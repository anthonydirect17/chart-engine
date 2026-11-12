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

Closed by chart 1.46.0 (D2, the first half: the lanes, the pick, the Armed switch), each with a check: PROP 4 (the
lanes, the traders and the prop accounts are above the roster), PROP 5 ("not heard yet" is not "no": Kill all is offered
before the first `accounts` message and the line under the title says so), and Escape (it cancels a question wherever
the focus is while the tab is open).

- N12. The page works out the day stop mark and "reached" itself; ChartBridge owns both. Show ChartBridge's. Not done
  in 1.46.0: ChartBridge does not send either to a page (only the plan's `dayStop` on `agent`), so this needs a
  ChartBridge change first (the mark and "reached" on each row of `accounts`).
- The account-move gap (the review of 97, F4; build answers 18, point 3), beside N12 for the next ChartBridge change:
  ChartBridge does not refuse `accountGroup` or `memberBench` by the state of the trader whose group it is (it refuses a
  bench only while that one account is not flat, and a join only for the bot's, the copier's or another agent's own
  account). The page refuses (`FleetCore.laneLock`, and the narrow feed bound to its lane, 1.47.0), and that is a
  courtesy, not a guard. Wanted: both refused by ChartBridge while the group's agent is in Auto or Copilot or owns
  anything, and `accountGroup` carrying the group the page believes the account is leaving (closes the page's
  stale-copy race: an account moved in another window a moment before).
- R3-3 of the third look at 94 and 99 (answers 26), beside N12 for the next ChartBridge change: ChartBridge also sends
  `agentStandDowns` from other threads on any stand-down change, so in a rare case one lands in the middle of a
  sign-in replay and Legion reads the traders as heard early; the 1.5 s floor covers it until then. Wanted: an explicit
  "replay done" message after the replay (item 7 of the design note
  FROM_BUILD1_2026-11-12_design_next_chartbridge_change.md in TradingApp_Handoff).
- D2, the second half: an account moved into or out of a lane by drag and drop (`accountGroup`, with the Accounts
  tab's own join question: the highest close and the account's rules from its type).
- The Armed switch's question and Kill all's question can both be up at once (each has its own buttons and its own
  line). Harmless; one at a time would be tidier.
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
