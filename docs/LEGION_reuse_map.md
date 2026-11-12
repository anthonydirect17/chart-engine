# Legion: the reuse map

For the coordinator and Anthony, before any Legion Setup code (build answers 17, 2026-11-12: "reuse first"). Each block
of the two mockup pages, the part of the chart page it uses, and "new" only where nothing existing does the job. Read
from the code at chart 1.46.0 on 2026-11-12. Line numbers are approximate. It states no rule.

How it was read: a survey pass over `live/` and a check by hand of the mount functions and the names below. Nothing was
run for this map. Where the survey could not tell, it says "not determined".

## In short

| Block | Reuse | Needs |
|---|---|---|
| The lanes, account chips, drag and drop, the join question | The Multi-Account panel, as it stands | One option on its mount (show one group); Legion handed the page's feed |
| "Not in a lane" | The Multi-Account panel's own Bench | Nothing more |
| Accounts by group (Live) | The Account page's own rows and room readings | One option on its mount (which accounts, rows only) |
| The chart (Live) | `ChartLive.mount`, the same engine and settings as every chart panel | Legion handed the page's chart feed; its indicators seeded once |
| Each group's marks on the chart | `LeagueOverlay.attach` (the League tab's marks) | One small change: take any trader's marks, not only the league's three seats |
| A trader's day and live record | Pieces only: nothing shows this for a lane's trader today | New, small, from existing figures |
| Boxes, pills, tables, switches | The page's `ws-` classes and tokens | Two new tokens (radius, shadow) for the chosen look |
| Roster with families and filters, the pick, Armed, Kill all, Market now, Setup and Live | New (the pick, Armed and Kill all exist since 1.46.0) | |

## Legion Setup

### The head: LEGION, Setup and Live, Armed, Kill all

- **Armed, Kill all:** as built in `live/fleet.js` (1.45.0, 1.46.0). Kept, and in the same place on both subpages.
- **Setup and Live switch:** the page's two-option switch, `.ws-seg` (`live/workspace.css` about 293: buttons with
  `aria-pressed`). New: only the two words and which subpage shows.
- **The wordmark:** the page's title font token, `--ws-title-font` (Cinzel, loaded from this PC since 1.44.0).

### Market now

New. Nothing on the page reads a zone. The strip says "not built yet" until Bot-Lab's plain-code labeler exists.

### Today: the lanes

**Use: the Multi-Account panel** (`live/multi-account.js`, `MultiAccount.mount(el, host)` about 193; pure part
`MultiAccountCore`; styles `live/multi-account.css`). A lane IS a group shown by that panel.

What it already does, and Legion must not write again:

- "Trades with the group" with its line ("3 accounts, $425 at risk a trade") and the Bench.
- A chip an account: name, SIM or LIVE, its type from The Desk, Room (ChartBridge's own number), Risk, and why it
  cannot move.
- Drag and drop and a click on a chip, both through one `move()` (about 339).
- The join question under the chip: `F.joinRefusal`, `F.joinPlan`, the words of `F.joinWords`, the highest close
  prefilled from The Desk's seed, "Put in" sending `F.accountGroup`. A join whose rules are not known is sent to the
  Accounts tab, as today.
- Moving a member to the Bench and back (`memberBench`), Remove for an account NinjaTrader no longer lists.
- The group's Type (Evals, Funded, Not set), its risk percent, rename and delete, in Group settings.

It can be mounted a second time: its state is inside each mount, its element ids carry the panel id, and it has no
shared state. That is from reading; it has not been run twice at once.

**Small changes it needs (one shared panel changed, no copy):**

1. `host.group`: a fixed group id. With it the panel shows that one group and hides its group list and "New group".
   Today it always lists every group (`groups()` about 210 and the dropdown).
2. It does not redraw itself. `workspace.js` redraws the panels that carry `v.accountPage` (`renderAccountPages` about
   2798). Legion's two mounts join that loop.
3. Legion is handed the page's feed (`AF`) for these mounts. Today it gets only the gated connection.

**"Not in a lane"** is the panel's own Bench: it already lists the firm's accounts that are in no group.

**What ChartBridge itself does with a move today** (read from `nt8/ChartBridgeGroups.cs`, `AccountGroup` and
`MemberBench`, and `ChartBridgeAgents.JoinRefusal`; the fourth "not determined", build answers 18 point 3): a join is
refused when the account is the bot's, the copier's or another agent's, or would hedge the group; a bench is refused while
that one account is not flat; a leave keeps the agent's trade on that account its own until flat. Nothing looks at the
lane trader's mode or at what the trader holds on the group's other accounts. So the page refuses a move while the lane
is in Auto, is not in Shadow, or its trader holds anything (`FleetCore.laneLock`, built in 1.47.0), and the gap is in the
design note for ChartBridge's next change.

**Answered (build answers 18, point 1): (b), the narrow feed, built in 1.47.0 as `FleetCore.laneFeed`.** The question was: Pull request 94's gate lets the Legion tab send three messages and no
other. The Multi-Account panel sends four more through the page's feed: `accountGroup`, `memberBench`, `groupSave`
and `groupDelete`. Mounted inside Legion, those are sent from the Legion tab. Two ways:

- (a) The gate stays on Legion's own code (Kill all, the pick, Armed), and the mounted panel uses the page's feed
  exactly as it does on the main screen. Simple, and the panel is the reviewed one. The claim "three messages" then
  reads "three from Legion's own code".
- (b) The panel mounted in Legion gets a narrower feed: `accountGroup` and `memberBench` only, so a group cannot be
  renamed, retyped or deleted from inside a lane. Group settings then stay on the main screen's panel.

I recommend (b): changing a lane's Type from inside the lane would move the lane out from under its trader.

**The bot or agent card on a lane** (its name, BOT or AGENT, risk a trade, what it is doing, today): new, small. It
reads `FleetCore.lanes` (1.46.0) and the roster card. One card a lane (build answers 17).

**What goes from `fleet.js`:** its own seat chips (`.fl-seat`) and its note that an account's group is set on the
Accounts tab.

### Roster

New: one line a family with its settings inside, the filters and Find. It reads what `FleetCore.rosterCards` already
gives (1.45.0); a roster file's `record.family` names the family. The pick list of 1.46.0 becomes "put on a lane" from
a setting's line, still `agentPick`.

### Other connections

`FleetCore.traders` and the Traders box of 1.45.0, folded, limited to traders on no lane. Not new.

## Legion Live

### The four tiles

New, small. Sums of numbers the Account page's rows already hold (`pnlToday`, the positions), by group. "The
business so far" needs The Desk; the page says so when it is not reachable.

### Today on the chart

**Use: `ChartLive.mount`** (`live/live.js`), the way the Agent tab (`agent.js` about 1653) and the League tab
(`league.js` about 401) each put a real chart in their tab: the page's chart feed, a fixed pane id, the toolbar off,
compact, a host that takes no orders. The indicators button, the chips and the badge go in a small head, as on the
Agent tab. The colours are the page's own (kept once for every chart).

- The workspace's own panel builder (`addView`, `mountChart` in `workspace.js`) is tied to the grid and is not
  exported, so the Agent tab's pattern is the existing way, not that builder.
- Needs: Legion handed the chart feed (`hub`) and the storage prefix, as `startAgent` and `startLeague` are.
- Indicators and levels are kept by pane id, so a new pane starts with none. They are seeded once from the main
  chart's defaults, as `seedMainIndicators` does. Whether a helper copies one pane's own choices to another: not
  determined.

**Each group's marks: `LeagueOverlay.attach(pane, host, get, root, faint)`** (`league.js` about 281), the League
tab's marks: a hollow circle at the fill, a diamond at the exit, the stop and target lines, a letter each.

- Small change: today it draws only a league day's three seats (`LeagueCore.marksFor`, seats H, S and O). It needs to
  take any list of marks and lines with a letter and a tint each. One change to the shared overlay.
- The other existing way is the engine's own `setTrades` with `ghost` (the Bot tab's faint trades,
  `src/chart-engine.js` about 2601). The overlay is closer to "as the League tab marks its traders".
- Where a lane's fills come from on the page (ChartBridge's `exec` and order messages for the lane's accounts): to be
  checked when Live is built. Not determined here.

### Traders today

No existing panel shows this for a lane's trader. What exists is tied to other sources:

- The League tab's day figures (`LeagueCore.seatDays`, `standingRows`): the league's seats, from The Desk.
- The PC helper's tier and live count (`AgentHelper.tierChip`, `proving`): the Agent tab's heroes.
- The Agents strip's cards (`AgentsStripCore`): the league again.

So this block is new, and small: trades, result and time in the trade from the lane's own fills and ChartBridge's
`agent` message; "live so far" and "against its test" from The Desk when it has them, with "not enough data yet"
under the minimum. A figure is added only where none of the three has it.

### Accounts by group

**Use: the Account page's rows** (`live/accounts.js`, `AccountsPage.mount(v, host)` about 1166). Its rows already
show today, the position, Room (to the floor and to the daily limit, the tighter marked, from
`AccountsCore.limitState` and `roomParts`), the group, and it already has one section a group with "n accounts,
today $x".

- Small change: today the only option is `only: 'cop'`. It needs `host.filter` (which accounts: here the prop groups)
  and a rows-only mode (no Positions, Orders, Trades and Log tabs, no settings drawer). Or the row builder lifted out
  as one exported function. Either is one change to the shared page.
- "To pass" and "To the payout": the target left is in `limitState` already (`tg`). The payout line: not determined
  whether the page holds a payout mark; if not it comes from the roster file's playbook (`payout_at`).
- **What goes from `fleet.js`:** its own Prop accounts table (`accountsHtml`, `propAccounts`), which repeats these
  rows with fewer readings (no daily room, no level colour).

## The look

- The page's own classes: `.ws-panel`, `.ws-sec`, `.ws-btn`, `.ws-seg`, `.ws-tag`, the `.gr` table, `.ws-sel`,
  `.ws-in`, `.ac-empty`. `live/kit.css` is not loaded by the page (it is the older cyan gallery), so it is not used.
- The chosen look (softer, more defined boxes) as a variant: the page has no radius or shadow token today, so two
  tokens are added and used by a `.ws-panel` variant. No second set of components.
- **What goes from `fleet.css`:** `.fl-box`, `.fl-h`, `.fl-table`, `.fl-tag`, `.fl-empty` in favour of the classes
  above, as each block is moved over.

## New, and why

| New | Why nothing existing does it |
|---|---|
| Roster families, filters, Find | The page has no list of the Lab's files but Legion's own |
| The bot or agent card on a lane | Multi-Account shows accounts, not who trades them |
| Market now | Nothing reads a zone |
| The four tiles | Sums by lane; the figures exist, the tiles do not |
| Traders today | Three partial sources, none for a lane's trader |
| Setup and Live | The arrangement itself |

## Order of work this implies

1. Shared panels first, each a small change with its own tests: Multi-Account's `host.group`; the Account page's
   filter and rows-only mode; the overlay's generic marks.
2. Legion Setup: the two Multi-Account mounts as the lanes, the card on each lane, the roster by family, the look.
3. Legion Live: the tiles, the chart with the overlay, the Account page's rows, Traders today.
