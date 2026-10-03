# Markup Studio

Grade NQ liquidity sweeps on our own charts, blind, so your reads can be turned into bot rules. Read only: it cannot trade.

## How to run it (Anthony, at HOME)

1. Get the repo: `git clone https://github.com/anthonydirect17/chart-engine` (or `git pull` in your copy), then `cd chart-engine`.
2. Check it reads your data: `py -3 tools\markup_studio.py --check` (prints the days found, one day's ticks and times, its first
   candidate), then run it: `py -3 tools\markup_studio.py` (it reads `E:\SchwabDesk_bulk\tickreplay` and `E:\SchwabDesk_bulk\ticks_packed`).
3. Your browser opens http://localhost:8790/live/markup.html (open it yourself if not).
4. You should see "Finding candidates: N of M days" top right; when it says "Excluded N already-seen", press **Next candidate**.
5. Your grades go to `E:\SchwabDesk_bulk\marks` (one JSON per grade, `marks_log.jsonl`, and `marks_export.csv` from **Export CSV**).
6. To stop it: Ctrl+C in the window where you ran it. If it says the port is in use, it is already running (or stop the other one).

## Using it

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
- No P&L and no outcome statistics anywhere.

## Flags

`--tickreplay=DIR` `--data=DIR` `--marks=DIR` `--port=8790` `--symbol=NQ` `--rule=FILE` `--no-browser` `--check[=YYYY-MM-DD]`
`--seen=CSV[,CSV]` (events already seen; default: `tickbench\runs\sweep_blind\KEY.csv` and the CSVs in
`tickbench\runs\eventstudy_r1\prints\`, matched by date, level and reclaim within 180 s, best effort).

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
  list (NQ, before 2026-04-01, without `holiday_close`, `missing_day` or `truncated`; a day whose first RTH tick is after
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
