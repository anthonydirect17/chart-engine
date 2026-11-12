# Legion and the two older tabs: what each one carries

For Anthony (build answers 12, 2026-11-11: "keep both tabs for now"). A list to decide from later. Nothing is removed and
nothing was built from this list. Read from the page's code at chart 1.46.0 (`live/agent.js`, `live/agent-core.js`,
`live/agent-helper.js`, `live/bot.js`, `live/bot-core.js`, `live/fleet.js`) on 2026-11-12. It states no rule.

"On Legion" means the Legion tab at chart 1.46.0: the lanes, the pick, the one Armed switch, Kill all, the traders,
the prop accounts and the roster.

## When Legion and the Agent tab disagree

They cannot hold two answers. Neither tab keeps a mode of its own: both show what ChartBridge says in its `agent`
messages, and both send the same `agentMode` message. So:

- A trader set to Shadow on the Agent tab while Legion reads Armed: ChartBridge takes the Shadow, and Legion's switch
  changes at once (off, or "Armed: PARTLY" when the other lane is still in Auto).
- A trader set to Auto on the Agent tab while its lane is not ready on Legion (no bot picked, for one): Legion reads
  "Armed: PARTLY" and says which lane is where. One click on the switch sends every lane to Shadow.
- Kill all, a kill switch, a stand-down and the 17:00 New York reset show on both tabs the same way.
- Copilot exists only on the Agent tab. Legion reads a lane in Copilot as "Armed: PARTLY" (never as off), says so beside
  the switch, and one click sends it to Shadow.
- A trader in Auto on a prop account that is on no lane makes the switch read "Armed: PARTLY" with its name; one click
  sends it to Shadow too. The switch never arms it.
- Until the page has heard ChartBridge (connected, signed in, the groups, the accounts and the traders), the switch reads
  "Armed: not known" and does nothing; Kill all still works.

ChartBridge is the truth on both.

## The Agent tab

### Controls

| Control | What it does | On Legion |
|---|---|---|
| Agents picker, Board, Pop out, Motion | Which trader the desk shows; the Heroes on duty board; a second window; movement on or off | No. Legion shows every trader at once and has no board or pop out |
| Build picker, On, Off, "Flatten and turn off" | The PC helper starts or ends the trader's program with the build picked | No. Starting the runner with Armed is the next piece (B4) |
| Auto-On time and daily cap | The helper starts him at a time; a dollar cap on model spend | No. A spec runner has no model spend |
| Shadow, Copilot, Auto (Auto: a second click within 4 s) | The trader's mode (`agentMode`) | Partly. The Armed switch sends Auto (asked first, a real click) and Shadow to the lanes' traders. No Copilot. A trader that is not in a lane is not switched from Legion |
| Kill switch (on: one click; release: a second click within 4 s) | That trader's kill switch (`agentKill`) | No. Legion has Kill all for the prop accounts, which turns the switch on; the release is on the Agent tab only |
| Change account (None, a group, one account; a LIVE choice asks first) | The trader's account (`agentAccount`) | No. A lane's trader gets its group on the Agent tab. ChartBridge's 17:00 reset puts a flat trader on None each trading day, so today this is a daily step (a change to keep a lane's group through the reset is before Anthony) |
| Change the rules (markets and sizes, the entry window, flat time, entry life, trades a day, losing trades, Market entry, No target) | The trader's rules (`agentRules`) | No. Legion shows the window, the flat time and the two entry switches, read only |
| Accept, Reject (and The Desk's two hotkeys) | Answer a Copilot proposal (`agentAnswer`) | No. A lane runs in Auto or not at all |
| Chart: market, bar size, Maximize | The trader's own chart | No |
| Stream filters, a row's drawer | His notes, plans and lessons | No. Each bot's own state from the runner is not built yet |
| Board: Kill all agents (one click, every trader) | Every trader's kill switch on | Partly. Legion's Kill all covers traders on prop accounts only, and also flattens them and sends them to Shadow |
| Board: Start in Shadow, Open, Kill, Clear stand-down, Assign hero | Start a hero's program; open his desk; his kill switch; clear a stand-down; give a group a hero | No |

### Readings

| Reading | On Legion |
|---|---|
| Name, build, connected and heartbeat age | Yes, in part (Traders, and a lane says "Its runner is not connected"; Legion says a heartbeat is late, over 5 s, and never shows its age) |
| Mode | Yes (Traders, each lane, the Armed switch) |
| Account or group and its accounts, SIM or LIVE | Yes (Traders, each lane's accounts; prop, sim or personal instead of SIM or LIVE) |
| Killed, stood down and why | Yes (Traders; a lane's reason it cannot be armed) |
| Position | Yes, by account (Prop accounts) |
| Today's P&L of the trader | By account only (Prop accounts) |
| Session R, the R curve, heat | No |
| Trades and losing trades against the rules' limits | No |
| The rules: window, flat time, Market entry, No target | Yes (Traders). Sizes, entry life and the two limits: no |
| The day's profit stop from the plan | Yes (Traders, Prop accounts) |
| Room to the daily limit and to the floor, by seat | The cushion to the floor, by account (Prop accounts). The daily room: no |
| Each seat's size, P&L and why it sat out of the last trade | No |
| The last plan and its result; the five steps; his stream and decision drawer | No |
| A Copilot proposal (side, size, entry, stop, target, risk, reason, time left) | No |
| Helper: on or off, spend this session and overall, the build's tier and proving count | No |
| Board: heroes on duty, groups with no hero, stand-downs | No |

## The Bot tab

The Bot tab is for the one NinjaTrader bot slot (ChartBridge's bot channel), not for the traders on the agent channel.
Legion does not act on that bot at all, and Kill all never touches it.

### Controls

| Control | What it does | On Legion |
|---|---|---|
| Library cards and their detail | The bot library's entries with their records | No. Legion's roster is the Lab's files for the spec runner, a different list |
| Shadow, Copilot, Auto (Auto: a second click within 4 s) | The bot's mode (`botMode`) | No |
| Change account (a LIVE choice asks first) | The bot's account (`botAccount`) | No |
| Change the rails (trades, losing trades, micro or mini) | The bot's limits (`botRails`) | No |
| Kill switch (release: a second click within 4 s) | The bot's kill switch (`botKill`) | No |
| Day type: Trend, Range, Gap, Unsure | A note kept in this browser | No |
| Today, Log, Options (sound, motion), Pop out, bar size | The lower panel and the chart | No |
| Accept, Reject on a proposal card (and the two hotkeys) | Answer the bot's Copilot proposal (`botAnswer`) | No |

### Readings

| Reading | On Legion |
|---|---|
| The slot: which bot is loaded, its mode, on, off, killed or lost, heartbeat | No |
| The library: each entry's evidence, trades, share won, average R, rule card | No |
| The bot's account, position, today's P&L, trades and losing trades against its rails | No |
| Trades today, signals today, the log | No |
| A proposal card | No |
| The strip under the top bar on the Main layout | No |

## In short

- Legion carries, for the lanes: the pick, Auto and Shadow through one switch, and Kill all. It reads, for every
  trader: mode, account, state, the window and the two entry switches.
- Only the Agent tab can: set a trader's account or group, set its rules, release a kill switch, use Copilot, start
  or stop a trader's program, and show what a trader is thinking.
- The Bot tab and Legion do not overlap.
