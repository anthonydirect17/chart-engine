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
