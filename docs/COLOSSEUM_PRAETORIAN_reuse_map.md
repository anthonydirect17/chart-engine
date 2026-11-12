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
| Praetorian | The Agent tab (`AgentDesk`) and the Bot tab (`BotDesk`), both mounted as they are, inside one tab | A two-way switch (Agents, Bot) with the page's `.ws-seg`; one option on each desk: which accounts it may offer |
| Praetorian: personal accounts only | `FleetCore.kindOf` (ChartBridge's own `prop` and `personal` flags on each account, 0.6.16) | One filter in `AgentCore.pickerChoices` and `BotCore.accountChoices`, off by default |
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
- **Praetorian:** in the Colosseum pull request, the Agent and Bot buttons stay as they are, after the four, so nothing
  is lost before Praetorian exists. In the Praetorian pull request they leave the top bar and one `#wsPraetorianTab`
  takes their place. The Bot button's alert class (`bt-alert`, the red mark when the bot needs Anthony) moves onto the
  Praetorian button, so an alert is never hidden behind a closed tab. Not determined: whether anything else reads
  `#wsBotTab`'s place in the top bar; the smokes that click it (`test/tab-buttons.mjs` and the Bot smokes) will say.
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

The new address for each is `?tab=colosseum` and `?tab=praetorian&side=agents|bot`. The old words keep working; nothing
stored in this browser names a tab today (the tab lives only in the address), so there is no stored key to move. Not
determined: whether The Desk or the PC updaters write `?tab=league` or `?tab=agent` anywhere else; the old words keep
working either way.

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
two sections at a time, with a switch in its head: **Agents, Bot** (`.ws-seg`, buttons with `aria-pressed`).

- The two desks are not merged into one view. Merging would rewrite both, which is what the direction forbids ("by
  moving the existing code, not by writing it again"). Their looks differ today (the Agent tab's Layout 5, the Bot tab's
  Library); Praetorian gives both the same head (PRAETORIAN in Cinzel, the switch, the personal-only line) and leaves each
  body as it is. Bringing both bodies to look B is a later piece, said in the pull request.
- Each desk's own button (`#wsAgentTab`, `#wsBotTab`) stays in the DOM, hidden in `#wsTabHold`, so its listener, its
  `hidden` (offered with a v3 ChartBridge) and its alert class keep working; the Praetorian button reads them.
  Praetorian is offered when either is.
- `onTab` of each desk is wired as today, with `pr-on` added to the body while either is open, and the switch moves
  between them by the desks' own `showTab`.
- The pop-out windows (`agent.html`, `bot.html`) are unchanged.

### Personal accounts only

**What the page knows:** ChartBridge 0.6.16 marks each row of its `accounts` message `personal: true` (the one account
Anthony picked on the Accounts tab, "This is my personal account") or `prop: true` (every other live account once one is
picked), with `personalNamed` saying whether a pick exists. `FleetCore.kindOf(row)` reads that into 'personal', 'prop',
'sim' or '' (not known). That is the Accounts page's own answer (`live/accounts.js` about 1767 draws the same flags).

**Use:** one option on each existing picker, off by default so the pop-out windows and every other caller are unchanged:

- `AgentCore.pickerChoices(accountsMsg, groupsMsg, agent, others, opts)` (about 382): with `opts.onlyKind = 'personal'`,
  a single account is offered only when its row says `personal: true`; a group is offered only when every member is
  personal; a league seat stays as it is (Sim only, already). Every other account is listed with the reason ("a prop
  account: it trades from Legion") and not offered, the way a taken account is today.
- `BotCore.accountChoices(accountsMsg, bot, opts)` (about 189): the same filter for the bot's account.
- None ("nothing trades") is always offered: it reaches no account.

**The careful side, as the kickoff asks:** an account the page cannot tell is not offered. With no personal account
picked (`personalNamed` not true), or before the first `accounts` message, or with a ChartBridge older than 0.6.16, no
account is offered on Praetorian and the line says why ("No personal account is picked yet: pick it on the Accounts
tab"). A Sim account is 'sim', not 'personal': **not offered on Praetorian (to confirm).** It is the narrower choice;
Sim trading stays possible from the pop-out windows, which are unchanged.

**A trader already on a prop account:** Praetorian must not add a way to reach a prop account, and the Agent desk's
mode, kill, rules and Accept controls act on whatever account the trader is on. So on Praetorian a trader whose
accounts are not all personal (`FleetCore.seatsKind` of its accounts is not 'personal' and not 'none') shows its
readings with a line "On a prop account: it is run from Legion" and its mode, rules and account controls are not
offered there. **Its kill switch stays offered:** turning a kill switch on only stops a trader, and taking a stop away
from a screen is the less careful choice (to confirm). The same for the bot slot when its account is prop.

Not determined until built: whether every control in `agent.js` can be held back by one flag at its render, or whether
a few need it at their click as well. Both are checked by a test that sends each control's click on a prop-account
trader and sees no message posted.

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
| Build picker, On, Off, "Flatten and turn off" | Praetorian, unchanged for a personal trader; prop held back |
| Auto-On time and daily cap | Praetorian, unchanged for a personal trader; prop held back |
| Shadow, Copilot, Auto (Auto's second click in 4 s) | Praetorian, unchanged for a personal trader; prop held back |
| Kill switch (on: one click; release: a second click in 4 s) | Praetorian; on is always offered; the release is prop held back (to confirm) |
| Change account (None, a group, one account; LIVE asked first) | Praetorian, personal accounts only (above) |
| Change the rules | Praetorian, unchanged for a personal trader; prop held back |
| Accept, Reject and The Desk's two hotkeys | Praetorian, unchanged; a prop trader's proposal is shown, not answered there (to confirm: Legion does not answer proposals either, since a lane runs in Auto) |
| Chart: market, bar size, Maximize | Praetorian, unchanged |
| Stream filters, a row's drawer | Praetorian, unchanged |
| Board: Kill all agents | Praetorian, unchanged (it only turns kill switches on) |
| Board: Start in Shadow, Open, Kill, Clear stand-down | Praetorian, unchanged for a personal trader; prop held back except Kill |
| Board: Assign hero (gives a group a trader) | **Not on Praetorian** (groups are the prop business): it stays reachable from the Agent pop-out window, unchanged, until Legion takes it (to confirm) |

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
| The watch box in the Colosseum | No read-only list of traders in Shadow exists outside tabs that carry controls |
| Praetorian's head and its Agents and Bot switch | The arrangement itself |
| The personal-only option on two pickers | An option on existing functions, not a new picker |
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
