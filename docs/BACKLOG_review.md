# Review backlog (chart-engine)

Review notes that do not block a merge, kept in one place (the minimal rulebook of 2026-11-11, rule 12). A note leaves
this file when a change closes it; the change says which. This file states no rule.

## With the next ChartBridge change (the review of 88 round 3 and 91, build answers 11)

Each with a check that fails when the fix is taken out.

The roster (`GET /roster`): D1, D3, D4, D2 and the harness gaps are closed by ChartBridge 0.6.21 (the top-level format key,
a drive-letter full path only, one 2 MB cap for an answer, the links said in PROTOCOL; `check/BotHarness.cs`).

The day's profit stop and Kill all (C4, the stale words, is closed by 0.6.21: the comment over the agent's part of Kill all
and PROTOCOL's step 2 now say what the code does):

- C2. A day start that never rolls makes the profit stop silent. Say it once when the wait lasts longer than a few
  seconds.
- C3. Two damaged day-file edges: an earlier day's file whose session line is the damaged one latches today; a line cut
  off after the account name loses the latch without a word.
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

From the third look at 92 (REVIEW_2026-11-11_chartengine_92_third.md, APPROVE WITH NOTES):

- T-1. A very tall alert banner in a short window is cut to 40% of the height, and its newest line and Dismiss are below
  the cut (three lines of about 700 characters at 700 x 400). The box scrolls, so nothing is lost. Kill all's own answer
  is a line of that length. Idea: under Legion the newest line first and Dismiss at the banner's top.
- T-2. The tab keeps 120 px at its foot but the banner may be 40% of the window: under the tallest banner in a short
  window the last rows cannot be scrolled clear until Dismiss. Rows and text only. Neither the height limit nor the foot
  room is held by a test.
- T-3. Under about 300 px wide the head row is wider than the window: Yes lies over a few pixels of the old button's box
  and Cancel runs off the right edge. A double click still sends nothing (the 600 ms rule). No real window is that
  narrow.
- T-4. In a short window the pinned head with a full Kill all answer leaves little for the rest (273 of 360 px at
  700 x 400; 224 of 728 px at 1024 x 768). Kill all stays at the top.
- T-5. At 700 px wide and under, the Legion button is off the right end of the page's top bar (the top bar does not
  wrap: the page's own layout from before 92). The address `?tab=legion` opens the tab.
- T-6. `flex-wrap: nowrap` on the head row is held by no test. It changes nothing at real widths, since the line that
  used to grow has its own row, and putting that line back in the head row does fail a test.

## Ruled, not open

- B/E, Merge and a strategy's key are off while a tab covers the chart (build answers 15, section 4).
