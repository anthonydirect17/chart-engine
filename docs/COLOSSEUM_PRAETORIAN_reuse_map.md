# The Colosseum and Praetorian: the reuse map

Before any Colosseum or Praetorian code. Each block of the two tabs, the part of the chart page it uses, the small change
that part needs, and "new" only where nothing existing does the job; then every control and reading on the League, Agent
and Bot tabs today and where it lands. Read from the code at chart 1.46.0 (branch `legion-lanes-d2`) on 2026-11-12. Line
numbers are approximate. It states no rule. The model is `docs/LEGION_reuse_map.md`; the checklist for the Agent and Bot
tabs is `docs/LEGION_and_the_old_tabs.md`.

How it was read: by hand, `live/workspace.js` (the top bar, `startBot`, `startAgent`, `startLeague`, `startFleet`,
`tabUrl`, `COVERING_TABS`), `live/index.html` (the top bar), `live/league.js` whole, the heads and account pickers of
`live/agent.js`, `live/agent-core.js`, `live/bot.js`, `live/bot-core.js`, and `FleetCore.kindOf`, `seatsKind` and
`traders` in `live/fleet.js`. Nothing was run for this map. Where reading could not tell, it says "not determined".

## In short

| Block | Reuse | Needs |
|---|---|---|
| The four top tabs | The buttons each tab already has (`#wsFleetTab`, `#wsLeagueTab`, `#wsAgentTab`, `#wsBotTab`), each with its own listener | One row in the top bar, in the order Chart, Legion, Colosseum, Praetorian; a Chart button (new, one line: closes whichever tab is open) |
| Old links and keys | `tabUrl` and the start-up reads of `?tab=` in `workspace.js` | `league` opens the Colosseum; `agent` and `bot` open Praetorian on that side |
| The Colosseum: the agents' live training | The League tab (`LeagueView`, `LeagueOverlay`, `LeagueCore`), as it stands | Its title and the button's word; nothing in what it reads or draws |
| The Colosseum: bots on the watch | `FleetCore.traders` (the traders as ChartBridge says them), read only | A listen-only connection handed to the view (no post at all); a new small box; "not built yet" for the loop's own list |
| Praetorian | The Agent tab (`AgentDesk`) and the Bot tab (`BotDesk`), both mounted as they are, inside one tab | Their two buttons become its two sides; each desk says the gate's reason and holds a prop trader's controls back |
| Praetorian: personal accounts only | `FleetCore.kindOf` (ChartBridge's own `prop`, `personal` and `sim` flags on each account, 0.6.16) | A gate on the connection the desks are handed (`AgentCore.praetorianGate`), the pattern of Legion's `legionLink`; a filter on each picker's list (`prChoices`, `prBotChoices`) |
| Boxes, pills, titles | The page's `ws-` classes and tokens | `var(--ws-box-radius, 18px)` and `var(--ws-box-shadow, ...)` with fallbacks; builder 1 defines them |

## The top tabs

**Today:** the top bar holds separate buttons. `#wsAgentTab` (Agent), `#wsLeagueTab` (League), `#wsFleetTab` (Legion) sit
after the laptop tabs; `#wsBotTab` (Bot) is moved between `#wsTabSlot` and `#wsTabHold` by `placeTabBtn` (about 2596).
Each desk's `create()` adds its own click listener to its own button and sets its `hidden` (the Bot and Agent tabs with a
v3 ChartBridge, the League once The Desk answers `/api/chart-league`, Legion with ChartBridge 0.6.17). One tab is open at
a time: each `onTab` closes the others. A layout's tab closes them all (about 3440). `tabUrl` keeps `?tab=` on a reload.

**Use:** the same buttons and their own listeners, moved into one row (`.ws-toptabs`) in the order Chart, Legion,
Colosseum, Praetorian. No button is rewritten.

- **Chart:** new, one button. Pressed when no tab is open. A click closes whichever tab is open (the same calls the
  laptop tabs' click already makes). It is never hidden, so the row never jumps.
- **Legion:** `#wsFleetTab` as it is. Builder 1 owns what it opens and when it is offered.
- **Colosseum:** `#wsLeagueTab`, its word changed from League to Colosseum, offered as today (The Desk answers).
- **Praetorian (as built, 1.48.0):** one group in the row: a Praetorian button (opens the side used last, closes it when
  open) and its two sides, which are the Agent desk's and the Bot desk's own buttons, moved into the group with their
  listeners, their offered state and the Bot's red alert (`bt-alert`). So an alert is never hidden behind a closed tab,
  and every link and smoke that clicks `#wsAgentTab` or `#wsBotTab` keeps working. (The first draft of this map had the
  two buttons leave the top bar and the alert move onto one button; keeping them as the sides does the same with less
  new code.)
- **The look:** the mockup's pills (gold border and text on the open one). The laptop tabs' gold ink
  (`ChartMotion.syncInk`, `.ws-tab`) is the page's existing look for a tab row and is reused for this row.

**Old links, keys and stored names:**

| Old | Lands on |
|---|---|
| `?tab=league` (and `&day=`, The Desk's Agent Stats links) | The Colosseum, the same past day |
| `?tab=agent` | Praetorian, the Agents side |
| `?tab=bot` | Praetorian, the Bot side |
| `?tab=legion` | Legion (unchanged) |
| The Agents strip's bot card and league card (`openLeague`, `botDesk.showTab`) | The Colosseum; Praetorian, the Bot side |
| `agent.js`'s "Bot: 1 proposal" link (`openBot`) | Praetorian, the Bot side |
| The covering tabs' names in the hotkey line (`COVERING_TABS`, about 1455: `lg-on` League, `ag-on` Agent, `bt-on` Bot) | Colosseum; Praetorian (both body classes) |
| `ACCEPT_SHOWN_ON` (Agent, Bot: the tabs that show the proposal the Accept key answers) | Praetorian. The rule is unchanged: Accept and Reject answer only on the tab that shows the proposal |

The Colosseum's address is `?tab=colosseum`. Praetorian keeps `?tab=agent` and `?tab=bot`, which now name its two sides,
and adds `?tab=praetorian` (the side used last). The old words keep working; nothing stored in this browser named a tab
before (the tab lived only in the address); Praetorian keeps the side used last in this browser
(`live-praetorian-side-v1`), a convenience only.

## The Colosseum

**What it is (the loop, amendment 1, section 5):** the League, widened to hold the bots that shadow because they need
more data to pass: station 5's "watch" and the agents' live training in one place. Nothing in it sends an order or
changes a trader's mode.

### The agents' live training

**Use: the League tab, all of it, as it stands** (`live/league.js`, `LeagueView.create` about 324): the one NQ 1 min
chart with the seats' paper trades (`LeagueOverlay.attach`), the legend, each seat's day (`seatDays`), the spend, the
week and month table (`standingRows`, "not enough data yet" under 20), the decision log (`decisionRows`), the past day
(`?day=`, `checkDay`, `chartReach`), the faint marks on other charts (the ⋯ switch, `GHOST_KEY`) and the Agents strip's
league read. Its read stays The Desk's `GET /api/chart-league` and only that.

Changes: the head's title becomes "Colosseum" (Cinzel, a title, never a live value) with "Shadow league" as the first
section's title; the button says Colosseum. `LeagueOverlay.attach` is builder 1's to change (its generic marks for
Legion Live); the Colosseum calls it as it does today and does not touch it.

### The watch: bots in Shadow because the loop wants more data on them

**What the page knows today:** ChartBridge's `agent` messages, one per trader on the agent channel, with its mode, name,
build, account or group, connected and heartbeat, killed and stood down, today's P&L and trades (the Agent tab and
Legion both read them). `FleetCore.traders(agents, accountsMsg, version)` (about 166) already turns them into rows with
`mode`, `status`, `accountText` and `kind`. **Use that, read only.**

What it does not know: which of those traders the loop is watching, why, against which bar, and since when. That list is
the loop's step 3 (Tier 3 and the watch) and does not exist yet.

So the box shows:

- "In Shadow on the agent channel now": `FleetCore.traders(...)` filtered to mode Shadow, one row each: name, build,
  connected or why not, account in words (prop, personal, Sim), today's trades. With the words "ChartBridge's own list;
  whether the loop is watching each one is not built yet".
- "The loop's watch list (station 5): not built yet." No sample rows. If a sample is ever shown it says SAMPLE on it.

**The connection:** the League view has no ChartBridge connection today (it reads The Desk only). The watch box needs the
`agent`, `accounts` and `hello` messages. It gets `{ listen }` and nothing else: no `post`, no `send`, no `sendOrder`.
So "nothing in the Colosseum sends" is true by how it is built, the way Legion's `legionLink` makes its three messages
true. A test proves the object has no other key, and a break hands it a `post` and shows the view never calls it.

New, small: the box and its row. Nothing existing lists traders in Shadow outside the Agent tab's picker and Legion's
Other connections, both of which carry controls; this one carries none.

## Praetorian

**What it is (build answers 16, amendment 1 section 5):** the Bot tab and the Agent tab as one tab, for Anthony's
personal accounts only, with every rule and safety they have today.

### The arrangement

**Use: `AgentDesk.create` and `BotDesk.create`, both, as they are.** Each already builds its whole view into its own
section (`#agView`, `#btView`), listens on the page's one v3 connection, and keeps its own safeties: Auto and a kill
release ask a second click within 4 s, a LIVE account is asked once in the page, Accept sends only the proposal's id,
the rails are tighten-only, the motion rules (R3) never touch a live value. Praetorian is one tab that shows one of the
two sections at a time; its two sides, **Agent** and **Bot**, are the two desks' own buttons (below).

- The two desks are not merged into one view. Merging would rewrite both, which is what the direction forbids ("by
  moving the existing code, not by writing it again"). Their looks differ today (the Agent tab's Layout 5, the Bot tab's
  Library); Praetorian leaves each body as it is. Bringing both bodies to look B is a later piece. (A head row over both,
  PRAETORIAN in Cinzel, was built and taken out: the Agent desk's Layout 5 needs that height, test/agent-l5-smoke.mjs.
  Its words went into the Praetorian button's title and each held-back trader's own line.)
- Each desk's own button (`#wsAgentTab`, `#wsBotTab`) is one of Praetorian's two sides (above). Praetorian is offered when
  either is.
- `onTab` of each desk is wired as before; the Praetorian button is pressed while either is open.
- The pop-out windows (`agent.html`, `bot.html`) are Praetorian too: they build the same gated link
  (`AgentCore.praetorianLink`; the review of 102, F1).

### Personal accounts only

**What the page knows:** ChartBridge 0.6.16 marks each row of its `accounts` message `personal: true` (the one account
Anthony picked on the Accounts tab, "This is my personal account") or `prop: true` (every other live account once one is
picked), with `personalNamed` saying whether a pick exists. `FleetCore.kindOf(row)` reads that into 'personal', 'prop',
'sim' or '' (not known). That is the Accounts page's own answer (`live/accounts.js` about 1767 draws the same flags).

**Use (as built):** the guard is on the connection, not in the pickers, so it holds whatever a desk draws:

- `AgentCore.praetorianGate()` hears ChartBridge's `accounts`, `agent` and `bot` messages and answers, for each message a
  desk would post, '' or why not. `live/workspace.js` hands both desks `praetorianLink`: frozen, its post passes only
  what the gate passes, and it has no send or sendOrder. It lives in `agent-core.js` (already installed on every PC) so no
  new page file needs a line in `nt8/install-files.json`.
- Passed: a kill switch ON (agent or bot), the two acknowledgements, and any other agent or bot message for a trader (or
  the bot) on your personal account, a Sim account or None, an account change only to one of those.
- The pickers: `AgentCore.prChoices` and `prBotChoices` mark a prop account, a live account the page cannot tell and
  every group "not on Praetorian" (listed, not offered); they never offer what the desk did not.
- None ("nothing trades") is always offered: it reaches no account.

**The careful side, as the kickoff asks:** an account the page cannot tell is not offered. With no personal account
picked (`personalNamed` not true), before the first `accounts` message, or with no FleetCore on the page, no live account
is offered and the Praetorian button's title and each held-back trader's line say why. **A Sim account IS offered (to confirm):** the first draft of this map said not; Sim
never reaches a prop account, and the Agent and Bot tabs are where a trader is tried on Sim.

**A trader already on a prop account:** Praetorian must not add a way to reach a prop account, and the Agent desk's
mode, kill, rules and Accept controls act on whatever account the trader is on. So on Praetorian a trader whose
accounts are not all personal (`FleetCore.seatsKind` of its accounts is not 'personal' and not 'none') shows its
readings with a line saying it is set up from Legion's trader desk and its mode, rules and account controls are not
offered there. **What only stops it stays offered:** its kill switch ON, the helper's Off and "Flatten and turn off";
taking a stop away from a screen is the less careful choice (to confirm). The same for the bot slot when its account is
prop (its kill switch ON).

As built: held back at render (disabled, with one line saying why) and again at the click for the helper's On, Auto-On
time and the board's Start; the gate refuses every ChartBridge message regardless. `test/praetorian-smoke.mjs` forces the
disabled controls on a prop trader and sees nothing posted.

### Praetorian is rule 12

The Bot tab and the Agent tab carry controls that reach a trader's mode and orders. Its pull request says so and gets an
independent review before merge.

## Every control and reading, and where it lands

### The League tab today

| Control or reading | Where it lands |
|---|---|
| The League button | The Colosseum button (same element, offered the same way) |
| The chart, NQ 1 min, the seats' marks, legend, "SHADOW: no orders" | The Colosseum, the Shadow league section, unchanged |
| Each seat's day, flags for Anthony, the API spend | The Colosseum, unchanged |
| Week and month table, agreement, decision time, "not enough data yet" | The Colosseum, unchanged |
| The decision log | The Colosseum, unchanged |
| A past day (`?tab=league&day=`), Back to today | The Colosseum, unchanged; the old address still opens it |
| The ⋯ switch "League trades (faint)" on a chart | Unchanged (its word stays: it is the league's trades) |
| The Agents strip's league card | Opens the Colosseum |

### The Agent tab today (the checklist of `docs/LEGION_and_the_old_tabs.md`)

Every control below lands on Praetorian, the Agents side, as the same code. "Prop held back" means: shown, not offered,
for a trader on a prop account (above).

| Control | Where it lands |
|---|---|
| Agents picker, Board, Pop out, Motion | Praetorian, unchanged |
| Build picker, On, Off, "Flatten and turn off" | Praetorian, unchanged for a personal trader; for a prop trader On is held back, Off and "Flatten and turn off" stay (they only stop) |
| Auto-On time and daily cap | Praetorian, unchanged for a personal trader; prop held back (an Auto-On time starts it) |
| Shadow, Copilot, Auto (Auto's second click in 4 s) | Praetorian, unchanged for a personal trader; prop held back |
| Kill switch (on: one click; release: a second click in 4 s) | Praetorian; on is always offered; the release is prop held back (to confirm) |
| Change account (None, a group, one account; LIVE asked first) | Praetorian, personal accounts only (above) |
| Change the rules | Praetorian, unchanged for a personal trader; prop held back |
| Accept, Reject and The Desk's two hotkeys | Praetorian, unchanged; a prop trader's proposal is shown, not answered there (to confirm: Legion does not answer proposals either, since a lane runs in Auto) |
| Chart: market, bar size, Maximize | Praetorian, unchanged |
| Stream filters, a row's drawer | Praetorian, unchanged |
| Board: Kill all agents | Praetorian, unchanged (it only turns kill switches on) |
| Board: Start in Shadow, Open, Kill, Clear stand-down | Praetorian; Open and Kill as before; Start held back for a prop trader (checked again before the helper's On); Clear stand-down (a group's) held back, set up from Legion's trader desk |
| Board: Assign hero (gives a group a trader) | **Legion's trader desk** (the next pull request: these same desks behind the gate turned round); held back on Praetorian and in the pop-outs |

Every reading in that list's Agent tab table (name, build, connection, mode, account, killed and stood down, position,
P&L, R and the curve, heat, trades against limits, rules, day stop, room, seats, last plan and steps, stream, proposal,
helper's spend and tier, the board) lands on Praetorian unchanged, for every trader, prop or personal: reading reaches no
account.

### The Bot tab today

| Control or reading | Where it lands |
|---|---|
| Library cards and their detail | Praetorian, the Bot side, unchanged |
| Shadow, Copilot, Auto (Auto's second click in 4 s) | Praetorian, unchanged while the bot's account is personal or None; held back on a prop account |
| Change account (LIVE asked first) | Praetorian, personal accounts only (above) |
| Change the rails | Praetorian, unchanged (tighten-only; ChartBridge refuses a loosening) |
| Kill switch (release: a second click in 4 s) | Praetorian; on always; the release held back on a prop account (to confirm) |
| Day type: Trend, Range, Gap, Unsure | Praetorian, unchanged |
| Today, Log, Options, Pop out, bar size | Praetorian, unchanged |
| Accept, Reject and the two hotkeys | Praetorian, unchanged |
| The bot strip under the top bar (Main layout) and its click | Unchanged; its click opens Praetorian, the Bot side |
| Every reading (slot, library, account, position, P&L, rails, trades, signals, log, proposal) | Praetorian, unchanged |

## New, and why

| New | Why nothing existing does it |
|---|---|
| The Chart button | The page has no button that means "no tab"; today a tab closes by its own button or a layout tab |
| Praetorian's gate (`AgentCore.praetorianGate`) | Nothing limited the Agent and Bot tabs by account kind; Legion's `legionLink` is the pattern |
| The watch box in the Colosseum | No read-only list of traders in Shadow exists outside tabs that carry controls |
| The Praetorian button and its group of two sides | The arrangement itself |
| The personal-only filter on two pickers | A filter on the existing lists, not a new picker |
| Praetorian's prop hold-back line | Nothing today limits the Agent and Bot tabs by account kind |

## Things I need that are not mine

None for the Colosseum and the tab row. `LeagueOverlay.attach` is builder 1's and is not touched. `#wsFleetTab` is
moved into the row in `index.html`, its id and listener unchanged; nothing in `fleet.js` changes.

## Order of work this implies

1. This map (draft pull request, this file only).
2. The tab row and the Colosseum, one pull request: the row with Chart, Legion, Colosseum (Agent and Bot after them,
   unchanged, until step 3), the old addresses, the watch box on a listen-only connection, tests and a smoke.
3. Praetorian, its own pull request, rule 12: the tab, the switch, the two desks moved in, the personal-only option, the
   prop hold-back, the old Agent and Bot buttons leaving the top bar, tests that click each held-back control on a prop
   trader and see nothing posted.

## After the review of 102 (2026-11-12): where every prop control goes

The coordinator's decision (reuse first): the old desks themselves go into Legion, behind Praetorian's gate turned round
("the trader desk for Legion": messages only for a trader or the bot on a prop account or a group, plus kill switch ON,
Shadow and the acknowledgements for anyone). Builder 1 mounts it once in Legion Setup.

| Control on the old tabs | Praetorian (personal, Sim, None) | Legion's trader desk (prop, groups) |
|---|---|---|
| Kill switch ON, a trader's Shadow | yes, for any trader | yes, for any trader |
| A kill switch's release, modes, rules, account, Copilot answers | yes | yes |
| Helper On, Auto-On time, board Start | yes | yes |
| Assign hero, a group's Clear stand-down | no (held back, with the reason) | yes |
| Every control of the bot | when its account is personal, Sim or None | when its account is prop |

## After the reviews of 103 (2026-11-12): the second copy, no home, moves in Shadow

| Case | Praetorian | Legion's trader desk |
|---|---|---|
| A trader or the bot on None | whole | whole; a move off None goes in Shadow first, so no mode travels |
| A trader with no home (a group holding your personal account or Sim only, a mix of kinds, an account the page cannot tell) | the stops; None while flat; "no home: ..." | the same, in the same words |
| A group changed under a group trader | (groups are never Praetorian's) | refused at once by the group as last heard |
| A shape the page cannot read | the stops only | the stops only |
| A proposal acknowledged | while its tab is shown, as before | only while the fold is open and its card is on screen |

Legion's copies are `embedded` (no Pop out, nothing of the page's own touched) with their own browser keys
(`legion-...`); `LegionDesk.show(on)` is called by the fold and by Legion's tab. Prop traders have no pop-out window
now (agent.html and bot.html are Praetorian's); whether Legion wants one is Anthony's call.
