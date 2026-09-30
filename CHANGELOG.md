# Changelog

## ChartBridge 0.3.4 (2026-09-30): every trade carries its side

ChartBridge (nt8/) only: the page, the engine and the chart version are unchanged, and the page needs no change to
work with it. **Needs a recompile:** run `nt8\install.ps1` again (only `ChartBridge.cs` changed), then compile in
NinjaTrader (F5). The first step toward cumulative delta (buy volume minus sell volume); the delta pane comes later.
- **The side of every trade, live and in the backfill** (`ChartBridgeSides`), by the rule Anthony approved: the
  exchange's aggressor flag if there were one (NinjaTrader 8 gives an add-on none, so that code is reserved); else the
  prevailing quote, at or above the ask a buy, at or below the bid a sell; else (between bid and ask, or no usable
  quote) the tick rule: up a buy, down a sell, unchanged the previous trade's side. Each trade also says which method
  found its side, so the chart can show how much was inferred.
- **Wire format, additive:** a live `tick` gains `s` (1 buy, -1 sell, 0 unknown) and `sm` (0 none, 1 aggressor flag,
  2 bid/ask, 3 tick rule); each backfill trade becomes `[t, p, v, s, sm]`, the first three in their places. The live
  page reads `t, p, v` by name and by position, so it takes both unchanged (a node test feeds the new messages to its
  bar builder).
- **Live:** the quote is the last bid and ask NinjaTrader delivered before the trade (its Bid and Ask updates).
- **Backfill:** tick charts ask for NinjaTrader's historical Bid and Ask ticks with the trades (same window, at the
  same time) and take for each trade the last bid and ask stamped strictly before it: a quote at the trade's own time
  is not used, since the quote change a trade causes shares its timestamp. Trades the quote history does not cover
  (before it, or over 5 s past the end of the shorter side) go by the tick rule; with no bid/ask history every trade
  does, and `/diag` and the Output window say so. A refused or empty quote request is asked once more ending now,
  and the quotes get at most 15 s after the trades are in (the live trades are held meanwhile); then the backfill goes
  out without them.
- **The seam (0.3.3) is unchanged:** the side takes no part in matching held live trades against the backfill, so a
  trade the live and the history quote call differently is still sent once (with the backfill's side).
- **`/diag` `sides`:** per instrument, live counts by method with the current quote and whether NinjaTrader's own
  e.Bid/e.Ask on each trade match it; for the last load, counts by method, the Bid and Ask history (ticks, first and
  last times, request result), trades before, after and between the quotes, `tieChanged`, the time resolutions, and
  NinjaTrader's own bid/ask stamps on the trades (usable, like its fill-in, agreeing with the join).
- **Unchanged:** orders, the PIN, network rules and fills (`ChartBridgeOrders.cs` and `ChartBridgePin.cs` untouched).
- Research with sources: `nt8/PROTOCOL.md`, Trade side (NinjaTrader's help for MarketDataEventArgs, Order Flow
  Cumulative Delta, historical Bid/Ask series and Tick Replay).
- Tests: the Mono harness (`check/SidesHarness.cs`, run by `npm run check:orders`) checks the rules (at, above, at and
  below the bid, between, no quote, one side, crossed, float noise, tick rule sequences with unchanged prices), the
  live tagger fed by Bid and Ask updates, the as-of join (ties, no look-ahead, missing history, shorter history at
  either end, whole-second quotes, NinjaTrader's stamps, 300,000 trades on 2,000,000 quotes in about 25 ms), and whole
  loads through Subscribe and the live handler (the quote requests, the answers in any order, a refused or empty
  quote history, quotes that never come, minute charts, the seam with sides that disagree, `/diag`). The 0.3.3 seam cases run unchanged.
  `test/trade-sides.test.js` checks the page's parsing and bar building with the new messages, and the fake bridge,
  which now sends sides (`--no-sides` for the old format).

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
