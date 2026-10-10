# The Agent tab (chart 1.17.0)

Where Anthony watches and controls his AI trading agents, next to the Bot tab. Manrae is the first agent; the tab serves
any number of them. It is the page's side of ChartBridge 0.5.0's agent channel (contract AGENT_CHANNEL v1, 2026-10-08:
section 7 is the page's interface, sections 3 to 6 say what the page shows and what ChartBridge refuses). ChartBridge's
own side is `nt8/` and `nt8/PROTOCOL.md`, built separately.

**AI is never in the order path.** The page never builds an order for an agent. Accept sends `agentAnswer` with the
proposal's id; ChartBridge places the entry itself, from the plan's own numbers, inside the agent's rules. The mode, the
kill switch, the rules, the account and the answers are the only agent messages the page sends, and ChartBridge checks
every one again.

## Files

| file | what |
|---|---|
| `live/agent-core.js` | `AgentCore`: the logic, no page in it (Node tests run it): agents and the picker, proposals and their countdown, the feed, the rule form and its checks, the account chooser, the agent's orders by its mark, the one copilot-key router, and board F's light (`lightState`), stream tones and drawer records (`rowTone`, `decisionRecord`), session trail (`sessionTrail`), room (`roomLines`) and Motion switch (`motionPref`) |
| `live/agent.js` | `AgentDesk`: draws the tab from AgentCore on the window's one v3 connection |
| `live/agent.css` | its look: board F (below), scoped to the tab |
| `live/fonts/agent-fonts.css` | Chakra Petch and JetBrains Mono from this PC (Latin subset, `OFL-agent.txt` beside them) |
| `live/agent.html` | the tab in its own window (Pop out, for a third monitor), on its own v3 connection |
| `test/agent.test.js` | AgentCore's unit tests, and the files' wiring |
| `test/fake-v3.mjs`, `test/fake-bridge.mjs` | the fake ChartBridge speaks the agent channel (`--agents=demo`): the made-up "Demo Agent" |
| `test/fake-v3.test.js` | the fake's agent tests, and its `/agent/<id>` socket |
| `test/agent-smoke.mjs` | `npm run smoke:agent`: the workspace against the fake, screenshots in `test/out/agent-*.png` |
| `test/agent-targets-smoke.mjs` | `npm run smoke:agent-targets` (also run by `smoke:agent`): Accept and Reject never covered, never dropped, never moving (below) |
| `test/perf-agent.mjs` | `npm run perf:agent`: the light's cost in a trade over a busy chart (`docs/MOTION.md` R5) |

Shared code changed (each change small and tested): `live/bot.js` hands its open proposals to the one copilot-key router
instead of owning the `chart-copilot-key` event; `live/bot-core.js` `botFillLedger(mark)` takes an optional mark (the
agent's); `live/accounts.js` names an agent's order "agent demo" on the Account page; `live/workspace.js` mounts the tab,
keeps one tab open at a time and lets the copilot keys work for agents; `live/index.html` loads the files;
`nt8/install-files.json` lists the four page files in its `www` part (see the lead's defaults).

## The look

Board F of Anthony's mockups (2026-10-08: "love it, lets build F into the real agent tab"; the Judgment colour and the
light's pace as he corrected them the same day). Board A's information in board F's look. Everything is scoped to the
tab (`.ag-view`): the top bar, the corner proposals and notices, the chart and every other tab keep the page's look.

- **Ground and colours:** a blue-black ground (`#010307`) with two faint radial glows; cyan (`#5df2ff`) is the base colour
  of lines, labels and figures. Purple (`#6d28d9`, `#7b5cff`, `#b69cff`, `#d8ccff`) and red (`#ff3b5c`) only on a few
  buttons, chips and words: the agent's name, the SIM chip and Reject in purple; the kill switch, a LIVE account's chip
  and the losses in red. Green and red for P&L.
- **Fonts (Anthony's hybrid):** Chakra Petch for titles, section labels, tabs and buttons; IBM Plex Sans for body text
  (his words, the proposal's reason, the stream's rows, notes, explanations); JetBrains Mono for every number. All three
  come from this PC: IBM Plex as for the whole page (`fonts/plex.css`), Chakra Petch (400 to 700) and JetBrains Mono (400,
  600) in `live/fonts` (Latin subset of npm `@fontsource` 5.2.5, SIL Open Font License, listed in
  `nt8/install-files.json`). The page loads nothing from the internet (1.16.0); a missing font falls back to the
  system's own (Segoe UI, Consolas).
- **Panels:** thin cyan borders on a dark glass; the light (below) circles the ones where his attention is.
- **Only what is needed to understand and use the page** (Anthony 2026-10-08: "I dont need the labels in profit or under
  water, I also dont need the light legend on the bottom or any other embedded labeling like that"): section titles,
  field names, values and numbers, buttons, and the words that need him to act (ChartBridge's refusals, the LIVE account
  question, the kill switch, a lost connection, Accept's last 5 s). No legend of the light's colours, no step captions, no
  sentences that explain how the page works; a figure not reported says "not reported" (ChartBridge's own words in its
  tooltip), a sent change says "Sent." for a few seconds. The colours below are written here, not on the page.

## The light

One slow comet light circles the borders of the panels where the agent's attention is, brighter at its head, with a
soft halo, and those panels glow softly. Where it circles and its colour follow his real state, worked out by
`AgentCore.lightState` (a pure function, unit tested) from the messages the page already gets: his `agent` message, his
notes and plans, his proposals and this window's answers, his own orders (`by: "agent:<id>"`) and his position, his open
P&L. Nothing is guessed: what the channel does not say is not shown.

| state | colour | where | from |
|---|---|---|---|
| watching | cyan `#5df2ff` (Screen) | the tracker | nothing newer below |
| a look | violet `#8f7bff` (Eyes) | the tracker and the stream | a `look` note in the last 2 min |
| judgment at work | magenta `#c81fe0` (Judgment) | the tracker and the stream | a `thinking` note in the last 2 min |
| a plan | magenta `#c81fe0` | the tracker and the proposal | a proposal open for you, or a Shadow plan in the last 2 min |
| his rules being checked | gold `#ffd23f` (Checks) | his account and the proposal | you pressed Accept and ChartBridge has not answered yet |
| placed | green `#3dff9a` (ChartBridge) | the proposal and the chart | his own entry works |
| a go | green | the proposal and the stream | a plan placed or accepted in the last 30 s |
| he passed, a plan ended | orange `#ff8a2a` | the proposal and the stream | a skip, or a proposal rejected, expired, withdrawn or not answered, in the last 30 s |
| a hard no | red `#ff3b5c` | his account and the proposal | a plan ChartBridge refused, in the last 30 s |
| in a trade | green at or above zero, red below | the chart and the P&L footer | a position; its open P&L (cyan while the P&L is not known yet) |
| out of the trade | green for a gain, red for a loss | the tracker and the P&L footer | a flat exit this window saw, in the last 30 s |
| kill switch on, stood down | red | his account | the `agent` message |
| not connected, off | no light | | the `agent` message |

The newest event inside its hold wins; a position, a working entry, an answer waiting for ChartBridge and an open
proposal come first, in that order. The tracker's step (Screen, Eyes, Judgment, Checks, ChartBridge) and its line follow the
same state, in plain facts ("A look", "A plan is waiting for you", "In a trade, long 1 MNQ", "Out of the trade: +$32.00");
how a trade is going is the light's colour and the P&L figure, never words.

- **Pace:** about 13 s a lap while he decides, about 9 s in a trade.
- **Open P&L** (lead's default): NinjaTrader's `unrealized` for the agent's account from ChartBridge's `accounts` message,
  when that account holds nothing but the agent's root; else from the chart's last price, the position's average price
  and the point value; else not known. Never estimated further.
- **Colour changes fade** (1.6 s): the light and the glow only. The glow fades through `--ag-pc`, a registered colour that
  is not inherited, set on the panels alone; the light crossfades between two copies of itself (the old colour and the new)
  by their opacity alone. So a colour change restyles a handful of elements, never the whole tab.
- **Cheap** (after the review of fc3101a, which measured the old light at a p95 frame of 66.7 ms against 16.8 ms with Motion
  Off, at 1920 x 1080 in headless software rendering): pure CSS, no script per frame. The line is four 3 px strips along
  the lit panel's border and the halo four soft 30 px strips across it (a linear-gradient mask for its softness, in place
  of the old 7 px blur); each strip clips its own copy of one small conic gradient centred on the panel's centre, and that
  copy turns by a CSS transform on the compositor. Nothing is painted again per frame, nothing is blurred, and only the
  strips' pixels are drawn. A conic gradient looks the same at any size about its centre, so one of 512 px scaled 8 times
  covers any panel: the same angle, colours and laps as before. None on a panel that is not lit. The state is worked out
  again only when a message arrives (ChartBridge sends `agent` once a second while connected, so a hold ends on the next
  one). `npm run perf:agent` holds it (below).

## Motion

`docs/MOTION.md` R3 holds: only the border light and the panels' glow move or fade. The P&L figures (today, open), the
position, the trades and losses, the chart and its price line, Accept and Reject, the kill switch and the mode change at
once, with no transition, easing or count-up, and are marked `data-no-motion`. The ChartMotion kit is not used on the tab.

- **The Motion switch** (in the strip: Full, Off) is kept in this browser (`live-agent-motion-v1`, every read and write in
  a try, Full when storage is blocked). Off hides the light and stops every animation and transition in the tab; the glow
  stays, still, on the panels where his attention is.
- **The system's reduced motion** does the same, whatever the switch says.

## His stream and the decision drawer

Every row of his stream (a note, a plan or skip, a fill, an exit) is a real `<button>`. A click opens his record of that
decision in a drawer over the right column, outlined in that decision's colour:

- **In his words:** the note's text, or the plan's reason.
- **The facts:** for a plan, the entry, stop and target (ticks and prices), the risk and the reward ratio, how long the
  entry lives, the setup, the confidence, ChartBridge's verdict on his rules (passed, or refused and why), and for a
  proposal how it ended, when you saw it, when you answered and how fast, and until when it was open. For a fill, the
  side, size, price, time and account. For an exit (from his own fills), in and out, the result before fees and how long
  he held.
- Only fields that exist. The channel carries no "for and against", no notebook rule cited by a plan and no time or cost
  of his thinking (board F showed them), so none is shown.
- **Closing:** Close, the same row again, or Escape while the focus is inside the drawer (the focus goes to Close when it
  opens and back to the row when it closes). There is no key handler on the page, so the order hotkeys and the page's own
  Escape are untouched; a row is a button, not a box, so the hotkeys work with the focus on it.
- **Where it sits** (lead's default): over the right column, never over the proposal panel while anything there is open
  (the agent's own proposal, another agent's or the bot's: every Accept and Reject stays in sight), and above the last part
  of the stream when there is room; while it is open the stream's rows start below it, so its row stays in sight even in a
  short list. It appears at once, with no slide (R3: it shows prices, risk dollars and P&L, and its Close button).
- **A long record** scrolls inside the drawer (never the page), and "more below" shows at its foot until its end is in
  sight.

## What the tab shows

- **The strip:** the agent's initials, name (purple) and build (as its hello says them), connected with the heartbeat's
  age, the mode, the account with its SIM or LIVE mark, the position, KILLED or STOOD DOWN with why, and while ChartBridge
  says the agent holds the owner lock, "OWNS SIM-AG1 MNQ"; the Motion switch and Pop out. With two or more agents, a
  picker (the choice is kept in this browser).
- **Left:** the mode (Shadow, Copilot, Auto), the kill switch, status, heartbeat and the last plan; his account with its
  mark, the room left (max loss room from ChartBridge's `roomDrawdown`, daily limit left from `roomDailyLoss` or The
  Desk's limit, each with the limit and a meter when known, else ChartBridge's words why) and Change account; the rules in
  force and Change the rules, with ChartBridge's refusal under the button.
- **Centre:** "What he is doing now", the tracker (Screen, Eyes, Judgment, Checks, ChartBridge) with a line in the light's
  colour; under it a normal live chart (never animated, takes no orders) of the agent's root, with the agent's own working
  orders, stop and target as lines (`by: "agent:<id>"` only), its trades today as marks and the chart's own live price
  line; its header has the root, the bars, the indicators and the position with its open P&L.
- **Right, the proposal:** each open proposal: side, quantity, root, kind and price (and limit price for a stop-limit),
  the setup, the confidence, the reason, stop and target in ticks and prices, the risk in dollars and the reward ratio, the
  account and its mark, a live countdown to `expiresAt`, Accept (cyan) and Reject (purple), with The Desk's keys on them.
  Accept and Reject never scroll out of sight: they stay at the foot of the proposal's box while its words scroll, with
  ChartBridge's words for that proposal right above them in the same foot (a refusal, "Under 5 s left", "Accept sent.
  Waiting for ChartBridge."; a card keeps that one line even while it is empty, so a word coming makes it no taller).
  **Only the shown agent's proposal is a card on the tab** (Anthony, 2026-10-08). It has a slot of a fixed height at the
  panel's top (`clamp(190px, 30vh, 380px)`: at 1366 x 768 230 px, which still shows its head and its Accept and Reject),
  reserved whenever the tab is shown, with "None open" in it at the same height when it is empty; its words scroll inside
  the slot and its Accept and Reject stay at the slot's foot, in the window without scrolling at 1000 x 800, 1366 x 768,
  1600 x 900, 1920 x 1080 (on a phone, 390 x 844, in the panel's first screen). Its proposal arriving, ending or going
  moves nothing. Nothing covers its Accept and Reject, at any size, in the workspace and in the pop-out.
  Under the slot, one line of a fixed height (30 px) counts the proposals open elsewhere, by whose: "Bot: 1 proposal ·
  Second Demo Agent: 1" (the agents by their display names). Each name is a link: the bot's opens the Bot tab, where its
  proposals are answered with their Accept and Reject as before; an agent's shows that agent in this tab (as the picker
  does), its proposal then in the slot. With none open the line keeps its height and says "No other proposals". It has no
  Accept or Reject, never changes height, and a count that rises is marked at once and stays still for 8 s (R3: nothing
  in it moves or fades). The bot's and the other agents' proposals are never cards on the tab: no list, no corner, no
  placeholders; the corner (the Bot tab's, with the bot's proposals, or the window's own) is hidden while the tab is shown,
  and always in the pop-out. So the others arriving and leaving move nothing on the tab. Switching the agent shown is
  deliberate: the slot changes then.
  The slot is written only when its cards changed, so a button keeps its focus and a press held across an agent message
  still clicks.
- **Right, his stream:** notes (look, thinking, lesson, notebook, status), plans (with their result: shadow, waiting for
  you, accepted in 1.3 s, rejected, expired, refused and why, skipped), and his fills and exits today, newest first, with
  filters (All, Plans, Notes, Thinking, Lessons). Each row opens the drawer above.
- **The footer:** today's P&L (ChartBridge's `pnlToday`, with the open P&L beside it in a trade), trades and losing trades
  (of the limit when the rules set one), his session as a light trail from the rules' `entryFrom` to `flatAt` (09:45 to
  15:55 by default) with now and his fills (F) and exits (X, green or red by result).
- **Corner:** an agent's proposal is answered only in the Agent tab (the re-review of c47a8a1: two agents' cards and the
  bot's ran the corner 207 px over the top bar at 1366 x 768). With the tab closed, one line of a fixed height (30 px) in
  the corner wherever Anthony is counts the agents' open proposals, "Demo Agent: 1 proposal · Second Demo Agent: 1"; each
  name opens the Agent tab on that agent; with none open the line is gone, and its room stays (while agents are known the
  Bot tab's corner sits 40 px higher), so its coming and going moves no bot card. No agent Accept or Reject exists
  outside the tab. The Bot tab's corner shows ONE bot card at a time (the re-check of e87ba23): the oldest open
  proposal, the one the keys answer, whole, with one line of a fixed height (24 px) under it, "+6 more bot proposals"
  (empty with none waiting). No stack and no scrolling: a proposal arriving is counted in that line and moves nothing;
  a card that ended shows its words until it goes, and then the next one takes its place. When the card shown changes
  (the last one answered, expired or withdrawn, or one arriving in an empty corner), its Accept and Reject and the keys
  are off for 1 s, disabled at once with no animation (R3): a press or a click in that second does nothing and is not
  kept, so a fast double press never answers the next proposal landing in the same place. The keys answer only the card
  shown, once armed and whole in the window under the top bar ("The bot's proposal has just come into the corner: press
  again in a moment" otherwise). The card is at most the window less the top bar, 16 px and the line (its reason
  scrolls inside when it must), so the corner never reaches the top bar. `botSeen` goes when a card shows. While the
  Agent tab is shown the Bot tab's corner and the agents' line are hidden and
  the tab counts what is open (above). Notices for
  an entry, an exit, a stand-down, the heartbeat, the kill switch, the mode, the account and how a proposal ended. While
  the Agent tab is shown the notices cover none of it: they stack over the chart's lower left, above its time axis (over
  the oldest bars), never over the controls, the rules, a proposal, the stream or the footer. The workspace's ChartBridge
  line (its warnings and errors, until dismissed) lies across the chart's top while the tab is shown, so its coming and
  going moves nothing in the tab (it pushed the whole tab down 46 px before). At 1100 px and narrower the chart sits far
  down the tab, so both are pinned at the top instead, in a band of their own of a fixed height above the tab's scrolling
  part (66 px, 96 px on a phone; they scroll inside it): always in sight, over no Accept or Reject, and moving nothing.
- **Smaller screens:** at 1366 x 768 everything fits the window with no scroll; narrower than 1100 px the controls and the
  proposal (with the stream under it) sit side by side at the top, the chart under them across both (the tab scrolls); on a
  phone the controls, then the proposal and the stream, then the chart, the words under the mode, the account and the rules
  keeping their two lines while empty so they move nothing under them; on a phone everything stacks, with no sideways scroll
  (the workspace's top bar wraps while the tab is open there).

## Page messages (contract section 7), exactly

| message | keys | when |
|---|---|---|
| `agentMode` | `type, cid, agent, mode` | a mode button (Auto asks a second click within 4 s) |
| `agentKill` | `type, cid, agent, on` | the kill switch (on in one click; release asks a second click within 4 s) |
| `agentSeen` | `type, agent, id, at` | once per proposal, the moment it shows in a window Anthony can see |
| `agentAnswer` | `type, cid, agent, id, answer, at` | Accept or Reject (a button or the copilot key), once per proposal |
| `agentAccount` | `type, cid, agent, account` | Change account (a LIVE account asks once, in the page) |
| `agentRules` | `type, cid, agent, roots, maxQty<ROOT> (each root chosen), entryFrom, entryUntil, flatAt, maxExpireSec, maxTrades, maxLosses` | Change the rules; flat keys, `roots` a comma list, `0` is none |

The page checks the rules against section 3 before sending (nothing ChartBridge would refuse for its values is sent):
at least one root, each served and not quote only; a size from 1 to the ceiling (2 for NQ and ES, 20 for MNQ and MES);
New York times `HH:MM`, in session order from the 18:00 open (ChartBridge 0.5.2, chart 1.18.1): `entryFrom` before `entryUntil`, `flatAt` after it and at most 15:59, so 18:00 to 15:25 flat 15:55 runs across midnight;
`maxExpireSec` 60 to 1800; `maxTrades` 0 or 1 to 50; `maxLosses` 0 or 1 to 20.

## With an older ChartBridge

The Agent tab button shows with any ChartBridge that speaks v3 (as the Bot tab's). Before 0.5.0 (the version in its
hello) the tab says "No agents on this ChartBridge (0.5.0 or later)." and the page sends no agent message; with 0.5.0 and
no `agents` line in config.txt it says none is named there. Everything else works as 1.16.0.

## The fake ChartBridge

`node test/fake-bridge.mjs 8765 --v3 --trading --agents=demo --agent-any-time` (`npm run bridge -- ...`): the made-up
"Demo Agent" (id `demo`, build `sample-build-1` when a test control connects it) and the made-up Sim account `SIM-AG1`
(checked for trading) for it to take. Every agent starts on Sim101 (no account file) in shadow. The test controls are in
the bridge's header (`/test/agent-connect`, `/test/agent-plan`, `/test/agent-proposal`, `/test/agent-note`, ...).
Everything there is sample data.

## Lead's defaults

Where the contract or the brief left a detail open, the safest simple choice, written here:

1. **How the page knows of agents (lead's default):** there is no switch for the channel in `trading.switches`; the page
   shows what `agent` messages tell it. The tab button shows with any v3 ChartBridge; older than 0.5.0 (hello's version)
   it says "No agents on this ChartBridge (0.5.0 or later)."; 0.5.0 or later with no agent, "none is named in its config.txt".
2. **Kill and Auto (lead's default):** as the Bot tab: the kill switch goes on in one click (stopping is never delayed) and
   its release asks a second click within 4 s; Auto asks a second click within 4 s. The contract's "a second click within 4
   s for Auto and for Kill, as for the bot" is read as the bot's behaviour. A second click under 400 ms after the first is
   the same double-click and is ignored, so a double-click never confirms (the review's S3; the Bot tab the same, through
   `BotCore.confirmStep`, its behaviour otherwise unchanged). A click on the kill switch within 1 s of a kill-on is the same
   press (`AgentCore.killOnRepeat`): a double click sends `agentKill` on once, and never arms the release.
3. **One copilot key (lead's default, after the review of 19e9ef0):** the `chart-copilot-key` event has one handler for the
   bot and every agent (`AgentCore.copilotRouter`). Which proposal a key answers:
   - With the Agent tab open: only the shown agent's proposals, the oldest of those. No key ever answers the bot's or
     another agent's there (they are not shown on the tab, only counted: open the Bot tab or that agent to answer them).
     With none of that agent's open, or the tab on its "no agents" card, the key answers nothing and says so. The Bot
     tab's own keys are the same keys through the same router: while the Agent tab is shown (the bot's corner hidden)
     they answer no bot proposal; on the Bot tab (its corner shown) they work as 1.16.0.
   - Anywhere else: the bot's oldest, exactly as 1.16.0. An agent's proposal is answered only in the Agent tab (the
     re-review of c47a8a1): the tab gives the router its proposals only while it is shown, so off the tab no key ever
     answers an agent's proposal, even one alone (the keys used to answer one there when it was the only one open).
   - (`AgentCore.copilotRouter` keeps its rule for a page that gives it agents' proposals off the tab, which this page no
     longer does:)
   - Anywhere else, with an agent proposal open: when exactly one proposal is open across the bot and every agent, that
     one; when more than one is, none, and the workspace's line says "More than one proposal is open: click the one you
     mean".
   - For every key answer but the bot's own: the keys rest 1 s after an answer; a proposal must have been on screen 1 s; a
     proposal in its last 5 s (or with no expiry) is never a key's; an answered proposal waiting for ChartBridge stays the
     key's target (a second press finds it again and sends nothing). So a double press can never answer a second,
     different proposal (the review's B1). What the key did not do is said on the workspace's line.
   `bot.html` (no AgentCore) keeps the 1.16.0 handler.
4. **The copilot keys for agents (lead's default):** Accept and Reject keys work and show in Settings while the bot switch
   is on or ChartBridge has told of an agent. The Desk's hotkeys are still read only while a switch needs The Desk, as in
   1.16.0.
5. **Where a proposal shows (Anthony, 2026-10-08):** in the tab's proposal panel for the agent shown there, in its fixed
   slot at the top; while the tab is shown the bot's and every other agent's are only counted, in one line under the slot
   (each name a link to the Bot tab or to that agent), and the corner is hidden; on the Bot tab the bot's show with Accept
   and Reject as before; with the tab closed, agents' proposals are only counted in the corner's line (each name opening
   the tab on that agent) and the bot's are its own cards in the corner. `agentSeen` goes once, the moment it shows in the
   slot of the tab (the agent shown) in a window Anthony can see (a hidden window sends it when it comes to the front), as
   `botSeen`; a proposal only counted is not seen yet.
6. **Accept in the last 5 s (lead's default):** ChartBridge refuses an accept with under 5 s left as expired, so the page
   closes Accept then and says why; Reject still goes. The countdown runs on this PC's clock against ChartBridge's
   `expiresAt` (the same PC). A proposal with no `expiresAt` is never accepted; one with no `sim` is marked LIVE, as an
   unknown account is everywhere. Cards and the picker show each agent's id next to its name.
7. **Rules as `agent` carries them (lead's default):** read in any form the contract leaves open: `roots` as "NQ,MNQ" or a
   list, `maxQty` as an object or flat `maxQty<ROOT>` keys, "none" as null, 0 or "none". The fake sends `roots` "NQ,MNQ",
   `maxQty` an object and none as null.
8. **The rule form's roots (lead's default):** NQ, MNQ, ES and MES (the roots with a ceiling in the contract), each offered
   only when this ChartBridge serves it and it is not quote only. `maxQty<ROOT>` is sent for each root chosen, never for
   one not chosen.
9. **When the rules and the account can change (lead's default):** the page offers both only while the agent is flat with
   no working entry and no open proposal (ChartBridge refuses them otherwise and says why under the button).
10. **The account chooser (lead's default):** every account ChartBridge says is tradable, SIM first, each marked; the bot's
    account, the copier's leader and followers and another agent's account are listed but not offered, with the reason
    (ChartBridge refuses them anyway). **An account change keeps the agent's mode** (ChartBridge 0.5.2, Anthony 2026-10-08;
    until 1.18.0 it went to Shadow): the LIVE question names the mode ("Agent demo will trade LIVE account EVAL-A in Auto.
    Continue?"); not confirmed, nothing is sent and the account stays. The message carries `keepMode`, the mode the question
    named (for a SIM account, the mode shown), and ChartBridge keeps the mode only if it is still that one; otherwise the agent
    goes to Shadow (another page changed the mode meanwhile). `keepMode` goes only to ChartBridge 0.5.2 or later (by the hello's
    `version`; 0.5.1 refuses a key it does not know): to an older one the question says Shadow ("This ChartBridge (before
    0.5.2) puts it in Shadow when its account changes.") and the page says so after sending; with 0.5.2 it says the mode is
    kept. The question records the mode once, when it opens, and is never redrawn with another: if the agent's mode changes
    while it is open (another page), it closes with a note ("demo went to Auto while the question said Shadow: nothing was
    sent. Choose Set to be asked again."), nothing is sent, and Set asks again naming the mode then (the 0.5.2 re-review).
11. **The agent's chart (lead's default):** its root is the one picked in the chart's header, else the position's, else a
    working entry's, else an open proposal's, else the last plan's, else the first of its roots. Its trades come from
    fills claimed against its own marked orders (`BotCore.botFillLedger` with the agent's mark, as the bot's), kept in this
    browser for the trading day (`live-agent-fills-v1`).
12. **ChartBridge's own words (lead's default):** its warnings and errors are the workspace's ChartBridge line (not
    repeated); an `info` line naming an agent (its flat time) is a corner notice too. In the pop-out (no workspace line)
    every `status` line naming an agent is a notice. A line names an agent when it starts with its id ("demo flattened at
    15:55 by its rules", "Agent demo: ...") or says "agent <id>" anywhere, in any case ("agent demo had an open trade on
    ...", "SIM-AG1 MNQ is no longer agent demo's: ...", "SIM-AG1 MNQ: agent demo's 1 closed; ..."): `AgentCore.statusAgent`.
13. **The feed (lead's default):** kept in memory; ChartBridge sends the last 200 notes and 50 plans again when a page signs
    in, and repeats are dropped. A refused plan never replaces a plan of the same id that was not refused (a duplicate id
    the agent sent): it is its own line. A proposal's outcome shows on its plan as this window saw it ("accepted in 1.3 s");
    another window shows "proposed" for one that ended before it opened.
14. **No agent strip on the Main tab (lead's default):** the bot strip stays the bot's; the Agent tab button marks a
    proposal waiting (a lavender dot) and an agent killed, stood down or lost (red).
15. **One tab at a time (lead's default):** opening the Agent tab closes the Bot tab and the other way round; a layout
    closes either; `?tab=agent` keeps it over a reload.
16. **`nt8/install-files.json` (lead's default, a deviation from the brief):** the brief keeps `nt8/` for ChartBridge's
    builder, but the installer and the PC updater copy only the page files this list names, and four tests check it, so
    its `www` part gains the four page files (`agent.html`, `agent.js`, `agent-core.js`, `agent.css`). Nothing else in
    `nt8/` changed. The other builder's additions go in `addons`, so the two merge without a conflict.
17. **The order ticket on an agent's pair (ChartBridge 0.5.0 as built):** while an agent owns (account, root) by the owner
    lock (`owns`, its position's root or a root where one of its own orders works), the ticket sends only a market exit
    that reduces (no bracket, no strategy). Any other order is refused before it is sent, in ChartBridge's words: "SIM-AG1
    MNQ belongs to agent demo: use Flatten, or move its stop or target". Flatten and moving or cancelling its stop or target
    work as always. ChartBridge refuses the same either way; the single chart page (no Agent tab) leaves it to ChartBridge.
18. **ChartBridge's words, shown as they come:** a refused plan that carries "(and N more refused plans in the second
    before, not shown)" is shown as is (ChartBridge sends at most one refused plan a second per agent). The warning when a
    cancel is not confirmed (and its error after 10 tries, and the last one at 30 minutes), the NOT FLAT errors (an account
    NinjaTrader no longer lists, the market shut, the market not trading, a close that ended unfilled), "... is no longer
    agent <id>'s", "agent <id>'s N closed; the rest ..." and the lost-trade errors are ChartBridge `status` lines: the
    workspace's ChartBridge line shows them as it shows every other warning and error (the pop-out as notices, 12 above).
19. **The fake ChartBridge follows ChartBridge 0.5.0 as built** (`agent-channel` 4d4a81f, `nt8/PROTOCOL.md` "Agent channel
    as built"; brought up from fb15822 after the review of fc3101a):
    - Each agent starts on Sim101 unless its account was chosen (`agentAccounts`, the account file). Only a chosen account
      is the agent's: the bot, the copier and other agents refuse only that. A clash stands the AGENT down in plain words
      ("Sim101 is also the bot's account: choose an account for agent demo on the Agent tab (an agent never shares an
      account)"): the bot's account and the copier's leader and followers, whatever the switches; another agent's chosen
      account, or two agents both on their unchosen default. `agentAccount` refuses those accounts and puts the agent in
      shadow. The bridge adds the made-up Sim accounts `SIM-AG1` and `SIM-AG2` for agents to take.
    - Hello first: anything before `agentHello` is refused unread, is no heartbeat, and never reaches the pages. After every
      `agentHello`: `welcome`, `agentState`, then the snapshot: a `position` per root of `welcome.instruments` (the roots it
      serves) on its account (a flat one too) and an `order` per working order of its own on those roots, ending with
      `{"type":"snapshot","roots":[...]}`. A socket that never says hello, or says nothing, is closed after 5 s. The rate is
      counted first (every message but `beat`).
    - Every plan id seen today is used, refused or not. Refused plans reach the pages at most once a second per agent; the
      next one shown says how many were held, and with no plan after them the timer shows the latest held one, with the
      count of the rest, within about a second. A refused duplicate never replaces the plan it copies.
    - Checks as built: stood down includes a clash; the account listed by NinjaTrader; a stop-limit refused with
      `orderTypes` off; the size the smallest of the agent's `maxQty`, the ceiling and config.txt's gate 3 cap (ChartBridge
      0.5.3: with no `maxQty.MNQ` line an agent's MNQ cap is 20, the page's stays 1);
      `maxBracketTicks` holds.
    - The owner lock: a page exit is a market order that only reduces, with no bracket and no strategy; anything else from
      the page gets "...: use Flatten, or move its stop or target"; the bot, the copier and other agents "... until it is
      flat". The copier skips an agent's pair.
    - Cancels: a cancel NinjaTrader does not confirm is sent again every 3 s, with a `status` warning at the second try (to
      every trader page, as ChartBridge's own warnings); at
      the tenth (about 30 s) an error ("... is still not confirmed after 10 tries ...; ChartBridge tries again every 30 s;
      cancel it in NinjaTrader now") and one try every 30 s from then; no try while the account is not connected (they go on
      when it is); after 30 minutes a last error ("... was never confirmed in 30 minutes (n tries); ChartBridge stops
      trying: cancel it in NinjaTrader now") and no more tries.
    - The backstop: no agent entry works while the agent is killed, in shadow, stood down or outside its window; outside
      its window an open proposal expires. A restart puts every agent in shadow (its sockets gone, its open proposals not
      answered), and the backstop cancels any entry from before it.
    - The flat hours run from `flatAt` to the next `entryFrom`: a flatten job per agent ("<id> flattened at 15:55 by its
      rules", or "<id> held a position outside its trading hours (15:55 to 09:45): flattened by its rules"); the agent's own
      `flatten` (auto) is the same job. Every NOT FLAT error starts 10 s after the job does. Nothing goes to an account
      NinjaTrader does not list: "Agent demo: NOT FLAT? its flatten (...) waits: ... (account not listed by NinjaTrader) ..."
      every 10 s, and the job goes on when it is back. The market shut (fixed hours: 17:00 to 18:00 New York Monday to
      Thursday, Friday 17:00 to Sunday 18:00): nothing is sent, NOT FLAT "... the market is shut, so ChartBridge sends no
      close until it opens; its stop and target stay ..." every 60 s, and the job goes on at the open. Before its legs are
      cancelled the root must have traded in the last 5 s, else NOT FLAT "... market not trading: the stop and target stay;
      ChartBridge tries again when it trades" every 10 s. A close that ended unfilled (NinjaTrader rejected it) puts its stop
      back at once at the agent's own stop price ("CB#<tag> ag:<id> stop p<price>", role `stop`, `by: "agent:<id>"` on the
      pages), says so in NOT FLAT, and waits 30 s; over a shut market that stop stays ("ChartBridge placed its stop again at
      <price>"), and at the open, once the market trades, it is cancelled with the rest and the position closed. Its legs
      cancelled with the close not filled when the shut hours come: the stop goes back the same way, once. The job asks
      again whether the pair is still the agent's (back from missing, a position not what it started with, and before every
      close): not (its sign the other way, or the trade lost), it ends with a warning "<account> <root> is no longer agent
      <id>'s: ChartBridge did not close it" and closes nothing. A close never exceeds what the agent's own trade holds (its
      ledger of its own fills; with no trade followed, what its stop legs covered at the start, less each close); when its
      part is closed and the account holds more, a warning "<account> <root>: agent <id>'s N closed; the rest (M) is not
      agent <id>'s: ChartBridge did not close it". A pair its flatten owns stays the agent's until flat. Not flat 10 s after
      its flatten, "Agent demo: NOT FLAT n s after its flatten (...): <root> on <account> still shows <n> (or <m> with fills
      not yet in the position); the account is not connected (<why>); act in NinjaTrader now" every 10 s, the two middle
      parts only when they hold (the second reading: `a.fillsAhead` in the fake's tests).
    - The agent's trade is its own ledger: its entry's fills open and add to it, a fill the other way (its leg, its close,
      Anthony's Flatten, a close in NinjaTrader) takes off at most what it holds; a fill bigger than the trade ends it and
      the rest is not the agent's: the lost-trade error "agent <id> had an open trade on <account> <root> and its legs are
      gone; ChartBridge no longer treats the position as the agent's: flatten or protect it by hand" every 60 s until that
      pair is flat (and "agent <id> holds N on <account> <root> with no trade record (ChartBridge restarted); only its own
      stop protects it: ..." for a record lost over a restart, `/test/agent-lose-trade?restart=1`).
    - The kill switch on: the agent's unfilled entries are cancelled (each `answer` `expired`), its open proposals end
      `not answered`, a position keeps its stop and target, and the pages get a `status` `warn`. Mode changes: leaving
      copilot ends the open proposals `not answered`; leaving auto cancels the unfilled entries; the agent gets a new
      `welcome`. Every start is shadow.
    - The 18:00 ET roll: trades, losing trades, P&L today, a stand-down and the plan ids start over, ended proposals are
      dropped (a trade still open goes on). A rules change never lifts a stand-down.
    - The page's `plan` on an agent's entry cannot take its stop or target away; `change` moves it; its legs move and cancel.
    - Rules: `roots` a list in `agent` and `welcome`; a chosen root's `maxQty<ROOT>` left out is its ceiling; a root not
      chosen takes only 0. A skip's `agentPlan` carries every plan key, null where it has none. `placed` names the order and
      when it ends. `position` for its account on its roots.
    - The agent's side of contract section 10 (the pages see none of it): `welcome.rules` carries the caps really enforced
      (per root the smallest of its rule, the ceiling and config.txt's gate 3 cap, MNQ 20 with no line since 0.5.3) and config.txt's `maxBracketTicks` and
      `maxTicksAway` (null when not set), and `welcome` goes again when a cap changes; `agentState` carries `session` (the
      18:00 ET session's date) and goes after every hello and whenever a field changed; its `order` messages carry
      `orderName` (its entry's `CB#<tag> ag:<id> s<n> t<n>`, its legs' `CB#<tag> stop|target f<n> q<n> p<price>`, its flat
      close's `CB#<tag> ag:<id> flat` with the role `flat`); `exec` carries `cbId` (null for an order placed in NinjaTrader)
      and `role` (`entry`, `stop`, `target`, `flat` for its own orders, `other` for any other); while it owns a pair it gets
      the `exec` of every fill there, its own or not (ownership read before the fill is booked).
    - `--agent-any-time` (tests and smokes only) skips the window and the flat hours and keeps the market open;
      `/test/agent-flat-hours` starts the flat hours on demand, `/test/agent-market-shut?on=1|0|auto` shuts or opens the
      market (auto: its fixed hours), `/test/agent-unlist` and `/test/agent-stuck-cancel` play an unlisted account and an
      unconfirmed cancel, `/test/agent-lose-trade` a trade record lost while the account holds the position.
    - **Not modelled by the fake** (ChartBridge does them; the page needs none of it): `subscribe`'s history and ticks
      (answered `ready` only); one `reject` a second at most for messages over the rate; the strict number format and key
      length; the day file over a restart (plan ids, entry expiries, the stand-down); a part-filled entry's rest as a trade
      of its own; the error 5 s after a start with a position; the owner lock's both position readings and fills ahead of
      their events; the flatten cancelling every order on that contract of the account (the fake: the agent's own) and
      cancelling again every 3 s; files that cannot be read; NinjaTrader refusing an entry; fills to The Desk. And, as built
      at 4d4a81f: the protective exit (`CB#<tag> ag:<id> protect f<n>`, role `protect`) and its restart reading; the flatten
      following the trade into another contract month; the 3 s grace before a trade held the other way is ended (the fake
      ends it at the crossing fill) and the 5 s before a trade flat by both readings is ended from its own fills with its
      warning; a late fill netting against the close that ended its trade; the lost-trade error for a record dropped after
      the execution replay (the fake: only `/test/agent-lose-trade`); a first failed read of `bot-account.txt` or
      `copier.txt` standing the agent down at once; the day file's shared lock and its retries; `agentState` built without
      the agent's lock and in sequence; a runner "not ready" without a complete snapshot; the close cap with no trade followed
      counted from each close's own fill at its end (the fake: as it fills).

20. **Board F's choices (lead's defaults, for Anthony to confirm):**
    - The mockup's account room had "to target" (a profit target): the channel and The Desk carry none, so it is left out.
      Max loss room and daily limit left are the Account page's own figures, with ChartBridge's words when a figure is not
      reported.
    - The mockup's drawer had "for and against", the notebook rule he leaned on, and the time and cost of his eyes and
      judgment: the channel carries none of them, so they are left out.
    - The words "What he is doing now", "His stream" and "his decision" are board F's; the tab shows them for any agent.
    - In a trade the open P&L is NinjaTrader's (the account's `unrealized`), else from the chart's last price; while
      neither is known the light is cyan and says so.
    - "Thinking" lights Judgment (magenta) with the stream, as a look lights Eyes; lessons, notebook and status notes do
      not move the light.
    - The P&L figures keep green and red for their sign and change at once (R3); only the light's colour fades.
    - The chart keeps the page's own look (candles, lines, price line); only its panel is board F's.
    - The workspace's top bar wraps on a phone while the Agent tab is open (it is wider than a phone otherwise), and while
      the tab is shown the corner notices stack in its chart panel's lower left (over the oldest bars, above the time
      axis) so they cover no control, rule, proposal, stream row or figure; nothing else outside the tab changed.

## Tests

- `npm test`: `test/agent.test.js` (AgentCore: messages, the strip, notices, proposals and their countdown and expiry, the
  feed, the rule form against every allowed value, the account chooser, the agent's orders and fills, the copilot-key
  router across the bot and the agents, the wiring) and `test/fake-v3.test.js` (the fake: strict messages, the plan checks
  in the contract's order, shadow, copilot, auto, expiry, the heartbeat, the flat time, accounts, rules, the socket, and
  4d4a81f's cancel tries, the market shut, the market trading in fact, the stop placed again, the flatten asking again and
  its close cap, the lost trade, the held refused plans and the agent's side of section 10). `AgentCore.statusAgent` is
  tested on each of ChartBridge's status texts that name an agent, and `killOnRepeat` on the kill switch's double click.
- `npm test` also checks board F: the light for every state (watching, a look, his thinking, a plan, his rules being
  checked, placed, passed, rejected, expired, refused, a go, a trade in profit, at zero, under water and not known, a flat
  exit, the kill switch, a stand-down, not connected), the drawer's records (only what the channel carries), the session
  trail, the room, the Motion switch with blocked storage, and the wiring (fonts from this PC, the light in CSS only, no
  document keydown handler, no ChartMotion; the light turned by a transform, with no blur and no animated angle; no
  animation in the tab but the light's).
- `npm run smoke:agent`: the workspace against the fake with two made-up agents, on one clock at 11:00 New York whatever
  the time of day (the fake's `--clock-offset`, which with `--v3` drives its desk clock too, and the page's `Date` shifted
  by an init script with the timers left real, as Playwright's clock broke the 4 s confirms). Board F: the light sits on the right
  panels in the right colour for watching, a look, a plan waiting in copilot, his rules being checked (the answer held a
  moment), his entry placed, an expired plan, an open trade in profit and under water, and a flat exit; the drawer opens
  and closes (the same row, Close, Escape only from inside it); Motion Off and reduced motion stop the light and keep the
  glow; the P&L figures, the position and the chart have no transition; no sideways scroll at 1366 px and at 390 px; a
  long record scrolls inside its drawer to its last fact; at 1440 x 1000 and 1366 x 768 the corner notices sit in the
  chart panel and cover none of the left column, its rules, the proposal, the tracker, the stream or the footer, and
  Accept and Reject are fully in sight; no explanatory label is on the tab and the tracker says "In a trade, long 1 MNQ"
  (no "in profit"). R3 with motion inherited (as `test/kit-smoke.mjs` on kit-v1): with the drawer open and in a trade, no
  figure, price, chip, row or button of the tab moves, on its own or through an ancestor that animates or has a transition
  (only a panel's glow and its colour may fade).
  Screenshots at 1440 x 1000: `agent-f-watching`, `agent-f-plan`, `agent-f-profit`, `agent-f-under`, `agent-f-drawer`,
  `agent-f-notices`.
  `npm run smoke:bot` is unchanged and passes with the Agent tab beside it.
- `npm run smoke:agent-targets` (run by `smoke:agent` too; written after the review of fc3101a, rewritten for the count line
  of 2026-10-08): with the shown agent's proposal open while the second agent AND the bot have proposals open, no other
  Accept or Reject is anywhere on the page, the corner is hidden, and the line says "Bot: 1 proposal · Second Demo Agent:
  1" at 30 px; `document.elementFromPoint` at the centre and the four corners of the tab's Accept and Reject finds the
  button itself, in the window with nothing scrolled (on the phone, in the panel's first screen), at 1000 x 800, 1366 x 768,
  1600 x 900, 1440 x 1000, 1920 x 1080 and 390 x 844; the line has no transition or animation; with four notices showing at
  1366, 1000 and 390 px wide, no Accept or Reject is under one; the focus stays on Reject over several renders, 20 ordinary
  clicks all arrive, a press held 1.4 s across a render still clicks; a new proposal right after an ended one never moves;
  the ChartBridge line coming and going moves no Accept; "Under 5 s left" and a long refusal are in sight right above
  Accept; a double click on the kill switch sends `agentKill` once. At 1000 x 800, 1366 x 768, 1920 x 1080 and 390 x 844
  the bot's and the second agent's proposals arrive and leave one by one ("No other proposals", "Bot: 1 proposal", ...,
  "Bot: 2 proposals · Second Demo Agent: 1", and back): each time the line says the right counts at 30 px, marks a risen
  count, and nothing on the tab moves (the shown agent's Accept and Reject, the slot, the line, the stream, the chart, the
  footer, the left column). The line's links: the second agent's name shows it in the tab (its proposal in the slot, the
  line then counting the first agent's), the first agent's brings it back, and the bot's opens the Bot tab, where the bot's
  proposal is in its corner with its Accept and Reject the buttons themselves. The keys: with the tab open and none of the
  shown agent's open, Accept and Reject keys answer nothing (the bot's and the second agent's are hidden) and say so; with
  one of its own open, the Reject key answers that one and nothing else. At 1000 x 800, 800 x 900 and 390 x 844, with the
  tab at its top, ChartBridge's error line is in the window, covers no Accept or Reject and moves the shown agent's Accept
  by nothing. The pop-out at 1366 x 768, 1920 x 1080 and 390 x 844: its agent's Accept and Reject in the window and
  themselves, no other Accept or Reject, the line counting the second agent's; its link shows the second agent there.
  Off the tab (added after the re-review of c47a8a1, which it fails; the bot's corner rewritten after the re-check of
  e87ba23), with two agents and seven bot proposals, at 1366 x 768 and 1920 x 1080: no agent Accept or Reject exists
  anywhere and the corner's line says "Demo Agent: 1 proposal · Second Demo Agent: 1"; the bot's corner shows one card,
  the oldest, whole with its name, side and size lines and its buttons, and "+6 more bot proposals" (24 px) under it;
  nothing covers the top bar (every 16 px along it); an eighth proposal moves nothing; Alt+Y answers the card shown and
  nothing else; the next card takes its place disarmed (buttons off at once), and a key press and a click where the last
  Accept was within its first second answer nothing; after it, Alt+N answers it once. The line's names open the Agent
  tab on that agent (the second agent at 1366 x 768, the first at 1920 x 1080), its proposal in the slot. The notices
  at 1100 px and narrower: every one in the band at the top of the tab, right under the top bar, at its fixed height (66
  px, 96 px on a phone), one in sight in it.
  Screenshots `agent-targets-1366`, `-390`, `-popout`.
- `npm run perf:agent` (R5, `test/perf-agent.mjs`, not part of `npm test`): the Agent tab in a trade at 1920 x 1080 while
  MNQ trades a busy tape (`--live-rate=200`), Motion Full and Motion Off taking turns. Gates: a chart's frame p95 under 4 ms
  and all charts per frame under 8 ms (the chart's own), the light on the chart and the footer with Full and none with
  Off, and the frame interval p95 with Full at most 4 ms over Off's.
