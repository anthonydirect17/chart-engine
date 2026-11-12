# Review backlog (chart-engine)

Review notes that do not block a merge, kept in one place (the minimal rulebook of 2026-11-11, rule 12). A note leaves
this file when a change closes it; the change says which. This file states no rule.

## With the next ChartBridge change (the review of 88 round 3 and 91, build answers 11)

Each with a check that fails when the fix is taken out.

The roster (`GET /roster`, `ChartBridgeRoster` in `nt8/ChartBridgeAgents.cs`):

- D1. A roster file is "an object whose `format` is": check the top-level key. Today the text may sit anywhere in the
  file, so a settings file holding it in a nested object is served whole. (The Legion tab already refuses such a
  file: it reads the top-level key.)
- D3. `rosterFolder` takes a drive-letter full path only. Refuse `C:roster`, `\roster` and `\\server\share\...` (the
  last would make the process that holds the order door open a network share on every request).
- D4. One total cap for an answer, about 2 MB, as the bot library has (200 files of 256 KB is a 40 MB answer today).
- D2. A hard link in the folder is served; a parent folder that is a link is followed; a file swapped for a link after
  the listing is followed. Each needs write access to the folder. Say it in PROTOCOL, or open the file and check what
  was opened.
- Harness gaps: a method other than GET and HEAD; a file error must send the exception's type only; a top-level list
  holding the format text; bad UTF-8 bytes; a file that is a link.

The day's profit stop and Kill all:

- C2. A day start that never rolls makes the profit stop silent. Say it once when the wait lasts longer than a few
  seconds.
- C3. Two damaged day-file edges: an earlier day's file whose session line is the damaged one latches today; a line cut
  off after the account name loses the latch without a word.
- C4. Stale words: PROTOCOL's Kill all section and the comments at `ChartBridgeAgents.cs` 1018 to 1022 and 4702 still
  say "ALL in scope" and "on every seat".
- Uncaught breaks: a read of the day file forgets the latch kept in memory; the second at 18:00 said as "NOT checked";
  the SHORT line said whenever a job is dropped with a position left, flipped or not.

Before any prop account is live (the coordinator's card, not a build item): C1 with F6, the account's Realized in
NinjaTrader at 17:59, 18:01 and 18:10 New York.

## With D2, the lanes and the Armed slider (the reviews of 92, build answers 13 and 15)

- PROP 4, what is left: the traders and the prop accounts above the roster (the head is pinned since the fix round).
- PROP 5. "Not heard yet" told apart from "no": when that is the only reason Kill all is not offered, Yes sends and
  ChartBridge answers. Also: before the first `accounts` message the line under the title says "No trader is in Auto on
  a prop account" (not known yet, not no).
- N12. The page works out the day stop mark and "reached" itself; ChartBridge owns both. Show ChartBridge's.
- Escape cancels the question wherever the focus is while the tab is open (today: only with the focus inside the tab).
- The three sections are set again on every message when their HTML is unchanged only by comparison of the whole
  string (harmless to Kill all: the head is kept; wasteful with a long roster).
- A real tablet tap, a pen and a remote desktop click on Kill all and Yes: to be tried by hand once, on Sim.
- N4, what is left: a file whose `above_no_edge` word contradicts its own numbers is shown (Bot-Lab's reader refuses
  it), and a range that leaves out its own number.
- The roster's line shows the number without its range (the range is in Details). While "Reading the roster again..."
  shows, the cards sit one line lower: a click aimed at one Details can land on the next card's.
- Under Legion and League the Reject key declines a bot proposal that is not shown on that tab (it can only decline).

## Ruled, not open

- B/E, Merge and a strategy's key are off while a tab covers the chart (build answers 15, section 4).
