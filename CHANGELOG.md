# Changelog

## 1.7.0 (2026-09-30): the cumulative delta pane

Page and engine; works with ChartBridge 0.3.4 (trade sides) and draws nothing but a note with 0.3.3 and older, no
recompile for the page. The engine adds the delta pane and `ChartEngine.CumulativeDelta`; with the pane off it draws
exactly as 1.6.0 (the same canvas calls, below). Run `nt8\install.ps1` again after pulling. The Desk gets it with the
new `live/live.js`, `live/live.css`, `live/bar-builder.js` and `src/chart-engine.js`.
- **Delta, as Anthony ruled (2026-09-30):** market buys minus market sells, in contracts. The side of every trade comes
  from ChartBridge 0.3.4 (`s` on each live `tick`, `[t, p, v, s, sm]` in the backfill; nt8/PROTOCOL.md, Trade side: the
  prevailing bid or ask, then the tick rule between them). The page never works a side out. A trade with an unknown side
  (`s` 0) or none at all adds nothing and is counted.
- **Cumulative delta candles in a pane below the chart**, on the chart's own bars, for every bar type (15s, 30s, 1m, 5m,
  15m, 1h, Range in both styles): open is the cumulative value at the bar's start (the previous bar's close in the
  session, 0 at the session's start), high, low and close the extremes and the last value of the running cumulative in
  the bar. It starts again at 0 at 18:00 ET (`tradeDay`, the boundary of the range bars, VWAP and the volume profile;
  bar times are New York wall clock, so both DST changes, weekends and holidays follow the chart's rules). The pane
  shares the x axis, scrolling, zoom and the crosshair: the pointer over the pane picks the same bar as over the chart
  (its line through both, the time tag and the legend follow it), and a drag or the wheel in the pane pans and zooms the
  bars. Candle colors, a value grid and zero line, round values and the newest value in a tag on its axis, its own
  eased value scale, the RTH shading and session dividers as in the chart. CHART_STYLE.md has the look.
- **Show: Cumulative or Bar delta** (Anthony), the gear's option: Bar delta is each bar's own buys minus sells, as a bar
  from a zero line. Saved per pane like the volume profile's hours (`live-indicator-options-v1`, `delta.show`), on a
  fresh read, only that field written, always saved even when unchanged (1.6.0 review S2); `setIndicatorOption('delta',
  'show', 'bar')` on a mounted chart (live/EMBED.md). Switching redraws the same delta; nothing is rebuilt.
- **Height:** about 20% of the chart at first; the band between the chart and the pane is a divider: drag it, or Tab to
  it and use the arrow keys (2%), Page Up and Down (10%), Home and End (`role="separator"`, its value in `aria-valuenow`).
  Kept between 8% and 60% of the chart, and never under 48 px for the pane or 120 px for the price chart
  (`PANE_RATIO_MIN`, `PANE_RATIO_MAX`, `PANE_MIN`, `PRICE_MIN`; the page reads the three ratios from the engine, review
  N8). Saved per pane when a move ends (`live-pane-heights-v1`, `{ <paneId>: { delta } }`, per storage prefix), and
  only when the height changed: a key on a chart too small to move it saves nothing (review N7). The divider's band
  starts at the pane's top edge and stops at the price axis, so it covers neither the price plot nor its axis (review
  N2), and "Jump to live" sits above the pane, not over it (review N3).
- **A normal E2 indicator**, "Cumulative delta" (chip DELTA, letter D) in the Volume group; search finds it by delta,
  cd, cvd, cumulative, order flow and flow. Show and hide keep it and its settings, the x takes it off, Hide all and
  Restore, pin, the two-tab rule, like the others. "Coming" now reads "time and sales".
- **On by default on the main pane** (Anthony), shown, **without a chip** (review N5; `UNPINNED_BY_DEFAULT` in
  live/live.js): the strip keeps the five chips of 1.6.0 ("V W L I F"), so the volume profile added to the main pane
  still gets the sixth, and the delta pane is shown, hidden and taken off from the Indicators menu, or pinned there for
  a chip like any other. Other panes (grid panes, mounted panes) start without it and add it from the menu (a chip, as
  for any addition while the strip has room). A saved layout with no delta entry (every 1.6.0 save) gets it on for the
  main pane, shown, no chip; saved after Hide all (nothing shown, a Restore mix kept), it comes back as it was, the
  delta pane hidden with the rest and added to the Restore mix, so Restore brings back the old mix and the pane (review
  N6). An explicit entry (off, hidden, pinned) stays as it is. The carry-over from `live-indicators-v1` (1.5.3 and older)
  does the same: the main pane gets it on, shown, no chip. The toolbar and the order bar do not move:
  their geometry is that of 1.6.0 at 1920, 1680, 1440, 1280, 1024 and 400 px on 1m, 15s and Range (measured), and
  nothing is added to the status line, so the chart area keeps its height too.
- **ChartBridge 0.3.3 or older** (trades without `s`): the pane is there (the layout does not change) and draws nothing
  but "Delta needs ChartBridge 0.3.4 on this PC"; the legend says the same, with no number. Whether a load has sides is
  read from its first trade; before any trade (a 1m view on a weekend), from hello's version. Never estimated.
- **Coverage, honest by construction** (review B1, S1, S3; review 2 S1, S2): the cumulative is only right if the page
  has every trade since 18:00, so it counts from 18:00 only when that is provable, never by a guess. The page holds
  every trade from the earlier of two moments (`deltaCoverage` in live/live.js):
  - **the store:** just after its first trade (the backfill is one run up to ChartBridge's seam, then every live trade;
    another trade of the same instant or bar before it may be missing), or earlier when NinjaTrader's own minute
    history proves it (`BB.minuteCover`, review 2 S2): when the store's trades in its first trade's minute add up to
    NinjaTrader's volume for that minute, it holds every trade of that minute; and when that minute is 18:00 and the
    minute history has no bar in the hour before it (the market was closed) and reaches back past that hour, the
    session is whole from 18:00. That proves the Sunday 18:00 open on a Monday (Range asks one hour more, 10 to 34 hours,
    but nothing trades from Friday 17:00 to Sunday 18:00, so no request reaches a trade before the open), a holiday
    reopening, and a minute view's 2 hours at 19:30. A store holding a trade from before 18:00 is whole as before (on
    Tuesday to Friday, Range's extra hour reaches the previous session's last trading hour). Once the page has dropped
    its oldest trades only its first trade counts;
  - **the moment the page went live** (this PC's clock at `ready`): every trade after it came in live, so a minute view
    opened at 17:59 or on Sunday afternoon counts the new session whole, trade or no trade in the break. The moment
    counts 5 s later (`LIVE_MARGIN`), or the PC clock's lag plus 2 s (`CLOCK_SLACK`) when that is more (review 2 S1):
    every live tick carries the data's UTC time `u` and ChartBridge's receive time `rx` (nt8/PROTOCOL.md, tick), and
    `u` minus this page's clock (or minus `rx`, whichever is more) is at most how far the data's clock is ahead of this
    PC's, since no tick arrives before it happened. When a tick shows it ahead by more than the delta was built with
    (in whole seconds), and that delta counted from the moment the page went live, the delta is built again at once
    with the later, honest start, the one on screen kept until then, and labelled "this PC's clock is 10 s behind the
    exchange's". Review 2's scenario C (the clock 10 s behind, a 1m view with no tick backfill going live at 17:59:53)
    now reads "Cumulative delta +N from 18:01 ET, not 18:00: this PC's clock is 10 s behind the exchange's". The
    status line's feed delay (`rx - u`) said "(PC clock ahead)" when it was negative, which means the PC's clock is
    behind the data's; it now says "(PC clock behind)" (wrong since 1.1.0, found while testing this).

  Anything else, such as a backfill The Desk's relay capped at 8 hours or NinjaTrader sending less than asked, is never
  taken as whole, even when it starts seconds after 18:00. A bar that started before that moment is left out whole
  (blank, never a part of a bar), and a session that started before it counts from 0 on its first complete bar and
  says so with that bar's exact start, seconds and tenths when not on the minute (`util.fmtExact`, review N1), and the
  true reason: the pane's title reads "Cumulative delta +1,234 from 18:05 ET, not 18:00: the tick history starts later"
  (NinjaTrader's minutes traded where its ticks have none), or "this view loads 2 hours of ticks" (8 on 15s and 30s),
  "this view loads no tick history", "no tick history came back", "this PC's clock is 10 s behind the exchange's", "the
  oldest trades were dropped", "its first minute does not add up to NinjaTrader's minute bar", "NinjaTrader's minute
  history does not confirm its first minute"; the legend "Delta from 18:05 +1,234", with a dashed line at that first
  bar; before the first complete bar, "starts with the next full bar". Bar delta counts each complete bar the same way.
  The proof rests on NinjaTrader's minute history coming apart from its tick history (the provider's minute data); a
  minute whose volumes differ proves nothing, so a disagreement only ever adds a label.
- **Minute views: 2 hours of ticks with the delta pane** (Anthony, 2026-09-30, replacing the `DELTA_WANTS_SESSION_TICKS`
  switch): on 1m, 5m, 15m and 1h, while the delta pane is on the chart (shown or hidden, since its delta is kept while
  hidden), the subscribe asks max(what the view asks, 2 hours) of ticks (`BB.timeTickHours`, `BB.DELTA_TICK_HOURS`), so
  trading after hours has its delta. The cumulative still resets at 18:00 ET: when the 2 hours reach back past the
  session start the count is whole from 18:00 (a 1m view at 19:30), otherwise labelled "from HH:MM" (at 22:00, "from
  20:00 ET, not 18:00: this view loads 2 hours of ticks"). Seconds views ask 8 hours and Range its sessions as before;
  with the pane off, or a ChartBridge that sends no sides, minute views ask none. Switching the pane on in a minute view
  loaded without it fetches the 2 hours with one new subscribe (the only way ChartBridge sends ticks), during which
  orders are refused with "Still loading" as on any load: 47 to 152 ms on the fake bridge (8 runs); on the trading PC it is
  ChartBridge's load time for 2 hours of trades and quotes (`loadMs` in `/diag`). Showing a hidden pane (chip, Restore)
  never reloads. **Load cost** (`perf:live --view=m1`, the fake bridge at 15 trades a second, 150 live a second): the 2
  hours are about 290,000 trades; the load went from 0.87 to 1.40 s (10:30 ET) and 0.88 to 1.51 s (20:00 ET), no long
  task, no frame over 50 ms, the chart frame 1.08 to 1.24 ms and 1.34 to 1.46 ms, the heap about 6 to 8 MB more. A
  15s or Range view switched to 1m keeps its ticks; 1m switched to 15s reloads for the 8 hours, as before.
- **Unknown sides** (`s` 0, or none): the legend adds "· 37 unknown" (the session's unknown volume in contracts, dim)
  when there are any. The core also counts them in trades, those with no side at all, and the volume sided by the tick
  rule (`unknownTrades`, `missing`, `byRule`), for a later readout.
- **Data:** the page's TickStore keeps each trade's side and method in one byte beside its block
  (`TickStore.push(t, p, v, s, sm)`, `side(i)`, `method(i)`, `feedSides`; `at(i)` still `[t, p, v]`, `feed` unchanged).
  The delta is built from the store at `ready`, on a bar type, size or style change and when it comes onto the chart
  (time bars bucket themselves; on range bars it goes through a new builder fed the same trades from the same place,
  which makes the same bars as the chart's), in slices of at most 8 ms (`DELTA_SLICE_MS`, one task each, review S5),
  handed to the chart only when complete; then each live trade is added right after the bar builders with the start of
  the bar it made: one trade, one O(1) add, never a rebuild per trade or per frame. So it holds exactly the trades the
  store holds (ChartBridge 0.3.3's seam, not the page, keeps a trade from coming twice), and a new session at 18:00
  starts at 0 with its first trade. It is kept while the pane is on the chart, shown or hidden, so the chip shows it
  again at once (review S5); off the chart, there is no delta at all. The engine keeps the closed candles' paths and
  the closed bars' value range between frames and draws only the newest candle and the axis each frame (review N4);
  the plot's width is in the key, so a resize that leaves the bars in view as they were moves the candles too (review
  2 S3). A range build no longer scans the store for the session start on the main thread in one go: the chart's
  rebuild hands its start over, and after a trim the scan runs in the slices (review 2 N2). A build started in a hidden
  tab goes at Chrome's pace for hidden tabs (once a second, after 5 minutes once a minute) and finishes at once when the
  tab is shown; nothing shows meanwhile (review 2 N3, accepted).
- **Legend:** "Delta +12,345" (bull color above zero, bear below), "Bar delta +123", thousands separators.
- Engine API: `setDelta(delta | null)`, `getDelta()`, layer `delta` (default false), `setDeltaView({ mode, ratio, note,
  reason })`, `deltaPane()` (`{ on, top, height, ratio, mode, note, title, lo, hi, plotHeight }`), `deltaToY(v)`,
  event `paneResize` (`{ ratio, height, done }`), `PANE_RATIO`, `PANE_RATIO_MIN`, `PANE_RATIO_MAX`, `PANE_MIN`,
  `PRICE_MIN`, `PANE_GAP`, `util.fmtExact(t)`; `CumulativeDelta({ sessionStart, seconds, coveredFrom })` with `add(t, v, side, barT, sm)`,
  `addQuiet`, `bars`, `sessions` (`buy`, `sell`, `unknown`, `unknownTrades`, `missing`, `byRule`, `partial`, `from`),
  `at(t)`, `indexOf`, `lowerBound`, `sessionOf`, `startOf`, `version`, `uncovered`, `skipped`.
- **The fake bridge** (tests only) sends sides like ChartBridge 0.3.4 (the same change as branch `bridge-side`, 0.3.4)
  and `--no-sides` for 0.3.3; its hello says `fake-0.3.4` or `fake-0.3.3`. Review 2: a minute's trades add up to its
  minute bar's volume, as NinjaTrader's do (not with `--tick-rate`); each live tick's `u` is on the exchange clock and
  `rx` on the PC's (`--pc-clock-offset`, default the exchange clock's), so a PC clock behind the exchange can be tested;
  `--cme-hours` keeps CME's hours (nothing from 17:00 to 18:00 ET or over the weekend). Its order handling is unchanged.
- **Unchanged:** the order path (`live/order-ticket.js`, `live/pin.js`, `test/orders-smoke.mjs`,
  `test/order-ticket.test.js`, `test/fake-orders.mjs`, the fake bridge's order handling) and everything under `nt8/`,
  byte for byte. The pane covers nothing of the price chart: the position, working orders and stop and target lines stay
  in it as before, and a click or Shift+click in the pane never places anything.
- Tests: `test/delta.test.js` (the candles on 15 s bars by hand; range bars of both styles through the page's bar
  builder against a count by hand, phantom bars blank; 18:00 ET over a weekend and on both DST changes from real UTC
  times, and 17:59:59.999 against 18:00:00.000; unknown and missing sides; bar delta per bar and each session's last close
  against its sums; coverage: a later start, exactly at the start, the first live trade, a range bar that started
  before; the TickStore's sides across block boundaries after a trim; the page's path, backfill then live, against a
  rebuild from the store and the store's own sums, on range and 5m bars; on a stand-in canvas: the pane only with the
  layer, 20%, the candles inside it, off draws the same with or without a delta, bar mode from zero, the note draws
  nothing else, the divider's keys, drag and limits, one crosshair and a drag in the pane, frames that never touch the
  delta, the closed candles' paths kept between frames, the divider band clear of the plot and the axis and "Jump to
  live" above the pane, no save from a key that moves nothing, `fmtExact`); `test/prefs.test.js` (default on for the
  main pane with no chip, the profile then the sixth chip, off on a new pane, search, show and hide, pin by hand and
  remove; a 1.6.0 save without the key, with six chips already, saved after Hide all and its Restore, an explicit off,
  junk; the 1.5.3 and 1.3 carry-overs; the Show option and the height per pane, fresh reads, limits, junk,
  `__proto__`, per prefix); `test/bar-builder.test.js` (Range asking one hour more, back before the
  17:00 close). The 1.6.0 tests that count what is on the main pane count the delta pane too and still check what they
  checked; the chip strips are those of 1.6.0 again.
  `npm run smoke:delta` (NQ Range 40 on sample data at 13:00 ET: on by default under the chart at 20%, in the count,
  with no chip (pinned from the menu for the chip checks); candles in both colors in the pane; its totals per session
  equal every trade the page received, counted in the test, also after 3 s of live trades, with no new delta; the crosshair over the pane; Bar delta from the gear and
  back, both after a reload; the black ground; 5m and 15s rebuilt once; the divider dragged, keyed (ArrowDown, End,
  Home, within the limits) and kept after a reload; the divider band and "Jump to live"; the chip, which shows it
  again at once with the same delta (review S5), Hide all and Restore, search, the x and the +; ChartBridge 0.3.3: the
  pane empty, the note, no number; 15s with 2 hours of ticks labelled "from 11:00 ET, not 18:00" (the minute proven by
  NinjaTrader's minute bar); the legend and title read in one task; mounted panes: pane-2 off, added from its menu, `setIndicatorOption('delta', 'show', 'bar')` and its
  height under `desk:`; review B1 at 02:05 ET on Range: The Desk's relay capping `tickHours` at 8 and NinjaTrader
  sending 8 of the 11 hours asked, each labelled partial from its exact start, never plain, and counting every trade
  from that start; review S1: 1m opened at 17:59:20 with nothing traded in the break counts the session whole from
  18:00, every trade received; the clock at 17:59:35: at 18:00 a new session from 0 with no rebuild, the title and the
  value read in one task after a drawn frame (review 2 N1); review 2 and the 2-hour ruling, on CME hours: 1m at 13:00
  asks 2 hours, labelled; 1m at 19:30 whole from 18:00, every trade counted, no label; 1m at 22:00 "from 20:00"; the
  pane switched on in a 1m view loaded without it, one subscribe for 2 hours, the time orders wait measured; scenario M,
  Monday 10:00 on Range, whole from the Sunday open, and with NinjaTrader's 18:00 minute one contract more, labelled
  "its first minute does not add up"; scenario C, the PC clock 10 s behind, 1m with no tick backfill live at about
  17:59:53, labelled "this PC's clock is 10 s behind the exchange's" at once and counting every trade from 18:01).
  `test/delta.test.js` adds `BB.minuteCover` (the Monday open, a volume short, a bar in the closed hour, a history
  that stops short, no 18:00 minute, a mid-session minute), a prepend through `_addBlockFront` and `_put` after a trim
  and with new blocks (every side stays with its trade), and review 2's width cases (800 to 803 and 1000 px with every
  bar in view, 800 to 803 with the view full: the pane as drawn equals the pane drawn from scratch);
  `test/bar-builder.test.js` the 2-hour rule. `smoke:vp`'s 1m load turns the delta pane off to keep checking a load
  with no ticks. The live
  (ChartBridge 0.2:
  the note), embed, settings, IB and volume profile smokes count the delta pane and check what they checked before.
- **Performance** (`npm run smoke:perf`, NQ Range 40 at 01:30 ET, 1.82 million backfill trades, 150 trades a second
  with bursts of 450, three loads of 10 s, headless Chromium on the build box, a shared box; the smoke runs with the
  delta pane on, `PERF_SMOKE_DELTA=0` for off). After the review fixes, six runs alternating on and off, the box's load
  average (1 min) at each start 2.01, 2.15, 1.91, 1.57, 2.38, 2.97:
  - delta on (400 candles, about 1.78 million trades counted), 9 loads: frames over 50 ms 0 in every load, long tasks 0;
    chart frame 1.29 to 1.42 ms, tick handler 29 to 33 us.
  - delta off, 9 loads: frames over 50 ms 0, long tasks 0; chart frame 1.10 to 1.19 ms, tick handler 27 to 32 us.
  So the pane costs about 0.2 ms a chart frame (0.3 to 0.5 ms before review N4). Showing the pane (review S5, the same
  view, three times each): before, one long task of 132, 195 and 174 ms and frame gaps up to 183 ms; now none, the
  longest frame gap 17 ms, both from the chip (kept while hidden) and from the menu's switch (a new build in slices).
  In the first round, with the box at a load of 4 to 11, loads showed single frames over 50 ms for 1.6.0 too (traces
  showed the compositor's commit); worth a run on Anthony's PC.
- **Drawing with the pane off is unchanged:** the canvas calls of 1.6.0 and 1.7.0 with the delta layer off (with and
  without a delta handed to the chart) are identical in 78 of 78 frames recorded on a stand-in canvas (plot, levels, the
  profile, fills, orders and the position, drawings, the crosshair over the plot and both axes, a drag, the wheel, the
  black ground, a live update; 1078 by 626 at dpr 1, 1440 by 760 at dpr 2, 400 by 700 at dpr 3).
- **Open for Anthony:** (1) Settled: minute views load 2 hours of ticks with the delta pane (above). The 15s and 30s
  views ask for 8 hours, so late in the day they start partway too (labelled). (2) The candle colors: the pane uses the
  bull and bear candle colors, not the trade-side green and red (the house style keeps those for sides and P&L). (3) A
  range bar with no trade (a NinjaTrader-style phantom bar) has no delta candle; should it show a flat one at the
  running value? (4) Unknown sides count in the legend as contracts ("· 37 unknown"); trades or a share instead? (5)
  The delta pane has no chip by default (review N5); pin it from the menu for one, or say if it should have the sixth.
- **Merged with main** (ChartBridge 0.3.4, 7c28d55): `test/trade-sides.test.js` now checks that `pushAll` passes all
  five places of a backfill trade and that the store keeps the sides from both formats.
- **For the live-first merge (PR #8, after this one; review 2's trial merge):** the TickStore's side bytes are added,
  dropped and written only through `_addBlock`, `_addBlockFront` and `_put`, so live-first's `prependAll` puts its front
  blocks in with `_addBlockFront` and writes each older trade with `_put` (its `[t, p, v, s, sm]`); keep this branch's
  five-place `pushAll` and drop the three-place one. The page has `deltaHistoryLoading(on)` (the label "the history is
  still loading" while the older history comes) and `deltaHistoryGrew(gapFrom)` (build the delta again from the whole
  store when the last older chunk is in, the one on screen kept until then; `gapFrom`, the first recent trade's time when
  ChartBridge reported `gapMs`, starts the count after it, labelled "the older history has a gap"). Both are unused on
  this branch.

## ChartBridge 0.3.4 (2026-09-30): every trade carries its side

ChartBridge (nt8/) only: the page, the engine and the chart version are unchanged, and the page needs no change to
work with it. **Needs a recompile:** run `nt8\install.ps1` again (only `ChartBridge.cs` changed), then compile in
NinjaTrader (F5). The first step toward cumulative delta (buy volume minus sell volume); the delta pane comes later.
Reviewed twice; the fixes from the reviews are marked "review" and "review 2".
- **The side of every trade, live and in the backfill** (`ChartBridgeSides`), by the rule Anthony approved: the
  exchange's aggressor flag if there were one (NinjaTrader 8 gives an add-on none, so that code is reserved); else the
  prevailing quote, at or above the ask a buy, at or below the bid a sell; else (between bid and ask, or no usable
  quote) the tick rule: up a buy, down a sell, unchanged the previous trade's side (Lee-Ready, kept over NinjaTrader's
  rule by Anthony on 2026-09-30). Each trade also says which method found its side, so the chart can show how much was
  inferred.
- **Wire format, additive:** a live `tick` gains `s` (1 buy, -1 sell, 0 unknown) and `sm` (0 none, 1 aggressor flag,
  2 bid/ask, 3 tick rule); each backfill trade becomes `[t, p, v, s, sm]`, the first three in their places. The live
  page reads `t, p, v` by name and by position, so it takes both unchanged (a node test feeds the new messages to its
  bar builder). The Desk's relay passes both through unchanged (the review checked it).
- **One tie rule, live and in the backfill** (review): the prevailing quote is the last bid and ask stamped strictly
  before the trade, on NinjaTrader's times. A quote at the trade's own time is not used (the quote change a trade causes
  shares its timestamp), a quote stamped after it never, and a quote over 60 s old is stale (tick rule, counted). Live
  used to take the quote in arrival order, so a trade whose own quote update arrived first could be called a sell by
  the quote; now a reload gives the same sides as the live chart, when NinjaTrader's live and historical times have the
  same resolution (with coarser history, a quote and a trade inside one step can differ).
- **The session** (Anthony, 2026-09-30; review 2): the tick rule starts over at 18:00 New York time (daylight saving
  included), live, in the backfill and after the seam: the first trade of a session between the quotes, or with no
  usable quote, is side 0.
- **Resets and bad prices** (review 2): a market data event with `IsReset` (NinjaTrader: after a manual disconnect, for
  its columns) is never a trade: the live quote is forgotten, nothing is sent, the first one is logged. A Last event at
  price 0 or below is ignored. Neither reaches the order code's last price any more (a reset of type Last at price 0
  could, making a long bracket's stop look passed for 2 s); the order code itself is unchanged.
- **Backfill:** tick charts ask for NinjaTrader's historical Bid and Ask ticks with the trades (at the same time).
  Review: only time and price are kept, size-only rows are dropped (the first row of each price and one every 5 s,
  each with the time of the last row it stands for, so a quote's age is exact), nothing is copied for a load that
  already went out, and the quote window is at most 24 hours (older trades: tick rule). Trades the quote history does
  not cover (before it, over 5 s past its end, or a quote over 60 s old) go by the tick rule; with no bid/ask history
  every trade does, and `/diag` and the Output window say so.
- **The quotes do not hold the chart up** (review): they get at most 2.5 s after the trades are in (was 15 s), and no
  wait at all when the trade request failed.
- **Order traffic first** (reviews 1 and 2): `ready` and the held live trades released after it go into the page's
  outbox as one entry, and order traffic (`order`, `orders`, `position`, `reject`, `trading`, fills, `status`, `pong`,
  `hello`) has its own lane, sent at the next message boundary ahead of queued market data, each lane in order. An order
  reply sent during a 20,000-trade release now arrives in under 1 ms (was up to 4 s).
- **A page more than 5 s behind is reconnected** (review 3; Anthony: "just a reset"): when the oldest market data waiting
  for a page has waited over 5 s, ChartBridge closes that page, which reconnects on its own without the PIN and reloads
  (Armed off). One Output line gives the lag. A load's history and ticks chunks do not count as lag while they go out.
  This replaces a limit of 5,000 waiting messages (0.3.3; it closed a page after a long release in a busy market) and
  of 50,000 (the second 0.3.4 round; it let a slow page fall about 17 s behind). A page that stopped reading is still
  closed after a 2 s stuck send with 5,000 waiting. `/diag` `pages` shows each page's queue and lag. Review 4: the time
  spent sending the page's own bulk data (a load's chunks and the held trades released after `ready`) is not counted
  as lag, so the reload after a close at 3,000 trades a second (about 90,000 held trades) does not close itself again;
  a close always aborts the connection, so the page sees it and reconnects (a close between two sends used to leave it
  connected, silent and Armed); and a load queues its chunks at most three ahead of the page, so a loading page holds
  about 4 MB of them, not the whole load (Range 40 over 28 hours was about 295 MB).
  The price of not counting the release (review 5): right after a load the chart can run behind by up to the release's
  length plus 5 s before the rule acts (review 5 measured 4.4 to 14.3 s on healthy pages at 3,000 trades a second),
  while trading stays enabled. Sending recent ticks first (the next step, branch live-first) is what shrinks the release.
- **Sends never throw** (review 3): a message racing a page's Close is dropped quietly (it used to throw out of the loop
  sending an order, position or fill update to every page, so the pages after it missed it); a failed send closes the
  page so it reconnects.
- **The seam (0.3.3) is unchanged:** the side takes no part in matching held live trades against the backfill, so a
  trade the live and the history quote call differently is still sent once (with the backfill's side). Review: the
  released trades' tick rule continues from that backfill copy, not from the dropped live twin.
- **`/diag` `sides`:** per instrument, live counts by method, `liveTieChanged`, `quoteAfterTrade`, stale quotes, the
  latest quote and whether NinjaTrader's own e.Bid/e.Ask on each trade match it; for the last load, counts by method,
  the Bid and Ask history (rows sent and kept, window, copy time, first and last times, request result), trades before,
  after, between the quotes and with a stale quote, `tieChanged`, the time resolutions, and NinjaTrader's own bid/ask
  stamps on the last 2,000 trades (usable, like its fill-in, agreeing with ChartBridge's side).
- **Unchanged:** orders, the PIN, network rules and fills (`ChartBridgeOrders.cs` and `ChartBridgePin.cs` untouched).
- Research with sources: `nt8/PROTOCOL.md`, Trade side (NinjaTrader's help for MarketDataEventArgs, Order Flow
  Cumulative Delta, historical Bid/Ask series and Tick Replay).
- Tests: the Mono harness (`check/SidesHarness.cs`, run by `npm run check:orders`) checks the rules (at, above, at and
  below the bid, between, no quote, one side, crossed, float noise, tick rule sequences with unchanged prices), the
  live tagger (the trade's own update first, an update stamped after the trade, stale, reset, a burst of 800 updates at
  one time), live and backfill giving the same sides on the same trades, the 18:00 ET session (the reopening print,
  live, backfill and after the seam; the DST days), the as-of join (ties, no look-ahead, missing history, shorter
  history at either end, a hole in the middle, whole-second quotes, NinjaTrader's stamps), the thinned quote series
  (same sides as every row, also at the 60 s edge over 200 made-up histories; 1,000,000 rows copied in about 25 ms),
  the two send lanes (an order reply during a 20,000-trade release at 20 and 200 us a message in under 1 ms; 1,500 and
  3,000 live trades a second after `ready` without a close; lane order; a stuck page and a page 50,000 behind still
  closed; Send after Close), resets and prices of 0 never reaching the order code, and whole loads through Subscribe
  and the live handler (the quote requests, the answers in any order, refused, empty, shorter, never coming, a failed
  trade request, the 24-hour window, a resubscribe during the quote wait, minute charts, the seam with sides that
  disagree, 6,000 and 20,000 held trades released to a page draining at a socket's pace, `/diag`). The 0.3.3 seam
  cases run unchanged. `test/trade-sides.test.js` checks the page's parsing and bar building with the new messages,
  and the fake bridge, which now sends sides (`--no-sides` for the old format).

## 1.6.0 (2026-09-29): the Indicators menu "E2", a chip strip per pane, one account picker, and the volume profile

Page and engine; works with ChartBridge 0.3.2 and 0.3.3, no recompile. The engine adds the volume profile (below) and
`getMarkers()`; with the profile off it draws exactly as 1.5.3. Run `nt8\install.ps1` again after pulling. The Desk gets it with the new `live/live.js`, `live/live.css`,
`live/order-ticket.js` and `src/chart-engine.js`.
- **The menu Anthony approved in the design canvas (E2)**, one per chart pane, from the same Indicators button (its
  count now reads shown/on this chart, "4/5"): a search box, focused on open, that matches names and short names
  (vwap; ib, ibh, ibl; pdh, pdl, onh, onl, levels; vol, volume; fills); Enter adds or shows the first match and never
  hides it (review); a Recent line with the last 5 used; "On this chart" with every indicator on the pane, each with
  a show or hide switch (hiding keeps it and its settings), its swatch, a pin for the chip strip, a gear for what it
  does (one panel open at a time) and an x that takes it off the chart; then the groups, folded on every open, one open
  at a time: Price (VWAP, Levels, Initial balance), Volume (Volume bars, Volume profile) and Trades (Fills), each with a + and the gear (no pin: pins are only on
  rows on the chart, Anthony); "Coming: cumulative delta, time and sales"; and "Hide all (n)", which becomes "Restore"
  and brings back the same mix, not everything. Saved sets are not in this build. The search is cleared when the menu
  closes (review).
- **Names** (Anthony): "Initial balance" (chip IB; "IB 1h" before) and "Volume bars" (chip VOL) in the menu, chips,
  status line ("Initial balance not shown: ...") and docs. The legend's "Vol" is the bar's volume and stays.
- **Chip strip** beside the button: pinned indicators only, **at most 6** (Anthony). An indicator added gets a chip
  while there is room; added to a full strip it gets none, and pinning onto a full strip is refused, each with a short
  note in the menu ("The chip strip holds 6: unpin one to pin another."). One click shows or hides. Shown: filled,
  solid border, its color line; hidden: no fill, dashed border, grey text and line (not only a color change). The
  strip always keeps room for six one-letter chips and shows the names only when that adds no toolbar line, so it
  never wraps and pinning or unpinning never moves the order bar or the chart (review N4; toolbar heights at 1920,
  1680, 1440, 1280 and 1024 px are those of 1.5.3).
- **One account picker** (Anthony). The order bar's Account picker is now the one account control, larger (600 13px
  mono, 34 px): orders go to it, and the chart marks **its fills only**. There is no "All accounts" any more and no
  fills filter anywhere else (the 1.6.0 draft had one in the Fills gear, hidden: review B1). With trading off the
  picker still works: it lists every account ChartBridge knows and switches the fills (the other order controls stay
  off, and nothing can be sent). With no order bar (a mounted chart such as The Desk's, or ChartBridge 0.2) a compact
  Account picker sits in the toolbar. Saved in `live-account-v1`, per prefix; a 1.5 `live-fill-account-v1` choice is
  read once when there is none ("All accounts" means none picked). Charts with one prefix follow each other's pick
  (the Desk's panes at once, other tabs through the storage event); a saved account ChartBridge no longer lists reads
  "(no longer listed)". The trading page shows no toolbar picker while connecting, so the toolbar does not jump. The
  picker's tooltip says what it does now: with trading off, "this only picks whose fills the chart marks". After an
  empty `hello` (no connected account yet) the picker is enabled again when the sign-in turns trading on (review 2,
  S1). The order path is unchanged: while trading, the
  order account is chosen exactly as before (Sim101 first, never from storage), the Armed switch still turns off when
  it changes, and nothing new is sent to ChartBridge.
- **The live trade always stays visible** (Anthony). Hide all includes Fills, and hiding Fills hides past fills and
  trade marks, but never the open trade: its entry fills stay marked (`OrderTicket.openEntryFills`, checked against
  the position ChartBridge reports while trading), and the position line and label, working orders and stop and
  target lines were never indicators. The Fills gear says so.
- **"/"** opens this chart's menu, with the focus in its search box, when the focus is inside the chart, or with
  nothing focused, the chart under the mouse (review N6: never while a host dialog or anything outside the chart has
  the focus). Never while a box has the focus (order quantity, bracket ticks, range size, a host's fields) or with
  Ctrl, Alt or Cmd; no chart or order-bar key used "/", and the PIN pad still takes every key first. Arrows move
  through the menu; Escape closes it and puts the focus back where it was.
- **The panel opens below the order bar** (review N5), so the Armed switch, the account and the position readout stay
  in view at every width; its list scrolls inside when the space is short, and it never gets wider than its pane.
- Accessibility: real buttons, `aria-pressed` and `aria-expanded`; switch and pin labels say what a press does
  ("Hide VWAP", "Unpin VWAP from the chip strip"); `aria-controls` only while its panel exists; one live region for
  the result count and notes, changed only when its text changes (review N8).
- **Saved per pane** in `live-indicators-v2` (`{ <paneId>: { ind: { <id>: { on, shown, pin } }, recent, restore }
  }`), per storage prefix (The Desk's `desk:` keys stay its own). What a click means is worked out from what the tab
  shows and saved as that fixed result on a fresh read, so two tabs never undo each other and a tab never saves the
  opposite of what it shows (review S1: the switch, +, Recent, Enter and Hide all were saved as relative toggles).
  Showing (the switch, a chip, Enter, Restore) writes "on the chart and shown", so even one another tab took off is
  drawn after a reload as it is now (review 2, N7).
  **Carried over once** from `live-indicators-v1` (left in place): every indicator draws exactly as before and an
  explicit off stays off. On the main pane all five stay on its chart, pinned, the ones that were off hidden; on any
  other pane only the ones that were on are on its chart. A damaged `live-indicators-v2` is carried over from v1 again
  (review N3). New panes start with nothing on (Anthony's rule); the main pane with the five on.
- **Open for Anthony** (review 2, S2, unchanged from 1.5.x): after a reconnect, or when trading comes on after the
  sign-in, the order account goes back to Sim101 (or the first allowed account), not the one in use; Armed is off after
  it and the picker shows the real order account. Which account should a load or a reconnect start on?
- **Going back to 1.5.x** (review N2): 1.6.0 never writes `live-indicators-v1`, so a 1.5.x page opened afterwards (or a
  1.5.3 tab left open) shows the set from before the upgrade, and what it saves is not read by 1.6.0 again. Nothing is
  lost; each version keeps its own key.
- Works the same in `ChartLive.mount`, read only included (nothing is sent to ChartBridge for indicators or the
  account).
- Tests: `test/prefs.test.js` (add, show, hide, remove, pin, the 6-chip cap with the auto-pin and the refusal, Recent,
  Hide all and Restore, counts, two tabs on different and on the same indicator and both pressing Hide all, junk in
  storage, search; the migration: explicit offs, a main pane saved before 1.5.3, other panes, junk, a damaged v2,
  read once, per prefix); `test/order-ticket.test.js` (`openEntryFills`: flat, scaled out, turned over, the reported
  position). `npm run smoke:live` (search and Enter that never hides, the switch by Space with its label, one settings
  panel, chips, Hide all and Restore, pin, x and +, the cap note, "/" and a clean reopen, "/" ignored in a box, reload,
  the toolbar account picker with the fills always its account's, one-letter chips at 400 px), `npm run smoke:orders`
  (the order bar's picker switching the fills; Hide all and hidden Fills with an open position and its stop and
  target: the position, both legs and the entry fill stay; trading off: only the picker works and the fills follow it,
  remembered; ChartBridge 0.2: the toolbar picker), `npm run smoke:embed` (the embed's toolbar picker and its fills,
  saved under the prefix; "/" by focus, by hover with nothing focused, and not with a host control focused; a 351 px
  pane with one-letter chips on one line and the menu inside it; a 1.5.3 embed's indicators carried over under its
  prefix), `smoke:settings` and `smoke:ib` updated.

### The volume profile (1.6.0)

- **The volume profile, drawn** (Anthony's ruling 2026-09-29): the session's volume per price on the right edge of
  the plot, behind the candles (in front of the grid, behind volume, levels, VWAP and candles), 1-tick rows, the POC
  and the 70% value area highlighted. The POC row is 25% of the plot width (`VP_WIDTH`), every other row in
  proportion. Colors are theme values (`vpRow` `#141C26`, `vpValue` `#212C3B`, `vpPoc` the value-level gold
  `#E0B45A`); on another ground the rows are mixed from the ground (7% and 14% toward the ink) and the POC moves
  until it reads at 3:1 on the value-area rows, built once per theme change like the rest. Candles over the rows read
  lower than on the bare ground: on the default ground bear 1.99:1 over the value-area rows and 2.42:1 over the
  others (2.77:1 on the bare ground), bull 4.70:1; the lowest over the presets and odd grounds tested is 1.76:1 (bear
  on Blue-grey); what floor they should keep is open for Anthony. Rows thinner than a device pixel share it (the
  longest bar there, the POC always shown), and the POC bar is at least 2 CSS px tall (`VP_POC_MIN`), centred on its
  row (review; it was a 1 device px hairline at 1-tick rows). The bars are laid out by `util.profileRects` once per
  change of the profile, the view or the size, kept as rectangle lists and filled with `fillRect`; the profile's rows
  are read once per version (`VolumeProfile.columns()`, cached). While trades flow the profile changes with nearly
  every frame, so in practice that is a rebuild per frame (about 700 in a 10 s busy window), costing well under a
  millisecond; with no trade and no view change nothing is rebuilt.
- **Off by default on every pane, added from the Indicators menu** (Volume group, with a +) as the indicator `vp`
  ("Volume profile", chip PROFILE, letter P), registered like the others: search finds it by vp, profile, poc, vah,
  val and value area; it gets a chip while the strip has room (with the main pane's five that makes six, a full
  strip); Hide all, Restore and the two-tab rule cover it like the others. The carry-over from `live-indicators-v1`
  reads it like the others: a 1.5.3 save never has a `vp` key, so the profile starts off after upgrading from 1.5.3;
  a save from the unreleased profile test build that had it on keeps it on (shown and pinned, the main pane's sixth
  chip).
- **Session or RTH** (Anthony): the full session from 18:00 ET, or RTH, 9:30:00.000 up to (not including)
  16:00:00.000 ET of the trading day (`VolumeProfile` option `rth`; the same window as the chart's RTH shading and
  sessionLevels; none on weekends and NYSE holidays, the IB's rule; the RTH profile empties at 18:00 and stays empty
  until 9:30). On NYSE early-close days (the day after Thanksgiving, Christmas Eve and July 3 when they fall Monday to
  Thursday; `util.nyseEarlyCloses`, `util.rthClose`) RTH ends at the 13:00 close, not 16:00 (review); the chart's RTH
  shading still runs to 16:00 on those days. There was no option mechanism for indicators, so there is one now: `LivePrefs.INDICATOR_OPTIONS`
  (`{ vp: { session: ['full', 'rth'] } }`), saved per pane in `live-indicator-options-v1`, set with
  `setIndicatorOption('vp', 'session', 'rth')` on the handle `ChartLive.mount` returns (and read with
  `indicatorOptions('vp')`; live/EMBED.md; it returns false, never throws, for any name that is not an option,
  including inherited ones such as `toString`, and a pane id such as `__proto__` is stored as a plain key), and in the menu the Volume profile's gear panel: "Hours", Session or RTH (the
  toolbar's segmented style at 11 px), with a line saying what the choice counts. A pick is always saved as what the
  tab shows, on a fresh read of that pane's field, also when the tab already shows it: a second tab still showing RTH
  after another tab saved Session saves RTH again, so the next load draws what it showed (review S2).
- **Legend:** "POC 26,150.50 · VA 26,101.50 to 26,289.50" (the POC price in the gold) while the profile is on and has
  trades.
- **Data:** built from the page's TickStore at `ready` (when on), when switched on and when Session / RTH changes,
  then each live tick is added right after the store's push, so it holds what the store holds; it moves to the new
  session at 18:00 ET on the clock (before the first trade). It does not depend on the bars, so changing the view
  keeps it. 1m and longer views that loaded no tick history (the page subscribed on one: tickHours 0) have only the
  live trades: the profile starts at the first live trade after the page went live, and the status line says so in
  its quiet grey ("Volume profile from 13:00 ET: this view loads no tick history, ..."). It also says when the tick
  history does not reach back to 18:00 (9:30 for RTH), for example the 8 hours of the 15s and 30s views late in the
  day, and "Volume profile (RTH) starts at 9:30 ET." before the open. ChartBridge is unchanged.
- Engine API: `setProfile(profile | null)`, `getProfile()`, layer `vp` (default false), `stats().profileBuilds`,
  `VP_WIDTH`, `VP_POC_MIN`, `util.profileRects`, `util.nyseEarlyCloses`, `util.rthClose`; `VolumeProfile`: option `rth` (with `rthStart`, `rthEnd`), `inRth(t)`,
  `startOf(t)`, `outside` (trades outside the RTH window, not counted in `skipped`), `columns()`; theme keys `vpRow`,
  `vpValue`, `vpPoc` and the derived `vpPocText`.
- Tests: `test/vp-draw.test.js` (RTH edges at 9:30:00.000 and 16:00:00.000, the overnight, four DST dates through
  `zoneSeconds`, a weekend, Labor Day, seven early-close days (12:59:59.999 in, 13:00:00.000 out) and the days next
  to them, the early-close calendar 2019 to 2026, RTH from the TickStore against a hand filter; `columns()` and its
  cache; the geometry: right edge, POC width, the POC's 2 CSS px at dpr 1, 2 and 3, row heights and gaps, sub-pixel
  rows, rows in view only, volume 0; the colors on the presets and odd grounds; candle and VWAP contrast over the
  rows on every ground and preset, measured and reported (`--test-reporter=tap` shows the table), held only to the
  current values, not to a floor; on a stand-in canvas: only with the layer, drawn after the grid and
  before the volume bars and candles, rebuilt once per change and not per frame); `test/prefs.test.js` (the `vp`
  indicator and its option, per pane, refused values; inherited names and `__proto__`, `constructor` and `toString`
  as pane ids, with Object.prototype untouched; the carry-over of a v1 save without a `vp` key and with `vp` on,
  under the 6-chip cap); `npm run smoke:vp` (NQ Range 40 on sample data at 13:00 ET:
  off by default, on from the menu, the POC row's pixels from the right edge at about 25% width, value-area and
  other rows at the edge, nothing in the left half; the profile equal to every trade the page received, for the
  session and for RTH, also after 2.5 s of live trades; Session and RTH differ in totals, legend and pixels; both
  choices after a reload; 5m keeps it; the POC bar at least 2 CSS px; a mounted pane's `setIndicatorOption` under
  `desk:`, and false with no throw for inherited names; two tabs: a stale tab's RTH saved again after another tab's
  Session, the other keys kept, and a new load drawing RTH; a 1m first load with its note). The live, embed, settings
  and IB smokes count what is on the chart (the profile off).
- **Performance** (`npm run smoke:perf`, NQ Range 40, 150 trades a second with bursts of 450, three loads of 10 s
  each, headless Chromium on the build box; the smoke now runs with the profile on, `PERF_SMOKE_VP=0` for off,
  `=rth` for RTH at 13:30 ET). Frames over 50 ms per load, and the chart's own frame time:
  - 01:30 ET (1.81 million backfill trades), profile off: 0, 0, 0; 0.91 to 1.05 ms.
  - 01:30 ET, profile on (Session, 476,800 contracts): 0, 0, 0; 0.95 to 1.06 ms.
  - 13:30 ET (1.11 million trades at 17 a second), profile off: 0, 0, 0; 0.93 to 0.95 ms.
  - 13:30 ET, profile on (RTH, 410,500 contracts): 0, 0, 0; 0.98 to 1.12 ms.
  The difference is within this box's run-to-run noise: the review's own profile-off run had 3 frames over 50 ms in
  one load and a slower frame than its profile-on run. A first cut that drew the bars as Path2D paths had 1 frame
  over 50 ms in two of three loads; filling rectangles removed that. Not measured in the smoke: building the profile
  from the store when it is switched on or Session / RTH changes is one task of about 40 to 70 ms for 1.8 million
  trades on this box (the review's figure), longer on a slower PC.
- **Open for Anthony:** (1) the profile holds the trading day of the clock, so over a weekend and in RTH mode from
  18:00 to the next 9:30 it is empty (like the IB): should it keep the last session (or the day's RTH) up instead?
  (2) RTH counts nothing on NYSE holidays (Globex trades to an early halt); right? (3) Minute views loaded without tick history start the profile at the first live trade: should the page ask
  ChartBridge for ticks back to 18:00 whenever the profile is on (a slower load), or keep the note? The 15s and 30s
  views ask for 8 hours, so late in the day they start partway too. (4) The 25% width and the colors are my picks.
  (5) The legend line does not say Session or RTH (its tooltip does): add a tag? (6) The POC shares the gold of the
  prior day's VAH and VAL lines: keep it, or a different gold? (7) The candle floor over the profile rows (above).
- **Volume profile, the compute core** (`ChartEngine.VolumeProfile` in `src/chart-engine.js`). A session volume profile from trades (t, price, size): rows at the tick (NQ 0.25) with optional grouping of N ticks
  per row, all in whole ticks; total volume; POC (ties go to the row closest to the middle of the profile, then the
  lower); value area high and low for a set share (default 70%) by the CBOT method (from the POC, add the larger of
  the next two rows above or the next two below, both when equal). One profile per trading session, emptied at the
  same 18:00 ET boundary as the range bars and VWAP (the engine's `tradeDay`). `add` is amortised O(1); POC and value
  area are cached until the profile changes. Only finite numbers are taken (null, strings and booleans are left out
  and counted). Measured with Node 22 on 500,000 trades: 7 to 70 ms to build (the first build in a process is the
  slowest), 0.02 to 1.1 ms for the first POC and value area after it (about 7 ms on one cold run elsewhere), and
  about 10 nanoseconds once cached.
- Built from the page's TickStore at `ready` and then from each live tick, so it holds exactly what the store holds.
  A trade at the moment ChartBridge started the tick backfill could come both in the backfill and as a held
  live tick and be counted twice (in the range bars too); ChartBridge 0.3.3 settles that seam (below), with the page
  unchanged.
- No buy/sell split: ChartBridge's ticks carry no aggressor side. Open questions for Anthony are listed in the code
  comment. Tests in `test/volume-profile.test.js`.

## ChartBridge 0.3.3 (2026-09-29): the backfill and live trades meet at one seam

ChartBridge (nt8/) only: the page, the engine and the chart version are unchanged, and the page needs no change to
work with it. **Needs a recompile:** run `nt8\install.ps1` again (only `ChartBridge.cs` changed), then compile in
NinjaTrader (F5). From the review of the volume profile core (S1, the seam), which proved the double count on the
page side; then reviewed on its own (four fixes below, marked "review").
- **The seam, one rule** (`ChartBridgeSeam.Dedupe`). Live trades are held from the subscribe until the backfill
  is sent; the backfill is what NinjaTrader has when it answers, so the two overlapped and a trade in the
  overlap reached the page twice (range bars, the forming minute, VWAP and volume; trades have no id, so the page
  cannot tell). Now, before `ready`, ChartBridge drops every held trade earlier than the last backfill trade (T).
  At exactly T it drops as many as the backfill has there with the same price and volume. Both sides are compared
  on NinjaTrader's own trade times, never the PC clock, at the coarser resolution of the two (millisecond, or whole
  seconds when at least 20 trades near the seam are all on whole seconds, or a shorter backfill has every trade on
  a whole second).
- **Review: at whole seconds, trades held after the answer are never matched at T.** At whole-second
  resolution, a load that finished inside the backfill's last second dropped a real trade in about one busy
  load in five (the review's simulation, rerun with a sound random generator). ChartBridge now counts the trades
  held when NinjaTrader answered (`heldAtAnswer`, right after copying the answer) and at whole seconds only those
  can match. Keeping every held trade at T instead would double count 20 to 80 trades a busy load, so that was
  not done. At millisecond resolution every held trade may still match (re-review: exact whatever order
  NinjaTrader delivers in). One held trade on a whole second no longer makes the comparison whole-second.
- **No gap from the PC clock.** The tick request ends 60 minutes past now. NinjaTrader's help says BarsRequest
  dates are turned into whole trading days, so the time should not cut the backfill anyway; the margin covers a
  connection that does, even with the PC clock behind the data. A request ending in the future that is refused,
  or (review) answered with no trades at all, is asked once more ending now (as 0.3.2).
- **The forming minute meets at the same seam.** The history is now split: the minute history's last bar is sent
  last, in its own `history` message, rebuilt from the same trades the held ones are matched against. Review: a
  trade at exactly hh:mm:00.000 stays in the bar that ends then (time bars are stamped at their close; believed
  to be NinjaTrader's rule, a live check), and when the rebuilt minute has less volume than NinjaTrader's (the
  trades lag), NinjaTrader's bar is kept. Minute and hour charts (no tick backfill) ask for the last 20,000
  trades for this only; they are not sent to the page. `ready` waits for that answer: ChartBridge's own work on it
  is about 1 ms; NinjaTrader's time to answer shows in `/diag` `loadMs`. When those trades do not cover the
  minute, NinjaTrader's bar is kept and every held trade is released, as before.
- **A newer subscribe wins** (review: checked before every chunk). Once the page subscribes again (say, for more
  tick hours), no further `history` or `ticks` chunk or `ready` of the older load is sent. Chunks already queued
  can still arrive, so `history`, `ticks` and `ready` now carry `sub` (the page's subscribe id if it sends one,
  else ChartBridge's count, as plain digits: `007` comes back as `7`); the live page does not use it yet
  (follow-up).
- **`/diag` `seams`:** the last 20 subscribes with the last backfill trade time, the first held and first
  released trade times, `overlapMs`, held, held at the answer, dropped as duplicate (older, same time),
  `droppedAfterAnswer`, `olderAfterAnswer` (a late delivery by NinjaTrader), released, the resolution, load time, NinjaTrader's and the rebuilt volume of the forming
  minute and whether it was rebuilt, so a live PC can confirm the seam.
- **Still open** (in `nt8/PROTOCOL.md`, Backfill and live): a gap if NinjaTrader's history lags its live data;
  the whole-second case where the callback lags NinjaTrader's snapshot inside the trade's second; the minute
  boundary rule (a recipe in PROTOCOL.md) and the order of NinjaTrader's answer against its live events
  (`olderAfterAnswer`), both to check on a live PC; stale chunks until the page uses `sub`; the page's own
  start-inclusive minute bars (page side, since 0.3.2); the pre-existing 5,000-message outbox per page.
- **Unchanged:** orders, the PIN, network rules and fills.
- Tests: the Mono harness (`check/SeamHarness.cs`, run by `npm run check:orders`) checks the rule as a pure
  function (overlap, no overlap, a multiset at the last time, all held older, none older, empty backfill, empty
  hold, whole-second against millisecond times, float noise in prices, trades held after the answer) and the whole
  load through ChartBridge's own Subscribe and live-trade handler with the stand-in BarsRequest answered by hand:
  the review's example now adds up to the true volume 10, the order on the wire, the tick request past now and the
  retry (refused or empty), minute charts, the minute boundary and a lagging rebuild, a stale load and a
  resubscribe mid-send, `sub` (and leading zeros), a short whole-second backfill, trades held after the answer
  at both resolutions, empty answers and `/diag`. Each review's new cases failed on the commit before its fix.

## 1.5.3 (2026-09-29): the 1-hour Initial Balance, and a chart background of any color

Page and engine only; nt8/ is unchanged and ChartBridge stays 0.3.2. Run `nt8\install.ps1` again after pulling (it
copies the page and engine files); no NinjaTrader recompile. The Desk's embedded chart gets both with the new
`src/chart-engine.js`, `live/live.js` and `live/live.css`.
- **IB 1h** (Anthony): today's high and low from 9:30:00 up to 10:30:00 New York time (DST-aware, like the rest of
  the chart), named "IBH" and "IBL", drawn from the 9:30 bar to the right edge (Anthony), in long dashes (12/5, a
  pattern no other level uses) while forming, moving with each new high or low; solid from 10:30:00 for the rest of
  the trading day (until 18:00). Before 9:30 nothing is drawn for today, and only today's IB is ever drawn. The
  high is the brighter orchid `#F7C6EC`, the low the orchid base `#E58BD2` (Anthony), 1.59:1 apart, in the level
  style (name at the right edge, outlined tag on the price axis; merged names as in 1.5.2, one string in the first
  level's color).
- **The data rule:** the IB is always computed from the 1-minute bars the page holds in every view (NinjaTrader's
  1-minute history, then bars built from the live trades), never from the bars on screen. Both edges are whole
  minutes, so no 1-minute bar straddles 9:30 or 10:30, and each 1-minute bar's high and low are exactly those of
  its trades: a trade at 10:29:59.999 counts, one at 10:30:00.000 does not, and the IB is the same on 1m, 15s,
  30s, 5m, 15m, 1h and Range bars, from the backfill or live, after a reload, and in `ChartLive.mount`. A 15-minute,
  1-hour or Range bar can run past 10:30, so bars as drawn would leak later prices; the engine's `initialBalance`
  refuses bars that straddle an edge. Ticks are not used even when a view has them loaded: they give the same
  numbers at whole-minute edges when NinjaTrader's minute and tick histories agree, and using them only in the tick
  views would let the IB differ by a tick between Range and 1m when they do not.
- **Shown only when it can be exact** (review S2): the 1-minute history must hold a bar from today's session (from
  the 18:00 start) ending at or before 9:30, and every minute from 9:30 up to the one in progress (to 10:29 once
  locked). History that starts after 9:30, yesterday's bars followed by today's from 9:45, a missing minute inside
  the hour, or data that stopped (a connection lost, also before 9:30; the check also runs while offline), all draw
  nothing, and the status line says why in its quiet grey (for missing minutes, that a reload fetches the history
  again). Weekends and NYSE full-day holidays (the NYSE's rules, including observed
  days; Globex trades on most of them, but there is no 9:30 open) draw nothing; a holiday gets a note naming the
  day, a weekend none. What cannot be seen from bars: a minute that has a bar but lost some of its trades.
- **Its own Indicators entry, IB 1h**, per pane, independent of Levels: on for the main pane (also a main pane saved
  by an earlier version), off for a new pane (Anthony's rule). The count now reads out of 5.
- **Background** in the Colors panel: presets Dark (the current `#080B10`, still the default), Black, Blue-grey
  `#1B2433` and Light `#F5F7FA`, and a picker and hex box for any color (`#RGB` shorthand accepted; anything else is
  marked invalid and not applied). On the default ground every color is the locked palette, key for key. On any
  other ground the engine builds the theme once per change (never per frame): grid, axes, text and tags are mixed
  from the ground toward a light or dark ink, and every colored mark (candles, VWAP, levels and their names, trade
  sides and results, drawings) keeps its hue where it can and moves just enough to read (text 4.5:1, strong text
  7:1, lines 3:1, candle bodies 2.5:1). Saved with the other colors (`live-colors-v1`), one field at a time, per
  storage prefix, so The Desk keeps its own and a second tab never undoes it.
- **Buy and sell keep their green and red on every ground** (review 2, S1): fill markers, trade entries, order lines
  and labels, the position's side word and the legend's last fill are always drawn in the chosen colors (`#3DDC97`,
  `#FF7A7A`). Where one does not read on the ground, marks and lines get an outline (3:1) and text a halo (4.5:1) in
  the house near-black or near-white, whichever stands out more from the ground. On the default ground nothing
  changes.
- **Other pairs stay apart on every ground** (review S1): bull and bear, profit and loss, and the IB high and low.
  On a ground near mid-grey (about `#6A6A6A` to `#8A8A8A`, and mid-luminance colors) nothing keeps its hue at 4.5:1.
  A pair that would merge is first parted by pushing the one farther from the ground further; if that cannot part
  it, the lighter goes toward white and the darker toward black. Each then reads at least 3.5:1 (the floor itself
  where the ground allows). The IB high stays the lighter, at least 1.5:1 apart on every preset (1.55:1 on Light)
  and 1.25:1 anywhere. Checked over all 256 greys and 20,000 random grounds. The other levels can still come out the
  same color on such a ground; their dash patterns and names tell them apart.
- **A clearly light ground takes the page light** (Anthony): the toolbar, menus, Colors panel and status line follow
  the ground, with the same floors (text 7:1, secondary text and accents 4.5:1 on the darkest surface they sit on;
  `ChartEngine.util.chromeColors`). Clearly light means 9:1 or more against the house near-black `#080B10` (greys
  from `#B0B0B0` up, the Light preset); mid and dark grounds keep the dark house chrome.
- **The order bar never changes** (review 2, B1): on every ground, light chrome or not, it looks exactly as in 1.5.2
  (dark bar, green Buy, red Sell, the amber Armed switch and tint). It keeps the house colors and sits on the house
  ground. Checked by computed style on the presets and all 256 greys, off and Armed.
- `legible` (1.5.3): it now moves toward black on a light ground (before it always lightened, which on a light
  ground made text worse), and it checks each step as drawn, in whole RGB steps. On dark grounds the stepping is the
  same as before, but because the rounded color is now what is checked, a few custom colors come out one 5% step
  different: one step further where the old rounding landed just under 4.5:1 (old `#AB3EB1` gave 4.499:1), and in
  some cases one step earlier (old `#6F4041` gave `#9A797A` at 5.06:1, now `#937071` at 4.50:1). The defaults and the
  three presets are unchanged.
- The Colors panel opens left-aligned when right-aligned would run off the page (the Colors button wraps to the
  start of the toolbar's second row at 1440 px wide).
- Engine API: `initialBalance`, `ibLines`, `rthDay`, `nyseHolidays`, `onGround`, `markOnGround`, `pairOnGround`,
  `distinct`, `mix`, `chromeColors`, `CHROME_VARS` in `util`; `BACKGROUNDS`, `FLOOR`, `PAIR`, `IB_FORMING_DASH`;
  `getLevels()`; a level may carry `layer` ('ib'), `from` (drawn from that time) and `tone`; `colors()` adds
  `text2`, `legendBg` and `ground`; `getTheme()` returns the colors as chosen; `stats().themeBuilds`.
- The IB high was `#F5BDE8` in the first cut (1.49:1 from the low); it is `#F7C6EC` now.
- CI runs `npm test` on Linux and Windows (`windows-latest`); the repo keeps no lock file, so it installs with
  `npm install --no-package-lock`.
- Tests: `test/ib.test.js` (forming, the lock at exactly 10:30:00 with trades at 10:29:59.999 and 10:30:00.000, four
  DST dates, straddling 1-hour, 40-minute and Range bars, backfill against live at every load minute, coverage:
  history from 9:45, yesterday plus 9:45, a 9:40 to 10:10 hole, a missing 9:30, data that stopped; weekends, the 2026
  NYSE holidays and early closes, the 2022, 2026 and 2027 calendars); `test/theme.test.js` (the default is the 1.5.2
  palette key for key; every role and every pair apart on the presets, all 256 greys, the extremes and 2,000 random
  grounds; the IB layer, colors and 9:30 start on the canvas; the light page chrome at its floors on 300 light
  grounds; the theme built once per change); `npm run smoke:ib` (the page and a mounted chart on a chosen New York
  time: forming at 10:00 on every view and after a reload, drawn from 9:30 by pixel, locked at 11:15, nothing at
  9:00, on a Saturday, on Labor Day or with history from 9:45; the four presets and picked colors, `#abc` and an
  invalid entry, buy and sell apart on `#767676`, the light toolbar at its floors, a reload, a second tab, the
  embedded chart's own key, Reset). The live, embed and settings smokes count five indicators.
- **Open for Anthony:** after 18:00 the day's IB is no longer drawn (the Globex evening belongs to the next trading
  day); say if it should stay up until the next 9:30. If ChartBridge is unreachable across 10:30 the IB disappears
  (minutes missing) and comes back with the reconnect's history.

## 1.5.2 (2026-09-29): ChartBridge 0.3.2, a PIN on ChartBridge's own page

ChartBridge (nt8/), the standalone page and the engine file (`src/chart-engine.js`, its version, shown in the
legend). **This release needs a recompile:** run `nt8\install.ps1` again (it now also copies `ChartBridgePin.cs`,
`live/pin.js` and `live/pin.css`, and the page and engine files), then compile in NinjaTrader (F5). A chart mounted
with `ChartLive.mount` (The Desk) behaves as in 1.5.1. The first time the page opens
on each PC, it asks for a PIN to be set; nothing streams to it until then.
- **A 4-digit PIN on `http://localhost:8765/`** (Anthony's design, a kid lock): "Set a PIN" once per PC, then the
  pad each time the page opens or reloads (mouse, touch or keyboard; the chart's look). Nothing streams and no
  order bar shows until it is unlocked: ChartBridge refuses the page's WebSocket (403, before the upgrade) and
  `GET /session` without the unlock token. The **PIN** button in the toolbar changes it (current PIN first).
- **No lockout, ever.** A wrong PIN is refused and that is all: nothing is counted, delayed or blocked, so the
  right PIN always works at once.
- **Never thrown back to the PIN mid-trade.** Once unlocked, a page stays unlocked while open, also across a
  ChartBridge restart (F5): the page holds an unlock token in memory (never in storage), an HMAC-SHA256 keyed
  by a random secret in `pin.txt`, which a restarted ChartBridge checks from the file. The page asks for the
  PIN again only when ChartBridge answers that the token no longer holds, never because ChartBridge is down.
  Changing the PIN keeps open pages unlocked. Armed is still off after a reload or a drop.
- **Stored:** only a salted PBKDF2-SHA256 hash (50,000 iterations, `Rfc2898DeriveBytes`; about 0.2 s per unlock
  on Mono) and the secret, in `Documents\NinjaTrader 8\ChartBridge\pin.txt`, flushed to disk before it is
  swapped in. **Forgotten PIN:** delete that file (NinjaTrader may stay open); the page asks for a new PIN on its
  next open or reconnect, and old tokens stop working (this also revokes every open page). On a fresh PC,
  whoever opens the page first sets the PIN.
- **A damaged or locked pin.txt is never "no PIN"** (review B1): three states (missing, ok, broken). While it
  cannot be read, open pages keep working from the last good copy, "Set a PIN" is never offered and the file is
  never written over; with no good copy the PIN answers 503 and the page keeps its unlock and recovers by itself.
  A page shown the pad again keeps its token and closes the pad by itself if the unlock holds again. A refused
  `GET /session` is retried after a status check. A page that first met an older ChartBridge checks again on
  every reconnect.
- **Unchanged:** The Desk's Live tab (`allowOrigins`) and local programs with no Origin (The Desk's relay)
  need no ChartBridge PIN; every order gate is as before. PIN endpoints (`POST /pin/status`, `set`, `unlock`,
  `change`) take the own page only (the exact Origin check orders use), `Host` localhost, JSON of at most 256
  bytes with only the named keys. The PIN and tokens are never logged; `/diag` shows only `pin.set`.
- **/diag after a Desk outage** (from the trading PC's fill-queue test): `desk.lastError` is cleared once a
  send to The Desk goes through, instead of showing the old error next to `lastSendFailed: false`.
- Tests: the Mono harness runs ChartBridge's real server for the PIN (hashing checked against PBKDF2 directly,
  set, change, 200 wrong PINs then the right one within a time bound, torn, empty and share-locked pin files, a stop and start keeping the page's token, the strict
  endpoints, `/session` and the WebSocket gate, the forgotten-PIN recovery, nothing in the Output window), and
  The Desk queue down and back up; source guards pin the PIN check before the upgrade and before `/session`,
  no counters or delays, and no PIN or token in any log call. The fake bridge has the same PIN
  (`test/fake-pin.mjs`; `--test-pin`, `--pin-file`), every smoke goes through it, and `npm run smoke:pin`
  covers set, unlock, reload, a restart mid-session with a position open, change, a phone with touch, a 500 from
  `/pin/status`, a refused `/session`, a torn pin file (also at a restart) and the forgotten PIN. `smoke:embed` checks the mounted chart shows no pad and asks nothing of `/pin/` with a PIN set.
## 1.5.1 (2026-09-29): Range bars smooth again

Page and engine only; nt8/ is unchanged. Run `nt8\install.ps1` again after pulling (no NinjaTrader recompile).
Anthony found the live NQ Range 40 chart choppier on 1.4.1 than before. Measured with the new `test/perf-live.mjs`
(sample NQ trades from the fake bridge, 150 a second with bursts of 450, headless Chromium): the cost of each
tick and each frame had not changed, but three things had.
- **The chart could stop drawing for good** (engine, since 1.0; exposed by 1.4.0). A tick handled after a frame
  began, when that frame's time stamp was more than 166 ms old, gave the live price ring a negative radius; the
  canvas threw and the frame loop never asked for another frame. 1.4.0 made Range load up to 33 hours of ticks,
  and building them is a long task that leaves such a stale frame behind: at 01:30 ET the loop stopped after
  8 of 10 loads in the benchmark (0 of 10 with 1.3.1 and 1.2.1, which load 8 hours; 0 of 10 now). The ring and
  the price tag flash now treat such a tick as brand new (no visible change), and the next frame is asked for
  before drawing, so an error while drawing no longer stops the chart. What was drawn stays on screen (never a
  black canvas), the error is reported at most once per 5 s per message (again after a clean frame), and a new
  engine event `on('error')` puts it on the live page's status line until the next clean frame. The embedded chart
  (ChartLive.mount) runs the same code and was measured the same way.
- **Ticks off the JavaScript heap** (`TickStore` in `live/bar-builder.js`). The page kept every trade of the
  backfill as its own small array: 33 hours of NQ is about 1.8 million objects, some 100 to 150 MB of heap for
  the garbage collector to walk and move (in 60 s windows after a load, single pauses of 34 to 78 ms seen on
  1.5.0 and at most 12 ms now; shorter windows often show neither). They are now
  columns of numbers in 65,536-trade blocks (never copied as they grow, dropped whole when the page trims):
  heap about 52 MB instead of 96 to 150 MB, and the bars are built exactly as before.
- **Faster range builds** (`live/bar-builder.js`, NinjaTrader style; Traded prices only is a little faster from
  the tick store alone): a trade that stays inside the forming NinjaTrader-style bar
  takes a short path (same arithmetic, checked against the full path on millions of trades), and building from
  the tick store allocates nothing per trade. Changing the range size or style on 33 hours of ticks now blocks
  the page for about 50 ms instead of about 150 ms (1.3.1 took about 18 ms on its 8 hours); the load's last step
  shrinks the same way.
- **Legend**: the source line names both versions, "NinjaTrader via ChartBridge 0.3.1 · chart 1.5.1".
- **Range style**: the NinjaTrader / Traded prices only select has a visible "Range style" label.
- Tests: `test/perf.test.js` in `npm test` (a stale frame time stamp never stops the frame loop, a drawing error
  never blanks the canvas and is reported at most once per 5 s per message, per-frame cost does not grow with bars held, 2 million ticks add
  under 16 MB of heap and a live tick costs the same as with none, TickStore); `npm run smoke:perf` (Range 40
  with 33 hours of sample ticks, three loads: fails on a page error, a stopped chart, frames over 50 ms or ticks
  back on the heap; it fails on 1.5.0). The fake bridge gets `--tick-rate`, `--live-rate`, `--serve-root` and
  `--clock-offset` for load tests.

## 1.5.0 (2026-09-29): the live chart as a mountable piece (ChartLive.mount), for The Desk

Page and engine only; nt8/ is unchanged except that `nt8\install.ps1` now also copies `live/live.css`. Run
`nt8\install.ps1` again after pulling (no NinjaTrader recompile).
- **ChartLive.mount(container, options)**: the same live chart code runs in a host page such as The Desk's
  Live trading section, returning `{ destroy(), chart, element, paneId }`. Options: `wsUrl` (a string, or a
  function asked again for every connect and reconnect, so a relay can hand out a fresh single-use ticket),
  `paneId`, `storagePrefix`, `onStatus`, `brand`. See `live/EMBED.md` for the files to vendor, in load order.
- **Always read only when mounted** (review N1: a `trading` option is ignored; only the standalone page, booted
  with `data-mount="page"`, can trade): no `GET /session`, no `auth`, only `subscribe` and `ping` ever sent (anything
  else is dropped), no order bar, Armed switch, Shift+click orders or draggable order lines.
- **Nothing global**: each chart keeps to its own element (class `chart-live`, element ids prefixed per mount);
  its listeners on document and window, timers and WebSocket go with `destroy()`. Mount, destroy and mount
  again all work, and several charts can run in one page with their own indicators (`paneId`).
- **Settings apart**: every storage key gets the `storagePrefix` in front (default `embed:`), so an embedded
  chart and the standalone page on one origin never share settings.
- **The standalone page is unchanged**: it now builds itself with the same code (`<script src="live.js"
  data-mount="page">`), with the ids it always had. Its styles moved to `live/live.css`, scoped under
  `.chart-live`; computed styles and layout of every page element match 1.4.1 at 1440, 900 and 400 px, with
  trading on and off. The Armed border sits on the chart root instead of `body`.
- `live/EMBED.md`: a host connecting straight to `ws://localhost:8765` needs its origin in ChartBridge's
  `allowOrigins`; smoke:embed runs the host on its own origin, refused when not listed, live when listed (S3).
- `live/EMBED.md` lists what the chart sends for a relay: `subscribe` with `days` 5 and `tickHours` 0, 8 or, for
  Range bars, 9 to 33 (never over 48); a relay that clamps `tickHours` gets the partial-session note (review S2).
- **Drawings per pane** (review S1): a pane other than `main` keeps its lines under
  `live-drawings-v1-<paneId>-<ROOT>`, so two panes on one instrument no longer overwrite each other; the main
  pane (and the standalone page) keeps `live-drawings-v1-<ROOT>`.
- **Order drag safety** (review N4, also on 1.4.2): an order drag let go outside the plot (over the toolbar, an
  axis, off the chart) or at a price not on screen is cancelled; the line goes back and nothing is sent. Before,
  it sent a move to an extrapolated price Anthony never saw. Engine unit test and an orders smoke case.
- Engine: `mountThemePanel` returns `destroy()` (removes the Colors panel and its document listener), and saves
  only the colors a change sets, on a fresh read, so two charts sharing the key no longer undo each other.
- Tests: `npm run smoke:embed` (a plain host page with one and two panes against the fake bridge); the fake
  bridge gets `--tickets` (single-use WebSocket tickets, like The Desk's relay) and, with `--test-controls`,
  `/test/drop` and `/test/received` (its `ticketsRefused` is apart from the network `refused` counters); a unit
  test checks `install.ps1` copies every local stylesheet.

## 1.4.2 (2026-09-29): ChartBridge 0.3.1, network hardening

ChartBridge (nt8/) only; the page and the engine are unchanged apart from the version. Run `nt8\install.ps1`
and recompile in NinjaTrader.
- **This PC only.** A read-only check on the trading PC found that HTTP.sys listens on every interface and
  matches only the `Host` header: a request to the Wi-Fi or Tailscale address with a forged `Host: localhost`
  was answered. Every request, on every path (page files, `/diag`, `/session`, `/ws`), is now checked first,
  before any routing: it must come from a loopback address (`127.x`, `::1`, `::ffff:127.x`), or it gets 403.
  Refusals are logged once an hour per address. A firewall rule blocking inbound 8765 is still recommended as
  a second layer (README, PROTOCOL.md "Network access").
- **WebSocket origin allow-list.** A browser may open the read-only WebSocket only from ChartBridge's own page
  or an origin in the new `config.txt` line `allowOrigins` (exact `scheme://host[:port]`, lower-cased, no
  wildcard; The Desk's Live trading page goes there). No `Origin` header (a local program) is allowed;
  `null` is refused. Trading still needs ChartBridge's own page. `/diag` shows the rules under `network`.
- **Missing-stop alarm** (from the Sim101 test): when the stop's OCO target was cancelled too, the alarm says
  "... the target was cancelled too (OCO), so the position has no stop and no target" (or, when the target went
  first, "the target was rejected and the stop was cancelled with it (OCO)"). The start of the text is unchanged.
- Tests: the Mono harness unit-tests the address check (IPv4, IPv6, mapped IPv4, LAN, Tailscale, none) and
  the origin check (own page, listed, unlisted, null, missing), runs the real request handler behind a
  listener on every interface with plain GETs (a forged `Host: localhost` from another address is 403 on every
  path), and covers the OCO alarm. Mono's HttpListener has no server WebSocket, so the upgrade itself is not run
  there: a source guard pins the address check (and the Origin check) before the upgrade, and a one-time curl on
  the trading PC checks it for real (PROTOCOL.md, Network access). The fake bridge follows the same origin rule
  (`--allow-origins`).

## 1.4.1 (2026-09-29): fixes from the review of 1.4.0

Page only again; nt8/ unchanged. Run `nt8\install.ps1` to copy the page files.
- **Range box** (S1): the chart rebuilds only when the size is committed (Enter, the arrows, leaving the box),
  never on a half-typed number, so a slow "1" on the way to "12" no longer rebuilds at 1 tick (1.3 s on a 2M tick
  backfill). A whole number typed is still saved for a reload; an invalid one ("450") drops that and keeps the
  committed size; a reload mid-typing saves the box with the same clamp as Enter (450 becomes 400).
- **Two tabs** (S2): indicators are saved one indicator per pane, and brackets one stop or target per root, at a
  time, so a tab loaded earlier no longer undoes another tab's change.
- **New panes start with no indicators on** (Anthony's decision). The main pane keeps today's set.
- **Range bar times** (N1): the trade's own bar keeps the trade's time and phantom bars sit in the gap since the
  previous trade, so a fill on a jump trade lands on the bar holding its price, and bar times no longer run ahead
  of the trades (only same-instant trades step on, by 10 microseconds a bar).
- **Leg summary** (N3): stops or targets over the position show in the warning color with the reason (a fill would
  reverse it); orders ChartBridge reports as kind "other" (MIT, LIT) are not counted and the summary says how many.
- **Range backfill** (N4, N5): after the tick cap trims, switching to Range reloads only if this session's start is
  no longer covered; when NinjaTrader sends less tick history than asked, the status line says the first session
  is partial.
- `docs/RANGE_BARS.md`: Break at EOD is on in Anthony's charts (confirmed by Anthony); NinjaTrader stamps a bar
  with its close time, the page with its open time (N2).
- Tests: the settings smoke covers "450", a slow "12" and a reload mid-typing; two-tab indicator and bracket
  tests; a fill on a jump trade; bar time bounds; over-coverage and not-counted orders (unit and orders smoke);
  the tick trim and partial history helpers; the live smoke checks the partial note with 2 hours of history
  (fake bridge `--tick-hours-max`).

## 1.4.0 (2026-09-29): quick wins on the live page (Phase A: B1, B2, indicator menu, leg summary)

Page and engine only; ChartBridge (nt8/) is unchanged, so no NinjaTrader recompile. After pulling, run
`nt8\install.ps1` again to copy the page files.
- **B1, the range size did not stick** (NQ set to 40 ticks, back to 20 after a reload). Two causes, both
  reproduced by the new `npm run smoke:settings` on 1.3.1: a size typed and not committed (no Enter, no click
  elsewhere) was never saved, since the page saved only on the input's change event; and every save wrote the
  tab's whole copy of the sizes back, so a second chart tab saving its own size put NQ back to 20. Now each
  choice is saved one field at a time (read fresh, change one field, write), as it is typed (whole numbers only,
  350 ms after the last key) and at once on Enter or leaving the box, and anything still waiting is saved when
  the page is hidden or closed. This covers the instrument, bars, range size (per instrument), range mode, glide,
  indicators (per pane) and bracket ticks (per instrument). New keys `live-settings-v2`, `live-range-v2`,
  `live-indicators-v1`; the 1.3 keys are read once, so earlier choices carry over. All storage access is in
  try/catch.
- **B2, range bars like NinjaTrader's.** From NinjaTrader's own `@RangeBarsType.cs`: a finished bar is exactly
  the range and closes on its high or low (even a price that did not trade), the next bar opens one tick
  further on, a jump of more than one range is filled with phantom bars (exactly the range, no volume), and a
  new session starts a new bar at its first trade. This is the default; the 1.3 behaviour stays as **Traded
  prices only** in a select next to the range size. Range bars now start from a session's first trade (the tick
  backfill reaches back to this session's start, or also the previous one while this one is under 8 hours old,
  at most 33 hours), so a reload gives the same bars; backfill and live use the same code. Sources, dates and
  open points: `docs/RANGE_BARS.md`.
- **Indicator menu.** The row of indicator chips is now one **Indicators** menu with checkboxes, per chart pane
  (state keyed by pane id, `main` today). The first run shows the same indicators as before. Keyboard: Enter
  opens it with focus on the first box, Space toggles, Escape or a click outside closes it. Fits at 400 px.
- **Leg summary** (trading on only): next to the position, "stops cover 2 of 2, targets cover 2 of 2", from the
  working orders the page already has, in the error color when stops cover less than the position. Orders sent
  are unchanged.
- Engine: version 1.4.0; no drawing or motion change. Nothing added per frame.
- Tests: `test/prefs.test.js` (storage, carry-over, a throwing storage, every page script is on the
  `install.ps1` list), range bar known answers for both modes (multi-range jumps, a session boundary, live
  equals a rebuild, the same bars from two backfill windows), `legSummary`; the live smoke drives the menu and
  checks every finished NinjaTrader range bar on the page is exactly the range; the orders smoke fills a 2-lot
  in two pieces. Fake bridge: `--tick-gaps` for tick history with price jumps.

## 1.3.1 (2026-09-29): fill marks that add up

From a report on the trading PC: a 3-lot trade whose target filled as three 1-lot executions drew as
"▲3" and one "▼1", because the three sell marks sat on top of each other.
- Engine 1.3.1: fills on the same bar, side and price (to the tick) draw as one mark with the summed
  quantity, so that trade reads ▲3 and ▼3. Fills on one bar at different prices keep their own marks, and
  their labels stack apart (sells up from the price, buys down) so each quantity reads. Triangle tips stay
  at the fill prices. Merging is for drawing only; `setMarkers` keeps every execution. The merged marks
  are rebuilt only when the fills, the bars or the tick change. Helpers `groupFills` and `stackFillLabels`.
  Nothing else in the look or the motion changed.
- Tests: `test/fill-marks.test.js`.

## 1.3.0 (2026-09-29): trading from the chart, the chart side (Step 2)

Order entry on the live page through ChartBridge protocol v2 (`nt8/PROTOCOL.md`, "Orders"). Everything is
checked by ChartBridge; the page adds its own checks on top. With ChartBridge 0.2 the page is read only,
exactly as before.
- Engine 1.3.0: `setOrders` (order lines with a label, a close x and a price-axis tag; green buy, red sell,
  stops dashed), `setPosition` (average price line with open P&L in points and dollars, `pointValue`),
  `setOrderEditing`, `setOrderPreview`, events `orderMove` (drag a label or tag, tick-snapped, Escape
  reverts), `orderCancel` (the x) and `orderPlace` (Shift+click without moving), plus `orderHandles`,
  `priceToY`, `yToPrice` and the helpers `orderLabel`, `openPnl`, `fmtMoney`, `fmtSigned`. Nothing else in
  the look or the motion changed.
- Live page: signs in with the token from `GET /session`; an order bar with the **Armed** switch (off after
  every load; off again when the account or instrument changes or the connection or trading is lost),
  account (only `trading.accounts`), qty (1 to the root's `maxQty`), Buy / Sell MKT, Shift+click side,
  bracket stop / target ticks per root (remembered in this browser), Flatten and Cancel all; working orders,
  the position and fills on the chart; order messages and refusals in the status line; ChartBridge errors
  stay on screen. No bracket on an order that reduces the position. No trading inside a frame. A repeat
  click on the same action within 0.4 s is ignored. No order hotkeys.
- Fake bridge: protocol v2 with the same gates as ChartBridge and a small matching engine
  (`test/fake-orders.mjs`, the reference behaviour), `--trading`, `--trade-accounts`, `--max-qty`, `--v1`,
  `--test-controls`, `--allow-frames`.
- Tests: gates, matching, brackets, flatten, Origin and token (`test/fake-bridge.test.js`), the page helpers
  (`test/order-ticket.test.js`), and `npm run smoke:orders` in Chromium at 1440 and 400 px.
  `npm run smoke:live` now runs against the fake as ChartBridge 0.2.

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
