# chart-engine

Anthony's trading chart. A Canvas 2D candlestick engine built to feel as smooth as OpenMarket:

- wheel and pinch zoom that eases in and stays anchored under the pointer;
- a price axis that re-fits smoothly instead of snapping;
- a live candle that grows toward each tick, with a flashing price tag and a bar-close countdown;
- throw-to-pan, live-edge following and a "Jump to live" icon at the top of the price scale;
- levels, session VWAP, trade marks and volume;
- a Colors panel so the candles can be any colors you like.

It has no dependencies, draws only when something changes, and runs at 60 fps in about half a
millisecond a frame. It is the chart for the trading app and the standard for every chart in every
project (see [CHART_STYLE.md](CHART_STYLE.md)).

**Live demo:** https://anthonydirect17.github.io/chart-engine/ (sample MNQ data and a simulated feed;
not market data). It updates on every push to `main`. To run it offline, open `index.html` in a browser.

## Live trading chart (NinjaTrader 8)

`live/` is the chart fed by real market data through **ChartBridge**, a NinjaTrader 8 add-on in `nt8/`.
It is **read only** unless trading is turned on in ChartBridge (see [Trading from the chart](#trading-from-the-chart)).
With ChartBridge 0.2 or older it is always read only, exactly as before.

1. From this folder on the Windows PC: `powershell -ExecutionPolicy Bypass -File nt8\install.ps1`
2. NinjaTrader > New > NinjaScript Editor > compile (F5). Check New > NinjaScript Output for
   `ChartBridge: serving http://localhost:8765/`.
3. Open `http://localhost:8765/` in Chrome or Edge. The first time on each PC it asks Anthony to **set a
   4-digit PIN** (see [The PIN on ChartBridge's page](#the-pin-on-chartbridges-page)).

`http://localhost:8765/` is the **workspace** (1.12.0): panels on a 12 x 6 grid, one browser window per screen, each
window with its own layout (`?layout=Main`, `?layout=Second`). Charts with slim headers (instrument and bars, the
Indicators menu, drawing tools), Time and Sales, and the **order ticket** (see [The workspace's order
ticket](#the-workspaces-order-ticket)). Each instrument's trades come in once per window, whatever the number of panels
showing it. Colors sit in the top bar, everything general (Glide, Range style, hotkeys, large prints, the PIN) in
Settings, and both are shared with the single chart page. The top bar also has **Flatten all** and **KEYS ON / OFF**.
The **single chart page** with its order bar and hotkeys is `http://localhost:8765/single.html`.

**The display round (1.14.0, Anthony's list):** nothing scrolls (every menu, popover and dialog fits at 1366x768 and up;
Colors and Settings in two columns, an indicator's gear beside the list); panels resize from any edge or corner;
Time and Sales colors each trade by where it printed against the quote (ChartBridge 0.3.8's `q`: above the ask, at it,
between, at the bid, below it; editable in the tape's gear; by side with an older ChartBridge), big trades (the bubbles'
floors) bold and brighter; grid lines off by default (Settings); 80 px of room right of the last bar at any zoom
(Settings); working orders, bracket legs and planned stop and target lines always on the price scale; the VWAP no longer
sizes the chart (off the scale it gets an edge marker); the legend shows the time left in the bar (Range: ticks left),
ATR(14) and the change from the prior settlement (ChartBridge 0.3.7; blank with none). Bubbles are sized by the order
(area by size over the floor), placed on the bar their prints traded in, and say their size in the legend on hover; the price scale keeps the legend clear. Batch 2: the profile's colors in its gear (brighter rows), the IB folded into
Levels with PD VAH, PD VAL and a drawn PD POC, each level its own toggle, the developing POC, VAH and VAL, up to 10 chips,
the VWAP from 09:30 ET (RTH only) or 18:00 ET per chart, a short header on small panels, and an **Aa** header text toggle
per chart. The single chart page has the
workspace's cleanup (one toolbar line, 2-letter chips, the drawing tools and Reset view in a small menu, Glide, Range
style, grid, room and the PIN in Settings). "chart x.y.z · ChartBridge a.b.c" is in the LIVE badge's tooltip and in
Settings. The page's clock follows Windows clock fixes (re-anchored to the PC's clock every 5 s, as ChartBridge does).

**1.15.0 (the workspace; `/single.html` stays as 1.14.0):** **4h, 1D and 1W** charts of NinjaTrader's own bars (ChartBridge
0.3.7 `htf`, kept live by `htfBar` and the trades; with an older ChartBridge the choices say they need 0.3.7), VWAP and
levels on 4h, none on 1D and 1W (a note says so); **1 hour charts load 30 days** of 1-minute history (15 minute 10);
a **middle-click ring** on any chart's plot (Trend line, Price line, Clear this chart, and the new **Zone**, a shaded box
between two prices and two times; Shift and Ctrl clicks still place orders while a tool is armed); a quiet **corner
readout** on every chart (the bar countdown and the ATR), shown on small panels and with the header text off; Room right
80, 120 or 160 px (120 by default); **compact order labels** ("TGT 1", "STP 1", "L1 +4.50 +$90", the full label on
hover, the hit areas and the x as before); a note when a press on an order does nothing ("Armed is off: arm to move or
cancel orders", or "Armed went off: ChartBridge reconnected"); and two new panels: the **Account panel** (today's open,
realized and day P&L and trades, then Positions with Close, Orders with x, and Fills with each flat-to-flat trade's P&L)
and the **Quote board** (NQ and ES: last, change and % from the prior settlement, the session's high and low).

Live CME data is licensed for your own screen: never publish it (the GitHub Pages demo stays on sample
data).

On the page, the **Indicators** menu (1.6.0) adds, shows, hides and removes Volume bars, VWAP, Levels, Fills, the
**Initial balance** (today's 1-hour IB, 1.5.3; part of Levels since 1.14.0, each level line its own switch), the **Volume profile** and the **Cumulative delta** pane (1.7.0: market
buys minus market sells below the chart, counted from when the page opens or the trades' sides were measured, and from
0 again at 18:00 ET; the sides from ChartBridge 0.3.4) per chart pane, with a search box ("/" opens it), a Recent line, Hide
all and Restore, and a pin for each on the chip strip beside the button (1.14.0: a click opens the indicator's settings with an on/off switch at the top; at most 10, the rest behind +N when they do not fit). **Chart
signals** (1.12.1, Anthony's NinjaScript indicators, counted from the page's opening from the trades' sides): **Absorption
bars** (Signals group, no chip; a large trade, a volume spike and a rejection close on one bar paint it cyan or yellow at
the close, an outline while it forms; settings per instrument and bar type in its gear), **Large-order bubbles** (Volume
group; same side prints within 100 ms from the large-print floor, the workspace's Time and Sales floors) and the delta
pane's **divergence arrows** (its gear, Show divergences). Hiding
Fills never hides the open trade (its entry fills, the position line, working orders, stop and target lines). One
**Account** picker, the order bar's (or, with no order bar, a compact one in the toolbar), chooses the account for
orders and whose fills are marked. **Range** bars are
built like NinjaTrader's (every finished bar exactly the range; see `docs/RANGE_BARS.md`), or from traded
prices only, picked next to the range size, which is kept per instrument. Every choice is remembered in
this browser as soon as it is made. The same chart can be mounted in another page (The Desk) with
`ChartLive.mount`, read only; see `live/EMBED.md`. `http://localhost:8765/diag` shows what ChartBridge
sees (accounts, fill counts, clock, The Desk queue, since 0.3.3 where each load's backfill met the live
trades, since 0.3.4 how each trade's side, buy or sell, was found, and since 0.3.5 each instrument's session table and
served window); see `nt8/PROTOCOL.md`.

**Light Range chart, exact profile** (chart 1.8.0 with ChartBridge 0.3.5): a Range or seconds chart opens with the last
2 hours of trades (`rangeHours`), which ChartBridge asks NinjaTrader for once per session and keeps in memory, so a reload
or a second page starts from the same trade without asking NinjaTrader again. Range bars are drawn only from the first
bar proven to be NinjaTrader's own (a session start, or a swing of more than the range each way; `docs/RANGE_BARS.md`),
never offset bars before it, and once drawn they stay all day. The volume profile comes from ChartBridge's table of the
session's volume at each price, fed by the live trades, on every view: exact from 18:00 ET. When ChartBridge starts
after 18:00 it loads the session once, at start, one instrument at a time (`profileRoots`), and the profile says "Volume
profile building, from HH:MM ET" until then. A NinjaScript compile (F5) restarts ChartBridge, so a compile during the
session counts as such a start: the session is loaded once more. The Range and seconds windows and these session loads go
to NinjaTrader one at a time; a minute chart's last-trades request (as in 0.3.3) is not queued behind them. If NinjaTrader
never answers one of them (or answers at the time limit but its copy does not finish within 30 s more), ChartBridge
asks for no more tick history (no window, no session load, no minute chart's last
trades) until NinjaTrader answers it or restarts: meanwhile Range and seconds charts open from ChartBridge's memory or start
from live trades, and say why. Orders and Flatten work during any load. With ChartBridge 0.3.4 or older the chart loads as before.

Settings live in `Documents\NinjaTrader 8\ChartBridge\config.txt` (optional, one `key = value` per
line; recompile or restart NinjaTrader after a change):

| Key | Default | What it does |
|---|---|---|
| `port` | `8765` | Web port (this PC only). |
| `roots` | `MNQ, NQ, MES, ES` | Instruments offered. |
| `quoteRoots` | `YM, RTY, GC, SI, CL, 6E, ZN, ZB` | ChartBridge 0.4.0: markets served for the Quote board only, each on its own front-month roll (NinjaTrader's rollover list when it covers today). Every order for them is refused. A root in both lists is quote only; `quoteRoots =` for none. See `nt8/PROTOCOL.md`, 0.4.0 hardening and markets. |
| `contract.MNQ` | front month by the CME roll rule | Force a contract, e.g. `MNQ 12-26`. |
| `days`, `tickHours` | `5`, `8` | 1-minute history days; tick backfill cap for seconds and range bars. |
| `rangeHours` | `2` | 0.3.5: the hours of recent trades a Range or seconds chart opens with (1 to 8). |
| `profileRoots` | `MNQ, NQ, ES, MES` | 0.3.5: when ChartBridge starts after 18:00 ET, the instruments whose session so far is loaded once, one at a time in this order, for an exact volume profile. Others count from the live trades ("since HH:MM ET"). |
| `quoteHours` | none | No longer used (ChartBridge 0.3.7 removed the by-date tick load it served; since 0.3.5 every Range and seconds chart gets the served window). The line is noted once in the Output window and does nothing; it can go. |
| `accounts` | every account except Backtest and Playback | Allow-list of accounts to watch, e.g. `Sim101, EVAL*` (`*` matches a prefix). |
| `postFills` | `false` | `true` also sends every fill to The Desk (see `nt8/PROTOCOL.md`). |
| `deskUrl` | `http://localhost:8800` | Where The Desk runs. |
| `bars` | off | `on` sends each session's 1-minute bars to The Desk after the close (ChartBridge 0.3.6, see below). |
| `barsRoots` | `NQ, MNQ, ES, MES` | Whose bars `bars = on` sends. |
| `pc` | the Windows computer name | This PC's name in the bars messages, e.g. `HOME` or `WORK`. |
| `trading` | `false` | `true` turns on order entry from the chart (see below). |
| `tradeAccounts` | none | Accounts the chart may trade, e.g. `Sim101, <eval name>`. Exact names, no wildcard; Backtest and Playback never. |
| `maxQty.MNQ` | `1` | Position cap per instrument root, one line per root (`maxQty.NQ = 1`, ...). |
| `maxTicksAway` | none | ChartBridge 0.3.7: a limit or stop price at most this many ticks from the last price (none: no limit; before 0.3.7 always 200). A value that is not a whole number of 1 or more means no limit, said in the Output window and to the signed-in pages. |
| `maxBracketTicks` | none | ChartBridge 0.3.7: a bracket at most this many ticks (0.3.8: a market or resting entry's stop and target ticks, and a `plan`'s). None: no limit. Same rule for a mistyped value. |
| `allowOrigins` | none | Other web pages that may open the read-only WebSocket (ChartBridge 0.3.1), comma separated, each an exact `scheme://host[:port]`, no wildcard, e.g. `https://desk.golivepage.com, http://100.88.192.33:8800` for The Desk's Live trading page (add `http://localhost:8800` or `http://127.0.0.1:8800` too if The Desk is ever opened that way). One line: the last `allowOrigins` line wins. Non-ASCII host names in punycode. They can read, never trade. |

**This PC only** (ChartBridge 0.3.1). Windows' web server (HTTP.sys) listens on every network interface and
matches only the `Host` header, so the `localhost` address alone does not keep other devices out. ChartBridge
therefore refuses (403) every request that does not come from this PC, on every path, before anything else,
and takes a browser WebSocket only from its own page or an `allowOrigins` entry. A local program that sends no
`Origin` header (such as The Desk's server relay) is allowed. As a second layer, keep inbound port 8765 blocked
in the Windows firewall; in an admin PowerShell:

```
New-NetFirewallRule -DisplayName "ChartBridge 8765 block inbound" -Direction Inbound -Protocol TCP -LocalPort 8765 -Action Block
```

The firewall does not filter traffic within the PC, so the chart and The Desk on this PC keep working. After
installing 0.3.1, check once that a plain request and a WebSocket upgrade to the PC's Tailscale or LAN address
get 403 (the two `curl` lines are in "Network access" in `nt8/PROTOCOL.md`).

**Never forward anything to 8765**: no cloudflared ingress, `tailscale serve` or `funnel`, `netsh interface
portproxy`, `ssh -R` or local reverse proxy pointing at it. A forwarded client arrives as 127.0.0.1 and passes the
this-PC rule. The rules keep out other devices and web pages, not software running on this PC: any local program
can connect from 127.0.0.1 and send any `Origin`.

### The PIN on ChartBridge's page

ChartBridge 0.3.2 locks its own page (`http://localhost:8765/`) with a 4-digit PIN, so someone else at this PC
cannot open it and see or trade Anthony's accounts. It is a kid lock, not high security, and it never locks
Anthony out of a trade:

- **Setting it.** While no PIN is set, the page shows **Set a PIN** (enter four digits, then the same four
  again). Nothing streams and no order bar shows until then. Each PC has its own PIN, set on that PC.
- **Unlocking.** Each time the page opens (or is reloaded) it asks for the PIN, with a pad that works with
  the mouse, touch or the keyboard (digits, Backspace, Delete clears). A wrong PIN is simply refused:
  **there is no lockout**, nothing is counted and nothing waits, so the right PIN always works at once.
- **Staying unlocked.** Once unlocked, the page stays unlocked while it is open, including across a
  ChartBridge restart (a recompile with F5, or restarting NinjaTrader): the page reconnects on its own and
  signs in again without asking. The unlock lives only in the open page (never saved in the browser), so
  a reload asks again. Armed is still off after a reload or a dropped connection, as before.
- **Changing it.** The **PIN** button in the toolbar asks for the current PIN, then the new one twice.
  Pages already open stay unlocked.
- **Forgotten PIN.** Delete `pin.txt` in `Documents\NinjaTrader 8\ChartBridge\` on this PC (NinjaTrader
  may stay open; no recompile). The page then asks for a new PIN the next time it opens or reconnects. Only
  someone at this PC can do this. Pages that were open keep their current connection, but once they
  reconnect they ask for the new PIN like any other page.
- **First run.** On a fresh PC, whoever opens the page first sets the PIN: open it and set the PIN right
  after installing.
- **Revoking.** Deleting `pin.txt` also revokes every open page: each asks for the new PIN on its next
  reconnect.
- **A damaged or locked pin.txt** (a backup or antivirus holding it, a power cut mid-write) never counts as
  "no PIN": open pages keep working from the copy ChartBridge read earlier, nobody is offered "Set a PIN",
  and the page recovers by itself once the file reads again. If ChartBridge starts with it damaged, the page
  keeps its unlock and waits, with a note saying why; delete `pin.txt` if it stays that way.
- **What is stored.** `pin.txt` holds a salted PBKDF2-SHA256 hash of the PIN (50,000 iterations), never
  the PIN, plus a random key that lets ChartBridge recognise pages it has unlocked. ChartBridge never logs
  the PIN or any token; `/diag` shows only whether a PIN is set.
- **What it does not touch.** The Desk's Live tab (listed in `allowOrigins`, with its own PIN) and local
  programs such as The Desk's relay connect exactly as before, without ChartBridge's PIN. The chart mounted
  in The Desk (`ChartLive.mount`) never shows the PIN pad.

Details: "PIN" in `nt8/PROTOCOL.md`.

### Daily bars to The Desk (`bars = on`, ChartBridge 0.3.6, off by default)

The Desk tags each trade with the levels around it, and for that it needs the day's 1-minute bars. With
`bars = on` in `config.txt`, ChartBridge sends them from NinjaTrader's own data:

- **What:** every finished 1-minute bar (open, high, low, close, volume, exactly as NinjaTrader has them) of
  the session, 18:00 to 17:00 New York time (the Sunday evening counts as Monday), for NQ, MNQ, ES and MES.
  One message per contract per session: the front month the chart uses, plus any other contract of that
  root you had fills in that session. Each bar carries its start time. Nothing else: no account, no PIN,
  no token, only the market data and this PC's name (`pc`).
- **When:** a few minutes after the 17:00 close, if NinjaTrader is connected; and when ChartBridge starts
  (about 2 minutes after, once the charts have loaded), any of the last 5 sessions The Desk has not taken
  yet, so the first run also sends the day before. Weekends and full holidays are skipped. Nothing during
  regular trading hours (09:30 to 16:15 ET) except that catch-up at the start.
- **Never in the way:** each request goes to NinjaTrader through the same one-at-a-time gate as the Range
  windows and session backfills (0.3.5), last of all, and only when nothing of the chart's is out, queued,
  still to come or loading; it never starts beside one, and never touches order entry. A bars request
  NinjaTrader does not answer in 60 s is given up and the chart's requests go on (the chart never waits on bars;
  one may then go while NinjaTrader is still working on it). A request that fails is
  logged and tried again 15 minutes later, 3 times at most, then not until the next start.
- **Like fills:** each message waits in `pending_bars.jsonl` (next to `pending_fills.jsonl`) until The
  Desk takes it (`POST /api/bars` at `deskUrl`, retried every 10 seconds), so a restart or The Desk being
  closed loses nothing. A message The Desk calls malformed is set aside in `rejected_bars.jsonl` and, since 0.3.7,
  listed in `refused_bars.txt`, so it is not asked for again after a restart either; a waiting message more than
  40 days old is dropped. Sessions The Desk took are listed in `sent_bars.txt`. `/diag` shows a `bars` section: on or off, the last session
  sent per contract, how many wait, what it waits for at the gate, and the last problem. Details: "Daily bars to The Desk" in
  `nt8/PROTOCOL.md`.

### Settlement, 4h, 1D and 1W bars, and the weekly profile (ChartBridge 0.3.7, data side)

For the page's day % change, its 4h, 1D and 1W charts and the weekly profile, ChartBridge sends the prior session's
settlement from NinjaTrader with the date it settles (in `hello` and when it changes, including the 18:00 roll; null when
it has no reliably dated value; kept in `settlements.txt` with its contract across restarts, so a restart on a roll day
never takes the old contract's value), answers a page's `htf` request with
NinjaTrader's own 240-minute, day or week bars (asked once per instrument and timeframe through the gate, last, never
beside a chart load; a request NinjaTrader does not answer in 15 s is given up with the reason and asked again no sooner
than 60 s later, so the chart never waits on it; kept in memory for other pages and reloads; the forming bar follows the
live trades), and answers
`weekProfile` with the last 5 sessions' volume at price from its session tables (never a NinjaTrader request; a missing
session is said). Old pages ignore all of it. Details: "Settlement, higher-timeframe bars and the weekly profile" in
`nt8/PROTOCOL.md`.

Without NinjaTrader, `npm run bridge` starts a fake bridge with sample data at `http://localhost:8765/live/` (the
workspace; the single chart page is `http://localhost:8765/live/single.html`)
(`npm run bridge -- --trading --trade-accounts=Sim101,DEMO-EVAL --max-qty=MNQ:5` to try order entry on
simulated fills; the flags are listed at the top of `test/fake-bridge.mjs`). The fake has the same PIN; it
asks for one to be set unless started with `--test-pin=<made-up PIN>`, and `--pin-file=<path>` keeps it
across fake restarts.

### Keep this PC up to date

`nt8\update-pc.ps1` keeps the chart page on each trading PC (HOME, the laptop, WORK) up to date by itself, and gets a
new ChartBridge ready for Anthony to install by hand. Windows PowerShell and git only; no admin, no Python, no token.

- **The page updates by itself.** The updater checks when you sign in and once a day at 5:05 PM New York time, while
  futures are closed. It installs the newest commit on `main` whose CI is green on both ubuntu-latest and
  windows-latest, and only when that page works with the ChartBridge compiled on this PC (`live/COMPAT.json`). An open
  page keeps running what it loaded, so an open trade is never disturbed.
- **ChartBridge never installs by itself.** A new one is fetched and staged; Anthony installs it with one command while
  flat, then presses F5.
- **Your clone is never moved.** The updater only fetches `main` and stages what it needs under `updater\staged\`; it
  never checks out, pulls or merges. Pull the clone yourself when you want to (that changes nothing the task runs).
- **The task runs its own copy** of the updater, `updater\bin\update-pc.ps1`: always the file of a commit on `main`
  whose CI is green, checked byte for byte against that commit. It changes only when you run `register` again or
  `-InstallChartBridge` (never to an older one), and every run checks it is still the file that was pinned (if not, it
  does nothing and says so in the log). A new commit on `main` never changes it by itself. After setup, run everyday
  commands with that copy too (below), so they are the same code the task runs.
- **A cut-off install repairs itself.** If the PC loses power or sleeps while page files are being replaced, the next
  run finishes the install (or goes back to the previous page) before anything else, even when paused.
- State and log: `Documents\NinjaTrader 8\ChartBridge\updater\` (`update.log`, `status.json`, `state.json`, the staged
  files, the previous page, `bin\`). `config.txt` and the PIN file are never touched.

**One-time setup.** Open Windows PowerShell (not as administrator), with NinjaTrader running and ChartBridge compiled.
Paste each block in turn; each ends in **OK** (go on) or **STOP** (read the line, fix it, paste the block again).

1. The clone, on `main`, up to date. This block never switches branches: if the clone is on another branch or has
   changes, it stops and says so.

   ```powershell
   $ce = @("$env:USERPROFILE\chart-engine", 'C:\TheDesk\chart-engine') | Where-Object { Test-Path (Join-Path $_ '.git') } | Select-Object -First 1
   if (-not $ce) { 'STOP: no chart-engine clone at %USERPROFILE%\chart-engine or C:\TheDesk\chart-engine' } else {
     Set-Location $ce; $br = git symbolic-ref --short HEAD; $dirty = git status --porcelain --untracked-files=no
     if ($br -ne 'main') { "STOP: the clone is on '$br', not main. When the work there is saved: git checkout main, then paste this block again" }
     elseif ($dirty) { 'STOP: the clone has changed files (git status shows them). Commit or put them aside, then paste this block again' }
     else { git pull --ff-only; if ($LASTEXITCODE -ne 0) { 'STOP: git pull failed (see the lines above)' }
       elseif ((git symbolic-ref --short HEAD) -eq 'main' -and (Test-Path .\nt8\update-pc.ps1)) { "OK: $ce is on main, up to date" }
       else { 'STOP: the clone is not on main with nt8\update-pc.ps1' } } }
   ```

2. What this PC has now. It asks ChartBridge's `/diag` for the version compiled here and saves what /diag reports
   (in `updater\state.json`, so a page waiting for F5 follows on the next check); it never writes a page or
   ChartBridge file:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\nt8\update-pc.ps1 status
   ```

   STOP "page folder is missing": this PC never had ChartBridge. While flat, with the NinjaScript Editor closed, run
   `powershell -NoProfile -ExecutionPolicy Bypass -File .\nt8\update-pc.ps1 -InstallChartBridge` (it asks first),
   open the NinjaScript Editor and press F5, then paste block 2 again. STOP "version is not known": start NinjaTrader
   (ChartBridge compiled), then paste block 2 again.

3. A dry run (fetches `main`, asks GitHub for CI, changes nothing):

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\nt8\update-pc.ps1 check
   ```

4. The first update, by hand:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\nt8\update-pc.ps1 update
   ```

5. The scheduled task for this Windows user. It checks when you sign in and once a day at 5:05 PM New York time, while
   futures are closed (`-DailyAt 17:10` for another New York time). It prints that time on this PC's clock. If the PC
   is off or asleep at 5:05 PM, that day's check is skipped rather than run later in the trading day; the next sign-in
   or the next day checks. Every check works out 5:05 PM New York time again and moves the daily check if this PC's
   clock drifted from it (a trip to another time zone, or DST dates that differ from New York's); the log says so.
   Register pins the updater from the newest green commit on `main` (it fetches first); it refuses a file changed by
   hand or from a branch, and never goes back to an older updater than the one pinned. Run it from a normal
   PowerShell window, not as administrator: the task's own run may not be allowed to move the daily check of a task
   registered from an elevated window (register warns, and `status` shows when a move failed).

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\nt8\update-pc.ps1 register
   ```

   To check the daily time is kept on this PC's clock (a time with no ending such as `-04:00` or `Z`, for example
   `2026-09-30T17:05:00`): `(Get-ScheduledTask 'ChartEngine Updater').Triggers | Select StartBoundary`

   On Windows 11, if a console window stays open while the check runs, that is Windows Terminal being the default
   terminal; the window closes when the run ends.

**Everyday commands, with the task's own copy.** Paste this once per PowerShell window, then use `$u` as below:

```powershell
$u = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'NinjaTrader 8\ChartBridge\updater\bin\update-pc.ps1'
if (Test-Path $u) { "OK: $u" } else { 'STOP: no pinned copy yet: do setup block 5 (register) first' }
```

For example `powershell -NoProfile -ExecutionPolicy Bypass -File $u status`. It knows the clone from its pinned.json.

**What the notices mean.** On the chart page's status line, at the bottom (never over the order bar or the chart, and
it never moves them; it never reloads anything):

- **Update ready: reload when flat**: new page files are installed. Reload the page when flat to use them.
- **ChartBridge x.y.z ready to install (flat, then F5)**: a new ChartBridge is staged. Nothing happens until Anthony
  installs it (below). A Windows notification says the same once, and so do `update.log` and `status.json`.
- **ChartBridge x.y.z copied: press F5 when flat**: it was copied; it runs after F5 in the NinjaScript Editor. The note goes as soon as
  the ChartBridge the page is connected to says it is x.y.z or newer (1.16.0).
- **Page files are being updated: do not reload yet**: files are being replaced right now (a few seconds).
- **Page update cut off: run update-pc.ps1 status**: an install was cut off (a power loss, a closed lid). Do not
  reload. The next check repairs it by itself; when flat you can run `repair` (page files only, never ChartBridge).
- **DO NOT press F5: ChartBridge files are mixed. Run update-pc.ps1 status and report**: `-InstallChartBridge`
  failed half way (a file held by the NinjaScript Editor, antivirus or OneDrive, or a power loss) and the old files
  could not all be put back, so `bin\Custom\AddOns` holds new and old ChartBridge files. Do not compile. `status`
  says which files changed and where the old ones are kept; the notice goes once AddOns holds one whole set again
  (the old files put back, or `-InstallChartBridge` run again with nothing holding the files).
- **Updater stopped: run update-pc.ps1 status**: the task's copy of the updater failed its own check (changed, or its
  `pinned.json` is gone), so the scheduled check does nothing. Run `register` again from the clone.

On a narrow window the notice is shortened ("Update ready"); hovering it shows the whole text.

**Install a new ChartBridge** (while flat in every account, with the NinjaScript Editor closed: an open editor compiles
as soon as a file changes):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $u -InstallChartBridge
```

It installs from `updater\staged\` (the green commit that was announced), never from the clone. It shows the staged
version and the one compiled here, asks once (type `y`), then writes the add-on files next to the old ones and replaces
them back to back (the files it replaces are kept in `updater\previous-addons\`). All or nothing: if one file cannot
be replaced (the NinjaScript Editor, antivirus or OneDrive holds it), every file already replaced is put back and it
says nothing changed; close what holds the file and run it again. If the put-back fails too, it says **DO NOT press
F5** (above). Then it says: open the NinjaScript
Editor and press **F5** while flat, then open `http://localhost:8765/diag` and check `"version"` shows the new one (or
run `update-pc.ps1 status`), then reload the chart page. A page that needs the new ChartBridge waits until /diag shows
it: after F5, run `update` (or `status`, which notes the new version for the next check). A page that works with both
installs at once; if it cannot be written right then, the ChartBridge part still counts and the page follows on the
next update. `-InstallChartBridge` also moves the task's copy of the updater to that commit (never to an older one).

**Pause, roll back, and the rest:**

| Command (`powershell -NoProfile -ExecutionPolicy Bypass -File $u ...`) | What it does |
| --- | --- |
| `status` | what is installed and waiting, and why; it saves what /diag reports (the version compiled here) in `updater\state.json`, and never writes a page or ChartBridge file |
| `check` | dry run: what `update` would do now |
| `update` | the automatic path, by hand |
| `rollback` | puts the previous page files back; that commit is skipped until a newer one is on `main`. `rollback` again goes forward again |
| `repair` | page files only, never ChartBridge: finishes or undoes a cut-off install, or writes a whole page (staged, previous, or the clone's page files; the clone's only when its `live/COMPAT.json` allows the ChartBridge compiled here, or it says plainly that it could not check) |
| `pause` / `resume` | turns the automatic update off and on (off is never the default; a cut-off install is still repaired while paused) |
| `register` / `unregister` | the scheduled task "ChartEngine Updater" for this Windows user: at sign-in and daily at 5:05 PM New York time |

Why it waits (all in `update.log`): CI not finished or red on either system; GitHub not reachable (it reads CI
without a token: 60 requests an hour per address, and a pass uses two); ChartBridge's version not known (NinjaTrader
closed and nothing recorded yet); the page needs a newer ChartBridge; paused; or a commit rolled back by hand.

With NinjaTrader closed, the ChartBridge version counted is the newest one `/diag` showed (or the one
`-InstallChartBridge` copied, once seen), and never above the version in `bin\Custom\AddOns\ChartBridge.cs`.

## The workspace's order ticket

The workspace trades through its **order ticket** (1.12.0, Anthony 2026-10-01), a panel of its own: instrument,
account, Armed, Qty, the bracket presets with the stop and target, Buy MKT, Sell MKT, B/E, **Close** (cancel this
instrument's orders and close its position at market; the single chart page calls it Flatten), Cancel all, and the
position, P&L, stop and target cover and last fill of its instrument. It calls the very same functions as the single
chart page's order bar (`live/trade.js`), so everything below about the order bar holds for it too.

- **Every chart on the ticket's instrument takes orders while it is Armed**, in every window: Shift + left click buys,
  Shift + right click and Ctrl + left click sell, drag a working order or a bracket leg to move it, its x cancels it.
  Those charts have a purple border with a soft glow. Charts on other instruments only show their orders, position and fills.
- **Switching the ticket's instrument** turns Armed off; anything still open on the old one shows as "Also open: MNQ
  +2" with its own Close.
- **One ticket for all windows** of the browser on this PC. The first window to open takes it by itself (Armed off);
  a reload takes it back. Add it in another window and it asks "Move the ticket here?"; after a move Armed is off.
  When the ticket's window closes, no other window takes it until you add it there ("Use the ticket here"). Only the ticket's window sends orders: a click, drag, Buy, Sell or B/E
  key in another window is passed to it; if it does not answer within 300 ms nothing is sent and a note says so.
- **Close, Flatten all and the top bar's Flatten all** go from the window you use, Armed or not, on the ticket's
  account (with no ticket anywhere: the last ticket's instrument, on the last account picked on this PC; KEYS's
  tooltip says which). Flatten all flattens every instrument with a position or a working order on it.
- **KEYS ON** in the top bar means a hotkey pressed now works in this window; KEYS OFF means the window does not have
  the focus, or a box, menu or dialog has it.
- Chrome or Edge (they keep the one ticket with the Web Locks API).

## Trading from the chart

Decided by Anthony on 2026-09-29: market buy and sell, limit and stop by clicking a price, brackets (stop
and target in ticks, per instrument, placed as an OCO pair), Flatten and Cancel all, **one click while
Armed is on**. Orders go through NinjaTrader's own order system (ChartBridge 0.3 and later, protocol v2 in
`nt8/PROTOCOL.md`), so the broker and the prop firm see NinjaTrader orders. Lucid's written OK on custom
front ends was requested and had not arrived when this was written; adding the evals to `tradeAccounts` is
Anthony's call once it does.

**Turn it on** in `Documents\NinjaTrader 8\ChartBridge\config.txt`, then recompile or restart NinjaTrader:

```
trading = true
tradeAccounts = Sim101
maxQty.MNQ = 2
maxQty.MES = 2
```

Only the accounts named in `tradeAccounts` show in the order bar. Use `Sim101` first.

**The order bar** (above the chart, only with ChartBridge 0.3 or later):

- **Armed** switch. Off after every page load, and it turns itself off when the account or instrument
  changes, the connection drops or ChartBridge turns trading off. While it is on, the switch is deep red and the bar
  is outlined in it, and the chart has a purple outline with a soft glow as in the workspace (1.13.0, Anthony; amber
  before), the legend shows ARMED with the account and the tab title starts with ARMED and names the
  instrument and the account ("ARMED · MNQ · EVAL-1", 1.6.1). **Nothing trades while it
  is off** (except Flatten, which works with Armed off, 1.11.0), and nothing asks for confirmation while it is on:
  one click sends the order. The one exception (1.13.0, Anthony): the first order with no stop after each page load
  (see NO STOP below).
- **Account** (only `tradeAccounts`), **Qty** (a select, 1 to 9; the choices over that instrument's cap are off and
  the cap shows beside it, "max 5"; the last qty picked is remembered per instrument, 1.10.0). The chart marks this account's fills
  (1.6.0). When trading comes on the bar is on the account this tab was using (1.6.1): after a reconnect or a PIN
  entry the one it was on, after a reload of the tab the one that tab was on, in a new tab the last one picked on
  this PC; always only if `tradeAccounts` still has it, else Sim101 with the note "Last account ... not available,
  on Sim101". The picker is ringed for a moment and a note says which account orders go to. Armed is always off
  then. Each tab keeps its own account. Other accounts with orders or a position on the instrument are named in the
  bar. With trading off the picker lists every account ChartBridge knows and still switches the fills.
- **Buy MKT / Sell MKT**.
- **Shift+click** a price on the chart to place a limit or stop at that price (1.10.0: the mouse button picks the
  side): **Shift + left click buys**, **Shift + right click sells**, and **Ctrl + left click sells** too. Ctrl and
  Shift together send nothing. The kind follows from where you click: a better price than the last trade is a limit
  (buy below, sell above), a worse one is a stop (buy above, sell below). Hold Shift over the chart to see what a
  click would buy (the label also names what a right click would sell). A plain click, a drag or a Shift+drag never
  places anything. The browser's right-click menu does not open over the chart's plot on this page.
- **Bracket**: stop and target from each fill, remembered per instrument in this browser (0 means none). The
  bracket goes on orders that open or add to a position, never on one that reduces it. 1.10.0: a preset select before
  the boxes: **Custom**, **1:1**, **1:1.5**, **1:2** (the target is the stop times the ratio, rounded, and follows the
  stop while the ratio is picked; typing the target makes it Custom), your saved presets, **Save current...** (a
  name, default like "12/24t"; up to 12) and **Delete** for the saved preset picked. A **t / pt** toggle shows and
  types the values in ticks or points (points round to the nearest tick); they are kept in ticks. With ChartBridge
  0.3.7 or newer the boxes take what ChartBridge takes (`maxBracketTicks` in `config.txt`, no limit without it; 1.13.0);
  with an older ChartBridge at most 200 ticks, as before. A limit or stop entry's stop and target are ticks from its
  fill and travel with it (ChartBridge 0.3.8, see below).
- **NO STOP** (1.13.0, Anthony): while the stop box is 0 a red NO STOP tag shows beside the bracket boxes. The first
  order with no stop after each page load (Buy MKT, Sell MKT, their hotkeys, a Shift+click or Ctrl+click on the chart)
  asks "No stop: send anyway?" in a strip over the top of the chart, with **Send** and **Cancel** (Cancel has the focus, so
  Enter does not send; Escape is Cancel). Cancel sends nothing; Send sends it, and nothing asks again until the page is
  loaded again. An order that reduces the position never asks, nor do Close, Flatten, Flatten all, B/E or a cancel; a
  reversal (Sell 3 while long 1) asks, since it opens a position (and, as before, goes with no bracket). The question
  never blocks anything: Flatten, Close and Flatten all work while it is open and close it, its order not sent; Armed
  going off or another instrument or account closes it too, and a Send is only for what was asked. In the workspace
  the question shows over the top bar of the window you clicked or pressed the key in, and a Close or Flatten in any
  window closes it.
- **B/E** (1.10.0, next to Flatten, needs Armed): moves the stop of the open position to break-even, the average
  price rounded a tick toward safety (long up, short down). On only with a position on this account and instrument
  and a ChartBridge stop working. It sends one move per ChartBridge stop leg, and only when the last price is past
  that price on the profitable side ("Price is not past break-even yet; the stop stays." otherwise). Stops placed in
  NinjaTrader are never touched (the note says so), and a stop already at break-even or past it is left.
- **Flatten** (works with Armed off, 1.11.0) cancels every working order on the chosen account and instrument, then closes the position at
  market. **Cancel all** cancels the working orders and leaves the position; while a position is open it
  keeps every order on the closing side (the position's stop and target, from the chart or NinjaTrader)
  and says how many it kept. Cancel those one by one with their x, or use Flatten. Its cancels go out by order id,
  at most 6 order actions in any 1.1 s (ChartBridge allows 10 a second, so Flatten always has room), the newest click
  first; once clicked it finishes whatever Armed, the account or the instrument shown do next, and the state row
  names it until the last one is sent ("Cancelling on EVAL-1 MNQ: 12 left", in amber while another account or
  instrument is shown). Nothing is locked meanwhile. A Flatten ChartBridge refuses for the rate is sent once more. If the connection drops first, a note above the chart names
  the account, the instrument and how many were not sent, until dismissed or those orders are gone (1.6.1).
- **Planned stop and target** (1.13.0, ChartBridge 0.3.8): a resting limit or stop entry shows its planned stop and
  target as lighter, finely dashed lines on every chart of its instrument, labelled "SL plan -12t" and "TP plan +24t"
  (ticks from the fill). They follow the entry while you drag it and redraw from the price ChartBridge confirms. While
  Armed, drag a planned line to change its distance (whole ticks, at least 1; a stop dragged to or past the entry,
  or a target, is refused on the page and nothing is sent), click its x to remove it, and click **+SL** or **+TP** on
  the entry's label to add it back at the bracket boxes' distance. With an older ChartBridge there are no planned
  lines and the page works as 1.12.0 did.
- Working orders show as lines with a label and a price tag (green buy, red sell; stops dashed, limits and
  targets solid). While Armed, drag a label (or its price tag) to move the order, press Escape during the
  drag (or let go outside the chart's plot) to put it back, and click the x to cancel it (a bracket leg takes its pair with it). The position
  shows as a light line at the average price with open P&L in points and dollars.
- Confirmations and refusals show in the status line; a refusal is in red with ChartBridge's reason. An
  error from ChartBridge (for example a bracket leg NinjaTrader rejected) stays on screen until dismissed.
- **Hotkeys** (1.11.0): **Settings** in the toolbar has a **Hotkeys** section with five actions, **Buy MKT**,
  **Sell MKT**, **B/E**, **Close** and **Flatten all**, and none has a key until you give it one: click the box and
  press the keys (it shows them, like `Alt+B`), or Clear. Each calls exactly what its button calls, with the same
  checks and notes: Buy MKT and Sell MKT with the Qty and bracket shown, B/E, and Close is the Flatten button (this
  account and instrument). **Flatten all** sends one Flatten for every instrument with a position or a working order
  on the order account, within ChartBridge's 10 order actions a second (paced like B/E when needed). Buy MKT, Sell MKT
  and B/E need Armed, as their buttons do; Close and Flatten all work with Armed off, like the Flatten button. A refused
  press says why. After a pick in an order bar select, or Enter in a bracket box, the focus leaves it, so a hotkey
  works at once. Refused as keys, with the reason shown and nothing saved: what
  the browser or Windows keeps (Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Tab, Ctrl+R, F5, Ctrl+L, F12, Alt+F4, Alt+Left, Alt+F,
  Ctrl+1 to Ctrl+9 and the like, any Windows key combo), the chart's own keys (A, + and =, -, /, End, the arrows,
  Delete, Escape, Tab), a modifier alone, a key that is not a letter, digit, F-key, numpad or punctuation key, and a
  combo another action has. A hotkey never fires while you type in a box or a select, while a menu or Settings is
  open, or from a held key's repeats, and the 0.4 s repeat guard applies. Kept in this browser
  (`live-hotkeys-v1`). Only the trading page has them; a mounted chart ignores them.
- Apart from the hotkeys, no key places or changes orders (only Escape, which cancels a drag in progress), and the
  order buttons act on a mouse or touch click only: Enter or Space on a focused button sends nothing.
- A limit on the wrong side of the market (a buy limit above the last price) is refused, since it would
  fill at once; a Shift+click above the market while buying places a stop, below it a limit.

**Safety gates** (all enforced in ChartBridge; the page only adds its own checks on top):

1. Off unless `trading = true`.
2. Only the accounts in `tradeAccounts`; never Backtest or Playback; no wildcard.
3. `maxQty.<ROOT>` caps the position (default 1): the position plus working orders on the same side plus
   the new order may not exceed it. Orders that reduce the position are always allowed.
4. Only ChartBridge's own page: the WebSocket Origin must be `http://localhost:<port>` (pages listed in
   `allowOrigins` can read, never trade), and the page must
   sign in with the token from `GET /session` (a new one each start; 0.3.2: only for a page unlocked with
   the PIN). The page may not sit in another
   page's frame; it also refuses to arm or trade inside one.
5. Limit and stop prices on the tick grid, stops on the right side of the market, and refused when the last
   trade is more than 300 seconds old. ChartBridge 0.3.7 has no distance limit unless `config.txt` sets
   `maxTicksAway` (before 0.3.7: within 200 ticks of the last price).

**Stop and target on a resting entry (ChartBridge 0.3.8, Anthony's ATM rule; replaces 0.3.7's planned prices).** A
limit or stop entry's stop and target are distances in ticks from its ACTUAL fill: every fill of it gets its legs at
the fill price plus or minus those ticks, so they travel with the entry when it is dragged, and moving the entry onto
or past where its stop or target would be is never refused. A market entry works the same way, as before. A fill
exits at market (with an alarm) only when a trade in the last 2 seconds went through the stop level. The ticks survive
a recompile or restart (the entry's order name, `CB#tag atm s8 t16`, and `planned_brackets.txt` in ChartBridge's
folder). A `plan` message adds, changes or removes them before the fill, in ticks (`stopTicks`, `targetTicks`); the
page sends it from chart 1.13.0 (the planned lines, above; `nt8/PROTOCOL.md`). An entry still resting from 0.3.7 is converted once to ticks
from its current price, with a warning to the page.
6. Only the instruments ChartBridge serves.
7. At most 10 order actions per second per page (a `plan` counts as one, 1.13.0).

The page is tested against a fake bridge that follows the same rules (`test/fake-orders.mjs`, the
reference for ChartBridge's behaviour) with `npm test` and `npm run smoke:orders`.

## Use it

```html
<div id="chart" style="position:relative;height:600px"></div>
<script src="src/chart-engine.js"></script>
<script>
  const chart = ChartEngine.create(document.getElementById('chart'), {
    barSeconds: 60,          // 1-minute bars
    precision: 2, tick: 0.25,
  });
  chart.setBars(bars);       // [{ t, o, h, l, c, v, vw }]
  chart.setLevels(ChartEngine.util.levelLines(ChartEngine.util.sessionLevels(oneMinuteBars)));
  chart.setTrades([{ tIn, tOut, pIn, pOut, dir: 1 }]);
  onTick(bar => chart.update(bar));        // same t updates the forming bar, a newer t adds one
  ChartEngine.mountThemePanel(chart, document.getElementById('toolbar'));
</script>
```

### Time

Bar times (`t`) are **exchange wall-clock seconds stored as if they were UTC**. For CME futures
that is New York time: 10:31 ET on Sep 29, 2026 is `Date.UTC(2026, 8, 29, 10, 31) / 1000`.
`util.zoneSeconds(unixSeconds, 'America/New_York')` converts real timestamps, and the default
`clock` does this for you. Nothing else needs time-zone math.

### Options (`create(container, options)`)

| Option | Default | What it does |
|---|---|---|
| `barSeconds` | `60` | Bar length. Intraday and daily (`86400`) both work. |
| `precision`, `tick` | `2`, `0.25` | Price decimals and the minimum price step. |
| `session` | `{ start: 64800, rthStart: 34200, rthEnd: 57600 }` | Session start (18:00, the evening before) and regular hours for shading. Use `start: 0, rthStart: null` for 24/7 markets. |
| `layers` | all on | `{ volume, vwap, levels, trades, ib }`; a level with `layer: 'ib'` shows with `ib`, the rest with `levels` |
| `theme` | Carolina blue / deep purple | Any key of `ChartEngine.DEFAULT_THEME`. |
| `clock` | New York now | Returns the current time in bar-time seconds (drives the countdown). |
| `rightOffset`, `barSpacing` | `8`, `7` | Empty bars past the last bar; starting bar width in px. |
| `room` | none | 1.14.0: empty room right of the last bar in CSS px, the same at every zoom (replaces `rightOffset` when set; the live page uses 80). |
| `grid` | `true` | 1.14.0: the price and time grid lines (the live page turns them off by default). |
| `fitOrders` | `true` | 1.14.0: the auto-fit price scale takes in every order price (working orders, bracket legs, planned lines), eased like any re-fit. The VWAP never sizes the scale. |
| `motion` | `{ zoom: 75, fit: 120, candle: 55, follow: 110, friction: 325 }` | Time constants in ms. These are the approved feel; change with care. |
| `unit` | `'pt'` | Suffix on trade result chips. Set `label` on a trade to override. |
| `pointValue` | `0` | Dollars per point, for the position line's open P&L (or pass it to `setPosition`). |

### Methods

`setBars(bars, { barSeconds })` · `update(bar)` · `setLevels(list)` · `getLevels()` · `setTrades(list)` ·
`setLayers(partial)` · `setTheme(partial)` · `getTheme()` · `colors()` · `setPaused(bool)` ·
`setBarSeconds(sec)` · `goLive()` · `reset()` · `isLive()` · `bars()` · `stats()` · `resize()` ·
`destroy()` · `on('legend', fn)` · `on('live', fn)` · `on('error', fn)` · 1.14.0: `setGrid(on)` · `getGrid()` ·
`setRoom(px)` · `room()` (`{ px, bars, gap }`) · `priceScale()` (`{ lo, hi, target, auto, plotHeight }`) · `vwapMarker()` ·
`lastBar()` · `atr(period)` (the closed bars' ATR, NinjaTrader's) · `setFitTop(px)` (room kept at the top of the
price scale) · `getFitTop()` · `on('bubble', fn)` (the large-order bubble under the mouse, or null) · `bubbleHover()` · `bubbles()` ·
`setProfileLines({ poc, vah, val })` · `getProfileLines()` (the developing profile lines) · `setVwapSource(fn)` (a page's own VWAP per bar) · `redraw()` ·
`setScaleLock(on)` · `scaleLock()` · `on('scaleLock', fn)` (the price scale lock; option `lockButton`)

Volume profile (1.6.0): `new ChartEngine.VolumeProfile({ tick, rowTicks, valueArea, rth })` counts
trades (`add(t, price, v)`) into rows with a POC and value area, per 18:00 ET session, or with `rth: true` only
9:30:00 up to 16:00:00 ET. `setProfile(profile | null)` hands one to the chart, drawn while the `vp` layer is on
(`setLayers({ vp: true })`, off by default) as bars from the right edge of the plot behind the candles; the chart
redraws on its own when the profile changes.

Chart signals (1.12.1): `new ChartEngine.Absorption({ settings, floorAt, tick })`, `new ChartEngine.LargePrints({ floorAt,
auto, tick })` and `new ChartEngine.DeltaDivergence({ settings })`, fed by the page (`add(...)`, `update(bars, valueAt)`);
`setSignals({ absorption, bubbles, divergence, version })` hands them to the chart, drawn while the `absorption`,
`bubbles` and `divergence` layers are on; the chart redraws when `version` changes.

Cumulative delta (1.7.0): `new ChartEngine.CumulativeDelta({ sessionStart, seconds, coveredFrom })` counts trades
(`add(t, v, side, barT, method)`, side 1 buy, -1 sell, 0 or none unknown) into one candle per price bar of the
running buys minus sells, from 0 at each 18:00 ET session, from `coveredFrom` on (the start of the page's
window of trades with measured sides). `setDelta(delta | null)` hands one to the chart, drawn in a pane below the plot while the `delta` layer is on;
`setDeltaView({ mode: 'cum' | 'bar', ratio, note, reason })`, `deltaPane()`, `deltaToY(v)` and
`on('paneResize', { ratio, height, done })` for the divider.

Orders (1.3.0): `setOrders(list)` · `setPosition({ qty, avgPrice } | null, { pointValue })` ·
`setOrderEditing(bool)` · `setOrderPreview(fn)` · `orderHandles()` · `priceToY(price)` · `yToPrice(y)` ·
`on('orderMove', { id, price })` · `on('orderCancel', { id })` · `on('orderPlace', { price })`. The chart only
asks; the page decides what to send. Order lines are display only until `setOrderEditing(true)`. 1.13.0: an item
with `plan: { parent, offset, role }` is a planned line drawn `offset` ticks from its parent order (following it while
the parent is dragged; its `orderMove` also has `from`, the parent price it was drawn from), and `adds: ['stop', 'target']` on an order draws "+SL" / "+TP" cells that fire
`on('orderPlanAdd', { id, which })`.

`on('legend')` fires with `{ bar, prev, index, forming, hovering }` whenever the bar under the
crosshair (or the forming bar) changes, so a page can draw its own OHLC legend.
`on('error')` (1.5.1) fires with `{ message, error }` when drawing a frame throws (the chart keeps running, and
each message is reported at most once per 5 s), and with `null` at the next clean frame.

### Helpers (`ChartEngine.util`)

`aggregate(bars, seconds)` rolls fine bars up; `foldLast(bars, seconds)` rebuilds just the newest one
for live updates; `addSessionVwap(bars, sessionStart)`; `sessionLevels(bars, opts)` gives prior-day
high/low/close, overnight high/low and the prior session's 70% value area; `levelLines(levels)` turns
those into styled lines; `initialBalance(data, opts)` (1.5.3) gives today's 1-hour Initial Balance (9:30 to
10:30 ET) from 1-minute bars or trades, with its state (`before`, `forming`, `locked`, or why there is none), and
`ibLines(ib)` turns it into lines; `rthDay(t)` and `nyseHolidays(year)` say which days have a regular session;
`profileRects(columns, view, emit)` lays out a volume profile's bars (1.6.0); plus
formatting and color helpers (`readableOn`, `legible`, `onGround`, `mix`, `buildTheme`); 1.14.0: `roomBars(px, spacing,
bars)`, `fitRange(lo, hi, extraPrices, plotHeight, tick, volume)`, `fmtRemain(seconds)`, `barRemain(t, barSeconds, now)`,
`atr(bars, period, count)`, `pctFrom(price, base)`, `bubbleRadius(size, floor)`, `rthVwap(bars, opts)`, `rthVwapUpdate(series, bars, opts)`, `vwapAt(series, time)`
and `PD_POC_DASH`.

## Colors

Defaults: bull `#4B9CD3` (Carolina blue), bear `#6D28D9` (deep purple), VWAP `#B69CFF`; the chart signals (1.12.1) a toned
cyan `#38DCE8` and warm yellow `#F3D84A`, with outlines `#9CF1F7` and `#FFEC8F` (theme keys `sigBull`, `sigBullLine`,
`sigBear`, `sigBearLine`; CHART_STYLE `--sig-bull`, `--sig-bull-line`, `--sig-bear`, `--sig-bear-line`).
`mountThemePanel(chart, host)` adds a **Colors** button with presets and pickers; choices are saved in
that browser. Its options (1.9.0): `vwap: false` leaves the VWAP picker out (the live page sets the VWAP in its gear),
`note` replaces the line at its foot, and the returned `slot` is an empty element above Reset for a page's own rows
(the live page's named chart and indicator presets). Trade marks use the house trade colors on purpose: entries are green (long) or red
(short), results are green (profit) or red (loss). Text drawn in a candle color is lightened
automatically so it stays readable.

**Background (1.5.3):** the panel's Background presets (Dark, the default; Black; Blue-grey; Light) and a picker
for any color set `theme.bg`. On the default ground every color is the locked palette. On any other ground
`buildTheme` derives the grid, axes, text and tags from it and moves every colored mark (candles, VWAP, levels,
trade and order colors) just enough to read, once per change, never per frame, keeping bull and bear, buy and sell,
and the IB high and low apart on every ground (buy and sell keep their green and red, outlined where needed). `getTheme()` returns the colors as chosen; `colors()` the colors as
drawn, including `text2`, `legendBg` and `ground` for a page's own legend; `util.chromeColors(colors())` gives the CSS
colors for a page's toolbar, and the live page's order bar, on any ground but the default (null there; 1.9.0, before
only on a light ground), which the live page and the demo apply.

## Develop

```sh
npm test          # unit tests (Node 20+, no install needed); with pwsh or Windows PowerShell also the updater's tests
npm i && npm run smoke   # drives the demo in Chromium, screenshots in test/out/
npm run smoke:live       # the live page against the fake bridge as ChartBridge 0.2 (read only)
npm run smoke:orders     # order entry against the fake bridge (protocol v2)
npm run smoke:settings   # saved choices survive a reload and a second chart tab
npm run smoke:hotkeys    # trading hotkeys: set in Settings, each sends what its button sends, refused combos, typing, reload, mounted
npm run smoke:embed      # ChartLive.mount in a plain host page: read only, reconnects, destroy, two panes
npm run smoke:pin        # the PIN on ChartBridge's page: set, unlock, reload, a restart mid-session, change, forgotten PIN
npm run smoke:perf       # Range 40 with 33 hours of sample ticks and a busy feed: the chart keeps drawing, no long frames
npm run smoke:ib         # Initial balance forming, locked, on every view and mounted; the Background presets, saved per prefix
npm run smoke:live-first # the served window and the session table: exact range bars, profile and VWAP against the fake's tape
npm run smoke:update     # "Update ready: reload when flat" with an open position: never over the order bar or the chart, never reloads
node test/perf-live.mjs --view=range --et=01:30   # the full measurement (frames, ticks, GC, heap); --root=DIR for another checkout
npm run check:nt8        # compile ChartBridge as C# 5 against stand-in NinjaTrader types (needs mono-mcs)
npm run check:orders     # the order gates, the PIN, the seam, trade sides, the served window, the daily bars and the 0.3.7 data side under Mono
```

Keep `CHART_STYLE.md` in step with the code, add a line to `CHANGELOG.md`, and bump the version in
`package.json` and `src/chart-engine.js` for every release.

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Manrae.
