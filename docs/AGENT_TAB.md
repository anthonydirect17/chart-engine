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
| `live/agent-core.js` | `AgentCore`: the logic, no page in it (Node tests run it): agents and the picker, proposals and their countdown, the feed, the rule form and its checks, the account chooser, the agent's orders by its mark, the one copilot-key router |
| `live/agent.js` | `AgentDesk`: draws the tab from AgentCore on the window's one v3 connection |
| `live/agent.css` | its look: the Manrae training viewer's (below) on the house style |
| `live/agent.html` | the tab in its own window (Pop out, for a third monitor), on its own v3 connection |
| `test/agent.test.js` | AgentCore's unit tests, and the files' wiring |
| `test/fake-v3.mjs`, `test/fake-bridge.mjs` | the fake ChartBridge speaks the agent channel (`--agents=demo`): the made-up "Demo Agent" |
| `test/fake-v3.test.js` | the fake's agent tests, and its `/agent/<id>` socket |
| `test/agent-smoke.mjs` | `npm run smoke:agent`: the workspace against the fake, screenshots in `test/out/agent-*.png` |

Shared code changed (each change small and tested): `live/bot.js` hands its open proposals to the one copilot-key router
instead of owning the `chart-copilot-key` event; `live/bot-core.js` `botFillLedger(mark)` takes an optional mark (the
agent's); `live/accounts.js` names an agent's order "agent demo" on the Account page; `live/workspace.js` mounts the tab,
keeps one tab open at a time and lets the copilot keys work for agents; `live/index.html` loads the files;
`nt8/install-files.json` lists the four page files in its `www` part (see the lead's defaults).

## The look

Anthony on the Manrae training viewer (2026-10-08): "looks great and is a great foundation". The tab takes its look, not
its file: one dark theme, flat columns ruled in purple (`#2A1F4D`), small mono labels in lavender (`#B69CFF`, uppercase,
wide tracking), the viewer's buttons and selects, quote blocks with a purple rule for the agent's reasons and thinking, the
confidence meter, the log's colored kinds (look lavender, plan purple, lesson gold, status dim). Green and red only for
trade sides and P&L (and, as on the Bot tab, the kill switch). Crimson only for a LIVE account's mark and question, the
Bot tab's Armed red. IBM Plex Sans, Condensed and Mono from the page folder. Nothing moves.

## What the tab shows

- **The strip:** the agent's initials, name and build (as its hello says them), connected with the heartbeat's age, the
  mode, the account with its SIM or LIVE mark, the position, P&L today, trades and losing trades (of the limit when the rules
  set one), KILLED or STOOD DOWN with why, and while ChartBridge says the agent holds the owner lock, "OWNS SIM-AG1 MNQ".
  With two or more agents, a picker at the strip's end (the choice is kept in this browser).
- **Left, control:** the mode (Shadow, Copilot, Auto), the kill switch, status, heartbeat and the last plan; the account and
  Change account; the rules in force and Change the rules, with ChartBridge's refusal under the button.
- **Centre, chart:** a normal live chart (never animated, takes no orders) of the agent's root, with the agent's own
  working orders, stop and target as lines (`by: "agent:<id>"` only) and its trades today as marks.
- **Right, proposals:** each open proposal: side, quantity, root, kind and price (and limit price for a stop-limit), the
  setup, the confidence, the reason, stop and target in ticks and prices, the risk in dollars and the reward ratio, the
  account and its mark, a live countdown to `expiresAt`, Accept and Reject (with The Desk's keys on them).
- **Right, notes and plans:** the agent's notes (look, thinking, lesson, notebook, status) and plans (with their result:
  shadow, waiting for you, accepted in 1.3 s, rejected, expired, refused and why, skipped), newest first, with filters
  (All, Plans, Notes, Thinking, Lessons). Thinking is a collapsed block; an opened one stays open as the feed grows.
- **Corner:** a proposal of an agent not shown in the tab pops up in the corner wherever Anthony is (the Bot tab's corner,
  so the two never overlap); notices for an entry, an exit, a stand-down, the heartbeat, the kill switch, the mode, the
  account and how a proposal ended.

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
New York times `HH:MM`, entries from 09:30, `entryFrom` before `entryUntil`, `flatAt` after it and at most 15:59;
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
   s for Auto and for Kill, as for the bot" is read as the bot's behaviour.
3. **One copilot key (lead's default, the brief's):** the `chart-copilot-key` event has one handler for the bot and every
   agent (`AgentCore.copilotRouter`); it answers the oldest open proposal across all of them, oldest by the time it showed
   on this page; a tie goes to the Bot tab. An agent proposal already answered and waiting for ChartBridge is skipped. The
   bot's side is unchanged, so with no agent proposal open the key does exactly what 1.16.0 did (tested in both smokes).
   `bot.html` (no AgentCore) keeps the 1.16.0 handler.
4. **The copilot keys for agents (lead's default):** Accept and Reject keys work and show in Settings while the bot switch
   is on or ChartBridge has told of an agent. The Desk's hotkeys are still read only while a switch needs The Desk, as in
   1.16.0.
5. **Where a proposal shows (lead's default):** in the tab's Proposals for the agent shown there; in the corner for any
   other agent and whenever the tab is closed. `agentSeen` goes once, the moment it shows in a window Anthony can see (a
   hidden window sends it when it comes to the front), as `botSeen`.
6. **Accept in the last 5 s (lead's default):** ChartBridge refuses an accept with under 5 s left as expired, so the page
   closes Accept then and says why; Reject still goes. The countdown runs on this PC's clock against ChartBridge's
   `expiresAt` (the same PC).
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
    (ChartBridge refuses them anyway).
11. **The agent's chart (lead's default):** its root is the one picked in the chart's header, else the position's, else a
    working entry's, else an open proposal's, else the last plan's, else the first of its roots. Its trades come from
    fills claimed against its own marked orders (`BotCore.botFillLedger` with the agent's mark, as the bot's), kept in this
    browser for the trading day (`live-agent-fills-v1`).
12. **ChartBridge's own words (lead's default):** its warnings and errors are the workspace's ChartBridge line (not
    repeated); an `info` line naming an agent (its flat time) is a corner notice too.
13. **The feed (lead's default):** kept in memory; ChartBridge sends the last 200 notes and 50 plans again when a page signs
    in, and repeats are dropped. A proposal's outcome shows on its plan as this window saw it ("accepted in 1.3 s");
    another window shows "proposed" for one that ended before it opened.
14. **No agent strip on the Main tab (lead's default):** the bot strip stays the bot's; the Agent tab button marks a
    proposal waiting (a lavender dot) and an agent killed, stood down or lost (red).
15. **One tab at a time (lead's default):** opening the Agent tab closes the Bot tab and the other way round; a layout
    closes either; `?tab=agent` keeps it over a reload.
16. **`nt8/install-files.json` (lead's default, a deviation from the brief):** the brief keeps `nt8/` for ChartBridge's
    builder, but the installer and the PC updater copy only the page files this list names, and four tests check it, so
    its `www` part gains the four page files (`agent.html`, `agent.js`, `agent-core.js`, `agent.css`). Nothing else in
    `nt8/` changed. The other builder's additions go in `addons`, so the two merge without a conflict.
17. **The fake's choices (lead's defaults, for the C# builder to compare):**
    - Each agent starts on Sim101 (the contract's no-file default), which is also the bot's account and the copier's
      default leader. The fake refuses an agent's plan at check 2 while its account is the bot's, the copier's leader or a
      follower ("choose demo's own account on the Agent tab"), so an agent and the bot never share an account even at the
      defaults. The bridge adds the made-up Sim account `SIM-AG1` for it to take.
    - `agentSeen` counts in gate 7's rate (the contract names no exemption; `botSeen` is not counted).
    - An `agentAnswer` accept with under 5 s left ends the proposal `expired` (the agent's `answer` says so) and the page
      gets a `reject` with its cid. An accept refused at placing ends it `rejected`, the agent gets `answer` `refused`.
    - The owner lock: a page order that only reduces the position on the agent's (account, root) is an exit and passes.
    - `agentRules` refuses a `maxQty<ROOT>` for a root not in `roots`, and a root other than NQ, MNQ, ES and MES.
    - `subscribe` from an agent is answered `ready` only (the fake keeps no history for agents).
    - `--agent-any-time` (tests and smokes only) skips the entry window and the flat time, so they run at any hour.

## Tests

- `npm test`: `test/agent.test.js` (AgentCore: messages, the strip, notices, proposals and their countdown and expiry, the
  feed, the rule form against every allowed value, the account chooser, the agent's orders and fills, the copilot-key
  router across the bot and the agents, the wiring) and `test/fake-v3.test.js` (the fake: strict messages, the plan checks
  in the contract's order, shadow, copilot, auto, expiry, the heartbeat, the flat time, accounts, rules, the socket).
- `npm run smoke:agent`: the workspace against the fake with two made-up agents; `npm run smoke:bot` is unchanged and
  passes with the Agent tab beside it.
