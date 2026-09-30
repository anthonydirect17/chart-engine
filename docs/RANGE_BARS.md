# Range bars: how NinjaTrader 8 builds them, and what the live page does

Researched 2026-09-29 for B2 ("some range bars come out slightly short of the full range"). Anthony expects
NinjaTrader-style exact bars, so that is now the default. The old behaviour stays as an option, **Traded prices
only**, in the select next to the range size (saved in this browser).

## Sources (all read 2026-09-29)

1. **NinjaTrader's own Range bar type source**, `@RangeBarsType.cs` (namespace `NinjaTrader.NinjaScript.BarsTypes`,
   header "Copyright (C) 2025, NinjaTrader LLC"). NinjaTrader ships it with every install in
   `Documents\NinjaTrader 8\bin\Custom\BarsTypes\` and it opens read only in the NinjaScript Editor. I read public
   copies that people committed from their own installs, and all three have the same bar logic:
   - github.com/DailyLectio/nt8-custom-backup, `bin/Custom/BarsTypes/@RangeBarsType.cs` (Copyright 2025)
   - github.com/vmf20288/footprint, `BarsTypes/@RangeBarsType.cs` (Copyright 2024)
   - github.com/pppmbs/NT8Strategy, `BarsTypes/@RangeBarsType.cs` (Copyright 2021)
   This is the strongest evidence: it is the code NinjaTrader runs.
2. NinjaTrader 8 Help Guide, **Bar Types** (https://ninjatrader.com/support/helpGuides/nt8/bar_types.htm, now served
   from static.ninjatrader.com; no date on the page): "A Range bar is based on a specified tick price range. The bar
   will continue to develop until the price range is broken, at which point a new bar will be created." and "Each
   historical bar in the 4 Range chart shown below represents exactly 4 ticks of price movement."
3. NinjaTrader 8 Help Guide, **Break at EOD** (https://ninjatrader.com/support/helpguides/nt8/break_at_eod.htm; no
   date): bars can break "on each new end of day session, or continue building until completed", and for Range bars
   "enabling this property may cause bars to complete before their criteria has been satisfied".
4. NinjaTrader 8 Help Guide, **IsResetOnNewTradingDay** (https://ninjatrader.com/support/helpGuides/nt8/isresetonnewtradingday.htm;
   no date): "Indicates if the bars series is using the Break EOD data series property."

## What NinjaTrader does (from the source, `OnDataPoint`)

Range R = the range in ticks times the tick size. For each trade at price P:

- **Inside the range** (P between high - R and low + R): the bar takes P as usual (high, low, close, volume added).
- **Past the top** (P above low + R): the forming bar is set to exactly the range: high = close = low + R, even when
  that price did not trade ("Every bar closes either with high or low"). The trade's volume is not added to it.
  The next bar opens one tick above, at low + R + 1 tick, with its low there too.
- **More than one range away:** the source says "If there's still a gap, fill with phantom bars". Each phantom bar
  runs from its open to open + R (open = low, close = high), then the next opens one tick further on. **Phantom
  bars get volume 0**; the trade's volume goes to the last bar, the one holding P. So yes, NinjaTrader draws bars at
  prices that did not trade.
- **Past the bottom**: the same, mirrored (low = close = high - R, next bar one tick below).
- **Time:** every bar made by one trade gets that trade's time, and `UpdateBar(..., time, ...)` restamps the bar
  with each trade, so a NinjaTrader bar's time is the time of its **last** trade (its close time).
  The page keys bars by their **open** time (the first trade's), as the chart does for every bar type, so the
  legend time of a range bar differs from NinjaTrader's Data Box. Prices and volume are the same.
- **Session boundary:** when `IsResetOnNewTradingDay` (the chart's Break at EOD) is on and the trade is the first of
  a new session, a new bar opens at the trade's price. No phantom bars fill the overnight gap, and the last bar of
  the old session can be short of the range. With Break at EOD off, the bar carries on across the session break,
  and the gap would be filled with phantom bars like any jump.

## What the live page does

- `live/bar-builder.js`, `rangeMode: 'nt'` (default) follows the source above step by step, in whole ticks.
  `rangeMode: 'traded'` is the page's behaviour up to 1.3.1: the breakout trade opens the next bar at its own price.
- Sessions start at 18:00 ET (CME equity index futures), and both modes start a new bar there, as NinjaTrader does
  with Break at EOD on (Anthony's setting, confirmed).
- The same code builds the bars from the tick backfill and from live ticks, so they match (tested tick by tick).
- Bar times on a jump (1.4.1): the chart needs strictly rising times, so bars made by one trade cannot share it.
  The trade's own bar keeps the trade's time, and the phantom bars before it sit in the gap since the previous
  trade, at most 1 ms apart. A fill at the trade's time therefore lands on the bar that holds its price, and times
  never run ahead of the trades. Only when trades arrive in the same instant (no gap) do the new bars step on by
  10 microseconds each.
- Range bars depend on where the build starts. To come out the same after a reload, the page asks ChartBridge for
  ticks back to a session start (this session, or also the previous one while this one is under 8 hours old; at most
  33 hours, below ChartBridge's 48) and builds from that session's first trade. Ticks of a session the backfill only
  partly covers are skipped. Seconds bars still load 8 hours.
- If NinjaTrader sends less tick history than asked (little local tick data), the first range tick can fall
  mid-session. The page then builds from there and says so in the status line ("Range bars start at 10:13 ET:
  NinjaTrader sent less tick history than asked ..."), whenever the first tick used is more than 10 minutes after
  its session's 18:00 start. Those bars can differ from NinjaTrader's until the next session starts.
- The ticks are kept in columns of numbers (`TickStore` in `live/bar-builder.js`, 1.5.1), not as one small array per
  trade, so 33 hours of NQ (about 2 million trades) cost the garbage collector nothing.
- On a very long session the page drops its oldest 500,000 ticks once it holds 2.5 million. Switching to Range
  after that reloads the backfill only if the ticks left no longer reach this session's start; otherwise it
  rebuilds from this session's first trade and leaves out the older, now partial, session.

## Live first (1.8.0): range bars before the whole history is in

With ChartBridge 0.3.5 the page goes live on the most recent trades (100,000 by default) and pulls the older history
after (nt8/PROTOCOL.md, Live first). Range bars are path dependent: a bar's boundaries depend on every trade since the
session's first (Break at EOD), so **exact range bars need every trade from 18:00 ET**, and the recent window alone does
not have them. The options, and the choice:

- **Range bars from the window's first trade, shown as they come out.** Rejected: until the two builds happen to meet,
  those bars have other boundaries than NinjaTrader's (and than the page's own a minute later), so the forming bar, its
  "ticks left" countdown and the bars behind it could all change when the history lands. That is a jump a trader can
  mistake for the market.
- **An anchor from NinjaTrader's own Range bars** (a BarsRequest of Range bars, then the page continuing the last one).
  Rejected: NinjaTrader builds them from the same tick history, so it costs NinjaTrader the same load the page is avoiding;
  it exists only for the NinjaTrader style, not Traded prices only; and continuing NinjaTrader's forming bar would need its
  exact state and its own seam with the live trades (a request of bars has no trades to match held trades against).
- **Chosen: range bars shown only from a point where they are proven exact** (`RangeSync` in `live/bar-builder.js`),
  with the 1-minute bars of the whole minutes before that point on their left (hovering one, the legend says "Range 40t
  (1m before 10:31)"), and 1-minute bars alone until such a point is seen (the legend says "Range 40t (1m until
  loaded)"). When a live trade gives the first proven point, the range bars appear to the right of the 1-minute bars
  (review S3: 1.8.0 as first built replaced every 1-minute bar with the one or two range bars that trade opened, a lone
  bar on a price axis still spanning the hours before). A 1-minute stand-in holds only whole minutes before the first
  proven bar, so no trade is in both. Two range builds of the
  same trades meet for good once they close a bar on the same trade with the same edge. That is certain at the first trade
  of a new session inside the window, and after a swing of more than the range each way: once the price has risen more
  than the range from the window's low so far to a high, then falls more than the range below that high (before a higher
  high), every build, whatever it did before the window, has that high as its bar's high and closes the bar down on the
  same trade. (The rise forces a bar that opened after the low; an up close opens a bar at its trade, and a down close
  opens one below the bar before it, so no bar can hold a high above that one.) The mirror holds for a fall and a rise.
  The rule reads only prices and times, in whole ticks, and holds for both styles. `test/live-first.test.js` checks it
  against builds from the session start on 240 made-up histories (both styles, ranges of 4, 12 and 40 ticks, some across
  the 18:00 break): every bar from the sync point on is identical, and a trend without a swing is never taken as synced.
  On NQ Range 40 a 10-point swing each way happens within minutes in most sessions, so with 100,000 recent trades the range
  bars are usually shown at once; with a quiet window the chart shows 1-minute bars until the first swing, live.
- When the last chunk of history is in, the page builds the range bars from the session start exactly as a full load
  does (in slices of its time, so no frame waits) and swaps them in. Every range bar shown before is the same bar after in
  price and volume (the live-first smoke compares them bar for bar), older range bars take the place of the 1-minute
  stand-ins, and the VWAP line appears.
- **Bar times at the swap (review N4).** A range bar's time can differ by 10 microseconds steps between the two builds, and
  only here: when the trade that opens the first proven bar comes in the same millisecond as the trade before it, the new
  bar steps 10 us on from the bar before it (the rule in "Bar times on a jump" above), and the bar before it is not the same
  bar in the two builds (the review's hunt found it in 19 of 1,940 made-up tapes, all at Range 1 in pileups; prices and
  volumes never differed). It cannot matter: both times lie inside the same millisecond as that trade (it would take 100
  bars opened in one millisecond to leave it); the chart places bars by their order, not their time; the legend shows
  minutes; and fills (whole milliseconds) land on a bar by the last bar time at or before theirs, which is the same bar in
  both. Making them identical would need the full build to borrow the early build's time, and then it would differ from a
  full load's instead. The smoke compares the times to the millisecond.
- **When the history ends short** (ChartBridge could not prove its join to the recent trades, they end before them, it
  failed, or it was dropped; nt8/PROTOCOL.md, Live first), the page never builds range bars from trades it cannot stand
  behind: the view stays as it was while loading, proven range bars with 1-minute stand-ins before them (or 1-minute bars
  until a full swing, the legend then says "1m until a full swing"), no VWAP, and the status line says why, with a Reload.
- **At the Sunday 18:00 ET open** (review B1) the recent trades by count reach back into Friday, while NinjaTrader's request
  by date returns only Sunday's session: nothing older comes, and nothing is needed. The first trade of the session is a
  proven point, so the range bars show from 18:00 at once, and after the swap they are a full load's bar for bar (the
  live-first smoke opens a made-up Sunday 18:15 and compares them, and the volume profile counts Sunday's trades once).
- The VWAP of range and seconds bars is the session's, from 18:00 ET, so it too needs every trade: until the history is
  in, those views draw no VWAP line and the legend reads "VWAP loading". (Starting it from the minute history's VWAP, the
  value the 1m view shows, was tried: on sample data it was up to 8 ticks off the exact value, a line that would jump.)

## Confirmed by Anthony

- **Break at EOD is ON** in Anthony's NinjaTrader Range charts (Anthony, 2026-09-29). So NinjaTrader starts a fresh
  bar at the first trade of the 18:00 ET session open with no phantom fill over the overnight gap, and so does the
  page.

## Not confirmed

- **Break at EOD default.** The help pages do not say whether it is on by default (forum advice, "uncheck Break at
  EOD, then save a preset", suggests on). This no longer matters for Anthony's charts: see Confirmed below.
- **The session template.** The page uses one boundary at 18:00 ET. NinjaTrader uses the instrument's trading hours
  template, which can differ on holidays and early closes.
- **NinjaTrader staff forum posts.** The old forum.ninjatrader.com threads on phantom bars and range gaps now
  redirect to a new forum and return "not found", and the web archive was not reachable from here, so I could not
  quote staff. The source code answers the questions directly.
- **Tick data.** NinjaTrader builds Range bars from its tick series; the page builds from ChartBridge's ticks (the
  same series for the backfill, market data events for live). If those ever differ, bars can differ slightly.
- **Anthony's NinjaTrader version.** The three copies (2021, 2024, 2025) have the same logic; worth a glance at
  `@RangeBarsType.cs` in the NinjaScript Editor on the trading PC to confirm.
