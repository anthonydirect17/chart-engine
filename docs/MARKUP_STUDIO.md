# Markup Studio

Grade NQ (or ES) liquidity sweeps on our own charts, blind, so your reads can be turned into bot rules. Read only: it cannot trade.

## How to run it (Anthony, at HOME)

1. Get the repo into its own folder (not the clone the PC updater runs from): `git clone -b markup-studio https://github.com/anthonydirect17/chart-engine.git E:\SchwabDesk_bulk\markup-studio`, then `cd E:\SchwabDesk_bulk\markup-studio` (later: `git pull` there).
2. Check it reads your data: `py -3 tools\markup_studio.py --check` (prints the days found, one day's ticks and times, its first
   candidate), then run it: `py -3 tools\markup_studio.py` (it reads `E:\SchwabDesk_bulk\tickreplay` and `E:\SchwabDesk_bulk\ticks_packed`).
3. Your browser opens http://localhost:8790/live/markup.html (open it yourself if not).
4. You should see "Finding candidates: N of M days" top right; when it says "Excluded N already-seen", press **Next candidate**.
5. Your grades go to `E:\SchwabDesk_bulk\marks` (one JSON per grade, `marks_log.jsonl`, and `marks_export.csv` from **Export CSV**).
6. To stop it: Ctrl+C in the window where you ran it. If it says the port is in use, it is already running (or stop the other one).

## ES

- Run it on ES with ES's own marks folder: `py -3 tools\markup_studio.py --symbol=ES --marks=E:\SchwabDesk_bulk\marks_ES`
  (add `--bot=PATH` as for NQ; `--check --symbol=ES` first to see the ES days). Never point ES and NQ at the same marks
  folder: the grades, the candidate cache and the day split are per symbol. NQ needs no flag (`--symbol=NQ` is the default).
- `--symbol` takes NQ or ES; anything else stops the Studio at startup with the list it knows (never NQ by default).
- Everything per symbol comes from one table, `INSTRUMENTS` in `tools/markup_core.py`: the tick (0.25 both), $ per point and
  the round trip per contract. NQ $20 a point, $4.50 a round trip; MNQ $2, $1.00; ES $50, $4.50; MES $5, $1.00. The round trips
  are Anthony's prop account rates; ES and MES cost the same as NQ and MNQ (NinjaTrader's commission table, as of
  2026-08-14). Change them there only.
- The page takes the instrument from the server's hello: the header ("ES replay, read only"), the charts' root and the mark
  tick. The Bot tab's dollars name ES and MES.
- **Split guard.** A new `bot_split_v1.json` records its symbol (`"symbol": "ES"`). On start the Studio refuses (and does not
  start) when the folder's split names another symbol. A split without a symbol is one written before splits recorded theirs:
  it is refused when the folder's grades or `candidates_v1.json` name another symbol; otherwise it is taken as NQ's for NQ,
  and for ES only when every day in it is one of ES's in-sample days, with a line in the window ("taken as the ES split"). A
  split file is never rewritten, so an old symbol-less ES split (marks_ES on the USB) keeps working as it is.

## Using it

- Training is on RTH sweeps only (09:31 to 16:00). Levels: PDH/PDL (prior day's RTH) and ONH/ONL (18:00 to 09:29:59),
  the last two only when the day's data really starts the evening before. The blind queue offers quote days only (real
  volume and buy/sell); `--include-last-only` adds the others. The charts load the prior kept day's minutes first, so the
  LV button draws PDH, PDL, Prior close and PD VAH / VAL / POC as on the live charts (nothing of the day after the clock).


- **Blind** (the default): Next candidate opens a sweep at its cut (the close of the 1-minute candle holding the reclaim). Only
  the time of day shows, never the date. You can start while the scan is still running ("scanning: N of M days"). The cut is
  exclusive: a trade stamped exactly at the cut (the next candle's first) is not shown; Next candle moves the cut one minute.
  The Free tab stays locked until the grade is saved. The level is the dashed purple line. **Next candle** steps one minute (counted).
  Grade: setup `1` SWEEP, `2` RETEST, `3` NONE, `4` WAIT; `L` long, `S` short; click reason chips and/or type; add marks (Level,
  Failed candle, Reclaim candle, Entry, Stop, Target: pick the button, click the chart) and spans (Volume I'm reading,
  Approach: pick the button, drag across the chart). `Esc` cancels a mark. **Save grade**. Only then do the machine read and
  the rule draft's verdict show, and **Reveal** (plays on at 5x) or **Jump 30 min** look at what came next.
- **Free**: any in-sample day, any time, play 1x/5x/20x/60x, pause, step, jump forward. Dates show. The machine read is always
  on (for the Level you mark, else the day's latest candidate before the clock).
- **Agreement with the draft**: your SWEEP against draft v0's TAKE over all grades; each disagreement opens in Free mode at
  the same clock. Draft v0 (from your words): TAKE when the volume into the level is falling (slope below 0) and a candle has
  closed back beyond the level; entry A the reclaim close, entry B the confirmation break. Its numbers are in
  `tools/markup_rule_v0.json` (read at every save).
- Add your own chips with the box under the chips (kept in `chips.json` in the marks folder).
- No P&L and no outcome statistics in Blind or Free (the Bot tab sums the bot's own trades only).

## Bot tab

Watch a bot trade replayed days on the same charts, or run it over every bot day. The Studio knows no trading rule: it loads
a bot module and shows what the bot returns, never more than the clock allows.

- Start with a bot: `py -3 tools\markup_studio.py --bot=PATH` (a `.py` file that speaks BOT_API 1: `BOT_API`, `NAME`,
  `variants()`, `exit_ids()`, `run(day, prior, params, progress)`). Without `--bot` the tab says how to start with one; a
  module that does not load or check out says why there (and in the window), and the rest of the Studio works as before.
  `test/markup_bot_fixture.py` is a made-up test bot for the tests only.
- **The day split.** On the first start the Studio writes `bot_split_v1.json` in the marks folder: every last-only day and
  half the quote days (sorted, shuffled with seed 7, the first half rounded up) are bot days, the other quote days are
  grading days, and the symbol (see ES above for the guard). It is never rewritten; days added later go to neither list (the window logs them). The blind queue offers
  grading days only (its line counts the candidates "on bot days"); the Bot tab opens bot days only and refuses grading days
  and the holdout (403). Free mode is unchanged.
- **Using it.** Pick a bot day and a variant, **Load**: the day opens at 09:30 like Free mode (play, pause, Next candle, jump)
  and the bot runs once on it in the background (the prior kept day goes with it, as for PDH/PDL). The charts draw each order
  up to the clock (entry orders dashed white, "BUY STP 21,001.00"), fills with their price, the open trade's stop (red) and
  target (green), and exits ("target +10.00"). The panel lists the bot's events (newest first), the day's trades (result per
  the base exit once closed) and the day's net per exit id after costs. Nothing after the clock: `/api/bot/view` is cut by
  one function (`bot_view` in `tools/markup_core.py`); events up to the clock, orders clipped at it with their status only
  once ended, trades once entered and each exit once it happened. The tab is locked while a blind candidate is ungraded.
- **Run all bot days** runs every bot day with every variant ("day k of n"), then shows the summary: per variant and exit
  id the trades, wins, losses, win %, average R, net points, net $ of 1 contract of the symbol and of 1 micro (NQ and MNQ,
  or ES and MES; total and per trade, after each one's round trip, `INSTRUMENTS`), profit factor (full contract) and max
  drawdown of closed-trade equity, with the trade count next to every number, and the same split by level type and by side.
  Files: `<marks>\botruns\<stamp>\trades.csv` (every trade with its features), `summary.csv`, `summary.json`; **Export**
  shows the folder.
- **Dollar fields.** `usd` is 1 contract of the symbol, `usd_micro` 1 of its micro, each after its round trip. The day's net
  (`/api/bot/view`): `net[exit] = {trades, points, usd, usd_micro}`. Summary rows: `net_usd`, `net_usd_per_trade`,
  `net_usd_micro`, `net_usd_micro_per_trade`, `pf`, `max_dd_usd`, `max_dd_usd_micro`. `trades.csv`: `symbol`, `micro` and per
  exit id `<exit>_net_usd`, `<exit>_net_usd_micro`; `summary.csv`: the rows with `symbol` and `micro`; `summary.json`:
  `symbol`, `contract`, `micro`, `point_value`, `rt`, `micro_point_value`, `micro_rt` and `costs` (per contract name). Run
  folders written before ES support have `nq` / `mnq` columns instead; the Studio never reads them back.

## Flags

`--tickreplay=DIR` `--data=DIR` `--marks=DIR` `--port=8790` `--symbol=NQ` (or ES) `--rule=FILE` `--no-browser` `--check[=YYYY-MM-DD]`
`--bot=PATH` (a bot module for the Bot tab)
`--include-last-only` (blind queue normally offers quote days only, where volume and buy/sell are real) `--seen=CSV[,CSV]` (events already seen; default: `tickbench\runs\sweep_blind\KEY.csv` and the CSVs in
`tickbench\runs\eventstudy_r1\prints\`, matched by date, level and reclaim within 180 s, best effort; those are NQ
events, so with `--symbol=ES` there is no default and the window says so).

## How it works

- `tools/markup_studio.py` (Python 3.10+, stdlib and numpy) serves `live/` and `src/` and speaks the read-only part of
  ChartBridge's WebSocket protocol (`hello`, `history`, `ticks` as `[t, p, v, s, sm]`, `ready`, `tick`, `status`;
  nt8/PROTOCOL.md), so the page mounts the very charts of the live pages with `ChartLive.mount` (live/EMBED.md): Range 40
  NinjaTrader-style bars, 1 minute, volume, VWAP and the cumulative delta pane. Trade sides come from the bid and ask (`sm`
  2) or the tick rule (`sm` 3) when a day has no quotes (the delta pane then counts only from the load on).
  Every chart message other than `subscribe` is ignored; there is no order path at all.
- **No future, by construction.** `visible_count(day, clock)` is the one place that says how many ticks exist; the history
  bars, the tick backfill, the live ticks, the machine read and the saved grade all take the day cut there. In blind mode
  play and jump are refused until the grade is saved, the clock never moves backward, and nothing the page receives names
  the date. `npm run smoke:markup` records every frame and response and checks each time against the clock, and that each
  chart got exactly the day's ticks up to it; a mutated server that lets one tick through must fail it.
- The page sets its `Date.now()` to the replay clock (the charts read "now" for the session, VWAP and range-bar loads) and,
  in blind mode, strips dates, weekdays and month names from every text drawn on the charts' canvases and from the page's
  text and tooltips (the engine has no option to hide dates; the frozen chart files are unchanged).
- Data: tickreplay's `loader.load_session(symbol, date, data_root=...)` (corrections applied; `Session.ticks`: `ts_ms`,
  `last`, `bid`, `ask`, `vol`, `has_quotes`). Days: `sessions_index.csv` in the tickreplay folder, the research's in-sample
  list (the `--symbol`'s rows, before 2026-04-01, without `holiday_close`, `missing_day` or `truncated`; a day whose first RTH tick is after
  noon is dropped when scanned).
- Candidates (Python, ticks up to each reclaim only): PDH/PDL the prior kept day's RTH high and low, ONH/ONL 18:00 to
  09:29:59; RTH from 09:31:00; through by 4 or more ticks, back by 1 or more tick on the original side within 120 s of the
  first cross; 30 minutes refractory per level per day; none after a gap of over 5 minutes inside RTH (a halt); shuffled
  with seed 4; cached in `candidates_v1.json`.
- Times: tickreplay gives New York wall-clock ms; the server converts with zoneinfo (US rules when Windows has no time zone
  database). Holdout: every date from 2026-04-01 on is refused (listing, loading, candidates, free mode).
- Tests: `npm run test:markup` (Python unit tests), `npm run smoke:markup` (Chromium; `PYTHON=py` on Windows). The npm
  scripts `bridge:replay` and `test:markup` call `python3` (Linux, CI); on Windows run `py -3 tools\markup_studio.py` and
  `py -3 -m unittest discover -s test -p "test_markup*.py"` instead.
- A day that fails to load is logged in the window and skipped (the page counts it); a seen file with no usable rows shows a
  warning in the page. Grade files are written whole to a temp file first, so there is never an empty one.
