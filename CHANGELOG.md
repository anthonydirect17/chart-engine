# Changelog

## chart 1.39.2 (2026-10-27): a benched account sits out with no confirm; a chart's dragged room is its own (page only, no F5)

Page only, no F5: no ChartBridge file changes, so nothing needs a recompile. ChartBridge stays 0.6.9; `minChartBridge` stays
0.6.2 (COMPAT.json follows the page to 1.39.2).

- **A group entry with an account on the bench goes out at once** (`live/trade.js`; Anthony 2026-10-27: "I moved the account
  off the group when it hit its max loss ... that account is supposed to just sit out"). Since 1.34.0 the confirm opened
  whenever any member sat out, and a member Anthony put on the Bench in the Multi-Account panel sits out every entry by design,
  so every entry asked. Now a member out only because it is benched (ChartBridge's `benched: ...` reason) counts as no issue:
  when every other member takes the entry it is sent at once, as when all take it, and the note says who sat out ("On the
  bench, sat out: ..."). Any other reason to sit out (its room too small, not connected, a hedge refused) still opens the
  confirm, as before. ChartBridge still refuses the whole entry if a size changed since the preview.
- **Dragging the room right on one chart no longer moves the others** (`live/live.js`, `live/workspace.js`; Anthony
  2026-10-27: "when I click and drag my minute chart all the charts move together on the drag ... the others should stay
  fixed"). Since 1.37.0 a drag in the gap right of the last bar set Settings' room for every chart, so on release every chart
  following live jumped to it. On his NQ 1 day chart, narrower than the 1 minute chart's new room, every bar went off screen
  and the price scale stayed on a range around 0 with no candles (it fits only bars in view). Now the dragged room is that
  chart's own (saved per chart, `live-pane-room-v1`); the others and Settings keep theirs. A room picked in Settings, a preset
  or Custom, sets every chart to it again and drops the charts' own (Anthony's pick of the two ways).
- **The room drawn is never wider than 80% of the plot** (`src/chart-engine.js` `roomNow`): the last bar always stays on
  screen, whatever room is set. The room asked for is kept as set (Settings shows it); only how much of a narrow chart it
  takes is capped.

## chart 1.39.1 (2026-10-25): the agreed follow-ups (page only, no F5)

Page only, no F5: no ChartBridge file changes (`nt8/*.cs` are the 0.6.9 files, byte for byte), so nothing needs a recompile.
ChartBridge stays 0.6.9; `minChartBridge` stays 0.6.2 (COMPAT.json follows the page to 1.39.1). The PC updater
(`nt8/update-pc.ps1`, PowerShell only) changes too; a PC picks it up at its next `-InstallChartBridge` or `register`, as
always.

- **A tall Indicators menu stays below the top bar and scrolls inside itself** (`live/live.js`, `live/live.css`). The menu
  already stopped below the top bar when taller than the window; its gear card did not keep to the screen: at 400 px wide it
  sat off the left edge (x -299 to 1), a card taller than the room ran past the window's foot, and a window made smaller while
  the menu was open left both where they were. Now, in the workspace: the menu and the gear's card stay between the top bar
  and the window's foot, placed again when the window is resized; a card taller than that room scrolls inside itself; where
  the menu and the card do not fit side by side (400 px), the card sits in the menu's list under its row, as on a host's
  chart, scrolled into sight. Nothing changes at 1366 x 768 and up but the card's height cap. CHART_STYLE.md says so. On
  45a422a the menu itself never went under the top bar in this environment (1366 x 768, 1366 x 620, 400 x 768, each chart of
  the default layout, 9 indicators on, every gear open): the exact case reported was not reproduced; the new smoke checks it.
- **Order labels: the label under a still mouse keeps its row** (`src/chart-engine.js`; the reviewer's probe). A new order
  arriving at the same price, earlier in the order list, took the row at the line from the label the mouse rested on (the
  stack places the orders in their order), so the next press moved the new order. The label under the mouse (its body, its
  x, its add cells) is now placed first in the row it is drawn in, as a pressed one is, until the mouse moves off it or leaves
  the chart. A hover alone moves no label (it and the label kept after a drag, labelFirst, are both where the last frame drew
  them); after Escape or a press that moved nothing the label goes back to its row before the press. Only which label a hover
  or press finds changes: the events (orderMove, orderCancel, orderPlace, orderPlanAdd) and what the page sends for them are
  unchanged. `orderHandles()` gains `y` (each order's line, read only, for the smokes). CHART_STYLE.md says so.
  The review of #72 (HIGH): the kept row was measured against this frame's line, so when the price scale moved under a still
  mouse (auto-scale on a new high or low, a scroll back in time, a zoom) the label stayed at its old screen height and left its
  line (the reviewer's probe: the line 427 -> 274 px, the label stayed at 418), and a drag from it would have landed the stop
  far from where Anthony aimed. The row is now kept against last frame's own line, so the label follows its line; the probe
  gives the label at 265 on the line at 274. `smoke:be-labels` rests the mouse on a stop label and moves the scale with a wide
  bar and with ArrowLeft: the label stays on its line (4 checks fail on the engine before this fix), and a drag from it moves
  the stop by the mouse's distance.
- **The Drone sky's card closes when the mouse leaves** (`live/agents-sky.js`; the agents-strip flake "the card goes when the
  mouse leaves"). Root cause: the card's HTML is replaced while it is open (its live P&L; a click on a thought), and Chromium
  then sends no pointerleave to the card when the mouse leaves within about a frame of that replace (a probe: 0 leaves at 0 ms,
  1 at 20 ms), so the card stayed. A move of the mouse anywhere outside the card, the drones and the list now starts the same
  250 ms close. The smoke now holds the leave events back on purpose, so it fails every time without the fix and passes with
  it.
- **The five page smokes that failed on main** (found on 506dff1; run on 45a422a here):
  - `smoke:plan` (18 of 43): stale since 1.38.0's gutter stacking (2ccb2b1, CHANGELOG "Order labels at break-even"). Labels
    that would overlap stack 20 px apart off their lines, and a drag moves the order by the distance the mouse moves; the smoke
    grabbed the stacked stop label and moved the mouse to the new price's y, so the stop went 7 points the wrong way ("a stop
    goes on the loss side"). The drags now move from the label by the distance from its line to the price, and the "drawn at"
    checks read the line (`orderHandles().y`), not the label. 43 of 43.
  - `smoke:v038` (1): stale since 1.35.0 (159cca4, "The button shows once The Desk answers GET /api/chart-league"). The League
    tab's read-only probe of The Desk runs whatever the ChartBridge. The check now allows that one GET (and checks the League
    button stays hidden with no Desk); every other Desk or /bot-library request is still refused. 28 of 28.
  - `smoke:bot` (1, the pop-out window): stale since the fake bridge's seed loses EVAL-B's connection (PR #58). ChartBridge's
    alarm band then stays at the top until dismissed, over the Bot view's header and its Pop out button, so the click never
    landed (Playwright: "#wsAlertText ... intercepts pointer events"). The smoke dismisses it first, as Anthony would. 66 of 66.
    Not changed: whether the band should cover the Bot view's header (a look question for Anthony).
  - `smoke:kit` (2) and `smoke:screens` (1): both pass on 45a422a and on 506dff1 here (kit 8 runs, one with the CPU slowed 8 times; screens 5;
    also three at once). The kit's two checks most likely to fail on a busy machine were its light colour fades (a 1.6 s transition read after
    a fixed 1.8 s); they now wait for the colour, up to 6 s. The screens failure could not be reproduced and is not changed (its
    default port, 8797, is also member-rules', orders' and markup's, so two of them run at once collide).
  - The agents-strip flake: above.
- **PC updater** (`nt8/update-pc.ps1`, the hidden-register review; Windows PowerShell 5.1 as before):
  - **A task's command line is read as PowerShell binds it**: `-Name value`, `-Name:value` and `-Name: value`, any case, and the
    unambiguous start of a name (`-Rep`). An option given twice, a name that is no option of update-pc.ps1, or one that starts
    two (`-D`) is refused by name with the fix ("PowerShell refuses such a line before the script starts, so every run of the
    task fails ... update-pc.ps1 unregister, then register"): by register and the move to the hidden launcher, and by status
    ("TASK COMMAND REFUSED", a STOP). Before, a duplicate was read as its last value and `-Repo:x` was not read at all.
  - **status reads the task as Task Scheduler keeps it**: a Disabled task is a STOP; its last run with LastTaskResult in words
    (0 OK, 1 the updater's own STOP, running, not run yet, ended at the time limit); a result that means the run did not start
    or broke (a file not found, access denied, refused, any other code) is a STOP; and when the task's pinned copy sits in
    another state folder than this window's (another user's or another Documents folder), it says both folders and the task's
    own last run from its own state.json.
  - **pinned.json only after a successful register**: register now writes the launcher, registers the task, and only then
    pins the copy and writes pinned.json (with the daily times). A register that fails (Access is denied) leaves the pinned
    copy, pinned.json and the task as they were, and puts the launcher back byte for byte. The move to the hidden launcher
    already wrote pinned.json last.
  - **The `$hadLauncher` handling flagged in #66**: the launcher before a move was read as text and written back as ASCII, and
    a read that failed (a file another program holds) left `$hadLauncher` set with no text, so the put-back would have written
    an empty launcher over a good one. Now the old launcher is kept as bytes (`Save-LauncherBackup`), a read that fails stops
    the move before anything is written, and the put-back is byte for byte (`Restore-LauncherBackup`; register uses it too).
  - **8.3 short names** (CI of #72, windows-latest: the new 8.3 test failed): the own-run check said "the task does not run
    the pinned copy" for a task whose -File names it by its short name. Two causes in the code: the script's file name was
    matched as `update-pc.ps1` only (its short form `UPDATE~1.PS1` is not), and Test-SamePath relied on GetFullPath
    expanding short names, which .NET 4.6.2 and later do not. `Get-LongPath` now puts each short part (`RUNNER~1`,
    `UPDATE~1.PS1`) in its long form, part by part in its parent folder, on both sides of every comparison and for the file
    name; a path with no `~` (HOME's and WORK's) is returned exactly as given. The test built its path correctly.
  - The review of #72: a launcher whose read-back fails in register's first write is put back byte for byte, so "nothing
    changed" holds; the common parameters' short names (`-ea`, `-wa`, `-infa`, `-ev`, `-wv`, `-iv`, `-ov`, `-ob`, `-vb`, `-db`,
    `-pv`) are read as those parameters, never reported as unknown (and `-ea` with `-ErrorAction` is an option given twice).
  - **Tests** (`test/pc-updater.tests.ps1`): the options (both colon forms, case, a start of a name, twice, unknown,
    ambiguous; the list of names follows the param block); status's task state (Disabled, each result code, never run, another
    state folder); register stubbed: a failed register leaves pinned.json, the copy and the launcher byte for byte, and a good
    one registers the task while pinned.json is still the old one; a launcher held at the move is never written. On Windows
    only: **the 8.3 short-path test** (a folder, a file and a task whose -File names the pinned copy by its short name; a skip
    that says so where the volume makes no 8.3 names, instead of a pass on two equal strings) and **C4 of #68** (a throwaway task,
    S4U, re-registers itself through Register-HiddenTask from its own running instance: the run goes on to its end, the new
    definition is in place, its result is 0; a skip with Task Scheduler's own result where the runner does not start it). These
    two have not run yet: CI runs on a pull request or on main, and this branch has neither; on Linux they are skips.
- Tests: `npm test`: 930 pass, 0 fail (`pc-updater: 96 passed, 0 failed, 7 skipped` under pwsh: the 7 are Windows only). New
  smoke `npm run smoke:indmenu` (screenshots `indmenu-1366.png`, `indmenu-gear-1366.png`, `indmenu-short-1366.png`,
  `indmenu-400.png`, `indmenu-gear-400.png`); `smoke:be-labels` gains the probe and the scale moves (54 checks; the probe's 4 fail
  on the 1.39.0 engine, `BE_ENGINE`, and pass here). Every smoke in package.json (56 files) was run one at a time: 54 passed at once; `smoke:embed`
  failed one check (the menu's new resize listener was not removed by destroy(); fixed, 71 of 71) and `smoke:headroom` one check
  (the Jump to live icon after a scroll back, in a 330 s run); headroom passes again here, and on 45a422a, so it is counted as a
  flake of that run, not of this change.

## ChartBridge 0.6.9 (2026-10-24): the stats suite's Phase 2, recording only: 1 second bars, the order record, a decision id on group entries

Anthony approved Phase 2 of his personal stats suite on 2026-10-24 (SPEC_personal_stats.md: "ChartBridge sends NQ and MNQ 1 second
bars", "ChartBridge records every order", "Each fill of a group entry carries a decision id"). ChartBridge only: the page, the engine
and the chart version are unchanged (page 1.39.0, `minChartBridge` stays 0.6.2, COMPAT.json unchanged). **Needs a recompile (F5)** on
WORK and HOME: `update-pc.ps1 -InstallChartBridge` while flat (one new add-on file, `ChartBridgeOrderRecord.cs`, in
`install-files.json`). In Anthony's words for this release's spirit: "nothing else should change when it comes to functionality": it
only records more. No change to order placement, sizing, the copier, the agents, the bot, hotkeys or any order path
(`ChartBridgeOrders.cs`, `ChartBridgeStops.cs`, `ChartBridgeCopier.cs`, `ChartBridgeBot.cs`, `ChartBridgeAgents.cs`,
`ChartBridgeStrategies.cs` and `ChartBridgeMerge.cs` are the 0.6.8 files, byte for byte). The Desk's side is a separate job; until it
ships, The Desk answers 404 on the two new paths and ChartBridge keeps everything on disk and offers it again (nothing is lost).

- **1 second bars to The Desk** (`ChartBridgeBars.cs`, PROTOCOL "1 second bars to The Desk (0.6.9, contract v2)"): with `bars = on`,
  each full session's 1 second bars for NQ and MNQ (the 1-minute bars' front month plus contracts with fills, the same 17:05 New York
  run and the same start catch-up of the last 5 sessions), one row per second with trades: `[t, o, h, l, c, v, bv, sv]`, `t` the
  second's open in UTC ms. Built in one pass on NinjaTrader's thread from its 1 tick history (a bars job at the 0.3.5 gate, last of
  all, never beside a chart load; 180 s limit). The side of each trade by the live rule: the bid and ask NinjaTrader stored with the
  trade when usable, else the tick rule; the message says how (`sides.method`, `bidAsk`, `tickRule`, `mixed` or `none`, with counts).
  **Only from 16:15 to 18:00 New York on weekdays and on the weekend while the market is shut** (Saturday, Sunday before 18:00): never
  premarket, in regular hours or in the evening session; the start's catch-up and the sends wait for that window; one request a pass.
  Sent as parts of at most 1,500 rows (about 90 KB) to the new `POST /api/bars-1s` (v 2, tf `1s`), each part with the set id, its
  number, the count and the session's totals, so The Desk knows when a day is whole. Queued in `bars1s/` (written once; a `.sent`
  file notes each part taken), retried like the 1-minute bars, `sent_bars1s.txt`, `refused_bars1s.txt`, `rejected_bars1s.jsonl`.
  `bars1s = off` turns only them off; `bars1sRoots` names their roots. The 1-minute bars are unchanged, byte for byte.
- **The order record** (`ChartBridgeOrderRecord.cs`, PROTOCOL "The order record to The Desk (0.6.9)"): every order on every watched
  account, every type (market, limit, stop market, stop limit, MIT) and every change of its state, prices, quantity or fills, with
  its role, who placed it (`by`, as fills), account, instrument, side, qty, filled, limit and stop prices, the average fill price, and
  at submission and at each price change the bid, ask and last price ChartBridge knew then (each null with the reason when not
  known: another contract, none yet, stale past 60 s). To the new `POST /api/order-events` (v 1); `postOrders`, else it follows
  `postFills`. A `cb` id now has a per-start part (the stop record's known limit, fixed in the new record only). **The stop record
  (`POST /api/stop-events`) is unchanged** and runs beside it for The Desk already installed. The order event only adds a snapshot to
  a queue in memory (about 5 microseconds an event in the harness); the 10 s timer builds, saves and sends.
- **A decision id on group entries** (PROTOCOL "The decision id of a group entry (0.6.9)"): one id (`d` and 12 hex characters) per
  `groupOrder`, on every member's entry and its legs (they share the entry's tag), in the order record and as an optional
  `decision_id` on those fills to The Desk. Single-account entries have none (their fills byte for byte as before). Kept across a
  restart in `decisions.txt` (5 days). The only order-path code touched: around each member's existing `PlaceOrder` call (a thread-local
  set and cleared) and one line in `ChartBridgeGroups.NoteNewOrder`; the Output window's group entry line names the decision.
- `/diag`: `orderRecord` (with `observeMeanUs` and `decisions`), `bars.oneSecond` (its `lastBuild` with the trades outside the
  session left out and the request's from and to).
- **The independent review of #71** (no safety problem in the order path; byte-identity confirmed): the PC updater test's made-up
  versions are counted above the real ChartBridge; a new 1 second request starts only by 17:50 New York and the clock is read again
  after the pass's 1-minute requests and before each request; the order record's `nt_order_id` (NinjaTrader's id at each event, the
  one fills carry); `lastBuild` shows the trades outside the session and the request's span; `decisions.txt` saved by the account
  timer itself; the order record forgets ended orders one at a time and never-ended ones after 7 days, its event thread never moves the
  waiting lines, the file is appended to (written whole only after events left it), and a refused batch is halved and grows back;
  `check:orders` builds to a path of its own per run unless `CHARTBRIDGE_ORDERS_EXE` is set.
- **Rollout checklist (HOME first):** after `update-pc.ps1 -InstallChartBridge` and F5, (1) it compiles: NinjaTrader's
  `OrderEventArgs.Time` and `AverageFillPrice` and `Bars.GetBid`/`GetAsk` are used for the first time; (2) after 16:15 New York,
  `/diag` `bars.oneSecond.lastBuild`: the trades outside the session (NinjaTrader's answer may hold the day before too) and the sides'
  method (`bidAsk` means NinjaTrader keeps the quote with its historical trades); (3) `/diag` `orderRecord`: `deskHasNoOrderRecord`
  true until The Desk ships its side, `waiting` growing, nothing dropped; then WORK.
- Tests: `nt8/check/RecordHarness.cs` (every order type and change, the quotes at submission and when not known, the stop record's
  events identical to 0.6.6's, the queue, today's Desk's 404, a malformed event, 20,000 events' cost on the event thread);
  `GroupsHarness.cs` DecisionIds (a group entry to 3 made-up accounts: the orders sent and the page's messages byte for byte the same
  with the id off, 0.6.8's path, and on; one id on the 3 entries and a leg; the fills; a single entry has none; decisions.txt);
  `BarsHarness.cs` OneSecond cases (rows from made-up trades with the buy and sell split, gaps, the session's edges, NinjaTrader in four
  time zones, out of order trades; the parts; the request; the 1-minute message unchanged; regular trading hours; one a pass; a chart
  loading; today's Desk; a restart mid set; a refusal; 600,000 trades in one pass); `test/nt8-record.test.js`.

## chart 1.39.0 (2026-10-24): house style V2, black and gold, on the chart page and the Markup Studio

Anthony, 2026-10-24: "lets unify everything. I really liked the black gold look you showed and I think it should live
through our entire system." Candles: "my colors for candles change all the time, You can add a black and gold pre-set,
thats fine, but I change them - this is more of an overall theme change." Motion: "smooth everywhere where possible as far
as we can go." Page and engine 1.39.0; ChartBridge does not change (no F5): the page works with ChartBridge 0.6.2 and later
as 1.38.1 did (minChartBridge stays 0.6.2), so with 0.6.8.

- **The page chrome** (the workspace, its panels, menus, popovers, dialogs, the ticket, the Accounts and Multi-Account
  panels, the Agents panel's Drone sky, the League, Bot and Agent tabs' purple parts, the PIN pad, the Markup Studio, the demo
  page) takes The Desk's V2 tokens (TheDesk PR #48): the black ground with a faint gold glow, charcoal panels, warm greys,
  gold for the accent. Gold replaces the purple accent and the crimson everywhere: the logo (a black tile with a gold glyph
  and border glow), the wordmark, Armed (gold with dark ink), the armed chart ring, the LIVE account marks; the Account page's
  red room meter is the loss red. Green and red only for P&L and trade side. Pills for buttons and tabs, 14 px popovers and
  dialogs with a gold border, a gold hairline along the top of panels and cards and under the top bar.
- **The chart's own colors** in the default theme (ground `#050506`, regular-hours ground, grid, axes, crosshair, tags, the
  exit and live dots, Jump to live, the padlock, the delta divider, the Colors panel): V2, every floor and pair rule of
  CHART_STYLE.md kept (axis text 5.55:1, crosshair 3.57:1, divider 1.49:1, grid 1.14:1). The Background preset Dark is the V2
  black; a ground saved as the V1 default `#080B10` (a Reset or a pick of Dark before) is read as the default. Other grounds
  build their chrome from V2's surfaces and gold.
- **Candles unchanged**: the default candle colors and Anthony's saved colors are never touched. New candle preset **Black and
  gold** (`#D4B06A` / `#7A7468`; wicks and volume follow the candle colors; its bull is close to the value-area and PD POC level
  gold `#E0B45A`, which stay dashed lines with names and tags), passing every contrast rule on every ground; the
  three presets of before stay. Indicator colors unchanged (their defaults and swatches).
- **Motion (V2)**: one ease. Menus and popovers fade in, a dialog that asks nothing about orders fades in, the top bar's own
  buttons ease and lift, a tab bar's gold ink slides (`ChartMotion.syncInk`, the laptop layout tabs and the Studio's tabs), the
  PIN card fades in, the Studio's buttons and tabs ease. Never on a live value or an order control: the ticket, the order bar,
  Armed, Flatten, B/E, the order dialogs, the tape, the quote board, the account panels, positions, P&L and the chart stay
  still; every control takes its click on the first frame. Reduced motion (the system's, or the page's Less motion): none of it.
  The chart's own pan, zoom, scroll and Glide feel (the `motion` constants) is unchanged.
- **The V1 ground**: `#080B10` now reads as the V2 ground everywhere: the default theme, the Colors panel, and a chart preset
  saved before 1.39.0, which still shows as in use (`LivePrefs.presetSame`, through `ChartEngine.util.groundOf`).
- **Review of #70**: danger stays red (Flatten all, the NO STOP question's Send and Delete group never take the gold hover
  border; the Bot tab's switch to a LIVE account asks in the sell red, as the Agent tab's does); dialogs, the PIN card and
  the Studio's summary fade in without moving, so a button is never hit off its place; the Studio's Level marker in the level
  gold; the warnings' text its own amber `#FFE2B0`; the grid at 50% (1.14:1; at 45% it read 1.117:1, under the 1.12 floor);
  the stated figures corrected (Armed's ink on gold 8.19:1, the default bear 2.87:1 on the V2 ground); candles-same also on
  the default V2 ground.
- Tests: `test/v2-theme.test.js` (the preset's contrast on every ground, the default candles, no V1 purple or crimson in the
  chrome, the motion rules: off with reduced motion, never on a live part, no delay; the chart's motion constants; the ink);
  `npm run smoke:v2` (the same in a page, on the fake bridge: nothing moves on the live parts at rest, Armed or with a position,
  Buy MKT and Flatten all send within the click, a menu and a dialog take their click while animating, reduced motion and Less
  motion still); the theme, presets, kit and motion tests moved to the V2 values; `npm run smoke` shows the Black and gold
  preset (`test/out/desk-colors-blackgold.png`, `desk-blackgold.png`, sample data).

## Unreleased (2026-10-23): the PC updater reads HOME's hand-made launcher; logon type refused by name

`nt8/update-pc.ps1` only (no page or ChartBridge change, no version bump, as the other 2026-10-23 updater entries below).

- **HOME's launcher** (FROM_HOME_2026-10-22_hidden_tasks): `C:\SchwabDesk_bulk\hidden\ChartEngine_Updater.vbs` runs
  `cmd /c "cd /d "<updater\bin>" && "<powershell.exe>" ... -File "<pinned update-pc.ps1>" update -Repo <clone>"`, with
  `cmd /c` and no `/s`. The parser takes off the quotes around the whole after either `cmd /c` or `cmd /s /c` (WORK's),
  then the `cd /d ... &&`. Tested with HOME's exact line (the user's name left out): read, and moved by the task's own
  run to its own launcher with 09:00, 17:00 and sign-in, `-Repo` kept, the hand-made `.vbs` left on disk.
- **A task that does not run only while signed in is refused by name** (review C3 of #68, as Bot-Lab's
  Get-PrincipalProblem): the move to the hidden launcher (`-InstallChartBridge`, the task's own run) and every change of
  the daily triggers refuse a task whose logon type is not Interactive ("the task runs with logon type S4U, not
  Interactive (only while signed in)"), or cannot be read, and change nothing. `register` makes it Interactive.
- **Which run changes the triggers, said plainly** (review C1 of #68): a run of the clone's copy changes no trigger and
  says so; the pinned copy (`$u` in the README) run by hand counts as the task's own run when the window is not
  elevated and runs as the task's user. Docs only; the checks are those of #68.
- Tests: HOME's exact line read and moved; logon type S4U or unreadable refused, in the move and in a trigger change.

## Unreleased (2026-10-23): the PC updater checks twice a day, at 9:00 AM and 5:00 PM New York time

`nt8/update-pc.ps1` only (no page or ChartBridge change, no version bump, as the other 2026-10-23 updater entries below).

- **Two daily checks, and at sign-in** (Anthony 2026-10-23: every updater checks for updates twice a day, at 09:00 and
  17:00 New York time, and at sign-in). `-DailyAt` takes a list, `09:00,17:00` by default; one time given by hand
  (`-DailyAt 08:30`) is one daily check. `register` writes the sign-in trigger and one daily trigger per time, each as
  local wall-clock time with no UTC offset, as before.
- **pinned.json** carries `dailyTimes` (the list) and `dailyAt` (its first time, which a pinned copy older than this change
  reads alone). A pin written before this change (`dailyAt` only) reads 09:00 and 17:00 when it held an old default
  (09:00 or 17:05) or no time; another single time is kept. `-InstallChartBridge` re-pins with the times it reads.
- **The check of the daily times** (`Sync-DailyTrigger`, every update run) keeps every daily trigger on its New York time
  across DST and time zones, as it kept the one. Every change of the triggers, a move as well as an add, is made only in
  the task's own run (Anthony 2026-10-23, as Bot-Lab's updater): the task runs the pinned copy and this run is that copy,
  not elevated, as the task's user. A run of `update` by hand changes no trigger and says so in update.log and `status`.
  More daily triggers than times, or none, are left to `register` and said.
- **A PC registered before gets the 5:00 PM check by itself, after its next `-InstallChartBridge` or `register`.** The
  automatic path never changes the pinned copy the task runs, so the new code first runs on a PC once one of those pins
  it (`-InstallChartBridge` run from the old pinned copy pins the new one too). From then on, the task's next automatic
  check adds the missing 17:00 trigger to its own hidden task in place: a change of the schedule only (the action, the
  launcher and the pinned copy stay as they are), and only in the task's own run: the task starts through its own
  hidden launcher, which runs the pinned copy, and this run is that copy; the run is not elevated; the task runs as
  this user. Anything else is refused by name in update.log and `status`, and changes nothing. A task not yet on the
  hidden launcher still moves only at `-InstallChartBridge` or `register`, as before, and gets both daily checks then
  (its 17:05 or 09:00 becomes 09:00 and 17:00; another time is kept).
- **Hand-made launchers are read, and moved by the task's own run** (WORK's 0.6.8 install, 2026-10-23: the #66 move
  said "does not run update-pc.ps1" on WORK and HOME, whose tasks run `wscript.exe` on a hand-made
  `C:\SchwabDesk_bulk\hidden\ChartEngine_Updater.vbs` since 2026-10-22). A launcher's Run line of the form
  `cmd /s /c "cd /d "<folder>" && "<powershell.exe>" ... -File "<pinned update-pc.ps1>" update -Repo <clone>"` is now
  read (the outer quotes `/s` takes off, then the `cd /d ... &&`), so `register` and `-InstallChartBridge` keep its
  `-Repo` and move it. And the task's own automatic run moves a task behind a `.vbs` in `C:\SchwabDesk_bulk\hidden`
  (with or without `//B`) to its own launcher, with 09:00, 17:00 and sign-in, through the same move: `-Repo` kept, and
  refused by name (one WARN line, nothing changed) when the window is elevated, the task runs as another user, its
  script is not the pinned copy, or its command is anything but `update -Repo` (an option the launcher would drop). Only
  when this run is the pinned copy. The hand-made `.vbs` stays on disk. A plain `powershell.exe` task still moves only at
  `-InstallChartBridge` or `register`. Tested with WORK's exact `.vbs` line.
- **Never two updates at once.** Two daily triggers and the sign-in trigger start the same task: Task Scheduler never
  starts it twice at once (IgnoreNew), and every run takes `updater.lock` (held open, no sharing) before it does
  anything; a run that finds it held says busy and changes nothing.
- `status` prints one line per daily time: the New York time, its time on this PC's clock and its next run; a time with
  no trigger yet, a daily trigger that is none of them, and why the last run left the triggers alone.
- Tests: the stubbed add (the sign-in trigger kept, the action, launcher and pinned.json untouched), each refusal (not on
  its launcher, elevated, another user, not the pinned copy), both there, both drifted, too many or none, a time given by
  hand, a refused change; `-DailyAt` as a list and through `-File`; old pins of each kind; register with two times; the
  migration with two times; and, on Windows, a real throwaway task registered with both, moved back from a drift, and
  given its 17:00 trigger in place.

## ChartBridge 0.6.8 and chart 1.38.1 (2026-10-23): the history gap after a reload, the League chart and the Drone sky on NQ

Two live bugs on WORK (2026-10-23, page 1.38.0, ChartBridge 0.6.7), and Anthony's choice for the League chart. ChartBridge 0.6.8
is a recompile; the page works without it (`minChartBridge` stays 0.6.2). Only ChartBridge's market data and history path
changes: nothing on any order path (ChartBridgeOrders.cs and the other order files are untouched; `npm run check:orders` passes).

- **The gap after a reload** (an NQ 1 min chart with no bars from about 10:40 to the live bar at 11:08; a 5 min chart the
  same from about 10:25 to 11:05). Verified in the Mono harness on the 0.6.7 code first (`nt8/check/GapHarness.cs`, the same
  case: NinjaTrader's minute answer ending 28 minutes before the clock, its 20,000 last trades starting after that, 28
  minutes of live trades seen before the subscribe): "gap REPRODUCED on today's code: minuteTailRebuilt 0 and no bar from
  10:40 to 11:08 ET". NinjaTrader's 1-minute answer ended early, the 20,000 trades could not rebuild its last bar, and the
  page fills nothing between the last history bar and the first live trade.
  - ChartBridge 0.6.8 keeps a **minute book** per instrument: 1-minute bars from every live trade it sees, stamped at the
    close as NinjaTrader's (a trade at hh:mm:00.000 in the bar that ends then), about two sessions (3,000 bars), from the
    first whole minute after it started listening or the feed came back, reset on a feed drop.
  - The seam: a subscribe takes the book's lock and then the page's Pending lock (OnMarketData's order) and copies the book
    in the same moment it clears the held trades, so no trade is in both and none in neither. NinjaTrader's bars are kept
    up to the first minute the book has whole, the book's bars follow, and the 20,000-trade request is not made. `ready`
    carries `filled` (the book's bars sent). When the book does not reach back to NinjaTrader's last bar (ChartBridge
    started later, a feed drop), 0.6.7's path runs.
  - A hole is recorded, never shown (Anthony 2026-10-23: "I dont need a notice"): "No bars from 10:41 to 11:08 ET:
    NinjaTrader's minute history ends at 10:40" (open market only: the 17:00 break and weekends are not a hole) goes to
    `/diag` (the seam's `hole`, `historyNotes`) and `history.log`; no status, and no notice on the page.
  - After the fix, the same harness case: continuous minutes from 09:30 to the ready minute, none twice, the volume of the
    bars and the trades after `ready` equal to every trade fed, each held trade sent once, `filled` 28; and with 18,022
    trades fed on another thread during the subscribe, every trade once.
- **The League chart on LOADING for 50 s and more**: a load's minute history and last-trades requests now wait at most 20 s;
  then the load goes ready with what ChartBridge has (its minute book, NinjaTrader's kept answers); a request given up and still
  unanswered is not asked again for that instrument (for up to 2 minutes, or until NinjaTrader answers), so reloads do not
  pile requests on a NinjaTrader that is not answering.
- **The reload of every window** (WORK 2026-10-23, 11:09: every load matched false with no tick backfill, 23 to 32 s, MNQ
  185 s): the book does not depend on the tick backfill or on how late or stale NinjaTrader's minute answer is (the copy is
  taken at the subscribe; every trade after it is held). A minute answer past its 20 s limit is no longer a loss of history:
  ChartBridge keeps NinjaTrader's minute answers per instrument in memory (late ones too) and a timed-out load starts from
  them joined to the book. And 0.6.7's own path: when the last trades miss NinjaTrader's last minute, the minutes they hold
  after it are now kept (0.6.7 threw them away with it). Harness: three instruments reloading at once, stale answers 28
  minutes old, no tick backfill, one answer after its limit, trades flowing on another thread: every chart continuous,
  every trade once.
- **Seconds and range charts the same** (Anthony 2026-10-23, this release): the book is copied for every load and joined to
  NinjaTrader's minute answer, the last minute rebuilt from the served window's trades as before; the minutes after a short
  last minute are kept on that path too; the minute history's 20 s limit and no re-ask apply, and a tick chart whose minute
  history does not come in time starts from the kept answers and the book (0.6.7 waited with no limit). Reproduced first on
  the 0.6.7 code (`nt8/check/WindowGapHarness.cs`, run alone by `check/WindowGapMain.cs`): W1 and W2 "no bars 10:40 to
  11:08", W3 "not ready after 3 s"; all three fixed on 0.6.8. The served window's own request keeps its 120 s limit.
- **History notes** (WORK's request): "Minute history failed", "last trades for the forming minute not loaded", "tick
  window failed", a request given up or answered late, and a history that ends early go to `/diag` (`historyNotes`, the last
  50) and `history.log` next to copier.log, with the time and the instrument.
- `/diag`: each seam adds the minute answer's last bar, the book's from, the bars it filled, the closed minutes NinjaTrader
  had more volume for, the time limits and the hole recorded; each book adds `minutes`.
- **The page** (no recompile part): a LOADING past 10 s says "Waiting for NinjaTrader's NQ history (N s)". No hole notice
  (Anthony: "I dont need a notice"). No bars are kept in sessionStorage.
- **The independent review of 0.6.8** (three MEDIUM, seven LOW), all fixed:
  - A load in the book's first minute (right after a start or a feed drop) could count a minute's volume twice: the book now
    stands in only with a bar after its `from`; else 0.6.7's path runs (harness: a load 8 s after a start, every trade once).
  - The minute history's time limit gives up only when history can stand in (kept answers, or the book with a bar); a cold
    start waits for NinjaTrader as in 0.6.7, the page saying it waits. A load that went ready on stand-in history is told
    once when NinjaTrader's answer comes (`historyLate`), and the page loads again by itself.
  - Agents (they place real orders) have no time limits and never get stand-in history; `ready` carries `minuteTimedOut`,
    `tailTimedOut` and `historyFrom` for a program to read.
  - No time-limit warning on screen either (a history note only; the "Waiting for NinjaTrader's ... history" line stays);
    a time-limit path that throws still ends in ready or the trades; kept answers are cut to the load's own days; the dead
    contract-change check is gone; after a stop, a time limit or a late answer does nothing; the four SeamHarness checks are
    back in their strict form; `nt8/check/GapMain.cs` runs the WORK case alone against the 0.6.7 sources: "WORK case
    REPRODUCED on 0.6.7: minuteTailRebuilt 0 and no bar from 10:40 to 11:08 ET", and on 0.6.8 "continuous minutes from 09:30
    to 11:07, every trade once (29225 of 29225)".
- **The re-review** (two MEDIUM, a LOW): after an error answer an agent gets exactly what 0.6.7 sent (no history bar) and
  `ready` says `minuteFailed` (and `standIn` for any load not on NinjaTrader's full answer); a fresh kept answer that reaches
  back to a load's start is that load's answer (NinjaTrader not asked), and `historyLate` goes at most once a page and
  instrument in 5 minutes, so a NinjaTrader just over the limit cannot reload the charts in a loop (harness: three loads, one
  historyLate, one request); a cold start marks the instrument overdue at the first limit and keeps looking every 3 s; kept
  bars served alone get their last minute from the last trades, as 0.6.7 does with an answer.
- **The third review** (a MEDIUM, two LOW): any minute answer, late or in time, clears the instrument's overdue mark, and the
  overdue skip applies only to loads whose days the kept answers cover (a 30-day 1 hour chart after a 5-day 1 min load asks
  NinjaTrader); a kept bar still forming when its answer came is never served as closed, in a load or inside a merge; the
  kept-bars-alone path falls back to ready if its last-trades request throws.
- **The League chart and the Agents panel's Drone sky on NQ 1 min.** Anthony, 2026-10-23: his only MNQ chart is a 40-range
  execution chart (it loads trades, not minute bars) and all his other charts, including a 1 min, are NQ; "the League tab's
  chart AND the Agents panel's Drone sky pillars switch from MNQ to NQ 1 min", keeping 5 days and no ticks for the League
  chart, "so they reuse his NQ 1 min line's data and open at once with no extra NinjaTrader request". The seats trade MNQ:
  their marks, entry and stop lines and tethers are drawn at their MNQ prices on the NQ candles (the same index, no
  conversion), the League chart's label says "NQ 1 min (league trades MNQ)", the sky's price label says NQ, and the seats'
  open P&L uses NQ's price with MNQ's point value. (The earlier idea of a 1-day MNQ League chart is dropped.)
- Tests: `nt8/check/GapHarness.cs` (the reproduction and the fix, the fallback and its record, the race, the storm, both time
  limits and their late answers, the book's own rules, the join, the resets); `nt8/check/WindowGapHarness.cs` (tick charts);
  `test/history-gap.test.js`; `test/fake-bridge.mjs --minute-lag-min=30`; `smoke:workspace` shows the LOADING wait on a 1 min
  chart and no hole notice at ready; `smoke:league` checks
  opening the League tab with an NQ 1 min chart open sends no new NQ subscribe and no MNQ minute subscribe, and the sky reads
  NQ bars from the NQ line already open.

## Unreleased (2026-10-23): -InstallChartBridge moves the PC updater's task to the hidden launcher

`nt8/update-pc.ps1` only (no page or ChartBridge change, no version bump, as the 2026-10-23 updater entry below).

- **No register job per PC** (Anthony 2026-10-23: "this prompt gets lost for the home PC"). The automatic path never
  changes the pinned copy the task runs, so the task can only move where a new updater first runs. `-InstallChartBridge`
  now, after re-pinning the task's copy, moves a task that is not started by its own launcher (plain `powershell.exe`,
  or a hand-made launcher in `C:\SchwabDesk_bulk\hidden`) to `wscript.exe //B` on `updater\bin\update-pc.hidden.vbs`,
  once, through register's own code: `-Repo` kept, pinned.json's dailyAt 17:05 moved to 09:00 (another time kept). It
  prints what it kept and the 09:00 note; the triggers, user and settings are register's own. Refused, and said: an
  elevated window, a task that runs as another user, a task on another clone or whose script is not the pinned copy, a
  command that cannot be read. A refused or failed move changes nothing (pinned.json is written only after the task;
  the launcher it wrote is taken away again) and never stops `-InstallChartBridge`. Task Scheduler applies a changed
  action from the task's next start.
- **Which run moves it.** The move needs a copy of the updater that has this change: `-InstallChartBridge` run from an
  up to date clone (`git pull --ff-only` first, as the ChartBridge 0.6.8 install job will do), or `register`. Run from
  a pinned copy older than this change, `-InstallChartBridge` only pins the new copy, and the move then happens at the
  next install.
- **The automatic run only warns:** while the task is not hidden, each `update` run logs one WARN line, "the task still
  starts without the hidden launcher: it is migrated at the next -InstallChartBridge (unless it is refused there; see
  its output) or update-pc.ps1 register", and changes nothing.
- Tests: stubbed migration (a running plain task, a hand-made launcher with another time, a task on another clone, an
  elevated window, another user, a script that is not the pinned copy, a failure that leaves pinned.json and the
  launcher as they were, the warning) and, on Windows, a real throwaway task migrated from its old action.

## Unreleased (2026-10-23): the PC updater's task starts hidden, and checks at 9:00 AM New York time

`nt8/update-pc.ps1` only: no page change, no ChartBridge change, no version bump here (the chart and ChartBridge versions
describe the page and the add-on; Anthony to say whether an updater-only change should carry one).

- **Hidden start** (Anthony, 2026-10-22: every scheduled program of ours runs hidden). `powershell.exe -WindowStyle Hidden`
  still flashed a console as PowerShell started. `register` now writes a one-line ASCII launcher,
  `updater\bin\update-pc.hidden.vbs`:
  `WScript.Quit CreateObject("WScript.Shell").Run("<the old command line, quotes doubled>", 0, True)`, and the task runs
  `wscript.exe //B "<launcher>"` (//B, batch mode: WScript never shows an error dialog). Window style 0 is hidden; True waits, so the exit code is the task's Last Result and Running
  stays true. The command line is exactly the old one (Windows PowerShell, -File on the pinned copy, update -Repo <clone>),
  so `-InstallChartBridge` updating the pinned copy keeps working. Same working folder, triggers, user (only while signed
  in, no password, not elevated), settings, 30 minute limit and description. A launcher that cannot be written (or a
  command line it cannot hold: a character outside ASCII, or a %) stops register and leaves the task as it was.
  `unregister` removes the launcher; `status` says whether the task starts hidden. The time limit with the launcher:
  Task Scheduler stops wscript.exe, and the PowerShell under it may go on; it still holds `updater.lock`, so later runs
  say busy and change nothing until it ends (git calls keep their own 3 minute limit).
- **register keeps what the task runs, and status checks the start** (the independent review, 2026-10-23). register
  reads the current task's `-Repo` from its own arguments or from the Run line of the launcher it starts (ours, or a
  hand-made one in `C:\SchwabDesk_bulk\hidden`, `cmd /c cd /d ... &&` form too); another clone is refused unless `-Repo`
  is given (`-Repo ''` cannot clear it), and so is a task whose command cannot be read. register writes and reads back
  the launcher before it pins or touches the task, so a failed write changes nothing. `status` prints the command the
  task runs, checks the launcher (missing, unreadable or not exactly the line register writes: STOP), and says when the
  last run was and how long ago.
- **The daily check moves to 09:00 New York time** (Anthony, 2026-10-23: "we push most updates overnight and I prefer them
  in the morning"). `-DailyAt` defaults to 09:00, and a pinned.json without a dailyAt reads 09:00. A check installs page
  files only (an open page keeps its code until reloaded when flat) and never ChartBridge. A PC registered before keeps
  its pinned 17:05 and its old powershell.exe action until `register` runs again from an up to date clone.
- Tests: the PowerShell tests stub the ScheduledTasks commands and check the launcher's exact line (paths with spaces,
  every argument, quotes doubled), its ASCII bytes, the wscript.exe //B action and that the rest of the task is unchanged; a
  launcher that cannot be written; unregister; the 09:00 default, an explicit -DailyAt and an old pin's time.

## chart 1.38.0 (2026-10-23): the Agents panel's Drone sky, order labels in the gutter at break-even, Multi-Account lane headers

Three items, **page only**: no ChartBridge change (it stays 0.6.7; `minChartBridge` stays 0.6.2), no Desk change, no Bot-Lab change.

- **The Agents panel becomes the Drone sky** (Anthony approved the concept 2026-10-23, mockup version 4, its "drones" style;
  `live/agents-sky.js`, new page file, installed; `live/agents-strip.js` keeps the data and the card). The same panel: "Agents" in
  + Add panel, one a layout, and a saved layout with the strip opens the sky. MNQ's minute bars stand as a skyline of light
  pillars, very faint slow code rain and dust behind them; one hexagon drone per agent active today in its colour (the League's H
  amber, S cyan, O violet; a live agent and the bot in the strip's own colour for them, `#9AA8B8`), a turning lens, a dashed ring
  for SHADOW and a solid one for LIVE, and its text block kept inside its own slot (fields cut or dropped, never over the next):
  name, its one-word state (look cap, API stopped, status late, killed, stood down...), mode; position, today's R, spend (the bot:
  its rails); looks left and the 30-tick look cap (a seat's). Under the canvas, the one-line feed with the decode effect and the
  "+N idle" chip (named on hover); a panel too narrow for every drone says "+N more", and a click on it lists them (each with its card
  on hover and its tab on a click). Below 200 px of height, the slim layout.
  - **Data**, only what the strip read: the league's seats from the page's one league read (The Desk), the live agents from the
    Agent tab's glance (one new read-only field, `sinceAt`, the time of the open trade's first fill, for the tether), the bot from
    the Bot desk's glance, MNQ's price and **its minute bars from the quote line the strip already watched** (its own history and
    trades, kept as the last 120 bars, a bar with a value missing or not a number left out; no new connection, nothing new asked), and **Anthony's own entries** from the order
    connection's fills on the ticket's account (a fill from flat or through flat; read only).
  - **Who flies:** a seat whose league day is today and that is active in status.json or holds a position or a resting order or
    decided or traded today; **seats fade after their session** (Anthony 2026-10-23): once the league's day is over as The Desk
    says it (its day closed, the strip's "day closed"; no clock time is worked out here), a seat holding nothing folds into "+N
    idle", and one still holding a position or a resting order stays until it is flat; a seat stopped in the session for a risk
    reason (its own "day stopped") stays a drone showing that word; a live agent that is connected, holds a position or has a working order; the bot when its channel is
    on and it is connected or holds a position. The rest fold into "+N idle".
  - **Events:** a new decision (a seat) or LOOK (a live agent) fires its look laser once, then a pass pulses and types its reason
    into the feed (an entry, a rest, a cancel, a refusal say theirs); an exit pulses; a trade draws the tether to its entry (green
    while its open R is up, red while down, a light packet running along it), its entry and stop dashed to now and its open R by
    the price; break-even and the trail move the stop line at once with a flash, and the feed says B/E or TRAIL; Anthony's new fill
    drops his white "A" beacon. **No replays:** acts from before the panel opened stand as they are; only the newest plays, once.
  - **Hover** a drone (or focus its button) for today's full card, the 1.36.0 strip card, with a thought's full reasoning under it;
    **click** opens the League tab, the Agent tab or the Bot view, as the strip's cards did. Nobody active: "No agents active
    today" over the faint moving background.
  - **Cheap:** one canvas on whole device pixels (the 1.37.0 snap), at most 30 frames a second, none while the panel is hidden
    (another view open, a panel maximized over it, scrolled away) or the window is in the background; reduced motion (Windows, or
    Less motion) is calm motion: 15 frames a second, slower, the feed text at once. docs/MOTION.md "Allowed motion: the Agents
    panel's Drone sky" (R3 holds: the figures are drawn as they are, never eased).
  - Not shown, no data on the page for it: a look cap and looks left for live agents and the bot (only the league has a cap); the
    bot's stop and its entry time (its message carries neither: its tether goes to its entry price at the newest bar); a live
    agent's "join with Anthony" (only the league marks it).
- **Order labels at break-even** (Anthony 2026-10-22 at WORK: "when I am dragging the stop over the entry, it kicks out over the
  active candles"). Until now a label that would overlap another stepped left past it, onto the newest candles. Now every order
  and position label stays right-aligned in the gutter beside the price axis; overlapping labels stack up and down there, 20 px
  at a time. The rule (two reviews): the label under a mouse that has not moved never changes owner. A pressed or dragged order's
  label is placed first, in the row it was drawn in at the press, and moves only with the drag (compact while dragged on a host's
  chart): a press moves nothing. After a drag that really moved the order, its label stays first in the row it was released in,
  until the next such drag, that order is gone or the mouse leaves the chart, so a second press there moves the same order. A
  click, a press that moves no tick, Escape, a drag cancelled or released off the chart leave the stack exactly as before. Each other
  one at its line when free, else the nearest free row; a label off its line gets a short leader to it. Each label's hit areas
  (body, x, add cells) are its own wherever it lands. The 1.37.0 see-through labels and light lines are unchanged.
- **Multi-Account lane headers** (WORK 2026-10-22): from about 610 to 760 px the trading lane's sum ran over the Bench's header. A
  lane's header now wraps inside its lane.
- Tests: `test/agents-strip.test.js` (who flies, a seat's trade and R, the acts, Anthony's entries, the text fit, the page);
  `npm run smoke:agents-strip` rewritten for the sky (55 checks: the drones and colours, no new connection, no replay, a look, a
  pass, a trail, Anthony's beacon, the hover card, the clicks, 30 frames a second and 15 calm, no frame while hidden, the frame
  time, slim, every text block inside its slot from 1,417 down to 380 px, +N more and its list, a seat stopped for a risk reason staying with its word, a flat seat folding into idle once the day closed while one still holding stays, +N idle, the empty state, nothing sent);
  `npm run smoke:be-labels` (new: the stop dragged onto the entry with a limit at the same price, compact and full labels: no
  label pixel left of the room-right gap, no overlap, each label's x and drag on its own order, and a second press right where a
  stop or a target was dropped moves that same order, and a click, a 2 px press, Escape and a release over the price axis on a
  label pushed a row down move nothing and leave the next press on the same order: 40 checks); `npm run smoke:league` reaches the Bot
  through the bot's drone; `npm run smoke:multi-account`
  measures both lane headers at 760 to 300 px. Version 1.38.0 (package.json, engine header and VERSION, COMPAT.json page).

## ChartBridge 0.6.7 and chart 1.37.0 (2026-10-22): the Multi-Account panel and the bench, more room right, lighter trade lines, sharp candles

Anthony's requests of 2026-10-22: "I would like to have the ability to quickly swap out accounts in and out of the group while flat
... a group panel, showing each account chip thats in the group and the ones on the side line, when I click and drag a chip into the
group, it trades with, when its on the bench, it sits out"; "I still find myself needing more room to the right ... our price /
trade lines can be a bit thinner ... I still find the chips and the lines obstructing price, especially when price is moving and im
trying to click and trail a stop"; and one grid panel's chart soft when zoomed out. **ChartBridge 0.6.7 is a recompile** (nt8/*.cs);
`minChartBridge` stays 0.6.2 (with 0.6.2 to 0.6.6 the panel shows the groups and the copier and says that moving a chip and New group
need 0.6.7).

- **The Multi-Account panel** (`live/multi-account.js`, `live/multi-account.css`, new page files): "Multi-Account" in + Add panel, one
  a layout, the approved mockup (version 2) built with the page's own tokens and classes. Two tabs:
  - **Groups:** the group dropdown (kept per panel in this browser), **Risk** in the bar (the group's percent of each account's own
    max loss; changed only while the group is flat, ChartBridge refuses it otherwise), "One direction, always (no hedging inside a
    group)", **Group settings** (the name, Type Evals or Funded, Delete group, asked twice and only while every account in it is
    flat) and **New group** (a name, a Type and the risk). Two lanes of chips: **Trades with the group** and **Bench** ("sits out new
    entries, keeps its rules"). A chip: the account and SIM or LIVE, its type on The Desk, ChartBridge's room to its floor and its
    own dollar risk at the group's percent (5% of a $4,500 max loss: $225); the trading lane sums them ("3 accounts · $375 at risk a
    trade"). A click or a drag moves a chip (`memberBench`); refused, with the reason on the chip, while the account holds a
    position or has a working order or has no type on The Desk. Only this firm's accounts show (the firm of the members' types on
    The Desk): the bench also lists the firm's accounts in no group, and a click or a drag of one into the group opens the join step
    on its chip (Anthony 2026-10-22, "Join flow on the chip"): the Accounts tab's own join, the same words, its rules from its type
    on The Desk, the highest close so far prefilled, then **Put in** sends the same `accountGroup` and it lands in the trading lane;
    **Cancel** (or Escape) leaves it on the bench. A highest close typed in one account's step never carries into another's (each
    starts from its own prefill). An account with no type on The Desk still cannot join and says so on its chip; one whose rules
    cannot be read from The Desk (The Desk not reached, or its type has no rules) is sent to the Accounts tab, where
    they can be typed. The Accounts tab's join works as before (the same code, now shared). With a ChartBridge older than 0.6.7 a
    join from the panel says it needs 0.6.7, as moving a chip does.
  - **Copier:** the copier exactly as it was, moved from the Account page (the Account page is mounted with only its Copier tab).
- **The Account page loses its Copier tab**, and **Settings loses Account groups** (its group dialog with the firm's rules, Hero on
  duty and the No hedging switch): groups are made and set on the panel. A saved layout and old settings load as before (a kept
  answer for the groups section is ignored). On the Accounts tab, with ChartBridge 0.6.7 and The Desk read, an account with no type
  on The Desk cannot join a group ("set its type there first"), and a group holds one firm's accounts.
- **ChartBridge 0.6.7, the bench** (nt8/PROTOCOL.md "The bench (0.6.7)"): a per-member `benched` flag in `groups.txt` (and the sealed
  `groups.txt.good`), written only for a benched member. A benched member stays a member (its rules, highs, floor and the group's
  one-direction check) and sits out every new group entry: the page's ticket and hotkeys (`groupPreview`/`groupOrder`: size 0,
  "benched: it sits out new entries (the Multi-Account panel)") and an agent's group plan (its seat stays in seat order; `welcome`
  names the benched seats; a change puts `seatsRev` up; a size sent for it places nothing, "benched"). Exits, stops, targets,
  changes, cancels and flattens are never blocked by it. `memberBench` is refused unless the account is flat by both readings on
  every instrument with no order that may still fill, with the reason. An older ChartBridge reading a file with the flag refuses
  it safely (its member line must have exactly 3 fields: the whole file unreadable; group entries refused, nothing rewritten, the
  machines wait; single-account orders and exits still go).
- **ChartBridge 0.6.7, groups:** no hedging is always on (`noHedge` false refused; a line saved off reads as on); a group's own rules
  are optional (a group made on the panel has none, its line `-` for drawdown, type and size) and never size a member: a member with
  no rules of its own sits out a group entry ("it has no account type: set its type on The Desk and apply it"); a group with no
  rules takes a joining account only with its own rules; the risk percent changes only while the group is flat.
- **ChartBridge 0.6.7, exits never wait on a groups.txt write** (reviews LOW 1, L1, L2, N1 to N3): every groups change runs one at a time
  behind a change gate taken before any other lock, so a second change waits there holding nothing an exit needs. A save with a risk
  percent, a bench move and `accountGroup` decide (the group or the account flat) and change memory under the group entry lock and
  the order lock, then let the order lock go and write `groups.txt` and its sealed copy with the group entry lock still held: a page
  market exit, a copier exit copy, an agent's close or stop and a flatten placed meanwhile never wait on the disk, and no page group
  entry is sized from a change not yet saved. A page stop or limit order placed on its own counts as an entry, so it can wait for a
  groups change in progress (normally milliseconds). A write that fails: when the account (or the group) is still flat with no working order, memory
  goes back to what the file holds ("groups.txt could not be saved (...); nothing was changed"); when something was placed on the change
  meanwhile (an agent's entry), the change stays, the alarm goes up and the answer says it will be saved with the next change; the
  pages show that answer as done with a warning, never as refused, and ChartBridge writes the kept change again every second (when no
  groups change is on) until it is in the file, then says so ("groups.txt saved"). Pages and agents are told either way. A save of a name, a Type or rules takes the save lock alone, as before 0.6.7.
- **Room right:** Custom beside 80, 120 and 160 px (any whole 40 to 600 px), and a drag in the gap between the last bar and the price
  axis on any chart sets it (live charts; the `col-resize` cursor there; never with Shift or Ctrl). Saved as the presets, for every
  chart; Jump to live and End keep it (engine: the `room` event, `util.ROOM_MIN`/`ROOM_MAX`).
- **Lighter trade lines:** order and position lines at 60% (orders were 90%), the position line 1 px (was 1.5), full strength (and
  1.5 px) while the mouse is on the line, its label or its tag, or it is dragged.
- **See-through labels:** an order's label (SL, TP, an entry, planned legs; compact or full) at 55% where a candle is behind it, full
  while the mouse is within 24 px or it is dragged. Hit areas, the drag and the clicks are unchanged.
- **Sharp candles:** the chart's canvas now covers whole device pixels (`resize()` and a twice-a-second check for a panel moved with
  no resize or a window taken to another screen). Before, a panel whose size was a fraction of a device pixel had a canvas the
  browser scaled by part of a pixel, so it resampled the whole chart; thin candles (zoomed out) went soft first.
  `npm run smoke:blur` (new): a chart at whole and fractional CSS positions and sizes, at 100%, 125%, 150% and 200% scaling (a real
  device scale factor), thin and wide candles: on 1.36.0, 7 of 32 placements are resampled (as low as 88% of pixels matching the
  canvas's own); on 1.37.0 all 32 match 100%.
  `npm run smoke:candles` (new, Anthony: "I want to MAKE sure"): the same sample chart drawn by 1.36.0 (kept unchanged as
  `test/fixtures/chart-engine-1.36.0.js`, the reference) and by 1.37.0, at 100%, 125%, 150% and 200% (real device scale factors),
  candle spacing 2.6, 6 and 14. At a whole-pixel box: 0 pixels differ in all 12 cases. At a fractional box, the reference placed at
  exactly the box 1.37.0's canvas landed on: the same canvas size in all 24 cases and 0 pixels different in 23; at 150%, spacing 2.6,
  the 12-column grid's third, 1,372 pixels differ: 13 candles (every tenth) sit one device pixel to the left, same color, width and
  height. Why: 1.36.0 lays its candles out from the box's width as the browser measures it (640.66669 css px, its 1/64 px layout
  units), 1.37.0 from its canvas's whole device pixels over the ratio (961 / 1.5 = 640.66667), and those candles' edges fall within
  that hair of a pixel's middle. Given exactly 1.37.0's width and height, 1.36.0 draws the same pixels in all 24 cases (0 different).
- Tests: `test/multi-account.test.js`; `npm run smoke:multi-account`, `smoke:blur`, `smoke:lines`, `smoke:candles` (new); the display smoke checks Custom
  and the gap drag; the accounts, settings and member-rules smokes follow the moves; `npm run check:orders` gains the bench, no
  hedging always on, a group with no rules and the risk while flat (GroupsHarness) and a benched agent seat (AgentHarness). Version
  1.37.0 (package.json, engine header and VERSION, COMPAT.json page), ChartBridge 0.6.7, CHART_STYLE and PROTOCOL entries.
- **A phone's Agent tab no longer jumps under the finger** (page only, `live/agent.css`): at 720 px and narrower, with the Agent
  tab open, the top bar wraps, and its status line ("feed 36 ms · local 13 ms (p95 297 ms) · 60 fps", rewritten every second)
  was sized by its text, so a p95 coming or going, or "60 fps" becoming "idle", moved it to a row of its own and back: the bar
  grew or shrank by 20 to 34 px and the whole tab under it moved, Accept and Reject with it. The status line now has a fixed
  width (330 px, its full text), so the bar's height never follows its text; at 390 px the bar looks as it did most of the time
  (the line on its own row). This was the agent-targets smoke's flaky "ChartBridge's error line moves no Accept" at 390 x 844
  (2 or 3 runs in 10): the line was never the cause. A new check sets each text the line takes and measures in one go: it
  fails on 1.36.0 at 390, 412 and 600 px and passes now.
- **ChartBridge's line no longer covers Kill all agents on the board** (page only, `live/agent.js`, `live/agent.css`; Anthony
  2026-10-22: "Band above the board"): with the Heroes on duty board open the line went back to the page's place, fixed under
  the top bar, and lay over the board's Desk and Kill all agents (a "no heartbeat" warning, just when Kill all is wanted; the
  agent-board smoke's Desk click timed out now and then). While the board is open the line and the notices now sit in the
  tray, the band of a fixed height above it (66 px, 96 on a phone, as narrower than 1100 px already), at every width: they
  cover nothing, and coming or going move nothing. The board starts 66 px lower at 1440 px. A new check fails on 1.36.0 at
  1440 (both buttons covered) and passes now.

## chart 1.36.0 (2026-10-22): the Agents strip, the Bot panel merged into it

Anthony's request of 2026-10-22 (WORK, "FROM_WORK_2026-10-22_REQUEST_agents_strip_panel.md"): "I want a panel made, that plays
horizontally, but just shows the current active shadow agents and eventually live agents status, so If I dont have their tab
pulled up I can still glance over and see their position, spent, stream of thoughts." **Page only: no ChartBridge change** (it
stays 0.6.6; `minChartBridge` stays 0.6.2), no Desk change of its own (it reads The Desk of chart 1.35.0; a seat's resting order
and a paper trade's risk come from The Desk's main, which passes `status.seats.<seat>.resting` and each trade's `risk_dollars`
and `stop_points`), no Bot-Lab change.

- **The Agents strip** (`live/agents-strip.js`, `live/agents-strip.css`, new page files): "Agents" in + Add panel, at most one a
  layout, made for the lower left of the Accounts layout on his third screen (about 1,430 by 450 px at 1906 x 1014). One card per
  agent, left to right: the league's seats H Haiku (amber), S Sonnet (cyan), O Opus (violet), as the League tab, then each live
  agent ChartBridge lists that is running, holds anything, or is killed or stood down (an off, empty slot is named in the strip's
  foot instead). Cards share the row at 240 to 360 px each; past that the row scrolls sideways inside the panel, never the page.
- **Each card:** the name and colour; the **mode big, SHADOW or LIVE only** (Anthony 2026-10-22: "theres really only 2 types right
  now, shadow or live. They are either shadow trading or get promoted and trade live with either sim or a cheap eval"): SHADOW in
  a dashed purple box (a seat, paper; a live agent or the bot in Shadow, or on no account, where nothing trades), LIVE filled with
  the accent for one trading an account of its own, the account kind under it in small text (sim, or "not Sim: eval or funded":
  the page cannot tell an eval from a funded account); the Copilot and Auto words are never shown, so a paper seat is never
  mistaken for a live one; its **one word** when it matters (look cap,
  API stopped, day stopped, day closed, feed down, status late, retired; killed, stood down, off, not connected); **now** (flat, or
  LONG or SHORT N since hh:mm, open P&L in dollars and R, the stop and target distance in points, a resting order); **today** (P&L
  and R, trades with wins and losses, the seat's virtual 50K Flex balance and room to the floor); **spend** (the seat's dollars
  against the seats' pool, the day against the day cap, calls today); the **stream of thoughts**, newest first (time, action,
  confidence, the first line of the reasoning; the lines that fit whole). A click on a thought opens its full reasoning in a box
  over the strip (Close or Escape); a click anywhere else on a card (or its › button) opens the League tab for a seat, the Agent
  tab on that agent for a live one.
- **Worked out on the page, and said so in its hover:** the **look cap** (the league logs it, but neither status.json nor The Desk
  passes it on): a seat's counted looks in the 60 minutes before now (every decision but a look at Anthony's new entry, which the
  league never counts: Amendment 7, read as runner.py `_look_kind` reads it, its `look_kind` or else a trigger starting "a new
  mentor entry"); 30 or more is the cap, and the next look is when the oldest of the last 30 counted ones is an hour old (the
  league's own rule, Bot-Lab league/runner.py `_cap_ok`: any 60 minutes, not the clock hour). Open P&L and R from the page's MNQ
  price (the Quote board's quote) against the paper fill. R is on the trade's ORIGINAL risk, never on the stop now (after
  break-even or the trail the stop is not the risk): a seat's open P&L dollars over the trade's `risk_dollars` (gross, before the
  round-turn fees; the hover says so, since the league's booked R is net of them), else its points over `stop_points`, the stop
  distance at the fill; a live agent's on its plan's risk; else "R not reported". The seats' pool: the day cap less the coach's
  reserve.
- **A seat's resting order:** read from status.json's `resting` as The Desk passes it on (`status.seats.<seat>.resting`): its
  side, type, price (or its reference), stop and target points, and "until hh:mm (N min left)"; null says nothing; with an older
  Desk that leaves the field out, "resting order: not reported".
- **The bot's card (the Bot panel merged into the strip,** Anthony 2026-10-22: "get rid of the bot panel and merge it into
  this"): after the live agents, whenever this ChartBridge offers the Bot (protocol v3), even with its channel off. Its name,
  SHADOW or LIVE with its account kind, its status words, its position (open P&L from the page's price; R, stop and target not
  reported), today's P&L, trades and losing trades, and its rails (trades n of max, losing n of max, amber and red as the Bot
  tab) in the spend row's place; its last signal. Its red alert by bot.js's own rule (one function, `alertNow`, read by the Bot
  button's bt-alert and the card: rails red, stand-down, killed, on but not connected) gives the card the Bot button's alert look
  and its one word. A click opens the Bot view, unchanged, where its enable, kill switch and rails are.
- **The Bot panel is gone:** "Bot" is no longer in + Add panel and `bot` is no longer a panel type (a saved layout that had one
  opens without it, no error). The Bot's button stays in the top bar where the Bot tab always was, on every layout (Anthony: "bot
  tab never left the top, that was the SS and its fine there"); the strip's bot card opens the same Bot view.
- **The League tab's decision log:** a "rest" answer is shown as a resting order ("rest short at IBL, stop 6 pt, target 15 pt,
  good until not reported": The Desk passes no good-until time with a decision), no longer as an entry; a "cancel" as the cancel
  of its resting order.
- **Not reported, never a guess:** a live agent's room,
  its calls, a resting order's time left, the PC helper's spend while the Agent tab has not read it.
- **One league read for the page:** the strip has no poller of its own. The workspace's league read (the faint marks' 30 s read)
  now runs while the faint marks or a strip are on the page, every 15 s with a strip, and reads nothing while the League view is
  open (that view reads every 15 s and its day is the one used). The live agents come from the Agent tab's state (`glance`, a new
  read only accessor in `live/agent.js`: his stream, his day's trades, his open position's first fill and risk, his working
  orders, the helper's spend as last read; `glances` gives every agent's from one read of the day's fills a second). The read
  gives up after 10 seconds, so a Desk that never answers cannot stop it.
- **Read only:** the strip sends nothing (no order, no agent or bot control message, no request of its own; the smoke checks it).
  **No motion** (docs/MOTION.md R3): a new thought is simply the first line the next time the card is drawn; nothing scrolls,
  slides or fades. A card is drawn again only when what it shows changed, and the stream's lines are measured again only then or
  when the panel's size changes.
- Tests: `test/agents-strip.test.js` (the derived look cap, the mode labels, not reported, the seats' and an agent's cards, the
  page) and `npm run smoke:agents-strip` (test/agents-strip-smoke.mjs: a SAMPLE league day, labelled as sample on every seat
  card, and the made-up Demo Agent in Shadow, in an Accounts-like layout at 1906 x 1014; screenshots
  `test/out/agents-strip-*.png`).

## chart 1.35.0 (2026-10-21): the League tab, the Bot as a panel, Update floors from The Desk, the trade note

Anthony's decisions of 2026-10-21. **Page only: no ChartBridge change** (it stays 0.6.6; `minChartBridge` stays 0.6.2). Needs The
Desk of this release (TheDesk branch `desk/release-1035`) for the league view, the floors and the note; with an older Desk each
says so (the league view and the floors: "The Desk has no ... yet"; a note record is refused by The Desk and the lost line says so).

- **The League tab** (`live/league.js`, `live/league.css`, new page files; Bot-Lab notes/DECISIONS_bot_division.md, "SHADOW
  LEAGUE: WHERE IT RUNS AND HOW IT SHOWS", and Anthony's ruling of the same day: keep the Agent tab exactly as it is, he pops in
  to check a running agent, and add the league as a second top-level tab): the top bar's **League** button, right after the Agent
  tab (`#wsLeagueTab`, `?tab=league`), opens it in place of the grid; the Agent tab, the League tab and the Bot view close each
  other, one at a time. The button shows once The Desk answers `GET /api/chart-league` (asked at the start and every 5 minutes):
  with an older Desk, or none reachable, the top bar keeps its room and the ⋯ switch below is not offered. One MNQ chart with each seat's paper trades as hollow marks
  carrying its letter in its color (H Haiku amber, S Sonnet cyan, O Opus violet): a circle at the fill, a diamond at the exit, a
  faint dashed stop and dotted target from the fill to the exit; "SHADOW: no orders"; the legend strip; each seat's day (its
  open paper trade, its virtual 50K Flex account, today's R, its looks, the league's flag for Anthony); the API spend against the
  caps; the week and month table with agreement and decision time ("not enough data yet" under the league's 20); the decision
  log. Read from The Desk's new `GET /api/chart-league` every 15 seconds while open (TheDesk docs/API.md "Shadow league"); after
  the 16:01 close it says "day closed, recording to 17:00". The marks are an overlay canvas drawn after each frame the chart
  draws (its `drawn` event): the chart's own canvas, look and motion are untouched. Nothing in it sends an order; the league is
  paper.
- **The league's trades on any chart:** each NQ or MNQ chart's ⋯ menu has "League trades (faint)", off by default, kept in this
  browser (`live-league-ghost-v1`); The Desk is read every 30 seconds while any is on.
- **The Bot tab as a panel** (Anthony: "the bot tab can also move to a panel"). + Add panel offers "Bot", at most one a layout.
  The panel holds the very button the top bar had (`#wsBotTab`, with its listeners and states) and opens the same Bot view; while
  any view is open (Bot, Agent, League) the button sits in the top bar where the Bot tab was, so one view can go to the other;
  closing the panel puts it back in a hidden hold (the Bot desk, its proposals, the copilot keys and the bot strip run as before).
  A layout with no room for the panel still reaches it: the menu item opens the Bot view itself and says so; with the panel placed
  already it opens the view. **The Agent tab is unchanged**, in the top bar where it was.
- **Update floors from The Desk** (Accounts tab, with ChartBridge 0.6.6): every prop account's floor as The Desk has it (its Prop
  seed from the firm dashboard plus the tracked fills; The Desk's new `GET /api/chart-floors`) beside ChartBridge's, and every one
  skipped with why (not listed by ChartBridge, no firm rules there, a static drawdown, The Desk's own reasons). Nothing goes until
  Send; then ChartBridge's existing `firmMinimum` for each (it checks each again), each row saying sent, set or refused.
  Repeatable.
- **No NinjaTrader floor flag once the firm minimum is set:** a firm minimum sent from this page and not refused within 3 seconds
  is kept in this browser (`live-firm-min-v1`); for such an account "NinjaTrader shows X to the floor, ChartBridge Y" (NinjaTrader's
  trailing figure never locks, so it always differs) is no longer a flag. NinjaTrader's figure is in the Room's hover for every
  account.
- **Trade tags: the note** (one line, at most 200 characters, under the chips): Enter or leaving the box after a change records it
  for the trade shown (`dim` `note`; every edit a new record, the newest is the note, an empty box clears it). Never a chip and
  never scored (The Desk keeps notes apart). Typing in it fires no hotkey: every hotkey handler of the page ignores keys while a box
  has the focus (the smoke checks KEYS OFF and that no order message goes).
- **Trade tags: the lost line** says when the losses happened and why (refused by The Desk, or unreadable in this browser) and goes
  with its Seen button. The bare count a 1.34.x browser kept (the "10" Anthony saw) becomes one loss with no time, said so.
- **Screens in Brave** ("Open my screens" put every window on the main monitor). Cause: Brave's Shields, with fingerprinting
  blocked, report `window.screenX`/`screenY` and `screen.availLeft`/`availTop` as a small random number, the screen as the size
  of the window and `screen.isExtended` false, and place a `window.open` child relative to those (brave-core pull 13737,
  kBraveBlockScreenFingerprinting). So every window was saved near 0, 0. The page cannot see through it: the Screens pop-up now says
  why and lists exactly what to allow (Shields down, or "Allow all fingerprinting", for this page; Window management: Allow;
  Pop-ups and redirects: Allow; reload and save again), and Save refuses the made-up places. It also says when Window management is
  blocked or not offered, or the pop-ups were blocked.

**The review of 159cca4, fixed** (the floors' Send waits on Anthony's ruling and is unchanged here).
- The Bot's red alert (rails red, stand-down, killed, on but not connected) is never hidden: while its button carries it, the
  button sits in the top bar where the Bot tab was, with or without a Bot panel, and goes back to its panel or the hold once it
  clears (the workspace follows the button's class as the Bot desk sets it).
- From the Agent or the League view, with or without a Bot panel, the Bot button is in the top bar: one click to the Bot.
- The "Layout" word gives way (`bt-has-tab`) only while the Bot button is really in the top bar (1.35.0 before this fix hid it for
  a Bot tab waiting in its panel or the hold).
- The league's faint marks draw the League view's day only while that view is open, else their own 30 second read, so they never
  freeze on what the view read last; closing the view hands its day over and reads at once. Only the latest read schedules the
  next, so a read still on its way when the view closes never starts a second 30 second poll.
- Screens: a real Brave window in F11 full screen at 0, 0 on the main monitor looked made up; when window management is granted
  and the browser lists more than one screen, the place is real.
- A `firmMinimum` refused after the 3 second wait is matched to its account: the remembered minimum is forgotten (the NinjaTrader
  flag can come back) and its row says refused. A remembered minimum also keeps the firm rules it was set under (size, drawdown
  and its type, lock) and is forgotten when they change (another type applied, a reset). A late refusal undoes only the
  minimum it was sent for, never a newer one sent since.
- The floors box: one row per account (two from The Desk for one account: the newer seed kept, the other listed with why), and each
  row shows this page's label for the account, then ChartBridge's name, then The Desk's prop name.

**Tests.** `npm test`: 883 pass, 0 fail (1 skipped: the PowerShell updater tests). New `test/league.test.js`; new tests in `test/trade-tags.test.js`,
`test/accounts-page.test.js`, `test/screens.test.js`. New smoke `npm run smoke:league` (screenshots `league-1366.png`,
`league-1600.png`, `league-1920.png`, `league-chart.png`, `league-faint-1366.png`, `league-agent-tab-1366.png`,
`league-panels-1366.png`, `league-nofolder-1366.png`); `smoke:trade-tags` (the note and the lost line: `trade-tags-note-1366.png`,
`trade-tags-lost-1366.png`), `smoke:accounts` (the floors and the flag: `accounts-12-floors-desk-1366.png`,
`accounts-13-floors-sent-1366.png`), `smoke:screens` (Brave: `screens-brave-1366.png`) extended; the bot smoke and agent-smoke open
the Bot view through `test/tab-buttons.mjs` (its panel, or + Add panel when there is no room); the agent smokes are unchanged but for
the Bot clicks and the top-bar order check in `agent-smoke.mjs`.
Every smoke in package.json and the new one were run (49 files): 47 pass. Two fail one check each, and fail the same check on main
(`bc9bc05`) in this environment, run here for the comparison: `smoke:bot` (waiting for the Library pop-up window) and
`agent-board-smoke.mjs` (the board's Desk button click), as the 1.34.0 entry says. No NT8 harness run: no ChartBridge change.

## chart 1.34.1 (2026-10-21): the Trade tags panel keeps clicks made during a trade and on Last trade; the ARMED chip

WORK's test card on 1.34.0 (FROM_WORK_2026-10-21_release.md, step 3.5): a chip clicked while a trade was open (OPEN) or
on Last trade (AFTER) showed for a moment and never reached The Desk; clicks made while flat (PRE) were saved. The cause:
ChartBridge sends a fill's `u` with three decimals (sub-millisecond), the panel named the trade by that time, and a
record's `trade_open_ms` must be whole milliseconds, so the record was dropped as invalid before it was queued. Now the
trade's open and close times are rounded to the millisecond (The Desk matches a trade within 2 seconds, so the match is
unchanged), and a click that cannot be made into a record says so on the panel instead of vanishing. Page only: no
ChartBridge change (it stays 0.6.6). A new test fails on 1.34.0 and passes on 1.34.1.

The ARMED badge in a chart's header (Anthony 2026-10-21: the armed tags were to be "significantly reduced in size, almost
to a chip size"): a small chip that says ARMED only, 8 px type; the account or the group it trades is in its tooltip,
never on the chart. 1.34.0 shortened it only when the header ran out of room and showed the whole account when it had
no label.

## ChartBridge 0.6.6 and chart 1.34.0 (2026-10-20): the work requests of 2026-10-20, and the firm's limits on entries

Everything on `desk/work-requests-1020` since 0.6.5 and 1.33.0. **ChartBridge 0.6.6 is a recompile** (outside market hours);
**the page works with ChartBridge 0.6.2** (`minChartBridge` stays 0.6.2): with 0.6.2 to 0.6.5 what needs 0.6.6 (the firm's
minimum, the firm's rules on an account in no group, Remove a follower row) is not offered and no `riskAlert` comes. nt8/PROTOCOL.md
"The firm's floor, Remove a follower and the firm's limits on entries (0.6.6)".

**Anthony's decisions of 2026-10-21, added to this release.**

- **Trade tags** (`live/trade-tags.js`, a new page file): its own placeable panel (+ Add panel, Trade tags), following the order
  ticket's account and instrument, so it can sit out of the way. One click per chip, four rows: Setup (Continuation, Breakout,
  Reversal, Sweep/retest, Other), Grade (A+, A, B), Context (With-trend, Counter-trend, No context), Trigger (Absorption, Delta
  flip/divergence, Level hold/reclaim, Other); one chip per row, a click on the set chip clears it. Clicks only: no hotkeys, and
  Enter or Space on a chip records nothing. Each click is one record with its phase worked out from ChartBridge's position and fills:
  `open` while the trade is open (with the trade's first fill), else `pre` for the next trade or `after` for the last one (the Next
  trade / Last trade switch while flat). Records are append-only (a change is a new record); the newest of each row is its chip,
  shown with the phase it was set in. Everything else (levels, delta, time, MFE, MAE, hold, exit, the stop) is measured from the trade
  on The Desk. Records go to The Desk's new `POST /api/trade-tags` (TheDesk branch `desk/trade-tags`); while The Desk is not reachable
  they wait in this browser and are sent again every 10 seconds. A ticket on a group records each click for every member.
- **The stop record** (`nt8/ChartBridgeStops.cs`, a new add-on file; nt8/PROTOCOL.md "The stop record to The Desk (0.6.6)"). What
  was there: ChartBridge saw every order update (with the stop price) but kept none of it; The Desk had the fills (fill and exit
  prices and times) and the Tradovate Orders import (each order's last state only). Added: for every stop order on a watched
  account, whoever placed it, one event per change of NinjaTrader's state, stop price, quantity or fills, with the time ChartBridge
  saw it, queued in `pending_stops.jsonl` and sent to The Desk's new `POST /api/stop-events` (the fills' queue rules). On with
  `postFills` (or `postStops = true|false`). The Desk's `GET /api/trade-record` gives each closed trade its stop at send (price,
  distance in points from the fill, contracts, time), every modify, his first stop move after the fill, the fill and the exit.
- **groups.txt that cannot be read no longer blocks the bot, the agents or the copier** (Anthony's ruling, replacing the 0.6.6
  review's "they stay refused" below): they run on "the last groups that read cleanly": `groups.txt.good`, which ChartBridge writes
  after every clean read and every save (never `groups.txt.bak`, the copy before the latest save, one change behind; never `.tmp`).
  A read blocked by a sharing lock is tried 5 times, 0.1 s apart. With no `groups.txt.good` they wait. His single-account orders
  always go; his group entries and every change stay refused and the file is never rewritten; the Q-EXIT cancel of an exit left
  behind stays off. The banner says the machines run on "the copy of <time ET>", and each account's floor and rooms worked out from
  it carry `fromCopy` (the Accounts tab's Room tooltip and the ticket's room line say so). The page plays the alert sound with the
  groups.txt banner, never a dialog.
- **The review of b4bc612, fixed.** The stop record never writes or sends on NinjaTrader's order event thread: the event only adds
  to the queue in memory, the 10 s timer saves and sends (and ChartBridge's stop saves); at most 20,000 events wait (the oldest
  dropped, counted in `/diag` `stops.dropped`, said once); a 404 from The Desk means it has no stop record: nothing more is queued
  until the next start (`stops.deskHasNoStopRecord`); the values are the event's own (`OrderEventArgs`), a repeated final event is
  dropped, and a stop with no master instrument is skipped with one line. The Trade tags panel never trims a record The Desk has not
  taken (every pending record kept, the newest 400 of the rest), and says on the panel when any record was ever lost.
- **The review of 4406fcb, followed up.** `pending_stops.jsonl` is written outside the queue's lock (the order event never waits on
  the file; a failed write is tried again); a sent batch is taken off the queue by who its events are, so events the cap moved to the
  front meanwhile are never lost; ChartBridge's stop saves after it stops watching the accounts (a hard crash or power cut can lose
  up to 10 s of stop events); `groups.txt.good` is written through to the disk like groups.txt and ends with `# end <lines>`, so a cut
  copy is no clean copy and the machines wait.

**Tests for the 2026-10-21 additions (after the reviews of b4bc612 and 4406fcb).** `npm test` 871 pass, 0 fail (1 skipped: the PowerShell
updater tests). The Mono harness (`npm run check:orders`): 3423 checks, 0 failed (new: `StopsHarness`, 31 checks through
ChartBridge's own order event: the stop at send, a drag, the end and its repeat, the event's own values, a stop with no master
instrument, memory only on the event thread, the file written outside the queue's lock, a sent batch taken off by who it is (never newer
events the cap moved to the front), the cap, the switch, The Desk down, up, refusing one event and answering 404;
`GroupsHarness.LastGoodCopy`: groups.txt.good written after a clean read and a save with its end line, a cut copy treated as none, a .bak alone never used, groups.txt unreadable
or missing with a good .good, the machines not blocked and held by the copy's one direction, `fromCopy` on the accounts message, his
group entry and every change still refused, the alarm with the copy's time at sign-in; `AgentHarness`'s unreadable cases remove the
.good as well, as they test no clean copy). `nt8/check/check.sh` compiles. New smoke `npm run smoke:trade-tags` (screenshots
`trade-tags-flat-1366.png`, `trade-tags-open-1366.png`, `trade-tags-last-1366.png`, `trade-tags-panel.png`), 3 runs of 3 (and again after the review's fixes). Every other smoke in package.json passes here except two, each failing one check, and each
fails the same check at 1ef3e3b, before this work, in the cloud environment too, so the release commit's "every smoke passes" was not
so there: `smoke:bot` (waiting for the Library pop-up window, 30 s) and `agent-board-smoke.mjs`, the last part of `smoke:agent` (the
board's Desk button click, 30 s). `smoke:agent`'s 390 px error-line check failed once in a full run and passed 2 of 2 on its own.
After the review's fixes `smoke`, `smoke:trade-tags`, `smoke:accounts`, `smoke:group-ticket`, `smoke:member-rules`,
`smoke:flatten-every` and `smoke:workspace` were run again and pass; after the follow-ups, `smoke` and `smoke:trade-tags` again.

**Anthony's decisions of 2026-10-20: "Only absolutely critical things should stop an account from trading."**

- **His own entries: one hard check.** An entry (an order that opens or adds; the part past flat of one that turns) that would take
  the account over the firm's max contracts, a fixed number typed in its rules, is refused by ChartBridge with a short why on the
  ticket's note ("over SIM-B's max of 4 minis: this entry of 5 NQ would take it to 5 minis ... Nothing was sent; 4 NQ at most"), and
  nothing is sent. No pop-up: lower the size and send again. No max typed: no check. Exits, closes, flattens and stop or target moves
  are never checked. No floor, daily room or no-stop check is added; the 1.13.0 first-order NO STOP question is unchanged.
- **The bot, the agents and the copier's followers** (no one at the keyboard) are held back only on a KNOWN breach, by one shared
  check in front of every entry they place (the order path for the bot and each agent seat, the copier's `Eligible` per follower):
  over the max contracts; this entry's stop risk plus the open stop risk past a known room to the floor or a known daily room (the
  group sizing's arithmetic); or the account's daily loss already reached that trading day. Not known (a room, a risk, a balance):
  the entry goes. A follower that would break a limit skips that one copy; the leader and the others trade as normal. Each hold
  sends one alert.
- **Alerts, never modal.** ChartBridge sends `riskAlert` once when an account's daily room reaches 0 or below (no new machine entry on
  it for the rest of that trading day) and for each held entry or skipped copy. The page shows it in its ChartBridge banner (red for
  the daily loss, amber for a hold) with a short sound, once per window; the Account page's log keeps it.
- **Nothing ever flattens an account on its own.** The firm does that at its daily loss limit.
- **Group auto-sizing never above the firm max.** Since 0.6.5 a member was capped by one max in mini equivalents, the smaller of
  `maxMinis` and `maxMicros / 10`. After the review (Anthony's ruling, "10 micros = 1 mini") one combined rule holds every entry,
  his own, a group member's and the machines', whatever its instrument: after the order the total in mini equivalents (minis +
  micros / 10, held and working, every instrument) is at most `maxMinis` and the total in micro equivalents at most `maxMicros`, each
  when set. So a 2 minis / 40 micros account holding 15 MNQ cannot buy 1 NQ, and holding 1 NQ can buy 10 MNQ, not 15: the same answer
  whichever came first. (An earlier commit of this release, ef98500, counted micros against `maxMicros` and minis against `maxMinis`
  separately; replaced.) A member capped to 0 sits out and says it is at its max size.
- **Flatten every account** (approved earlier today): its own button in the top bar beside Flatten all, with one confirm listing each
  account and what it holds. It flattens every account ChartBridge lists with a position or a working order, the copier's, the bot's
  and the agents' included, whatever the ticket shows, with Armed off, paced within ChartBridge's 10 order actions a second as Flatten
  all. Flatten all on None still sends nothing. Its button, like every order button, goes by a click only. Under 1440 wide it reads
  "Flatten every" (the whole name in its tooltip and for screen readers) and the top bar's items sit 10 px apart instead of 16, so
  every control keeps its full size at 1366.
- **The ticket shows the account's room** (it did not: only a chart's header said "Limit N%" from 70 percent used): one quiet line
  for a single account where ChartBridge's numbers give them, "Room $900.00 daily · $1,700.00 to floor · entry $40.00 at stop" (Qty x
  the bracket's or the Order Strategy's stop), display only.
- **Audit: a tall Indicators menu** (a group opened, on a chart low on the screen) slid under the workspace's top bar. It now stops
  just below it, its list scrolling inside when needed, and a gear's card never goes above the bar either.
- **Found and fixed on the way: groups.txt refused its own file.** 0a9f315 (below) writes the firm's rules of an account in no group
  as a `rules` line, but the loader still refused any rules line for an account in no group, so after the next start the whole file
  was unreadable and every new entry refused. The loader now reads them.
- The top bar's delay line gives way part by part (the frame rate, the p95, the local delay) whenever it is cut, as it did with the
  clock warning: at 1366 with the v3 tabs Flatten every account takes its room.

**The review of 1310f06 (Anthony's rulings of 2026-10-21), fixed.**

- **The max, one rule** (above).
- **An exit refused at the max while the two position readings disagree.** The position an order closes is now the larger of the
  two readings, so an order that reduces by either is never checked (listed long 4 NQ with a sell fill of 4 not in the list yet: a
  sell of 4 goes).
- **A machine's entry with the open stop risk not known** is still held when its own stop risk alone is past a known room to the
  floor or daily room. Unknown rooms still never hold anything.
- **A group member with its room or open stop risk not known: "size it anyway".** It is sized by its risk percent and its firm max
  (and `maxQty`), the unknown room's cap skipped; a known room still caps its own stop. The ticket's projection says so quietly
  ("SIM-B: room unknown: sized by risk only"), and no confirm opens for it. The confirm now opens only when a member sits out for a
  real reason: its risk below one contract's stop, at its firm max or the `maxQty` cap, a known room too small, the copier's, the
  bot's or an agent's account, not in NinjaTrader or not connected.
- **groups.txt that cannot be read: "My single orders go".** His single-account entries go; group entries are refused with a banner
  saying why; the bot's, the agents' and the copier's entries stay refused (they read the groups: an agent's seats, the one direction of a member's group).
- **Holdings ChartBridge does not serve** are named by Flatten every account and Flatten all, in the confirm and the note: "Not
  covered (not served by ChartBridge): FUNDED-C YM 12-26" (ChartBridge's accounts entries gain `unserved`). With no v3 connection the
  confirm says it covers the trade accounts only.
- **The ChartBridge banner no longer pushes the panels down.** It floats over the top of the grid under the top bar. In the
  group-ticket smoke the fake's EVAL-B went Gone about 10 s in; its banner opened between measuring the group stop line and dragging
  it, moved every chart 46 px down, and the drag missed (the smoke failed about one run in five). The smoke also measures the line
  and the position label again right before it drags and hovers.
- **Going back to 0.6.5 after 0.6.6** (nt8/PROTOCOL.md): 0.6.6 writes a `rules` line for an account in no group, which 0.6.5 reads
  as an unreadable file (every entry refused). Take those accounts' rules off before going back.

**The work requests of 2026-10-20 (WORK and Anthony), built earlier on this branch.**

- **The floor from the firm's rules** (Anthony: "the floor and thus the % used for certain accounts is still wrong ... so it stops
  being an issue?"). An account in no group takes its type's rules too (`memberRules` there), so its floor trails and locks as the
  firm's. The computed room is the room; NinjaTrader's broker figure (which never locks) only when nothing is computed, and always
  sent beside it as `roomFloorNt` (the page flags a difference). `firmMinimum {account, minBalance}`: the firm dashboard's minimum
  balance seeds both highs (minimum plus drawdown), so the floor equals the firm's from then on; refused below the starting floor,
  above the lock, on a static drawdown or with no rules.
- **Remove a follower row** (`copierFollowerRemove`): an off row left from the October copier tests kept its account out of every
  group entry. Refused while the follower is on or the copier still holds anything there; the copier state says `canRemove`, and the
  Copier tab marks every saved follower row.
- **The Accounts tab's clean layout:** rows grouped by group with Sim folded, the Room column showing the tightest limit, each
  account's settings in a drawer, columns dragged wider or narrower (a double-click gives the default back), the firm minimum box,
  and flags where NinjaTrader's figure differs.
- **A group entry goes at once when every account takes it** (Anthony: "this screen should not pop up each time ... only appear with
  an issue"): the confirm only when one sits out; while Armed on a group a quiet preview shows "Next entry: ... at risk" in the
  ticket's state row; the hotkeys work with a group.
- **Order labels:** short labels name no group (an entry its count, the group on hover); stop and target labels say their ticks and
  dollars ("SL -80t -$120"), live as dragged.
- **Group trading in other windows:** another window follows the ticket onto a group (its Flatten all and Close sent nothing
  there), and a group ticket's charts draw the members' positions as one line ("LONG 36 · Lucid ×4"), each account in its tooltip.
- **Screens:** Save these screens and Open my screens (each saved window on its screen, unlocked by the opening window's PIN with a
  one-time code); the Screens button beside the gear.
- **The ARMED badge** gives way before the instrument and says the account's label or the group's name.
- **Indicators:** EMA and SMA (up to three lines each), Bollinger Bands and Wilder's RSI in the lower pane, off by default.
- The new group dialog's risk box starts empty; the old Account panel is no longer offered in + Add panel.

**Tests.** `npm test` 860 pass, 0 fail (1 skipped: the PowerShell updater tests, no PowerShell here). The Mono harness (`npm run
check:orders`): 3370 checks, 0 failed (new: `GroupsHarness.FirmLimits` (the page's max, exits and flips, an exit by either reading,
the reviewer's 15 MNQ / 1 NQ case, the daily loss alert once, the machines' holds, the open risk known and not, the bot's order path),
the combined max cases in `GroupEntries`, sizing with a room not known, a no-group rules line read at the start, an unreadable file
with his single orders going, `CopierHarness.FirmLimitSkip`; the copier's start check fixed for `canRemove`). New smoke
`npm run smoke:flatten-every` (Flatten every account, what it cannot reach, and the alert's banner and sound; screenshots
`flatten-every-confirm-1366.png`, `flatten-every-done-1366.png`, `flatten-every-alert-1366.png`); `smoke:group-ticket` checks the
ticket's room line (`group-ticket-room-1366.png`) and re-measures the stop line right before each hover and drag (the floating banner fixed the panels moving; the line's label still moves a few pixels with the price axis), 10 runs of 10 after both fixes (before them, about one run in five failed:
the release commit 1310f06 said every smoke passed, which was not so for this one); `smoke:noscroll` opens every group of every
Indicators menu (`noscroll-indicators-tall-1366.png`); `smoke:studies` allows the menu's own list to scroll below the top bar. Every
smoke in package.json passes but `smoke:headroom`'s "scrolled back, the icon at the top of the price scale" (it fails the same way at
caafbd0, before this work).

## ChartBridge 0.6.5 and chart 1.33.0 (2026-10-19): one group of accounts of different types and sizes, each with its own rules, traded from the ticket

Anthony's PRIORITY ask (FROM_WORK_2026-10-19_PRIORITY_multi_account_groups, "build it into the current build"): his three Lucid
accounts in one group (a 150K Flex eval, a 50K Flex eval, a 25K Daily intraday eval; three 50K Flex evals join tomorrow). A group had
one rule set, so two of three floors had the wrong numbers. **ChartBridge 0.6.5 is a recompile** (outside market hours); **the page
works with ChartBridge 0.6.2** (`minChartBridge` stays 0.6.2: with 0.5.8 to 0.6.4 it joins exactly as 1.32.0). nt8/PROTOCOL.md "Each
member's own rules and the risk percent (0.6.5)".

- **Each member carries its own rules** (ChartBridgeGroups.cs): account size, daily loss, drawdown amount and type, floor stops at,
  target, consistency, max minis and micros, and The Desk's type id, in a `rules` line per member in `groups.txt`. The group keeps what
  is shared (name, Type, hero, No hedging, risk) and its own rules for a member with none of its own. Floor, room, daily room and target
  left per member: its floor trails from its own highest close (EOD) or highest balance (intraday) and stops at its own lock.
  `accountGroup` takes the rules with the join (all or none); `memberRules` (new) changes them later; leaving or a deleted group drops
  them. ChartBridge holds them all, so it works while The Desk is down.
- **Migration.** A member with no rules line inherits the group's rules: a 0.6.4 file loads, gives the same numbers and is written
  back line for line (risk off adds no field). A ChartBridge before 0.6.5 reads a rules line as a line it does not know: the whole
  file unreadable, every entry refused with its alarm, never rewritten (the 0.5.8 rule; never a floor from the wrong rules).
- **The join is automatic** (Anthony: "I shouldnt have to manually assign the account types ... so its all automatic"). Picking a
  group takes the account's rules from its type on The Desk, a number set on the account itself on The Desk winning, and shows one
  compact row: the rules taken, the risk dollars and the highest close question, prefilled from The Desk's seed floor plus the
  drawdown when The Desk sends `seed_floor` (desk/reorg-prop-roi; read if present, else asked as before). Only an account with no type
  on The Desk gets the full rules form; Edit rules opens it on any join; a member's Rules (its Limits cell) changes its rules later.
  The type picker is 1.32.0's (Firm > Plan > Size), not repeated.
- **Trade the group** (Anthony 2026-10-19: "Trade the group (new)"). The order ticket's picker lists each group after the accounts
  ("Group Lucid (4)"; the hotkeys follow the ticket). Buy, Sell and a chart click on a group send one entry with its bracket stop to
  every member, each sized by ChartBridge from the group's risk percent of its own max loss (its drawdown amount: 10% is $200 on a
  50K, $450 on a 150K): contracts = floor(dollar risk / (stop ticks x tick value)), in the entry's own instrument. Guards, in order: a
  member whose room to the floor (or, with a daily loss rule, daily room) is not known sits out; never above its max size (minis or
  micros, from its rules) nor ChartBridge's `maxQty` for the root, less what it holds and has working on that side (an add is sized
  the same way); the stop loss within its room to the floor and its daily room; a member at 0 sits out and says why. No stop: refused
  ("a group entry needs a stop"). The ticket first asks ChartBridge (`groupPreview`) and shows one confirm with each account's size,
  dollar risk and budget, or why it sits out; Send (a click only) sends `groupOrder` with those sizes, which ChartBridge works out
  again and refuses whole if any changed; each member's entry then goes through the order path (every gate, one direction per
  group, its own legs). Close, Flatten all, B/E (each member's own break-even) and Cancel all act on every member. A member that is
  the copier's leader or a follower, the bot's account or an agent's sits out (as a group trading seat). The group's risk off: a
  group entry is refused. The copier, the agents and single account tickets are unchanged. `accountState.rules` gains `maxMinis`
  and `maxMicros` (0 none).
- **Anthony's answers (2026-10-19), built.** (1) A group ticket's charts draw the group's order lines: one line per level (the
  members' orders of one role, side and kind at one price, and their planned lines), its quantity the sum, labelled with the group
  and how many accounts it covers ("STP 9 · Lucid ×4"; the engine's `group` field, CHART_STYLE.md), each account's order in its
  tooltip. Dragging a group stop or target moves EVERY member's order to the same price, the price dropped at: one `change` per
  member, each ChartBridge's single path (a stop already traded is refused for that member as on one account), and the ticket says
  each member's result ("Group stops to 25,406.75: SIM-A, SIM-B moved; SIM-C: refused (...)"); its x cancels each, a planned
  line's drag or +SL / +TP sends `plan` to each. (2) An Order Strategy may go with a group entry: its stop sizes each member (the
  same formula and guards) and its targets and stop management run on each member's own entry. (3) The copier, bot and agent sit
  outs stay. (4) The room cap counts ALL the member's open stop risk on that side: each position it holds there at its working
  stops, measured from the last price (a stop past the price in profit risks 0), comes off its room to the floor and its daily
  room before the new entry's stop; a position with no working stop for some of its contracts makes the risk not known, so it sits
  out and says why.
- **The review of d7c8e50, fixed.** The open stop risk counts every working entry at its own stop and every position on both
  sides (each contract month from its own price); one lock holds a group entry from its sizing to its last order, and page entries
  take it too, so two windows cannot both pass the room check; the confirmed sizes carry their accounts; the max size counts every
  instrument in mini equivalents (10 micros = 1 mini); a stop-limit strategy sizes from its stop plus its limit ticks; the preview
  applies the bracket cap; the group's Close, Flatten all, Cancel all, B/E and lines leave out the copier's, the bot's and an
  agent's accounts (`tradeOut`) and say so; one id per planned group level; the ticket shows the group's risk in place of QTY and
  each member's position; a member that leaves the group mid trade is named (its own stops stay); the join row shows the seed's
  date ("highest close from The Desk's seed of 2026-10-17").
- **The re-review of c360a20, fixed.** A closing side OCO set (an ATM's or a typed stop and target) is one exit up to the position;
  every OCO order on the adding side counts in the open stop risk and the max size. With both max limits set, the smaller (4 minis /
  20 micros is 2 mini equivalents). A page market exit never waits on the group entry lock (only entries take it), and a group
  entry's answer is sent after the lock is let go. The ticket redraws for the groups only when membership, tradeOut or a member's
  positions change.
- Tests: `test/member-rules.test.js` (The Desk's rules with an account's own numbers winning, the seed floor, the form's checks, the
  messages, the display and the risk dollars, the fake bridge's mirror of the harness, the old ChartBridge's key lists, the source);
  the Mono harness `GroupsHarness.MemberRules` (the migration of a 0.6.4 file, every refusal, three types in one group with each floor,
  daily room and target, EOD and intraday trailing to each lock, a restart, memberRules, leaving and joining again, the risk percent,
  unreadable rules lines); `npm run smoke:member-rules` at 1366 x 768 (screenshots `member-rules-join-auto-1366.png`,
  `member-rules-join-form-1366.png`, `member-rules-edit-1366.png`, `member-rules-accounts-1366.png`, `member-rules-dialog-1366.png`).
  `smoke:settings`: the join question for an account with no type is now the full form with the same question. The group ticket:
  `GroupsHarness.GroupEntries` (each guard with its words, rounds to 0, a room not known, adds, no stop, the sizes changed, risk off,
  the placing, one direction per member), the fake's `groupSize`, `groupPreview` and `groupOrder` with the same numbers, and
  `npm run smoke:group-ticket` (screenshots `group-ticket-confirm-1366.png`, `group-ticket-placed-1366.png`,
  `group-ticket-lines-1366.png`, `group-ticket-moved-1366.png`), `test/group-ticket.test.js` (the lines, the drag to one price with a
  member refused, a strategy in place of the bracket, B/E and Close per member) and harness cases for the strategy sizing, the
  open stop risk cap and the move with one member's stop already traded.

## chart 1.32.2 (2026-10-19): a trade's own result decides its colour

Page only; ChartBridge is unchanged. **A trade can carry `pts`**, its signed result in points: when it is a finite number it
decides the colour of the trade's dotted line and chip and the chip's default text, instead of (pOut - pIn) * dir. The Desk's
Review draws a trade with adds from its first entry fill to its last exit fill (so every mark sits on a bar), while its result is
the contract weighted average: long 1 at 100, add 2 at 110, out 3 at 105 is -1.67 pt and is now drawn in the loss colour, not the
profit colour first to last would give. A trade without `pts` draws exactly as before. Tests: test/trade-pts.test.js.

## ChartBridge 0.6.4 and chart 1.32.1 (2026-10-19): no false no-trade-record alarm, the copier's leader back to none, Merge on an off follower

Three bugs Anthony hit at WORK on 2026-10-19 (ChartBridge 0.6.3). **ChartBridge 0.6.4 is a recompile for its own fixes**
(Anthony does it on each PC outside market hours); **the page works with ChartBridge 0.6.2** (`minChartBridge` stays 0.6.2).
Nothing changes on the order path: exits, legs and flattens are as before.

- **No false "no trade record" alarm on a fresh fill** (FROM_WORK_2026-10-19_BUG_false_orphan_alarm). A 1-lot long that filled
  39 s after it was placed raised "agent manrae holds 0 on Sim101 MNQ with no trade record (ChartBridge restarted)" 26 ms
  before its trade record opened, then every minute while the trade was followed with its stop and target working; ChartBridge
  had not restarted. Four fixes in `Seat.WarnHeldByStopOnly` and `RepeatTradeLost`:
  - the race: NinjaTrader shows the entry filled, the position moved and its legs working before the execution event that
    opens the record comes through, so the error now needs that state on every pass for 5 s (`OrphanConfirmMs`) with no fill
    NinjaTrader shows ahead of its event; a record, a flat pair or anything else working starts it over;
  - it clears: once a trade record follows on that pair, or the pair is flat, the error stops and, if it was sent, the pages get
    one `info` line ("agent <id>: the no-trade-record error on <account> <root> is cleared: ChartBridge follows its trade <tag>
    there now", or "the pair is flat");
  - the quantity: what the account holds by the effective reading (it counts a fill not yet in NinjaTrader's position), the
    listed one when that is 0, never "holds 0" while the account holds 1;
  - the reason: "ChartBridge restarted" only for a position that was there when this run of ChartBridge began watching the
    account (and has not been flat since); otherwise "opened while ChartBridge was running".
  After a real restart the error now comes 5 s later than before (or, with the flatten job already running, after its 30 s hold).
- **The copier's leader goes back to none** (chart 1.32.1, page only). The Copier tab's Leader none sent nothing, so the picker
  snapped back to the saved leader; it now sends `copierSet` with `"leader": null`, which ChartBridge takes since 0.4.3 (no
  leader, stood down, saved in `copier.txt`, so none survives a restart). A saved leader still comes back at start stood down
  until Re-arm ("ChartBridge started: check the accounts and press Re-arm").
- **Merge on a copier follower that is off.** The page lists every account as a follower row, so with the copier on Merge was
  refused on every account ("is a copier follower: Merge is refused ..."). It is now refused only on a follower that is on, or
  on one that is off while the copier still has something of its own there (a copied position, a copier entry, stop or close
  that may fill, a reduce or a wait), with its own words; an off follower with nothing of the copier merges as any account.

## 1.32.0 (2026-10-19): the account type picker as Firm, Plan and Size

Page only, no recompile (ChartBridge 0.6.2 as for 1.31.0; `minChartBridge` stays 0.6.2). The Desk's list of account types now holds
about 208 types from 9 firms, and one flat dropdown of them was not usable (Anthony 2026-10-19: "far to many accounts for just a drop
down"). He chose Firm > Plan > Size, with "firms I actually trade first", and for the Accounts tab "Text + Change" (the three selects
side by side cut the labels to "Luci", "Topst", "Tradir" at 1366 x 768), then "Narrower Room" for the column's width and "not
known" while The Desk is not reachable.

- **The picker's pure parts (live/groups.js GroupsCore).** `typeParts` splits a type's name as The Desk writes it ("<Plan> <Size>K
  <rest>", e.g. "LucidFlex 50K Eval", "Trading Combine 50K", "Master 25K Option 2 EOD"): the plan is the text before the first
  "<number>K" token; a name with no size token (or nothing before it) is plan "Other" and shows its whole name. `typeTree` sorts:
  the firms in use first (from the GET /api/chart-accounts rows the page already reads: the firm of each account whose type is set,
  and the firm The Desk gives on a row, its `firm` field, type set or not), then the other firms A to Z (all A to Z while The Desk is
  not reachable); within a firm the plans A to Z; within a plan by the size number, then Eval,
  Challenge or Test before Funded, Qualified, Sim-Funded or Account (any other words between them), then the rest A to Z.
  `cascadeView` gives the three selects' options and `cascadePick` each choice and what it sends.
- **Accounts tab, Account type ("Text + Change").** The cell shows the account's type as plain text ("LucidFlex 50K Eval"), cut at
  the cell's end where it is long, with the firm and the whole label in its tooltip ("Lucid LucidFlex 50K Eval (not checked)"), and a
  small Change button; with no type, "Not set" and Set. A type no longer on The Desk's list shows as before, "(not on The Desk's list
  now)". Change (or Set) opens a row under that account, as Apply's question does: Firm, Plan and Size at full width with full labels
  (Size: "50K Eval", "(not checked)" until checked), then Save, "Not set" (only when a type is set) and Cancel. No select sends
  anything (in Chromium an arrow key on a closed select fires change, so a select that sent could save a wrong type by accident);
  a firm with one plan takes it at once, and going back to the account's own firm shows its own plan and type again. Firm and Plan
  keep the focus where it is, so the arrow keys move through the firms and plans. Save is enabled once a Size other than the
  account's own is chosen; Save (a click, or Enter on it: the one button on the Account page that works by keyboard) sends the PUT
  /api/accounts/{account}/account-type of 1.30.0 and closes the row; Not set sends null and closes it; Cancel closes it and sends
  nothing. After Save, Not set or Cancel the focus goes to that account's Change or Set button (after a save, once it is back). When
  the list is drawn again, the control with the focus keeps it. One row open at a time (Change on another account closes the first). Read only (no Change or Set, no row) while
  The Desk is not reachable, as before; Apply and its question row are unchanged. While no Desk rows have been read (The Desk not
  reachable since the page opened) each cell says "not known", not "Not set", with the tooltip "The Desk is not reachable, so the
  account's type cannot be read now"; when The Desk stops answering later, its last rows show as before.
- **Accounts tab, "Narrower Room".** At 128 px the column cut "LucidFlex 50K Eval" to "LucidFlex..." (and to "Luc..." beside Change
  and Apply). The column is now 244 px, so "LucidFlex 50K Eval", "LucidPro 150K Funded" and "Trading Combine 150K" show whole at
  1366 x 768 beside Change and also beside Change and Apply (about 220 px was the ask; at 220 px the three still cut beside Apply,
  which needs 241 px). The width comes from the Room only (2.4fr to 1.45fr: 295 px to 178 px at 1366); the other columns keep their
  widths. A long Room is cut at the cell's end, and its whole text is now the first line of its tooltip. Longer type names
  ("LucidDaily 150K Eval Intraday DLL Off") may still cut, whole in the tooltip.
- **Settings, the rules dialog.** The same three selects in the place of the one Account type select. Choosing the size fills every
  rule box and the Type as in 1.30.0; "Not set" clears the link; Firm and Plan alone fill nothing and keep the type chosen last for
  Save. Firm and Plan keep the focus where it is; after a Firm or Plan change with Size still blank, a line under the selects says
  "still: <the type chosen last>" (what Save keeps), gone once a Size is chosen. Update opens on the group's type.
- Tests: `test/account-types.test.js` (the split, the order with a row's firm counted, the send rules, the selects as data with a
  type gone, the wiring: no select sends or moves the focus, Save sends the Size chosen, Not set sends null, Cancel sends nothing, the focus back
  on Change or Set, one open row, the dialog's "still:" line);
  `test/fake-desk.mjs` gives `sampleFirmTypes()` (Topstep, Bulenox and FundedNext types, made-up values); `smoke:settings` runs the
  Accounts tab against the fake Desk at 1366 x 768 (text and Change or Set, the cell fits, the 244 px column, the three names whole
  beside Change and beside Change and Apply, the Room's text first in its tooltip, the row's order with a firm in use from a row's
  firm, ArrowDown on Firm keeps the focus there and sends nothing, ArrowDown on Size sends nothing and enables Save, nothing sent
  for Firm, Plan, Size or Cancel, one row at a time, one PUT on Save by Tab and Enter, null for Not set, the focus on Change or Set
  after Cancel, Save and Not set, "not known" and read only with The Desk down) and the dialog's fill and its "still:" line by
  ArrowDown on Firm; screenshots `settings-types-text-1366.png` (the text cells),
  `settings-types-change-row-1366.png` (one Change row open, Save enabled), `settings-group-type-still.png` (the dialog's "still:"
  line) and `settings-types-desk-down-1366.png` (The Desk not reachable),
  beside the 1.30.0 ones. The check that the Room is no narrower than without the column is gone (Anthony chose a narrower Room).

## ChartBridge 0.6.3 and chart 1.31.0 (2026-10-16): the audit fixes for ChartBridge and the chart page

Audit C (the live-only quirks of a laptop: off at the wrong hour, asleep, a power cut, flaky Wi-Fi), all ten findings, approved by
Anthony on 2026-10-16 with his decisions on C5, C7 and C9. **ChartBridge 0.6.3 is a recompile for its own fixes; the page works with
ChartBridge 0.6.2** (`minChartBridge` stays 0.6.2). Order path: exits always go; the only behaviour that changes on the order path is
what Anthony decided (the kill switch kept through a restart, the flat time closing with the data feed down, the copier's leader
re-arming by itself).

- **C1: a missed 17:00 ET reset is caught up.** At start and on every 2 s check, when `daily-reset.txt` names a day older than the
  latest 17:00 ET at or before now (the page's `resetDay` rule), the reset to None runs then, with the same Idle and skip rules and
  notes that say it was caught up. No file is not a missed break; a day ahead of now is not due.
- **C2: a close or a high ChartBridge did not see never overstates the room.** `account-marks.txt` keeps the last close seen, the last
  reading's balance and flat state, and any missed close or day (12 fields; a 0.6.2 file reads as before). After a gap (a restart, a PC
  asleep, an account not connected for 10 s): nothing traded means the missed close was that balance; otherwise the trailing `floor`
  and `roomFloor` are null with the reason (in `accounts` and `accountState`) until the account is put in its group again with the
  highest close. Going back to 0.6.2 makes it read the file as not understood: its trailing floors are null (never a guess).
- **C3: state files survive a power cut.** Every state file is written through a temp file opened write-through and flushed
  (`Flush(true)`) before the replace, which keeps the old copy as `.bak`; day-file appends are flushed too. A file that reads but is not
  understood falls back to its `.bak` with a note to the pages. A damaged agent day file keeps the trades, losses and plan ids that
  read (and its `.bak`), never resets them, stands the agent down for this run only and is written again at once; the alarm no longer
  says to delete it.
- **C4: a file held open at the start is read again** (agent rules, account, day, `agent-standdowns.txt`): no new entries meanwhile,
  read on every 500 ms check, the alarm only after a minute, and the stand-down gone by itself once it reads.
- **C5 (Anthony's decision): the kill switch survives a restart.** `agent-<id>-kill.txt` per agent and `bot-kill.txt`, written and
  removed only by the page's kill message. `welcome` carries `killed`; the page's `agent` rows and `bot` carry `killedAt`; the Board
  and the agent's desk say "kill switch on since <time>".
- **C6: the Accounts tab after ChartBridge drops** keeps the last rows dimmed and marked "as of hh:mm:ss ET (not connected)", Conn
  unknown, and the Accounts, Positions and Working orders footers say so. Group, Account type and Limits stay, "not known (not
  connected)".
- **C7 (Anthony's decision): the flat time with the data feed down.** No trade because NinjaTrader's data feed is down, with the
  account Connected and the market open by the calendar: the flatten goes anyway and the pages are told why. The feed up and no trade
  is a real halt, as before.
- **C8: nothing ends a trade while the account is not Connected** (the ghost-trade end, the drop against the other side, the owner
  lock's release); once Connected again it must stay so for 3 s before they look.
- **C9 (Anthony's decision): the copier's leader** counts as gone only after about 10 s not Connected, and stood down by that the
  copier re-arms by itself once the leader is back and every follower matches its position, with a status line each time.
- **C10: a late flatten names the real time** ("flattened at 16:40 by its rules (its 15:55 flat time passed while ChartBridge was not
  running or not watching)").
- An account on None is "account - (None)" in the Output window and the logs, never "(LIVE)".
- `nt8/update-pc.ps1` (the ops audit): a git that times out is ended with the programs it started (taskkill /T, as
  `botlab_update.ps1`), and a stale lock on `refs/remotes/origin/main` or `packed-refs` (older than 10 minutes) is removed before the
  fetch, so one ended fetch no longer means `fetch_failed` for good.
- **The independent review's fixes.** HIGH 1: a branch whose account is not known yet (not listed by NinjaTrader, not Connected,
  or Connected under 30 s) is never put on None by the daily reset, caught up or in the break; it keeps its account and stays
  pending in `daily-reset.txt` until it is known. MED 2: a day `.bak` of another session is never merged. MED 3: an agent's
  account and rules, `agent-standdowns.txt` and `groups.txt` never take their `.bak` on their own: they stand down as in 0.6.2
  and the alarm says what the copy holds and how to use it (`daily-reset.txt` and `account-marks.txt` still fall back on their
  own). MED 4: only the flat time's job closes with the data feed down. MED 5: a file missing after a cut-off replace with a
  `.bak` or `.tmp` beside it: the same rules. LOW 6: a day file read after a wait keeps what was booked meanwhile. LOW 7: a read
  after a wait never switches an account chosen on the page. LOW 8: NinjaTrader's own trailing room when a high may be missed,
  and the warnings by the group's drawdown type. LOW 9: no trade since the start counts as the feed down. LOW 11: a day file
  repair keeps the good `.bak`. A kill file held open at the start is read again, killed meanwhile.
- **The review's second round.** A page choice (an agent's account, group, league seat or None, the bot's account, the copier's
  leader) always wins over a pending reset; the reset's settle is `SteadyMs` (30 s), as the rest of ChartBridge; a branch whose
  reset is pending takes no new entries ("waiting for the daily reset"), exits, legs and flattens never affected; a retried
  catch-up after a restart still says caught up; the missing-file alarm names the exact files to delete.
- **Going back to ChartBridge 0.6.2** (review LOW 10): 0.6.2 reads the 12-field `account-marks.txt` as a file it does not
  understand and never rewrites it, so its trailing floors and its computed `realizedToday` and `pnlToday` are not given until
  that file is deleted. 0.6.2 ignores `agent-<id>-kill.txt` and `bot-kill.txt`: a kill switch on stays on in the file, so a kill
  released under 0.6.2 comes back on when 0.6.3 starts again (release it on the page then). 0.6.2 reads only the day line of
  `daily-reset.txt` (a pending branch is not tried again by it).
- Tests: harness cases for every finding (BotHarness, GroupsHarness, AgentHarness, CopierHarness), the PowerShell tests for the
  updater, and `smoke:accounts` drops the fake ChartBridge (accounts-9-dropped-1366.png). The harness runs the daily reset only when a
  case calls it (`ChartBridgeBranches.HarnessManual`), never on the test PC's own clock.

## 1.30.0 (2026-10-16): account types from The Desk's ledger, and the Settings cleanup

Page only, no recompile (ChartBridge 0.6.2 as for 1.29.0; `minChartBridge` stays 0.6.2). After 1.29.1. Wave 5 (Anthony 2026-10-16: "a
repository of all the different firms and account types ... when a new account was added, I could just select the account type from a
drop down"). The ledger lives on The Desk; the page reads it and copies a type's rules to ChartBridge only when Anthony applies them.

- **The Desk's list (live/accounts.js `readTypes`).** GET /api/account-types from The Desk's address (`deskBase()`, as the limits),
  with the limits now and every minute. The last good list is kept in this browser (`live-account-types-v1`, every read and write in
  try/catch; the page works without it) and used while The Desk is not reachable, with "the list as of <time> ET" on the Accounts tab
  and in the rules dialog. Money is read in dollars, as GET /api/chart-accounts and The Desk's prop tables. A type is "checked" only
  when The Desk says exactly that; every other type shows "(not checked)" after its name wherever it is offered.
- **Accounts tab: Account type.** A column between Group and Limits (once ChartBridge sends groups and the list is known): "Not set",
  then every type as "<firm> <name>". Choosing one sends PUT /api/accounts/{account}/account-type `{"account_type": id|null}` and shows
  what The Desk says after (a refusal goes to the window's note). Read only while The Desk is not reachable.
- **Apply its rules** (an account in no group with a type) asks first and only then sends the existing accountLimits; the question
  shows each number and how it was worked out. A static type: My floor is the account size less the drawdown. A trailing type (end
  of day or intraday) never sets My floor: ChartBridge does not trail My floor (an account in no group keeps its floor as typed), so
  any fixed floor would go stale after a new high and overstate the room. My floor is sent again exactly as it was, and the question
  says "A trailing floor is tracked only in a group: put this account in a group (a one-account group is fine) so ChartBridge trails
  it from its highest close." My daily: the type's daily loss limit; when the type has none and the account has its own, the question
  says "My daily none (it replaces your $X)".
- **The join question for an intraday group** asks "highest balance so far (intraday)" (end of day: "highest close so far", as
  before). The message is the same `highClose`, which ChartBridge 0.6.2 takes as the start of both its highs.
- A type's "floor stops at" is ignored at or below the starting floor (size less the drawdown) and on a static drawdown, also in this
  browser's copy of the list. Filling from a type with no Type (Evals or Funded) set keeps the group's own Type, and that is not a
  difference. The Account type column is narrow at 1366 x 768 (names cut, whole in the tooltip) so the Room keeps its width; a picked
  type stays shown until The Desk's rows are read again.
- **Settings, Account groups, the rules dialog.** An Account type select at the top fills every rule box (size, daily loss, drawdown
  and its type, floor stops at, target, consistency) and the group's Type (Evals, Funded, not set) from the type; the name is never
  touched (Anthony names his groups). Any box can still be changed; Save sends groupSave as before, so the rules are on the PC. A type
  missing a value a group needs says so.
- **The group's link to its type.** Kept in this browser (`live-group-types-v1`, keyed by group id: the type's id, its version and
  name). groups.txt cannot carry it without a ChartBridge change: ChartBridge 0.6.2's groupSave refuses any key it does not know. A new
  group's link is kept once ChartBridge answers with its id; a deleted group's link goes with it.
- **Warnings, never blocks.** A group whose rules differ from its type's current values (a new version on The Desk, or a box changed
  by hand) shows "rules differ from <type>: Update" in Settings; Update refills the dialog from the type and puts Save in focus. A member
  account whose own type is not the group's is named under the group in Settings, and on the Accounts tab with a warning row under
  it and its dropdown marked. Nothing is refused anywhere.
- Tests: `test/account-types.test.js` (the list read clean, "(not checked)", the fill, the differ check, Apply's numbers (a trailing
  type never sets My floor, static, what My floor and My daily replace, an account gone sends nothing), the copy and
  the links with storage blocked, the member warning, the chart-accounts rows, the wiring, and the fake Desk against the contract);
  `test/fake-desk.mjs` answers the spec's account-type routes; `smoke:settings` adds the whole flow at 1366 x 768 against the fake Desk
  (screenshots `settings-types-accounts-tab.png`, `settings-group-type-filled.png`, `settings-types-differ.png`).
- **The Settings cleanup.** Every section is collapsible from its header row (the heading as before, the whole row a button with a
  small caret; no motion: a section opens and closes at once): Charts, Hotkeys, Order Strategies, Entry types, Large prints, The
  Desk, ChartBridge PIN, Layout and Account groups. Open or closed is remembered per section in this browser
  (`live-settings-sections-v1`, try/catch; another window's change is followed), and Collapse all / Expand all sits in the first
  header row (Charts), with no row of its own. The order, most used first: the first column what is changed while trading (Charts,
  Hotkeys); the second Order Strategies and Entry types, then what is set once (Large prints, The Desk, the PIN, Layout); the Account
  groups keep their own column. Every section starts open, as before. Settings is placed again whenever a section opens or closes,
  another window changes them, or the groups column comes or goes, so in its fullest form (ChartBridge v3 with The Desk and the
  groups) it sits under the gear at 1366 x 768 and never covers the top bar (1.29 placed it before the groups column showed, over
  the top bar), with no scroll, open, partly closed or all closed. Nothing else changes in look.
- Tests: `test/workspace.test.js` (the kept state, junk and defaults, the label, the order and the wiring); `smoke:settings` adds the
  sections at 1366 x 768 (screenshots `settings-sections-open-default-1366.png`, `settings-sections-charts-closed-1366.png`,
  `settings-sections-closed-1366.png`, `settings-sections-open-1366.png`).

## 1.29.1 (2026-10-16): one missed PC helper poll no longer flips the Agent tab

Page only, no recompile (ChartBridge 0.6.2 as for 1.29.0; `minChartBridge` stays 0.6.2). After 1.29.0 (#51).

- **The missed-poll grace (live/agent-helper.js `pollStep`).** On the laptop install (page 1.29.0, ChartBridge 0.6.2, the Bot-Lab
  PC helper on 127.0.0.1:8767), about once a minute while an agent was On the Agent tab flipped for one poll to Build `-`, On and
  Off greyed, Session and Overall `-` and "The PC helper is not running on this PC", then came back on the next poll, while the
  helper stayed up and answered every /status. Any one failed GET /status (the 4 s timeout, a network error, or an HTTP status the
  client reads as down, a 500 too) set the reach to down. Now one miss right after a good answer keeps that answer (the build,
  On or Off, the spend, the line) for one poll, as long as that answer arrived at most 8 s before the miss; the second miss in a row is down and
  says "not running" as before. The 8 s covers the worst single miss (3 s poll plus the 4 s timeout after a good answer); a helper
  really gone (connection refused at once) says not running on the second poll, about 6 s after its last answer, and an answer
  that arrived more than 8 s before the miss (the tab was hidden, polls stopped) is never kept. 401 (the PIN), 403 (refused), 400 and 409 and every good
  answer are taken as they come, exactly as before, and end the grace.
- **Nothing starts on an old answer.** In the grace the Agent card's header label says "PC helper slow" (the existing label,
  short enough for its one line, no new colour) while the last answer stays on screen, On is held (greyed) and does nothing if pressed, the
  board's Start in Shadow is held, and Assign hero (and its Continue and pick) sends nothing and says the helper is slow. Off stays
  as the last good answer allows: it ends only the agent shown, his position comes from ChartBridge (not the helper), and the
  helper itself answers it (a failed Off says so, as before). The On/Off job flow (Shadow, Flatten, Off) is unchanged.
- Tests: `test/agent-helper.test.js` (one miss keeps the answer, a 500 and a 200 with no agents are misses, two in a row are down,
  an old answer is never kept, recovery, 401, 403, 400 and 409 unchanged, Assign refused while slow, the wiring);
  `smoke:onoff` adds one 500 (the tab holds at every 100 ms sample, the slow note shows, On is held) and two in a row (not
  running, then back), with the fake helper's new `setFail(n)`; screenshot `agent-onoff-slow.png`.

## ChartBridge 0.6.2 and chart 1.29.0 (2026-10-16): group stand-downs, Clear stand-down, and league seats

SPEC CE-2, Phase 4 pieces 5 and 4 (DECISIONS 2026-10-15i, 15j, 15k, 16m). **It needs the recompile: the page needs ChartBridge 0.6.2**
(`minChartBridge` raised to 0.6.2); a PC on an older ChartBridge keeps the page it has, and the PC updater waits. Order-path change
(Anthony approved order-path edits for Phase 4): new entries can now be refused by a stand-down and by a league seat's Sim check; nothing
else changes, and exits are never gated.

- **Group stand-downs (ChartBridge 0.6.2).** The runner sends `standDown {group, kind, why}` on the agent channel (raise only; the agent
  has no clear). ChartBridge keeps it in `agent-standdowns.txt` (written only by ChartBridge; survives restarts and the 18:00 roll; a
  deleted group's lines go with it) and refuses every new entry from that build on that group: the whole plan at check 2 for a group,
  the one seat for an account inside the group, and again per seat under `PlaceLock`. Raising it cancels that build's unfilled entries
  there and expires its open proposals; positions keep their stop and target; Flatten, the agent's flatten, protect, the legs, flatAt
  and the stop placed again always go. A file that cannot be read is never written over and (Anthony 2026-10-16) refuses agent entries only on accounts in a prop
  group: accounts in no group (a Sim league seat, a personal account) keep trading and exits always go; with `groups.txt` unreadable
  too, accounts that are not Sim are refused and Sim accounts allowed. The pages still get the reason and the alarm.
  `agentState.groupStandDown` to the runner; `agent.standDowns` and `agentStandDowns` (every stand-down, a hero not connected too) to
  the pages.
- Fix round 1: `agentHello` refuses a build with a space at either end (a build cut on the space before its stamp) and a
  second hello with another build on the same connection; a missing `groups.txt` keeps every stand-down (the file is not rewritten);
  at most 200 stand-downs for a group ChartBridge cannot find (groups.txt unreadable; a raise for a known group is always taken),
  refused, logged and alarmed once per build and group; a repeat raise logged once per build and group.
- **The group's Type for the runner.** The agent's `welcome.group` is `{id, name, accountType}` (`eval`, `funded`, or null) and
  `agentState` gains `groupType` (the same value), so a Type changed in Settings reaches the runner without a reconnect.
  `accountState` gains `accountType` (after `noHedge`; the account's group Type, null when not set or not prop), so a hero on one
  account inside a prop group knows it too.
- **Clear stand-down (chart 1.29.0).** The Board shows each stand-down as an amber row under its hero (the group, the kind and why,
  since when) with Clear stand-down: one click sends `agentStandDownClear {cid, build, group}` (signed-in v3 pages only, gate 7),
  which ChartBridge logs "cleared on the page".
- **League seats.** `agentAccount {account, league: true}` makes the agent a league seat on one Sim account (never a group, never None);
  ChartBridge reads Sim fresh at `agentAccount`, at plan check 2 and per placement under `PlaceLock` (an unknown provider is no Sim:
  "agent <id> is a league seat: Sim accounts only"). Saved as `league<TAB><account>` (a ChartBridge before 0.6.2 stands the agent down
  on it). `welcome` and `agent` carry `league`. It starts in Shadow and goes to None at the 17:00 reset like every agent. The Agent
  tab's picker lists a league seat on each account (a LIVE one with the reason, never offered); the Board shows PROVING n of 100 from
  the PC helper's `liveN`.
- PROTOCOL.md "Group stand-downs and league seats (0.6.2)". Tests: AgentHarness (raise and refuse, one account inside the group, other
  builds and accounts unaffected, exits, raise mid fan-out, proposals expired, restart, the roll, a deleted group, unreadable and
  unwritable files, the agent cannot clear, the page clear and gate 7, league at agentAccount, check 2 and placement, the old reader),
  GroupsHarness (the delete hook; page orders never gated), test/standdown.test.js, and the board smoke's league and stand-down rows.

## ChartBridge 0.6.1 and chart 1.28.0 (2026-10-16): a group's default hero, and the heroes-on-duty board

SPEC CE-1, Phase 4 pieces 3 and 2 (DECISION 2026-10-15k). **It needs the recompile: the page needs ChartBridge 0.6.1**
(`minChartBridge` raised to 0.6.1); a PC on an older ChartBridge keeps the page it has, and the PC updater waits. Nothing new in
the order path: no new trading restriction, and single-account and group trading work exactly as in 0.6.0.

- **A group's Type and default hero (ChartBridge 0.6.1).** `groups.txt` gains two fields after `consistency`: the Type (`eval`,
  `funded`, `-`) and the default hero (a build name, `-` for none); a 0.6.0 line reads as not set and none, and a 0.5.8 or 0.6.0
  ChartBridge keeps the two fields as read. `groupSave` takes them as `accountType` (the message's `type` is its kind) and `hero`,
  both optional (absent keeps them, `-` clears), shapes only; the `groups` message carries both. ChartBridge never knows heroes.
- **Settings, Account groups (chart 1.28.0).** The rules dialog has Type (Evals, Funded, Not set) and Hero on duty: None, then every
  hero the PC helper lists with its tier, and a warning beside it when its tier does not fit the Type (shown only; he can pick any).
  Each group's row says its Type and hero. The No hedging switch and Rename keep them.
- **The Agent tab's picker.** For an agent on a group, the build picker preselects the group's default hero (after a build he
  picked or the one he runs; the picker stays) and lists every hero with its fit warning for the group's Type. Tier fit: Not ready
  fits nothing; Acceptable fits Evals (guidance: at most 3 evals at once); Good, Great and Exceptional fit both; no tier says "tier
  unknown" with why (no rating on this PC yet, or the PC helper is not answering); no Type: no fit warning ("type not set").
- **The heroes-on-duty board.** The Agent tab's strip has Board (kept in this browser): one row per agent slot that is on or has an
  account or a group (hero name and build, tier chip, the group and the accounts it leads or the one account, mode, position,
  today's R, the room of the tightest seat from ChartBridge's own numbers, its own Kill and Open); KILL ALL AGENTS (the existing
  `agentKill` on to every agent, one click); a NO HERO row per group no agent trades with Assign hero: a free slot (an agent id on
  None and Off) gets the existing `agentAccount {group}` (a LIVE member asked once in the page), then the PC helper's existing
  `POST /on` with the group's default hero, in Shadow (no default hero the helper has: he picks one; no free slot: "add an agent id
  to config.txt", which ChartBridge never writes). The Tron kit's look; nothing on the board moves.
- Fix round 1: a slot seated on a group (or an account) but Off in the helper (it refused On, or the 10 s wait ran out) says
  "Off: not started (nothing trades)" on its row, with Start in Shadow (the helper's POST /on with his build, else the group's
  default hero) and the hint to set None on his desk to free the slot; its group shows No hero on duty meanwhile. Assign hero
  takes a slot whose kill switch is off first (a killed one only when no other is free, and the line says his kill switch is on;
  a Kill is never undone) and asks the free slot again at Continue (nothing is sent when it no longer holds). The room's why comes
  from the tightest seat. The new tests and seeds use made-up SIM-A to SIM-D and Group A, Group B (fake bridge `--board-groups`).
- Fix round 2: Start in Shadow really starts in Shadow. ChartBridge keeps an agent's mode across runner stops, so an agent left
  in Auto is first sent the existing `agentMode` shadow; the helper's `POST /on` goes only once his `agent` message shows Shadow
  (the desk's 10 s wait; not confirmed: nothing is started, with why), as the desk's own On (his mode and sim, so the helper's
  heroes-only check runs). On a group, Start uses the group's default hero when the helper offers it, else his last build.
- Tests: the Mono harness's Type and hero cases (round trip, absent keeps, `-` clears, every refused shape, a 0.6.0 line, fields
  after the hero kept, an unreadable type or hero); test/board.test.js (tier fit, the chips, preselect, the board's rows from fake
  agents and helper rows with and without tiers, Kill all, Assign hero with and without a free slot, groupSave's shapes);
  `npm run smoke:agent-board` (in smoke:agent) and the group editor in smoke:settings, with screenshots.

## ChartBridge 0.6.0 and chart 1.27.0 (2026-10-15): one hero trades a whole prop group from the Agent tab

Anthony's decisions of 2026-10-15 (Phase 4 piece 1, Q1 b, Q2 a, Q3 a). **It needs the recompile: the page needs ChartBridge
0.6.0** (`minChartBridge` raised to 0.6.0); a PC on an older ChartBridge keeps the page it has, and the PC updater waits. Separate
from the copier, which stays exactly as it is. The protocol is in PROTOCOL.md, "Group trading (0.6.0)", shared with Bot-Lab's runner.

- **Seats.** An agent trades one account (exactly as before) or a whole prop group: each member is a seat. ChartBridge keeps
  everything it followed for the one account per seat now: the open trade and its ledger, the roots it owns until flat, the
  flatten jobs, the lost-trade errors and their 0.5.7 hold. `agentAccount` may carry `group` (the group id) in place of
  `account`; `agent-<id>-account.txt` saves `group<TAB><id>` (an older ChartBridge stands the agent down on that line: safe).
  Choosing a group is refused while the agent is exposed, while a member or a seat holds anything on its roots, and when a member
  is the bot's, the copier's leader or a follower, another agent's, Backtest or Playback, or not in NinjaTrader. A member that is
  not tradable or connected now is taken: it sits out each trade until it is.
- **One plan, every seat.** `plan` adds `seatsRev` and `sizes` ("5,3,4" in seat order; 0: the runner found no room for 1
  contract). ChartBridge never resizes: each size is checked against the agent's caps and the hard ceiling, `riskDollars` is the
  sum over the sizes, `qty` the first size that is not 0. Every check runs again under the agent's gate at the moment of placing;
  then seat by seat through the page's own order path (`PlaceAgentEntry`, every v2 gate, the owner lock and the one-direction check
  under `PlaceLock` for each), each in its own try, all with the plan's id. A seat that cannot take it (its size 0, not tradable
  or not connected, a position or order that is not the agent's, the one-direction check) sits that trade out; the plan is
  refused only when no seat can take it. A plan sized for another `seatsRev` is refused whole ("the group changed; size again").
  One answer per seat (`answer.account`) and the plan's own; an entry NinjaTrader rejects is refused on that seat only.
- **The rest per seat.** One direction per group and exits never blocked, unchanged. Kill, heartbeat loss, leaving Auto, a
  withdraw and the expiry cancel unfilled entries on every seat; flatAt runs per (seat, root) with each seat's own close cap; the
  agent's `flatten` may name one seat (`account`), else every seat at once. maxTrades and maxLosses count one per plan: a loss when
  the group's net for that plan is below 0, once every seat closed. The 17:00 reset goes to None only when no seat is exposed and
  every member is idle; otherwise the note names the accounts holding something. A seat that leaves the group, or a deleted group
  (the agent goes to None), while it holds the agent's trade stays owned and protected until flat, and takes no new entry.
- **The clash rules count every seat**: the owner lock, the bot's account, the copier's leader and followers (and the copier's
  Eligible), other agents; an account cannot join a group an agent trades if it is the bot's, the copier's or another agent's.
- **Messages.** `welcome` adds `group`, `seats` and `seatsRev` (up on every membership change, with a fresh welcome and
  accountState); `agentState` adds `seats` for a group; one `accountState` per seat; the snapshot covers every seat. Day file:
  `#seat<TAB><tag><TAB><account>` (a comment to an older ChartBridge), so a restart brings back each seat's trade.
- **The page (1.27.0).** The Agent tab's picker is one list: None, then each group ("Group Lucid: SIM-A, SIM-B, SIM-C"), then
  single accounts; a group with a member that cannot be taken is shown with why, not offered. A group with a LIVE member asks once,
  naming them. His account card shows the seats table for a group (account, SIM or LIVE, position, the last plan's size, P&L, R
  from each seat's own risk, daily room, floor room, why it is not in the trade) and the group's total. The Accounts tab marks each
  seat with its hero's name; the copier's leader picker and follower rows show a seat with the reason. Off on a group in a trade
  works as for one account: Shadow first, then the page's Flatten on every seat holding his trade, then Off once every seat is flat.
- Review fixes: a seat that left the group while holding the trade keeps its accountState until flat; once the agent's socket
  drops, a fan-out places no further seat (checked per seat under `PlaceLock`); a join is checked again under the lock that saves
  the membership.
- Tests: the Mono harness's group cases (fan-out to 3 seats with different sizes; each kind of sit-out; a seat rejected by the
  broker; a partial fill; per-seat flatten; flatAt with the per-seat cap; Kill, heartbeat and leaving Auto; a stale seatsRev;
  join and leave while exposed; a group deleted while exposed; the 17:00 reset; the copier and the bot refusing a seat; restart
  recovery of the seat to tag mapping; maxTrades and maxLosses per plan; copilot and withdraw); every 0.5.8 check unchanged.

## ChartBridge 0.5.8 and chart 1.26.0 (2026-10-15): prop groups (one direction per group) and real account state

Anthony's decisions of 2026-10-14 (items 4 and 5, with G1, G2, G3 and F-ALL). **It needs the recompile: the page needs
ChartBridge 0.5.8** (`minChartBridge` raised to 0.5.8: groups and accountState); a PC on an older ChartBridge keeps the page it
has, and the PC updater waits until ChartBridge 0.5.8 is compiled there. New add-on file `nt8/ChartBridgeGroups.cs` (it never
places an order) and page file `live/groups.js`, both in `install-files.json`. After #47.

- **Groups, made on the page and saved by ChartBridge.** Settings has a third column, Account groups (shown once ChartBridge
  sends groups, so Settings still fits 1366x768 whole): each group as one row with its name, the firm's rules in a line, the No
  hedging switch, Edit, Rename and Delete (an in-page confirm), and New group. Edit and New open the rules dialog of Anthony's
  approved mockup, in the workspace's house style: group name, account size (G1), daily loss limit, drawdown size, drawdown
  type (trails end of day, trails intraday, static), floor stops at (G1, the Lucid-style lock), profit target, No hedging. The
  Accounts tab gets a Group dropdown (None and every group) and a Limits column: putting an account in a group asks once for its
  highest close so far, prefilled with the larger of the account size and its balance (G2 b); an account in no group (a
  personal account) has My floor and My daily. New accounts arrive in None. ChartBridge keeps it all in `groups.txt` (two `#`
  lines, then `group`, `member` and `personal` lines; ids `g1`, `g2`, so a rename never touches membership) and each account's
  highs and day start in `account-marks.txt`; nobody edits a file. No `groups.txt` (every PC today): no groups, exactly 0.5.7.
  A `groups.txt` that cannot be read is never rewritten that run and refuses every new entry, with an alarm, as `accounts.txt`.
  Messages: `groupSave`, `groupDelete`, `accountGroup` (with `highClose`), `accountLimits` from the page; `groups` (each with its
  side and holders) and new `accounts` fields (`group`, `myFloor`, `myDailyLoss`, `floor`, `roomFloor`, `roomDaily`,
  `targetLeft`, `src`, `why`) to it; every 0.5.7 field stays, `pnlToday` included, so a 1.25 page works.
- **One direction for the whole group, every market (G3 a).** While any member holds a long (a position by either reading, or
  a working buy entry, ChartBridge's own just sent included), no member may open a short in any market, and the other way round;
  a mixed group refuses new entries on both sides. Checked by ChartBridge under its order lock (`PlaceLock`) for every entry:
  the order ticket and chart clicks, the bot, every agent (and its plan check 10b), Order Strategies, and each copier follower
  (skipped as "group"). The refusal names the group and the holders as NinjaTrader names the accounts ("Group Lucid is long
  (... +2 MNQ; ... buy limit 1 NQ working): a sell on ... would hedge the group; prop firms ban hedged accounts. Exits and flattens
  still work."). Exits, flattens, stops and targets are never blocked: an account's own order on the other side of its position,
  with no stop, target or strategy, for no more than the position with its exits already working, is an exit. Legs, OCO parts,
  merged legs and an agent's flat and protect orders are no entries. Two entries on opposite sides at the same moment: one
  passes. A group made mixed by an order typed into NinjaTrader (which cannot be refused) raises one status error to the pages,
  and one note when it is one direction again. Per group, the No hedging switch (on by default) turns the check off.
- **Real account state (item 5).** With NinjaTrader's balance and P&L and the group's rules, ChartBridge works out each account's
  floor (end of day: the highest end-of-day equity, raised in the 17:00 to 18:00 ET break and by each session's first reading;
  intraday: the highest equity seen, every second; both stop at "floor stops at"; static: size less drawdown), the room to it
  (NinjaTrader's trailing drawdown when it reports one), the daily room (open P&L counted, from the session's day start) and the
  target left; for a personal account, from its own floor and daily limit. A number it cannot give is null with the reason,
  never estimated. The Accounts tab's room shows them first ("$900.00 daily · $1,700.00 to floor · $2,500.00 to target").
- **The agent's accountState** (for Bot-Lab, which builds its view from it and falls back to its model's numbers when anything
  is missing): `account`, `sim`, `kind` (prop, personal, none), `group`, `groupId`, `groupSide`, `noHedge`, `rules` (the group's,
  with `size` and `lockAt`, or the account's own; inside `rules` 0 says none, never null, the coordinator's note from the
  Bot-Lab side), the eight numbers with `src` and `why`, `session`, `at`. Sent right after the snapshot on every `agentHello`,
  then from the 1 s pass when anything but `at` changed, and at once on an account, group or rules change.
- **F-ALL (a)**: the ticket's Flatten all on None does nothing, as built in 0.5.7.
- **Review of #48 (fixed before merge):**
  - A page market exit skipped the group check (the agents' `pageReduces`), so a second Sell Mkt 2 on a long 2 while the first
    still worked could flip the account short beside a member's long. Every order now asks the check; its own exit rule passes
    a true exit and counts the exits already working; one too big is refused, saying to use Flatten or cancel the working exits.
  - An unreadable `groups.txt` refused exits too: the exit rule now comes first, and only entries are refused.
  - A ChartBridge started mid-session took its first reading as the day start, so earlier losses were missed: a day start read
    more than 2 minutes after 18:00 ET takes the smaller of it and NinjaTrader's realized P&L (null, with why, when NinjaTrader
    gives none), which can only understate the daily room. `account-marks.txt` keeps when the day start was read.
  - NinjaTrader's trailing drawdown overrode the computed room: with both, the smaller.
  - Orders on the other side of a position were each taken as an exit when no more than the position: they are summed now, and
    the part past the position counts as an entry.
  - A late first reading raised the end-of-day high to a midday balance: only a reading in the 17:00 to 18:05 ET window does.
  - PROTOCOL says plainly that an OCO pair of entries typed into NinjaTrader is not counted until one fills.
  - Re-review: the exits already working counted protective orders too, so with a lone ChartBridge stop (no target, no OCO id)
    or a stop typed into NinjaTrader on a long 2, Sell Mkt 1 and Sell Mkt 2 were refused. Only plain market or limit exit
    orders with no OCO id count now; stops, targets and ChartBridge's, the agent's and the copier's legs never do.
  - A personal account whose limits Anthony never set sends `accountState.rules` null (the agent keeps its model numbers);
    once My floor or My daily is saved, 0 included, `{floor, dailyLoss}`. The Accounts tab's boxes say "not set" until then.
- **Q-EXIT (b), Anthony 2026-10-15: exits left behind.** Resting exits are still always accepted; when an account in a group with
  No hedging on goes flat on an instrument, ChartBridge cancels the working orders there that were exits of the position just
  closed (the page's and ones typed into NinjaTrader; never its own legs or an ATM's), since they would now open the other side,
  and tells the pages ("SIM-A went flat on MNQ: cancelled the sell limit 2 left from the long, so it cannot open a short"). After a
  start, an order on a flat account against its group's side is cancelled once the same way.
  Re-review: a typed OCO pair left after flat counts (once per OCO id at its largest) and is cancelled; the pass runs at once on
  the position update to flat, not only every second; the after-start look is per account, once it is connected; the note names
  the position just closed and the side the order would open. Re-review 3: a resting reversal whose own fills took the position
  through flat keeps its rest unless the group's other members hold the other side (then it is cancelled with a note). A leftover
  with no fill of its own is cancelled at once; only a reversal's rest and the after-start look wait until flat for 150 ms.
- **CON (a), Anthony 2026-10-15: consistency percent.** Each group's rules get an optional consistency percent (no single day
  over that share of the profit): the rules dialog, `groupSave`, `groups.txt` (an 11th field; older lines read as none), the
  `groups` message and `accountState.rules.consistency` (0 none). Informational only: nothing is blocked or flattened by it.
- **Tests.** `check:orders`: GroupsHarness (the files, the migration, an unreadable file, every refusal, side counting with
  both readings and ChartBridge's just sent, legs and exits, the exit rule, mixed, No hedging off, two opposite entries at once,
  the numbers for end of day, intraday, static and personal, the highs and the day start across a restart), and a group check in
  OrdersHarness's ticket path, AccountsHarness (the new fields, `accountGroup` refused when it would mix), CopierHarness (a
  "group" skip), BotHarness (a bot entry refused), AgentHarness (accountState after the snapshot, on a change, None, plan check
  10b) and IntegrationHarness X14. Node: `groups.test.js`, `accounts-page.test.js`, `nt8-source.test.js` (ChartBridgeGroups.cs
  never places an order; every entry path asks it), `fake-agent` (`accountStateProblem`). `smoke:accounts` section 4 at
  1366x768 (the Group dropdowns, the highest close question, My floor, Settings' groups column, the rules dialog, Delete).
  The review's fixes each have a GroupsHarness check that fails on the code before them.

## ChartBridge 0.5.7 and chart 1.25.0 (2026-10-14): the plan id on agent orders, no TradeLost alarm during a flatten, None in every tab

DECISION 2026-10-14d (phase 2, the plan id) and 2026-10-14e (None in every tab, the daily reset), and the TradeLost hold.
**It needs the recompile: the page needs ChartBridge 0.5.7** (`minChartBridge` raised to 0.5.7: None and planId); a PC on an
older ChartBridge keeps the page it has, and the PC updater waits until ChartBridge 0.5.7 is compiled there. After #46.

- **The plan id on an agent's orders** (DECISION 2026-10-14d: "R per trade: matched from the fill to its plan ... Phase 2:
  ChartBridge sends the plan id with each agent order so R is exact"). ChartBridge notes each entry's plan id for its tag
  before the order exists, and a v3 page's `order` message for the agent's entry, its legs and its flat close carries
  `planId` (`ChartBridgeAccounts.ForPage`, next to `by`); the agent's own `order` is unchanged. The day file keeps it as
  `#tagplan<TAB><tag><TAB><id>` for today's trades, working entries and carried trades: it starts with `#` because a
  ChartBridge before 0.5.7 stands an agent down for any line it does not know and skips comments; a malformed one is skipped.
  The Agent tab takes the plan of that id (placed or proposed only: a refused plan may repeat an id) and falls back to the
  matching by root, side, kind, size, price and ticks; R still from the plan's own `riskDollars`. `smoke:agent-l5` adds a
  trade where a lookalike plan a cent off leaves the matching "not reported" and planId gives +2.00 R.
- **No TradeLost alarm while ChartBridge's own flatten runs on that root.** The lost-trade error ("its legs are gone") is
  held while any flatten job of that agent is on that root (its own cancels take the legs away): logged, not sent, not
  repeated, never dropped. Once no job runs there it is raised (then every 60 s, as before) if the pair is still not flat,
  and forgotten if it is. The bot has no such alarm or flatten job of its own (its flatten is NinjaTrader's, already kept
  apart from the missing-stop alarm).
- **None in every tab** (DECISION 2026-10-14e: every branch offers None, and None means nothing trades). The order ticket's
  picker offers None first and has no Sim101 fallback (`LivePrefs.orderAccount`): on None nothing is sent ("No account
  (None): nothing was sent. Pick an account to trade.") and Armed stays off. The Bot and Agent tabs' pickers offer None and
  show it; `botAccount` and `agentAccount` take `"account": null`, refused only while that branch has a position or a working
  entry. No `bot-account.txt` or `agent-<id>-account.txt` is None (until 0.5.6 Sim101; this PC's bot and agents with no
  account file start on None after the update); None is saved as `account<TAB>-`, which a ChartBridge before 0.5.7 reads as
  an account NinjaTrader does not have, so nothing breaks. On None every new entry is refused with a plain reason; exits,
  flattens and anything open are never blocked; None clashes with nobody. The copier's leader keeps its none; followers have
  none of their own.
- **The daily reset.** Once per day in the 17:00 to 18:00 ET break (New York time, daylight saving included), ChartBridge
  puts the bot, each agent and the copier's leader on None when their account is flat with no working order, the bot and the
  copier whether or not their switch is on (off: in their files), so no branch starts the day on yesterday's account. One
  with a position or a working order is skipped and the pages get a note naming it (also on sign-in in that break). The day
  it ran is kept in `daily-reset.txt`, so a restart in the break does not run it again. `ChartBridgeBranches.KeepThroughReset`
  is the one place an exception would go (a hero on Sim101, still to decide); for now there is none. The ticket's account is
  each page's own, so the workspace applies the same rule to it (`LivePrefs.ticketReset`, each pick stamped in
  `live-account-at-v1`; a page closed through the break does it at its next load).
- **Review of #47 (fixed before merge):**
  - The ticket's daily reset waited 3 s after trading came on, not for ChartBridge's snapshot: on a slow reconnect it could
    put the ticket on None while its account held a position. It now waits for the sign-in snapshot of orders and positions
    (ChartBridge 0.5.7's `orders` list says how many `position` messages follow it: `positions`), never a timer, and never
    resets while that account has a position or a working order. On None the ticket's Flatten all sends nothing and says to
    pick an account, as every ticket action (whether it should cover every trade account then is Anthony's to decide).
  - The bot's None from the page and its daily reset take the bot's PlaceGate (as the agent's do), in Place's lock order.
  - The lost-trade hold is only for a flatten job that owns the pair (one that does not never says NOT FLAT) and lasts 30 s
    at most; then the error is raised and repeats every 60 s as before.
  - An agent's None from the page is refused while its account holds any position or working order (a trade it lost
    included), the daily reset's own rule, so a lost-trade error can never repeat naming no account.
- **Tests.** `check:orders` (AgentHarness: planId on the page's orders and through a restart, the day file with and without
  `#tagplan`, the TradeLost hold ending flat and not flat, None for agents, the reset on and off; BotHarness: None, the file,
  the reset in EDT and EST, once per day, a restart in the break; CopierHarness: the leader's reset). Unit tests for the
  pickers, the ticket and `ticketReset`; the fake bridge follows (`--bot-account`, `--agent-accounts`); the smokes that trade
  from the ticket pick Sim101 first (`smoke-pin.mjs` `ticketOnSim101`), and `smoke:orders`, `smoke:bot`, `smoke:agent` and
  `smoke:agent-parity` check None. `test/agent-parity.json`: two of its test references renamed, its 128 items unchanged.

## ChartBridge 0.5.6 and chart 1.24.0 (2026-10-14): feed delay split, PC clock against real data delay

Build list #77, Anthony's spec: "1) ChartBridge checks this PC's clock against an internet time server every few minutes,
and the header splits the number: 'feed 2435 ms = clock +2310 ms, real 125 ms', plus a 'PC clock off by N s' warning. 2) The
amber or red warning only for a real data delay (for example ship Wi-Fi)." The feed delay is ChartBridge's receipt of a trade
(`rx`, this PC's clock) minus the exchange's time on it (`u`), so a PC clock that runs ahead read as late data (2026-10-12:
the laptop showed "feed 2435 ms", and 122 ms after a Windows time sync). **The split needs ChartBridge 0.5.6 (a recompile,
update-pc stages it); the page works with ChartBridge 0.5.2 to 0.5.5 exactly as before** (`minChartBridge` stays 0.5.2).

- **ChartBridge 0.5.6: the time check** (`ChartBridgeClock`, in `ChartBridge.cs`; no new file, no new dependency). Every 5
  minutes (the first 3 s after a start) one SNTP question (UDP port 123) to `config.txt`'s `timeServer`, default
  `time.windows.com` (the server Windows time sync uses; `timeServer = off` turns it off), on a background thread of its own,
  never NinjaTrader's or the thread pool's (the name lookup is synchronous on it); the answer gets 2 s, and a fault in a
  check is said in the Output window and never ends the thread. Offset = ((t1 - t0) + (t2 - t3)) / 2,
  the server's time minus this PC's, timed on the clock `rx` is stamped with; an answer that is not a server's, turns the
  question down, comes from a server whose own clock is not set, does not echo the question, or does not add up, is no answer.
  **It only measures: it never sets the clock and never changes a setting** (a test checks no add-on file can). No answer
  (offline, a firewall): the last answer is kept for 30 minutes, then the state is "not checked" with why; nothing else changes.
  When ChartBridge follows a step of the PC clock (a Windows time sync), the offset held moves with it at once and a step over
  250 ms is checked again at once, so the split never shows the old clock for 5 minutes.
- **What it tells:** `pcClock` in `hello` and the new `pcClock` message to every page (in the order lane; a page may get one before its hello, which then carries the state as it is):
  `{checked: true, offsetMs, rttMs, atUtcMs, server}` or `{checked: false, why, server}`; `/diag` `pcClock` adds the counters
  (`clockOffsetMs` stays what it was: ChartBridge's own clock against the PC's). The Output window says when the first check
  answers or not, when that changes, and when the clock goes 0.5 s off or back; never one line per check.
- **The workspace's top bar** (chart 1.24.0): with an answer, "feed 2435 ms = clock +2310 ms, real 125 ms" (the parts rounded
  first, so they add up; the PC ahead is +), and "PC clock off by 2.3 s" in amber, right after it, from 0.5 s off either way.
  The feed is **amber from 1 s and red from 3 s of real delay, never for the clock's part**, and only once the clock is checked
  (unchecked, a late number may be the clock's). Where the top bar has no room for the split beside everything else (1366 x
  768), the line says "125 ms real" and the tooltip has the split; while the warning shows and the line is still cut, the
  frame rate, then the local delay's p95, then the local delay give way, never the warning. Every control of the top bar
  (KEYS, Flatten all, Colors, Layout, + Add panel, the gear) now keeps its full size; only a note, the update notice and the
  status line give way, the line last, cut rather than push Flatten all out of the window (`smoke:workspace` checks the bar
  never overflows at 1366 x 768, 1600 x 900 and 1920 x 1080, with and without the warning and with a long note). The tooltip says what was checked, by which server,
  when, and the round trip, each instrument's split, and with the warning how Windows fixes it (Settings, Time and language,
  Date and time, Sync now). No answer: the feed as before ("(PC clock behind)" below 0 included) and the tooltip says "PC clock
  not checked: why". No `pcClock` (ChartBridge before 0.5.6): exactly as before. A mounted chart's own status line (not shown in the
  workspace) splits the feed and colours it the same way, with the clock in its tooltip; the warning is the top bar's
  (`LivePrefs.feedText`, `feedShort`, `feedLevel`, `clockWarn`, `clockNote`, new in `live/live.js`).
- Tests: `npm run check:orders` (ClockHarness, new: the NTP time stamps and the 2036 era, the formula and its sign, every
  answer that is none, a time server of its own on 127.0.0.1 that answers and one that never does, what the pages and the
  Output window are told, the answer held through failed checks, a PC clock step, `timeServer = off`; 45 checks),
  `test/nt8-source.test.js` (measures only, its own thread, the hooks), `test/feed-clock.test.js` (new: the split, the sign,
  the thresholds, no clock), `npm run smoke:workspace` (a fake ChartBridge 0.5.6 with its PC clock 2.31 s ahead: the split at
  1920 x 1080, "real" at 1366 x 768 with Flatten all in the window, amber and red by the real delay, no answer; the fake with
  no `pcClock` as before) and `npm run smoke:live` (the chart's own line). The fake bridge's `--pc-clock` and
  `/test/pc-clock`.

## 1.23.1 (2026-10-14): Layout 5 polish

Page only, no recompile (ChartBridge 0.5.2 as for 1.23.0). After 1.23.0 (#43).

- **Change the rules in the Rules card's header** (the review of #43, LOW): at 1366 x 768 the card's lines have about 69 px and
  "more below" covered the button, so it was reached only by scrolling inside the card. It now sits at the right of the card's
  header (the header stays 18 px, so the lines lose no room), in sight at every size. Its `data-parity` hook (LR02), its words
  ("Change the window" when only the window can change), its tooltip, its closed state and its focus rule are unchanged, and it
  still gives way to the form's own Set and Cancel. `smoke:agent-l5` now asks, at 1366 x 768, 1600 x 900 and 1920 x 1080, for
  a floor under the card's lines (66, 116 and 280 px; they are 69, 123 and 303) and for Change the rules in sight without
  scrolling, nothing over it. `smoke:agent-parity`: 128 of 128, `test/agent-parity.json` unchanged.
- **`smoke:workspace`, "no status line under the charts"** failed every day from about 10:40 to 11:30 ET, on every main since
  1.12.0 (6b47065, E2a: a compact chart's status line shows while it carries a note). The fake bridge's sample history is shifted
  to end at the current minute, so its hour of no trading (17:00 to 18:00) lands over the 18:00 session start in that window,
  and the default Range 40 chart rightly notes "Range bars start at 18:53 ET: NinjaTrader sent less tick history than asked".
  The page is right; the check now asks for what E2a meant: no feed, local or fps readout under any chart, and a line only with
  a note.

## 1.23.0 (2026-10-14): the Agent tab's Layout 5 (Tron)

Anthony's decision 2026-10-14a: the Agent tab takes "Layout 5 Tron" as in the approved preview, keeping every piece of
information and every control board F has. Page only, no recompile (ChartBridge 0.5.2 as for 1.21.0). After 1.22.0 (#41).

- **Before it (#42, merged): board F kept as a kit and the parity test.** `live/kits/agent-board-f/` saves board F (chart
  1.21.0, main a90c3c4) so it opens on its own against the fake bridge and can be put back (its README); never installed,
  never loaded by the page. `test/agent-parity.json` lists board F's 128 items (55 in the base state, 73 under a condition)
  and `npm run smoke:agent-parity` asserts each through a `data-parity` hook `live/agent.js` puts on its element (no style
  reads them), plus the rules across the tab (R3, motion, keys, focus, fixed heights, Accept and Reject never covered or
  moved, the messages, the stored choices). It is Layout 5's gate: **128 of 128 hold**, the list unchanged.
- **The look:** panels framed by a thin glowing line with cut corners (drawn behind each panel, so the light and the glow are
  never clipped), a solid near-black ground (the preview's glow and horizon grid behind the panels cost frames under the moving
  light in `perf:agent`, so the grid's canvas draws the horizon floor instead), cyan and white-hot, orange only for his action (his proposal
  waiting, the decision, the beam when a plan arrives). Headers in **Orbitron** (new: 500 and 700, the Latin subset of npm
  `@fontsource/orbitron` 5.2.8, SIL Open Font License in `live/fonts/OFL-orbitron.txt`, in `live/fonts/agent-fonts.css` and
  `nt8/install-files.json`; nothing from the internet), Chakra Petch for buttons, chips, tabs and small labels, IBM Plex Sans
  for body text, JetBrains Mono for numbers. Nothing rezzes in or flickers.
- **The layout** at 1366 x 768, 1600 x 900 and 1920 x 1080, one screen with no page scroll: the strip (his disc and name only,
  connected, mode, account, position, today, Session R, Motion, Pop out), a still line of each step's newest word, the controls
  as four cards on the left, the grid over his chart (about 40 % and 60 %) in the centre, the proposal's slot (its height
  unchanged) and his stream on the right, and the footer's cards (today, trades and losses, his session, his R curve, his
  heat). Narrower than 1100 px and on a phone, board F's stacking rules, kept.
- **The grid** (`live/agent-grid.js`, new, installed): his five steps with today's tracker words and how long ago
  (`AgentCore.stepLines`, `ageText`; a step with nothing yet says nothing; no scores), the decision (his newest plan), and one
  canvas behind them: the steps feed a point-cloud sphere inside identity-disc rings and its lines funnel into the decision;
  an orange beam only for 6 s after an `agentPlan` arrives. At most 30 frames a second and 1.5 device pixels; paused with
  Motion Off, reduced motion, a hidden window or the tab closed. The tab's one frame loop (the lead's ruling):
  `test/agent.test.js` allows `requestAnimationFrame` in that file alone, with the reason.
- **Maximize:** the chart takes the whole centre column by its button, a double click on its head bar (inside the chart a
  double click stays the chart's own) or restores with Escape from inside its panel (no page-wide key handler); a strip of
  Position, Entry, Stop, Target, Open R, Session, Heat and Room from real data, never animated. The controls and the proposal
  keep their places: the kill switch, the mode, Accept and Reject never move and are never covered.
- **His figures from real data only:** Session R, the R curve and open R from his own fills and each plan's own
  `riskDollars` (`AgentCore.entryRisk` finds the plan an entry came from by root, side, kind, size, price and stop and target
  ticks; `tradesR`); heat at his own working stop (`heatNow`); "if accepted" his open proposal's risk. Not known: "not
  reported". The entries' risks are kept for the day (`live-agent-risk-v1`) and each kept fill now carries its order id.
- **Review of 84893d0 (fixed):** ChartBridge's words above Accept and Reject wrapping to a second line ("Under 5 s left: too
  late to accept. Reject still goes.") moved them 8 to 12 px: the card now fills its slot with its foot at the bottom, so the
  words grow upward and Accept and Reject move 0 px (`smoke:agent-l5` checks the last 5 s, "Accept sent." and a long refusal at
  1366 x 768, 1600 x 900, 1920 x 1080 and in the pop-out). R never linked on a real ChartBridge: a fill's `order` is
  NinjaTrader's OrderId, so fills are now linked to his entry through the ledger (`BotCore.botFillLedger` `orderOf`, new) and
  the risks are kept under account, page id and first-seen time (never handed to a new order after NinjaTrader restarts); the
  fakes send a NinjaTrader-style `order` on every `exec` (`ntOrderId`), as ChartBridge does. `entryRisk` needs the entry's
  planned stop ticks (no lookalike). Step ages show nothing while he is not connected; the grid measures only when its canvas
  changes size. The controls column fits at 1366 x 768, 1600 x 900 and 1920 x 1080: the Rules card scrolls inside itself with
  "more below", status and last plan one line each, "Room left" in the account card's head, the now line not shown at 820 px
  high or less.
- **Fixed: on a phone the mode's words collapsed while hidden** (workspace.css's `[hidden] { display: none !important }` won
  over agent.css): they keep their two lines like the account's and the rules' (the parity test now asserts it).
- **Order path unchanged:** no message the page sends changed; Accept, Reject, the kill switch, the mode, the account, the
  rules, On/Off and Flatten-and-off behave and refuse as before, with the same focus and key rules. `live/agent.js` changed
  in its markup and drawing only; `live/agent-core.js` gained pure functions (and `lightState`'s events moved into
  `lightEvents`, unchanged).
- Tests: `npm run smoke:agent-l5` (new, run by `smoke:agent`) and its screenshots `test/out/agent-l5-*.png`; unit tests for the
  new functions, the grid canvas's pace and pauses (a fake clock), the fonts and the wiring; `test/kit.test.js` lists the
  Orbitron faces in `agent-fonts.css`. `docs/AGENT_TAB.md` and `docs/MOTION.md` describe the grid canvas as allowed motion.
## 1.22.0 (2026-10-10): the single chart page removed

Anthony's cut (2026-10-10): the workspace is ChartBridge's only page. **The workspace, and the workspace open in several
windows, work exactly as in 1.21.0**; its smokes run unchanged where they did not drive the single chart page. Page only,
no recompile; no change to ChartBridge or the engine's drawing. The page is kept on the branch
`archive/chart-single-page-2026-10-10` (main at 235a02b).

- **The single chart page is gone**, and with it everything only it used in `live/live.js`: the page boot
  (`data-mount="page"`), its order bar and order connection, its Settings and small menu, its legend and **Aa** toggle,
  the PIN boot, the tab's own account (`live-account-tab-v1`), the settlement readout, `window.liveChart` and
  `window.liveData`. Every chart is a mounted one (`ChartLive.mount`).
- **`live/single.html` is now a stub** that opens the workspace (`./`, a meta refresh and a link; no script). It stays in
  `nt8/install-files.json`, so `nt8/update-pc.ps1` and `nt8/install.ps1` write it over the old page: an old copy on a PC
  (install.ps1 never deletes a file) or a bookmark to `/single.html` opens the workspace instead of a blank page or a 404.
- **`ChartLive.mount`:** `wsUrl` is a string only (a function or a promise of one served The Desk's relay and its
  single-use tickets; the relay is being removed); anything else throws at mount, saying so. `legendToggle`, `legendShown()` and `setLegendShown()`, empty since
  1.16.0, are gone; `data()` gives the chart's data for tests and the console (the page's `window.liveData`).
  `LivePrefs` no longer has the legend key (`live-legend-v1`) or its methods. Markup Studio (`live/markup.js`), the one
  caller that passed a function, passes the same address as a string.
- **The update notice** (`live/update-notice.js`) has only the workspace's place for it (the page's footer spot is gone).
- **The workspace** no longer writes `live-desk-sync-v1` (it told the single chart page the hotkeys were shared); its
  Settings say the hotkeys are "kept in this browser" and no longer mention the page.
- **The workspace draws a moved order where it was dropped until ChartBridge answers** (order path, the F2 check again):
  its ticket redraws the charts after every action, which put a waiting move back at the old price, so a planned stop
  dragged then was measured from there. TradeCore keeps each sent move (until an order message at that price, the order
  finished, a reject with that change's `cid` (a `change` now carries one), or 5 s) and the charts draw it there
  (`movePending`, `setOrders` in the engine). A second workspace window that forwarded the drag keeps the same wait (its
  own order messages or the 5 s end it; a refusal comes back as the note the ticket's window sends). A move refused after
  a planned line was dragged during the wait adds one line saying where that line really is ("Order 123 stays at
  21000.00: its planned stop is 20 ticks from it, at 20995.00 (dropped at 20994.00).").
- **The Agent tab:** "No agents on this ChartBridge (0.5.2 or later)." for any ChartBridge before 0.5.2 (it said 0.5.0;
  0.5.0 and 0.5.1 refuse every account change, which carries `keepMode`), and again for a v3 ChartBridge 0.4.x (1.21.0 told
  it that none is named in config.txt). The tab reads the version for this text only.
- **Tests:** `test/chart-host.html` (one mounted chart with its own toolbar) takes the chart checks the page carried;
  `smoke:orders` drives the workspace's order ticket (the same TradeCore and controls); `smoke:live` runs on the current
  protocol (it ran on ChartBridge 0.2). The fake bridge's `--tickets` (the relay) is gone. Checks of the page's own parts
  went with it: its legend, footer, title wording, the tab's own account, its order bar on one line, its layout at 400 px
  and its Settings; a mounted chart's toolbar is checked at 1920x1080 and up (it wraps at 1366, as before).

## 1.21.0 (2026-10-10): the page needs ChartBridge 0.5.2; the fallbacks for older ones go

Anthony's approved cut C7 (2026-10-10), in one change with `live/COMPAT.json`'s `minChartBridge` raised from 0.3.2 to
**0.5.2**: the PC updater installs this page only on a PC whose compiled ChartBridge is 0.5.2 or newer, so a PC on an older
ChartBridge keeps the page it has instead of getting one it cannot talk to (every PC was sent 0.5.2 on 2026-10-09). Page
only, no recompile.

- **Orders (order path, independent review): no 200-tick bracket cap for a ChartBridge before 0.3.7.** The bracket boxes take
  what ChartBridge takes: no limit unless `config.txt` sets `maxBracketTicks` (as with 0.3.7 and newer since 1.13.0).
  `OrderTicket.bracketCap(maxBracketTicks)` no longer reads the version, and its version helpers (`versionOf`,
  `versionAtLeast`) are gone with it; TradeCore keeps no version.
- **The Agent tab:** `agentAccount` always carries `keepMode` and the LIVE question always names the mode the agent keeps
  (until 1.21.0 an older ChartBridge got no `keepMode` and the question said Shadow). The tab no longer reads ChartBridge's
  version: a v3 ChartBridge with no `agents` line says none is named there. `keepsMode` is gone from
  `live/agent-core.js` (its `parseVersion` and `atLeast` stay for checks above 0.5.2).
- **The delta pane:** every trade carries its side (ChartBridge 0.3.4 and newer), so the page no longer waits to learn whether
  sides come, and the "Delta needs ChartBridge 0.3.4 on this PC" note, its legend line and the Data Box's "This ChartBridge
  sends no trade sides" are gone. The engine's note stays (a host may still set one).
- **Protocol v1 (ChartBridge 0.2):** no read-only page for it any more; comments say so.
- **The fake bridge:** `--v1` (ChartBridge 0.2), `--no-sides` (0.3.3) and `--no-q` (0.3.7) are gone, with their tests and
  smoke sections (the 0.3.3 delta note, the 0.3.6 bracket cap, orders-smoke's v1 page). `npm run smoke:live` is rewritten on
  the current protocol (v2, trade sides, the PIN, trading off), not dropped: the order bar shows with trading off and its
  account picker switches the fills, and the delta pane counts. embed-smoke's string `wsUrl` check runs on the current
  protocol too.
- Still in the page, to go with a later change that moves the fake bridge's defaults to 0.5.2 (most smokes run the fake as
  0.3.4 today): the load without the served window (before 0.3.5), the "needs ChartBridge 0.3.7" notes for 4h, 1D and 1W, the
  0.3.4.1 quote window in the delta count, and the fake's `--pin-off` and `--quote-hours`.

## ChartBridge 0.5.5 (2026-10-10): the retired accounts line goes; one line for any unknown config.txt key

Anthony's approved cuts (2026-10-10, items C1 to C4 of the cut list). ChartBridge only: recompile once (update-pc stages
it); no page change, and every page keeps working with it.

- **The one-time conversion of the `accounts` line is gone** (0.5.1 read the line once, on each PC's first 0.5.1 start, to
  hide the connected accounts it did not name). All three PCs were sent 0.5.2 on 2026-10-09, and any 0.5.1 or later run writes
  `accounts-detail.txt`, after which the conversion never runs again. Accounts follow NinjaTrader as since 0.5.1: an account seen Connected is listed,
  unchecked when new. Nothing can trade that could not before: this code only ever hid accounts, never checked one.
  `accounts-detail.txt` now holds the connected times only (its old `converted` line is skipped and dropped at the next
  save; going back to 0.5.2 finds the file there and converts nothing either).
- **Any config.txt key ChartBridge does not read is said once per load** in the Output window: "config.txt: `<key>` is not
  a ChartBridge setting; the line does nothing". The retired `accounts` and `quoteHours` lines get this line instead of
  their own special notes, and a mistyped key (`tradeAcounts`) is no longer silently ignored. A `maxQty.<ROOT>` value that is
  not a whole number says so (the cap stays the default 1, as before). Every key ChartBridge reads, the v3 off-lines
  included, is still read exactly as before, and `port`, `days`, `tickHours` and `rangeHours` with a value that is not a
  number are still ignored without that line.
- **`notConnectedYet` is gone from each account** in the `accounts` message (always false since 0.5.1; no page ever read it).
- **Stale text fixed:** ChartBridge.cs's header names no version (the version is `ChartBridgeServer.Version`), the install
  notes point at `nt8/install-files.json` instead of naming 4 of the 12 files, and gate 2 is described as the Account page's
  checkmark (with `tradeAccounts` only for `accountChecks = off` and the first start's pre-check), in README and the headers.
- Tests: `npm run check:orders` (the accounts section: the generic line for accounts, quoteHours, a mistyped key and a bad
  maxQty value; no line for any key ChartBridge reads; no conversion on a run without `accounts-detail.txt`), and
  `test/nt8-source.test.js`.

## ChartBridge 0.5.4 and chart 1.20.1 (2026-10-10): the agent's window can change at any time

Anthony (2026-10-10, DECISION ag): "I don't want any restrictions. I will set the time and that's what the rule is ... I do
not want to be locked out of changing the time if I want to during live trading." The window stays inside ChartBridge's
full-session limit (in session order from 18:00, flat at 15:59 at the latest); nothing else narrows it.

- **ChartBridge 0.5.4:** while the agent has a position, a working entry or an open proposal, `agentRules` may change its
  window (`entryFrom`, `entryUntil`, `flatAt`); every other rule (roots, sizes, entry life, trades, losses) still waits until
  it is flat, and is refused with "only its window (entries from, until, flat at) can change now". The new window rules at
  once, as any window does: a flat time already passed, or a start after now, puts him in his flat hours and ChartBridge
  flattens his position by his rules. While his `agent-<id>-rules.txt` cannot be read (the rules in force are then
  placeholder defaults), nothing changes while he is exposed, not even the window; and then a pair he owns on any root
  an agent may trade (NQ, MNQ, ES, MES) counts as exposed, not only the placeholder roots. **Order path: F5 needed** (a
  ChartBridge recompile).
- **The Agent tab (chart 1.20.1, page only):** with ChartBridge 0.5.4 or later the rules button reads "Change the window"
  while he is in a trade or has an entry or a proposal open, and only the three times are open in the form. A window that
  would flatten him now asks first, in the page ("This window puts Demo in his flat hours now ...: ChartBridge flattens his
  position at once, by his rules. Set it?"); Cancel sends nothing. With an older ChartBridge the tab works as before.
- **Already so, unchanged:** a new agent starts on 09:45 to 15:00, flat 15:55 (no rules file), and ChartBridge keeps his
  last window in `agent-<id>-rules.txt`, so it never resets (over restarts and F5 too).
- Tests: the harness (`check:orders`, AgentHarness `WindowAnytime`), the fake (`test/fake-v3.mjs` follows, its hello says
  fake-0.5.4), `test/agent.test.js` and `npm run smoke:agent` (in a trade: Change the window, the question, Cancel, Set).
## 1.20.0 (2026-10-10): On/Off, the spend readout and the hero picker on the Agent tab

Anthony's request (NOTE_HOME_2026-10-08; DECISION 2026-10-09 v and w): an On/Off switch that ends the agent's program so
API spend is $0, the agent of his choice started from the app, the live agent's spend next to it, and heroes by name.
Page only, no recompile. Needs Bot-Lab's PC helper (`manrae/helper.py`, registered at sign-in by
`tools/manrae_helper.ps1`); without it the tab says so and offers no On, and everything else works as 1.19.0.

- **On/Off** (a new Agent section at the top of the left column): On asks the PC helper on `http://localhost:8767` to start
  the agent's runner with the build picked (no window, no agent session); Off asks it to end the runner. Kill and Shadow
  are unchanged: neither stops model calls, Off does.
- **Off in a trade** asks, in the page, for that agent only (showing another agent closes the question): "Flatten and turn
  him off?". Flatten and turn off first puts him in Shadow (ChartBridge then places nothing more for him and cancels his
  unfilled entries; 10 s at most), then sends the page's own Flatten for his account and root (`trade.js` `flattenAgent`,
  the chart's Flatten message; his position and account read again right before it goes; never a default account), then
  Off once ChartBridge says he is flat. Not in Shadow in 10 s, or not flat in 30 s: he stays on (in Shadow) and the line
  says so until the next On or Off. Keep him on sends nothing. The pop-out has no order connection: it says to flatten on
  the main page or in NinjaTrader first.
- **Spend:** this session's and the overall dollars of the live agent only (the runner's own journal of its calls; never
  training or exams), beside On/Off.
- **The picker** (DECISION w): in Copilot, in Auto and on a LIVE account, heroes only; in Shadow on a Sim account, heroes
  and the builds over the Shadow bar (until Anthony sets the bar, every build). While a build that is not a hero runs,
  Copilot, Auto and a LIVE account are closed and say why (the runner and the helper refuse them too). This fails closed:
  without the helper's word the page reads it from his hello (a build that is not a hero says its build id as its name).
  The picker is closed while he runs: Off first.
- **Names** (DECISION v): the header shows the agent's name as his hello says it (a hero's name, "Demo 2"; a build that is
  not a hero shows its build id); the build id and stamp moved from the header to a Build row under Status.
- **Auto-On and the daily cap** (folded under the section): an auto-On time (New York) and a dollar cap a session, kept by
  the helper; a new cap takes effect at his next start.
- Every call to the helper carries this page's PIN unlock; the helper checks it with ChartBridge's `GET /session`. A
  helper that refuses the page (403) says so, with its reason.
- Tests: `test/agent-helper.test.js` (in `npm test`) and `npm run smoke:onoff` against the fake bridge and a fake helper
  (`test/fake-helper.mjs`); `npm run smoke:agent` checks the build in the Build row.
## ChartBridge 0.5.3 (2026-10-10): the agents' MNQ cap of 20 ships with ChartBridge

Anthony's decision (2026-10-10): the agent's MNQ cap of 20 ships, so any PC can run the live agent at the full $270 and nothing is set by
hand. Nothing else in NinjaTrader changes. `nt8/PROTOCOL.md`, "Agent channel", has the rule. ChartBridge only: no page
change, no `config.txt` change; install it with `update-pc.ps1 -InstallChartBridge` and F5 while flat.

| MNQ cap | with no `maxQty.MNQ` line | with a `maxQty.MNQ = N` line |
|---|---|---|
| an agent's entry | **20** (was 1) | **20** (was N) |
| the page, the bot, the copier | 1, as before | N, as before |

An agent's MNQ entry is the smallest of its own rule (Agent tab, default 20), the hard ceiling (20) and this 20.

- **Agents never read `maxQty.MNQ`** (Anthony, 2026-10-10). The line caps the page, the bot and the copier only.
  `ChartBridgeAgents.ShippedConfigCap` (MNQ 20) is used through `ChartBridgeOrders.AgentCap` for agent entries only: gate
  3, plan check 4 and `welcome.rules`. Every other root for agents is as before (`config.txt`'s cap, 1 with no line).
- **Nothing writes `config.txt`.** ChartBridge, the installer and the updater leave it alone. With agents on and a
  `maxQty.MNQ` line, ChartBridge says once at start in the Output window: "config.txt: maxQty.MNQ = 2 caps the page's, the
  bot's and the copier's MNQ orders only; agents use their own MNQ cap of 20 (with the agent's rule and the hard ceiling)".
- **A page exit from an agent's position** (review). Anthony can cut an agent's MNQ from the page with no `maxQty.MNQ`
  line: a market order that only reduces it (no bracket, at most the position) skips gate 3's per-order qty check, and
  gate 3's position count (position plus working orders on that side plus this order) is held to the agent's cap (20),
  not the page's 1. Every other gate stays. Re-review: the exit plus the page's exits still working on that side (orders
  that are no stop or target) may close at most the position, read again at gate 3, so two quick exits never flip it.

  | agent long 20 MNQ, page cap 1 | result | why |
  |---|---|---|
  | page market sell 5 | placed | an exit: no per-order qty check; count 5 of 20 |
  | a second sell of 16 while the 5 still works | refused | 5 working plus 16 would close 21 of 20 |
  | agent long 5: sell 5, then 5 again before the first fills | second refused | 10 of 5 would flip it |
  | agent long 5: sell 3, then 2 | both placed | 5 of 5 |
  | agent long 5: sell 3, then 3 | second refused | 6 of 5 |
  | page market sell 25 | refused, never trimmed | more than the position is no exit: the owner lock ("use Flatten, or move its stop or target") |
  | page buy 1 | refused | an add is never an exit: the owner lock, before gate 3 |

- **Refusals name the cap that applied** (review). Gate 3 and plan check 4 never say `maxQty.MNQ in config.txt` for an
  agent: they say "agent manrae's maxQty for MNQ" when its Agent tab rule is below the hard ceiling, else "the hard ceiling
  of 20 for MNQ" (`ChartBridgeAgents.CapWords`). `maxQty.<ROOT> in config.txt` stays for a root with no shipped cap whose
  line is lower, and for the page.
- Tests: `nt8/check/AgentHarness.cs` (a 20 MNQ agent entry with no line; the page sells 5 of it, a second exit past the
  position, 25 and a buy refused; on a long 5: 5 and 5, 3 and 2, 3 and 3; gate 3's and check 4's words; with a line of 5 the agent placed at 6 and refused
  only above 20 or its own rule, the page refused above 5; the note), `test/nt8-agents.test.js` (the source guards), and
  the fake follows (`test/fake-v3.mjs`, `test/fake-v3.test.js`).

## 1.19.1 (2026-10-10): quality round 1

A small fix found by clicking every control of the workspace against the fake bridge (Anthony 2026-10-09: "Make sure every
button works"). Page only, no recompile. Nothing that decides, sizes, sends, changes or cancels an order changes: the fix is
in how Settings saves The Desk's hotkeys document.

- **Two changes to The Desk's hotkeys in a row are both saved.** The hotkeys document is saved whole with the rev last
  read, so a second change made before the first was saved (Limit then Stop in Entry types, or two keys set quickly) went
  with the old rev; The Desk refused it as if another PC had saved first ("Not saved: another PC saved the hotkeys first"),
  and that change was lost. The saves now go one at a time, each built from the document the save before it left, and each
  is checked again then.
- Tests: `npm run smoke:quality` (`test/quality-smoke.mjs`: Limit then Stop, and Buy MKT's key then Sell MKT's key, each
  twice, with The Desk's saves slowed to 400 ms as from another PC; it fails on 1.19.0 and passes here).

## 1.19.0 (2026-10-08): Kit version 1

A shared look for Anthony's trading apps, as Anthony approved it on 2026-10-08 (`docs/KIT.md`). It is added alongside the
pages: **no existing page uses it yet, so no page changes behaviour.** Each screen moves onto the kit in its own release.
Page only, no recompile; no change to the engine's drawing or to ChartBridge.

- **The look and the tokens** (`live/kit.css`, `live/kit.js`, which sets `window.ChartKit`): every colour as a CSS custom
  property and in `ChartKit.TOKENS`, the chart's locked money, candle and purple colours included; three surfaces
  (`.kit-trading`, dim grey-blue so the candles stay brightest; `.kit-desk`, cyan; `.kit-agent`, the fuller glow); panels,
  cards, buttons, chips, tags, pills, tabs, the segmented switch, the side rail, meters, fields, the step tracker, stream
  rows and the decision drawer; the soft, faded purple armed outline. Every text colour is 4.5:1 or better on every
  surface. Nothing that shows a number, a price, P&L or a button moves, and nor does anything holding one (R3): the
  decision drawer appears at once. No explanatory labelling on a product screen.
- **The fonts** (Anthony's hybrid): Chakra Petch for titles, labels, chips, tags, tabs and buttons; IBM Plex Sans for body
  text, text fields and selects; JetBrains Mono for every number and numeric field. All from `live/fonts`, the same files
  as the Agent tab (`agent-fonts.css` and `plex.css`); nothing from the internet. Only the header comment of
  `agent-fonts.css` changes, to name the pages that load it; the font files are unchanged.
- **The light rules** (`ChartKit.light`): a slow comet around a panel's border with a soft glow, pure CSS. Outside the
  Agent tab it runs only while in a trade (the page says so) and only around the panel showing that trade: lighting one
  trade panel turns off any other. Never on the order ticket, order lines, Flatten, the copier, or anything marked
  `data-no-light` or `data-no-motion`. Only the light's colour and glow fade. `ChartKit.setMotion` follows Settings' Less
  motion (it sets `ChartMotion.setReducedMotion` when the motion kit is loaded) and the system's reduced motion.
- **The gallery** (`live/kit.html`): every token with its contrast, the fonts, every component in every state, the three
  surfaces side by side, the armed outline, the light in each colour (one trade panel lit at a time) and its refusal on a
  mock ticket. Sample data only: Sim101 and made-up names.
- The kit files and fonts are in `nt8/install-files.json`, so the PC updater ships them. Tests: `test/kit.test.js` (in
  `npm test`) and `npm run smoke:kit`.

## ChartBridge 0.5.2 and chart 1.18.1 (2026-10-08): a full-session agent window; an account change keeps the mode

Anthony's rulings (2026-10-08): Manrae may trade any time after the 18:00 New York reopen, until his last entry at 15:25, and
ChartBridge flattens him at 15:55. No locks by account, account type or account name: the window and the mode are Anthony's
settings, on the Agent tab. `nt8/PROTOCOL.md`, "Agent channel", has the rules.

- **The window in session time.** The agent's `entryFrom`, `entryUntil` and `flatAt` are read in session order, minutes since
  the 18:00 open (18:00 is 0, midnight 360, 17:00 1380). 18:00 to 15:25, flat 15:55 is allowed, and so is the old 09:45 to
  15:00, flat 15:55 (still the default with no rules file). A window the wrong way round (15:30 to 09:00) is refused, saying
  so; `flatAt` stays at 15:59 at the latest. The 09:30 floor is gone.
- **Across midnight.** Entries, the proposals' lives, the timers that cancel unfilled entries at `entryUntil`, the flat hours
  and the flatten's words all use session time: a position held from 22:00 past midnight stays, and is flattened at 15:55.
  The day's counters, stand-down and plan ids still start over at 18:00.
- **Never into a closed market.** No agent entry while the market is closed: the 17:00 to 18:00 break, Friday 17:00 to Sunday
  18:00, a CME holiday, and after the 13:00 halt on an NYSE holiday or the 13:15 halt on an early close (ChartBridge's own
  CME calendar). A position still held then is flattened at the next open: the flatten sends nothing at all while the
  market is closed, the calendar's holidays and halts included (no cancel, no market close into a halted market, even with
  trades still printing; its stop and target stay), and goes on at the open.
- **A position from an earlier session.** After a restart past 18:00, an agent position whose trade began in the session
  before (its 15:55 flatten did not finish) is flattened at once by its rules, even inside an 18:00 window; never into a
  closed market. The day file keeps such a trade as a `carried` line until the agent is flat, so a roll at 18:00 while
  ChartBridge runs, then a restart, still flattens it. Only that trade's position is flattened: a fresh trade of the new
  session never is, even before the line is cleared (it clears when a plan finds the agent flat, or on the next pass). Going back to 0.5.1 with that line in the file: 0.5.1 cannot read
  the file and never rewrites it, so it takes no entries for that agent on every run until the file is deleted or 0.5.2 is
  back.
- **An account change keeps the mode** (until 0.5.1 the agent went to Shadow). The page asks once before a LIVE account,
  naming the mode: "Agent manrae will trade LIVE account EVAL-A in Auto. Continue?"; the Bot tab's question names the bot's
  mode the same way. Not confirmed, nothing changes. ChartBridge keeps the mode only when `agentAccount` carries `keepMode`,
  the mode the page's question named, and the agent is still in it; a page without `keepMode` (1.18.0 and older, whose
  question says Shadow) or a mode changed meanwhile by another page puts the agent in Shadow, as before. The rest is as it was: never the bot's, the copier's or another agent's
  account, the owner lock, and no change while the agent has a position, a working entry or a proposal.
- **The page (chart 1.18.1).** The Agent tab checks the rules the same way before sending, its session trail runs across
  midnight (an hour mark every 3 hours on a long session), and it sends `keepMode` only to ChartBridge 0.5.2 or later (0.5.1
  refuses a key it does not know); to an older ChartBridge its LIVE question says the agent goes to Shadow, and after
  sending it says which. The LIVE question keeps the mode it named when it opened; if another page changes the agent's
  mode while it is open, it closes with a note, nothing is sent, and Set asks again. A rules file
  with an 18:00 window is refused by ChartBridge 0.5.1 and older (no entries for that agent until its rules are set again):
  update ChartBridge before setting one.

## 1.18.0 (2026-10-08): the Account tab's Hide and Show; the ticket and ChartBridge 0.5.1's re-sent orders

The page side of ChartBridge 0.5.1 (below). Page only, no recompile; with an older ChartBridge everything works as 1.17.0.

- **Hide and Show on the Account tab.** Each account ChartBridge says may be hidden (flat, no working orders, not the bot's,
  the copier's or an agent's) has a Hide button, Gone or not; it asks on the page first ("Hide EVAL-B? It leaves every list
  until you Show it; its history stays."). Hidden accounts are listed under Hidden, each with a Show button that brings it
  back unchecked. Show appears only with a ChartBridge that has it (0.5.1); with 0.5.0 a Gone account keeps its Archive as
  before.
- **The order ticket and re-sent orders.** ChartBridge 0.5.1 sends an order again, marked `again`, right after a snapshot
  so the page always ends with the latest state. The ticket never shows a note for such a message (one "Filled", one
  "Rejected"), and its notes compare each update with what the order last said in a message of its own, so a re-send that
  arrives first never hides the note for NinjaTrader's own part fill or move.

## ChartBridge 0.5.1 (2026-10-08): the Account tab follows NinjaTrader's connected accounts; Hide and Show

A new evaluation account no longer needs a `config.txt` edit and F5, and dead accounts are one click to remove.
`nt8/PROTOCOL.md`, "Accounts" and "Accounts as built", has the rules. Built on 0.5.0 (the agent channel).

- **Connected accounts only.** An account is watched (its fills go to The Desk) and listed on the Account tab once NinjaTrader
  has shown it Connected in this NinjaTrader session; a new one appears by itself within seconds, its checkmark off. Accounts
  NinjaTrader only remembers (no connection, or not connected this session) are never watched, listed or written to
  `accounts.txt`. One seen connected that then drops stays listed Gone as before (its checkmark kept, exits work); after a
  restart of NinjaTrader it is listed again when it connects. Never Backtest or Playback.
- **Hide and Show.** `accountArchive` (with the page's confirm) is accepted for any account that is flat with no working orders
  and is not the bot's, a copier leader or follower, or an agent's; otherwise it is refused with the reason. A hidden account
  stays hidden until Show (`accountUnarchive`, new), which brings it back unchecked. An archived account NinjaTrader shows
  with a position or working orders is listed again at once, unchecked, so hiding never strands an exit. The page has a Hide
  button on each account that may be hidden and a Show button in the Hidden list; each account in `accounts` carries
  `canHide` and `hideWhy`.
- **The `accounts =` line is retired.** On the first 0.5.1 run with the line, every account seen connected in the first 5
  minutes that the line does not name and that is not checked is hidden once ("hidden: not on the old accounts list", and an
  info line on the page); the accounts it names keep their checkmarks exactly. Afterwards the line is ignored (one Output
  line says so) and can go. If ChartBridge cannot tell whether it converted before, it does not convert.
- **Newly listed accounts reach the page.** When an account is listed (it connects, Show, or it comes back from Hidden with a
  position or orders) a signed-in page gets its working orders and positions at once. ChartBridge watches an account from
  the first second it sees it connected.
- **No ghost or missing orders after sign-in.** An order or position change NinjaTrader reports while the page's order list
  is being built is sent again right after the list, so the page always ends with the latest state (before, a stop
  cancelled at that moment could reappear on the page, or a new one be missing). Those messages are marked `again`, and the page never shows them a
  second time (one fill note, one rejection note); its notes compare each update with what the order last said in a message
  of its own, so a re-send that arrives first never hides the note for NinjaTrader's own part fill or move.
- **Tidy files.** Plain `off` records not seen connected for 30 days leave `accounts.txt` (logged); checked and archived ones
  never do. The last time each account was seen connected and the conversion marker are in a new `accounts-detail.txt`:
  `accounts.txt` keeps 0.5.0's exact format, because 0.5.0's reader refuses the whole file for a line with a 4th field.

## 1.17.0 (2026-10-08): the Agent tab

Anthony's AI trading agents get their own tab next to the Bot tab (Manrae is the first; the tab serves any number). It is
the page's side of ChartBridge 0.5.0's agent channel (contract AGENT_CHANNEL v1). Its look is board F of Anthony's
mockups ("love it, lets build F into the real agent tab", 2026-10-08). Everything is in `docs/AGENT_TAB.md`, with every
lead's default.

- **The look (board F), scoped to the tab:** a blue-black ground with faint glows, cyan panels, purple and red only on a
  few buttons, chips and words (the kill switch, Reject, a LIVE account, the agent's name). Fonts, Anthony's hybrid:
  Chakra Petch for titles, labels, tabs and buttons, IBM Plex Sans for body text, JetBrains Mono for every number, all
  from this PC (Chakra Petch and JetBrains Mono added to `live/fonts`, Latin subset, SIL Open Font License; listed in
  `nt8/install-files.json`); offline each falls back to the system's own. The rest of the page is unchanged.
- **The layout:** left, the mode, the kill switch, status, his account with the room left (the Account page's figures:
  ChartBridge's, else The Desk's limits) and his rules; centre, "What he is doing now" (Screen, Eyes, Judgment, Checks,
  ChartBridge) above the chart; right, the proposal and his stream; bottom, today's dollars, trades and losses (of the
  limit), and his session as a trail from his rules' entryFrom to flatAt with his fills and exits. Only what is needed to
  understand and use the page (Anthony): no legend of the light, no step captions, no sentences explaining the page; a
  figure not reported says "not reported".
- **The flowing light:** one slow comet circles the borders of the panels where his attention is (13 s a lap while he
  decides, 9 s in a trade), with a soft halo, and those panels glow. Its place and colour come from his real state
  (`AgentCore.lightState`, from the messages the page already gets): watching cyan, a look violet, a plan or his thinking
  magenta (#c81fe0), his rules being checked gold, placed, filled or a go green; passed or a plan that ended unaccepted
  orange; refused red. In a trade it moves to the chart and the P&L, green at or above zero and red below, and back to the
  tracker after a flat exit. Pure CSS, turned on the compositor (below), worked out again only when a message arrives.
- **Motion:** only the light and the glow move or fade; the figures, the price, the position, Accept and Reject change at
  once (`docs/MOTION.md` R3). A Motion switch (Full, Off; kept in this browser) and the system's reduced motion stop the
  light and keep the glow, still. The ChartMotion kit is not used on the tab.
- **His stream's drawer:** every row (a note, a plan, a fill, an exit) is a button; it opens his record of that decision in
  a drawer over the right column, outlined in its colour: his words, the plan's numbers, ChartBridge's verdict on his
  rules, the proposal and when you saw and answered it, fill and exit details. Only what the channel carries. The same row
  again, Close, or Escape from inside it closes it; no key handler on the page, so the order hotkeys are untouched. It
  never covers an open proposal, keeps its row in sight below it, and a long record scrolls inside it ("more below").
- **The corner notices** cover nothing of the tab while it is shown: they stack over the chart's lower left, above its
  time axis, at every width; the workspace's ChartBridge line lies across the chart's top while the tab is shown.

- **The strip:** name, build, connected and the heartbeat's age, mode, the account with its SIM or LIVE mark, position,
  KILLED or STOOD DOWN with why, and "OWNS <account> <root>" while the agent holds the owner lock; the Motion switch and Pop
  out. A picker when there is more than one agent. P&L today, trades and losing trades are in the footer.
- **Control:** Shadow, Copilot, Auto (Auto asks a second click within 4 s) and the kill switch (on in one click, release
  in two), as the Bot tab. Change account lists the tradable accounts, never the bot's, the copier's or another agent's, and
  asks once in the page for a LIVE one, naming the mode; the agent goes to Shadow when its account changes. The rules in force, and Change the rules (only while the agent is flat with nothing
  working or proposed), checked against the contract's allowed values before `agentRules` goes out with flat keys;
  ChartBridge's refusal shows under the button.
- **Proposals:** side, quantity, root, kind and price, stop and target, risk, setup, confidence, reason, the account, and a
  live countdown to the plan's own expiry; Accept and Reject send `agentAnswer` (`agentSeen` the moment it shows). Accept
  closes in the last 5 s, when ChartBridge would refuse it. A card only in the tab, for the agent shown (the bot's and the
  other agents' counted in one line under it); off the tab, counted in one line in the corner that opens the tab on them.
- **One copilot key for the bot and every agent** (`AgentCore.copilotRouter`; `live/bot.js` hands it its proposals): with
  the Agent tab open a key answers the shown agent's proposals only; elsewhere it answers the bot's alone, never an
  agent's (the Agent tab hands the router its proposals only while it is shown). After an answer the keys rest 1 s, a proposal must have been on screen 1 s, and none in its last 5 s is answered
  by a key, so a double press never answers a second proposal. Off the Agent tab the bot's answer is exactly as in 1.16.0.
- **A double-click never confirms** Auto or a kill switch's release, on the Agent tab and the Bot tab (a second click under
  400 ms after the first is ignored).
- **His stream:** the agent's looks, thinking, lessons, notebook and status, its plans with their results, and its fills
  and exits today, newest first, with filters (All, Plans, Notes, Thinking, Lessons).
- **The chart:** the agent's root with its own orders and legs (`by: "agent:<id>"`) as lines and its trades as marks, its
  position and open P&L in the chart's header; the chart itself is the page's, never restyled or animated. The Account
  page names such an order "agent <id>".
- **Pop out:** `agent.html`, the tab in its own window.
- **An older ChartBridge:** the tab says "No agents on this ChartBridge (0.5.0 or later)." and nothing else changes.
- **On a pair an agent owns** (ChartBridge 0.5.0's owner lock), the order ticket sends only a market exit that reduces; a
  resting order there is refused before it is sent, in ChartBridge's words ("... belongs to agent demo: use Flatten, or
  move its stop or target"). Flatten and moving its stop or target work as always.
- ChartBridge's own lines are shown as they come: a refused plan with its held count, the warning when a cancel is not
  confirmed and the NOT FLAT errors (an account NinjaTrader no longer lists included) on the workspace's ChartBridge line.
- The fake ChartBridge speaks the agent channel as ChartBridge 0.5.0 built it (`--agents=demo`, the made-up Demo Agent and
  Sim accounts SIM-AG1 and SIM-AG2): the snapshot after hello, the owner lock, the refused plans' pace, cancels sent again,
  the backstop, the flat hours and the NOT FLAT errors; what it does not model is listed in `docs/AGENT_TAB.md`.
- **After the independent review of fc3101a** (the Agent tab is on the order path: Anthony accepts or rejects there):
  - Nothing covers the tab's Accept and Reject. Another agent's proposal and the bot's sat in the fixed corner over them
    (at 1366 x 768, 1600 x 900 and on a phone, and in the pop-out); while the tab is shown the corner is now hidden (see
    "Only the shown agent's proposal on the tab" below). The drawer keeps clear of the proposal.
  - Clicks and the focus are no longer lost: the proposal list was written again on every render (once a second per agent),
    which took the buttons out of the page (the focus fell to the page, about 3 clicks in 40 were lost, a held press sent
    nothing); now it is written only when its cards changed.
  - ChartBridge's words under a proposal ("Refused by ChartBridge: ...", "Under 5 s left", "Accept sent. Waiting for
    ChartBridge.") sit in the sticky foot right above Accept and Reject, in sight at 1366 x 768.
  - The light is cheap: thin strips along the border each turn a small conic gradient by a transform on the compositor,
    the halo softened by a mask instead of a 7 px blur, and a colour change crossfades two copies (the glow's colour is a
    registered property that is not inherited), so nothing is painted again per frame and no colour fade restyles the tab.
    The same look (look F, 13 s and 9 s laps). The reviewer's measure at 1920 x 1080 in a trade (headless, software
    rendering): Motion Full frame p95 50 ms before (66.7 ms in the review), 16.8 ms after, the same as Motion Off. A new gate,
    `npm run perf:agent`.
  - The decision drawer appears at once (it slid in over prices, risk dollars, P&L and its Close button: R3), and the R3
    smoke now catches motion inherited from an animated or transitioned ancestor, as on kit-v1.
  - A double click on the kill switch sends `agentKill` once (a click within 1 s of a kill-on is the same press).
  - The workspace's ChartBridge line no longer pushes the tab down 46 px (it lies over the chart's top), and a new proposal
    right after an ended one takes the top at once instead of jumping up 153 px when the ended one goes.
  - Narrower than 1100 px the notices sat fixed at the bottom left over in-flow buttons; they are in the tab now (below).
  - The pop-out names an agent in every ChartBridge status line that says "agent <id>" anywhere, in any case ("... is no
    longer agent demo's", "agent demo had an open trade ...", "agent demo holds 1 ... with no trade record", "...: agent
    demo's 1 closed; the rest ...": `AgentCore.statusAgent`). The order ticket uses `AgentCore.pageExitPasses`.
  - The fake ChartBridge follows ChartBridge 0.5.0 as built at agent-channel 4d4a81f (was fb15822): a cancel not confirmed
    is an error after 10 tries, then tried every 30 s, never while disconnected, and given up after 30 minutes; the market
    shut hours (nothing sent, NOT FLAT every 60 s); the market trading in fact before legs are cancelled; the stop placed
    again; the flatten asking again and its close cap; the lost-trade error; the held refused plan shown within about a
    second; and the agent's side of contract section 10 (welcome's caps, agentState's session, the snapshot's end,
    orderName, cbId and role, others' fills on its pair). What it still does not model is listed in `docs/AGENT_TAB.md`.
  - `npm run smoke:agent` runs at 11:00 New York whatever the time of day (the trail check failed after 15:55 New York),
    and `npm run smoke:agent-targets` holds the tab's Accept and Reject: never covered, never dropped, never moving.
- **After the re-reviews of a4fa9d9, 60e9ddd and 7bca487:**
  - The shown agent's proposal stays first and in sight (look F: Accept and Reject always in sight): it has a slot of a
    fixed height at the top of the panel (30vh, at least 190 px and at most 380 px: 230 px at 1366 x 768), reserved
    whenever the tab is shown ("None open" at the same height when empty), its words scrolling inside it with Accept and
    Reject at its foot; a card keeps a line for ChartBridge's words even while it has none; the browser's scroll anchoring
    is off in the tab. Narrower than 1100 px the controls and the proposal sit side by side at the top, with the chart
    under them.
  - At 1100 px and narrower ChartBridge's error line and the notices are pinned at the top of the tab in a band of a fixed
    height (it lay on the chart, far down: at 989 px at 1000 x 800, 1299 px on a phone). On a phone the proposal comes
    before the chart, and the words under the mode, the account and the rules keep their lines while empty.
  - The fake ChartBridge's texts as on main: the last NOT FLAT names the second position reading ("(or N with fills not yet
    in the position)") and why the account takes no exit ("; the account is not connected (...)"); the warning at a cancel's
    second try goes to every trader page.
- **Only the shown agent's proposal on the tab** (Anthony, 2026-10-08; it replaces the list of other proposals that the
  re-reviews of a4fa9d9, 60e9ddd, 7bca487 and 3d28bb0 kept fixing: its placeholders, its pointer-away timer, the watch on
  the bot's cards, its pinned head and the "whose" line are gone):
  - While the Agent tab is shown, the bot's and the other agents' proposals are not cards anywhere on it: the corner (the
    Bot tab's, or the window's own) is hidden, and always in the pop-out. Under the shown agent's slot, one line of a fixed
    height (30 px) counts them, "Bot: 1 proposal · Second Demo Agent: 1" (display names, open proposals); each name is a
    link, the bot's to the Bot tab and an agent's to that agent in the tab (as the picker); with none it keeps its height
    and says "No other proposals". It has no Accept or Reject, never changes height, and a count that rises is marked at
    once and stays still for 8 s (R3). So nothing on the tab moves when other proposals arrive or leave.
  - On the Bot tab the bot's proposals show with Accept and Reject as before (off the Agent tab, see the re-review of
    c47a8a1 below).
  - The copilot keys on the Agent tab answer the shown agent only, never a hidden proposal: with none of its own open, or
    the tab on its "no agents" card (`AgentCore.copilotRouter`: the tab's focus may be `true`, holding every key), they
    answer nothing and say so. The Bot tab's keys are the same keys through the same router, so they answer no hidden bot
    card either.
  - `npm run smoke:agent-targets` is rewritten for it: with the bot and the second agent proposing, no other Accept or
    Reject on the page; the line's counts at 30 px; its links (the second agent shown, back, the Bot tab with the bot's card
    and its buttons); the shown agent's Accept and Reject in the window and hit-testing to themselves at 1000 x 800,
    1366 x 768, 1600 x 900, 1440 x 1000, 1920 x 1080 and 390 x 844; nothing moving while the others arrive and leave at
    1000 x 800, 1366 x 768, 1920 x 1080 and 390 x 844; the keys; the pop-out's slot and line; and, as before, the error
    band, the notices, the focus and clicks, ChartBridge's words in the foot and the kill switch.
- **After the re-review of c47a8a1** (off the Agent tab, every agent's proposal and the bot's shared the corner, with no
  height limit: at 1366 x 768 with the bot and two agents proposing its top was at -207 px, the top card's name off screen
  with its Accept in sight, the top bar's Bot, settings and Agent buttons under it):
  - An agent's proposal is answered only in the Agent tab: off it no agent's proposal is a card anywhere. One line of a
    fixed height in the corner counts them, "Demo Agent: 1 proposal · Second Demo Agent: 1", each name opening the Agent
    tab on that agent (a risen count marked, still); its room is kept while agents are known, so it moves no bot card.
  - The copilot keys answer an agent's proposal only while the Agent tab is shown (they were global: off the tab a key
    answered an agent's proposal when it was the only one open). Off the tab they answer the bot's, as 1.16.0. `agentSeen`
    goes when the proposal shows in the tab's slot.
  - `npm run smoke:agent-targets` checks it at 1366 x 768 and 1920 x 1080 with two agents and the bot proposing: no agent
    Accept or Reject anywhere, the line's counts and links, and the keys (it fails on c47a8a1). `npm run smoke:agent`
    checks the corner's line and the keys off the tab.
- **After the re-check of e87ba23** (the bot's corner: B1, a corner that scrolled let Alt+Y accept the oldest bot proposal
  scrolled out of sight; B2, as on main, a bot card leaving slid the cards above down, the next card's Accept landing
  where the last one's was, enabled):
  - The bot's corner shows ONE card at a time, the oldest open proposal (the one the keys answer), and under it one line
    of a fixed height, "+N more bot proposals"; no stack and no scrolling, so nothing moves when a proposal arrives or
    leaves, and the corner never reaches the top bar (the card's reason gives way in a short window).
  - When the card shown changes, its Accept and Reject and the keys are off for 1 s (disabled at once, R3): a press or a
    click then does nothing and is not kept. The keys answer only the card shown, once armed and whole in the window
    (`AgentCore.copilotRouter`: the bot's entry is `ready` then). `botSeen` goes when a card shows.
  - `npm run smoke:agent-targets` checks it with seven bot proposals at 1366 x 768 and 1920 x 1080 (one card and "+6
    more", nothing over the top bar, Alt+Y on the card shown only, the next card disarmed for 1 s, a press and a click in
    that second answering nothing, one after it answering once), and its notices check at 1100 px and narrower now checks
    the band at the top of the tab, as designed. `npm run smoke:bot` waits out a card's first second before its key.
- Tests: `test/agent.test.js`, the agent part of `test/fake-v3.test.js`, `npm run smoke:agent` and `smoke:agent-targets`
  (screenshots `test/out/agent-*.png`), `npm run perf:agent`. The chart draws exactly as in 1.16.0. Page only, no
  recompile; COMPAT stays at ChartBridge 0.3.2.

## ChartBridge 0.5.0 (2026-10-08): the agent channel

AI trading agents (the first is Manrae; any number may follow) trade through ChartBridge, inside per-agent rules ChartBridge
enforces. AI is never in the order path: an agent sends plans, and ChartBridge places every order itself, from the plan's
parameters. Contract v1 of 2026-10-08 and Anthony's rulings are in `nt8/PROTOCOL.md`, "Agent channel (`agents`, 0.5.0)", with
every lead's default in its "as built" list. The chart's own version is unchanged (the Agent tab ships with the page).

- **Off until named.** `agents = manrae` in `config.txt` (a comma list) turns the channel on for those ids; with no line,
  `/agent/...` answers 404 and nothing changes. Each agent has its own secret, account, rules, day file and log next to
  `config.txt`, its own mode (every start in shadow), heartbeat and kill switch: `nt8/ChartBridgeAgents.cs`, one object per id.
- **Plans, checked in order.** A plan is refused at the first of twelve checks that fails (strict message, the account and the
  files, the root and kind, the size, the risk in dollars, the expiry, the entry window, one at a time, the day's limits, the
  owner lock, the price). Shadow shows it; copilot proposes it until the plan's own expiry; auto places it. Entries are limit
  or stop-limit only, always with a stop and a target, never above the hard ceiling (minis 2, micros 20, a code constant).
- **ChartBridge's own timers.** An unfilled entry is cancelled at its expiry and at the end of the entry window; at the flat
  time ChartBridge cancels the agent's orders and closes its position at market, with the agent gone too, and says so loudly
  until it is flat.
- **The owner lock.** While an agent holds a position or a working entry on its account and root, entries from the page, the
  bot, the copier and other agents are refused there; exits always pass (Flatten, cancels, moving a stop or target, an order
  that only reduces). An agent never enters where anything else is held or working. One check, where every entry passes.
- **Accounts never shared.** An agent never trades the bot's account, the copier's leader or a follower, or another agent's;
  the bot and the copier refuse an agent's account once it is chosen on the page. An agent still on its unchosen default
  (Sim101) claims nothing: if the bot or the copier takes that account, the agent stands down in plain words (its unfilled
  entries cancelled) and the bot and the copier are left as they were.
- **Fills to The Desk** carry `by` (`agent:<id>`, `bot` or `copier`) when ChartBridge knows who placed the order; nothing else
  in the fill changes. v3 pages see `by: "agent:<id>"` on an agent's orders and legs.
- **After two order-path reviews.** A cancel NinjaTrader does not confirm is sent again every 3 s, with a warning from the
  second try. A backstop cancels any agent entry still working while the agent is killed, in shadow, stood down or outside its
  window (every start is shadow, so an entry from before a restart goes at once), and the page's kill, mode, account and rules
  wait for the agent's placing gate. A trade record left open never makes the agent own a position it did not place (current
  session only, and only while its orders are listed or its executions followed). Only a page MARKET order may reduce an
  agent's position; resting page orders on its pair are refused ("use Flatten, or move its stop or target"). A flatten whose
  account leaves NinjaTrader's list keeps saying NOT FLAT and goes on when the account is back. The rest of a part-filled entry
  that fills after the first part closed is its own trade. The rate is counted before anything else; refused plans reach the
  pages at most once a second. After every `agentHello` the agent gets its positions and working orders.
- **The agent socket's additions (contract section 10).** `agentState` carries its session and is sent again whenever a field
  changes, `owns` included, at the next order or position event. `exec` carries ChartBridge's order id (`cbId`) and the order's
  role; its `order` messages carry `orderName`, NinjaTrader's own name of the order. The flat-time close and the protective
  exit are named with `ag:<id>` and carry the roles `flat` and `protect`. The
  snapshot after hello covers exactly the served roots of `welcome` and ends with a `snapshot` message. Pages are unchanged.
- **After the second reviews.** A flatten asks again whether the pair is still the agent's before it closes anything, and
  never closes more than the agent's own trade holds. Nothing is sent while the market is shut (fixed hours: 17:00 to 18:00 on
  weekdays, Friday 17:00 to Sunday 18:00). An agent trade that ended where ChartBridge could not see it raises an error every
  minute while the account holds a position there. Unconfirmed cancels slow to every 30 s after 10 tries, with an error, and
  wait while the account is disconnected. The flatten follows the agent's trade into another contract month. A first failed
  read of `bot-account.txt` or `copier.txt` stands the agent down at once; held-back refused plans are shown within a second;
  the day file never loses a plan id; old trade records wait for NinjaTrader's execution replay.
- **Round 4.** While the agent owns a pair it hears of every fill there, its own or not, so a close made by hand is booked as
  a manual exit. `welcome.rules` shows the caps ChartBridge really enforces, with `config.txt`'s bracket and distance limits,
  and goes again when they change. The flatten cancels no leg unless the market is trading in fact; over a shut market a
  position whose legs were already cancelled gets its stop back at the agent's own price (unless that price is through the
  market), and the error says which. The close cap counts each close; a trade the account holds the other way is ended after
  3 s with its realized part booked; unconfirmed cancels stop after 30 minutes with a final error; the protective exit's name
  is at most 43 characters; a failed execution read is not taken as the replay.
- **Round 5.** The stop ChartBridge places again over a shut market is the agent's protective leg: after a restart the pair
  stays the agent's, the stop stays, Anthony gets an error every minute, and at the open the flatten closes it. That stop is
  never placed beside a market close that still works, and a pair the agent does not own never loses it while it holds a
  position. Only the cancel step waits for a trading market; a close that cannot go puts the stop back at once. The agent
  never gets agentState before its welcome; a trade never crosses zero, so its booked result is always from real fills. A
  fill of an order that is not the agent's reaches it as role `other` (a page order too), with the page's id.
- **Round 6.** A late fill of an agent's entry nets against the close that ended its trade, so no ghost trade is left open;
  an open trade on a pair flat by both readings for 5 s is ended from its own fills, with a warning when they do not add up.
  A stop placed again after a rejected close waits for a trading market before it is cancelled. A second hello keeps the
  agent connected and its ticks flowing, and agentState still follows the welcome.
- **Tests.** `nt8/check/AgentHarness.cs` (inside `npm run check:orders`) runs every refusal and every timer; IntegrationHarness
  X13 where the lanes meet; `test/fake-agent.mjs` is a made-up agent client with its test; `test/nt8-agents.test.js` guards the
  source. The bot channel, the copier and every other lane behave as in 0.4.3 except where the contract requires (refusing an
  agent's account, the owner lock, `by` on fills).

## ChartBridge 0.4.3 (2026-10-07): the copier never crosses zero, copies a fixed quantity, and can have no leader

Found on WORK on Sim, test card section 5 (the copier), Anthony's copier test of 2026-10-07 15:01 ET:

- **The copier closed a follower into the other side (short 1).** Sim101 (leader) and Sim102 (follower) each held 5 with
  stops at the same price. The market hit both: Sim102's own stop sold 1, and in the same instant the copier called
  NinjaTrader's Flatten, which closed the 5 Sim102 still showed. The copier now **never uses NinjaTrader's Flatten** on a
  follower. It cancels every order there that may still fill, waits until NinjaTrader confirms each one cancelled or filled,
  until every fill there has come through ChartBridge's order events, and until both position readings agree, then closes
  only what the follower still holds, at market. Not confirmed in 3 s: nothing is sent, an alarm, and the missed-exit check
  tries again. A scale-out's reduce waits for the same fills. ChartBridge keeps each order's last filled count from its order
  events (seeded when an account is first watched) to know when a fill has come through.
- **A fixed quantity per follower** (Anthony: "I thought we were going with an absolute number"; the old copier moved from a
  multiplier to a fixed quantity in August). A follower's Qty is what it trades for each leader entry, whatever the leader's
  size; a leader add copies it again; a scale-out leaves it the same share, rounded to the nearest contract with no
  minimum cut (Anthony 2026-10-07: under a leader of 5 scaling out one at a time, Qty 3 holds 3, 2, 2, 1, 1 and Qty 1 keeps
  its 1 until the leader is flat; "at least 1" had taken a small follower out early). 0.4.0 to 0.4.2 multiplied it by the leader's
  contracts (Sim102 at Qty 1 took 5).
- **No leader.** `copierSet` with `"leader": null` clears the leader and stands the copier down. 0.4.2 had no way to clear
  it, so the page's "none" did nothing and the bot could not trade the old leader's account. The page's Leader dropdown
  sends it with the single Account page release; until then pick another account for the bot.
- **From the independent review** (no blocker; the race is closed and its test guards it): when a close does not go out
  (NinjaTrader slow to confirm, a disconnect, readings on opposite sides), the follower's stops are already cancelled, so
  the close is now **owed** and tried again every 4 s whatever the leader does, until it goes out or the follower is flat;
  a leader entry meanwhile skips that follower ("closing"); a scale-out reduce never replaces a close; the leader cannot be
  cleared while a close is owed. A fill NinjaTrader shows whose order event never comes stops blocking closes after 10 s
  (a warning); one that lands in the moment between the last check and the close also stops it (the close waits, or stays
  owed). A copier order whose Submit throws leaves the just-sent list. After a restart, a follower holding a copied
  position with no working stop and no record raises one alarm. The account seeding runs outside the watch lock.
- **From the second independent review** (no blocker; four should-fix, all fixed): a close stays owed until the follower is
  flat by both readings with every fill through, not just until it is sent, so a close that is rejected, cancelled or part
  filled is tried again; while a close may still fill, no second one starts. The close reads what may still fill and the
  fills not yet through both before and after it reads the position, and sends nothing if anything changed. A fill whose
  order event never comes no longer counts as booked after 10 s: its contracts are taken off the close (and a reduce), so
  the copier can only close too little, never too much, and an alarm says so. A follower owed a close that now holds the
  other side is left to the user after 10 s (one alarm). Clearing or changing the leader is blocked only while a close is
  running (3 s at most). One refused order no longer stops the rest of that second's work. An owed copy record is never
  replaced.
- **From the third independent review** (no blocker; three should-fix, all fixed): a fill whose order event never comes is
  taken off a close only until NinjaTrader's position there updates after it (then it is booked), so it is never taken off a
  later trade's close; the copier looks at every follower's orders each second, so a lost event is known at once. A close
  that neither fills nor ends in 10 s raises one alarm, is cancelled, and the close goes again once NinjaTrader confirms;
  the owed close is never cleared beside a live close. Fourth review: a late fill is booked only once its executions add
  up to its filled count and a position update came after them (a position update alone is not enough); a stuck close's
  cancel is tried each second until it goes out, with one alarm per close. One refused order during a leader exit no longer stops the other
  followers' exits.
- ChartBridge only; the page is unchanged (each PC keeps its page rollback to 1.15.0). Page wording left for the Account
  page release: the Qty dropdown's hidden label and its error text still say "per leader contract".
- Tests: the copier harness reproduces WORK's short 1 first (it fails on 0.4.2: Flatten called; a Qty 3 follower adds 6),
  then checks the close waits for every confirmation, fill and position update, never sends more than either reading shows,
  a part-filled stop, a late copy fill during the close, and a fixed quantity over two fills and an add. Every older copier
  check is updated from "NinjaTrader's Flatten" to the close; the stand-in bridge copies a fixed quantity and takes a null
  leader.

## ChartBridge 0.4.2 (2026-10-07): ChartBridge never clears a checkmark

- Anthony, after seeing NinjaTrader's trailing drawdown drift on a prop account past its drawdown lock: "I will manage the
  checkmarks on accounts ... I know when they blow, or pass to funded." So ChartBridge no longer clears a checkmark by
  itself, for any reason:
  - **Gone keeps the checkmark.** An account that drops (after it was connected) or is disabled for 10 s is still listed
    Gone and its entries wait (it is not in the ticket's list while Gone); when it is back it trades again at once with
    its checkmark, and the pages get an info line saying so. An account Anthony unchecked stays unchecked. Archive is
    unchanged (only for a Gone account, after the page's confirm); an archived account that connects again still comes
    back unchecked, since Anthony archived it.
  - **NinjaTrader's trailing drawdown never makes an account Gone.** It is shown in the Room column and the amber and red
    warnings only. (0.4.1 made an account Gone, and cleared its checkmark, when that figure read 0 or below for 10 s.)
- ChartBridge only; the page is unchanged (no page install, so each PC keeps its page rollback to 1.15.0). Known wording
  left for the single Account page release after the Thursday and Friday tests: when an account comes back, the Account
  page's own Log line still says "the checkmark stays off"; ChartBridge's info line next to it gives the truth.
- Tests: the Mono accounts harness checks Gone keeping the checkmark in `accounts.txt`, an entry refused while Gone and
  taken at once when it is back (no tick), an unchecked account staying unchecked through Gone, disabled and enabled
  again, and a trailing drawdown at 0 and below 0 for a minute leaving the account active and checked.

## ChartBridge 0.4.1 (2026-10-07): compiles on NinjaTrader 8.1

- ChartBridge 0.4.0 did not compile on WORK's NinjaTrader 8.1.6.3 (CS1503 at ChartBridge.cs line 2266): it passed
  `Instrument.GetInstrument` as a method group, and NinjaTrader's GetInstrument has an optional second parameter, so it
  does not convert to `Func<string, Instrument>`. It is a lambda now, as ChartBridgeBars.cs already does. The Mono
  stand-in for GetInstrument now has the same optional parameter, so `check:nt8` catches this kind of error. No other
  change; the page is unchanged (no page install).

## 1.16.0 (2026-10-07): the pre-cruise release with ChartBridge 0.4.0 (every new feature on, no Sim locks)

- **No switches, no Sim locks** (Anthony 2026-10-07: "I do not want another arbitrary block ... I am capable of only
  testing on sim until we clear our tests"). ChartBridge 0.4.0's new features are on as soon as it is installed:
  `accountChecks`, `orderTypes`, `strategies`, `merge`, `cancelFromList`, `copier` and `bot`. Each `config.txt` key stays
  only as an optional off line (`merge = off`); `trading.switches` reports the real values; `trading = true` is unchanged
  (off unless `config.txt` says so). The default is set in one place (`ChartBridgeSwitches.Reset`).
- **The copier takes real followers** through every account gate (trading on, its checkmark, Connected, not Gone, the caps);
  every other copier rule stays (never cross zero, the follower's stop at the leader's price, the mass disconnect and
  Re-arm). `copier.simOnly` is `false`. The Copier tab offers every account but the leader, each marked **SIM** or **LIVE**.
- **The bot trades the account Anthony chooses** (`botAccount`, kept by ChartBridge in `bot-account.txt`, Sim101 by
  default), Sim or LIVE, through every gate; refused while the bot has a position or a working entry, when the account is
  not tradable, and when it is a copier follower or the leader. `bot`, `welcome` and `botProposal` carry `account` and
  `sim`. The rails are unchanged. The Bot tab shows the account with a SIM or LIVE mark (LIVE in the Armed red, never
  animated) next to the mode, in the strip, the pop-out and on every proposal; **Change account** lists the tradable
  accounts, each marked, and asks once in the page before a LIVE one. The mode reads **Auto** (not "Sim auto").
- Tests: the Mono harness checks "on by default; the off line turns it off" for every switch (its 0.3.8 base runs with every
  off line written), a real follower copied with every gate, the bot on a chosen LIVE account (auto, proposals, refusals,
  `bot-account.txt` and a restart), the bot's account never a follower or the leader; the fake bridge defaults to every
  switch on and models `botAccount`; `smoke:bot` and `smoke:accounts` check the marks, the picker and the in-page question.

- **No text inside a chart** (Anthony 2026-10-07): a mounted chart (every workspace chart, a host's) has no legend and no
  **Aa** toggle any more (`live-legend-v1` is read by the single chart page only; `legendToggle` is an empty hidden element
  for hosts that place it). Its badge (`badge`, placed in the workspace's panel header) shows **ARMED · account** while the
  chart takes orders and the connection when it is not LIVE. The single chart page keeps its 1.14.0 legend.
- **Stale feed**: no trade for 10 s in RTH (09:30 to 16:00 ET) or 60 s outside it, while the line is live and CME Globex
  open (not in the 17:00 to 18:00 ET break or the weekend; holidays are not known): a thin amber edge on the chart and
  "Feed stale 12 s" in its badge (the LIVE pill on the single chart page: "STALE 12 s"); it clears with the next trade.
  `LivePrefs.staleSeconds`.
- **The bubble under the mouse** in the corner readout: "Buy 142 · Bar 0:54 · ATR(14) 5.58", set on the bubble event.
- **Auto-fit and bubbles**: the price scale counts the bubbles in view (only those, their drawn radius, up to 27 px at the
  default zoom) so none crosses the top of the plot (`util.fitRange`'s `bub`).
- **Data Box** panel (Add panel > Data Box): the bar under the cursor on any chart, else the newest bar of the last chart
  hovered: open time, how long it lasted, open, high, low, close, range (points and ticks), volume, buy and sell volume and
  delta (from the chart's Cumulative delta; says so when it is off), the largest print (the delta core's new `big`), the
  bubbles on the bar and the one under the mouse, and the tape timing (ChartBridge's receipt of a trade to the frame that
  drew it, one stamp per frame; the top bar's tooltip has the worst chart's). Cells are written only when they change; the
  charts tell it only while one is open (`ChartLive.mount`'s `barInfo()`, `onBar(fn)`, `timing()`).
- **Maximize and restore** a panel: the square beside its x, or the **Maximize panel** hotkey (Settings > Hotkeys, none by
  default, `live-ws-keys-v1`): never a trading key (both ways refused), never while a box has the focus. Not saved.
- **Laptop preset** (Settings > Layout): two blank layout tabs, Main and Second, in the top bar, with 2 px margins
  (`live-ws-laptop-v1`, this browser).
- **New layout...** starts with no panels (Reset still gives the default layout).
- **Fonts from the PC**: IBM Plex Mono, Sans and Sans Condensed (the weights in use) in `live/fonts` with `plex.css` and the
  SIL OFL licence; no Google Fonts link in `index.html` or `single.html`; in the install list; `*.woff2 binary`. A unit
  test checks that no installed file refers to an http(s) address other than this PC. A narrow Quote board keeps 10 px
  figures (a 9-figure price was cut at 10.5 px with the real font).
- **Shared feed**: the live record keeps a rolling window (`LIVE_MAX`, the oldest tenth goes) instead of dropping itself; a
  panel joining after it rolled gets a load of its own on a new socket and the panels already on the line never reload.
- Engine: `on('drawn')`, `vwapAt(i)`. Tests: `test/display116.test.js`, `test/offline.test.js`, `test/feed.test.js`,
  `smoke:display116`; the smokes that read a mounted chart's legend or LIVE pill read its badge (`data-conn`).

- **Quote board: NQ and ES only** (Anthony 2026-10-05): the MNQ and MES rows are gone (`QUOTE_ROOTS` in
  `live/workspace.js`). Display only: the charts and the order ticket still trade every configured root.
- **The F5 note clears itself**: "ChartBridge x copied: press F5 when flat" (`live/update-notice.js`) goes as soon as the
  ChartBridge the page is connected to (its hello version) is x or newer, not at the updater's next run, and comes back if a
  later hello is older. The page's connections tell the notice their hello version (`ChartUpdateNotice.bridge`, after
  everything else in `live/live.js`'s hello; the workspace's connection badge); nothing is fetched or sent for it. Display
  only: the order path is not touched. Tests: `test/update-notice.test.js`, `smoke:update`.

- **Bot tab** (Anthony's addenda 2 to 4; ChartBridge 0.4.0's bot channel, shown only when its `bot` switch is on; with it
  off the tab says so and offers nothing): its own layout tab with the bot's chart, the Library (one slot; Ready L1 or higher
  and Research shelves; full screen with the large equity curve, rule card, settings, live record and "Conditions it works
  best in"; read from `GET /bot-library`, the file's shape in `docs/BOT_LIBRARY.md`), the bot panel (mode, rails with how
  close to each and their change as ChartBridge built it, kill switch, day type log, today's signals and trades, Log,
  Options) and **Pop out**
  (`bot.html`, its own window). The **bot strip** across the top of the Main tab; **copilot proposals** on any tab with
  `botSeen` and `botAnswer` (The Desk's `accept` and `reject` keys or the buttons; an expired one says "not answered");
  corner notices (sound off by default); per-chart **ghost marks** of the bot's trades (off by default; the engine's
  `setTrades` draws `ghost` trades faint and an open trade's entry only). Motion (`live/motion.js`) on the Bot tab and
  the Library only; Settings > Motion: Less. Files `live/bot-core.js`, `live/bot.js`, `live/bot.css`, `live/bot.html`;
  tests `test/bot.test.js`, `smoke:bot`, `perf:bot`; the fake bridge gains `botRails` and `/bot-library`. Made-up bots only.
- **Quote board markets** (Anthony 2026-10-07): each Quote board's header has a ⋯ menu listing every row it can show (NQ,
  ES and the quote-only markets hello lists), each with a checkbox; an unchecked row is hidden on that board only, saved
  with the layout (`panel.hide`, kept and cleaned by `cleanPanel`; a root hello no longer lists is ignored); all shown by
  default; with none shown the board says "No markets shown: pick some in the menu". Display only. `smoke:quoterows`.
- **One v3 connection per window** (the page integration of the Account page, the ticket's 0.4.0 parts and the Bot tab):
  `live/accounts.js` `createFeed` is the window's only v3 connection (`client` v3, signed in), shared through `listen` and
  `post`; the Bot tab opens none of its own (`bot.html` makes its one). The order ticket's connection stays a v2 page
  exactly as in 0.3.8 and carries every order action (`order` with a strategy or a new kind, `merge`, the Account page's
  cancel from the list); the ticket's switches, `managed` and the Merge result come from the v3 connection. As ChartBridge
  0.4.0 built it: `botRails` takes the root and 1 to 5 trades and 1 to 3 losses (kept in `bot-rails.txt`, no 18:00 reset);
  the bot's orders carry no mark (Sim101 on the bot's root are the bot's); the copilot keys reach the Bot tab only through
  the `chart-copilot-key` event; The Desk's address is ChartBridge's `deskUrl` (from `/diag`), nothing per browser. The
  fake bridge sends what the C# sends (`by` only for a strategy, `tradable` to a v3 page only, the bot's `welcome`).
  `smoke:v038`: with a ChartBridge without v3 no new control and no v3 message, and the ticket's messages equal 1.15.0's.

## Unreleased: Markup Studio (a tool; the chart stays 1.15.0)

- **Markup Studio** (`tools/markup_studio.py`, `live/markup.html`): grade NQ liquidity sweeps blind on the chart's own Range 40
  and 1 minute charts on a replay clock, with reason chips, role marks and spans, a machine read hidden until the grade is
  saved, rule draft v0 with a running agreement score, and a CSV export. Read only, port 8790, the holdout (2026-04-01 on)
  refused everywhere. No change to the live pages, the engine or `nt8/`. See docs/MARKUP_STUDIO.md.
- Markup Studio: the history starts with the prior kept day's minutes, so the charts draw PDH, PDL, the prior close and the
  prior day's value area (Anthony 2026-10-03); chip "stop limit on failed candle break".
- Markup Studio: a **Bot tab** (`--bot=PATH`, a module speaking BOT_API 1) to watch a bot trade a bot day on the replay
  clock and run it over every bot day with a summary and CSV/JSON files; days split once into bot and grading days
  (`bot_split_v1.json`, seed 7), the blind queue on grading days only. The Studio holds no trading rule.
- Markup Studio: **ES** (`--symbol=ES` with its own `--marks` folder). One instrument table (`INSTRUMENTS` in
  `tools/markup_core.py`: tick, $ per point, round trip; ES and MES cost the same as NQ and MNQ); the header, the charts' root
  and tick come from the server's hello; the Bot tab and Run all files give dollars as `usd` (1 contract of the symbol) and
  `usd_micro` (its micro) and name both; new day splits record their symbol and a split of another symbol is refused. NQ
  dollars unchanged; an unknown symbol stops the Studio at startup.
- Markup Studio: a **Trades tab** (`--bot` with `--trade-queue=PATH`, a Run all `trades.csv`) to grade the bot's own trades
  blind, keyboard first: each opens frozen when the bot placed its entry order (ticks before it, the bot's view at it, no
  fill, outcome or date), `T`/`A`/`P` save TAKE, ADJUST or PASS at once, ADJUST then marks your entry, stop and target, and
  the reveal shows the date and the bot's result per exit. The queue (`trade_queue_v1.json`, seed 11) and each grade file are
  written once; flags that disagree with the queue are refused; a bot that does not match the queue's rows is refused;
  "seen this day" skips a day (`trade_skip_days.json`); the next trade is prefetched; optional reveal-only notes
  (`--trade-notes`); counts only, never outcomes by label; `trade_grades.csv` export. The test bot gains a variant TM (three
  trades) and the Bot tab's Run all tests count it.
- Markup Studio Trades tab: **your trade** after the grade. A bot may offer `simulate(day, prior, spec)` (optional in BOT_API
  1): once an ADJUST is complete (or a PASS with his trade instead) the reveal shows his own trade's result by the bot's own
  fill law, a "Your trade" row and line, and the charts draw it labelled YOU, all in one accent (`--ms-yours`, #FF9500);
  his Entry, Stop and Target marks take the accent once saved. `/api/trades/result` gains `yours`, `/api/trades/view`
  `yours_orders` and `yours_trade` (cut at the clock like the bot's), only after the grade is complete. **My trade
  instead**: after P, `M` marks his own trade before any outcome shows (`<qid>.mine.json`, kind `instead`), `N`/`Enter`/`Esc`
  goes on without one (kind `none`); the reveal waits for that choice. An ADJUST on the other side of the bot's trade is
  saved with `opposite_side` and a note first. The Trades tab draws **only the trade being graded** (its entry order, legs,
  fill and exits; no other trade's orders, no events). With `--trade-exits`, the listed exits' own legs from the optional
  result key `exit_orders`, named ("t5 target"), else the primary target named "bot primary target". The Bot tab is
  unchanged.
- Markup Studio Trades tab: **label sets** (`--trade-labels-only`). The grade saves as usual, but no result, date or trade
  of his is shown, and the clock stays at the cut while a trade is open; the queue records `labels_only` and a start with
  the other setting is refused.
- Markup Studio: the **Work list** (`--work=DIR`). Staged work items (`tools/markup_work.py add`, one JSON each with the same
  settings as the flags, written once; `status` finishes one) are offered in the header's Work list with their counts only;
  picking one, or a link `live/markup.html#work=<id>`, opens it (refused while a grade is open in the current item or Run all
  runs; a failed open changes nothing), and the last one opens again at start. `GET /api/work` (no paths) may be read by the
  origins given with `--allow-origin` (The Desk); nothing else is shared. `--log=FILE` and
  `tools/studio-service/install-studio-task.ps1` start it at logon with no window and no desktop icon.

## 1.15.0 (2026-10-02): higher timeframes, deeper hour charts, the drawing ring, compact labels, the Account panel and the Quote board

Page and engine only; works with ChartBridge 0.3.2 and newer, no recompile (`minChartBridge` stays 0.3.2). The 4h, 1D and
1W charts and the Quote board's change from the settlement need ChartBridge 0.3.7; with an older one the chart says so and
the change stays blank. Nothing under `nt8/` changes, nor the order code (`live/trade.js`, `live/order-ticket.js`) or the
motion (the time constants, the live tick path, `live/bar-builder.js`). **`/single.html` is frozen** (Anthony 2026-10-02):
it loads, trades and flattens exactly as 1.14.0, with none of the items below (the engine's new behaviour is behind options
only a host's chart turns on). Every item is the workspace's.

### Anthony's rulings (2026-10-02)
1. **Deeper history**: a 1 hour chart loads 30 days of 1-minute history (`subscribe` `days: 30`), a 15 minute chart 10, the
   rest 5 (`LivePrefs.daysFor`). One feed serves every panel of an instrument: its subscribe asks the most any panel needs,
   and a panel switched to 1 hour later loads the deeper history the way a switch to a tick view always has (the line's
   one new load; the other panels of that instrument start again from it). Measured with the fake bridge (sample data,
   reload to live): 5 minute chart, 5 days, 140 to 250 ms; 1 hour chart, 30 days, 210 to 340 ms.
2. **4h, 1D and 1W**, NinjaTrader's own bars from ChartBridge 0.3.7's `htf` (about 300), on their own row of a chart's bars
   picker. The forming bar follows `htfBar`, and between those each live trade inside it moves its close, high and low (exact,
   one compare per trade; the volume waits for `htfBar`). Times as PROTOCOL says (4h from 18:00 ET in 4 hours, the last to
   the 17:00 close; 1D the trading day; 1W its Monday; `util.htfStart`, `util.htfEnd`), the countdown to the bar's real close.
   A refused or timed-out request shows ChartBridge's reason on the chart's note line and is asked again 60 s later; the
   page stops waiting after 130 s (ChartBridge takes a queued request back after 120 s). With ChartBridge older than 0.3.7
   the choices show, dashed, with "Needs ChartBridge 0.3.7 or newer", and a chart on one says "4h bars need ChartBridge 0.3.7
   or newer" (nothing is asked). The feed passes `htf` on the instrument's line (still read only: no order message ever
   leaves a chart).
3. **Indicators on them**: no delta pane, bubbles or absorption bars (they work on the page's own intraday bars); on 4h the
   VWAP (the session's, from the 1-minute bars, as of each bar's end) and the levels; on 1D and 1W no VWAP, levels or volume
   profile, and the note line says "VWAP and levels are intraday: not drawn on 1D bars." The indicators stay on the chart, so
   going back to 5 minute shows them.

### Drawing tools (Anthony)
4. **The middle-click ring** on any chart's plot: Trend line (top), Price line (right), Clear this chart (bottom), Zone
   (left), centred on the pointer, moved in to stay inside the plot, fixed and never scrolling. A tool arms on THAT chart (one
   armed tool at a time), draws one drawing and goes off; Escape takes back the ring, an armed tool or a drawing half made; a
   click outside closes it; the focus goes back to the page, so KEYS is ON at once. The middle press over a chart is kept
   from the browser (no Windows auto-scroll).
5. **Orders untouched**: the middle button never places, moves or cancels an order. While a tool is armed a Shift or Ctrl
   click is an order click exactly as with none (engine option `toolOrders`, a host's charts only; the page's Ctrl+click
   and Shift+right click no longer wait for the tool to go there); only a plain click or drag draws.
6. **Zone**: two corners (click-click or drag), prices on the tick; the drawing color at 10% with a crisp edge, above the
   grid and behind the candles; dragged by an edge, a corner resized, selected and deleted like the other drawings, saved
   with them.
7. The ring replaces Trend line, Price line and Clear drawings in a chart's small menu, which keeps Reset view and says
   "Drawing tools: middle-click the chart."

### Anthony's review of 1.14.0
8. **Room right**: 80, 120 or 160 px in Settings, 120 until one is picked; a value saved before (Anthony's 160) is kept
   (`LivePrefs.ROOMS_WS`, `roomSaved()`).
9. **Corner readout** on every chart: the bar countdown (Range: ticks left) and the ATR in one quiet readout at the plot's
   bottom right, moved up past the order labels and the VWAP's marker, a short form on a narrow plot; shown on small panels
   and with the header text off; gone from the header text. Engine: `setCorner(text, short)`, `corner()`, `util.cornerPlace`.
10. The change from the settlement left the chart headers (the Quote board has it).
12. **Say why a press does nothing**: with the chart not live for orders, a press on a working order, a leg or a planned
    line says so on the chart's note line, once per press: "Armed is off: arm to move or cancel orders.", after a dropped
    connection "Armed went off: ChartBridge reconnected. Arm to move or cancel orders.", on another instrument than the
    ticket's "The order ticket is on MNQ: switch it to NQ to move or cancel these orders." The ticket's window tells the
    others why Armed went off (its published state's `offWhy`). Notes only: nothing is sent, Flatten unaffected. Engine:
    `on('orderPressOff', { id })`; `ChartLive.mount`'s `trade` takes an optional `pressOff(root)`.

### Two-monitor setup (Anthony, images/67.webp)
13. **Compact order labels** (engine option `compactLabels`, a host's charts): "TGT 1", "STP 1", "BUY LMT 1", planned "SL -12t" /
    "TP +24t", the position "L1 +4.50 +$90", in 10px text in a 14 px box where the full label would end; the full label while
    the mouse is over it. The hit areas, the stacking and the x are the full label's (`orderHandles()` unchanged); the same
    colors. `util.orderLabelShort`, `util.positionShort`, `labelHover()`.
14. **New panels** (Add panel):
    - **Account**: a summary strip for the ticket's account (open P&L, today's realized from the fills, the day, trades
      today), then **Positions** (every instrument: qty, average, open P&L in points and dollars, and a Close that is the
      ticket's "Also open" Close, TradeCore `flattenHere(root)`, Armed or not, from the window it is clicked in),
      **Orders** (entries, legs, planned lines: instrument, side and type, qty, price, and an x that cancels an order of ANY
      instrument (Anthony): TradeCore's own cancel with its checks (Armed, the ticket's account, a working order) in the
      ticket's window, forwarded there from any other as the chart's x is; charts keep the ticket-instrument rule), **Fills** (today's, newest
      first, each flat-to-flat trade's P&L on the fill that went flat, "open" for one still open, "n/a" for one begun before
      today, never guessed; `WorkspaceCore.roundTrips`). The seam for an "Accounts" tab (the copier, after the cruise) is in
      the code only (Anthony: hidden until the copier exists). Nothing new is asked of ChartBridge.
    - **Quote board**: NQ, MNQ, ES, MES: last, change and % from the prior settlement (0.3.7; blank without), the session's
      high and low; read only, on the window's one feed per instrument.
    Both fit under the ticket at 1366, 1920 and 2560 px with nothing cut: narrow panels stack pairs of columns, a 2 x 1
    board shows the last, change and % (the rest in the row's tooltip); only the Account panel's rows scroll.
    **Anthony's ruling for 1.15.0** (charts and orders first): a trade only notes a price; the figures are written at most 4
    times a second, in one animation frame, only the cells that changed. The rows are built only when their set changes (an
    instrument, an order, a fill): a price never replaces a button (the orders review: a Close replaced between press and
    release lost 27 of 60 clicks).

### The 1.15.0 reviews
- **A moved press is never an order click**: after a drawing tool's first click, a Shift drag pans and sends nothing (it
  placed an order at the release point).
- **No blank on a reload of the line**: a panel switched to 1 hour or 15 minutes loads the instrument's deeper history; the
  other charts of it keep their bars, levels, profile, delta and order lines until the new history is in, then swap in one
  frame; a 4h, 1D or 1W chart keeps its bars while it asks `htf` again (a refusal then keeps them, "as last loaded").
- The feed sends `htf` as exactly `{ type, root, tf, id }` (`ChartFeed.htfOf`).
- A compact label that slides under a still mouse shows in full on the next frame.
- The disarmed note in a window without the ticket gives the ticket window's reason ("reconnected" or "dropped").
- A late `htfBar` with a closed bar's final values updates that bar.
- Anthony: no percent beside the bar's change in the workspace's headers (the single chart page as 1.14.0); "Realized" reads
  "Real." on a narrow Account panel.
- Text written only when it changes: the legend's fields (each, not every frame) and the tape's cells.
- The top bar's local delay shows its p95 beside the median; a host's chart (and the workspace's order connection, tapes and
  quotes) tries again at once after a drop, then backs off as before (the single chart page as 1.14.0).

### Also
- Day labels on a host's 4h and 1h charts no longer print over each other (engine option `spacedDays`: a label closer than
  70 px to the last one drawn keeps its divider, not its text; the 1.14.0 review's 1 hour overlap).
- `test/fake-bridge.mjs`: `--deep-history` (62 days of sample minutes, a subscribe's `days` honoured), `POST /test/htf?fail=`
  (htf refused with that reason), `/test/received` lists subscribes with their days and the flattens and cancels.
- `npm run perf:workspace -- --variant=panels`: the default layout with the Account panel and the Quote board.

### Tests
- `test/h1.test.js` (new): room presets, days per timeframe, the 4h, 1D and 1W times (against the fake's own formula
  over two months), `cornerPlace`, short labels, round trips (reversals, scaling, a part closed, a trade from before today),
  fills of the trading day, the quote math, the panels in a layout, the feed passing `htf`; the engine on a stand-in canvas:
  the Zone (click-click, drag, Escape, edges and corners, saved), a Shift click with each tool armed placing the order on a
  host's chart and drawing on the page (frozen), the press while editing is off told once per press, compact labels (the
  same hit areas, the full one on hover), the corner readout clear of a label and its short form.
- `npm run smoke:h1orders` (new, 13 checks, the orders review's probes): 60 of 60 human-speed presses on the Account panel's
  Close and on an x while prices move; a Shift drag after a Trend line's or Zone's first click sends and draws nothing; the x
  on an NQ order with the ticket on MNQ (disarmed: nothing; Armed: cancelled; from a window without the ticket: forwarded
  and cancelled); a panel switched to 1 hour leaves the armed 5 min chart's bars and order lines and the 4 hour chart's bars
  on screen in every frame; no percent in the headers; the reconnect reason in a window without the ticket.
- `test/h1.test.js` adds the review's three (24 in all): the Shift drag after a first click, a label sliding under a still
  mouse, `htfOf`; the first two fail on 98343d5.
- `npm run smoke:h1` (new, 65 checks): 4h, 1D and 1W against the fake (times, live, the 1D note, 4h VWAP from the minutes, a
  refusal and the ask 60 s later), ChartBridge 0.3.6 (the choices and the chart say so, nothing asked, no settlement), the
  30 day hour load and its time, the ring (centred, the browser's middle default prevented, one chart, the focus back, KEYS
  ON, a Shift+click with a tool armed sending the order and drawing nothing, a Zone, Escape, a click outside, an edge),
  the corner on every chart, a small one and with the header off, compact labels and hover, the Account panel (x disarmed:
  nothing sent and why; x armed: cancelled; Close disarmed from a window without the ticket; Fills' P&L), the Quote board
  against the fake's settlement, the disarmed note and the reconnect note; screenshots of two-monitor layouts at 1366x768,
  1920x1080 and 2560x1440 and crops of the labels, the Account panel, the Quote board, the corner and the ring.
- `smoke:noscroll`: Anthony's Main layout with the Account panel (each tab) and two Quote boards at three sizes, no figure
  cut, the ring at the middle and both corners of a chart, the bars picker with 4h, 1D and 1W.
- Expectations changed: `test/display.test.js` (120 px is a kept room value), `smoke:display` (the workspace's ATR read from the corner readout), `smoke:workspace` (the small menu is Reset view; the 1 hour title; an ES chart switched to 15 min makes one more subscribe for its 10 days), `test/workspace.test.js` (`d1` is a chart's
  bars now).

## 1.14.0 (2026-10-02): the display round

Page and engine only; works with ChartBridge 0.3.2 and newer, no recompile (`minChartBridge` stays 0.3.2). The Time and
Sales categories need ChartBridge 0.3.8 (`q`) and the change from the prior settlement 0.3.7 (`settlement`); with an
older one the tape colors by side and that readout stays blank. Nothing under `nt8/` changes, nor the order code
(`live/trade.js`, `live/order-ticket.js`, order drawing), the motion (the time constants, the live tick path,
`live/bar-builder.js`) or the signals' drawing. `ChartLive.mount` takes no new options. Anthony's list of 2026-10-01,
from using 1.12.0 live on HOME:

### 1. No scrolling, ever
- **Colors** in two columns (the colors on the left, the preset groups on the right, 560 px): it fits a 1366x768 screen
  whole. In the workspace's top bar it no longer scrolls sideways or cuts the Black swatch and the hex boxes (the top
  bar's `nowrap` reached into it; its popovers wrap their text now).
- **Settings** in the workspace in two columns (the charts and hotkeys; large prints, the PIN, the layout and the
  versions), 800 px; it fits at 1366x768.
- **The Indicators menu**: an open gear's settings sit in a column beside the list (the menu grows sideways, not down),
  and the menu is placed where it fits whole: below the order bar when it fits there (the Armed switch, the account
  and the position stay in view, as before), else below its button, else as high as it must. Only a menu taller than
  the window scrolls its list (none at 1366x768 with the defaults).
- **The workspace's popovers** (a chart's instrument and bars and its small menu, Add panel, the Time and Sales gear,
  Settings) open under their button when they fit, else moved up until they do, never with a scrollbar.
- `npm run smoke:noscroll` (new) opens every panel, menu, popover and dialog at 1366x768, 1920x1080 and 2560x1440, in the
  workspace and on `/single.html`, and fails on anything that would scroll or is cut (Time and Sales rows are the only
  intended scroll; text cut on purpose with an ellipsis and its tooltip is not counted), or off the screen.

### 2. Panels resize from any edge or corner
- A handle on every edge (7 px, 3 px of it in the gap between panels) and corner (14 px), snapped to whole cells as
  before; overlap still refused ("That place overlaps another panel: put back"). Quiet: nothing shows until the pointer
  is on one, then a 2 px accent line on that edge (an L at a corner), and its resize cursor stays while dragging; the
  bottom right corner keeps its grip lines. Moving stays on the header. `WorkspaceCore.snapResizeEdge`.

### 3. Time and Sales, NinjaTrader style (ChartBridge 0.3.8)
- Each trade's category from `q`: above the ask, at the ask, between, at the bid, below the bid, each with its own color
  (tokens `--tape-above` `#9CF5CB`, `--tape-ask` `#3DDC97`, `--tape-mid` `#9AA8B8`, `--tape-bid` `#FF5C7A`,
  `--tape-below` `#FFA3B4`: the house buy green and the tape's sell red at the quote, the brighter pair outside it, the
  quiet grey between). Editable in the tape's gear (a picker and a hex box each, Default colors), saved in this browser
  (`live-tape-colors-v1`) for every tape. A trade with no `q` (ChartBridge before 0.3.8, or no usable quote) colors by
  its side as before.
- **Big trades** (the large-print floor: NQ 50 / 25, ES 100 / 50, MNQ 100 / 50, MES 100 / 50, RTH / overnight): bold, the
  price and size brighter, on a tint of their color with a bar at the left edge. The floors are the bubbles' one
  setting (`live-tape-floors-v1`, read through `LivePrefs.largeFloors` and looked up by `ChartEngine.largeFloorAt`, the
  signals' own rule); the bubbles' Auto applies to the bubbles only (Anthony).
- `live/feed.js` keeps each trade's `q` with it (LiveLog), so a tape that joins later, or a replay, colors the trades it
  starts with the same; a backfill row keeps it in the 6th place as ChartBridge sends it.

### 4. Grid lines
- An option in Settings (Grid lines Off / On), **off by default**, for every chart and the single chart page
  (`live-settings-v2` `grid`). Off leaves the session dividers, the RTH shading and the delta pane's zero line.
  Engine: option `grid` (default on), `setGrid(on)`, `getGrid()`.

### 5. Chart display
- **Room right of price**: 80 px of empty space right of the last bar by default, the same on screen at every zoom (it
  was 8 bars, a few px zoomed out); None, 40, 80 or 160 px in Settings (`room`). Jump to live and End keep it; zooming
  while following keeps the live edge in place. Engine: option `room` (CSS px; none keeps `rightOffset` bars),
  `setRoom(px)`, `room()`.
- **Zoom to brackets**: the auto-fit price scale takes in every working order, the position's stop and target legs and
  the planned stop and target lines (1.13.0), so they are always on screen. It eases in with the existing 120 ms axis
  re-fit, never a snap; an order being dragged keeps the scale still under the pointer (it counts at its confirmed or
  asked price). Engine: option `fitOrders` (default on), `priceScale()`.
- **The VWAP no longer sizes the chart**: a VWAP far from price draws off the scale, and a marker at the plot's top or
  bottom right edge says where it is (a small triangle and "VWAP 25,512.25" in its color on the legend ground).
  Engine: `vwapMarker()`.
- **Readouts** in the legend (once a second, on the second; never on the tick path): **Bar 0:23**, the time left in the
  bar (Range bars: **Bar ▲3 ▼5t**, the ticks left up and down), and **ATR(14) 12.50**, NinjaTrader's ATR (period 14, the
  first 14 true ranges averaged then Wilder's smoothing) of the chart's own closed bars, on the legend's first line;
  **+0.42% vs settle**, the last price's change from the prior settlement (ChartBridge 0.3.7: hello's `settlement`
  and the `settlement` message; blank, never estimated, when there is none), beside the bar's change. In the
  workspace's compact legend the change from the settlement follows the bar's change, the bar time and ATR come last
  (shown when the panel has room). Engine: `lastBar()`, `atr(period)`; `util.fmtRemain`, `barRemain`, `atr`, `pctFrom`,
  `roomBars`, `fitRange`.

### 6. `/single.html` gets the workspace's cleanup
- One toolbar line (at 1366, 1920 and 2560 px): the instruments, Bars and the range size, Indicators and its chips (the
  workspace's 2-letter chips: VO VW LV FL; those that do not fit go behind a **+N** chip), a small **⋯** menu (Trend line, Price line, Clear
  drawings, Reset view), Colors, Settings.
- **Settings** hold the general controls: Glide, Range style, Grid lines, Room right, then the hotkeys, Change PIN and
  the versions.
- While Armed the chart is outlined in the workspace accent purple with the soft glow; the order bar stays deep red.
- The order bar, hotkeys and order behaviour are exactly 1.13.0's. A host's chart with its own toolbar (`ChartLive.mount`,
  The Desk) keeps its toolbar as it was.

### From Anthony at WORK (on 1.12.1)
- **Bubble size shows the order size.** The area follows the size against the floor: radius = 4.8 px x sqrt(size /
  floor), 4.8 px at the floor, 6.8 px at twice it, 9.6 at four times, 15.2 at ten times, 27 px at most (about 32 times).
  Before, the radius grew with the fourth root, so prints near the floor all looked the same small size. Fill, ring and
  alpha unchanged. `util.bubbleRadius`.
- **No numbers on the chart; the size on hover.** The size beside the larger bubbles is gone. With the mouse over a
  bubble (the topmost under the pointer, 3 px of slop) the chart's top legend line says "Bubble Buy 142 @ 31,120.25
  08:44:05.3", in the workspace's panels and on `/single.html`. The hit test runs on mouse moves only, on the bubbles as
  last drawn; the per-frame cost is unchanged. Engine: `on('bubble', { t, p, v, side, floor } | null)`, `bubbleHover()`,
  `bubbles()` (each bubble as last drawn, its size as drawn).
- **The high no longer runs into the legend** (the 5 min and 1 hour panels): the price scale keeps the legend's height
  and 8 px free at its top (8% when that is more; at most 45% of the plot), told again whenever the legend's height
  changes and eased with the 120 ms re-fit, never a snap; with zoom to brackets and the VWAP rule as above. The time axis
  is below the plot, so nothing changes at the bottom. Engine: option `fitTop`, `setFitTop(px)`; `util.fitRange` takes it.

### From Anthony live on 1.13.0: the header room, by itself, and Jump to live
- **Price never runs into the header** as it trends, without resizing or squashing by hand: the auto-fit counts the
  forming bar's real high and low (not only its eased candle), so the scale makes room before the candle gets there, and
  the room under the header is 8 px. A price scale zoomed or moved by hand stays as set while the price is inside it;
  once a new trade takes the forming bar within 12 px of the header (or the bottom) while following live, the auto-fit
  takes over again, eased with the same 120 ms re-fit. Going back to live (End, the icon, or scrolling back to the live
  edge) brings the auto-fit back too. The fit is the bars in view (and orders), so the candles are never squashed more
  than the move needs. The time constants are unchanged.
- **Jump to live is a small icon** (24 x 22 px, the same purple, a play-to-end glyph, tooltip "Jump to live (End)") at
  the top of the price scale instead of the pill over the plot, on both pages and in every panel. It shows only while
  not following live, sits clear of every tag in that column (the last price with its countdown, orders, the position,
  levels: it moves down below them when they are at the top, and the axis prices under it are not drawn), never over the
  plot, and takes no layout room. End still works.

### The NO STOP question's place (the coordinator, layout only)
- On `/single.html` it opens just under the legend, so the LIVE and ARMED pills stay in view; in the workspace it starts
  after the connection status (which stays in view) and ends before KEYS. Its rules are 1.13.0's: it takes no layout
  room, nothing resizes or scrolls, and Close, Flatten, Flatten all, KEYS, Cancel and Send stay uncovered
  (`smoke:noscroll` checks it at the three sizes, with screenshots). Its logic is unchanged.

### 7. Versions
- "chart 1.14.0 · ChartBridge 0.3.8" in the LIVE badge's tooltip (the workspace's top bar, the single chart page's LIVE
  pill) and in Settings (both pages).

### 8. The `smoke:orders` flake
- "a drag on order NT208 while it waits in a Cancel all" failed now and then. Root cause: the probe took the first order
  still queued, whose cancel goes out at the very next slot of the pace (1.1 s after the click), while the wait for the
  chart to settle takes 0.5 to over 1 s; when the cancel went first, ChartBridge removed the order before the drag,
  which then pressed on an empty chart (no note, the check failed). The probe now drags the order cancelled last (3.3 s
  after the click) and checks it is still queued right before the press. Nothing skipped; the page is unchanged.

### 9. The page's clock follows Windows clock fixes
- `nowMs` was `performance.timeOrigin + performance.now()`, fixed at page load, while ChartBridge re-anchors to the PC
  clock every 5 s: after Windows time sync stepped the clock the page showed a false "local -99 ms (PC clock behind)"
  until it reloaded (HOME). The page's clock (`LivePrefs.pageClock`, one per page) now compares itself with
  `Date.now()` every 5 s and re-anchors when off by more than 50 ms, as ChartBridge does. `now()` is still one addition
  (the tick path's cost is unchanged), and every user reads it: the local delay and the order ticket link's stamps
  (`TicketLink.browserNow`).

### From Anthony at WORK: bubble placement (59.png, 60.png)
- A bubble sat over a bar whose range did not hold its price, or one bar early. Cause: same-side prints at one price
  within the aggregation window were grouped across a bar change, and the group was placed by its first print's time
  while its price was the group's VWAP. Now a bar change closes the group (`LargePrints.add(t, p, v, side, barT)`), each
  group keeps its bar's start, and the chart places it by that bar. Range bar and minute boundaries and the "one bar
  early" case are in the test, which failed before the fix. Absorption and divergence unchanged.

### Batch 2 (Anthony, 2026-10-02)
- **A. Volume profile colors**: rows, value area rows and POC each a picker and hex box in the profile's gear (indicator
  colors `vpRow`, `vpValue`, `vpPoc`; an indicator preset saved before takes the defaults for the new two). Brighter
  rows outside the value area by default: `#19212C` (was `#141C26`), 7.5% toward the text color on other grounds (was
  7%). The value area is capped at 1.13.0's `#212C3B` (14%), so a bear candle over it keeps 1.99:1 on the default ground
  (Anthony's answer to the review); POC gold unchanged; he can still raise them in the gear. Measured on the default
  ground: bear 1.99:1 over the value area, 2.28:1 over the other rows; bull 4.70:1.
- **B. Levels**: the Initial Balance is part of Levels (its own indicator and IB chip retired; search "ib" finds Levels).
  Every line its own toggle in the Levels gear: PDH, PDL, Prior close, ONH, ONL, PD VAH, PD VAL, PD POC, IBH, IBL. The
  prior day's value area is named **PD VAH** / **PD VAL**, and its point of control **PD POC** is drawn (the value-area
  gold, a dash-dot 8/3/2/3 no other level uses). The IB's colors moved into the Levels gear. Saved choices carried over
  once per chart (`LivePrefs.migrateIb`): an IB shown means its two lines on in Levels (Levels off before: on now with
  only the IB lines, pinned if either was), an IB off or hidden its lines off; Recent and Restore name Levels.
- **C. Developing POC, VAH and VAL** of the profile on the chart, each a toggle in the profile's gear (dPOC, dVAH, dVAL,
  on by default with the profile): solid lines across the plot (the prior day's are dashed), the POC 1.5 px in its gold,
  the value area's edges 1 px in the secondary text color, named at the profile's left edge. From the profile's columns,
  which it keeps per version: nothing is walked per frame or per tick. Engine: `setProfileLines({ poc, vah, val })`,
  `getProfileLines()`.
- **D. Chips**: up to 10 pinned (was 6); a strip that does not fit puts the rest behind **+N**, which opens a small list
  of them, on both pages at 1366, 1920 and 2560 px; a host's own toolbar (`ChartLive.mount`) does the same once its
  one-letter chips do not fit either, and keeps room for every chip there can be (7 today). The +N button is not an
  `.ind-chip`.
- **E. VWAP hours** in the VWAP gear, per chart: **Full session (from 18:00 ET)**, the default and as before, or **RTH
  only (from 09:30 ET)**, from the 1-minute bars' typical prices, none outside 09:30 to 16:00 ET. Engine:
  `setVwapSource(fn)`, `util.rthVwap`, `util.vwapAt`.
- **F. Short header on small panels**: a workspace chart under 700 px wide or 400 px tall shows one quiet line (the name,
  bars, last price and change, the indicators' values); the bar's open, high, low and volume and a hovered bubble come on
  a second line only while the crosshair is over the chart (the scale does not move for it). Bigger panels keep the full
  header; `/single.html` always does. The room kept at the top follows the header's real height.
- **G. No numbers on the bubbles** anywhere (the size is on hover, above).
- **Header text toggle** (**Aa**, next to Indicators in each panel header and on `/single.html`): off hides the header
  text, even on hover, and the hovered bubble's text; the price scale takes the room back, eased with the 120 ms re-fit.
  On by default, saved per chart (`live-legend-v1`). `ChartLive.mount` returns `legendToggle`, `legendShown()` and
  `setLegendShown(on)`; the engine `getFitTop()`.

### From Anthony: a chip opens its settings
- **A chip click opens that indicator's settings** in a popover dropped from the chip, instead of switching it off: the
  gear's own card (Hours, toggles, numbers, colors and Default colors, exactly as in the menu), with an **on/off switch**
  at the top. Off hides the indicator and keeps the chip, so the same popover turns it back on; unpinning stays in the
  menu. A click outside, Escape or the chip again closes it, and the focus leaves it (as the order bar's `handBack`), so
  the hotkeys work at once; the workspace's KEYS reads OFF while it is open (the single chart page's hotkeys wait too).
  It never scrolls: fixed under the chip, flipped up or left near an edge, whole at 1366, 1920 and 2560 px. Both pages,
  the 2-letter chips, a host's own toolbar, and the chips behind "+N" (dropped from "+N").

### Review D2 fixes and Anthony's answers
- **Chip popovers never block the order bar or the ticket**: on `/single.html` the popover opens below the order bar
  (as the Indicators menu), in the workspace never over the ticket's panel. **Close and Flatten all always act** while any
  menu, popover or panel is open (their keys and buttons), also from a popover's box when the combo types nothing there
  (Ctrl, Alt or an F-key); Buy, Sell and B/E keys stay blocked there with the note, as before.
- **An order drag holds the price scale still**: no take-over, no auto-fit easing, no zoom-to-brackets re-fit while an
  order's line is dragged; the line stays under the pointer and the price sent is the price drawn; it eases on after the
  drop.
- **Ticket link**: every cross-window stamp and age check on `Date.now()` (the same in every window, also after a clock
  fix); `move()` counts its own waits for its 1.5 s deadline. `/single.html`'s last-seen price guard on
  `performance.now()`, as the workspace's.
- **The workspace's NO STOP strip** is one line at every width: the text shortens ("The MNQ order has no stop.", "MNQ:
  no stop.") before it would be cut; the whole text is in its tooltip; Cancel and Send always in view.
- **RTH-only VWAP** kept up to date bar by bar (`util.rthVwapUpdate`: the closed bars once, the forming bar again), not
  recomputed over every 1-minute bar each second.
- `--tape-big-lift` token for a big trade's lift (was a literal white).
- The 1h panel's overlapping day labels ("Tue 29", "Thu 1") come from code unchanged since main (the session-start labels
  are not spaced); not this branch's, left as is.
- The fake bridge's `weekProfile` serves a fixed set (the 5 weekday sessions before today), so its test passes at any
  hour (it failed 14:15Z to 15:45Z on every branch).
- **Profile contrast (Anthony)**: the value area capped at 1.13.0's (see A); rows outside it stay brighter.
- **Price scale lock (Anthony)**: a small padlock in the corner under the price axis (no layout room, no tag ever goes
  there), on both pages and every panel, saved per chart (`live-scale-lock-v1`), unlocked by default. Locked, a price zoom
  set by hand is kept as price moves (no take-over near the edge, none on scrolling back to the live edge; price may
  leave the view) until it is unlocked, End or Jump to live. Engine: option `lockButton`, `setScaleLock(on)`,
  `scaleLock()`, `on('scaleLock')`.
- **ATR period (Anthony)**: editable in Settings on both pages (a whole number 2 to 100, 14 by default), saved with the
  settings (`live-settings-v2` `atr`), every chart's readout follows.
- Tests: `smoke:dragfreeze` (new, the reviewer's probe: four events during a drag), `smoke:chippop` (every chip's popover
  at three sizes: Flatten, B/E, Cancel all, Buy, Sell, Armed and the ticket's buttons reachable; the Close and Flatten
  all keys act, also from a popover's box), `smoke:hotkeys` (Flatten all acts while Settings is open, Buy does not),
  `smoke:noscroll` (the NO STOP text not cut), `smoke:headroom` (the lock), `smoke:display` (the ATR period); unit tests
  for the ticket link's clock and deadline, the incremental VWAP, the lock, the ATR setting.

### Tests
- `test/display.test.js` (new): the room, the scale with orders and planned lines, the countdown, the ATR, the change
  from the settlement, the settings, the tape categories and colors, the floors, the feed carrying `q` and the
  settlement, the page clock, the edge resize, the bubble radius (1x, 2x, 4x, 10x, over the cap), the legend's
  room at the top, the bubble placement repro (range bar and minute boundaries, one bar early), the VWAP anchors (full
  session from 18:00 and RTH from 09:30, each resetting), the level toggles and `migrateIb` (through the store too) with
  an old indicator preset, the chip cap and the header toggle. `test/vp-draw.test.js`: the developing lines, each its own
  toggle, per profile version; the profile contrast guards moved to the brighter rows' measured values.
- `npm run smoke:display` (new): grid off by default and on from Settings, the room at any zoom and after End, zoom to
  brackets eased, planned lines and the VWAP in the engine, the readouts (Range too; a new and a missing settlement),
  the versions, the single chart page's layout and Armed outline, the tape by category (gear, Default colors, big
  trades, a tape that joins later) and by side with an older ChartBridge, edge and corner resize with an overlap refused,
  bubbles sized by the order and told in the legend on hover, the high below the legend on every chart,
  screenshots of both pages at 1366x768, 1920x1080 and 2560x1440 and close crops of the tape and the Colors panel.
  Batch 2: the Levels gear's ten toggles and PD POC, the developing lines and profile colors, VWAP RTH against its own
  computation, every chip pinned at three sizes on both pages, the short header and its hover line, no numbers drawn on a
  bubble, the header toggle on both pages (none on hover, the room back eased, saved per panel across a reload).
- `npm run smoke:noscroll` (new), above.
- `npm run smoke:headroom` (new): a fake-bridge trend of +60 points in 2 minutes on MNQ, watched on a big workspace
  panel (full header, its price scale squashed by hand after a first leg up) and a small one (the short header), then
  on `/single.html`: the last price, the forming high and every high in view stay at least 4 px below the header at
  every sample, the scale is never more than 1.1 times the fit of the bars in view, the auto-fit takes over by itself
  near the header; Jump to live as an icon at the top of the price scale, clear of the last price tag, no layout room,
  a click and End. `test/vp-draw.test.js`: the takeover (kept while the price is inside, on a trade near the header, on
  going back to live) and the icon (hidden while following, at the top of the price scale, below two order tags priced
  at the top).
- Selectors that follow the new layout: `smoke:live` (Range style and Glide in Settings, the drawing tools in the small
  menu, 2-letter chips on a phone), `smoke:pin` (Change PIN in Settings), `smoke:workspace` (the single chart page's
  Glide in Settings; the tape's colors by category or side), `smoke:ib` (the light toolbar read on Settings, the toolbar's
  `.btn`, since Reset view moved into the menu), `smoke:delta` (Home and End on the pane's divider: the ratio within
  0.001 of the limit, as the pane's whole pixels give it at the taller chart). `smoke:orders`: the drag probe above.
  `smoke:hotkeys` unchanged (Settings and the small menu stay on screen when the window is resized while open).
- Batch 2 in the older smokes: `smoke:live` (5 indicators on at first run, the IB in the Levels gear, the cap rule at 3),
  `smoke:ib` (IBH and IBL toggles in the Levels gear), `smoke:presets` (the IB colors in the Levels gear, the profile's
  row colors), `smoke:settings` (a 1.3 save: Levels on with only the IB lines), `smoke:delta` (the counts without the IB),
  `smoke:vp` (the hours switch read apart from the new toggles; the developing POC off while the POC bar's own pixels are
  measured, since its line runs through the bar), `smoke:workspace` (no IB chip; a small panel's legend is the short
  header) and `smoke:embed` (no IB chip; seven chips, the narrow pane's rest behind +N).
- `npm run smoke:chippop` (new): on both pages at 1366x768, 1920x1080 and 2560x1440 (and a 1000 px window for the flip): a
  chip opens its settings under it, whole on screen and not scrolling; an edit applies and is saved; the switch hides the
  indicator and keeps the chip, and shows it again; Escape, the chip again and a click outside close it with the focus
  back on the page; KEYS OFF while open and ON after; a chip behind "+N". The smokes that clicked a chip to hide or show
  now use its popover's switch: `smoke:live`, `smoke:orders`, `smoke:delta`, `smoke:embed`, `smoke:workspace`.
- `test/trade-sides.test.js` (ChartBridge 0.3.8's): the hub now keeps a trade's `q` (it said chart 1.12.0 read none);
  the chart, the bar builder and the order code still read no `q`.

## 1.13.0 (2026-10-02): planned stop and target lines, NO STOP, Armed in deep red

Page only; works with ChartBridge 0.3.2 and newer, no recompile (`minChartBridge` stays 0.3.2). The planned lines need
ChartBridge 0.3.8; with an older one there are none and the page works as 1.12.0 did. Nothing under `nt8/` changes,
nor `test/fake-orders.mjs` or `test/fake-bridge.mjs`. The engine gets planned lines and "+SL" / "+TP" cells.

### Planned stop and target on a resting entry (ChartBridge 0.3.8, Anthony's ATM rule)
- **Planned lines.** A working limit or stop entry whose `order` message carries `planned` shows its stop and target on
  every chart of its instrument (the workspace, every window, and `/single.html`), Armed or not: drawn like its legs
  but clearly planned (lighter, finely dashed), labelled "SL plan -12t" / "TP plan +24t", ticks from the fill. While
  the entry is dragged they move with it; after the drop they redraw from the price ChartBridge confirms.
- **Dragging a planned line** (Armed, with the leg drag's gates: connected, the account shown, not in a Cancel all)
  sends `plan` with the new distance, snapped to whole ticks, at least 1. The distance is the one the chart showed:
  measured from the entry price the chart draws, which is the moved price while a drag of the entry still waits for
  ChartBridge's answer (the engine's `orderMove` for a planned line carries it as `from`). A stop dragged to or past
  the entry (or a target) is refused on the page with a note, nothing sent, and the line goes back. Its x sends `null`
  (removed).
- **"+SL" / "+TP"** on the entry's label (while Armed, only for one that is missing) adds it at the bracket boxes'
  distance; with that box at 0 a note says to set it. No context menu.
- In the workspace a drag, x or "+SL" / "+TP" in a window without the ticket goes to the ticket's window, as other
  chart actions do (1.12.0), and is checked and sent there.
- `plan` counts as an order action (ChartBridge's 10 a second).

### Bracket limits (ChartBridge 0.3.7)
- **No 200-tick cap** on the bracket boxes and presets with ChartBridge 0.3.7 or newer: they take what ChartBridge
  takes (`maxBracketTicks`, no limit when `config.txt` does not set one). An older ChartBridge keeps the 200 cap.
- **A mistyped `maxTicksAway` or `maxBracketTicks`** (which ChartBridge reads as NO limit) is shown on `/single.html` as
  a warning that stays until dismissed, as the workspace already did. Any other ChartBridge `warn` shows there too.

### NO STOP (Anthony)
- A red **NO STOP** tag beside the bracket boxes while the stop is 0, on the ticket and `/single.html`.
- **The first order with no stop after each page load asks** "No stop: send anyway?" in the page (not the browser's
  dialog), with Send and Cancel; Cancel has the focus everywhere, so Enter never sends it (Escape is Cancel). It covers
  Buy MKT, Sell MKT, their hotkeys and chart clicks. After Send nothing asks again until the page is loaded again. An
  order that reduces the position never asks (it takes no bracket); Close, Flatten, Flatten all, B/E and cancels are
  never asked.
- **The question never blocks Close or Flatten.** It is a strip that takes no room and is never modal: over the top
  of the chart on `/single.html`, over the left part of the top bar (up to KEYS) in the workspace. Nothing resizes or
  scrolls when it shows, and it covers no order control. The Flatten button, the ticket's Close, the top bar's Flatten
  all and the Close and Flatten all keys work while it is open: they act at once and close it, its order not sent. A
  Close, Flatten or Flatten all in any window closes the question in every window for that instrument (every
  instrument for Flatten all).
- **An answer is for what was asked.** Armed going off, another instrument or account, or the ticket moving or being
  released closes the question; a Send is checked against the instrument, the account and the arming it was asked in
  and otherwise sends nothing, with a note. The ticket's window refuses an answer from another window given before
  its last Close or Flatten of that instrument (a late message), and is not told "Send" by it.
- **A reversal is asked as an entry** (long 1, Sell 3 opens short 2): with the stop at 0 it asks. The bracket rule is
  as in 1.12.0: an order that reduces or reverses the position goes with no bracket, so the opening part of a reversal
  has no stop whatever the bracket boxes say.
- **In the workspace the question shows in the window Anthony clicked or pressed the key in.** The ticket's window
  tells the others its stop and whether it was answered; a window forwarding an order with no stop asks first and
  forwards it with the answer and the instrument it asked about; the ticket's window refuses it ("Not sent: the order
  ticket is on NQ now, not MNQ.") if the ticket moved on meanwhile, and is not told "Send" by it. A Buy or Sell key
  forwarded names its instrument the same way. The ticket's window never asks for another window. One Send in any window counts for
  the ticket's window until it is loaded again (a ticket moved to a window not yet asked asks there once more).

### Armed in deep red (Anthony: "we need more of that in the layout")
- The Armed switch, the ticket's outline while Armed, `/single.html`'s order bar outline and the ARMED badge use the
  house crimson (`--crimson` `#9F1239` with the logo's light ink, the outline `--crimson-word`). No new colors. The
  charts stay purple with the soft glow while Armed, in the workspace and now on `/single.html` too (Anthony: only the
  order bar is deep red; the workspace accent `#7B5CFF`). Contrast: the ink on crimson 6.7:1, the
  outline 4.5:1 on the bar (3:1 needed).

### The position readout (Anthony), on the ticket and `/single.html` (shared code)
- One line: a small **LONG 4** / **SHORT 2** tag in the side's color, the average price, and the open P&L, dollars
  first and largest, then points. Flat: just "Flat".
- One quiet protection line, "Stop 4/4 · Target 4/4"; a gap in plain words, "NO STOP on 1", in the loss red of the
  NO STOP tag (more than the position stays in the warning color).
- The last fill in the dim text color, one line. The ticket's notes keep their own one-line slot and fade; a "Filled"
  note no longer repeats the last fill. Labels in the sans face, prices in tabular figures; nothing changes width as
  the numbers move.

### Tests
- `npm run smoke:plan` (new): the planned lines, an entry drag carrying them, a planned-line drag (`plan` with the
  ticks), x and "+TP", a wrong-side drag refused, a disarmed drag sending nothing, an older ChartBridge (the page
  strips `planned` from its messages: the fake always sends it), the 200 cap kept for 0.3.6 and lifted for 0.3.8, the
  config warning staying, NO STOP and its one question on both pages (Flatten and Close never asked, the question in
  the clicking window), deep red Armed, purple workspace borders, and screenshots at 1920x1080.
- `npm run smoke:nostop` (new, the F2 review's probes): with the question open, the Close and Flatten all keys, the
  Flatten button, the ticket's Close and the top bar's Flatten all send at once on both pages and in a forwarding
  window; the question covers no control and nothing resizes or scrolls (the ticket at 1366x768, 1920x1080 and
  2560x1440); Cancel has the focus (Enter sends nothing); a reversal is asked; Armed off, another instrument and Armed
  again, or a Close in the other window drops the question; an answer that reaches the ticket's window after a Close
  (the drop missed) is refused.
- `smoke:plan` also drags a planned stop while the entry's move waits for its answer (the change held back in the
  page) and checks the ticks sent are the chart's.
- `test/plan.test.js` (new): the tick math and the drag rules (with `from`), the 200 cap by version, the protection
  line, reversals.
- Expectations changed: `smoke:orders`, `smoke:hotkeys`, `smoke:workspace`, `smoke:pin`, `smoke:live-first` and
  `smoke:presets` answer Send to the one NO STOP question (they place orders with no stop); `smoke:orders` reads the
  new protection line ("NO STOP on 1" in the loss red); `smoke:plan` no longer expects a key to do nothing while the
  question is open.

## 1.12.1 (2026-10-02): Signals: absorption bars, divergence arrows, large-order bubbles

Page and engine only (the engine, `live/live.js`, `live/live.css`, `live/workspace.js`); works with ChartBridge 0.3.2 and
newer, no recompile (the signals need the trade sides of 0.3.4 and newer), no new page file. Run `nt8\install.ps1` again
after pulling (the PC updater installs it by itself; the open pages say "Update ready: reload when flat").
Anthony's two NinjaScript indicators ported from the files he sent (`FROM_WORK_2026-10-01_LargeAbsorber.cs`, class
AbsorptionTradeCombo, and `FROM_WORK_2026-10-01_DeltaD.cs`, class DeltaDivergenceSignal v1.0), with his rulings of
2026-10-01. Every signal counts from the page's opening only, from the
trades ChartBridge sides (an unknown side is left out). The motion, the live tick path, the bar builder, the candle and
volume drawing order and the order code are unchanged; a trade costs O(1) more and a bar close one short step.

- **Absorption bars** (Indicators, new "Signals" group; no chip, never counted toward the strip): a large trade, a volume
  spike and a rejection close on one bar, the large trade's side matching. Painted at the close only, the whole candle in
  a toned cyan (bullish) or warm yellow (bearish) with a crisp 1 px outline in a brighter shade; an outline only while the
  bar forms with the three holding (it goes when they stop; NinjaTrader paints mid-bar and never un-paints). No line, no
  label. **A deliberate difference from Anthony's NinjaTrader script** (his ruling 2026-10-02): a large print on a bar's
  first tick counts for that bar. In the script OnBarUpdate resets the bar's tracking on its first tick, which can drop a
  large print that came on that very tick; here the bar's tracking is reset first and then the print is taken. LookbackPeriod 20, VolumeMultiplier 1.8, RejectionZone 0.35 and AggregationWindowMs 500 per instrument and
  chart type, in its gear (`live-signals-v1`); TickTolerance 0 as the file. The large trade's floor is the large-print
  floor.
- **Divergence arrows** in the delta pane only (its gear: Show divergences, off by default, per pane; SwingLookback 5,
  MinBarsBetweenSwings 3, MinDivergencePct 0.10): on the pane's own cumulative delta, at bar close. A hollow arrow from the
  close of the bar that beats the previous swing while the delta does not; solid when that bar is confirmed as the swing;
  gone when a later bar takes its high (low) first. Cyan below a bullish swing, yellow above a bearish one.
- **Large-order bubbles** (Volume group, chip BB / B): same side prints within 100 ms added up, from the floor; circles at
  the trade price on its bar, the area growing with the square root of the size (6 px radius at the floor, 24 px at
  most), in the bull and bear colors as they read on the ground, see-through over the candles with a crisp ring; the
  size beside the larger ones. Floors RTH 09:30 to 16:15 ET / overnight: NQ 50 / 25, ES 100 / 50, MNQ 100 / 50, MES 100
  / 50, the same key as the workspace's Time and Sales floors (`live-tape-floors-v1`), editable in the gear and in the
  workspace's Settings; Auto per instrument: the session's top 1% of group sizes.
- **Colors** (CHART_STYLE): `--sig-bull` `#38DCE8`, `--sig-bull-line` `#9CF1F7`, `--sig-bear` `#F3D84A`,
  `--sig-bear-line` `#FFEC8F`, set in the Absorption bars gear and kept by indicator presets (a preset saved before takes
  the defaults, so none is lost). On other grounds they move as candle bodies and lines do.
- Engine: `ChartEngine.Absorption`, `LargePrints`, `DeltaDivergence`, `absorptionAt`, `largeFloorAt`, the layers
  `absorption`, `bubbles`, `divergence`, `chart.setSignals()` and `chart.barToX(i)`. `ChartLive.mount`'s
  `setIndicatorOption('delta', 'div', 'on')` (live/EMBED.md).
- Tests: `test/signals.test.js` (the rules on hand-built bars and trades); `npm run smoke:signals` replays a scripted tape
  (`test/signals-scene.mjs`, the fake bridge's `--scene=signals`, sample data) on MNQ Range 40 in regular hours on the
  single chart page and in the workspace, with pixel checks of the toned colors and screenshots.
- A rebuild (another bar type or size, a setting changed, a reconnect) replays the page's own live trades in slices; on
  range bars each trade goes to the bar it made by its order in the store (as the delta pane, `RangeReplay`), so the
  rebuilt chart paints exactly the bars live trading painted. The chart's frame allocates nothing for the signals.
- `live/COMPAT.json`: page 1.12.1, minChartBridge 0.3.2 (unchanged).

## ChartBridge 0.3.8 (2026-10-02): stop and target in ticks from the fill (the ATM rule), Time and Sales category

ChartBridge (nt8/) and the PC updater only; the page and the engine are unchanged (chart 1.12.0 works against it as it
is: it already sends `bracket` in ticks and ignores the new keys). **Needs a recompile:** while flat and with no resting
orders if you can, run `update-pc.ps1 -InstallChartBridge` (README: Keep this PC up to date) or `nt8\install.ps1`, then
compile in NinjaTrader (F5). Entries still resting at the recompile are handled as below.

### The rule change (Anthony): a resting entry's stop and target are ticks from the fill again
- **0.3.7's planned PRICES are gone.** A limit or stop entry's stop and target are distances in ticks from its
  ACTUAL fill, like a NinjaTrader ATM: every fill increment gets its legs at the fill price plus or minus those ticks
  (better fill, better legs; slippage moves them with it). They travel with the entry when it is dragged, and moving
  the entry onto or past where its stop or target would be is never refused. Market entries are unchanged.
- **The market exit** at a fill now happens only when a trade in the last 2 seconds went through the stop level
  (a fresh trade, never an estimate); otherwise the stop goes in as usual.
- **Protocol** (`nt8/PROTOCOL.md`, "Planned stop and target on a resting entry (0.3.8)"): `order` keeps `bracket` in
  ticks; `stopPrice` and `targetPrice` are no longer accepted, and the price checks went with them. `plan` is
  `{type, cid?, id, stopTicks?, targetTicks?}`: a whole number of 1 or more sets a distance, `null` removes it, a key
  left out is unchanged, at least one is needed; strict, rate-limited, the same gates as `change` (and
  `maxBracketTicks` when set). A bracket on a reducing order is still refused. `order` messages for a working resting
  entry carry `"planned": {"stopTicks", "targetTicks"}` (null for none).
- **Kept from 0.3.7, now in ticks:** the plan-versus-fill race check under the fill path's lock; the ticks in the
  order name (`CB#1a2b3c4d atm s8 t16`) and `planned_brackets.txt` (`<tag> ticks <stop> <target> <saved>`); file I/O
  off NinjaTrader's thread and outside every lock; fills found by the 2 second check left to that path; recovery that
  never guesses (a missing record uses the name's ticks, with an alarm). The remembered sent price of a move (0.3.7,
  P9) is removed: plans no longer depend on the entry's price.
- **No legs from an estimated price (review P3, P13).** After a recompile, an increment that follows contracts handled
  with no legs is priced from NinjaTrader's executions of the entry; when they cannot give the price, no legs are
  placed and an error alarm says NO STOP and to set it in NinjaTrader (0.3.7 placed legs from an estimate, and could
  put a stop above the market and exit at market by mistake).
- **Entries placed before 0.3.8 and still resting:** a 0.3.6 entry (`s8 t16`, already ticks) is recovered as it is,
  and `plan` now accepts it. A 0.3.7 entry (`plan s<price> t<price>`) is converted once, at recovery, to the ticks it
  shows now from the entry's current price (a price on the wrong side is no stop or no target), written to the file,
  with a `status` `warn` to the pages naming them; when its stop was on the wrong side, an error alarm that it has NO
  STOP, at the conversion and again at its fill (review P10).
- **The empty `planned_brackets.txt` seen on HOME.** In 0.3.7 a failed write (an antivirus such as Norton holding the
  file just written) was only logged, so an earlier empty write could stay as the file, and a failed read at start
  was followed by rewrites from memory that dropped the lines not read. Now: writes are tried again a few times,
  raise an alarm when they still fail and are retried every 2 seconds until they succeed ("saved again"); a read is
  tried again for a few seconds and, if it still fails, the file is never rewritten that run (with an alarm); and
  every 2 seconds each working resting entry with a bracket is checked to have its line.

### Settlement dating (Anthony)
- A value stamped from a session's close (17:00 ET) until the next session's settlement time is that session's. The
  snapshot NinjaTrader gives at a first start in the evening (HOME, 20:43 ET on 2026-10-01) is now that day's
  settlement; a morning start dates it the day before, a weekend one Friday.
- A value equal to the stored value of the day before is never used, whatever its stamp (NinjaTrader can still hold
  the day before's value; a blank is safer than a wrong change). With nothing stored for the day before, a value
  stamped from the close on is the day's, and one stamped between 16:00 and the 17:00 close waits. Settlement updates
  are handled one at a time in arrival order (one task each could take them out of order).

### Time and Sales category (`q`)
- Every live `tick` carries `q`: 2 above the ask, 1 at the ask, 0 between, -1 at the bid, -2 below the bid, from the
  same quote the side tagger uses (no request added, no string made per trade); no field when unknown. A served-window
  trade ChartBridge saw live with a quote is `[t, p, v, null, null, q]`; trades from NinjaTrader's answer, tables and
  files stay `[t, p, v]` (unknown, never guessed). Chart 1.12.0 ignores both. `/diag` counts trades by category.

### PC updater (`nt8/update-pc.ps1`)
- The delete of `staged.tmp\files.zip` is tried again for about 5 seconds (Norton held it: "Access to the path is
  denied").
- A fetch that fails because the network is not up yet (the run at sign-in) is tried again every 10 seconds for up
  to 2 minutes; then the run ends quietly (`offline`, logged as INFO, not a STOP) and the next run tries again.
  Other fetch failures stop as before. A command refused meanwhile (`-InstallChartBridge`, say) says the other run is
  waiting for the network and to try again in about 2 minutes. The scheduled task runs the pinned copy: this applies
  after `update-pc.ps1 register` or `-InstallChartBridge`.

### Checks
- `npm run check:orders`: OrdersHarness (the 0.3.8 ATM checks and the planned_brackets.txt faults), DataHarness
  (settlement dating: evening, morning, Saturday and Sunday first starts), SidesHarness (`q`, and a flood probe:
  OnMarketData cost unchanged within noise). `test/pc-updater.tests.ps1` (the fetch wait, the held zip),
  `test/trade-sides.test.js` (1.12.0 ignores `q`), the fakes (`test/fake-orders.mjs`, `test/fake-bridge.mjs`
  with `--no-q`) and the source guards.

## 1.12.0 (2026-10-01): the workspace and its order ticket

Page only; works with ChartBridge 0.3.2 and newer, no recompile. Run `nt8\install.ps1` again after pulling (the PC
updater installs it by itself at sign-in and at 17:05 ET, and the open pages say "Update ready: reload when flat").
Under `nt8/` only the page install changes, no C#: `nt8/install-files.json` gets six new `www` entries
(`single.html`, `feed.js`, `workspace.js`, `workspace.css`, `trade.js`, `ticket-link.js`), and `nt8/update-pc.ps1`
writes them in a new order (the engine, the libraries and `trade.js`, `live.js`, then `workspace.js`, the pages, and
`index.html` last). The scheduled task runs a pinned copy of the updater: the new order applies after Anthony runs
`update-pc.ps1 register` again from the clone; until then a page loaded during an install fetches `trade.js` and
`ticket-link.js` itself if the older page did not load them, or says to reload. The engine only gets its version number. The single chart page (`/single.html`) keeps its order bar and hotkeys
exactly as in 1.11.0 (the same functions now live in `live/trade.js`; `smoke:orders` and `smoke:hotkeys` unchanged
and green), with the hotkey changes listed last.

### The order ticket (E2b)
- **The order ticket panel** (Anthony 2026-10-01) replaces the placeholder: instrument (the roots ChartBridge serves),
  account, Armed, Qty (1 to 9, the cap beside it), the bracket presets (the same list as the single chart page) with
  the stop and target in ticks or points, Buy MKT, Sell MKT, B/E, **Close** (this instrument: the single chart page's
  Flatten), Cancel all, and the position, its P&L, the stop and target cover and the last fill of its instrument, as
  the order bar shows them. It is not tied to a chart. A notes line under it says what was sent or why not.
- **One order path.** The order bar's logic moved out of `live.js` into `live/trade.js` (TradeCore) unchanged; the
  ticket and the single chart page call the very same functions with the same checks, repeat guard and pacing.
  `smoke:workspace` runs one sequence on `/single.html` and on the ticket and compares the messages sent.
- **Every chart on the ticket's instrument takes orders while Armed**, in any window: the 1.10.0 mouse rules (Shift +
  left click buys, Shift + right click and Ctrl + left click sell, Ctrl and Shift together send nothing), dragging a
  working order or a bracket leg, the x to cancel. Charts on other instruments are display only for orders. Every
  chart shows the working orders, position and fills of its own instrument on the ticket's account, Armed or not.
- **The Armed border** on each chart that is live for orders (Anthony): the accent purple with a soft, static glow.
- **Switching the ticket's instrument** with a position or orders still open on the old one is allowed: Armed goes
  off, and the ticket shows "Also open: MNQ +2" (or "MNQ 1 order") with its own Close. The old instrument's charts keep
  showing the position and orders and stop taking order clicks.
- **One ticket across windows** (same PC, same browser; `live/ticket-link.js`). The window holding the browser's lock
  for the ticket (Web Locks) has it; the others show "Ticket is in the other window" with Move the ticket here. Adding
  a ticket while another window has it asks "Move the ticket here?"; on yes the other window's ticket becomes the
  placeholder, and Armed is off after every move. A window that opens or reloads with the ticket in its layout takes
  it by itself when no other window has it (Anthony), Armed off; a window that finds another holding it never asks.
  When the ticket's window closes, no other window takes it ("Use the ticket here" there). Two windows opening, or
  adding it, at the same moment: the browser gives the lock to exactly one. Only the ticket's window arms and sends Buy, Sell, B/E,
  chart clicks, drags and cancels; another window's chart click or drag on the ticket's instrument is passed to it
  (BroadcastChannel) and acted on there with the same checks. A click goes as the limit or stop its own chart saw;
  the ticket's window sends it only when its own recent price (10 s, as the single chart page) says the same, else
  nothing is sent and the note says why. ChartBridge's refusal of an order sent for another window's click shows in
  that window too. If the ticket's window does not answer within 300 ms the clicking window says "The order ticket's
  window did not answer: nothing was sent." (and the ticket's window never acts on it later).
  A browser without Web Locks gets no ticket rather than one that could be in two windows.
- **Hotkeys work in every window.** Buy MKT, Sell MKT and B/E go to the ticket's window (the same note if it does not
  answer); **Close and Flatten all are sent from the window they are pressed in**, on its own ChartBridge connection,
  on the ticket's account and instrument. Every window keeps the ticket's instrument and account as the ticket's window
  says them; with no ticket anywhere, Close is for the last ticket's instrument on the default account (the last one
  picked on this PC). KEYS's tooltip names what Close and Flatten all would act on.
- **Flatten all in each window's top bar** (Anthony 2026-10-01): every instrument with a position or a working order
  on the ticket's account, from that window, Armed or not (connected and signed in), paced as the Flatten all hotkey.
- **KEYS ON / KEYS OFF** in each window's top bar: ON when a key pressed now would fire a hotkey there (the window has
  the focus, no box, select, menu or dialog has it). The focus comes back to the page after every pick in the ticket
  (its selects, a step of the stop or target spinner, its buttons), so KEYS is ON again at once.
- **Each window has its own order connection** (signed in with the PIN like the single chart page; it subscribes to
  nothing). ChartBridge's order errors ("the position may have NO STOP") show under the top bar until dismissed, as do
  cancels and Flattens that were not sent. The title starts with ARMED in the ticket's window while it is Armed.
- **Default layout**: the ticket takes rows 1 to 3 and Time and Sales rows 4 to 6, so the whole ticket shows at
  1366x768 (Time and Sales gives up a row). Layouts saved before keep their sizes; Settings, Reset gets the new one.
- `ChartLive.mount` option `trade` (live/EMBED.md): a host's chart hands its order clicks, drags and x to the host and
  shows what `setTrade` gives it; the chart itself still sends only subscribe and ping. `ChartLive.hotkeyHandler`.

### Hotkeys (the 1.11.0 review), on both pages
- **More refused as keys**: Ctrl+Shift+C, Ctrl+O, Ctrl+U, Ctrl+G, Ctrl+K, Ctrl+E, Ctrl+Shift+B, Ctrl+Shift+O,
  Alt+Shift+I and F4 (with any modifiers). One saved before is cleaned away on the next load.
- **Flatten all keeps every instrument it sent**: refusals for the rate (more than 10 order actions a second) are
  matched to the newest Flattens and each refused one is sent again 1.1 s later, the note naming them all (1.11.0 kept
  only the last). The Flatten button and Close keep the 1.11.0 rule and notes.
- **A Close or Flatten all key pressed while a box has the focus** says "Hotkey ignored: a box has the focus." instead
  of nothing (nothing is sent; the box keeps the key).

### The workspace (E2a)
- **The workspace is ChartBridge's main page**: `http://localhost:8765/` (`live/index.html`) opens it (the default
  layout, `?layout=` as before). The single chart page moved unchanged to `/single.html` (`live/single.html`): its order
  bar, hotkeys and everything else as in 1.11.0. The "Update ready: reload when flat" notice shows in the workspace's top
  bar too.
- **One connection per instrument per window** (`live/feed.js`, ChartFeed): every chart and tape showing an instrument
  takes its trades from one WebSocket and one subscribe, parsed once (E1 opened a socket per panel). A panel added later
  joins the instrument's load and gets the trades since from the window's own record (no new subscribe, nothing else
  reloads); a panel that needs more (Range bars on an instrument loaded for minutes) makes one new subscribe for what
  every panel there needs. A connection with no panel left closes.
- **Slim chart headers** (Anthony): handle, instrument and bars (a click opens a small picker: instruments, bars, the
  range size), the chart's Indicators button, a small menu (Trend line, Price line, Clear drawings, Reset view) and the
  x. The chart's pinned indicators show next to Indicators as 2-letter chips (VO Volume bars, VW VWAP, LV Levels, IB
  Initial balance, VP Volume profile, CD Cumulative delta, FL Fills; one click shows or hides, as the toolbar's chips);
  those that do not fit go behind a "+N" chip that opens a small list. The header never wraps or scrolls. The charts' own
  toolbars and status lines are not shown: one status line for the window sits in the top bar (the worst feed and local
  delay over the instruments, each one's in its tooltip, and the frame rate). A chart's own notes (loading, the Range
  bars start, the IB and profile notes, ChartBridge's messages; warnings in their colour) show in one faint line at the
  bottom of that chart, only while there is one. The panel legends are at most 2 lines: no source and version line, no
  LIVE pill (the top bar has it), no bar time; the close and change first (`compact: true`). The single chart page
  keeps its full legend and status line.
- **Settings holds everything general**: Glide and Range style (every chart, and the single chart page), the trading
  hotkeys (the 1.11.0 Settings, acting on the order ticket), the large-print floors, Change PIN, the
  layout reset. **Colors** sit in the top bar and color every chart at once.
- **Settings shared with the single chart page**: the workspace keeps everything under the same keys (no prefix), so
  colors, color presets, indicator colors, Glide, Range style, bracket presets, Qty and hotkeys are the same on both
  pages. Each chart keeps its own instrument, bars and range size in the layout (never in the single chart page's
  settings) and its own indicators and drawings under its panel id.
- **Default layout** (12 x 6): MNQ Range 40 (cols 1 to 7, rows 1 to 4), MNQ 1 hour under it (rows 5 to 6; daily bars
  come with ChartBridge 0.3.7), NQ 5 min and ES 1 min (cols 8 to 10), the order ticket (cols 11 to 12, rows 1 to 3)
  and Time and Sales (rows 4 to 6). No execution chart (Anthony's redesign: the order ticket replaces it).
- `ChartLive.mount` options for a host (live/EMBED.md): `feed`, `view`, `onView`, `toolbar: false`, `compact`, `onColors`, and
  `setView`, `refreshSettings`, `refreshColors`, `stats`, `indicators`, `chips`, `colors` on the returned object. Without them a mounted
  chart and the single chart page behave exactly as before.
- The updater writes the workspace's script after `live.js` and the pages last (`index.html` very last).

## ChartBridge 0.3.7 (2026-10-01): planned stop and target prices, settlement, 4h, 1D and 1W bars, the weekly profile

ChartBridge (nt8/) only; the page and the engine are unchanged (chart 1.11.0 works against it as it is: it ignores the
new keys and messages; the page side of `plan`, settlement, the higher timeframes and the weekly profile comes later).
**Needs a recompile:** while flat and with no resting orders, run `update-pc.ps1 -InstallChartBridge` (README: Keep this
PC up to date) or `nt8\install.ps1`, then compile in NinjaTrader (F5). An entry placed by 0.3.6 and still resting at the
recompile keeps its tick bracket (below).

### Order side (Anthony's rulings of 2026-10-01)
- **No 200-tick limits.** A limit or stop price may be any distance from the last price, and bracket ticks any whole
  number of 0 or more. Every other gate stays (tick grid, last price under 300 seconds old, stops and limits on the
  right side of the market, the cap, the rate, strict messages, accounts, the token). Optional limits in `config.txt`:
  `maxTicksAway = 400` and `maxBracketTicks = 300` (absent means no limit; a value that is not a whole number of 1 or
  more is ignored with a line in the Output window); when set, the `trading` message names them. Order names take any
  number of digits (`CB#1a2b3c4d s1200 t2400` recovers after a recompile). A bracket that would put a leg at or below
  zero is refused.
- **A resting entry's stop and target are prices.** A limit or stop entry's planned stop and target are prices, where
  Anthony sees them: every fill increment's legs go there at any fill price (better on a gap, worse on slippage), not
  at a tick distance from the fill. Today's page still sends `bracket` in ticks: for a limit or stop entry ChartBridge
  turns it into prices once, at placement, from the entry's own price. A market entry keeps ticks from its fill. A
  planned stop that has already traded at the fill (a fresh trade, or the fill itself, at or through it) takes the
  market exit path with its alarm; a planned target already reached goes in as a limit through the market (it fills
  at once at the target or better) with a `status` `warn`.
- **Moving a resting entry leaves its planned stop and target where they are**; a move to or past its own planned
  stop or target is refused with a plain reason.
- **New `plan` message**: add, move or remove a resting entry's planned stop and target before the fill
  (`{"type":"plan","id":"o5","stopPrice":24975.5}`, `"targetPrice":null` removes). Checked against the entry's price
  (wrong side and off-grid refused), counted in the 10 actions a second, the same gates as `change`. After a part
  fill it applies to the contracts still to fill; legs already working move with `change`, as B/E does. `order`
  also takes `stopPrice` and `targetPrice` (prices) instead of `bracket` on a limit or stop entry. Every `order`
  message for such an entry carries `"planned": {"stop": ..., "target": ...}` (pages before 0.3.7 ignore it).
- **Survives a recompile or a restart**: the planned prices are in the entry's name at placement and in
  `planned_brackets.txt` in ChartBridge's folder (every change; removed when the entry is done). A recovered entry
  whose record is missing uses the prices in its name (as placed), never a guess, with an alarm at recovery and at
  the fill.
- **Review fixes (same draft).** A `plan` is set in memory with the check that no reported fill waits, before
  the file is written; a plan racing a fill NinjaTrader has reported is refused, saying how many contracts get the
  old prices (and NO STOP alarmed when there was none); a failed save keeps the plan, with an alarm. A plan is
  checked against a move still waiting for NinjaTrader too. After a recompile an estimated increment price never
  triggers the market exit (only a fresh trade does). planned_brackets.txt is read on a pool thread before the
  accounts are watched and written outside every lock; NinjaTrader's thread only reads memory, and legs wait
  (never guessed) until the file has been read. A `bracket` object on `plan`, `change` or `cancel` is refused
  (still ignored on `flatten`). A mistyped `maxTicksAway`/`maxBracketTicks` is also told to the pages. The check
  harness reads the Output window under its lock (SidesHarness flake).
- **Entries placed by 0.3.6 and still resting at the recompile** keep their tick bracket (ticks from each fill, as
  they were placed); `plan` refuses them (cancel and place again to get prices).
- Checks: `npm run check:orders` (OrdersHarness, the 0.3.7 section), `test/fake-orders.mjs` and `test/fake-bridge.mjs`
  speak the new keys (`--max-ticks-away`, `--max-bracket-ticks`), `test/fake-bridge.test.js`, the source guards in
  `test/nt8-source.test.js`. `test/orders-smoke.mjs` starts the fake bridge with `--max-ticks-away=200` for its
  refusal check.

- **Release fixes (re-review and final review).** A fill an order event reported on a resting entry before
  `planned_brackets.txt` was read gets its legs the moment the file has been read (the full increment, as its event
  would have). One the 2 second check found first (it filled while ChartBridge was stopped) is left to that check,
  which legs only what the listed position still holds, so never a flat account (final review P8). If the file is
  still not read about 3 s after the 2 second check first sees such a fill, the pages get an alarm naming the entry
  with no legs. The price a move sent is forgotten on any change error or refusal, on an update at that price, when
  the entry is done, and when a pending change state was seen and then left; an older update outside a pending state
  does not drop it (final review P9). A `plan` sent before the file is read is not called "could not be saved": the
  write waits for the read. The `maxTicksAway`/`maxBracketTicks` warning goes only to a page that signed in.

### Data side
- **Prior settlement.** The settlement of the session before the current one (sessions 18:00 to 17:00 ET), from
  NinjaTrader's own settlement for each served contract (`MarketData.Settlement` at subscription, and every Settlement
  update). Each value is dated with the session it settles from NinjaTrader's stamp; one stamped inside a later session is
  not used (null, never a guess). Today's settlement, in after the close, becomes the prior at 18:00 (over a weekend,
  Friday's from Sunday 18:00; across a CME holiday, the last session's). In `hello` per instrument (`settlement`,
  `settlementDate`), and `{"type":"settlement","root","p","date"}` to every page when the prior changes. The last two dated
  values per root are kept in `settlements.txt` with their contract (a line for another contract, as after a roll, is
  ignored), read and written off NinjaTrader's thread, so a restart in the evening still knows the prior. `/diag` `settlements`.
- **4h, 1D and 1W bars on request.** `{"type":"htf","root","tf","id"}` (strict). NinjaTrader's own 240-minute, day and week
  bars, 300 by count, through the gate last (only with no chart loading, no window or backfill out or queued, no minute
  chart's last trades out); not answered in 15 s (Anthony), it is given up with the reason, frees the gate, and is asked
  again no sooner than 60 s later. A page waits on a request once, answers are formatted once and outside the locks the
  live trades take, and `htfBar` goes only to pages that have the bars. Kept per root and timeframe: a second
  page or a reload is served from memory; asked again on a later trading day or after a feed drop. The forming bar follows
  the live trades ChartBridge already has (no request per trade); a page that asked gets `htfBar` at most once a second
  while it changes. Bars are start-stamped (4h from the 18:00 ET open; 1D on the trading day; 1W on its Monday).
- **Weekly volume profile on request.** `{"type":"weekProfile","root","id"}` (strict): the last 5 finished sessions' volume
  at price from the session tables, never a NinjaTrader request. Each finished table is now also kept as
  `profile-<ROOT>-<date>.txt` (14 days) so a restart still has the week; a session with no table is listed as missing, a
  table that is not whole says so. One answer per page at a time, cached per root while the tables are the same.
- **The old by-date tick load is removed** (replaced by the served window in 0.3.5): its request, the Bid and Ask history
  (`quoteHours`), the quote wait and their `/diag` fields (`sides.lastLoad`, `quotesOutstanding`, `seams.tickToAheadMin`,
  `tickRetriedEndingNow`), and the backfill's side join that only it used (`ClassifyBackfill`, `QuoteSeries`,
  `ContinueTickRule`, `BackfillSides`). A `quoteHours` line in `config.txt` is now noted once and does nothing. Live
  trades keep their sides as before.
- **Review follow-ups.** The gate's stop edges (lf7 N1 to N3): a request dropped at a stop answers its waiting pages and a
  start clears what it left, a timeout after the stop never marks the gate stuck again, and a stop is checked right before
  a taken request is sent (a request that still slips out in the last instructions has its answer dropped uncopied). `MarketClosedNow` knows the CME holidays by the page's own rules
  (lf7 N4: no session on New Year's Day, Good Friday and Christmas; the 13:00 halt on other NYSE holidays and 13:15 on
  early closes). Daily bars (bars1): a queued message older than 40 days is dropped, a session The Desk refused is not
  asked again after a restart either (`refused_bars.txt`, N1), and the queue files are read on the bars thread, not
  NinjaTrader's (N7). The updater (`update-pc.ps1 -InstallChartBridge`, N2) takes out an add-on file the previous install
  had and the new commit no longer lists (a revert of daily bars, say), inside the same all-or-nothing copy, and records
  each install's file list.
- **Release fixes (data review nits).** weekProfile requests that come while one is answered are folded per root (a
  request for another root is never lost; the latest id of each). A page ends with the right prior settlement: after
  its `hello`, a root whose prior changed while the hello was built (settlements.txt read just after a start, or a new
  value) gets `settlement` to that page. `settlements.txt` that cannot be read is not rewritten from memory that run,
  and lines for roots not configured now are kept. A failed higher-timeframe request says when it can be asked again
  ("it can be asked again in 60 s (from ... ET)"), and a date-only settlement stamp seen before that day's settlement
  time says so, not "inside a later session".
- Unchanged from the reviews, still open: bars1 N3 (`contract.<ROOT>` applies to every catch-up session), N4 (two README
  wording points), N5 (Stop can block up to 500 ms in the worst case), N6 (a minute chart's last trades can go beside a bars
  request); lf7 N4's other points (the "failed once" text after an unstuck, `feedDown` set by any connection, tails not
  gated: Anthony's call).

## 1.11.0 (2026-10-01): trading hotkeys

Page only; works with ChartBridge 0.3.2 and newer, no recompile. Run `nt8\install.ps1` again after pulling. Nothing
under `nt8/` changes, and the engine only gets its version number. What Buy MKT, Sell MKT, B/E and Cancel all do when
clicked is unchanged; Flatten now works while disarmed (below).
- **Flatten works while not Armed** (Anthony 2026-10-01: Flatten is never blocked): the Flatten button, the Close
  hotkey and Flatten all. The Flatten button no longer dims while disarmed. Only the Armed check is dropped for them: trading on, connected, signed in, an order account
  and the picker showing it are still checked, with the repeat guard and the pacing. Buy, Sell, B/E, Shift+click,
  Ctrl+click and Cancel all still need Armed (buttons, clicks and hotkeys).
- **Settings, with a Hotkeys section** (Anthony 2026-10-01). A Settings button in the toolbar (the trading page only)
  opens a panel with one row per action: **Buy MKT**, **Sell MKT**, **B/E**, **Close** and **Flatten all**. No action
  has a key until Anthony gives it one: click the box, press the keys (it shows them, like `Alt+B`), or Clear. Saved
  in this browser (`live-hotkeys-v1`, under the page's storage prefix), cleaned on read, kept on reload.
- **Each hotkey calls what its button calls**, with the same checks, repeat guard and notes: Buy MKT and Sell MKT
  (the account, Qty and bracket shown), B/E (paced, all its checks), and Close is the Flatten button (this account and
  instrument). **Flatten all** sends one Flatten (the same send as the button's) for every instrument with a position
  or a working order on the order account, whatever instrument is shown; within ChartBridge's 10 order actions a
  second, the rest paced as B/E is. Buy MKT, Sell MKT and B/E need Armed, as their buttons do; Close and
  Flatten all work while disarmed, as the Flatten button now does. A refused press says why ("Armed is off: nothing
  was sent.", "B/E: no open position ...").
- **The focus comes back** after a pick in an order bar select (account, Qty, bracket preset) or the t / pt toggle,
  and Enter in a bracket box commits it and leaves the box, so a hotkey works at once.
- **Refused as keys**, with the reason shown and nothing saved: what the browser or Windows keeps for itself (Ctrl+W,
  Ctrl+T, Ctrl+N, Ctrl+Shift+T, Ctrl+Tab, Ctrl+R, F5, Ctrl+L, Ctrl+P, Ctrl+S, Ctrl+F, Ctrl+H, Ctrl+J, Ctrl+D, Ctrl+Q,
  Ctrl+Shift+N, Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+Delete, F1, F3, F6, F7, F11, F12, Alt+F4, Alt+Tab, Alt+Left,
  Alt+Right, Alt+Home, Alt+D, Alt+E, Alt+F, Escape, Tab, any Windows key combo; also Ctrl+Shift+W, Ctrl+Shift+R,
  Ctrl+Shift+Q, Ctrl+F4, Ctrl+0 to Ctrl+9 and F10), the chart's own keys with any modifiers (A, + and =, -, End, the
  arrows, Delete, Backspace; / without Ctrl or Alt), a modifier alone, keys that are not a letter, digit, F-key, numpad
  or punctuation key (Space, Enter, Page Up and the like), and a combo another action has.
- **Never by accident**: no hotkey fires while the focus is in a box, a select or an editable element, while a menu
  or Settings is open, or on a held key's repeats; one that fires calls preventDefault so the browser does not act on
  it too. A mounted read-only chart has no Settings and ignores the keys entirely. The handler is one function
  (`hotkeyHandler`) so a page with several charts can give it to its execution chart.

## 1.10.0 (2026-10-01): order bar essentials

Page only; works with ChartBridge 0.3.2 and newer, no recompile. Run `nt8\install.ps1` again after pulling. Nothing
under `nt8/` changes, and the engine only gets its version number. Flatten, Cancel all, Armed, dragging orders and the
order checks work as before.
- **Bracket presets.** A select before the stop and target boxes: Custom, 1:1, 1:1.5, 1:2, your saved presets, Save
  current... and Delete. A ratio sets the target to round(stop x ratio) and keeps it linked: change the stop and the
  target follows. Typing the target (or changing a saved preset's numbers) makes it Custom. Save current... asks for
  a short name (1 to 24 characters, "12/24t" by default); up to 12 presets, saved in ticks in this browser
  (`live-bracket-presets-v1`), cleaned on read. The pick is remembered per instrument and survives a reload. A ratio
  above the 200-tick cap is capped there, with a note (ChartBridge 0.3.6 still takes at most 200).
- **Ticks or points.** A small t / pt toggle shows and types the stop and target in ticks or points (points are ticks
  x 0.25 on NQ, MNQ, ES and MES). Points round to the nearest tick when you press Enter or leave the box. Stored in
  ticks always.
- **Qty is a select, 1 to 9.** The choices over the instrument's cap are off, never hidden, and the cap shows beside
  it ("max 5"). The last qty is remembered per instrument. The page's own qty check and ChartBridge's gates are
  unchanged: a remembered qty over a lower cap stays picked and is refused with the reason.
- **B/E**, next to Flatten (needs Armed). On only with a position on this account and instrument and a ChartBridge
  stop working on it. One click moves each ChartBridge stop leg to break-even: the average price on the tick grid,
  rounded toward safety (long up to the next tick, short down). Only when the last price is past that price on the
  profitable side; otherwise nothing is sent and the note says "Price is not past break-even yet; the stop stays."
  Stops placed in NinjaTrader are never touched, and the note says so. A stop already at break-even or past it is
  left as it is.
- **Shift+click by mouse button.** Shift + left click buys at the price, Shift + right click sells, and Ctrl + left
  click sells too. Limit or stop by the last price, as before. Ctrl and Shift together send nothing. The Buy / Sell
  toggle is gone from the order bar. Hold Shift to see the buy, with what a right click would sell.
- The order bar stays on one line at 1440 and 1920 px. On a phone the Armed switch keeps its armed width, so arming
  never rewraps the bar.
- **B/E in paced chunks** (Anthony 2026-10-01: "send in paced chunks"). One click always finishes: as many changes go
  at once as ChartBridge's 10 a second allows, the rest as soon as it allows. Before each later chunk the page must
  still be Armed, connected and signed in, with the last price still past break-even; a leg no longer a working
  ChartBridge stop behind break-even is skipped. A note says what was sent and what was not. A click while a run is
  under way sends nothing.
- **No browser menu anywhere on the chart** on the trading page (Anthony 2026-10-01): the plot, the price and time
  axes and the delta pane. The toolbar, the order bar and the menus keep it. What every click does is unchanged.

## 1.9.0 (2026-09-30): color presets, indicator colors in their gears, the top bar matches every ground

Page and engine only; works with ChartBridge 0.3.2 and newer, no recompile. Run `nt8\install.ps1` again after pulling.
The Desk gets it with the new `live/live.js`, `live/live.css` and `src/chart-engine.js`. With the default colors the
chart and the page draw exactly as 1.7.0 (every element's computed style outside the Colors panel is the same, off and
Armed); the order bar's controls, places and actions are unchanged (only its colors on a ground other than the
default). No file under `nt8/`, `live/order-ticket.js`, `live/pin.js` or the order tests changes.
- **Named presets, two groups** (Anthony: "Bar colors and chart color should be a preset. Indicator colors should have
  their own preset group"). The Colors panel gets **Chart presets** (bull, bear and the background) and **Indicator
  presets** (every indicator color). Save the colors in use under a name (Enter or Save; a name already used, in any
  case, is replaced and the button says Replace), pick one to apply it, rename it (the pencil; Enter keeps, Escape
  cancels) and delete it (the x, a second click confirms). The one matching the colors in use shows as pressed. Up to 24
  per group, names up to 40 characters. The built-in presets (Carolina, Mint, House, the four grounds) stay as they were.
- **A chart preset can remember one indicator preset** (Anthony: link the groups). The chart group's save row has
  **Indicator colors: None / <each indicator preset>**, set at first to the indicator preset holding the colors in use,
  else None. The chart preset keeps that preset's id, and picking it applies both. A save never makes or changes an
  indicator preset; a re-save sets the link only as the select says; a full group refuses only its own save, and a
  refused save writes nothing (the panel lists the store again). An indicator preset deleted since is ignored: the
  chart preset still works, no message. A link to one deleted while the panel was open refuses the save with a message.
- **One small store for the presets:** `LivePrefs.localPresetStore(storage)` (`list`, `save`, `rename`, `remove`, each
  returning a promise, and `shared`), in this browser today (`live-color-presets-v1`, per storage prefix, read fresh on
  every call so two windows do not undo each other). A store shared by every PC plugs in as `ChartLive.mount`'s
  `presetStore` option once Anthony chooses one (live/EMBED.md); the panel's foot says where presets are kept.
  Damaged or blocked storage lists nothing and refuses to save with a plain message; nothing throws. The page cleans
  every list a store hands back (presets of a bad shape, a bad color or no name are left out), as a shared store will
  hand over what another PC wrote.
- **Indicator colors in each indicator's gear** (the brief: editable in that indicator's own settings): a
  picker and a hex box per color, and Default colors. VWAP (line), Levels (prior day high and low, overnight, value area,
  prior close), Initial balance (high, low), Volume profile (point of control). Applied at once to the chart, without
  rebuilding anything from the bars; shared by the charts of one storage prefix (`live-indicator-colors-v1`). The VWAP
  picker moves out of the Colors panel into the VWAP gear; a VWAP color saved before 1.9.0 is copied into the
  indicator colors once, on page start, so a ground changed first no longer loses it (review R1). On a ground other
  than the default the chosen colors move to read as the house ones do. The IB high stays the brighter with any
  colors (Anthony), on the default ground too: a high picked darker than its low is drawn the brighter
  (`ibPair`). The volume bars, the delta pane and the fills get no colors of their own (Anthony).
- **Reset to default in the Colors panel no longer resets the VWAP color:** the VWAP is in its gear now, whose own
  Default colors resets it.
- **The top bar matches every ground** (Anthony: "white chart, white top bar", then "the top bar matches every
  ground"). The toolbar, menus, status line and now the order bar take their colors from `chromeColors` on every
  ground but the default: Black gives a black top bar, Blue-grey a blue-grey one (the house dark chrome lifted by the
  same steps over the ground), a light ground the 1.5.3 light chrome (unchanged there). On a mid ground, where black
  or white text reads under 9:1, the chrome's ground is the chart's lightened or darkened just enough for 9:1
  (`#808080` gives `#AAAAAA`). Buy and Sell keep a tint of the house green and red with their text in the same hue at
  4.5:1 (over the bar and over the Armed bar), Armed the chrome's amber at 4.5:1. On the default ground it is exactly
  the 1.5.2 bar. This reverses the 1.5.3 rule "the order bar never changes with the ground" (review 2, B1), at
  Anthony's request.
- **Dimmed controls as strong as on the house bar on every ground** (review R2). Disarmed (Buy, Sell, Flatten, Cancel
  all at 0.45) and trading off (every control at 0.4) faded further on a light bar (disarmed Buy 1.93:1 on white
  against 2.85:1 on the house bar). `chromeColors` now raises the two opacities (`--obar-off`, `--obar-disabled`) in
  0.05 steps until every dimmed control reads at least as on the house bar: 0.75 and 0.65 on Light, 0.5 and 0.45 on
  Black. Worked out once per ground change.
- **Engine:** `levelLines(lv, colors)` and `ibLines(ib, colors)` take optional colors over `LEVEL_COLORS`
  (`levelColors`); `chromeColors` gives colors on every ground but the default and adds `--buy`, `--sell` (with
  `-edge`, `-tint`, `-hover`), `--warn-tint`, `--obar-off` and `--obar-disabled`; `util.CHROME_LIGHT` is gone (no
  longer a rule); `util.ibPair`, `util.obarDims`, `util.fadedContrast` and `util.OBAR_DIM` are new; `mountThemePanel`
  takes `vwap: false`, `note`, and returns `slot` and `isOpen()`. On the live page the Colors panel scrolls when taller
  than the window (live.css, so other hosts of the engine keep their panel as it was).
- **Tests:** `test/presets.test.js` (the store, its refusals, damaged storage, prefixes, indicator colors and their
  migration with a ground changed first, level and IB colors, linked presets and full groups (review 2 S1, S2), every text of the order bar at 4.5:1
  and every dimmed control at least as on the house bar across review 1's 21 grounds, the greys and 600 random
  grounds), `test/theme.test.js` (the chrome on every ground, the IB high the brighter with any colors) and
  `npm run smoke:presets` (the panel, every preset action, linked presets, a chart save making no indicator preset, a
  refused save writing nothing and a full indicator group keeping a link, a linked preset deleted, the old VWAP after a ground
  change and a reload, the top bar on the four grounds and custom ones, an in-page contrast sweep of the 21 grounds in
  four states, the light order bar and its Buy MKT and Flatten, the gears, a second window, a reload). `smoke:ib` now
  checks the bar is unchanged on the default ground and takes the chrome's ground on every other; `smoke:embed` sets
  pane B's VWAP in its gear.

## ChartBridge 0.3.6 (2026-10-01): daily 1-minute bars to The Desk

ChartBridge (nt8/) only, on top of 0.3.5: the page, the engine and the chart version (1.8.0) are unchanged. Ships with
0.3.5 as one install. **Needs a recompile:** while flat, run `update-pc.ps1 -InstallChartBridge` (README: Keep this PC
up to date) or `nt8\install.ps1`; both copy the new `ChartBridgeBars.cs` too (it is listed in `nt8/install-files.json`;
`install.ps1` itself is unchanged), then compile in NinjaTrader (F5). **Off** until `bars = on` is in `config.txt`.
- **What it sends** (contract v1, approved by Anthony 2026-09-30): after each session closes (17:00 New York time, plus
  5 minutes), if NinjaTrader's price feed is connected, every finished 1-minute bar of that session (18:00 the day before
  to 17:00; the Sunday evening counts as Monday) for NQ, MNQ, ES and MES, from NinjaTrader's own data, to The Desk's
  `POST /api/bars`. One message per contract per session: the front month the chart uses (or `contract.<ROOT>`), plus
  any other contract of that root with fills that session. Each bar is `[t, o, h, l, c, v]`, `t` its open in UTC
  milliseconds (NinjaTrader stamps a bar at its close; ChartBridge takes a minute off), sorted, one per minute,
  `complete: true`. Only market data and the PC name (`pc`, default the Windows computer name) leave the PC.
- **Catch-up:** at the start (2 minutes in, and only once the gate below is idle) any of the last 5 sessions The Desk
  has not taken yet is sent, so the first run also delivers the day before. Weekends and the template's full holidays
  are skipped. A session NinjaTrader has no bars for (or that fails) is asked 3 times, 15 minutes apart, then not
  until the next start: nothing is looped on.
- **Never beside the chart's data work:** each bars request goes to NinjaTrader through 0.3.5's gate, last of all. It
  is queued only when the gate is idle (not stopped or stuck, no Range window or session backfill out or queued, no
  backfill still to come or due again, no minute chart's last trades out, no page loading), so nothing piles up there;
  otherwise it waits and `/diag` says what for. A window or backfill asked while a bars request is out waits behind it,
  as behind any request (one contract's minutes, about a second). A bars request NinjaTrader does not answer in 60 s
  frees the gate (Anthony: the chart never waits on bars), unlike a window or a backfill, which keep 0.3.5's stuck
  rule; a window may then go while NinjaTrader still works on it (accepted), and its late answer is not used. In
  regular trading hours (09:30 to 16:15 ET) it asks for nothing, except the catch-up after a start. Nothing on the order
  lane; the order files are byte for byte those of main.
- **Stop** (F5, closing NinjaTrader): nothing more is asked of NinjaTrader or posted to The Desk. The worker leaves any
  wait at once, a post in flight is aborted (the message stays queued), an answer that comes later is not copied, and
  Stop waits 250 ms for the worker, as the gate's Stop does.
- **Like fills:** messages wait in `pending_bars.jsonl` until The Desk takes them (10 s per request, retried every 10 s);
  ones The Desk calls malformed (400, 422) are set aside in `rejected_bars.jsonl`; `sent_bars.txt` records what was
  taken. The Desk stores by (contract, minute), so a resend is harmless.
- **`/diag`:** a `bars` section (`enabled`, `state`, `waitingForGate`, `lastSent` per contract, `waiting`, `setAside`,
  `gaveUp`, `lastRequest`, `lastError`), and the gate shows `barsQueued`.
- **Settings:** `bars = on`, `barsRoots = NQ, MNQ, ES, MES`, `pc = HOME`.
- **Checks:** `nt8/check/BarsHarness.cs` runs inside `npm run check:orders` (Mono, 112 checks): the session rules, then
  the failure scenarios through the real gate with a stand-in Desk (S1 off by default, S2 one session including both
  daylight saving changes and a Sunday open, S3 The Desk unreachable, S4 catch-up, S5 never beside a window or backfill
  and a stuck gate, S6 a stop during a request and during a post, S7 contracts per root, S8 `/diag`, RTH). A real
  post to The Desk (its `POST /api/bars` from a local run) stored the rows, refused bad input with a 400 and refused
  the tunnel's headers with a 403. `test/nt8-bars.test.js` guards the source in CI.

## 1.8.0 and ChartBridge 0.3.5 (2026-09-30): a light Range chart, an exact volume profile

Page, bar builder, fake bridge and ChartBridge; the engine only changes its version. **Needs a recompile:** run
`nt8\install.ps1` again (it copies `ChartBridge.cs` and the page files), then compile in NinjaTrader (F5). Why: on WORK
(2026-09-30 RTH) each Range page load pulled 16 to 17 hours of MNQ trades (2.8 to 2.96 million, 33 to 72 s) plus 0.3.4's
quote history, NinjaTrader showed 8.5 to 10.9 s "high latency" stalls across all its windows while Anthony was in a trade,
and pages that reconnected ran the heavy load again. Anthony's rules: the Range chart only needs the last 2 hours at open
and its bars then stay all day; the volume profile must be exact from 18:00 ET; delta runs live from page open (its own
PR); nothing about trades or range bars kept past the session; don't over engineer. Chart 1.8.0 because the delta pane's
branch claims 1.7.0. The quote requests themselves go with ChartBridge 0.3.4.1 (`quoteHours`, branch hotfix-no-quotes),
merged in here from main (quoteHours exactly as 0.3.4.1 defines it: default 0; a served window and the session backfill
never ask for quotes).
- **The served window** (nt8/PROTOCOL.md, Served window and session table): ChartBridge's `hello` lists
  `features: ["liveFirst", "profile"]`; a Range or seconds chart then subscribes with `liveFirst` and gets the last
  `rangeHours` of trades (config.txt, default 2), asked of NinjaTrader **by count** (a request by date returns whole
  trading days), sized from the live trade rate and asked once more, larger (two asks at most), when the answer does not reach back
  far enough. ChartBridge keeps that window, extended by every live trade, in memory for the session: a reload, a second
  page or a view switch gets its trades from there, from the same first trade, and NinjaTrader is not asked again. Dropped
  at the next 18:00 ET session; never written to disk.
- **The served windows and the session backfills go to NinjaTrader one at a time** (review 2 B1, B2): windows first, a
  window's second ask ahead of any backfill (review 3 S-D); a session backfill only with nothing else out (no window, no
  other backfill, no minute chart's last-trades request). A minute chart's last-trades request (20,000 by count, made since
  0.3.3) is not queued behind them, as before: it can go beside a window or another minute chart's, and is skipped (the
  forming minute as NinjaTrader sent it) while a backfill is out (review 4 S3). A window request is shared by every load of
  that instrument that comes while it is out, kept whatever load is current, asked at most twice (the second time larger),
  and after a failure not asked again for 60 s. When over 500,000 live trades come while it is out, its loads go live at
  once with no trades and a note, nothing more is held for it, and the next load asks again (review 4 B2). Every tick
  subscribe gets the served window, with or without `liveFirst` (a 1.6.x page, The Desk's relay): 0.3.5 never runs 0.3.4's
  by-date tick load (review 2 S6).
- **One unanswered request** (review 3 X1, review 4 B1, S1, S2, S4): a window or a backfill NinjaTrader does not answer in
  time (120 s, 5 min) is given up for its pages but stays outstanding, so ChartBridge asks for no tick history (no window,
  no backfill, no minute chart's last trades) until NinjaTrader answers it (the late answer is dropped uncopied) or
  restarts. Nothing waits on it: a Range or seconds load, queued or new, gets the served window from memory when there is
  one (with its gap, if a feed drop left one; the gap is asked again only when the ask can go out), else goes live at once
  with no trades and says NinjaTrader has not answered an earlier request; its live trades are not held. Queued backfills
  say they wait (the profile and VWAP notes, `/diag` state "waiting: ..."), not "building", a queued retry too, and run as
  usual once it answers, a retry with its "failed once" state back (review 5 S1). An answer and the time limit are decided
  once (Interlocked), so an answer at the limit never leaves it stuck (a late answer that comes while the time limit is
  being acted on frees the gate once it is marked stuck, not before: review 5's race2 probe caught one run in 36 left
  stuck for good); an answer that claimed it at the limit has 30 s more
  to finish its copy, then it is treated as unanswered (one Output line, `gate.stuck` set) until the copy ends (review 5 N2).
  `/diag` `gate.stuck` and `stuckSinceUtcMs`; only the request that made it stuck frees it (review 6 N1). Stopping
  ChartBridge clears it and the instruments' tables and marks the gate stopped until the next start (review 6 S1): after
  it no tick request goes to NinjaTrader (nothing is queued, no worker starts, no minute chart's last trades are asked, a
  second ask is not made), an answer that comes later is dropped uncopied, and any backfill retry still to come is
  cancelled with its timer (a failure answered after the stop schedules none). So no timer of the gate outlives the stop.
  The gate's worker has its own thread (review 6 N2); its waits end at the stop, and Stop, on NinjaTrader's thread, waits
  for it at most 250 ms (review 6 S2). A worker still inside a NinjaTrader call by then ends when that call returns and
  sends nothing more (one Output line says so). Review 5 N6: one harness run in 12 exited with code 1 after ALL PASSED,
  when Mono's timer thread was aborted at exit; the harness now waits 5 s for the worker before it exits.
- **The session table:** per instrument, the session's volume at each price per half hour of New York time, fed by the live
  trades. Whole when ChartBridge and the feed were up before 18:00, however late the first trade (review 3 S-A). When
  ChartBridge starts after 18:00 (NinjaTrader started, or the add-on recompiled), and only then, ONE backfill of the session
  per instrument in `profileRoots` (config, default MNQ, NQ, ES, MES, in that order whatever order their first trades come
  in): once the feed has been up a minute and no page is loading (review 3 S-E), one at a time,
  once per session, never for a page load, never while the market is closed. It asks by date from 18:00; NinjaTrader's help
  says a by-date request covers whole days from midnight, so the answer also holds the previous day's hours before 18:00,
  which are copied and then left out. On NinjaTrader's callback thread only the copy (timed, `/diag` `callbackMs`); the rest
  on a worker, joined to the live trades by the 0.3.3 seam. On an error or an empty answer it is asked once more after 60 s,
  then given up with a note; at most 500,000 live trades are kept for it, none once it fails or times out (review 2 S1). At
  18:00 a new table starts; the finished one is kept (one small file per instrument, `profile-MNQ.txt`, not used when over 4
  days old) for the weekend's "last session" profile and a later weekly profile. A trade more than 2 minutes off the clock
  never opens a session (review 2 S7).
- **A feed drop** (review 2 S2): when a price feed goes from Connected to anything else, or a market data reset arrives, while
  the market is open, the table is not whole for the rest of the session ("Volume profile missing trades: the data
  connection was down at HH:MM ET"), the served window keeps the gap and is asked again at a load at most once in 10
  minutes (review 3 S-G), and live pages get the profile again. A drop while the market is closed marks nothing, and the page
  shows a drop only inside the trading its profile counts (review 3 S-B). Range and seconds views keep their VWAP (the
  table's sums plus the page's trades) and say what it misses; with no table from 18:00 they say why there is none (review
  3 S-C). A feed down across 18:00 with ChartBridge running: the table counts from the first trade and says so, no backfill.
- **No formatting under the market data lock** (review 2 S4): the `profile` message, the saved file and its read are made
  from copies with no lock held.
- **The `profile` message:** the table before `ready` (exactly up to the page's last trade), again when the backfill makes
  it whole. The page's volume profile is its rows plus every trade after them, on Range and minute views alike: equal to
  the profile of every trade of the session (Session and RTH). While the backfill is to come the profile says "Volume
  profile building, from HH:MM ET"; with none (not in `profileRoots`, or it failed) "Volume profile since HH:MM ET".
- **With 1.6.1's kept profile** (merged from main): the profile is built from ChartBridge's table when the page's own trades
  are not of a later session; an RTH profile with nothing of today's RTH yet is kept from the table's `last` (the finished
  session), so a minute view overnight or on a weekend shows the last session exactly with no tick history. 1.6.1's order
  account check is kept; 1.8.0 drops only its "Still loading" block (orders and Flatten work during any load).
- **With 1.7.0's delta pane** (merged from main): the served window's trades carry no side, so the pane counts live trades
  from the page's open, as it does with 0.3.4.1's default; a window with no sides does not read as an old ChartBridge (the
  first live trade says whether sides come). A reconnect or a view switch served from ChartBridge's memory is a later load
  of the same instrument: the pane's count and its "missed N s" carry on. Its range-bar replay starts where the window's
  range bars are built from (the window's first trade).
- **Range bars start where they match** (docs/RANGE_BARS.md, Served window): the page draws range bars only from the first
  bar proven to be NinjaTrader's own (`RangeSync`: a session start, or a swing of more than the range each way), never
  offset bars before it; a quiet window shows none, with a note, until one is proven. A window that starts with its
  session's first trade is proven from it (the table says no trade of the session came before). Once drawn, bars stay all
  day: over 2.5 million trades the page drops only earlier sessions' trades (`trimCount`). Seconds bars start at the first
  whole bar.
- **VWAP** of range and seconds bars starts from the table (its price times volume less the page's trades, in whole
  ticks): the VWAP of every trade from 18:00. None while the table builds.
- **HEAD requests** (WORK W17): `HEAD /` and a HEAD for any page file got a 500 and a "request failed" line in the Output
  window (ChartBridge wrote the body, which HttpListener refuses on a HEAD reply). Now the same status, Content-Type and
  Content-Length as GET, and no body.
- **Orders keep working during any load:** order actions no longer wait for a view's load; a price order (click to place)
  needs a known last price (the last seen for the instrument is kept across loads), market orders and Flatten never wait.
  The order path itself is unchanged (`ChartBridgeOrders.cs`, `ChartBridgePin.cs`, `live/order-ticket.js`, `live/pin.js`,
  `install.ps1`, the fake bridge's order handling).
- **Gone** from the live-first branch's first design: the older history pulled after `ready` (`more`, `olderTicks`,
  `recentTicks`, the fill join and its harness cases, the 1-minute stand-ins, the reload button, the 120 hour tick cap,
  `quotes: false`, the quote start of review 1).
- **Old bridges and relays:** ChartBridge 0.3.4 and older get the subscribe of 1.6.0 and its full load. A 1.6.x page and
  The Desk's relay (which passes no `features` and drops `profile`) get the served window from 0.3.5, with their own
  profile note; The Desk gets the exact profile once its relay passes both and it vendors chart 1.8.0.
- **`/diag`:** `books` (per instrument: the table, the last one, the backfill with its state, time from the ask, time on
  NinjaTrader's thread and trade count, the served window and its request, the live trade rate; then the gate,
  `profileRoots` and `backfillTotalMs`) and `windows` (the last 20 served-window loads).
- Tests: `nt8/check/WindowHarness.cs` (in `npm run check:orders`): the table exact per half hour and price, RTH edges,
  the profile message, the 18:00 rollover, the weekend, NinjaTrader in four time zones across the DST weeks, the whole
  rule (a minute), profileRoots, a stale last trade at start, the bounded live list, a mid-session start whose backfill
  joins the live trades exactly and is never asked again (with the time on the callback thread), the backfill waiting for a
  window request that is out, its one retry and its time limit, the served window by count with its second ask (never a
  third), a 1.6.x-style subscribe and a reload from memory with no request, two pages and a resubscribe sharing one request,
  no re-ask right after a failure, a feed drop, the text format; review 4's probes: a window queued behind a stuck request,
  later loads while stuck, a gapped window while stuck, backfills waiting then running, a minute page and its last trades
  beside a window, the 500,000 trade cap, an answer racing the time limit (1.5 million trades at 240 to 305 ms of a 300 ms
  limit), and the requests counted for a mid-session start with two Range pages and a reconnect storm; review 5's: a retry
  queued behind a stuck request, an answer whose copy never ends, an answer while the gate is being marked stuck, and a
  stop while a request is out and a retry is to come; review 6's: a window answered after the stop with a second ask
  due, a load whose minute history is answered after the stop, an old answer after a stop and a start, and a stop while
  the worker is inside a slow NinjaTrader call; all on a simulated
  clock (review 2 N7). `test/live-first.test.js`:
  `RangeSync` on 240 made-up histories, the VWAP seed, the trim, the profile from rows equal to the profile from every trade
  (Session and RTH, an early close, both DST changes), and the fake bridge's protocol against its tape.
  `npm run smoke:live-first`: NQ Range 40 in a busy market (trades, bars, VWAP and the profile equal to the tape's), a
  reload and a second page from memory with the same first bar, 15s, a 1m profile with no tick history, a building table
  then its push, an instrument not in profileRoots ("since"), a feed drop and a reload after it, a market order and Flatten
  during a Range load, a quiet market, the Sunday open, the 18:00 rollover, an old bridge.

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
- **Delta while trading: only measured sides count** (Anthony, round 4: "Delta is a tool I use WHILE trading, not for
  historical look backs"). ChartBridge 0.3.4.1 asks NinjaTrader for historical quotes only for the backfill's last
  `quoteHours` (config.txt; 0 by default, because 0.3.4's quote requests over the whole tick window are the suspect in
  NinjaTrader freezing on WORK), and gives every trade before that a tick-rule side (`sm` 3). The pane counts only trades
  whose side was measured: every live trade, and the backfill from its first trade whose side came from the quote or
  the aggressor flag (`sm` 2 or 1, `TickStore.firstMeasured`) on. With quoteHours 0 that is the page's opening. The
  window (`deltaCoverage` in live/live.js), counted by the trades' places in the store, never by their times:
  - **the backfill's measured window:** from its first measured trade on (round 6: it counts); every trade after it is held (the
    backfill is one run up to ChartBridge's seam, then every live trade). Labelled "since HH:MM ET";
  - **none in the backfill:** from the first live trade on (round 6: it counts), or from the moment the page went live (this PC's
    clock at `ready`) when that is earlier, so a page open across 18:00 in the 17:00 to 18:00 break restarts the count
    at 18:00, whole. That moment counts 5 s later (`LIVE_MARGIN`), or this PC clock's lag plus 2 s (`CLOCK_SLACK`)
    when that is more (review 2 S1): every live tick carries the data's UTC time `u` and ChartBridge's receive time
    `rx`, and `u` minus this page's clock (or minus `rx`, whichever is more) is at most how far the data's clock is
    ahead of this PC's. A tick showing more lag than the delta was built with builds it again at once with the later
    start, the one on screen kept until then. Labelled "since HH:MM ET (page opened)". Review 2's scenario C (the clock
    10 s behind, a 1m view going live at 17:59:53 with nothing traded in the break) reads "Cumulative delta +N since
    18:01 ET (page opened)", never a count from 18:00;
  - after a trim, not before the store's first trade.

  The count starts again at 0 at 18:00 ET: a page open across 18:00 counts the new session whole. A bar that started
  before the window is left out whole (blank, never a part of a bar); a session that started before it counts from 0 on
  its first complete bar, and the pane's title says since when, with that bar's exact start (seconds and tenths when
  not on the minute, `util.fmtExact`, review N1): "Cumulative delta +1,234 since 10:04 ET (page opened)" or "since
  12:01:15 ET"; the legend "Delta since 10:04 +1,234", with a dashed line at that first bar. A session counted from
  18:00 has no label. Before the first complete bar, "starts with the next full bar". Bar delta counts each complete bar
  the same way. **On 5m, 15m and 1h** (round 5, review 4 S1) the bar holding the window's start is not left out: its
  trades count from that moment by their own time (`CumulativeDelta` option `byTime`), it opens at 0, and the label
  gives the exact moment ("since 13:00:00.3 ET (page opened)"), so a 1h view counts at once, not from the next hour.
  With no backfill trade measured, the first live trade after a build moves the start to it (every trade from it on
  is held, and it counts, round 6), a few seconds before the 5 s margin. The status line's feed delay (`rx - u`) said "(PC clock ahead)" when it was negative, which means the
  PC's clock is behind the data's; it now says "(PC clock behind)" (wrong since 1.1.0).
- **The count survives a reload of the same instrument** (round 5, review 4 B1; Anthony uses the delta while trading):
  the counted trades live outside the store every load replaces, per instrument (`K` in live/live.js). The count begins
  with the instrument's first `ready` (its window and the backfill's measured trades), then takes every live trade of
  it, also those arriving while a later load of it is on its way. A later load of the same instrument (a ChartBridge
  reconnect, or a view that needs more ticks, such as 1m to 15s) builds the delta from the count, so its start and
  "since ... (page opened)" stay as they were; its trades go on the new load's bars, on Range by their order in the new
  store (`BB.RangeReplay`, round 6, review 5 S1: the builder fed the store as the chart's bars were, each counted trade
  matched to its store trade), never by their time, so trades sharing a millisecond across a range-bar boundary stay in
  their bar and the candles do not move after a reload. The backfill's measured trades are not copied on the first load (the count points into the
  store; copying them doubled the heap in smoke:perf, 99 MB against its 80); only before a later load of the same
  instrument is this session's part of them copied. Its trades are dropped at each 18:00 ET (the count starts again at 0
  there) and the oldest 500,000 past 2.5 million, like the store: at most one session of one instrument. A switch of instrument starts a new
  count, labelled "since HH:MM ET" with no "(page opened)". Trades that arrive neither live nor with a measured side (while
  a reconnect is down, or held by ChartBridge during a reload and sent only in the new backfill, with tick-rule sides
  under quoteHours 0) are not in it, by the measured-sides rule, and the label says so (round 6, review 5 B1): the
  first trade of the later load measures the hole on the trades' own clock from the last one counted (it can be no
  longer; a quiet market can make it read longer than what was really missed), for this session only, and from 1 s the
  pane's title and the legend add the session's total: "Cumulative delta +123 since 13:00:15 ET (page opened), missed
  32 s", or "since 18:00 ET, missed 32 s" for a session held from its start. A browser reload (F5) or a second tab is a
  new page and starts a new count, "(page opened)".
- **Nothing extra is loaded for the delta** (round 4): every view asks for the ticks it asked for before 1.7.0 (none on
  1m, 5m, 15m and 1h; 8 hours on 15s and 30s; Range its sessions, 9 to 33 hours), and switching the pane on never
  reloads: it is built from the store, so orders are never refused for it. On a minute view with quoteHours 0 the store
  holds the live trades since the page opened, which is the delta's window anyway. Round 3's 2-hour tick load for
  minute views, Range's extra hour and the minute-history proof of an 18:00 open are gone with the need for them.
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
  and `--no-sides` for 0.3.3; its hello says `fake-0.3.4` or `fake-0.3.3`. `--quote-hours=N` is ChartBridge 0.3.4.1's
  quoteHours (only the backfill's last N hours measured, `sm` 2; before them the tick rule, `sm` 3; without the flag all
  measured, as 0.3.4). Each live tick's `u` is on the exchange clock and `rx` on the PC's (`--pc-clock-offset`, default
  the exchange clock's), so a PC clock behind the exchange can be tested; `--cme-hours` keeps CME's hours (nothing from
  17:00 to 18:00 ET or over the weekend); `--load-delay-ms` sends a load's ticks and `ready` that much later with no
  live trade meanwhile, as ChartBridge holding them. Like ChartBridge, it now sends no tick backfill for `tickHours` 0 and no
  backfill trade stamped after now (it sent the forming minute's walk, to :59.9). Its order handling is unchanged.
- **Unchanged:** the order path (`live/order-ticket.js`, `live/pin.js`, `test/orders-smoke.mjs`,
  `test/order-ticket.test.js`, `test/fake-orders.mjs`, the fake bridge's order handling) and everything under `nt8/`,
  byte for byte. The pane covers nothing of the price chart: the position, working orders and stop and target lines stay
  in it as before, and a click or Shift+click in the pane never places anything.
- Tests: `test/delta.test.js` (the candles on 15 s bars by hand; range bars of both styles through the page's bar
  builder against a count by hand, phantom bars blank; 18:00 ET over a weekend and on both DST changes from real UTC
  times, and 17:59:59.999 against 18:00:00.000; unknown and missing sides; bar delta per bar and each session's last close
  against its sums; coverage: a later start, exactly at the start, `byTime` on 5m bars (round 5), `RangeReplay` against
  the store's own path with three trades a millisecond (round 6), a range bar that started
  before; the TickStore's sides across block boundaries after a trim; the page's path, backfill then live, against a
  rebuild from the store and the store's own sums, on range and 5m bars; on a stand-in canvas: the pane only with the
  layer, 20%, the candles inside it, off draws the same with or without a delta, bar mode from zero, the note draws
  nothing else, the divider's keys, drag and limits, one crosshair and a drag in the pane, frames that never touch the
  delta, the closed candles' paths kept between frames, the divider band clear of the plot and the axis and "Jump to
  live" above the pane, no save from a key that moves nothing, `fmtExact`); `test/prefs.test.js` (default on for the
  main pane with no chip, the profile then the sixth chip, off on a new pane, search, show and hide, pin by hand and
  remove; a 1.6.0 save without the key, with six chips already, saved after Hide all and its Restore, an explicit off,
  junk; the 1.5.3 and 1.3 carry-overs; the Show option and the height per pane, fresh reads, limits, junk,
  `__proto__`, per prefix); `test/bar-builder.test.js` (Range's hours as before 1.7.0). The 1.6.0 tests that count what is on the main pane count the delta pane too and still check what they
  checked; the chip strips are those of 1.6.0 again.
  `npm run smoke:delta` (NQ Range 40 on sample data at 13:00 ET: on by default under the chart at 20%, in the count,
  with no chip (pinned from the menu for the chip checks); candles in both colors in the pane; its totals per session
  equal every trade the page received, counted in the test, also after 3 s of live trades, with no new delta; the crosshair over the pane; Bar delta from the gear and
  back, both after a reload; the black ground; 5m and 15s rebuilt once; the divider dragged, keyed (ArrowDown, End,
  Home, within the limits) and kept after a reload; the divider band and "Jump to live"; the chip, which shows it
  again at once with the same delta (review S5), Hide all and Restore, search, the x and the +; ChartBridge 0.3.3: the
  pane empty, the note, no number; 15s with 2 hours of ticks labelled "since 11:00:15 ET"; the legend and title read in one
  task; mounted panes: pane-2 off, added from its menu, `setIndicatorOption('delta', 'show', 'bar')` and its
  height under `desk:`; review B1 at 02:05 ET on Range: The Desk's relay capping `tickHours` at 8 and NinjaTrader
  sending 8 of the 11 hours asked, each labelled partial from its exact start, never plain, and counting every trade
  from that start; review S1: 1m opened at 17:59:20 with nothing traded in the break counts the session whole from
  18:00, every trade received; the clock at 17:59:35: at 18:00 a new session from 0 with no rebuild, the title and the
  value read in one task after a drawn frame (review 2 N1); round 4: a 1m first load asks no ticks and counts from the
  page's opening; 15s with quoteHours 0 counts none of its 8 hours of backfill, only the live trades, "since 13:00:15 ET
  (page opened)", and with quoteHours 1 from the first 15 s bar after the backfill's first measured side, "since
  12:01:15 ET", each equal to every trade received from then; the pane switched on in a 1m view loaded without it: no
  new subscribe, never LOADING; scenario C (review 2 S1), the PC clock 10 s behind, a 1m view with no tick backfill live
  at about 17:59:53: "since 18:01 ET (page opened)", never a count from 18:00, every trade from 18:01; round 5: 1h with
  no backfill counts at once from the page's opening, every live trade; 5m then 15s (a reload for 8 hours) then a
  ChartBridge reconnect (`/test/drop`) keep one count with every live trade of all three loads, still "(page opened)";
  a count from quoteHours 1's window kept across a reconnect; another instrument starts a new count without it; round
  6: 5m to 15s with the fake holding the trades 3 s (`--load-delay-ms=3000`) reads "missed 3 s" in the title and the
  legend; the fake bridge killed for 8 s and started again on its port: the same count, every live trade before and
  after, "missed 11 s").
  `test/delta.test.js` adds `TickStore.firstMeasured` (a quote window after tick-rule trades, a tick-rule trade inside
  it, a trim, none, the aggressor flag), a prepend through `_addBlockFront` and `_put` after a trim and with new blocks
  (every side stays with its trade), and review 2's width cases (800 to 803 and 1000 px with every bar in view, 800 to
  803 with the view full: the pane as drawn equals the pane drawn from scratch). The live
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
- **Open for Anthony:** (1) Settled (round 4): delta while trading, from measured sides only (above). (2) The candle colors: the pane uses the
  bull and bear candle colors, not the trade-side green and red (the house style keeps those for sides and P&L). (3) A
  range bar with no trade (a NinjaTrader-style phantom bar) has no delta candle; should it show a flat one at the
  running value? (4) Unknown sides count in the legend as contracts ("· 37 unknown"); trades or a share instead? (5)
  The delta pane has no chip by default (review N5); pin it from the menu for one, or say if it should have the sixth.
- **Merged with main** (ChartBridge 0.3.4, 7c28d55): `test/trade-sides.test.js` now checks that `pushAll` passes all
  five places of a backfill trade and that the store keeps the sides from both formats.
- **Merged with main again** (e6f035e: the per-PC updater and ChartBridge 0.3.4.1, config.txt `quoteHours`, default 0):
  `live/COMPAT.json` now says page 1.7.0, still working with ChartBridge 0.3.2 and later (the delta pane shows its note
  before 0.3.4; 0.3.4.1 recommended). The fake bridge keeps `--quote-hours` as the stand-in for 0.3.4.1 in the tests:
  main's fake bridge does not model it.
- **Merged with main a third time** (588766e: chart 1.6.1, the order account after a reload, Cancel all by id, the volume
  profile keeping the last session): 1.7.0 carries all of 1.6.1. Conflicts in the version lines (1.7.0 kept), the
  legend row (the profile's day and the delta both kept), the indicator exports, CHART_STYLE, EMBED, live.css, the IB
  smoke (main's wait for the repaint) and the fake bridge (main's `--market-hours`, `--tick-shift-ms`, `--version` and
  shared-out minute volumes kept beside this branch's `--quote-hours`, `--cme-hours`, clocks and no future trades; its
  hello says `fake-0.3.4` unless `--version` is given). `live/COMPAT.json`: page 1.7.0 above the 1.6.1 line.
- **For the live-first merge (PR #8, after this one; review 2's trial merge):** the TickStore's side bytes are added,
  dropped and written only through `_addBlock`, `_addBlockFront` and `_put`, so live-first's `prependAll` puts its front
  blocks in with `_addBlockFront` and writes each older trade with `_put` (its `[t, p, v, s, sm]`); keep this branch's
  five-place `pushAll` and drop the three-place one. When the last older chunk is in, add the older trades to
  `D.backfill` and call `deltaStart({ keep: true })` (with quoteHours 0 they change nothing; they matter only when
  quoteHours reaches past the recent window); after a reported `gapMs`, the window must not start before the first
  recent trade. Round 4's unused `deltaHistoryGrew` and `D.historyGapFrom` are removed (review 4 N2); the PR says what
  the merge adds.

## ChartBridge 0.3.4.1 (2026-09-30): no historical quote requests by default

ChartBridge (nt8/) only: the page, the engine and the chart version are unchanged. **Needs a recompile:** run
`nt8\install.ps1` again, then compile in NinjaTrader (F5).
- **Why:** on the trading PC NinjaTrader froze several times a minute with 0.3.4. Every tick chart load and every
  reload (including the page's reload after a 5 s lag reset) asked NinjaTrader for 8 hours (up to 24) of historical Bid
  and Ask ticks next to the trades. They did not answer within 2.5 s, so they most likely kept running inside
  NinjaTrader while the next reload asked again. Those quotes only label past trades as buys or sells for cumulative
  delta, which the chart does not show yet, and delta is a tool used while trading.
- **Now, by default, no Bid or Ask history is asked for at all.** The tick backfill goes out as soon as the trades are
  in (no 2.5 s quote wait). Past trades get their side by the tick rule, and say so (`sm` 3), so a page can tell them
  from measured sides. Live trades keep their side from the live bid and ask, as before (that costs nothing extra).
- **New setting `quoteHours`** in `config.txt`: `0` (default), `1` or `2`. With 1 or 2 a tick chart asks for only the
  last 1 or 2 hours of Bid and Ask (at most its tick window), for a measured test later. Anything else is 0, with a
  line in the Output window. NinjaTrader's help documents no way to cancel a request once asked, so a reload never asks
  again while an earlier Bid or Ask request for the same instrument is still unanswered (that load goes by the tick
  rule and `/diag` says why).
- **`/diag`:** `sides.<root>.lastLoad` has `quoteHours`, `quoteWindowHours` (hours asked, 0 when none) and, at 0, the
  note `quotes not requested (quoteHours 0)`; `sides.<root>.quotesOutstanding` counts unanswered Bid and Ask requests.
  The other counters are unchanged.
- The order code (`ChartBridgeOrders.cs`) and the PIN (`ChartBridgePin.cs`) are unchanged.

## Unreleased (2026-09-30): keep each trading PC up to date (`nt8/update-pc.ps1`)

Approved by Anthony on 2026-09-30. Page and tooling only; nt8/*.cs is unchanged (ChartBridge 0.3.4 as on main).
- **`nt8/update-pc.ps1`**, Windows PowerShell 5.1 and git, no admin: `status`, `check` (dry run), `update` (the
  automatic path), `-InstallChartBridge`, `rollback`, `pause`, `resume`, `register`, `unregister`. The scheduled task
  runs `update` for the signed-in user when Anthony signs in (after 2 minutes; an at-startup trigger would need admin)
  and once a day at 17:05 New York time (`-DailyAt`), converted to the PC's clock when registering: futures are closed
  from 17:00 to 18:00 ET, so no check lands while Anthony trades (Anthony's ruling). A missed daily run is not started
  later (no StartWhenAvailable: it could land in the trading day); the sign-in check covers a PC that was off. Never
  two runs at once, 30 minutes at most. The task runs its own copy, `updater\bin\update-pc.ps1`, which changes only
  when Anthony runs `register` or `-InstallChartBridge`; the automatic path never moves the clone (it fetches and
  stages from git objects), so a newer ChartBridge.cs never appears where `install.ps1` copies from. git never asks
  anything (no terminal, Credential Manager or askpass window; ssh in batch mode). README: "Keep this PC up to date".
- **The page updates by itself**, only from the newest commit on `main` whose CI is green on ubuntu-latest and
  windows-latest (read from GitHub without a token, as The Desk's updater does), and only when the ChartBridge compiled
  on the PC is at least the page's `minChartBridge` in **`live/COMPAT.json`** (new). The compiled version comes from
  `/diag` when ChartBridge runs (the newest observation, a downgrade too, with a warning in the log), otherwise from
  what the tool recorded and never above the Version in `AddOns\ChartBridge.cs`; unknown means no update, and the log
  says why. Files are staged, then written into `www` one by one through a temporary file and an atomic replace, the
  engine first and index.html last. A journal (`updater\swap.json`) is written first: a run cut off by a power loss
  or a closed lid is finished, or undone to the previous page, at the start of the next run, before pause and every
  other gate. The previous page, kept for `rollback`, is only ever copied from a `www` that is exactly the installed
  build, so it is never a mix.
- **ChartBridge never installs by itself**: a new one is staged under `updater\staged\`, announced (page, Windows
  notification, log, `status.json`), and copied into `bin\Custom\AddOns` only by `-InstallChartBridge`, which Anthony
  runs while flat, with the NinjaScript Editor closed, before pressing F5. It installs from `staged\` (the announced
  green commit), shows both versions before asking, writes all three files to temporary names and then replaces them
  back to back. A page that needs the new ChartBridge waits until `/diag` shows it (COMPAT decides).
- **"Update ready: reload when flat"** (`live/update-notice.js`, loaded by `live/index.html` only): the page reads
  `update.json` (written by the updater into `www`: versions and a build id only) about once a minute and says so on
  the status line; also "ChartBridge x.y.z ready to install (flat, then F5)". It never reloads, never covers the order
  bar or the chart, and never moves them: it takes no room of its own on the status line (checked from 700 to 1920
  px). A screen reader hears the whole text once; polling survives an error. "Page update cut off: run update-pc.ps1
  status" if an install could not repair itself.
- **`nt8/install-files.json`**: the one list of what is installed; `nt8/install.ps1` now reads it (same files as before,
  plus `update-notice.js`).
- **COMPAT.json in practice**: a release whose page needs a newer ChartBridge raises `minChartBridge` and adds a
  `history` line; `page` follows `package.json` (a test holds both, and that `minChartBridge` is never above the
  ChartBridge in the same commit).
- Tests: `test/pc-updater.tests.ps1` (run by `npm test` through `test/pc-updater.test.js` with Windows PowerShell 5.1 on
  Windows and pwsh elsewhere): the CI gate, the ChartBridge compatibility gate, unknown version, staging and the file
  swap, a power loss at every step of an install (the review's p1 case too), rollback, pause, the version rules (the
  review's p2 downgrade case), no .cs file ever written to AddOns by the automatic path, `-InstallChartBridge`, the
  clone never moved, the pinned copy, and the scheduled task registered for real on the Windows runner (both
  triggers and the daily time). `npm run smoke:update`: the notice with an open position and the width sweep.
- Second review round: a page that opens while files are written reads "Page files are being updated: do not reload
  yet" and never takes that build as its own ("installing" for over two minutes reads as cut off, never "reload");
  `-InstallChartBridge` records the copy at once, so a page that cannot be written then follows on the next update
  instead of a STOP; `update-pc.ps1 repair` rewrites page files only (no message points at `install.ps1`, which also
  copies .cs files); `register` pins the staged copy of the newest green main, or the running file only when it is a
  green commit's blob, and every run from the pinned copy checks its sha256; git runs through one allow-listed entry
  point with gc and maintenance off; the staged add-ons and updater are checked against the commit's blobs; the pinned
  copy never goes back to an older commit; README runs everyday commands with the pinned copy; each run moves the
  daily trigger back to 17:05 New York time if the PC's clock drifted; `status` keeps what /diag said; the finish
  after a cut-off drops files the new build no longer has.
- Review of the first version (independent): B1 (no journal, a mixed page kept as the rollback copy), B2 (the clone
  fast-forward), S1 to S7 and the cheap nits are fixed as above. Left as notes: N3 the 403/429 mapping is read, not
  tested (junk, empty and refused answers are tested); N11 with OneDrive Known Folder Move, `www` and `updater\` sync
  and OneDrive can hold a file longer than the 3 s retry (the install then fails and is undone, never mixed). N12 (a
  PC in another time zone drifting by the DST difference until `register` ran again) is fixed: every run moves the
  daily trigger back to 17:05 New York time (second round), and the trigger is kept on the PC's own clock (third
  round).
- Third review round:
  - `-InstallChartBridge` is all or nothing. If one add-on file is held past the retry (the NinjaScript Editor,
    antivirus, OneDrive), every file already replaced is put back from the backup and checked by hash, and it says
    nothing changed. If the put-back fails too, or a power loss cuts the copy (it is recorded in `state.json` before
    the first replace), it says "DO NOT press F5: ChartBridge files are mixed. Run update-pc.ps1 status and report"
    on the console, in `update.log`, in `status.json` and on the page, until AddOns holds one whole set again.
  - The daily trigger's StartBoundary is written as local wall-clock time with no UTC offset.
    New-ScheduledTaskTrigger wrote the offset of the day, which keeps a trigger on UTC: registered in summer, it
    would have run at 4:05 PM New York time all winter. The drift check reads the wall-clock time from the string and
    treats an offset as drift. A failed move is recorded and shown by `status`, and `register` warns when run from
    an elevated window. README: a one-line check of StartBoundary.
  - The pinned copy stops when its `pinned.json` is missing, and its STOP reaches `status.json` and the page
    ("Updater stopped").
  - `register`'s offline fallback never pins an older updater than the pinned one.
  - `repair` writes the clone's page only when its COMPAT allows the ChartBridge here, or says plainly it could not
    check, and names the clone's branch and commit.
  - git's `symbolic-ref`, `remote` and `hash-object` are allowed only in their reading forms.
  - `status` takes the lock before it reads `state.json`.
  - A run cut off right after saving `state.json` leaves the page reading "installed", never "cut off": the page is
    told first, after every file's hash is checked again.
  - The notice's commands name the task's copy (README: Keep this PC up to date).

## 1.6.1 (2026-09-30): the order account comes back after a reload or a reconnect, and the volume profile keeps the last session

Page and engine only; nt8/ is unchanged (review 2 S3). Run `nt8\install.ps1` again after pulling (it copies the page
and engine files); **no NinjaTrader recompile, no F5**. Works with ChartBridge 0.3.2 to 0.3.4.1 as they are.
**It loads no tick history beyond 1.6.0's** (Anthony, 2026-09-30, after ChartBridge's big loads froze NinjaTrader
during RTH: "smoothness and low low low latency"): the whole session on minute views and the last session's profile
after a weekend load come with chart 1.8.0's session volume-at-price table from ChartBridge 0.3.5. The Desk gets it
with the new `live/live.js`, `live/live.css` and `src/chart-engine.js` (`live/order-ticket.js` is byte-identical to
1.6.0). Two of Anthony's rulings of 2026-09-30 and his answers of the same day, then three reviews (fixes marked
"review", "review 2" and "review 3"). `live/COMPAT.json` (from main's updater):
page 1.6.1, `minChartBridge` 0.3.2 as before.

### The order account after a reload or a dropped connection (Anthony: "the account I was using", not Sim101)

- **Restored when allowed.** On the trading page, when trading comes on the order bar selects the account this tab
  is on, if ChartBridge's `tradeAccounts` has it now:
  - after a reconnect that keeps the page (including ChartBridge 0.3.4's lag reset) or a PIN entry on the kept page:
    the account it was on, so a reconnect never switches the account;
  - after a reload of the tab: the account that tab was on (sessionStorage `live-account-tab-v1` under the prefix,
    which survives a reload of the same tab; review S1);
  - in a new tab: the account last picked on this PC (`live-account-v1` under the prefix).
  Otherwise the bar is on Sim101 (or the first allowed account when Sim101 is not allowed, as before) with the note
  "Last account EVAL-1 not available, on Sim101." in the warning color; the stored picks are kept, so a later load
  tries them again. The rule is `LivePrefs.orderAccount(allowed, wanted)` in live.js. Both keys are written by a pick
  in the order bar, never by a fallback. This replaces 1.6.0's safety default ("the order account is never read from
  storage") and answers the 1.6.0 open question (review 2, S2).
- **Armed always starts off** after a load, a PIN entry and a reconnect. It is never saved or restored. It also
  turns off if ChartBridge's list changes while trading and the account in use is no longer on it.
- **Very visible.** Each time trading comes on, the Account picker gets a ring for about 3.6 s (purple, amber on the
  fallback; a still ring with reduced motion) and the order bar's state row says which account orders go to: "On
  EVAL-1, the account this tab was on. Armed is off." after a reload ("the account of the tab that opened this one" in
  a tab copied with window.open, "the account this tab's session was on" in a duplicated tab; review 2 N3; "the last
  account picked" in a new tab), "Still on EVAL-1.
  Armed is off." after a reconnect, "On EVAL-1 (picked while trading was off). Armed is off." when the picker was
  changed during a drop (review N3), or the fallback note. It goes after 8 s (the fallback's after 15 s), and at once
  on a pick, when Armed goes on, and when trading is lost (review S2). The note takes what is left of that row, never
  wraps and is cut short on a narrow screen; the ring is a shadow; neither moves the chart (1440 and 400 px).
- **The tab title and the ARMED pill name the account** (review S5), since two tabs on two accounts is now the
  design: "ARMED · MNQ · EVAL-1" while armed ("ARMED" stays first, so a narrow tab still shows it), "MNQ · EVAL-1 ·
  Live Chart" otherwise, and the pill "ARMED · EVAL-1". The order bar keeps its size.
- **Other accounts by name** (review S3): "Other accounts on MNQ: EVAL-1: LONG 1, 1 order · EVAL-2: 2 orders" in the
  order bar's state row, in the warning color while one of them has a position. It wraps on a narrow screen rather
  than being cut short, so a live trade on another account is never hidden (review 3 S2; the first cut kept it to one
  line and cut "LONG 1" off at 390 px). 1.6.0 showed only a dim count.
- **The account shown is the account used.** Every order path sends for `TR.account` and only after `ready()`, which
  now also refuses if the picker does not show `TR.account` ("Nothing was sent: the account shown was not the order
  account. The picker is back on EVAL-1; click again to act on EVAL-1."; review N2). Checked: order bar Buy and Sell,
  click-trade and Shift+click (`orderPlace`), Flatten, Cancel all, single cancel (the x) and modify (dragging a
  line). The x and the drag also refuse an order that is not on the account shown ("Not sent: that order is not on
  EVAL-1.") or no longer working ("Not sent: that order is no longer working."; review N4). While trading is off
  there is no order account at all. The fills follow the picker as in 1.6.0.
- **Cancel all, once clicked, finishes** (review N1, then review 2 S1, S2, N1, review 3 S1, S2, S4, N1). Its ids are
  the working orders of the account and instrument shown at the click, after `ready()`. They go out by order id,
  fewer than 6 order actions of any kind in any 1.1 s (ChartBridge refuses more than 10 a second; the other 4 are
  Anthony's, Flatten above all), and **the rest keep going out whatever Armed, the picker or the instrument show
  afterwards**: Anthony asked for those cancels, a cancel only takes an order away, and each goes to that order's own
  account. So "the account shown is the account used" holds for every order, change, Flatten and every Cancel all
  click; only the tail of a Cancel all Anthony already clicked can go out after a switch, and the state row says so
  while it does, "Cancelling on EVAL-1 MNQ: 12 left (6 a second).", whatever account or instrument is shown, in the
  warning color while that account or instrument is not the one shown, and wrapping on a narrow screen (review 3 S2).
  - **The newest click goes first** (review 3 S1): each Cancel all click is its own queue, so a Cancel all on the
    account shown goes out at the next slot of the pace, not behind an earlier one on another account (the first
    cut sent Sim101's 3 cancels 2.9 to 4.0 s after the click, behind 22 of DEMO-EVAL's).
  - **Nothing is locked** while it runs: Armed, the account picker, the instrument and Flatten all work. 1.6.1's first
    cut locked the picker and Armed until the last cancel, and an instrument switch then dropped the rest and kept
    Flatten out of reach for up to 2 s per 16 orders (review 2 S1). The picker lock is gone too: its only purpose was
    to stop a late cancel going out while another account is shown, which is now the rule, named on screen, and it
    would keep Anthony from flattening another account for those seconds.
  - Each send skips an order no longer working (filled, cancelled). **Flatten** during a batch takes the rest of that
    account and instrument off the batch (ChartBridge's Flatten cancels them), so no red "No working order" follows
    (review 2 S2); the x on one of them takes it off too.
  - **A second Cancel all** while one is under way adds only orders not already in it and not cancelled in the last
    5 s: a repeat click sends nothing ("Still cancelling on EVAL-1 MNQ: 12 left. Nothing new to send."; review 2 S2,
    where 1.6.0 and the first cut sent 32 cancels and ChartBridge refused 12, leaving 6 orders working). A cancel
    ChartBridge refused can go again at the next click (review 3 N1); one refused for the rate (a busy PC can deliver
    two of the page's seconds close together) is sent again once by itself, first in line, at the pace.
  - **Flatten is never blocked** (review 3 S4): it goes out at once, never behind the pace, and with 6 a second for a
    batch Anthony's Buy, Sell and Flatten fit within one second (at 8, ChartBridge refused a Flatten after two quick
    orders, as in 1.6.0). If ChartBridge still refuses a Flatten for the rate, the page sends it once more 1.1 s later
    while the same account and instrument are shown ("ChartBridge refused Flatten for EVAL-1 MNQ (more than 10 order
    actions a second): sending it again in 1 s."); otherwise the note above the chart says it was not sent. A second
    Flatten finds the account flat.
  - It stops only for what ChartBridge would refuse: **the connection drops**, trading goes off, or the account leaves
    ChartBridge's list. Then a note that stays until Anthony dismisses it, or until those orders are no longer working,
    says so in the warning color above the chart: "14 cancels on EVAL-1 MNQ were not sent: the connection to
    ChartBridge dropped. Those orders may still be working. Check them, then Cancel all again on that account and
    instrument (or in NinjaTrader)." (review 2 S1; a 6 s status line before.)
  - 6 orders or fewer all go out at the click, so Armed going off right after drops none (review 2 N1). The account
    note keeps its full 8 s or 15 s whatever a batch does (review 2 N2).
  - **A drag on an order in a Cancel all under way** (queued, or its cancel just sent) sends no change: Cancel all
    wins and still cancels it (Anthony, 2026-09-30), so no change can cross its cancel. The line goes back and the
    status line says "Not moved: order NT12 is in the Cancel all under way, which cancels it."; the cancel's own
    "Cancelled ..." line follows.
- **A pick while trading is off counts.** During a drop or the sign-in window the picker still switches the fills,
  and that account is also the one orders go to when trading comes back (if allowed), so the picker never jumps. Its
  tooltip says so.
- **Two tabs.** Tab A on EVAL-1 and tab B on EVAL-2 each stay on their own account through picks in the other tab,
  reconnects and a reload of that tab. The last pick in any tab is what a new tab starts on. The trading page no
  longer follows another tab's pick through the storage event (1.6.0 did while trading was off).
- **The standalone page with ChartBridge 0.2 changed too** (review N7): it is the trading page (read only there), so
  it no longer follows another tab's pick either, and the 1.5 fills choice (`live-fill-account-v1`) is no longer
  carried over on the standalone page: the 1.5 fills choice is never an order account. Harmless: the picker still
  works and is remembered.
- **The Desk's embed (`ChartLive.mount`) is unchanged:** it has no order account, its picker only picks fills, and
  it still follows picks from other charts and tabs with its prefix.

### The volume profile keeps the last session (Anthony: keep it until the next session's first trade)

- **The full session** keeps the last session it counted until the next session's first trade over weekends and NYSE
  holidays, so a Friday can be reviewed over the weekend: Friday's session stays from Friday 17:00 through 18:00 and
  the weekend, until Sunday 18:00's first trade. On a holiday with Globex trading (Labor Day, Thanksgiving) Session
  shows the holiday's own Globex session. On weekday evenings it moves to the new session at 18:00 as in 1.6.0.
- **RTH keeps today's RTH through the weekday night** until the next 9:30 open (Anthony's answer, 2026-09-30), and
  over weekends and holidays until the next day with a stock market session: Globex trades and the clock never move
  it; the next RTH trade does. 1.6.0 emptied it at 18:00.
- **This holds for the ticks the page has.** 1.6.1 asks ChartBridge for exactly 1.6.0's tick history (`ticksWanted`
  and `ticksMissing` as in 1.6.0; review B1's weekend window and review 2's version-based 120 hour cap are gone). So
  the profile is kept on a page left open, and after a load, a reload or a reconnect it holds what the view's ticks
  hold: on a Saturday a Range view shows "(Fri from 16:00)", and the note says where its ticks start; on a weekend,
  a weekday morning or a holiday RTH says "Volume profile (RTH): the last RTH session is not in the tick history
  this view loaded." (with "The next starts at 9:30 ET." before an open); a view with no tick history says it counts
  the live trades (for RTH, "the RTH trades from now on" or "from the next 9:30 ET on"). Never advice to reload or
  install: a reload would load the same. 1.8.0's session table fills these in.
- **A session's first trade a few ms after 18:00:00.000** (or 9:30), with nothing traded before it (after a holiday
  halt or the break), no longer makes the profile "partial" (review 2 S4). The session counts as whole only when the
  ticks were asked from before its start and the 1-minute bars the page loaded agree (review 3 S3): no bar with
  volume between the start and the first tick's minute, and that minute's ticks hold its bar's volume (2% for
  rounding); with no bar to check against, only within 5 s of the start. Otherwise the legend and the note say where
  the ticks start, to the second in the session's first minute ("(Mon from 18:00:46)").
- **Legend:** the session's day at the end, "POC 26,150.50 · VA 26,101.50 to 26,289.50 (Fri)", in the quiet grey,
  and "(Fri from 16:00)" when its ticks start after the session did; the tooltip names the date.
- **The IB is unchanged** (none on weekends and NYSE holidays): it shares no code with the profile.
- Engine: `VolumeProfile` option `keep` (the full session: over a trading day with no stock market session
  `advance()` does nothing; RTH: never moved by the clock or by trades outside RTH; the next session's first trade,
  or the next RTH trade, moves it), `startOfDay(d)`, `VolumeProfile.fromStore(store, opts)` (the last session with
  trades in the store; RTH looks back to the last RTH in it), `util.closedDay(d)`, and the CME calendar
  `util.cmeClosed(t)`, `util.cmeSessionDay(d)`, `util.cmeClosures(year)` (review 2 S5; the fake bridge's market
  hours use it). Without `keep` the engine counts as in 1.6.0.

### Tests

- New `test/order-account.test.js` (`orderAccount`: restored when allowed, Sim101 or the first allowed with the
  missed account named, nothing picked, junk, always an allowed account; live.js: every order path through `ready()`
  with the shown-account check, `TR.account` set only from `orderAccount`, the picker or cleared, Armed never from
  storage, the tab's account in sessionStorage first, the trading page not following other tabs, no 1.5 key; review 2:
  live.js's Cancel all code run on its own with the page stubbed, 20 orders sent by id through an Armed off, an
  account and an instrument switch, a second click, orders gone meanwhile, a Flatten, a drop, the account leaving
  the list, 3 orders with Armed off at once, the pace with other orders just sent, never over 8 in 1.1 s, nothing
  locked) and `test/vp-keep.test.js` (a Friday kept over the weekend, the switch at Sunday 18:00's first trade, RTH
  over a weekend, the full session on weekday evenings as 1.6.0, RTH through the weekday night, Thanksgiving,
  Christmas, `keep` off unchanged, `fromStore` over a weekend, Labor Day, Thanksgiving and a weekday night, the CME
  calendar; `ticksWanted` and `ticksMissing` as 1.6.0's, nt8/ as on main, no install advice). Review 3: the newest
  click first, the batch line's warning color, 6 a second, a refused cancel sent again, Flatten sent again once
  after a rate refusal (and not after a switch: the note says so)); a drag on an order in a Cancel all sends nothing.
- `test/fake-bridge.mjs --market-hours`: the sample on the real calendar (moved by whole weeks), no trades while CME is
  closed (`util.cmeClosed`), tick history counted back from the clock, as ChartBridge does. `--tick-shift-ms=137`
  stamps every trade that much later (a session's first trade at 18:00:00.137); `--version` sets hello's version. A
  minute's trades now add up to its bar's volume, as NinjaTrader's do (review 3 S3 checks the ticks against the bars).
- `npm run smoke:orders`, a 1.6.1 section: first visit on Sim101 with the ring and the note; pick, arm, reload with the
  PIN: back on the tab's account, Armed off; every order path on the restored account, with every message the page
  sent for that account; a stored account that is not a trade account (the fallback); two tabs, including the
  review's case (tab A with a DEMO-EVAL long and stop reloads after tab B picked Sim101 and comes back on DEMO-EVAL);
  the named other account; a dropped connection; the note cleared on Armed on and on trading lost; a pick while
  trading is off ("picked while trading was off"); the title and the pill at 1440 and 400 px. Review 2: a Cancel
  all of 10 (nothing locked, the state row counting down, every cancel for DEMO-EVAL); R15 an instrument switch
  300 ms into 30 (Armed off but usable, arm and Flatten on NQ at once, all 30 cancelled); R16 a drop 300 ms in (6
  sent, the note naming DEMO-EVAL MNQ and 14 still up after the reconnect and 7 s, gone once they are cancelled);
  R17 DEMO-EVAL leaving the list (the note says why, the fallback note keeps its 15 s, Dismiss); R18 Flatten 300 ms
  in (flat, nothing working, no cancel after it, no reject); R19 a second Cancel all (20 cancels in all, at most 6 in
  any second, no reject); 3 orders with Armed off in the same task (all 3 sent). Review 3: R26 (DEMO-EVAL long with
  30 orders, Cancel all, then Sim101 picked and its own Cancel all: Sim101's 3 are the first sent after its click;
  at 390 px the batch line, in the warning color, and "Other accounts ... DEMO-EVAL: LONG 1" both whole); R23 (Cancel
  all, Buy, Sell and Flatten within 300 ms: none refused, flat; a made-up rate refusal of Flatten: sent once more).
- `npm run smoke:vp`, new: Saturday and Sunday 12:00 on Range, 15s, 1m and 15m, Session and RTH (each asks 1.6.0's
  hours, and the profile is none or the part the ticks hold, said plainly), and a reconnect; a page with Friday's ticks
  (a test hook asks 72 hours, as a page left open since Friday) at Sunday 17:59:45: Friday kept over 18:00 on the
  clock, then Session on Monday's from the first trade while RTH keeps Friday's; Tuesday 17:59:45, RTH: Tuesday's
  RTH kept after Wednesday's first Globex trades; Monday and Tuesday 08:00 (1.6.0's hours, RTH's note); the most
  recent NYSE holiday with Globex trading at 12:00 and 14:00 (1.6.0's hours, Session the holiday's own session, RTH's
  note with no reload advice); the +137 ms first trade after a Monday holiday on Range (whole); Monday 17:30 on Range
  with the session's first 0, 1, 45 and 150 s missing (whole with none missing, else "(Mon from 18:00:03)" and so
  on, with the note); The Desk's embed through a relay serving 8 hours (a neutral note). `npm run smoke:embed`: a pick saved by another tab still followed by both
  mounted panes, and no account note or ring in the embed.
- **Changed because the old behaviour changed:** `smoke:vp`'s two legend checks now expect the day, " (Tue)";
  `smoke:orders`' trading-off tooltip check now expects the new tooltip text; review 2 replaced the first cut's lock
  checks (unit and smoke:orders) and its holiday and older-ChartBridge checks in smoke:vp, and 1.6.1's own weekend
  loads went again with Anthony's answers of 2026-09-30; review 3 made smoke:ib's
  "Reset to default" check wait for the repaint with its tab in front (it failed now and then, on main too). No other
  existing check changed;
  `test/order-ticket.test.js` and `live/order-ticket.js` are untouched.
- Order-path files changed: `live/live.js` (account handling, `ready()`, Cancel all, the chart's move and cancel
  handlers, Flatten taking its orders off a Cancel all, the order-action count in `send`, the title and pill) and
  `test/orders-smoke.mjs`. Unchanged: `live/order-ticket.js`, `live/pin.js`,
  `test/order-ticket.test.js`, `test/fake-orders.mjs`, `nt8/ChartBridgeOrders.cs`.

## ChartBridge 0.3.4 (2026-09-30): every trade carries its side

ChartBridge (nt8/) only: the page, the engine and the chart version are unchanged, and the page needs no change to
work with it. **Needs a recompile:** while flat, run `update-pc.ps1 -InstallChartBridge` (README: Keep this PC up to
date; it copies the files of the green commit on main, and only `ChartBridge.cs` changed), then compile in NinjaTrader
(F5). The first step toward cumulative delta (buy volume minus sell volume); the delta pane comes later.
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
