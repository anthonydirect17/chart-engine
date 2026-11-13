/*
 * The Legion tab (chart 1.45.0; build answers 7, part D1; named by Anthony 2026-11-11): the Prop Business on the chart page. One place for the roster (the
 * bots and lineups the Lab built, with their numbers), the traders (the slots on ChartBridge's agent channel) and the prop
 * accounts they trade. It was drafted as "Fleet" (the file and the fl- names keep that word); on screen it is Legion.
 *
 * It is added beside the Agent, Bot and League tabs and replaces none of them yet. It shows only what ChartBridge itself says
 * on the window's own connection, and the roster files ChartBridge serves from this PC, so nothing is sample data:
 *   - The roster (ChartBridge 0.6.20's `GET /roster`, Bot-Lab's specrunner.roster/1 and specrunner.lineup/1 files): each bot
 *     and each lineup, whether the spec runner can run it and why not, the run its numbers come from, and for the eval stage
 *     and the funded stage the playbook it sizes with and its profit per $1 beside the no-edge range. Every card says
 *     "In-sample, not confirmed" and its try count: a roster/1 file carries no confirmation, and a number from an in-sample
 *     run is never shown as proof (build answers 8, section 4). A file built with --quick says so and is never traded.
 *     The tab reads the files; it decides nothing from them and sends nothing about them.
 *   - Kill all: flatten and stop. ChartBridge 0.6.17's `agentKillAllProp`: every trader on prop accounts is flattened, its kill
 *     switch goes on and its mode goes to Shadow. It asks first, in the page (two buttons, no browser dialog). It never touches
 *     the personal account, a trader on Sim accounts only, the bot or the copier, and it cancels only the trader's own orders;
 *     the trader's position on its account and contract is closed whole, a contract added by hand included (Anthony
 *     2026-11-11: the account a bot trades is the bot's for the day). ChartBridge decides all of that, not the page.
 *   - Traders: each one's mode, account, window, what it is doing, why it is stood down, the day's profit stop its plan named
 *     (ChartBridge 0.6.19), and its two entry switches, Market entry and No target (0.6.18), so a market entry with no target is
 *     never a surprise (the coordinator's condition, 2026-11-11). Read only: a switch is changed on the Agent tab, by a person.
 *   - Prop accounts: stage (the group's Type), progress to the target, the cushion to the floor, today, the day's profit stop
 *     mark and where it comes from, and what would stop the runner sizing it (no group Type: size 0).
 *   - The lanes (chart 1.46.0, build answers 7 part D2; needs ChartBridge 0.6.21). Two at most: the eval lane and the funded
 *     lane. A lane is a trader whose account is a group, and the group's Type (eval or funded) says which lane it is. Each
 *     lane shows its trader, the accounts in its group, the roster file picked for it, and why it cannot be armed when it
 *     cannot. The PICK is changed here (`agentPick`: ChartBridge keeps it and refuses a change while the trader is in Auto
 *     or holds anything). ONE ARMED SWITCH for both lanes: on, every lane that is ready goes to Auto (`agentMode`); off,
 *     every lane's trader goes to Shadow. On asks first, in the page, and takes a real click only, as Kill all's Yes; off
 *     is one click. The switch holds no state of its own: it reads each trader's mode from ChartBridge, so a mode changed
 *     on the Agent tab, by Kill all or at 17:00 New York shows here at once, and "partly" is said when the lanes differ.
 * Not in this cut, and said plainly on the tab: moving an account into or out of a lane by drag and drop (today: the
 * Accounts tab, the account's group), and each bot's own state from the spec runner. The lanes' runners are kept running by
 * Bot-Lab's PC helper (B4), not by Armed; each lane says what the helper says of its runner (laneRunner, 1.48.1).
 *
 * "Prop" is ChartBridge's word (`prop` on each row of the `accounts` message, 0.6.16): every live account that is not the
 * personal account Anthony picked. With no pick nothing is prop, and the tab says how to pick.
 *
 * Nothing here places an order. It can send three messages and no other (FleetCore.maySend, which workspace.js puts in
 * front of the connection): `agentKillAllProp`, `agentPick`, and `agentMode` to Auto or to Shadow. The one request it makes
 * is GET /roster.
 *
 * Two parts, as league.js: FleetCore (pure: Node tests, test/fleet.test.js) and, in a browser, FleetView (the tab).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FleetCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const KILL_MIN = '0.6.17';       // ChartBridge that knows agentKillAllProp
const SWITCH_MIN = '0.6.18';     // ... the two entry switches
const DAYSTOP_MIN = '0.6.19';    // ... the day's profit stop
const ROSTER_MIN = '0.6.20';     // ... GET /roster
const PICK_MIN = '0.6.21';       // ... the pick (agentPick)
const STAGES = ['eval', 'funded'];
const FILE_RX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}\.json$/;      // a roster file's name, as ChartBridge takes it (PlainName)
const ID_RX = /^[a-z0-9]{1,12}$/;                              // a trader's id
const ROSTER_FORMAT = 'specrunner.roster/1', LINEUP_FORMAT = 'specrunner.lineup/1';   // Bot-Lab specrunner/roster.py
const NAME_RX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
/* chart 1.54.0 (G): Anthony's name for a bot at promotion, the roster file's optional display_name (Bot-Lab specrunner/roster.py
   _DISPLAY: plain words, 40 at most, no double space, nothing around it). A label for the pages only: the bot's built name stays
   what every plan carries, and it shows small beneath. */
const DISPLAY_RX = /^[A-Za-z0-9][A-Za-z0-9 .'_-]{0,39}$/;
const displayNameOk = n => typeof n === 'string' && DISPLAY_RX.test(n) && n.indexOf('  ') < 0 && n === n.trim();
/** The name a card shows: Anthony's display_name when it has one, else the built name. */
const shownName = c => (c && c.displayName ? c.displayName : c ? c.name : '');
/** A card in a list of text (the pick list, the Armed question): the shown name, the built name beside it when they differ. */
const cardText = c => (c.displayName ? c.displayName + ' (' + c.name + ')' : c.name) + (c.kind === 'lineup' ? ' (lineup of ' + c.bots.length + ')' : '');
const CONFIRM_MS = 8000;         // the Kill all question stays this long (compared at the Yes too, not left to a timer)
const ARM_MS = 600;              // ... and takes no answer for this long after it opens: a double click answers nothing
const ANSWER_WAIT_MS = 5000;     // a Kill all sent and not answered in this long is said, marked bad
const ROSTER_WAIT_MS = 10000;    // a roster request not answered in this long is given up
const MAX_CARDS = 100, MAX_MEMBERS = 12, MAX_NOT_SHOWN = 50;     // what the roster draws at most
const MODE_NAME = { shadow: 'Shadow', copilot: 'Copilot', auto: 'Auto' };
const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
const isNum = v => typeof v === 'number' && isFinite(v);
const plainObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n || 200) : '');

/* a version of two parts ("0.7") reads as 0.7.0, never as "older than everything" */
function parseVersion(v) { const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(typeof v === 'string' ? v : ''); return m ? [+m[1], +m[2], +(m[3] || 0)] : null; }
function atLeast(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
}

/** Dollars for the tab: "$1,200", "-$310", "+$310" with sign true; "" when not a number. Whole dollars unless cents matter. */
function usd(v, sign) {
  if (!isNum(v)) return '';
  const a = Math.abs(v), cents = Math.abs(a - Math.round(a)) > 0.004;
  const body = '$' + a.toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
  return (v < 0 ? '-' : sign && v > 0 ? '+' : '') + body;
}

/** The rows of the `accounts` message by name (lower case). */
function accountIndex(accountsMsg) {
  const m = new Map();
  for (const a of (accountsMsg && Array.isArray(accountsMsg.list) ? accountsMsg.list : [])) if (plainObj(a) && typeof a.name === 'string') m.set(a.name.toLowerCase(), a);
  return m;
}
/** The groups of the `groups` message (its `list`) by id. */
function groupIndex(groupsMsg) {
  const m = new Map();
  for (const g of (groupsMsg && Array.isArray(groupsMsg.list) ? groupsMsg.list : [])) if (plainObj(g) && typeof g.id === 'string') m.set(g.id, g);
  return m;
}

/** 'prop', 'personal', 'sim' or '' (not known, or no personal account picked) for one row of the accounts message. */
function kindOf(row) {
  if (!plainObj(row)) return '';
  if (row.prop === true) return 'prop';
  if (row.personal === true) return 'personal';
  if (row.sim === true) return 'sim';
  return '';
}

/**
 * The day's profit stop for one account, as ChartBridge 0.6.19 computes it (ChartBridgeAgents.DayMark): the smaller of the
 * plan's value and, on an account that is not funded, its consistency percent of its profit target. -> { mark, from } or null.
 */
function dayMark(rules, stage, planValue) {
  let mark = 0, from = '';
  if (isNum(planValue) && planValue > 0) { mark = planValue; from = "the plan's day stop"; }
  const r = plainObj(rules) ? rules : null;
  if (stage !== 'funded' && r && isNum(r.consistency) && r.consistency > 0 && isNum(r.target) && r.target > 0) {
    const c = Math.round(r.consistency / 100 * r.target * 100) / 100;
    if (c > 0 && (mark === 0 || c < mark)) { mark = c; from = r.consistency + '% of the ' + usd(r.target) + ' target'; }
  }
  return mark > 0 ? { mark, from } : null;
}

/** The accounts one trader is on, from its `agent` message: its account AND every seat it has (a group's, or one left over
 *  after a move), each once (answers 26, R3-4, and builder 4's note on answers B4-2: the gates count them the same way). */
function traderAccounts(agent) {
  const a = plainObj(agent) ? agent : {};
  const out = [];
  if (typeof a.account === 'string' && a.account) out.push(a.account);
  if (Array.isArray(a.seats)) for (const x of a.seats) if (plainObj(x) && typeof x.account === 'string' && x.account && !out.includes(x.account)) out.push(x.account);
  return out;
}
/** Can the page read this trader's accounts at all? account null or a name, group null or an object, seats absent or a list of
 *  { account: name }. Anything else is "the page cannot tell" (answers 28, R4-1; the same reader as 104's). */
function accountsReadable(a) {
  if (!plainObj(a)) return false;
  // answers 34, 104-E: the same rule as the gates' AgentCore.gateAccounts: a missing `account` key is not None, it is not known
  const acct = own(a, 'account') && (a.account === null || (typeof a.account === 'string' && a.account.length > 0));
  const grp = a.group === undefined || a.group === null || (plainObj(a.group) && typeof a.group.id === 'string' && a.group.id.length > 0);
  const seats = a.seats === undefined || a.seats === null || (Array.isArray(a.seats) && a.seats.every(x => plainObj(x) && typeof x.account === 'string' && x.account.length > 0));
  return acct && grp && seats;
}

/** What a trader is doing, in a few words (the Agent tab's own order of reasons). */
function statusText(a) {
  if (!a) return 'Not known yet';
  if (a.enabled === false) return 'Off in ChartBridge';
  if (a.killed) return 'Kill switch on';
  if (a.standDown) return 'Stood down: ' + str(a.standDown, 300);
  if (!a.connected) return 'Not connected: its program is not running';
  if (isNum(a.lastBeatMs) && a.lastBeatMs > 5000) return 'Heartbeat late (' + (a.lastBeatMs / 1000).toFixed(1) + ' s)';
  return a.owns ? 'In a trade' : 'Watching';
}

/**
 * What a trader's accounts are, for Kill all (ChartBridgeAgents.KillScope and KillMixed). kinds: one of 'prop', 'personal',
 * 'sim', 'unlisted' (NinjaTrader does not list it now: in scope for Kill all) or '' (listed, and no personal account picked).
 * -> 'none' | 'prop' | 'personal' | 'sim' | 'unlisted' (in scope, some seat not listed) | 'mixed' (the personal account AND
 *    a seat in scope: Kill all will NOT stop it) | 'propsim' (prop and Sim seats: stopped, its prop seats flattened) | ''
 */
function seatsKind(kinds) {
  if (!kinds.length) return 'none';
  if (kinds.some(k => k === '')) return '';
  const scope = kinds.some(k => k === 'prop' || k === 'unlisted'), me = kinds.some(k => k === 'personal');
  if (scope && me) return 'mixed';
  if (scope) return kinds.some(k => k === 'unlisted') ? 'unlisted' : kinds.some(k => k === 'sim') ? 'propsim' : 'prop';
  return me && kinds.some(k => k === 'sim') ? 'personal' : me ? 'personal' : 'sim';
}

/**
 * The traders, one row each, in id order. agents: the `agent` messages (a list); accountsMsg; version: ChartBridge's.
 * -> [{ id, name, build, mode, modeText, connected, autoProp, status, tone, accounts, accountText, kind, window, flatAt,
 *       marketEntry, noTarget, switchesKnown, dayStop, dayStopKnown, pnlToday, trades }]
 * autoProp: in Auto, not off, not killed, not stood down, on something Kill all counts (kind prop, propsim, unlisted or
 * mixed): it can place an order on a prop account, now or as soon as its program connects. (The draft's two-word label for this was the name
 * of the claim through The Desk that the corrected design withdrew, so it is not used.)
 */
function traders(agents, accountsMsg, version) {
  const idx = accountIndex(accountsMsg);
  const out = [];
  for (const a of (Array.isArray(agents) ? agents : [])) {
    if (!plainObj(a) || typeof a.agent !== 'string') continue;
    const names = traderAccounts(a);
    const kind = !accountsReadable(a) ? '' : seatsKind(names.map(n => { const row = idx.get(n.toLowerCase()); return row ? kindOf(row) : (accountsMsg && accountsMsg.personalNamed === true ? 'unlisted' : ''); }));
    const r = plainObj(a.rules) ? a.rules : {};
    const mode = own(MODE_NAME, a.mode) ? a.mode : '';
    const can = a.enabled !== false && !a.killed && !a.standDown;
    out.push({
      id: a.agent, name: str(a.name, 40) || a.agent, build: str(a.build, 40), mode, modeText: mode ? MODE_NAME[mode] : 'Not known',
      connected: a.connected === true, autoProp: can && mode === 'auto' && (kind === 'prop' || kind === 'propsim' || kind === 'unlisted' || kind === 'mixed'),
      cannotTell: can && mode === 'auto' && !accountsReadable(a), readsAccounts: accountsReadable(a), grouped: plainObj(a.group),   // 104-B and 104-D (answers 27)
      status: statusText(a), tone: a.enabled === false ? 'off' : a.killed ? 'killed' : a.standDown ? 'standDown' : !a.connected ? 'lost' : 'on',
      // answers B4-8, F1: a trader whose accounts the page cannot read never shows as None, nor as only the seats it can read
      accounts: names, accountText: !accountsReadable(a) ? 'Cannot tell its accounts' + (names.length ? ' (the page reads ' + names.join(', ') + ', not the rest)' : '')
        : !names.length ? 'None' : plainObj(a.group) ? 'Group ' + (str(a.group.name, 40) || str(a.group.id, 12)) + ': ' + names.join(', ')
        : names.length > 1 ? names[0] + ', left over: ' + names.slice(1).join(', ') : names[0],   // 104-D: every account, as Kill all counts them
      kind, window: str(r.entryFrom, 5) && str(r.entryUntil, 5) ? str(r.entryFrom, 5) + ' to ' + str(r.entryUntil, 5) : '', flatAt: str(r.flatAt, 5),
      marketEntry: r.marketEntry === true, noTarget: r.noTarget === true, switchesKnown: atLeast(version, SWITCH_MIN),
      dayStop: isNum(a.dayStop) && a.dayStop > 0 ? a.dayStop : null, dayStopKnown: atLeast(version, DAYSTOP_MIN),
      pnlToday: isNum(a.pnlToday) ? a.pnlToday : null, trades: isNum(a.trades) ? a.trades : null,
    });
  }
  return out.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/**
 * The prop accounts, one row each, in name order. -> [{ name, stage, stageText, group, connection, made, target, progressText,
 *   cushion, cushionWhy, today, mark, markText, done, traders: [ids], position, sizeNote }]
 * stage: 'eval', 'funded' or '' (its group has no Type, or it is in no group: the runner sizes it 0 and the tab says so).
 * done: today is at or over the day's profit stop.
 */
function propAccounts(accountsMsg, groupsMsg, agents) {
  const groups = groupIndex(groupsMsg);
  const rows = [];
  for (const a of (accountsMsg && Array.isArray(accountsMsg.list) ? accountsMsg.list : [])) {
    if (!plainObj(a) || a.prop !== true || typeof a.name !== 'string') continue;
    const g = typeof a.group === 'string' ? groups.get(a.group) : null;
    const stage = g && (g.accountType === 'eval' || g.accountType === 'funded') ? g.accountType : '';
    const rules = plainObj(a.rules) ? a.rules : null;
    const target = rules && isNum(rules.target) && rules.target > 0 ? rules.target : null;
    const made = target !== null && isNum(a.targetLeft) ? Math.round((target - a.targetLeft) * 100) / 100 : null;
    const on = (Array.isArray(agents) ? agents : []).filter(x => plainObj(x) && traderAccounts(x).some(n => n.toLowerCase() === a.name.toLowerCase()));
    const plan = on.map(x => (isNum(x.dayStop) && x.dayStop > 0 ? x.dayStop : 0)).filter(Boolean);
    const dm = dayMark(rules, stage, plan.length ? Math.min.apply(null, plan) : 0);
    const today = isNum(a.pnlToday) ? a.pnlToday : null;
    const pos = (Array.isArray(a.positions) ? a.positions : []).filter(p => plainObj(p) && isNum(p.qty) && p.qty !== 0)
      .map(p => (p.qty > 0 ? 'Long ' : 'Short ') + Math.abs(p.qty) + ' ' + str(p.root || p.name, 12)).join(', ');
    rows.push({
      name: a.name, stage, stageText: stage === 'eval' ? 'Eval' : stage === 'funded' ? 'Funded' : 'No type',
      group: g ? str(g.name, 40) : '', connection: str(a.connection, 20),
      made, target, progressText: target === null ? 'no target in its rules' : made === null ? 'not known' : usd(made) + ' of ' + usd(target),
      cushion: isNum(a.roomFloor) ? a.roomFloor : null, cushionWhy: plainObj(a.why) ? str(a.why.roomFloor, 200) : '',
      today, mark: dm ? dm.mark : null,
      markText: dm ? (today !== null ? usd(today) + ' of ' : '') + usd(dm.mark) + ' (' + dm.from + ')' : stage === 'funded' ? 'none (funded, and no plan value)' : 'none',
      done: !!dm && today !== null && today >= dm.mark - 1e-9,
      traders: on.map(x => x.agent), position: pos || (a.connection === 'connected' ? 'Flat' : 'Not connected'),
      sizeNote: !g ? 'In no group: the runner sizes it 0 (it reads the stage from the group\'s Type)' : !stage ? 'Its group has no Type (eval or funded): the runner sizes it 0' : '',
    });
  }
  return rows.sort((x, y) => (x.name.toLowerCase() < y.name.toLowerCase() ? -1 : x.name.toLowerCase() > y.name.toLowerCase() ? 1 : 0));
}

/* ---------------------------------------------------------------- the roster (GET /roster, ChartBridge 0.6.20) */
/** "+0.42", "-0.10", "0.00" (two places); "" when not a number. Profit per $1 is a ratio, not dollars. */
function signed(v) { return isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(2) : ''; }
/** A share from 0 to 1 as a percent, one decimal when it has one: 0.996 is "99.6%", never "100%". */
const pct = v => (Math.round(v * 1000) / 10) + '%';
const count = v => (Number.isInteger(v) && v >= 0 ? v : null);
const one = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
/* ---------------------------------------------------------------- Legion simpler (chart 1.54.0, part D) */
const LANE_KEEP_MIN = '0.6.22';   // ChartBridge keeps a lane's trader through the 17:00 reset and runs the lane rule (laneLog)
/** The lane rule's lines on a group (ChartBridge 0.6.22, the groups message's laneLog): [{ at, text }], oldest first, at most
 *  20; a line not in that shape is left out. */
function laneLogOf(g) {
  const raw = plainObj(g) && Array.isArray(g.laneLog) ? g.laneLog : [];
  return raw.filter(x => plainObj(x) && isNum(x.at) && x.at > 0 && typeof x.text === 'string' && x.text.length > 0).slice(-20).map(x => ({ at: x.at, text: str(x.text, 300) }));
}
/** A time of ChartBridge's (Unix milliseconds) as New York hours and minutes, "14:05". */
function hhmm(ms) {
  try { return new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); } catch (e) { return ''; }
}
/** A lane's status in a word or two (Anthony 2026-11-13: "status in one or two words"); the why is behind the lane's "?". */
function laneWord(l) {
  if (!l || !l.id) return { key: 'notrader', text: 'No trader' };
  if (!l.pick) return { key: 'nobot', text: 'No bot' };
  if (l.auto && l.exposed) return { key: 'intrade', text: 'In a trade' };
  if (l.stoodDown) return { key: 'stooddown', text: 'Stood down' };   // 1.55.0 (D3): a day stop or a loss stop reached, or stood down by hand
  if (l.auto) return { key: 'trading', text: 'Trading' };
  return l.armable ? { key: 'off', text: 'Off' } : { key: 'notready', text: 'Not ready' };
}
/**
 * A lane's accounts as its list shows them (chart 1.55.0, D1 and D2): trading first, then the bench, each by name.
 * -> [{ name, benched, sim, today (dollars or null), ruleOwned }]. ruleOwned: an account that is not Sim, which the lane rule
 * (ChartBridge 0.6.22) adds and takes out by its type on The Desk, so the page offers no Remove for it (a hand remove would
 * be undone within a minute); a Sim account carries no type, so it is added and removed by hand.
 */
function laneAccounts(l, accountsMsg, version) {
  if (!plainObj(l) || !Array.isArray(l.seats) || !Array.isArray(l.benched)) return [];
  const idx = accountIndex(accountsMsg), handKept = atLeast(version, HAND_MIN);
  /* 1.56.0 (Anthony 2026-11-13: "If I make a move, that's the move"): from ChartBridge 0.6.23 a hand Remove sticks (the rule skips
     it), so every account has Remove; with an older one a removal of an account the rule owns would come back within a minute */
  const row = (name, benched) => {
    const r = idx.get(String(name).toLowerCase()), sim = !!(r && r.sim === true);
    return { name, benched, sim, today: r && isNum(r.pnlToday) ? r.pnlToday : null, ruleOwned: !sim && !handKept };
  };
  return l.seats.map(n => row(n, false)).concat(l.benched.map(n => row(n, true)));
}
const RULE_OWNED_WORDS = 'Leaves when The Desk marks it blown, passed or archived';
const HAND_MIN = '0.6.23';   // ChartBridge keeps a hand removal out of the lane rule and says the rule's state (laneRule)
/**
 * The lane rule's state as a lane card says it (chart 1.56.0), from the groups message's laneRule (ChartBridge 0.6.23), for
 * one stage. -> { key: on | off | error | unknown | none, text, kept: [{ account, from }] } where kept are the accounts taken out
 * of a lane of this stage by hand (the rule leaves them out until they are put in a group by hand).
 */
function laneRuleOf(groupsMsg, version, stage) {
  const lr = plainObj(groupsMsg) && plainObj(groupsMsg.laneRule) ? groupsMsg.laneRule : null;
  const kept = lr && Array.isArray(lr.handOut) ? lr.handOut.filter(x => plainObj(x) && typeof x.account === 'string' && x.account && x.type === stage).slice(0, 50).map(x => ({ account: str(x.account, 60), from: str(x.from, 40) })) : [];
  if (!atLeast(version, LANE_KEEP_MIN)) return { key: 'none', text: 'Lane rule: needs ChartBridge ' + LANE_KEEP_MIN + ' (this one is ' + (version || 'not known') + ')', kept };
  if (!lr) return { key: 'unknown', text: 'Lane rule: ChartBridge ' + (version || '') + ' does not say; it runs unless config.txt has laneRule = off (ChartBridge ' + HAND_MIN + ' says)', kept };
  const why = typeof lr.why === 'string' && lr.why ? str(lr.why, 300) : '';
  if (lr.state === 'on') return { key: 'on', text: 'Lane rule: on', kept };
  if (lr.state === 'off') return { key: 'off', text: 'Lane rule: off' + (why ? ' (' + why + ')' : ''), kept };
  if (lr.state === 'error') return { key: 'error', text: 'Lane rule: not working' + (why ? ': ' + why : ''), kept };
  return { key: 'unknown', text: 'Lane rule: not known', kept };
}
/**
 * The lanes' third row, Unassigned (chart 1.56.0; Anthony 2026-11-13: "there should be 3 rows, eval, funded and unassigned",
 * "show them in unassigned marked in copier"), from the groups message's laneRule.outside (ChartBridge 0.6.23): every account
 * The Desk types eval or funded that is in no lane, marked with where it is. -> { key: none | unknown | list, text, rows:
 * [{ account, kind, kindText, group, copier, byHand, where }] }. Only ChartBridge's words: nothing here is worked out.
 */
function unassigned(groupsMsg, version) {
  const lr = plainObj(groupsMsg) && plainObj(groupsMsg.laneRule) ? groupsMsg.laneRule : null;
  if (!atLeast(version, HAND_MIN) || !lr || !own(lr, 'outside')) return { key: 'none', text: 'Needs ChartBridge ' + HAND_MIN + ' or later (this one is ' + (version || 'not known') + ')', rows: [] };
  if (!Array.isArray(lr.outside)) return { key: 'unknown', text: 'Not known yet: ChartBridge has not read The Desk\'s accounts (the lane rule reads them once a minute while it is on)', rows: [] };
  const rows = lr.outside.filter(x => plainObj(x) && typeof x.account === 'string' && x.account && STAGES.includes(x.kind)).slice(0, 100).map(x => {
    const group = typeof x.group === 'string' && x.group ? str(x.group, 40) : '', copier = x.copier === 'follower' || x.copier === 'leader' ? x.copier : '', byHand = x.byHand === true;
    const where = [group ? 'in ' + group : '', copier === 'follower' ? 'in the copier' : copier === 'leader' ? 'the copier\'s leader' : '', !group && byHand ? 'kept out by hand' : '', !group && !copier && !byHand ? 'in no group' : ''].filter(Boolean).join(', ');
    return { account: str(x.account, 60), kind: x.kind, kindText: x.kind === 'eval' ? 'Eval' : 'Funded', group, copier, byHand, where };
  }).sort((a, b) => (a.kind !== b.kind ? (a.kind === 'eval' ? -1 : 1) : a.account.toLowerCase() < b.account.toLowerCase() ? -1 : a.account.toLowerCase() > b.account.toLowerCase() ? 1 : 0));
  return { key: 'list', text: rows.length ? one(rows.length, 'account') + ' outside the lanes' : 'Every eval and funded account is in its lane.', rows };
}
const LANE_HELP = 'A lane is a trader whose account is a group; the group\'s Type (eval or funded) says which lane. From ChartBridge ' + LANE_KEEP_MIN + ' the lanes fill themselves: an account whose type on The Desk is eval or funded joins its lane on the bench (it trades only once you take it off the bench), and a blown, passed or archived one leaves once flat; every move is a line on the lane. The accounts button opens the lane\'s own Multi-Account panel: drag or click an account in or out, or on and off the bench. No account moves while the lane is in Auto or holds something. Armed sends each ready lane to Auto; off sends every lane to Shadow and closes no position: Kill all does. What shows here is what ChartBridge says, so a mode changed on Praetorian, by Kill all or at 17:00 New York shows here too.';
const share = v => isNum(v) && v >= 0 && v <= 1;

/**
 * One stage of a roster file as the tab shows it, or null when anything in the file's playbook or numbers is not what the
 * format says (Bot-Lab's specrunner/roster.py, _check_scored and _numbers). Only null means "none": a value of another type
 * (the text "800", 0, a negative, a key left out) is never read as none (the review of 92, FIX 1): the file is then not shown.
 */
function stageCard(d, stage) {
  const pb = plainObj(d.playbook) ? d.playbook[stage] : null, n = plainObj(d.numbers) ? d.numbers[stage] : null;
  if (!plainObj(pb) || !plainObj(n) || !isNum(pb.risk_dollars) || pb.risk_dollars <= 0 || !isNum(n.profit_per_dollar)) return null;
  const optKeys = ['daily_loss_stop', 'daily_profit_stop', 'max_trades'].concat(stage === 'funded' ? ['payout_at'] : []);
  for (const k of optKeys) if (!own(pb, k) || !(pb[k] === null || (isNum(pb[k]) && pb[k] > 0))) return null;
  if (pb.max_trades !== null && !Number.isInteger(pb.max_trades)) return null;
  const ne = n.no_edge, r = n.range95;
  if (!plainObj(ne) || !isNum(ne.median) || !isNum(ne.p5) || !isNum(ne.p95) || ne.p5 > ne.p95 || typeof n.above_no_edge !== 'boolean') return null;
  if (!Array.isArray(r) || r.length !== 2 || !isNum(r[0]) || !isNum(r[1]) || r[0] > r[1]) return null;
  if (!own(n, 'not_searched_on') || !(n.not_searched_on === null || isNum(n.not_searched_on))) return null;
  const optPos = k => own(n, k) && (n[k] === null || (isNum(n[k]) && n[k] > 0));
  if (stage === 'eval') { if (!share(n.eval_pass) || !optPos('sessions_to_pass')) return null; }
  else if (!isNum(n.paid_per_funded) || !share(n.share_paid) || !optPos('sessions_to_first_payout')) return null;
  const out = {
    stage, title: stage === 'eval' ? 'Eval' : 'Funded',
    risk: pb.risk_dollars, dayLoss: pb.daily_loss_stop, dayProfit: pb.daily_profit_stop, maxTrades: pb.max_trades,
    payoutAt: stage === 'funded' ? pb.payout_at : null,
    profitPerDollar: n.profit_per_dollar, range: [r[0], r[1]],
    noEdge: { median: ne.median, p5: ne.p5, p95: ne.p95 }, aboveNoEdge: n.above_no_edge,
    notSearchedOn: n.not_searched_on,
    evalPass: stage === 'eval' ? n.eval_pass : null, paidPerFunded: stage === 'funded' ? n.paid_per_funded : null,
  };
  out.playbookText = 'Risk ' + usd(out.risk) + ' a trade; day loss stop ' + (out.dayLoss === null ? 'none' : usd(out.dayLoss)) + '; day profit stop ' + (out.dayProfit === null ? 'none' : usd(out.dayProfit)) +
    '; ' + (out.maxTrades === null ? 'no cap on trades a day' : 'at most ' + one(out.maxTrades, 'trade') + ' a day') + (stage === 'funded' ? '; payout ' + (out.payoutAt === null ? 'not set' : 'at ' + usd(out.payoutAt)) : '');
  out.profitText = 'Profit per $1: ' + signed(out.profitPerDollar) + ' (95%: ' + signed(out.range[0]) + ' to ' + signed(out.range[1]) + ')';
  out.noEdgeText = 'No edge would show ' + signed(ne.median) + ' (5th to 95th: ' + signed(ne.p5) + ' to ' + signed(ne.p95) + ')';
  out.edgeText = out.aboveNoEdge ? 'Above no edge' : 'Not above no edge';
  out.heldBackText = 'On the sessions not searched: ' + (out.notSearchedOn === null ? 'none were held back' : signed(out.notSearchedOn));
  if (stage === 'eval') out.stageText = 'Passes ' + pct(n.eval_pass) + ' of evals' + (n.sessions_to_pass === null ? '' : ', in ' + n.sessions_to_pass + ' sessions (median)');
  else out.stageText = 'Paid ' + usd(n.paid_per_funded) + ' per funded account; ' + pct(n.share_paid) + ' reach a payout' + (n.sessions_to_first_payout === null ? '' : ', the first in ' + n.sessions_to_first_payout + ' sessions (median)');
  return out;
}
/** A bot's part (its own file, or one row of a lineup's `bots`): the name, whether it runs live and why not, its run. Or null.
 *  runs_live true goes with a why_not of null, false with the reason as text: anything else is not the format (N4). */
function botPart(b) {
  if (!plainObj(b) || typeof b.bot !== 'string' || !NAME_RX.test(b.bot) || typeof b.runs_live !== 'boolean' || !plainObj(b.record) || typeof b.record.run_id !== 'string' || !b.record.run_id) return null;
  if (b.runs_live ? b.why_not !== null : !(typeof b.why_not === 'string' && b.why_not)) return null;
  const r = b.record, sess = count(r.sessions), trades = count(r.trades), tries = count(r.try);
  return {
    name: b.bot, runsLive: b.runs_live, whyNot: b.runs_live ? '' : str(b.why_not, 400), family: str(r.family, 40),
    runId: str(r.run_id, 80), sessions: sess, trades, tries, instrument: str(r.instrument, 12), verdict: str(r.verdict, 200),
    recordText: 'Run ' + str(r.run_id, 80) + ': ' + (sess === null ? 'sessions not known' : one(sess, 'session')) + ', ' + (trades === null ? 'trades not known' : one(trades, 'trade')) + (str(r.instrument, 12) ? ', ' + str(r.instrument, 12) : ''),
    /* a roster/1 file carries no confirmation on locked weeks: every number in it is in-sample (build answers 8, section 4) */
    evidenceText: 'In-sample, not confirmed' + (tries === null ? '; try count not known' : '; try ' + tries),
    /* the file's free text, labelled as what it is: it can never read as this tab's own word (the review of 92, FIX 2) */
    verdictText: str(r.verdict, 200) ? "The run's own per-trade verdict (in-sample): " + str(r.verdict, 200) : '',
  };
}
const planText = p => (plainObj(p) && typeof p.size === 'string' && typeof p.dll === 'boolean' ? str(p.size, 8) + (p.dll ? ' with the daily loss limit' : ' without the daily loss limit') : 'plan not known');
const QUICK_WHY = 'it was built with --quick, a small search for a look: never a file to trade on';

/**
 * The body of GET /roster as the tab shows it. body: the parsed JSON ({ files: [{ name, ok, roster | why }], left }).
 * -> { ok, why, bots: [card], lineups: [card], notShown: [{ name, why }], left }
 * A card: { kind: 'bot' | 'lineup', file, name, runsLive, whyNot, quick, planText, stages: [eval, funded], ... } and, for a bot,
 * its botPart; for a lineup, bots: [botPart + { taken, skipped, sessionsLeftOut }] in the lineup's order and joinedText.
 * The tab is not Bot-Lab's strict reader, but it shows no file that reader's own rules for these fields would refuse: a file
 * whose shape it cannot show is listed under notShown with why, never half shown. A quick file (any truthy counts.quick, as
 * the reader's own lines() takes it) never reads "Runs live": the runner refuses it. Two files that name the same bot, or
 * the same lineup, are both not shown: the tab cannot say which one the runner would take.
 */
function rosterCards(body) {
  const out = { ok: false, why: '', bots: [], lineups: [], notShown: [], left: 0 };
  if (!plainObj(body) || !Array.isArray(body.files)) { out.why = 'ChartBridge\'s answer is not a roster list'; return out; }
  out.ok = true;
  out.left = count(body.left) || 0;
  for (const f of body.files) {
    if (!plainObj(f) || typeof f.name !== 'string') continue;
    const name = str(f.name, 60), no = why => out.notShown.push({ name, why });
    if (f.ok !== true) { no(str(f.why, 200) || 'ChartBridge did not serve it'); continue; }
    const d = f.roster;
    if (!plainObj(d) || (d.format !== ROSTER_FORMAT && d.format !== LINEUP_FORMAT)) { no('not a roster file this tab knows'); continue; }
    const stages = [stageCard(d, 'eval'), stageCard(d, 'funded')];
    if (!stages[0] || !stages[1]) { no('its playbook or its numbers are not in the format\'s shape'); continue; }
    if (!plainObj(d.counts)) { no('its counts are not in the format\'s shape'); continue; }
    const quick = !!d.counts.quick;
    const base = { file: name, quick, planText: planText(d.plan), stages, sha256: typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.sha256) ? f.sha256 : '' };   // 0.6.21: the file's sha256, which Armed names
    if (d.format === ROSTER_FORMAT) {
      if (own(d, 'display_name') && !displayNameOk(d.display_name)) { no('its display_name is not plain words, 40 at most'); continue; }   // 1.54.0 (G): the reader's own rule
      if (own(d, 'display_name')) base.displayName = d.display_name;
      const b = botPart(d);
      if (!b) { no('its bot, its run or whether it runs live is not in the format\'s shape'); continue; }
      if (quick) { b.whyNot = b.runsLive ? QUICK_WHY : b.whyNot + '; and ' + QUICK_WHY; b.runsLive = false; }
      out.bots.push(Object.assign({ kind: 'bot' }, base, b));
    } else {
      if (own(d, 'display_name')) { no('a lineup file carries no display_name (only a bot\'s own file does)'); continue; }   // 1.54.0 (G): the lineup format has none
      const parts = Array.isArray(d.bots) ? d.bots.map(x => { const b = botPart(x); return b && Object.assign(b, { taken: count(x.taken), skipped: count(x.skipped), sessionsLeftOut: count(x.sessions_left_out) }); }) : [];
      if (typeof d.lineup !== 'string' || !NAME_RX.test(d.lineup) || parts.length < 2 || parts.some(b => !b || b.taken === null || b.skipped === null || b.sessionsLeftOut === null) || typeof d.runs_live !== 'boolean') { no('its name or its bots are not in the format\'s shape'); continue; }
      if (new Set(parts.map(b => b.name)).size !== parts.length) { no('a bot appears twice in the lineup'); continue; }
      const j = plainObj(d.joined) ? d.joined : {};
      if (count(j.sessions) === null || count(j.trades) === null || count(j.skipped) === null) { no('its joined record is not in the format\'s shape'); continue; }
      const stopped = parts.filter(b => !b.runsLive);
      const why = stopped.length ? stopped.map(b => b.name + ': ' + b.whyNot).join('; ') : d.runs_live ? '' : 'the file says the lineup does not run live';
      out.lineups.push(Object.assign({ kind: 'lineup' }, base, {
        name: d.lineup, bots: parts,
        /* the lineup runs live only when the file says so AND every bot in it does AND it is not a quick file */
        runsLive: d.runs_live === true && !stopped.length && !quick,
        whyNot: str(quick ? (why ? why + '; and ' : '') + QUICK_WHY : why, 600),
        joinedText: one(j.sessions, 'session') + ' in common, ' + one(j.trades, 'trade') + ' taken, ' + j.skipped + ' skipped because another bot\'s trade was open',
        evidenceText: 'In-sample, not confirmed; tries: ' + parts.slice(0, MAX_MEMBERS).map(b => b.name + ' ' + (b.tries === null ? 'not known' : b.tries)).join(', ') + (parts.length > MAX_MEMBERS ? ', and ' + (parts.length - MAX_MEMBERS) + ' more' : ''),
      }));
    }
  }
  /* two files, one name: neither is shown */
  for (const key of ['bots', 'lineups']) {
    const seen = new Map();
    for (const c of out[key]) seen.set(c.name, (seen.get(c.name) || []).concat(c.file));
    out[key] = out[key].filter(c => {
      const files = seen.get(c.name);
      if (files.length < 2) return true;
      out.notShown.push({ name: c.file, why: files.length + ' files name the ' + (key === 'bots' ? 'bot ' : 'lineup ') + c.name + ' (' + files.join(', ') + '): the tab cannot say which one the runner would take' });
      return false;
    });
  }
  const byName = (x, y) => (x.name.toLowerCase() < y.name.toLowerCase() ? -1 : x.name.toLowerCase() > y.name.toLowerCase() ? 1 : 0);
  out.bots.sort(byName); out.lineups.sort(byName);
  return out;
}
/** Why the roster is not shown, for an answer of GET /roster that is not a 200 with a list. status: the HTTP status; 0: the
 *  request itself failed; 'late': no answer in ROSTER_WAIT_MS; 'notjson': a 200 whose body is not JSON. */
function rosterProblem(status, error) {
  if (status === 404) return 'No roster folder is set on this PC. It is one line in ChartBridge\'s config.txt (rosterFolder), filled in when Bot-Lab is installed here.';
  if (status === 403) return 'ChartBridge serves the roster only to a page opened by the localhost name. Open the chart page as localhost, not by a number.';
  if (status === 500) return 'ChartBridge could not read the roster folder' + (str(error, 200) ? ': ' + str(error, 200) : '') + '.';
  if (status === 0) return 'The roster could not be asked for: ChartBridge did not answer.';
  if (status === 'late') return 'ChartBridge did not answer the roster request in ' + (ROSTER_WAIT_MS / 1000) + ' seconds. Read again asks once more.';
  if (status === 'notjson') return 'ChartBridge answered the roster request with something that is not JSON.';
  return 'ChartBridge answered ' + status + ' for the roster.';
}

/** May Kill all be sent now? -> { ok, why }. */
function killAllState(version, accountsMsg, signedIn, connected) {
  if (!connected) return { ok: false, why: 'ChartBridge is not connected' };
  if (!atLeast(version, KILL_MIN)) return { ok: false, why: 'Kill all needs ChartBridge ' + KILL_MIN + ' or later (this one is ' + (version || 'not known') + ')' };
  if (!signedIn) return { ok: false, why: 'Sign in to trading first (the PIN in the top bar)' };
  /* PROP 5: "not heard yet" is not "no". Before the first accounts message the tab does not know whether a personal account
     is picked; when that is the only thing missing, Yes sends and ChartBridge answers (it knows) */
  if (accountsMsg && accountsMsg.personalNamed !== true) return { ok: false, why: 'No personal account is picked yet, so no account is prop: pick it on the Accounts tab (an account\'s settings, This is my personal account)' };
  return { ok: true, why: '' };
}
const killAllMsg = cid => Object.assign({ type: 'agentKillAllProp' }, cid ? { cid } : {});

/**
 * The line beside the title: every trader in Auto that Kill all counts, and which of them it will NOT stop (the review of
 * 92, PROP 3). It never says nobody is trading while a trader is in Auto on a group with the personal account in it, or on
 * an account NinjaTrader does not list now.
 */
function autoLine(rows, heard) {
  if (heard === false) return 'Not heard from ChartBridge yet which accounts are prop';
  const on = rows.filter(t => t.autoProp), nm = t => t.name + (t.connected ? '' : ' (its program is not connected now)');
  const plain = on.filter(t => t.kind === 'prop' || t.kind === 'propsim'), unl = on.filter(t => t.kind === 'unlisted'), mixed = on.filter(t => t.kind === 'mixed');
  const parts = [];
  if (plain.length) parts.push('In Auto on prop accounts: ' + plain.map(nm).join(', '));
  if (unl.length) parts.push('In Auto on an account NinjaTrader does not list now (Kill all stops it): ' + unl.map(nm).join(', '));
  const mixedGroup = mixed.filter(t => t.grouped), mixedOne = mixed.filter(t => !t.grouped);
  if (mixedGroup.length) parts.push('In Auto on a group with your personal account in it (Kill all will NOT stop it: stop it on the Agent tab): ' + mixedGroup.map(nm).join(', '));
  if (mixedOne.length) parts.push('In Auto on your personal account with a prop account left over (Kill all will NOT stop it: stop it on the Agent tab): ' + mixedOne.map(nm).join(', '));   // 104-D: not a group
  // 104-B (answers 27): never quiet about a trader in Auto whose accounts the page cannot read
  const cannot = rows.filter(t => t.cannotTell);
  if (cannot.length) parts.push('In Auto on accounts the page cannot read (Kill all may not reach it): ' + cannot.map(nm).join(', '));
  if (parts.length) return parts.join('. ');
  return rows.length ? 'No trader is in Auto on a prop account' : 'No traders yet';
}
/* ---------------------------------------------------------------- the lanes, the pick and the Armed switch (D2) */
/** What a lane's trader is doing, with no number that changes by the second (the lane is not redrawn while nothing changed). */
function laneStatus(a) {
  if (a.enabled === false) return 'Off in ChartBridge';
  if (a.killed) return 'Kill switch on';
  if (a.standDown) return 'Stood down: ' + str(a.standDown, 300);
  if (!a.connected) return 'Its runner is not connected';
  return a.owns ? 'In a trade' : 'Watching';
}
/* The Agent tab's own rules for a trader's mode (the review of 94, FIX 6: one rule and one builder on the page): AgentCore's
   modeMsg builds agentMode, and modesAllowed with groupTradable says whether Auto may be asked for. */
const AGC = typeof require === 'function' && typeof module === 'object' ? (() => { try { return require('./agent-core.js'); } catch (e) { return null; } })() : (typeof self !== 'undefined' ? self.AgentCore : null);
const SHA_RX = /^[0-9a-f]{64}$/;
/**
 * The two lanes. agents: the `agent` messages; cards: rosterCards()'s result or null (not read).
 * -> [{ stage, title, traders: [ids], id, name, mode, modeText, auto (a trader of the lane is in Auto), connected, status,
 *       groupId, groupName, seats: [the accounts that trade with the group], benched: [members on the bench], pick, sha,
 *       pickKnown, card (the picked file's card or null), pickText, exposed, why (why it cannot be armed, '' when it can),
 *       armable, runnerNote }]
 * A lane's trader is the one whose account is a group of that Type. None, or more than one: the lane says so and cannot be
 * armed. Nothing here is worked out from a roster file's numbers: a file is named, and only its own "runs live" is read.
 * The review of 94: an account on the group's bench is not a lane's account (FIX 3); every account that trades with the
 * group must be one ChartBridge marks prop (or Sim, said as such), never one it has not said (STOP 1); Auto must be one the
 * Agent tab would offer (AgentCore.modesAllowed with groupTradable, FIX 6); and the 17:00 reset's daily None is said (FIX 4).
 */
function lanes(agents, groupsMsg, accountsMsg, version, cards) {
  const groups = groupIndex(groupsMsg), idx = accountIndex(accountsMsg), files = new Map();
  if (cards && cards.ok) for (const c of cards.lineups.concat(cards.bots)) files.set(c.file, c);
  const list = (Array.isArray(agents) ? agents : []).filter(a => plainObj(a) && typeof a.agent === 'string').sort((x, y) => (x.agent < y.agent ? -1 : x.agent > y.agent ? 1 : 0));
  return STAGES.map(stage => {
    const title = stage === 'eval' ? 'Eval lane' : 'Funded lane';
    const on = list.filter(a => plainObj(a.group) && typeof a.group.id === 'string' && groups.has(a.group.id) && groups.get(a.group.id).accountType === stage);
    const L = { stage, title, traders: on.map(a => a.agent), id: '', name: '', mode: '', modeText: '', auto: on.some(a => a.mode === 'auto'), connected: false, status: '',
      groupId: '', groupName: '', seats: [], benched: [], laneLog: [], stoodDown: false, sim: false, simCount: 0, kindText: '', pick: '', sha: '', pickKnown: atLeast(version, PICK_MIN), card: null, pickText: '', exposed: false, why: '', armable: false, runnerNote: '',
      /* the re-review of 94, R2: any trader of the lane not said to be in Shadow (Copilot, Auto, or not said), set before any
         early return, so a doubled lane in Copilot is never read as "off" */
      notShadow: on.some(a => a.mode !== 'shadow'), notShadowIds: on.filter(a => a.mode !== 'shadow').map(a => a.agent + ' (' + (own(MODE_NAME, a.mode) ? MODE_NAME[a.mode] : 'not known') + ')') };
    if (!groupsMsg) { L.why = 'Not heard from ChartBridge yet'; return L; }
    if (!on.length) {
      L.why = 'No trader is on a group of Type ' + stage + '. Give a trader the group in Legion\'s Traders section below (a group with Type ' + stage + ': New group on the Multi-Account panel). From ChartBridge ' + LANE_KEEP_MIN + ' a lane keeps its trader through the 17:00 reset; an older one puts a flat trader on None each trading day.';
      return L;
    }
    if (on.length > 1) { L.why = on.length + ' traders are on ' + stage + ' groups (' + on.map(a => a.agent).join(', ') + '): Legion runs one lane a stage. Take all but one off on the Agent tab.'; return L; }
    const a = on[0], g = groups.get(a.group.id);
    L.id = a.agent; L.name = str(a.name, 40) || a.agent; L.mode = own(MODE_NAME, a.mode) ? a.mode : ''; L.modeText = L.mode ? MODE_NAME[L.mode] : 'Not known';
    L.connected = a.connected === true; L.status = laneStatus(a); L.exposed = a.owns === true; L.stoodDown = !!a.standDown;
    L.groupId = a.group.id; L.groupName = str(g.name, 40) || a.group.id; L.laneLog = laneLogOf(g);
    /* the re-review of 94, N2: the bench is the Multi-Account panel's own rule (MultiAccountCore.lanes, one rule in one place)
       when that file is loaded (the page loads it after this one, so it is asked here, at the call); the same field read here
       otherwise (Node tests, or the panel not served) */
    const MAC = typeof self !== 'undefined' && self.MultiAccountCore && typeof self.MultiAccountCore.lanes === 'function' ? self.MultiAccountCore : null;
    let bench = new Set(Array.isArray(g.benched) ? g.benched.filter(x => typeof x === 'string') : []);
    if (MAC) { try { const ml = MAC.lanes(g, { accounts: plainObj(accountsMsg) && Array.isArray(accountsMsg.list) ? accountsMsg.list : [], desk: new Map() }, []); bench = new Set(ml.bench.filter(c => c.member).map(c => c.name)); } catch (e) { /* the field as read above */ } }
    const all = traderAccounts(a);
    L.seats = all.filter(n => !bench.has(n)); L.benched = all.filter(n => bench.has(n));
    L.pick = typeof a.pick === 'string' && FILE_RX.test(a.pick) ? a.pick : '';
    L.card = L.pick ? files.get(L.pick) || null : null;
    L.sha = L.card && SHA_RX.test(String(L.card.sha256 || '')) ? L.card.sha256 : '';
    L.pickText = !L.pick ? 'None' : L.card ? cardText(L.card) : L.pick;
    const kinds = L.seats.map(n => { const row = idx.get(n.toLowerCase()); return row ? kindOf(row) : ''; });
    L.sim = kinds.length > 0 && kinds.every(k => k === 'sim');
    L.simCount = kinds.filter(k => k === 'sim').length;
    /* 1.53.0 (Anthony 2026-11-13: Sim and prop may share a lane): what the lane trades, in plain words on its card; '' while any
       account is not prop or Sim (the lane is then not armable and says why) */
    const propCount = kinds.filter(k => k === 'prop').length;
    L.kindText = !kinds.length || propCount + L.simCount !== kinds.length ? '' : propCount && L.simCount ? 'PROP + SIM' : propCount ? 'PROP' : 'SIM';
    /* answers B4-8, F2 (rule 12, A28-1's rule for Armed too): no lane is armed while ANY other trader holds, or may hold, one of
       its accounts (the group's members and every account of its own trader), in any mode: a trader the page cannot read may be
       on any of them. The reason names the trader and the place, never the account. */
    const mine = new Set(all.concat(Array.isArray(g.members) ? g.members.filter(m => typeof m === 'string' && m) : []).map(n => n.toLowerCase()));
    const sharing = list.filter(x => x !== a).map(x => {
      const who = str(x.agent, 40);
      if (!accountsReadable(x)) return who + ': the page cannot read its accounts, so it may be on one of this lane\'s accounts';
      // the next release (answers B4-9, N3): a group trader whose seats ChartBridge has not listed may be on any of them
      if (plainObj(x.group) && (!Array.isArray(x.seats) || !x.seats.length)) return who + ': ChartBridge has not listed its group\'s seats, so it may be on one of this lane\'s accounts';
      const acct = typeof x.account === 'string' && mine.has(x.account.toLowerCase());
      const seat = (Array.isArray(x.seats) ? x.seats : []).some(y => plainObj(y) && typeof y.account === 'string' && mine.has(y.account.toLowerCase()));
      return acct ? who + ' has one of this lane\'s accounts as its own account' : seat ? who + (plainObj(x.group) ? ' has a seat' : ' has a seat left over') + ' on one of this lane\'s accounts' : '';
    }).filter(Boolean);
    const shareWhy = sharing.length ? 'Another trader is on, or may be on, one of its accounts (in any mode), and a lane is never armed beside another trader: ' + sharing.join('; ') : '';
    const r = plainObj(a.rules) ? a.rules : {};
    const allowed = AGC && typeof AGC.modesAllowed === 'function' && typeof AGC.groupTradable === 'function'
      ? AGC.modesAllowed({ tradable: AGC.groupTradable(accountsMsg, null, L.seats), account: L.groupName }).auto : { ok: false, why: 'The page\'s mode rules (agent-core.js) are not loaded' };
    L.why = !L.pickKnown ? 'The pick needs ChartBridge ' + PICK_MIN + ' or later (this one is ' + (version || 'not known') + ')'
      : !ID_RX.test(a.agent) ? 'Its id is not one ChartBridge takes'
      : !accountsReadable(a) ? 'The page cannot tell its accounts (what ChartBridge sent is not an account, a group or a list of seats)'
      : !Array.isArray(g.members) ? 'Not known yet: ChartBridge sent its group without its members, so the page cannot tell who else is on its accounts'   // N3, as groupLock
      : shareWhy ? shareWhy
      : a.enabled === false ? 'The trader is off in ChartBridge'
      : a.killed ? 'Its kill switch is on (it is released on the Agent tab, by you)'
      : a.standDown ? 'It is stood down: ' + str(a.standDown, 300)
      : typeof a.pickProblem === 'string' && a.pickProblem ? 'Its saved pick could not be read: ' + str(a.pickProblem, 200)
      : !L.pick ? 'No bot is picked for it'
      : !cards || !cards.ok ? 'The roster is not read, so the picked file cannot be checked'
      : !L.card ? 'The picked file ' + L.pick + ' is not a roster file this PC serves now'
      : !L.card.runsLive ? L.card.name + ' does not run live: ' + str(L.card.whyNot, 300)
      : !L.sha ? 'ChartBridge gave no sha256 for ' + L.pick + ' (it needs ChartBridge 0.6.21 with the review\'s fixes): Auto must name the file it arms'
      : !accountsMsg ? 'Not heard from ChartBridge yet which accounts are prop'
      : !L.seats.length ? 'No account trades with its group (all on the bench, or none)'
      : kinds.some(k => k === 'personal') ? 'Its group holds your personal account'
      : kinds.some(k => k === '') ? 'ChartBridge has not said whether ' + L.seats.filter((n, i) => kinds[i] === '').join(', ') + ' is prop'
      : !kinds.every(k => k === 'prop' || k === 'sim') ? 'An account of its group is neither prop nor Sim'
      : atLeast(version, SWITCH_MIN) && r.marketEntry !== true ? 'Market entry is off in its rules (the Agent tab): the runner\'s entries would be refused'
      : !allowed.ok ? allowed.why
      : '';
    L.armable = !L.why;
    L.runnerNote = L.connected ? '' : 'Its runner is not connected: nothing trades in this lane until it is.';
    return L;
  });
}
/**
 * Every trader in Auto that is on no lane (the review of 94, FIX 2; the re-review, R3: whatever its account, prop, Sim or
 * not known; only the personal account is Praetorian's and left out), enabled and not killed. -> [ids], with .words: each
 * one named with what it is on and whether Kill all reaches it.
 */
function outsideAuto(ls, agents, accountsMsg, version) {
  const onLane = new Set([].concat.apply([], (ls || []).map(l => l.traders)));
  const rows = traders(agents, accountsMsg, version).filter(t => t.mode === 'auto' && t.tone !== 'off' && t.tone !== 'killed' && t.kind !== 'personal' && !onLane.has(t.id));
  const where = t => (t.kind === 'sim' ? 'on a Sim account (Kill all does not reach it)' : t.kind === 'prop' || t.kind === 'propsim' ? 'on a prop account'
    : t.kind === 'mixed' ? 'on a prop account and your personal account (Kill all will NOT stop it)'   // 104-D (answers 27)
    : t.kind === 'unlisted' ? 'on an account NinjaTrader does not list now'
    : t.readsAccounts === false ? '(the page cannot read its accounts; Kill all may not reach it)'   // answers B4-8, F4
    : 'on an account ChartBridge has not marked prop or personal (Kill all may not reach it)');
  const out = rows.map(t => t.id);
  out.words = rows.map(t => t.id + ' ' + where(t));
  return out;
}
/**
 * The Armed switch, read from ChartBridge's own modes. -> { state: 'unknown' | 'off' | 'on' | 'partly', text, can (may be
 * switched on), canOff, why, reasons }.
 * The review of 94: Armed is offered only when Kill all is (one function decides both: killAllState; STOP 1). Until the page has
 * heard ChartBridge's groups, accounts and traders, signed in and connected, it reads "Armed: not known" and is not offered
 * either way (FIX 1). A trader in Auto outside the lanes, or a lane in Copilot, reads PARTLY with the reason, and a click
 * then only switches off (FIX 2, note 8).
 */
function armState(ls, version, signedIn, connected, accountsMsg, groupsMsg, heard, outside) {
  const kill = killAllState(version, accountsMsg, signedIn, connected);
  const known = connected && signedIn && !!groupsMsg && !!accountsMsg && heard;
  if (!known) {
    const why = !connected ? 'ChartBridge is not connected' : !signedIn ? 'Sign in to trading first (the PIN in the top bar)' : !accountsMsg || !groupsMsg ? 'Not heard from ChartBridge yet' : 'No trader heard from ChartBridge yet';
    return { state: 'unknown', text: 'Armed: not known', can: false, canOff: false, why: why + ': the page does not know whether a lane is in Auto (Kill all and NinjaTrader still work)', reasons: [], outside: [] };
  }
  const out = Array.isArray(outside) ? outside : [];
  const busy = ls.filter(l => l.traders.length && (l.auto || l.notShadow)), ready = ls.filter(l => l.armable);
  const reasons = [];
  for (const l of ls) if (l.traders.length && l.notShadow && !l.auto) reasons.push(l.title + ' has a trader not in Shadow: ' + (l.notShadowIds || []).join(', '));
  for (const l of busy) if (l.auto && !l.armable) reasons.push(l.title + ' is in Auto but not ready (' + l.why + ')');
  for (const l of ready) if (!l.auto && l.mode === 'shadow' && busy.length) reasons.push(l.title + ' is not in Auto');
  if (out.length) reasons.push('Not a lane, so not armed from here: ' + (Array.isArray(out.words) && out.words.length === out.length ? out.words : out).join('; ') + ' in Auto (a click sends it to Shadow; or Praetorian, the Agent tab until Praetorian merges)');
  const state = !busy.length && !out.length ? 'off' : !reasons.length && ready.length && ready.every(l => l.auto) ? 'on' : 'partly';
  const why = !kill.ok ? kill.why : !atLeast(version, PICK_MIN) ? 'Armed needs ChartBridge ' + PICK_MIN + ' or later (this one is ' + (version || 'not known') + ')'
    : !ready.length ? 'No lane is ready: ' + ls.map(l => l.title + ': ' + l.why).join(' ') : '';
  return { state, text: state === 'on' ? 'Armed: ON' : state === 'partly' ? 'Armed: PARTLY' : 'Armed: off', can: !why, canOff: true, why, reasons, outside: out };
}
/** The messages one use of the switch sends, built by AgentCore.modeMsg. on: every ready lane not yet in Auto goes to Auto,
 *  naming its pick and that file's sha256 (the review of 93, FIX 2). Off: every trader of every lane that is not in Shadow,
 *  and every trader in Auto outside the lanes, goes to Shadow. */
/** True when the page's mode rules (agent-core.js) are loaded, so Armed can build a message at all (the re-review of 94, N5). */
const modeRulesLoaded = () => !!(AGC && typeof AGC.modeMsg === 'function');
function armMsgs(ls, on, agents, cidFn, outside) {
  const out = [], mk = (agent, mode) => { const c = cidFn ? cidFn() : ''; const m = AGC && typeof AGC.modeMsg === 'function' ? AGC.modeMsg(agent, mode, c || undefined) : null; if (m) out.push(m); return m; };
  if (on) {
    for (const l of ls) if (l.armable && l.mode !== 'auto' && ID_RX.test(l.id) && FILE_RX.test(l.pick) && SHA_RX.test(l.sha)) { const m = mk(l.id, 'auto'); if (m) { m.pick = l.pick; m.pickSha = l.sha; } }
    return out;
  }
  const modes = new Map((Array.isArray(agents) ? agents : []).filter(a => plainObj(a) && typeof a.agent === 'string').map(a => [a.agent, a.mode]));
  const ids = [].concat.apply([], ls.map(l => l.traders)).concat(Array.isArray(outside) ? outside : []);
  for (const id of ids.filter((x, i) => ids.indexOf(x) === i)) if (ID_RX.test(id) && modes.get(id) !== 'shadow') mk(id, 'shadow');
  return out;
}
/** What switching on would do, in words, for the question: each lane, its bot, its trading accounts, or why it stays off. */
function armWords(ls) {
  return ls.map(l => (l.armable ? l.title + ': ' + l.name + ' goes to Auto and trades ' + l.pickText + ' on ' + one(l.seats.length, l.sim ? 'Sim account' : 'account') + (!l.sim && l.simCount ? ', ' + l.simCount + ' Sim' : '') + (l.sim ? ' (Kill all does not reach Sim accounts: Armed off does)' : '') + (l.benched.length ? ' (' + one(l.benched.length, 'account') + ' on the bench sit' + (l.benched.length === 1 ? 's' : '') + ' out)' : '') + (l.connected ? '' : ' (its runner is not connected: nothing trades there until it is)')
    : l.title + ': stays off (' + l.why + ')') + '.').join(' ');
}
/** The files a lane can pick: every card that runs live, lineups first. -> [{ file, text }] */
function pickChoices(cards) {
  if (!cards || !cards.ok) return [];
  return cards.lineups.concat(cards.bots).filter(c => c.runsLive && FILE_RX.test(c.file)).slice(0, MAX_CARDS)
    .map(c => ({ file: c.file, text: cardText(c) }));
}
/** The files the pick list does not offer because they do not run live, each with its card's own why_not (answers of
 *  2026-11-13 02:00 UTC: a sweep build says "runs live after 10 matching nights (n so far)" on the lane cards). At most
 *  `max` are listed; .more counts the rest. -> [{ file, text, why }] */
function waitingChoices(cards, max) {
  if (!cards || !cards.ok) { const none = []; none.more = 0; return none; }
  const all = cards.lineups.concat(cards.bots).filter(c => !c.runsLive && FILE_RX.test(c.file));
  const n = isNum(max) && max >= 0 ? max : 5;
  const out = all.slice(0, n).map(c => ({ file: c.file, text: cardText(c), why: str(c.whyNot, 300) || 'the file says it does not run live' }));
  out.more = Math.max(0, all.length - n);
  return out;
}
/** agentPick: a served file's name, or null for none. null when the id or the name is not one ChartBridge takes. */
function pickMsg(agent, file, cid) {
  if (!ID_RX.test(String(agent || '')) || !(file === null || (typeof file === 'string' && FILE_RX.test(file)))) return null;
  return Object.assign({ type: 'agentPick' }, cid ? { cid } : {}, { agent, file });
}
/**
 * THE GATE on the tab's connection (workspace.js calls it before every post; N5 of the review of 92): the three messages the
 * tab may send, each with exactly its keys, and nothing else. A mode other than Auto or Shadow, a kill switch, an account
 * change, an order: never.
 */
function maySend(m) {
  if (!plainObj(m)) return false;
  const keys = Object.keys(m), only = allowed => keys.every(k => allowed.includes(k));
  const cidOk = !own(m, 'cid') || (typeof m.cid === 'string' && m.cid.length > 0 && m.cid.length <= 40);
  if (!cidOk) return false;
  if (m.type === 'agentKillAllProp') return only(['type', 'cid']);
  if (m.type === 'agentPick') return only(['type', 'cid', 'agent', 'file']) && own(m, 'file') && typeof m.agent === 'string' && ID_RX.test(m.agent) && (m.file === null || (typeof m.file === 'string' && FILE_RX.test(m.file)));
  if (m.type === 'agentMode') {
    if (!(typeof m.agent === 'string' && ID_RX.test(m.agent))) return false;
    if (m.mode === 'shadow') return only(['type', 'cid', 'agent', 'mode']);
    /* Auto names the pick and its file's sha256 (the review of 93, FIX 2). Legion arms only a lane with a pick, so the gate
       refuses a bare Auto outright (the re-review of 94, N4): a trader with a pick is never armed from here without it */
    if (m.mode === 'auto') return only(['type', 'cid', 'agent', 'mode', 'pick', 'pickSha']) && typeof m.pick === 'string' && FILE_RX.test(m.pick) &&
      typeof m.pickSha === 'string' && SHA_RX.test(m.pickSha);
    return false;
  }
  return false;
}

/* ---------------------------------------------------------------- the roster by family (Legion Setup, chart 1.48.0) */
/** A bot's readable name from its file's own name (Anthony 2026-11-12: the whole name, the family capitalised, so two
 *  settings never read the same): "germanicus_r75_cap_off_v1" -> "Germanicus r75 cap off v1". */
function readableName(name) {
  const parts = String(name || '').replace(/\.json$/, '').split(/[_-]+/).filter(Boolean);
  if (!parts.length) return '';
  return [parts[0].charAt(0).toUpperCase() + parts[0].slice(1)].concat(parts.slice(1)).join(' ').slice(0, 80);
}
const FILTERS = ['all', 'evals', 'funded'];
/**
 * The roster as one line a FAMILY with its settings inside (Legion Setup). cards: rosterCards()'s result; ls: lanes();
 * filter: 'all' | 'evals' | 'funded'; find: text. A bot's family is its run's family (record.family), else the first word of
 * its name; a lineup is a family of its own. One number a setting: profit per $1 with its range (the eval stage's; a file
 * whose two stages differ says so in Details). The two "good for" filters use only the file's own word (Anthony 2026-11-12):
 * a setting that runs live and that the file marks above no edge for that stage, sorted by its eval pass share or by the
 * dollars paid per funded account. No threshold is set on the page. -> { families: [...], total, shown }
 */
function rosterFamilies(cards, ls, filter, find) {
  const out = { families: [], total: 0, shown: 0 };
  if (!cards || !cards.ok) return out;
  const f = FILTERS.includes(filter) ? filter : 'all', q = String(find || '').trim().toLowerCase();
  const where = new Map();
  for (const l of Array.isArray(ls) ? ls : []) if (l && l.pick) where.set(l.pick, (where.get(l.pick) || []).concat(l.title));
  const fams = new Map();
  for (const c of cards.lineups.concat(cards.bots)) {
    const famKey = c.kind === 'lineup' ? 'lineup:' + c.name : 'bot:' + (c.family || String(c.name).split(/[_-]/)[0]).toLowerCase();
    const ev = c.stages[0], fu = c.stages[1];
    const row = { card: c, file: c.file, name: c.name, readable: readableName(c.name), display: c.displayName || '', kind: c.kind, runsLive: c.runsLive,
      ppd: ev.profitPerDollar, range: ev.range, stagesDiffer: ev.profitPerDollar !== fu.profitPerDollar, evalPass: ev.evalPass, paid: fu.paidPerFunded,
      riskEval: ev.risk, riskFunded: fu.risk, aboveEval: ev.aboveNoEdge, aboveFunded: fu.aboveNoEdge,
      where: (where.get(c.file) || []).join(' and '),
      standing: c.kind === 'lineup' ? c.joinedText : (c.trades === null ? 'trades not known' : one(c.trades, 'trade')) + ', ' + (c.sessions === null ? 'sessions not known' : one(c.sessions, 'session')),
      evidence: c.evidenceText };
    if (!fams.has(famKey)) fams.set(famKey, { key: famKey, kind: c.kind, name: c.kind === 'lineup' ? readableName(c.name) : readableName(famKey.slice(4)), settings: [] });
    fams.get(famKey).settings.push(row);
    out.total++;
  }
  for (const fam of fams.values()) {
    let list = fam.settings;
    if (f === 'evals') list = list.filter(r => r.runsLive && r.aboveEval).sort((a, b) => b.evalPass - a.evalPass);
    else if (f === 'funded') list = list.filter(r => r.runsLive && r.aboveFunded).sort((a, b) => b.paid - a.paid);
    else list = list.slice().sort((a, b) => b.ppd - a.ppd);
    if (q) list = list.filter(r => (r.display + ' ' + r.readable + ' ' + fam.name + ' ' + r.file).toLowerCase().includes(q));
    if (!list.length) continue;
    out.shown += list.length;
    out.families.push({ key: fam.key, kind: fam.kind, name: fam.name, settings: list, count: fam.settings.length,
      best: Math.max.apply(null, list.map(r => r.ppd)), bestPass: Math.max.apply(null, list.map(r => (isNum(r.evalPass) ? r.evalPass : -1))),
      bestPaid: Math.max.apply(null, list.map(r => (isNum(r.paid) ? r.paid : -1))),
      where: list.filter(r => r.where).map(r => (r.display || r.readable) + ': ' + r.where).join('; ') });
  }
  const by = f === 'evals' ? (a, b) => b.bestPass - a.bestPass : f === 'funded' ? (a, b) => b.bestPaid - a.bestPaid : (a, b) => b.best - a.best;
  out.families.sort(by);
  return out;
}

/* ---------------------------------------------------------------- a lane's own Multi-Account panel (1.47.0, the reuse map) */
/**
 * Why no account may move into, out of or within a lane now ('' when moves are free): the lane's trader is in Auto, is not
 * known to be in Shadow, or holds a position, a working entry or a proposal (in Shadow it has no proposal). The conditions
 * under which ChartBridge 0.6.21 refuses a new pick. ChartBridge itself does NOT refuse accountGroup or memberBench for
 * these (it refuses a bench only while that one account is not flat), so this is the page's rule until ChartBridge has it.
 * NOT KNOWN IS LOCKED (the review of 97, F1; the tab's PROP 5): heard is the caller's word that ChartBridge's groups and its
 * traders have been heard on this connection. Before that, or with no lane, every move is refused ("not known yet"); a lane
 * with no trader is free only once heard. A proposal exists only in Copilot, so "not in Shadow" covers it (F5).
 */
const NOT_KNOWN = 'Not known yet: ChartBridge has not said this lane\'s traders and groups on this connection, so no account moves.';
/** The same lock, when the cause is a trader the page cannot read (answers 34, A33-2): it starts the same way, so it is locked
 *  wherever NOT_KNOWN is. */
const NOT_READABLE = 'Not known yet: a trader on this connection could not be read: the lane stays locked until it can.';
function laneLock(l, heard) {
  if (heard !== true || !plainObj(l) || !Array.isArray(l.traders)) return NOT_KNOWN;
  if (!l.traders.length) return '';
  if (l.traders.length > 1) return 'Two traders are on this lane\'s groups: no account moves here until one is taken off (the Agent tab).';
  if (l.auto || l.mode === 'auto') return 'The lane is in Auto: switch Armed off before an account moves.';
  if (l.exposed) return 'The lane\'s trader holds a position or a working entry: an account moves once it is flat.';
  if (l.mode !== 'shadow') return 'The lane\'s trader is not in Shadow (' + (l.modeText || 'not known') + '): an account moves only while it is.';
  return '';
}
/**
 * ANY GROUP'S LOCK (answers 25, S2; answers 26, R3-4; answers 28, R4-1 and R4-2): may an account be taken out of group gid now?
 * - Not heard yet, a group ChartBridge does not list with its members (groupsMsg), or ANY heard trader whose accounts the page
 *   cannot read (accountsReadable): NOT_KNOWN, which is locked.
 * - A trader seated directly on one of the group's accounts (its account, or a seat left over, not as that group's own trader):
 *   locked in ANY mode, Shadow and flat included (two drivers on one account are never one click away).
 * - The group's own traders keep S2's rule: free only with none, or its one trader in Shadow holding nothing.
 * Every reason names the trader.
 */
function groupLock(gid, list, heard, groupsMsg) {
  if (heard !== true || !Array.isArray(list)) return NOT_KNOWN;
  if (typeof gid !== 'string' || !gid) return NOT_KNOWN;
  const g = plainObj(groupsMsg) && Array.isArray(groupsMsg.list) ? groupsMsg.list.find(x => plainObj(x) && x.id === gid) : null;
  if (!g || !Array.isArray(g.members)) return NOT_KNOWN;
  if (list.some(a => !accountsReadable(a))) return NOT_READABLE;
  const members = new Set(g.members.filter(m => typeof m === 'string').map(m => m.toLowerCase()));
  const name = a => str(a.agent, 40) || 'a trader';
  const onIt = a => plainObj(a.group) && a.group.id === gid;
  const direct = list.filter(a => !onIt(a) && traderAccounts(a).some(n => members.has(n.toLowerCase())));
  if (direct.length) return direct.map(name).join(', ') + (direct.length > 1 ? ' are' : ' is') + ' seated on an account of that group: no account moves out of it while another trader is on one of its accounts, in any mode.';
  const on = list.filter(onIt);
  if (!on.length) return '';
  if (on.length > 1) return 'Two traders are on that group (' + on.map(name).join(', ') + '): no account moves out of it until one is taken off (the Agent tab).';
  const a = on[0];
  if (a.mode !== 'shadow') return name(a) + ' trades that group in ' + (own(MODE_NAME, a.mode) ? MODE_NAME[a.mode] : 'a mode not known') + ': an account moves out of it only while it is in Shadow.';
  if (a.owns === true) return name(a) + ' holds a position or a working entry on that group: an account moves out of it once it is flat.';
  return '';
}
/** The one message a lane's panel may post itself: memberBench with exactly its keys. (Its join goes through accountGroup.) */
function laneMaySend(m) {
  if (!plainObj(m) || m.type !== 'memberBench') return false;
  return Object.keys(m).every(k => ['type', 'cid', 'account', 'benched'].includes(k)) && typeof m.account === 'string' && m.account.length > 0 && m.account.length <= 60 &&
    typeof m.benched === 'boolean' && (!own(m, 'cid') || (typeof m.cid === 'string' && m.cid.length > 0 && m.cid.length <= 40));
}
/**
 * THE NARROW FEED a lane's Multi-Account panel is handed in place of the page's whole feed (build answers 18, points 1 to 3).
 * It passes what the panel reads (S, joinRefusal, joinPlan, joinWords) and two sends: post() for memberBench only, and
 * accountGroup() (a join with its question's answers, or a removal). Every other send is refused and its name kept in
 * `refused`: a group cannot be renamed, retyped, re-risked or deleted from inside a lane, and nothing else of the feed
 * (send, sendOrder, the copier, limits) is there at all. locked(): '' or why no move goes out now; with a reason both sends
 * are refused here too, whatever the panel shows.
 * BOUND TO ITS LANE (the review of 97, F2): groupId is the lane's group. accountGroup goes only INTO that group (for an account the
 * feed's S shows in no group, in that group, or in another group whose own lock, otherLocked(gid), is free: ChartBridge moves an
 * account straight out of its group) or OUT of it (group null, for a member of it); memberBench only for a member of it.
 * Anything else is refused by name. With no locked function, no group id, or groups not known, everything is refused.
 * The account's group is the page's copy: a move made in another window a moment before can still race (ChartBridge's gap,
 * docs/BACKLOG_review.md beside N12).
 */
function laneFeed(feed, locked, groupId, otherLocked) {
  const ask = fn => { try { const w = typeof fn === 'function' ? fn() : null; return typeof w === 'string' ? w : 'not known'; } catch (e) { return 'not known'; } };
  const refused = [], why = () => (typeof groupId === 'string' && groupId ? ask(locked) : 'no lane group');
  /* the account's group on the page's copy: an id, null (none), or undefined (the groups are not known) */
  const groupOf = name => {
    const gs = feed && feed.S && Array.isArray(feed.S.groups) ? feed.S.groups : null;
    if (!gs) return undefined;
    if (typeof name !== 'string' || !name) return undefined;
    const lc = name.toLowerCase();                       // ChartBridge matches names ignoring case (answers 28, R4-4)
    const hits = gs.filter(x => plainObj(x) && Array.isArray(x.members) && x.members.some(m => typeof m === 'string' && m.toLowerCase() === lc));
    if (hits.length > 1) return undefined;               // answers 33, A28-2: two groups match ignoring case: not known, refused
    return hits.length ? String(hits[0].id) : null;
  };
  const joinOk = name => {
    const cur = groupOf(name);
    if (cur === undefined) return false;
    if (cur === null || cur === groupId) return true;
    return ask(typeof otherLocked === 'function' ? () => otherLocked(cur) : null) === '';   // taking it from another group: that lane's lock too
  };
  const no = name => { refused.push(String(name)); if (refused.length > 50) refused.shift(); return false; };
  const out = {
    get S() { return feed.S; },
    joinRefusal: (name, g) => feed.joinRefusal(name, g),
    joinPlan: (name, g, acc) => feed.joinPlan(name, g, acc),
    joinWords: j => feed.joinWords(j),
    post: m => (laneMaySend(m) && !why() && groupOf(m.account) === groupId ? feed.post(m) === true : no(plainObj(m) && typeof m.type === 'string' ? m.type : 'not a message')),
    accountGroup: (name, group, highText, rules, useCid) => (typeof name === 'string' && name && !why() &&
      ((group === null && groupOf(name) === groupId) || (group === groupId && joinOk(name))) ? feed.accountGroup(name, group, highText, rules, useCid) === true : no('accountGroup')),
    refused,
  };
  return Object.freeze(out);
}

/* ---------------------------------------------------------------- Legion Live (chart 1.49.0, the reuse map's Live page) */
const LANE_COLOR = { eval: '#8FB4E0', funded: '#C9A55C' };            // eval steel blue, funded gold (build answers 16); the letter says it too
const LANE_LETTER = { eval: 'E', funded: 'F' };
const MAX_FILLS = 4000;
/** The accounts message's prop rows, by name (lower case) -> row. A row ChartBridge does not mark prop is never counted. */
function propRows(accounts) {
  const out = new Map();
  for (const r of plainObj(accounts) && Array.isArray(accounts.list) ? accounts.list : []) if (plainObj(r) && r.prop === true && typeof r.name === 'string' && r.name) out.set(r.name.toLowerCase(), r);
  return out;
}
/** Today's result of a list of account names: { value, known, of } from each row's pnlToday (realized plus open, ChartBridge's).
 *  value null when one is not known (an account not in the message, or no number): never a sum of the ones that are. */
function todayOf(names, accounts) {
  const rows = propRows(accounts), list = Array.isArray(names) ? names.filter(n => typeof n === 'string' && n) : [];
  let sum = 0, known = 0;
  for (const n of list) { const r = rows.get(n.toLowerCase()); if (r && isNum(r.pnlToday)) { sum += r.pnlToday; known++; } }
  return { value: list.length && known === list.length ? Math.round(sum * 100) / 100 : null, known, of: list.length };
}
/**
 * THE FOUR TILES: today on every prop account, on the eval lane, on the funded lane, and the business so far.
 * -> [{ key, title, value (dollars or null), text (what the number is, or why there is none) }]. The business so far needs The
 * Desk (payouts, fees); Legion does not read it yet, and the tile says so instead of a number.
 */
function liveTiles(ls, accounts) {
  const tile = (key, title, t, none) => ({ key, title, value: t.value, text: t.of === 0 ? none : t.value === null ? 'not known: ' + t.known + ' of ' + t.of + ' accounts say today' : one(t.of, 'account') + ', realized plus open' });
  const all = [...propRows(accounts).values()].map(r => r.name);
  const out = [tile('all', 'Today, every prop account', todayOf(all, accounts), plainObj(accounts) ? 'no prop account' : 'the accounts are not known yet')];
  for (const stage of STAGES) {
    const l = (Array.isArray(ls) ? ls : []).find(x => plainObj(x) && x.stage === stage);
    const names = l && l.id ? l.seats : [];
    out.push(tile(stage, stage === 'eval' ? 'Today, the eval lane' : 'Today, the funded lane', todayOf(names, accounts), l && l.id ? 'no account trades with its group' : 'no trader on this lane'));
  }
  out.push({ key: 'business', title: 'The business so far', value: null, text: 'not built yet: it needs The Desk (the payouts and the fees), which Legion does not read yet' });
  return out;
}
/** A fill as ChartBridge's exec sends it, cleaned, or null. */
function cleanFill(f) {
  if (!plainObj(f) || typeof f.id !== 'string' || !f.id || typeof f.account !== 'string' || !f.account) return null;
  if (f.side !== 'buy' && f.side !== 'sell') return null;
  if (!isNum(f.qty) || f.qty <= 0 || !Number.isInteger(f.qty) || !isNum(f.p) || f.p <= 0 || !isNum(f.t)) return null;
  return { id: str(f.id, 80), account: str(f.account, 60), root: str(f.root, 12), side: f.side, qty: f.qty, p: f.p, t: f.t };
}
/**
 * EACH LANE'S MARKS on the one chart (LeagueOverlay.attach's { kind: 'marks' }): every fill since `since` (chart seconds) on an
 * account of the lane's group (trading or on the bench), in time order, per account and market: a fill that opens or adds is
 * an entry (a circle), one that reduces or closes is an exit (a diamond); a fill that turns a position over is an exit. The
 * colour and letter are the lane's (E eval blue, F funded gold). roots: the markets drawn on this chart (MNQ and NQ share a
 * price). Lines (stop, target) are not drawn: the page does not hold a lane's planned stop; ChartBridge's own is on the
 * account. -> { kind: 'marks', marks, lines: [] }
 */
function laneMarks(ls, fills, since, roots) {
  const want = new Set((Array.isArray(roots) ? roots : []).map(r => String(r).toUpperCase()));
  const owner = new Map();
  for (const l of Array.isArray(ls) ? ls : []) {
    if (!plainObj(l) || !l.id || !STAGES.includes(l.stage)) continue;
    for (const n of [].concat(l.seats || [], l.benched || [])) if (typeof n === 'string' && n) owner.set(n.toLowerCase(), l.stage);
  }
  const list = (Array.isArray(fills) ? fills : []).map(cleanFill).filter(f => f && owner.has(f.account.toLowerCase()) && (!isNum(since) || f.t >= since));
  list.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const pos = new Map(), marks = [];
  for (const f of list) {
    const k = f.account.toLowerCase() + '|' + f.root, before = pos.get(k) || 0, d = f.side === 'buy' ? f.qty : -f.qty, after = before + d;
    pos.set(k, after);
    if (want.size && !want.has(f.root.toUpperCase())) continue;
    const opens = before === 0 || (Math.sign(after) === Math.sign(before) && Math.abs(after) > Math.abs(before));
    const stage = owner.get(f.account.toLowerCase());
    marks.push({ kind: opens ? 'entry' : 'exit', t: f.t, price: f.p, color: LANE_COLOR[stage], letter: LANE_LETTER[stage] });
  }
  return { kind: 'marks', marks: marks.slice(-2000), lines: [] };
}
/**
 * BY TRADER: one row a lane's trader. -> [{ stage, id, name, mode, today (dollars or null), trades (ChartBridge's count today, or
 * null), inTrade (true, false, or null when ChartBridge did not say), record }]. record: the trader's live record against its
 * test: The Desk's, not read by Legion yet, so it says so; never a number made up here.
 */
function traderDays(ls, agents, accounts) {
  const rows = [];
  for (const l of Array.isArray(ls) ? ls : []) {
    if (!plainObj(l) || !l.id) continue;
    const a = (Array.isArray(agents) ? agents : []).find(x => plainObj(x) && x.agent === l.id) || {};
    const t = todayOf(l.seats, accounts);
    rows.push({ stage: l.stage, id: l.id, name: l.name, mode: l.modeText, today: t.value, trades: isNum(a.trades) && a.trades >= 0 ? Math.floor(a.trades) : null,
      inTrade: a.owns === true ? true : a.owns === false ? false : null, record: 'not enough data yet: the live record against its test comes from The Desk, which Legion does not read yet' });
  }
  return rows;
}

/**
 * A LANE'S RUNNER (B4, chart 1.48.1). Bot-Lab's PC helper (manrae/helper.py, "lanes" in its helper.json) keeps each lane's
 * spec runner running; Legion only READS its GET /status (o.helperStatus: the AgentHelper client's status call and nothing
 * else, so no On or Off can leave this tab; the helper refuses both for a lane's id anyway). help: { reach, body } as
 * AgentHelper's client answers, or null before the first answer. -> { text, tone: 'ok' | 'warn' | 'bad' | 'mut', stops }.
 * Not known is said as not known, never as running.
 */
function laneRunner(l, help) {
  if (!plainObj(l) || !l.id) return { text: '', tone: 'mut', stops: 0 };
  if (!plainObj(help)) return { text: 'Its runner: the PC helper has not answered yet.', tone: 'mut', stops: 0 };
  if (help.reach === 'locked') return { text: 'Its runner: the PC helper needs this page unlocked with the PIN to say.', tone: 'warn', stops: 0 };
  if (help.reach !== 'ok' || !plainObj(help.body) || !plainObj(help.body.agents)) return { text: 'Its runner is not known: the PC helper is not answering (it starts with Windows; Bot-Lab\'s helper keeps the lanes\' runners).', tone: 'bad', stops: 0 };
  const row = help.body.agents[l.id];
  if (!plainObj(row) || !STAGES.includes(row.lane)) return { text: 'Its runner: the PC helper keeps no runner for ' + l.id + ' (helper.json "lanes" does not name it). Nothing trades in this lane until it does.', tone: 'bad', stops: 0 };
  if (row.lane !== l.stage) return { text: 'Its runner: the PC helper runs ' + l.id + ' as the ' + row.lane + ' lane, but its group is of Type ' + l.stage + '. The sizes would follow the wrong lane: put them in step (helper.json "lanes", or the group\'s Type).', tone: 'bad', stops: 0 };
  const n = typeof row.stops === 'number' && isFinite(row.stops) && row.stops >= 0 ? Math.floor(row.stops) : 0;
  const last = plainObj(row.lastStop) && typeof row.lastStop.why === 'string' ? str(row.lastStop.why, 160) : '';
  const stopped = n ? ' It stopped ' + (n === 1 ? 'once' : n + ' times') + ' this session' + (last ? ' (last: ' + last + ')' : '') + '.' : '';
  if (row.running === true) return { text: 'Its runner runs.' + stopped, tone: n ? 'warn' : 'ok', stops: n };
  const why = typeof row.why === 'string' && row.why ? str(row.why, 200) : 'no reason given';
  return { text: 'Its runner is not running: ' + why + '.' + stopped, tone: 'bad', stops: n };
}

/** Does ChartBridge's own answer to Kill all say something was not stopped? (PROP 1: then the tab marks it bad.) */
const badAnswer = text => /NOT STOPPED|FAILED|could NOT/.test(String(text || ''));
/** "09:41:07" of a Date (the PC's own clock), for the time in front of a Kill all answer. */
const clock = d => [d.getHours(), d.getMinutes(), d.getSeconds()].map(x => String(x).padStart(2, '0')).join(':');

return Object.freeze({ displayNameOk, shownName, cardText, LANE_KEEP_MIN, laneLogOf, hhmm, laneWord, LANE_HELP, one, laneAccounts, RULE_OWNED_WORDS, HAND_MIN, laneRuleOf, unassigned, modeRulesLoaded, NOT_KNOWN, NOT_READABLE, groupLock, accountsReadable, MAX_FILLS, LANE_COLOR, LANE_LETTER, propRows, todayOf, liveTiles, cleanFill, laneMarks, traderDays, laneRunner, readableName, rosterFamilies, FILTERS, laneLock, laneMaySend, laneFeed, PICK_MIN, STAGES, lanes, outsideAuto, armState, armMsgs, armWords, pickChoices, waitingChoices, pickMsg, maySend, KILL_MIN, SWITCH_MIN, DAYSTOP_MIN, ROSTER_MIN, ROSTER_FORMAT, LINEUP_FORMAT, CONFIRM_MS, ARM_MS, ANSWER_WAIT_MS, ROSTER_WAIT_MS, MAX_CARDS, MAX_MEMBERS, MAX_NOT_SHOWN, MODE_NAME, atLeast, usd, signed, stageCard, rosterCards, rosterProblem,
  kindOf, seatsKind, dayMark, traderAccounts, statusText, traders, propAccounts, killAllState, killAllMsg, autoLine, badAnswer, clock });
});

/* ================================================================================================ the tab (browser only) */
(function () {
'use strict';
if (typeof window === 'undefined' || typeof document === 'undefined') return;
const C = window.FleetCore;
const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HINT = 'Kill all stops every trader on a prop account and closes its position there whole, a contract you added by hand on that account and contract included. Your personal account, a trader on Sim accounts only, the bot and the copier are never touched.';

/*
 * HOW IT IS DRAWN (the review of 92, STOP 2). The head (Kill all, the question's two buttons, the two lines under them) is
 * built ONCE when the tab opens and kept: a message changes only its texts and attributes, so a click whose press and release
 * straddle a message still counts. The three sections under it (the roster, the traders, the prop accounts) are each drawn on
 * their own, each in its own try, and only when what they show changed; the roster only when the roster changed.
 *
 * THE QUESTION (STOP 1). A click on Kill all puts CANCEL in the button's own place (the same box, at every width) with Yes to
 * its left, where nothing was, and the question's words on their own line under the head. The head row never wraps.
 * No answer is taken for ARM_MS after it opens, so a double click anywhere on the button answers nothing: its second click
 * lands inside that moment, and on Cancel. A click on Yes inside that moment is not taken, leaves the question up and says so.
 * From ARM_MS on, a real click on Yes counts whatever its click count (the second look at 92, FIX B: a person clicking Yes
 * again and again must get through; the browser counts quick clicks on one spot as a double click). Yes counts only while the question is up and not older than CONFIRM_MS
 * by the clock (a held-back timer does not keep it alive), and everything is checked again at that moment.
 * Yes takes a REAL CLICK ONLY (Anthony 2026-11-11, the review's N10): never Enter, Space or a click made by a key. The test of
 * a real click is the page's one rule, OrderTicket.realClick, handed in by workspace.js (o.realClick), the same function the
 * group entry's Send calls; with none handed in, Yes is never taken. Cancel may be given by the keyboard, and Escape cancels.
 * Opening the question by keyboard is as it was.
 */
function create(o) {
  o = o || {};
  const view = o.view || null, tabBtn = o.tab || null, V3 = o.v3 || null;
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const realClick = typeof o.realClick === 'function' ? o.realClick : () => false;      // none handed in: Yes is never taken
  const S = { shown: false, built: false, version: '', connected: false, signedIn: false, accounts: null, groups: null, agents: new Map(), firstAgentAt: null, signInAt: null, replayDone: false, settleTimer: 0,
    ask: 0, askTimer: 0, hint: '', hintBad: false, hintState: false, answer: '', answerBad: false, cidSeq: 0, pending: '', pendingAt: 0, waitTimer: 0, sent: 0,
    armAsk: 0, armTimer: 0, armSaid: '', armBad: false, modeSent: new Map(), pickSent: new Map(),
    helper: null, helperTimer: 0, helperSeq: 0, sub: 'setup', filter: 'all', find: '', famShut: new Set(), laneHelp: new Set(), laneAccts: new Set(), laneAdd: new Set(), acctSaid: new Set(), removeAsk: '', unSaid: null, unAsk: '', lanePanels: {}, desk: null, deskOpen: false, deskSent: null,
    roster: { state: 'idle', text: '', cards: null, seq: 0, asked: 0, at: 0, version: '' }, rosterDirty: true, rosterTimer: 0, open: new Set(), drawn: {}, draws: { head: 0, roster: 0, traders: 0, accounts: 0, lanes: 0, 'lane-eval': 0, 'lane-funded': 0, 'lane-unassigned': 0, tiles: 0, bytrader: 0 },
    fills: new Map(), pane: null, overlay: null, rows: null };
  const el = {};
  const agentList = () => [...S.agents.values()];
  const cid = () => 'fl' + (++S.cidSeq).toString(36) + Math.random().toString(36).slice(2, 6);
  const killState = () => C.killAllState(S.version, S.accounts, S.signedIn, S.connected);
  const laneList = () => C.lanes(agentList(), S.groups, S.accounts, S.version, S.roster.cards);
  const outside = ls => C.outsideAuto(ls, agentList(), S.accounts, S.version);
  /* "Heard" (the re-review of 94, N1, and its S1; answers 25). At sign-in ChartBridge replays every trader, one after another,
     and then sends agentStandDowns (ChartBridgeAgents.AfterAuth, 0.6.21). Every trader is heard only when that message has
     come for the LATEST sign-in AND SETTLE_MS have passed since the first trader of that sign-in (or since the sign-in, when
     none came): a stand-down list broadcast in the middle of a replay is rare but possible, the floor covers it. Until both,
     "not known", which is locked. A sign-in or a sign-out (a change of trading.enabled; ChartBridge sends trading again on
     every checkmark change, which is not a new sign-in) and a dropped connection forget the traders and start again; nothing
     is heard while signed out. o.settleMs: the tests' clock. */
  const SETTLE_MS = typeof o.settleMs === 'number' && o.settleMs >= 0 ? o.settleMs : 1500;
  const settleFrom = () => (S.firstAgentAt !== null ? S.firstAgentAt : S.signInAt);
  const heardAll = () => S.connected && S.signedIn && S.replayDone && settleFrom() !== null && now() - settleFrom() >= SETTLE_MS;
  /* a render at the moment "heard" can turn true (the message came before the floor ran out) */
  function settleSoon() {
    clearTimeout(S.settleTimer); S.settleTimer = 0;
    if (!S.replayDone || settleFrom() === null) return;
    const left = SETTLE_MS - (now() - settleFrom());
    if (left > 0) S.settleTimer = setTimeout(() => { if (S.shown) render(); }, left + 10);
  }
  /* a sign-in or a sign-out: what was heard of the traders is forgotten; ChartBridge replays them after a sign-in */
  function newSignIn() {
    S.agents.clear(); S.firstAgentAt = null; S.replayDone = false; S.signInAt = S.signedIn ? now() : null;
    clearTimeout(S.settleTimer); S.settleTimer = 0;
  }
  // ChartBridge's groups heard, and the traders settled after sign-in (the re-review of 94, N1, and answers 25, S1:
  // ChartBridge's end of the sign-in replay plus the floor, never while signed out), for the lane locks too
  const heard = () => !!S.groups && heardAll();
  const armNow = ls => C.armState(ls, S.version, S.signedIn, S.connected, S.accounts, S.groups, heardAll(), outside(ls));

  function takeFill(f) {
    const c = C.cleanFill(f);
    if (!c) return;
    S.fills.set(c.account + '|' + c.id, c);                            // the same fill twice (execs then exec) is one
    if (S.fills.size > 4000) S.fills.delete(S.fills.keys().next().value);
    if (S.overlay) S.overlay.redraw();
  }
  const marksNow = () => { try { return C.laneMarks(laneList(), [...S.fills.values()], typeof o.sessionStart === 'function' ? o.sessionStart() : null, ['MNQ', 'NQ']); } catch (e) { return null; } };
  /* the Live page's chart and the accounts' rows: mounted while the tab is open on Live, taken down otherwise */
  function mountLive() {
    if (!S.pane && typeof o.liveChart === 'function' && el.chart) {
      try { S.pane = o.liveChart(el.chart); } catch (e) { S.pane = null; }
      if (S.pane && window.LeagueOverlay && typeof window.LeagueOverlay.attach === 'function') S.overlay = window.LeagueOverlay.attach(S.pane, el.chart, marksNow, () => 'MNQ', false);
    }
    if (!S.rows && typeof o.accountRows === 'function' && el.acctrows) {
      try { S.rows = o.accountRows(el.acctrows, 'legion-live', a => !!a && typeof a.name === 'string' && C.propRows(S.accounts).has(a.name.toLowerCase())); } catch (e) { S.rows = null; }
    }
  }
  function unmountLive() {
    if (S.overlay) { try { S.overlay.destroy(); } catch (e) { /* gone */ } S.overlay = null; }
    if (S.pane) { try { S.pane.destroy(); if (S.pane.indicators) S.pane.indicators.remove(); if (S.pane.chips) S.pane.chips.remove(); if (S.pane.badge) S.pane.badge.remove(); } catch (e) { /* gone */ } S.pane = null; }
    if (S.rows) { try { S.rows.destroy(); } catch (e) { /* gone */ } S.rows = null; }
    for (const k of ['chart', 'acctrows']) if (el[k] && el[k].innerHTML) el[k].innerHTML = '';   // nothing of them is left behind
  }
  function onMessage(m) {
    switch (m && m.type) {
      case 'hello': S.version = typeof m.version === 'string' ? m.version : ''; S.connected = true; offer(); if (S.shown) helloRoster(); break;
      case 'trading': { const was = S.signedIn; S.signedIn = !!m.enabled; if (S.signedIn !== was) newSignIn(); break; }
      case 'agentStandDowns': if (S.signedIn) { S.replayDone = true; settleSoon(); } break;   // after the sign-in replay (S1)
      case 'accounts': S.accounts = m; break;
      case 'groups': S.groups = m; break;
      case 'agent':
        if (m && typeof m.agent === 'string') {
          S.agents.set(m.agent, m);
          if (S.firstAgentAt === null) { S.firstAgentAt = now(); settleSoon(); }
        }
        break;
      case 'exec': takeFill(m); break;                                 // Legion Live: each lane's fills on the one chart
      case 'execs': if (m && Array.isArray(m.list)) for (const f of m.list.slice(0, C.MAX_FILLS || 4000)) takeFill(f); break;
      case 'reject':
        if (S.pending && m.cid === S.pending) answered(typeof m.reason === 'string' && m.reason ? 'ChartBridge refused Kill all: ' + m.reason : 'ChartBridge refused Kill all', true);
        else if (typeof m.cid === 'string' && S.modeSent.has(m.cid)) { const x = S.modeSent.get(m.cid); S.modeSent.delete(m.cid); armSay('ChartBridge refused ' + (x.mode === 'auto' ? 'Auto' : 'Shadow') + ' for ' + x.agent + (typeof m.reason === 'string' && m.reason ? ': ' + m.reason : ''), true); }
        else if (typeof m.cid === 'string' && S.pickSent.has(m.cid)) { const id = S.pickSent.get(m.cid); S.pickSent.delete(m.cid); armSay('ChartBridge refused the pick for ' + id + (typeof m.reason === 'string' && m.reason ? ': ' + m.reason : ''), true); S.drawn.lanes = null; }
        break;
      case 'status': if (typeof m.text === 'string' && /^Kill all \(prop accounts\)/.test(m.text)) answered(m.text, m.level === 'error' || C.badAnswer(m.text)); break;
      default: return;
    }
    if (S.hintState && killState().why !== S.hint) hint('', false);
    checkWait();
    if (S.shown) render();
  }
  /* the connection dropped: what ChartBridge said is forgotten; a Kill all sent and not answered is NOT (PROP 2) */
  function lost() {
    S.roster = { state: 'idle', text: '', cards: null, seq: S.roster.seq + 1, asked: S.roster.asked, at: 0, version: '' }; S.rosterDirty = true; clearTimeout(S.rosterTimer);
    S.connected = false; S.signedIn = false; S.agents.clear(); S.firstAgentAt = null; S.signInAt = null; S.replayDone = false; S.accounts = null; S.groups = null;
    clearTimeout(S.settleTimer); S.settleTimer = 0;
    endArmAsk(); S.modeSent.clear(); S.pickSent.clear(); S.armSaid = ''; S.armBad = false;
    if (S.pending) answered('Kill all was sent and ChartBridge\'s answer never came (the connection dropped): look in NinjaTrader now', true);
    hint('', false); endAsk();
    if (S.shown) render();
  }
  /* the tab button shows with a ChartBridge that has prop accounts (0.6.17: Kill all); never hidden under an open tab (N9) */
  function offer() { if (tabBtn) tabBtn.hidden = !C.atLeast(S.version, C.KILL_MIN) && !S.shown; }
  /* the line under the head: why Kill all is not offered (fromState: it goes as soon as that reason does), or nothing */
  function hint(text, bad, fromState) { S.hint = String(text || ''); S.hintBad = !!bad; S.hintState = !!fromState; }
  /* ChartBridge's own answer to Kill all (or that none came), with this PC's time in front; kept until the next one (PROP 1) */
  function answered(text, bad) { S.pending = ''; S.pendingAt = 0; clearTimeout(S.waitTimer); S.answer = C.clock(new Date(now())) + '  ' + String(text || ''); S.answerBad = !!bad; }
  /* a Kill all sent and not answered in ANSWER_WAIT_MS is said, marked bad; a late answer still replaces it (PROP 2) */
  function checkWait() {
    if (S.pending && S.pendingAt && now() - S.pendingAt >= C.ANSWER_WAIT_MS) {
      const keep = S.pending;
      answered('Kill all was sent and ChartBridge has not answered in ' + (C.ANSWER_WAIT_MS / 1000) + ' seconds: look in NinjaTrader now', true);
      S.pending = keep;                                     // still listening for the answer; pendingAt 0: said once
    }
  }
  function endAsk() { clearTimeout(S.askTimer); S.askTimer = 0; S.ask = 0; }
  function endArmAsk() { clearTimeout(S.armTimer); S.armTimer = 0; S.armAsk = 0; }
  /* the line beside the Armed switch: what was just sent, or ChartBridge's refusal (marked bad), with this PC's time in front */
  function armSay(text, bad) { S.armSaid = text ? C.clock(new Date(now())) + '  ' + String(text) : ''; S.armBad = !!bad; }
  const remember = (map, k, v) => { map.set(k, v); if (map.size > 50) map.delete(map.keys().next().value); };

  /* ---------------- the Armed switch and the pick (D2). The switch has no state: what it shows is read from ChartBridge's
     own `agent` messages each time. On: one agentMode auto for each ready lane not yet in Auto, after the question and a
     real click on Yes. Off: one agentMode shadow for every lane trader not in Shadow, at one click or key, no question
     (the safe direction is never held up). Everything is checked again at the moment it is sent. */
  function arm(on) {
    const ls = laneList(), st = armNow(ls);
    endArmAsk();
    if (on && !st.can) { armSay(st.why, true); render(); return; }
    if (!on && !st.canOff) { armSay(st.why, true); render(); return; }
    const msgs = C.armMsgs(ls, on, agentList(), cid, outside(ls));
    if (!msgs.length && !C.modeRulesLoaded()) { armSay('Armed cannot switch ' + (on ? 'on' : 'off') + ' from here: the page is incomplete (agent-core.js is not loaded). Use Kill all, or NinjaTrader.', true); render(); return; }
    if (!msgs.length) { armSay(on ? 'Every ready lane is already in Auto' : 'No lane\'s trader is in Auto or Copilot: nothing to switch off', false); render(); return; }
    let sent = 0;
    for (const m of msgs) { if (V3 && V3.post(m) === true) { sent++; remember(S.modeSent, m.cid, { agent: m.agent, mode: m.mode }); } }
    S.sent += sent;
    if (sent < msgs.length) armSay((on ? 'Auto' : 'Shadow') + ' could NOT be sent for ' + (msgs.length - sent) + ' of ' + msgs.length + ': ChartBridge is not connected.' + (on ? '' : ' Use Kill all, or NinjaTrader'), true);
    else armSay((on ? 'Sent Auto for ' : 'Sent Shadow for ') + msgs.map(m => m.agent).join(', ') + ': the switch shows what ChartBridge says next', false);
    render();
  }
  function pick(agent, file) {
    const l = laneList().find(x => x.id === agent);
    /* the review of 94, note 7: only None or a file the list offers is sent */
    const offered = file === null || C.pickChoices(S.roster.cards).some(c => c.file === file);
    const m = l && offered ? C.pickMsg(agent, file, cid()) : null;
    if (l) S.drawn['lane-' + l.stage] = null;             // the list goes back to what ChartBridge says until it says otherwise
    if (!m) { armSay('That pick cannot be sent' + (l && !offered ? ': the list does not offer it' : ''), true); render(); return; }
    if (l.auto) { armSay('The pick changes only while the lane is not in Auto: switch Armed off first', true); render(); return; }
    if (V3 && V3.post(m) === true) { S.sent++; remember(S.pickSent, m.cid, agent); armSay('Sent the pick for ' + l.title.toLowerCase() + ': ' + (file === null ? 'none' : file), false); }
    else armSay('The pick could NOT be sent: ChartBridge is not connected', true);
    render();
  }

  function killAll() {
    const st = killState();
    endAsk();
    if (!st.ok) { hint(st.why, true, true); render(); return; }
    const id = cid();
    S.sent++;
    const ok = !!V3 && V3.post(C.killAllMsg(id)) === true;
    if (ok) {
      S.pending = id; S.pendingAt = now();
      S.answer = C.clock(new Date(now())) + '  Kill all sent: waiting for ChartBridge\'s answer'; S.answerBad = false;
      clearTimeout(S.waitTimer);
      S.waitTimer = setTimeout(() => { checkWait(); if (S.shown) render(); }, C.ANSWER_WAIT_MS + 50);
    } else answered('Kill all could NOT be sent: ChartBridge is not connected. Look in NinjaTrader now', true);
    hint('', false);
    render();
  }

  /* ---------------- the roster: one GET /roster (ChartBridge 0.6.20), when the tab opens, when ChartBridge says hello while it
     is open, and on Read again. Never on a timer, never on any other message. Read only: nothing is sent about a file and
     nothing here decides from one. A late answer of an older ask is dropped; an ask not answered in ROSTER_WAIT_MS is given up. */
  function setRoster(r) { S.roster = r; S.rosterDirty = true; }
  /* the page hands the tab two hellos on a connect (the ticket's connection and the v3 one): the second asks nothing (N1) */
  function helloRoster() {
    const R = S.roster;
    if (R.state === 'loading' || (R.version === S.version && R.at && now() - R.at < 1000)) return;
    loadRoster();
  }
  function loadRoster() {
    const R = S.roster, doFetch = typeof o.fetch === 'function' ? o.fetch : typeof fetch === 'function' ? fetch : null;
    clearTimeout(S.rosterTimer);
    if (!S.connected) { setRoster({ state: 'idle', text: '', cards: null, seq: R.seq + 1, asked: R.asked, at: 0, version: '' }); render(); return; }
    if (!C.atLeast(S.version, C.ROSTER_MIN)) { setRoster({ state: 'old', text: 'The roster needs ChartBridge ' + C.ROSTER_MIN + ' or later (this one is ' + (S.version || 'not known') + ').', cards: null, seq: R.seq + 1, asked: R.asked, at: now(), version: S.version }); render(); return; }
    if (!doFetch) return;
    const seq = R.seq + 1, version = S.version;
    setRoster({ state: 'loading', text: '', cards: R.cards, seq, asked: R.asked + 1, at: 0, version });
    render();
    const done = (state, text, cards) => { if (S.roster.seq !== seq) return; clearTimeout(S.rosterTimer); setRoster({ state, text, cards: cards || null, seq: seq + 1, asked: S.roster.asked, at: now(), version }); if (S.shown) render(); };
    S.rosterTimer = setTimeout(() => done('error', C.rosterProblem('late')), C.ROSTER_WAIT_MS);
    const h = typeof o.headers === 'function' ? o.headers() : {};
    Promise.resolve().then(() => doFetch('/roster', { cache: 'no-store', headers: h || {} }))
      .then(r => {
        if (r.status === 200) return r.json().then(b => { const c = C.rosterCards(b); if (c.ok) done('ok', '', c); else done('error', c.why + '.'); }, () => done('error', C.rosterProblem('notjson')));
        if (r.status === 500) return r.json().then(b => b && b.error, () => '').then(e => done('error', C.rosterProblem(500, e)));
        done(r.status === 404 ? 'none' : 'error', C.rosterProblem(r.status));
      })
      .catch(() => done('error', C.rosterProblem(0)));
  }
  function stageHtml(st) {
    return `<div class="fl-stage" data-stage="${esc(st.stage)}"><div class="fl-trow"><span class="fl-stname">${esc(st.title)}</span><span class="fl-tag" data-kind="${st.aboveNoEdge ? 'edge' : 'noedge'}">${esc(st.edgeText)}</span></div>
      <p class="fl-line mono">${esc(st.profitText)}</p><p class="fl-line mono fl-mutline">${esc(st.noEdgeText)}</p>
      <p class="fl-line mono fl-mutline">${esc(st.heldBackText)}</p><p class="fl-line">${esc(st.stageText)}</p><p class="fl-line fl-mutline">${esc(st.playbookText)}</p></div>`;
  }
  function settingHtml(r) {
    const open = S.open.has(r.kind + ':' + r.name), c = r.card;
    const live = r.runsLive ? '' : '<span class="fl-tag" data-kind="notlive">Does not run live</span>';
    let more = '';
    if (open) {
      const shown = c.kind === 'lineup' ? c.bots.slice(0, C.MAX_MEMBERS) : [];
      const members = c.kind === 'lineup' ? `<ol class="fl-members">${shown.map(b => `<li><span class="fl-mname">${esc(C.readableName(b.name))}</span> <span class="fl-mut">took ${b.taken}, skipped ${b.skipped}${b.sessionsLeftOut ? ', ' + b.sessionsLeftOut + ' of its sessions left out' : ''}; ${esc(b.recordText)}</span></li>`).join('')}</ol>
          ${c.bots.length > shown.length ? `<p class="fl-line fl-mutline">And ${c.bots.length - shown.length} more bots in this lineup, not drawn.</p>` : ''}
          <p class="fl-line fl-mutline">${esc(c.joinedText)}. One playbook for the lineup; the bot listed first takes a tie.</p>` : `<p class="fl-line fl-mutline">${esc(c.recordText)}</p>${c.verdictText ? `<p class="fl-line fl-mutline fl-verdict">${esc(c.verdictText)}</p>` : ''}`;
      more = `<div class="fl-more">
        <p class="fl-line fl-mutline">File <span class="mono">${esc(c.file)}</span>, ${esc(c.planText)}. ${esc(r.evidence)}.</p>
        ${r.runsLive ? '' : `<p class="fl-line fl-warn">Why not: ${esc(c.whyNot)}</p>`}
        ${r.stagesDiffer ? '<p class="fl-line fl-warn">The file gives the eval and the funded stage different numbers; the line shows the eval stage\'s.</p>' : ''}
        ${members}
        <div class="fl-stages">${c.stages.map(stageHtml).join('')}</div>
      </div>`;
    }
    return `<li class="fl-set" data-kind="${r.kind}" data-name="${esc(r.name)}"${r.runsLive ? '' : ' data-tone="notlive"'}${open ? ' data-open="1"' : ''}>
      <div class="fl-srow"><span class="fl-sname">${r.display ? `${esc(r.display)}<span class="fl-built">${esc(r.readable)}</span>` : esc(r.readable)} <span class="fl-mut">risk ${esc(C.usd(r.riskEval))} eval, ${esc(C.usd(r.riskFunded))} funded${r.where ? ' · on the ' + esc(r.where) + ' today' : ''}</span>${live}${c.quick ? '<span class="fl-tag" data-kind="quick">Quick look: never traded</span>' : ''}</span>
        <span class="mono">${esc(C.signed(r.ppd))} <span class="fl-mut">(${esc(C.signed(r.range[0]))} to ${esc(C.signed(r.range[1]))})</span> <span class="fl-tag" data-kind="${r.aboveEval ? 'edge' : 'noedge'}">${r.aboveEval ? 'Above no edge' : 'Not above no edge'}</span></span>
        <span class="mono">${r.evalPass === null ? '' : esc(Math.round(r.evalPass * 1000) / 10 + '%')}</span>
        <span class="fl-mut">not built yet</span>
        <span class="fl-mut">${esc(r.standing)}; ${esc(r.evidence)}</span>
        <button type="button" class="fl-pill" data-do="more" data-card="${esc(r.kind + ':' + r.name)}" aria-expanded="${open}">${open ? 'Hide' : 'Details'}</button></div>
      ${more}
    </li>`;
  }
  function rosterHtml() {
    const R = S.roster, c = R.cards;
    let body;
    if (c && (c.bots.length || c.lineups.length || c.notShown.length)) {
      const all = C.rosterFamilies(c, laneList(), S.filter, S.find);
      const fams = all.families.slice(0, C.MAX_CARDS), not = c.notShown.slice(0, C.MAX_NOT_SHOWN);
      const head = '<div class="fl-srow fl-shead"><span>Family and setting</span><span>Profit per $1</span><span>Eval pass</span><span>In this zone</span><span>Standing</span><span></span></div>';
      const famHtml = f => {
        const open = !S.famShut.has(f.key) || !!S.find.trim();
        return `<li class="fl-fam" data-fam="${esc(f.key)}"${open ? ' data-open="1"' : ''}>
          <div class="fl-srow fl-famrow"><span class="fl-sname"><span class="fl-tname">${esc(f.name)}</span> <span class="fl-who" data-who="bot">${f.kind === 'lineup' ? 'LINEUP' : 'BOT'}</span> <span class="fl-mut">${esc(f.count + (f.count === 1 ? ' setting' : ' settings'))}${f.settings.length < f.count ? ', ' + f.settings.length + ' shown' : ''}${f.where ? ' · ' + esc(f.where) : ''}</span></span>
            <span class="mono">best ${esc(C.signed(f.best))}</span><span class="mono">${f.bestPass >= 0 ? esc(Math.round(f.bestPass * 1000) / 10 + '%') : ''}</span><span class="fl-mut">not built yet</span><span class="fl-mut">in-sample, not proven</span>
            <button type="button" class="fl-pill" data-do="fam" data-fam="${esc(f.key)}" aria-expanded="${open}">${open ? 'Close' : 'Open ' + f.settings.length}</button></div>
          ${open ? `<ul class="fl-sets">${f.settings.map(settingHtml).join('')}</ul>` : ''}
        </li>`;
      };
      body = (R.state === 'loading' ? '<p class="fl-empty">Reading the roster again...</p>' : '') +
        (fams.length ? `<div class="fl-scroll"><div class="fl-stable">${head}<ul class="fl-fams">${fams.map(famHtml).join('')}</ul></div></div>`
          : `<p class="fl-empty">${S.find.trim() || S.filter !== 'all' ? 'Nothing in the roster matches this filter.' : 'No roster file here can be shown.'}</p>`) +
        (all.families.length > fams.length ? `<p class="fl-note">${all.families.length - fams.length} more families not drawn.</p>` : '') +
        (not.length ? `<ul class="fl-notshown">${not.map(x => `<li><span class="mono">${esc(x.name)}</span>: not shown, ${esc(x.why)}</li>`).join('')}</ul>` : '') +
        (c.notShown.length > not.length ? `<p class="fl-note">And ${c.notShown.length - not.length} more files not shown.</p>` : '') +
        (c.left ? `<p class="fl-note">${c.left} more file${c.left === 1 ? '' : 's'} in the folder not read (ChartBridge reads 200 at most).</p>` : '');
    } else if (R.state === 'ok') body = '<p class="fl-empty">The roster folder on this PC is empty. A bot shows here once the Lab has built its roster file and Bot-Lab is installed on this PC.</p>';
    else if (R.state === 'loading') body = '<p class="fl-empty">Reading the roster...</p>';
    else if (R.state === 'idle') body = `<p class="fl-empty">${S.connected ? 'The roster is not read yet.' : 'ChartBridge is not connected.'}</p>`;
    else body = `<p class="fl-empty${R.state === 'error' ? ' fl-warn' : ''}">${esc(R.text)}</p>`;
    return body + `<p class="fl-note">Profit per $1 is profit per $1 spent on accounts, one number for the eval and its funded account together, with its range. Every number is from in-sample runs, and none is a promise. "No edge" is what the same trades would show with their edge taken out. The two "Good for" filters use only each file's own word. "In this zone" waits for Market now.</p>`;
  }

  function accountHtml(a) {
    const tone = a.today === null ? '' : a.today > 0 ? ' up' : a.today < 0 ? ' down' : '';
    return `<tr data-name="${esc(a.name)}"${a.done ? ' class="fl-done"' : ''}>
      <td><span class="fl-aname">${esc(a.name)}</span><span class="fl-mut">${esc(a.stageText)}${a.group ? ', ' + esc(a.group) : ''}</span>${a.sizeNote ? `<span class="fl-warn">${esc(a.sizeNote)}</span>` : ''}</td>
      <td class="mono">${esc(a.progressText)}</td>
      <td class="mono"${a.cushion === null && a.cushionWhy ? ` title="${esc(a.cushionWhy)}"` : ''}>${a.cushion === null ? 'not known' : esc(C.usd(a.cushion))}</td>
      <td class="mono fl-pnl${tone}">${a.today === null ? 'not known' : esc(C.usd(a.today, true))}</td>
      <td class="mono">${esc(a.markText)}${a.done ? ' <span class="fl-tag" data-kind="done">reached</span>' : ''}</td>
      <td>${esc(a.position)}${a.traders.length ? `<span class="fl-mut">${esc(a.traders.join(', '))}</span>` : '<span class="fl-mut">no trader on it</span>'}</td>
    </tr>`;
  }
  function accountsHtml(accts) {
    return `<h3 class="fl-h">Prop accounts</h3>
      ${accts.length ? `<div class="fl-scroll"><table class="fl-table"><thead><tr><th>Account</th><th>Progress</th><th>Cushion to floor</th><th>Today</th><th>Day stop</th><th>Status</th></tr></thead>
          <tbody>${accts.map(accountHtml).join('')}</tbody></table></div>`
        : `<p class="fl-empty">${!S.connected ? 'ChartBridge is not connected.' : S.accounts && S.accounts.personalNamed === true ? 'No prop account is connected.' : 'No personal account is picked yet, so no account is prop. Pick it once on the Accounts tab: an account\'s settings, This is my personal account.'}</p>`}
      <p class="fl-note">Today counts realized plus open. The mark shown is worked out on this page from the group's rules and the plan's value; ChartBridge's own mark is not sent to the page yet. The day stop is held by ChartBridge itself: reached while a trader holds something on the account, that trader is flattened and stops until 18:00 New York.</p>`;
  }

  /* built once for each time the tab opens; nothing in the head is ever replaced after that */
  function build() {
    view.innerHTML = `<div class="fl-wrap">
      <div class="fl-top"><div class="fl-head">
        <span class="fl-title">Legion</span>
        <span class="fl-fill"></span>
        <button type="button" class="ws-btn fl-kill fl-yes" data-do="yes" data-k="yes" hidden>Yes, kill all</button><button type="button" class="ws-btn fl-cancel" data-do="no" data-k="no" hidden>Cancel</button>
        <button type="button" class="ws-btn fl-kill" data-do="ask" data-k="kill">Kill all: flatten and stop</button>
      </div>
      <div class="fl-armrow">
        <button type="button" class="ws-btn fl-arm" data-do="arm" data-k="arm" role="switch" aria-checked="false" data-state="unknown">Armed: not known</button><button type="button" class="ws-btn fl-cancel" data-do="armno" data-k="armno" hidden>Cancel</button>
        <button type="button" class="ws-btn fl-armyes" data-do="armyes" data-k="armyes" hidden>Yes, arm</button>
        <span class="fl-armsaid" data-k="armsaid" role="status" aria-live="polite"></span>
      </div>
      <p class="fl-ask fl-armask" data-k="armask" role="alertdialog" aria-label="Armed" hidden></p>
      <p class="fl-ask" data-k="ask" role="alertdialog" aria-label="Kill all" hidden>Close every trader's position on the prop accounts and stop them? Yes, or Cancel, at the top right.</p>
      <p class="fl-autoline" data-k="autoline"></p>
      <p class="fl-said" data-k="hint" role="status" aria-live="polite"></p>
      <p class="fl-answer" data-k="answer" role="status" aria-live="polite" hidden></p>
      <div class="fl-subrow"><span class="ws-seg fl-sub" role="group" aria-label="Legion page"><button type="button" data-do="sub" data-sub="setup" aria-pressed="true">Setup</button><button type="button" data-do="sub" data-sub="live" aria-pressed="false">Live</button></span></div>
      <p class="fl-legend"><span class="fl-key"><span class="fl-dot" data-stage="eval"></span>Eval account</span><span class="fl-key"><span class="fl-dot" data-stage="funded"></span>Funded account</span><span class="fl-key"><span class="fl-who" data-who="bot">BOT</span>fixed rules</span><span class="fl-key"><span class="fl-who" data-who="agent">AGENT</span>an AI trader</span></p></div>
      <div class="fl-page" data-k="setup">
        <section class="fl-box fl-market" aria-label="Market now"><div class="fl-btitle"><h3 class="fl-h">Market now</h3></div>
          <p class="fl-empty">Not built yet. The zone (the trend's direction and the volatility, in words) comes from Bot-Lab's plain-code labeler on this PC once it exists. It will suggest; you choose.</p></section>
        <section class="fl-box fl-today" aria-label="Today"><div class="fl-btitle"><h3 class="fl-h">Today</h3><span class="fl-sub2">Accounts join their lane by themselves (ChartBridge 0.6.22), on the bench. Pick the bot for the lane. Flip Armed.</span></div>
          <div class="fl-lanegrid"><div data-k="lane-eval"></div><div data-k="lane-funded"></div><div data-k="lane-unassigned"></div></div><div data-k="lanes"></div></section>
        <section class="fl-box fl-desk" aria-label="Traders"><div class="fl-btitle"><h3 class="fl-h">Traders</h3><span class="fl-sub2">Set up a prop trader: its account or group, its rules, its proposals. Closed until you open it.</span>
          <span class="fl-fill"></span><button type="button" class="fl-pill" data-do="desk" data-k="deskbtn" aria-expanded="false" aria-controls="flDesk">Show</button></div>
          <div id="flDesk" class="fl-deskbody" data-k="desk" hidden></div></section>
        <section class="fl-box fl-roster" aria-label="Roster"><div class="fl-btitle"><h3 class="fl-h">Roster</h3><span class="fl-sub2">The bots the Lab built. One line a family; open it for its settings.</span></div>
          <div class="fl-filters" role="group" aria-label="Roster filters">
            <button type="button" class="fl-pill" data-do="filter" data-filter="fits" aria-pressed="false" aria-disabled="true" title="Market now is not built yet, so nothing can be matched to the market">Fits now</button>
            <button type="button" class="fl-pill" data-do="filter" data-filter="evals" aria-pressed="false" title="Runs live, and the file itself says its eval number is above no edge; best eval pass share first">Good for evals</button>
            <button type="button" class="fl-pill" data-do="filter" data-filter="funded" aria-pressed="false" title="Runs live, and the file itself says its funded number is above no edge; most paid per funded account first">Good for funded</button>
            <button type="button" class="fl-pill" data-do="filter" data-filter="all" aria-pressed="true" data-k="allbtn">All</button>
            <label class="fl-find">Find <input type="text" class="ws-in" data-do="find" placeholder="name or family" autocomplete="off" spellcheck="false" maxlength="40"></label>
            <span class="fl-fill"></span><button type="button" class="fl-pill" data-do="roster">Read again</button>
          </div>
          <div data-k="roster"></div></section>
      </div>
      <div class="fl-page" data-k="live" hidden>
        <section class="fl-box fl-tilebox" aria-label="Today"><div class="fl-tiles" data-k="tiles"></div></section>
        <section class="fl-box fl-chartbox" aria-label="Today on one chart"><div class="fl-btitle"><h3 class="fl-h">Today on one chart</h3><span class="fl-sub2">Each lane's fills: E the eval lane, F the funded lane; a circle opens or adds, a diamond reduces or closes. This chart takes no orders.</span></div>
          <div class="fl-chart" data-k="chart"></div><p class="fl-note" data-k="chartsaid"></p></section>
        <section class="fl-box" aria-label="By trader"><div class="fl-btitle"><h3 class="fl-h">By trader</h3><span class="fl-sub2">Each lane's trader today, as ChartBridge says it.</span></div><div data-k="bytrader"></div></section>
        <section class="fl-box" aria-label="Accounts live"><div class="fl-btitle"><h3 class="fl-h">Accounts live</h3><span class="fl-sub2">The Accounts tab's own rows, the prop accounts only, one section a group. Read only.</span></div>
          <div class="fl-acctrows" data-k="acctrows"></div><div data-k="accounts"></div></section>
      </div>
    </div>`;
    for (const k of ['autoline', 'ask', 'kill', 'yes', 'no', 'hint', 'answer', 'roster', 'accounts', 'lanes', 'lane-eval', 'lane-funded', 'lane-unassigned', 'desk', 'deskbtn', 'arm', 'armyes', 'armno', 'armsaid', 'armask', 'setup', 'live', 'allbtn', 'tiles', 'chart', 'chartsaid', 'bytrader', 'acctrows']) el[k] = view.querySelector('[data-k="' + k + '"]');
    el.cancel = view.querySelector('[data-do="no"]');
    if (el.desk) el.desk.hidden = !S.deskOpen;           // the Traders fold: shut until opened (the desk is mounted only then)
    deskButton();
    S.built = true; S.drawn = {}; S.rosterDirty = true;
  }
  const setText = (e, t) => { if (e && e.textContent !== t) e.textContent = t; };
  const setHidden = (e, h) => { if (e && e.hidden !== h) e.hidden = h; };
  function section(key, html) {
    if (S.drawn[key] === html || !el[key]) return;
    S.drawn[key] = html; el[key].innerHTML = html; S.draws[key]++;
    if (key.startsWith('lane-')) placeLanePanels();
  }
  /* ---------------- a lane's accounts: the Multi-Account panel itself, mounted by the page once a lane (o.lanePanel: the page's
     own mount with one fixed group, the narrow feed and the lane's lock). Its element is made once and kept: after the lane's
     words are drawn again it is put back in its place, so a drag or a join under way is never torn down by a message. */
  function lanePanelFor(l) {
    if (typeof o.lanePanel !== 'function' || !l || !l.groupId) return null;
    const cur = S.lanePanels[l.stage];
    if (cur && cur.groupId === l.groupId) return cur;
    if (cur) { try { cur.mount.destroy(); } catch (e) { /* gone */ } delete S.lanePanels[l.stage]; }
    if (typeof document === 'undefined' || !document.createElement) return null;
    const host = document.createElement('div'); host.className = 'fl-lanepanel';
    const stage = l.stage;
    /* not known is locked (the review of 97, F1): heard once ChartBridge's groups and its traders have come on this connection */
    // answers 33, A28-1: every group's lock includes the lane's own: a heard trader the page cannot read makes it not known too
    const locked = () => { if (agentList().some(x => !C.accountsReadable(x))) return C.NOT_READABLE; const now = laneList().find(x => x.stage === stage); return C.laneLock(now, heard()) || (!S.connected ? 'ChartBridge is not connected' : ''); };
    /* taking an account from another group asks that group's lane too (F2); a group no lane trades is free once heard */
    // answers 25, S2: any group's lock covers every trader heard on it, not only a lane's own (a doubled lane's second group, a group of no Type)
    const otherLocked = gid => { if (!heard()) return C.NOT_KNOWN; return C.groupLock(gid, agentList(), true, S.groups) || (!S.connected ? 'ChartBridge is not connected' : ''); };
    let mount = null;
    try { mount = o.lanePanel(host, 'legion-' + stage, { group: l.groupId, locked, otherLocked }); } catch (e) { mount = null; }
    if (!mount) return null;
    S.lanePanels[stage] = { groupId: l.groupId, host, mount };
    return S.lanePanels[stage];
  }
  /* ---------------- the Traders fold (build answers B4-1, section 3; builder 4's Legion trader desk, chart-engine 103): ONE mount,
     o.traderDesk(el), handed by the page (it calls LegionDesk.mount with the page's feed; the desk puts Legion's gate round it).
     Closed by default; mounted the first time it is opened, then told show(true) when opened and show(false) when shut (the
     desk counts as shown only between the two: no "seen", no polling, no live chart while shut, builder 4's fixes of B4-2);
     taken down (destroy, which also takes its gate off the feed) when the tab closes and on destroy. Nothing else of the
     desk is here. */
  /* told only when the value changes (the last one sent is kept); the Live sub-page hides the fold too (answers 27, 104-A) */
  const deskShow = on => { if (S.desk && typeof S.desk.show === 'function' && S.deskSent !== on) { S.deskSent = on; try { S.desk.show(on); } catch (e) { /* gone */ } } };
  function openDesk() {
    S.deskOpen = true;
    if (el.desk) {
      el.desk.hidden = false;
      if (!S.desk && typeof o.traderDesk === 'function') { S.deskSent = null; try { S.desk = o.traderDesk(el.desk) || null; } catch (e) { S.desk = null; } }
      if (!S.desk) el.desk.innerHTML = '<p class="fl-empty">The trader desk shows here when the page has it (live/legion-desk.js).</p>';
    }
    deskShow(S.sub === 'setup');
    deskButton();
  }
  function shutDesk() {
    S.deskOpen = false;
    deskShow(false);
    if (el.desk) el.desk.hidden = true;
    deskButton();
  }
  function dropDesk() {
    S.deskOpen = false;
    if (S.desk) { deskShow(false); try { if (typeof S.desk.destroy === 'function') S.desk.destroy(); } catch (e) { /* gone */ } S.desk = null; }
    S.deskSent = null;
    if (el.desk) { el.desk.hidden = true; el.desk.innerHTML = ''; }
    deskButton();
  }
  function deskButton() { if (el.deskbtn) { el.deskbtn.setAttribute('aria-expanded', String(S.deskOpen)); el.deskbtn.textContent = S.deskOpen ? 'Hide' : 'Show'; } }
  function dropLanePanels() { for (const k of Object.keys(S.lanePanels)) { try { S.lanePanels[k].mount.destroy(); } catch (e) { /* gone */ } } S.lanePanels = {}; }
  function placeLanePanels() {
    for (const stage of C.STAGES) {
      const box = el['lane-' + stage];
      if (!box || typeof box.querySelector !== 'function') continue;
      const spot = box.querySelector('[data-panel="' + stage + '"]'), lp = S.lanePanels[stage];
      if (spot && lp && typeof spot.appendChild === 'function' && lp.host.parentNode !== spot) spot.appendChild(lp.host);
    }
  }
  function renderArm(ls) {
    const st = armNow(ls), asking = S.armAsk > 0;
    /* "Sent ..." is kept only until ChartBridge's word changes the switch; a refusal or a failed send stays until the next use */
    /* what was said beside the switch (sent, or ChartBridge's refusal) goes when ChartBridge's word changes the switch (note 4) */
    if (S.armSeen !== st.state) { if (S.armSeen !== undefined) { S.armSaid = ''; S.armBad = false; } S.armSeen = st.state; }
    setText(el.arm, st.text);
    if (el.arm) {
      el.arm.setAttribute('aria-checked', st.state === 'on' ? 'true' : st.state === 'partly' || st.state === 'unknown' ? 'mixed' : 'false'); el.arm.setAttribute('data-state', st.state);
      if ((st.state === 'off' && !st.can) || st.state === 'unknown') { el.arm.setAttribute('aria-disabled', 'true'); el.arm.setAttribute('title', st.why); }
      else { el.arm.removeAttribute('aria-disabled'); el.arm.setAttribute('title', st.state === 'off' ? 'Switch on: every ready lane goes to Auto. It asks first.' : 'Switch off: every lane\'s trader goes to Shadow, at this one click. It closes no position: Kill all does.'); }
    }
    setHidden(el.arm, asking); setHidden(el.armno, !asking); setHidden(el.armyes, !asking); setHidden(el.armask, !asking);
    if (asking) setText(el.armask, 'Arm? ' + C.armWords(ls) + ' Yes, or Cancel, beside this.');
    setText(el.armsaid, S.armSaid || (st.state === 'partly' ? st.reasons.join('. ') + '. A click switches ' + (st.outside.length ? 'every lane and ' + st.outside.join(', ') : 'every lane') + ' off.' : (st.state === 'off' && !st.can) || st.state === 'unknown' ? st.why : ''));
    if (el.armsaid) el.armsaid.classList.toggle('bad', S.armBad && !!S.armSaid);
  }
  /* today's result on a lane: the sum of its accounts' today as ChartBridge sends it, or null when one is not known */
  function laneToday(l) {
    const rows = S.accounts && Array.isArray(S.accounts.list) ? S.accounts.list : [];
    let sum = 0;
    for (const n of l.seats) { const r = rows.find(x => x && typeof x.name === 'string' && x.name.toLowerCase() === n.toLowerCase()); if (!r || typeof r.pnlToday !== 'number' || !isFinite(r.pnlToday)) return null; sum += r.pnlToday; }
    return l.seats.length ? Math.round(sum * 100) / 100 : null;
  }
  /* 1.54.0 (D, Legion simpler; Anthony 2026-11-13): a lane card is the bot picked, how many accounts (a click lists them: the
     lane's own Multi-Account panel, folded), its status in a word or two and the lane rule's last lines. Every explanation sits
     behind its "?" (drawn and hidden until opened, so nothing it says is lost). */
  const laneLine = x => `<li><span class="mono fl-mut">${esc(C.hhmm(x.at))}</span> ${esc(x.text)}</li>`;
  /* 1.55.0 (D1, D2): the lane's own account list. Each account: trading or on the bench, today, a Bench / Trade toggle (the
     per-account arm) and, for a Sim account (added by hand), Remove, asked once; an account the lane rule owns says when it
     leaves. Every move goes through the lane's own Multi-Account panel (its bench and remove), so its checks, its lock, its
     narrow feed and its answer are the ones used: this list sends nothing itself. "Add a Sim account" opens that panel. */
  function lanePanelApi(stage) { const lp = S.lanePanels[stage], p = lp && lp.mount ? lp.mount.panel : null; return p && typeof p.bench === 'function' && typeof p.remove === 'function' ? p : null; }
  function laneMoveWhy(l) { return C.laneLock(l, heard()) || (!S.connected ? 'ChartBridge is not connected' : '') || (lanePanelApi(l.stage) ? '' : 'An account moves only when the page is open with its accounts part.'); }
  function laneAcctsHtml(l) {
    const accts = C.laneAccounts(l, S.accounts, S.version), why = laneMoveWhy(l), dis = why ? ` aria-disabled="true" title="${esc(why)}"` : '', api = lanePanelApi(l.stage);
    const said = S.acctSaid.has(l.stage) && api && api.state && api.state.toast ? api.state.toast : null;
    const row = a => `<li class="fl-acct" data-acct="${esc(a.name)}"${a.benched ? ' data-benched="1"' : ''}><span class="fl-aname">${esc(a.name)}</span>${a.sim ? '<span class="fl-tag" data-kind="sim">Sim</span>' : ''}
        <span class="fl-mut">${a.benched ? 'On the bench' : 'Trading'}</span><span class="fl-fill"></span>${a.today === null ? '<span class="fl-mut">today not known</span>' : `<span class="mono fl-pnl${a.today > 0 ? ' up' : a.today < 0 ? ' down' : ''}">${esc(C.usd(a.today, true))}</span>`}
        <button type="button" class="fl-pill" data-do="acctbench" data-stage="${esc(l.stage)}" data-acct="${esc(a.name)}" data-to="${a.benched ? 'trade' : 'bench'}"${dis}>${a.benched ? 'Trade' : 'Bench'}</button>
        ${a.ruleOwned ? `<span class="fl-mut fl-ruleowned">${esc(C.RULE_OWNED_WORDS)}</span>` : `<button type="button" class="fl-pill fl-remove" data-do="acctremove" data-stage="${esc(l.stage)}" data-acct="${esc(a.name)}"${dis}>${S.removeAsk === l.stage + '|' + a.name ? 'Yes, remove ' + esc(a.name) + (a.sim ? '' : ': it stays out until you add it by hand') : 'Remove'}</button>`}</li>`;
    return `<ul class="fl-accts" aria-label="${esc(l.title)}: its accounts">${accts.length ? accts.map(row).join('') : '<li class="fl-mut">No account in this lane yet.</li>'}</ul>
      ${why ? `<p class="fl-line fl-mutline fl-acctwhy">${esc(why)}</p>` : ''}${said ? `<p class="fl-line fl-acctsaid${said.warn ? ' fl-warn' : ''}" role="status">${esc(said.text)}</p>` : ''}
      <div class="fl-trow"><button type="button" class="fl-pill" data-do="addsim" data-stage="${esc(l.stage)}" aria-expanded="${S.laneAdd.has(l.stage)}">${C.atLeast(S.version, C.HAND_MIN) ? 'Add an account by hand' : 'Add a Sim account'}</button></div>`;
  }
  function laneHtml(l, choices) {
    const none = !l.id, helpOpen = S.laneHelp.has(l.stage), acctOpen = S.laneAccts.has(l.stage);
    const opts = [{ file: '', text: 'None' }].concat(choices);
    if (l.pick && !choices.some(c => c.file === l.pick)) opts.push({ file: l.pick, text: l.pickText + ' (not offered now)' });
    const locked = l.auto ? 'Switch Armed off first: the pick changes only while the lane is not in Auto' : l.exposed ? 'The trader holds something: the pick changes once it is flat' : !l.pickKnown ? 'The pick needs ChartBridge ' + C.PICK_MIN : '';
    const sel = none ? '' : `<label class="fl-k" for="flPick-${esc(l.stage)}">Bot</label><select class="fl-pick" id="flPick-${esc(l.stage)}" data-do="pick" data-agent="${esc(l.id)}"${locked ? ` disabled title="${esc(locked)}"` : ''}>${opts.map(c => `<option value="${esc(c.file)}"${c.file === l.pick ? ' selected' : ''}>${esc(c.text)}</option>`).join('')}</select>`;
    const c = l.card, st = c ? c.stages[l.stage === 'eval' ? 0 : 1] : null, today = none ? null : laneToday(l), word = C.laneWord(l);
    const card = none ? '' : c ? `<div class="fl-botcard"><div class="fl-trow"><span class="fl-tname">${c.displayName ? `${esc(c.displayName)}<span class="fl-built">${esc(C.readableName(c.name))}</span>` : esc(C.readableName(c.name))}</span><span class="fl-who" data-who="bot">${c.kind === 'lineup' ? 'LINEUP' : 'BOT'}</span><span class="fl-fill"></span>${today === null ? '<span class="fl-mut">today not known</span>' : `<span class="mono fl-pnl${today > 0 ? ' up' : today < 0 ? ' down' : ''}">${esc(C.usd(today, true))}</span>`}</div></div>`
      : '<div class="fl-slot">No bot is picked for this lane.</div>';
    const n = l.seats.length + l.benched.length;
    const count = none ? '' : `<div class="fl-trow"><button type="button" class="fl-pill fl-acctbtn" data-do="laneaccts" data-stage="${esc(l.stage)}" aria-expanded="${acctOpen}">${esc(C.one(n, 'account'))}${l.benched.length ? ' (' + l.benched.length + ' on the bench)' : ''}</button></div>`;
    const list = none || !acctOpen ? '' : laneAcctsHtml(l);
    const log = none || !l.laneLog.length ? '' : `<ul class="fl-lanelog" aria-label="What the lane rule did">${l.laneLog.slice(-3).reverse().map(laneLine).join('')}</ul>`;
    const help = `<div class="fl-lanehelp"${helpOpen ? '' : ' hidden'}>
      <p class="fl-line fl-mutline">${l.stage === 'eval' ? 'Goal: pass the eval.' : 'Goal: reach the payout.'}${none ? '' : ` Trader ${esc(l.name)}, group ${esc(l.groupName)}, mode <span class="fl-mode" data-mode="${esc(l.mode)}">${esc(l.modeText)}</span>.`} <span class="fl-tag" data-kind="${l.armable ? 'live' : 'notlive'}">${l.armable ? 'Ready' : 'Not ready'}</span>${l.sim ? ' <span class="fl-tag" data-kind="sim">Sim: no money at stake</span>' : ''}</p>
      ${l.why ? `<p class="fl-line fl-warn fl-lanewhy">${esc(l.why)}</p>` : ''}
      ${!none && c ? `<p class="fl-line fl-mutline"><span class="fl-status">${esc(l.status)}</span>; risk ${esc(C.usd(st.risk))} a trade.</p>` : ''}
      ${!none && c && c.kind === 'lineup' ? `<p class="fl-line fl-mutline">${esc(c.bots.map(b => C.readableName(b.name)).join(', '))}: one open trade at a time, the first listed wins a tie.</p>` : ''}
      ${none ? '' : (w => (w.length ? `<p class="fl-line fl-mutline fl-waiting">Not offered until it runs live: ${w.map(x => `${esc(x.text)} (${esc(x.why)})`).join('; ')}${w.more ? `; and ${w.more} more (the Roster says why)` : ''}.</p>` : ''))(C.waitingChoices(S.roster.cards, 5))}
      ${!none && l.runnerNote && l.armable ? `<p class="fl-line fl-mutline">${esc(l.runnerNote)}</p>` : ''}
      ${none ? '' : (r => `<p class="fl-line fl-runner" data-tone="${esc(r.tone)}">${esc(r.text)}</p>`)(C.laneRunner(l, S.helper))}
      ${!none && l.laneLog.length > 3 ? `<ul class="fl-lanelog fl-lanelogold" aria-label="The lane rule's earlier lines">${l.laneLog.slice(0, -3).reverse().map(laneLine).join('')}</ul>` : ''}
      <p class="fl-line fl-mutline">${esc(C.LANE_HELP)} A second bot on a lane comes as a lineup file from the Lab.</p>
    </div>`;
    return `<div class="fl-lane" data-stage="${esc(l.stage)}" data-armable="${l.armable}"${l.auto ? ' data-auto="1"' : ''}>
      <div class="fl-trow"><span class="fl-lanetitle"><span class="fl-dot" data-stage="${esc(l.stage)}"></span>${esc(l.title)}</span>
        <span class="fl-fill"></span><span class="fl-word" data-word="${esc(word.key)}">${esc(word.text)}</span><button type="button" class="fl-help" data-do="lanehelp" data-stage="${esc(l.stage)}" aria-expanded="${helpOpen}" aria-label="${esc(l.title)}: what it says in full">?</button></div>
      ${(r => `<p class="fl-line fl-lanerule" data-rule="${esc(r.key)}">${esc(r.text)}</p>${r.kept.length ? `<p class="fl-line fl-mutline fl-kept">Kept out by hand: ${r.kept.map(k => esc(k.account) + (k.from ? ' (from ' + esc(k.from) + ')' : '')).join(', ')}. The rule leaves ${r.kept.length === 1 ? 'it' : 'them'} out until put in a group by hand.</p>` : ''}`)(C.laneRuleOf(S.groups, S.version, l.stage))}
      ${none || !l.kindText ? '' : `<div class="fl-lanekind" data-lanekind="${esc(l.kindText === 'SIM' ? 'sim' : l.kindText === 'PROP' ? 'prop' : 'propsim')}">${esc(l.kindText)}</div>`}
      ${none ? '' : `<div class="fl-trow">${sel}</div>${card}`}
      ${count}
      ${list}
      ${none ? '' : `<div class="fl-lanepanels" data-panel="${esc(l.stage)}"${acctOpen && S.laneAdd.has(l.stage) ? '' : ' hidden'}>${typeof o.lanePanel === 'function' ? '' : '<p class="fl-mut">The accounts of this lane show here when the page is open with its accounts part.</p>'}</div>`}
      ${log}
      ${help}
    </div>`;
  }
  /* 1.56.0 (Anthony 2026-11-13): the third row, Unassigned. Add goes through the lane's own Multi-Account panel (its join step:
     its checks, its rules, its highest close and its Put in), so the add is his hand add and ChartBridge takes the account off
     the hand list; this row sends nothing itself. An account in a group of his own stays there until he takes it out. */
  function unassignedHtml(ls) {
    const u = C.unassigned(S.groups, S.version);
    const row = r => {
      const l = ls.find(x => x.stage === r.kind), lane = r.kind === 'eval' ? 'the eval lane' : 'the funded lane';
      const why = !l || !l.groupId ? 'There is no ' + r.kind + ' lane yet (a trader on a group of Type ' + r.kind + ')' : laneMoveWhy(l);
      /* Anthony 2026-11-13 ("1. a"): one in a group of his own moves straight into the lane, asked once, naming both groups */
      const asking = !why && r.group && S.unAsk === r.kind + '|' + r.account;
      return `<li class="fl-acct" data-acct="${esc(r.account)}"><span class="fl-aname">${esc(r.account)}</span><span class="fl-tag" data-kind="${esc(r.kind)}">${esc(r.kindText)}</span>
        <span class="fl-mut fl-where">${esc(r.where)}</span><span class="fl-fill"></span>
        <button type="button" class="fl-pill" data-do="unadd" data-acct="${esc(r.account)}" data-stage="${esc(r.kind)}"${why ? ` aria-disabled="true" title="${esc(why)}"` : ''}>${asking ? 'Yes, move ' + esc(r.account) + ' out of ' + esc(r.group) + ' into ' + esc(lane) : (r.group ? 'Move to ' : 'Add to ') + esc(lane)}</button></li>`;
    };
    return `<div class="fl-lane fl-unassigned" data-stage="unassigned">
      <div class="fl-trow"><span class="fl-lanetitle">Unassigned</span><span class="fl-fill"></span><span class="fl-mut">${esc(u.text)}</span></div>
      ${u.rows.length ? `<ul class="fl-accts" aria-label="Unassigned: eval and funded accounts outside the lanes">${u.rows.map(row).join('')}</ul>` : ''}
      ${S.unSaid ? `<p class="fl-line fl-acctsaid${S.unSaid.warn ? ' fl-warn' : ''}" role="status">${esc(S.unSaid.text)}</p>` : ''}
      <p class="fl-line fl-mutline">Eval and funded accounts on The Desk that are in no lane. An account you took out by hand stays out until you add it; Add opens the lane's own panel, where you check its rules and put it in. One in a group of yours moves straight into the lane, asked once.</p>
    </div>`;
  }
  /* each lane is drawn on its own (the review of 94, note 3): a change in one never takes an open pick list away in the other */
  function lanesHtml(ls) {
    for (const l of ls) lanePanelFor(l);
    for (const stage of Object.keys(S.lanePanels)) { const l = ls.find(x => x.stage === stage); if (!l || !l.groupId) { try { S.lanePanels[stage].mount.destroy(); } catch (e) { /* gone */ } delete S.lanePanels[stage]; } }
    return '';   // 1.54.0 (D): the lanes' explanation is behind each lane's "?" (FleetCore.LANE_HELP)
  }
  function renderSub() {
    setHidden(el.setup, S.sub !== 'setup'); setHidden(el.live, S.sub !== 'live');
    deskShow(S.deskOpen && S.sub === 'setup');           // 104-A: off the Setup page the desk is not shown (no polling, no chart)
    if (S.sub === 'live') mountLive(); else unmountLive();
    if (view && typeof view.querySelectorAll === 'function') for (const b of view.querySelectorAll('[data-do="sub"]')) b.setAttribute('aria-pressed', String(b.dataset.sub === S.sub));
    if (view && typeof view.querySelectorAll === 'function') for (const b of view.querySelectorAll('[data-do="filter"]')) b.setAttribute('aria-pressed', String(b.dataset.filter === S.filter));
    const total = S.roster.cards && S.roster.cards.ok ? S.roster.cards.bots.length + S.roster.cards.lineups.length : 0;
    setText(el.allbtn, 'All (' + total + ')');
  }
  function tilesHtml(tiles) {
    return tiles.map(t => `<div class="fl-tile" data-tile="${esc(t.key)}"><span class="fl-tiletitle">${esc(t.title)}</span>` +
      (t.value === null ? '<span class="fl-tileval fl-mut">-</span>' : `<span class="fl-tileval mono fl-pnl${t.value > 0 ? ' up' : t.value < 0 ? ' down' : ''}">${esc(C.usd(t.value, true))}</span>`) +
      `<span class="fl-tiletext">${esc(t.text)}</span></div>`).join('');
  }
  function byTraderHtml(rows) {
    if (!rows.length) return '<p class="fl-empty">No lane has a trader yet: put a trader on a group on Setup.</p>';
    return `<div class="fl-bytrader" role="table" aria-label="By trader"><div class="fl-btrow fl-bthead" role="row"><span role="columnheader">Lane</span><span role="columnheader">Trader</span><span role="columnheader">Mode</span><span role="columnheader" class="r">Today</span><span role="columnheader" class="r">Trades</span><span role="columnheader">Now</span><span role="columnheader">Live record</span></div>` +
      rows.map(r => `<div class="fl-btrow" role="row"><span role="cell"><span class="fl-dot" data-stage="${esc(r.stage)}"></span>${esc(r.stage === 'eval' ? 'Eval' : 'Funded')}</span><span role="cell">${esc(r.name)}</span><span role="cell">${esc(r.mode)}</span>` +
        `<span role="cell" class="r mono">${r.today === null ? 'not known' : esc(C.usd(r.today, true))}</span><span role="cell" class="r mono">${r.trades === null ? 'not known' : esc(String(r.trades))}</span>` +
        `<span role="cell">${r.inTrade === null ? 'not known' : r.inTrade ? 'in a trade' : 'flat'}</span><span role="cell" class="fl-mut">${esc(r.record)}</span></div>`).join('') + '</div>';
  }
  function renderHead(rows) {
    const st = killState(), asking = S.ask > 0;
    setText(el.autoline, C.autoLine(rows, !!S.accounts));
    setHidden(el.ask, !asking); setHidden(el.yes, !asking); setHidden(el.no, !asking); setHidden(el.kill, asking);
    if (el.kill) {
      if (st.ok) { el.kill.removeAttribute('aria-disabled'); el.kill.removeAttribute('title'); }
      else { el.kill.setAttribute('aria-disabled', 'true'); el.kill.setAttribute('title', st.why); }
    }
    setText(el.hint, S.hint || (st.ok ? HINT : st.why));
    if (el.hint) el.hint.classList.toggle('bad', S.hintBad);
    setText(el.answer, S.answer); setHidden(el.answer, !S.answer);
    if (el.answer) el.answer.classList.toggle('bad', S.answerBad);
    S.draws.head++;
  }
  function render() {
    if (!view || !S.shown) return;
    if (!S.built) build();
    let rows = [];
    try { rows = C.traders(agentList(), S.accounts, S.version); } catch (e) { rows = []; }
    try { renderHead(rows); } catch (e) { /* the head's buttons are already there: a text that cannot be set never takes them away */ }
    let ls = [];
    try { ls = laneList(); } catch (e) { ls = []; }
    try { renderArm(ls); } catch (e) { /* the switch is already there */ }
    try { const choices = C.pickChoices(S.roster.cards); section('lanes', lanesHtml(ls)); for (const l of ls) section('lane-' + l.stage, laneHtml(l, choices)); section('lane-unassigned', unassignedHtml(ls)); placeLanePanels(); } catch (e) { section('lanes', '<p class="fl-empty fl-warn">The lanes could not be drawn.</p>'); }
    try { if (S.rosterDirty) { S.rosterDirty = false; section('roster', rosterHtml()); if (el.roster) el.roster.setAttribute('data-state', S.roster.state); } } catch (e) { section('roster', '<p class="fl-empty fl-warn">The roster could not be drawn.</p>'); }
    try { renderSub(); } catch (e) { /* the pages are already there */ }
    /* 1.54.0 (D): "Other connections" left Legion: the traders on no lane show on the Colosseum's watch box (those in Shadow)
       and on Praetorian; one in Auto on a prop account is named in the line under the title, and Kill all still stops it */
    /* the old Prop accounts table only where the page cannot hand the Accounts tab's own rows (accounts.js not served) */
    try { section('accounts', S.rows ? '' : accountsHtml(C.propAccounts(S.accounts, S.groups, agentList()))); } catch (e) { section('accounts', '<p class="fl-empty fl-warn">The prop accounts could not be drawn.</p>'); }
    if (S.sub === 'live') {
      try { section('tiles', tilesHtml(C.liveTiles(ls, S.accounts))); } catch (e) { section('tiles', '<p class="fl-empty fl-warn">The tiles could not be drawn.</p>'); }
      try { section('bytrader', byTraderHtml(C.traderDays(ls, agentList(), S.accounts))); } catch (e) { section('bytrader', '<p class="fl-empty fl-warn">The traders could not be drawn.</p>'); }
      setText(el.chartsaid, !S.pane ? 'The chart shows when the page is open with its chart part.' : S.fills.size ? '' : 'No fill on a lane\'s account yet today.');
      if (S.overlay) S.overlay.redraw();
    }
  }
  function onClick(e) {
    const b = e.target && e.target.closest ? e.target.closest('button[data-do]') : null;
    if (!b) return;
    const what = b.dataset.do;
    if (what === 'roster') { if (S.roster.state !== 'loading') loadRoster(); return; }
    if (what === 'sub') { const sub = b.dataset.sub === 'live' ? 'live' : 'setup'; if (sub !== S.sub) { S.sub = sub; render(); } return; }
    if (what === 'filter') { const f = String(b.dataset.filter || ''); if (C.FILTERS.includes(f) && f !== S.filter) { S.filter = f; S.rosterDirty = true; render(); } return; }
    if (what === 'fam') { const k = String(b.dataset.fam || ''); if (S.famShut.has(k)) S.famShut.delete(k); else S.famShut.add(k); S.rosterDirty = true; render(); return; }
    if (what === 'desk') { if (S.deskOpen) shutDesk(); else openDesk(); return; }
    if (what === 'acctbench' || what === 'acctremove') {                   // 1.55.0 (D1): through the lane's own panel, never around it
      const stage = String(b.dataset.stage || ''), name = String(b.dataset.acct || ''), l = laneList().find(x => x.stage === stage);
      if (!l || !C.STAGES.includes(stage) || !name || !C.laneAccounts(l, S.accounts, S.version).some(a => a.name === name)) return;
      if (laneMoveWhy(l)) { render(); return; }                             // the reason is on the list already
      const api = lanePanelApi(stage), a = C.laneAccounts(l, S.accounts, S.version).find(x => x.name === name);
      if (what === 'acctbench') { S.removeAsk = ''; api.bench(name, b.dataset.to === 'bench'); }
      else if (a.ruleOwned) return;                                          // the rule owns it: no hand remove (it would come back)
      else if (S.removeAsk !== stage + '|' + name) { S.removeAsk = stage + '|' + name; render(); return; }
      else { S.removeAsk = ''; api.remove(name); }
      S.acctSaid.add(stage); render(); return;
    }
    if (what === 'unadd') {                                                 // 1.56.0: Unassigned's Add, through the lane's own panel
      const stage = String(b.dataset.stage || ''), name = String(b.dataset.acct || ''), l = laneList().find(x => x.stage === stage);
      const r = C.unassigned(S.groups, S.version).rows.find(x => x.account === name && x.kind === stage);
      if (!l || !r || !C.STAGES.includes(stage) || !l.groupId || laneMoveWhy(l)) { render(); return; }   // the reason is on the button
      const api = lanePanelApi(stage);
      if (r.group) {                                                        // his own group: one step, asked once (naming both groups)
        if (S.unAsk !== stage + '|' + name) { S.unAsk = stage + '|' + name; S.unSaid = null; render(); return; }
        S.unAsk = '';
        const no = api && typeof api.moveIn === 'function' ? api.moveIn(name) : 'The lane\'s panel cannot move an account on this page.';
        S.unSaid = no ? { text: no, warn: true } : { text: 'Sent to ChartBridge: ' + name + ' out of ' + r.group + ' into the ' + stage + ' lane.', warn: false };
        render(); return;
      }
      S.unAsk = '';
      S.laneAccts.add(stage); S.laneAdd.add(stage);                          // the lane's panel open, where the join step shows
      const no = api && typeof api.join === 'function' ? api.join(name) : 'The lane\'s panel cannot add an account on this page.';
      S.unSaid = no ? { text: no, warn: true } : { text: name + ': check its rules and its highest close in the ' + stage + ' lane\'s panel, then Put in.', warn: false };
      render(); return;
    }
    if (what === 'addsim') { const stage = String(b.dataset.stage || ''); if (C.STAGES.includes(stage)) { if (S.laneAdd.has(stage)) S.laneAdd.delete(stage); else S.laneAdd.add(stage); render(); } return; }
    if (what === 'lanehelp' || what === 'laneaccts') {                      // 1.54.0 (D): display only, a lane's "?" or its accounts, open or shut
      const stage = String(b.dataset.stage || ''), set = what === 'lanehelp' ? S.laneHelp : S.laneAccts;
      if (!C.STAGES.includes(stage)) return;
      if (set.has(stage)) set.delete(stage); else set.add(stage);
      render(); return;
    }
    if (what === 'more') {                                                  // display only: a card's detail open or shut
      const k = String(b.dataset.card || '');
      if (S.open.has(k)) S.open.delete(k); else S.open.add(k);
      S.rosterDirty = true; render(); return;
    }
    if (what === 'ask') {
      if (S.ask) return;
      const st = killState();
      if (!st.ok) { hint(st.why, true, true); render(); return; }
      /* Cancel takes the room the button had, so every point of the button is Cancel once the question is up */
      try { const w = el.kill.getBoundingClientRect().width; if (w > 0 && el.cancel) el.cancel.style.minWidth = Math.ceil(w) + 'px'; } catch (x) { /* no layout: the wait still holds */ }
      S.ask = now();
      clearTimeout(S.askTimer);
      S.askTimer = setTimeout(() => { endAsk(); render(); }, C.CONFIRM_MS);
      hint('', false);
      render();
      try { if (el.cancel) el.cancel.focus(); } catch (x) { /* the safe answer has the focus where focus exists */ }
      return;
    }
    if (what === 'arm') {
      if (S.armAsk) return;
      const ls = laneList(), st = armNow(ls);
      if (st.state === 'unknown') { armSay(st.why, true); render(); return; }
      if (st.state !== 'off') { arm(false); return; }      // on or partly: one click switches every lane off, no question
      if (!st.can) { armSay(st.why, true); render(); return; }
      /* Cancel takes the switch's own place, so the second click of a double click lands on Cancel, inside the first moment */
      try { const w = el.arm.getBoundingClientRect().width; if (w > 0 && el.armno) el.armno.style.minWidth = Math.ceil(w) + 'px'; } catch (x) { /* no layout: the wait still holds */ }
      S.armAsk = now(); armSay('', false);
      clearTimeout(S.armTimer);
      S.armTimer = setTimeout(() => { endArmAsk(); render(); }, C.CONFIRM_MS);
      render();
      try { if (el.armno) el.armno.focus(); } catch (x) { /* the safe answer has the focus where focus exists */ }
      return;
    }
    if (what === 'armyes' || what === 'armno') {
      if (!S.armAsk) return;
      const age = now() - S.armAsk;
      if (age > C.CONFIRM_MS) { endArmAsk(); render(); return; }
      if (what === 'armno' && !realClick(e)) { endArmAsk(); render(); return; }          // Cancel by the keyboard: always
      if (what === 'armyes' && !realClick(e)) { armSay('Armed is confirmed by a click on Yes only, not by keyboard. Cancel and Escape work from the keyboard.', true); render(); return; }
      if (age < C.ARM_MS) { if (what === 'armyes') { armSay('Too soon: read the question, then click Yes.', true); render(); } return; }
      if (what === 'armyes') arm(true); else { endArmAsk(); armSay('', false); render(); }
      return;
    }
    if (what !== 'yes' && what !== 'no') return;
    if (!S.ask) return;
    const age = now() - S.ask;
    if (age > C.CONFIRM_MS) { endAsk(); render(); return; }                 // the 8 seconds, by the clock (PROP 6)
    if (what === 'no' && !realClick(e)) { endAsk(); hint('', false); render(); return; }   // Cancel by the keyboard: always
    if (what === 'yes' && !realClick(e)) { hint('Kill all is confirmed by a click on Yes only, not by keyboard. Cancel and Escape work from the keyboard.', true); render(); return; }
    if (age < C.ARM_MS) {                                                   // too soon: no answer, the question stays (STOP 1)
      if (what === 'yes') { hint('Too soon: read the question, then click Yes.', true); render(); }
      return;
    }
    if (what === 'yes') killAll();
    else { endAsk(); hint('', false); render(); }
  }
  /* the lanes' runners: the PC helper's GET /status, read every POLL_MS while the tab is open (o.helperStatus, a read only) */
  const HELPER_POLL_MS = 3000;
  function pollHelper() {
    clearTimeout(S.helperTimer);
    if (!S.shown || typeof o.helperStatus !== 'function') return;
    const seq = ++S.helperSeq;
    let p;
    try { p = Promise.resolve(o.helperStatus()); } catch (e) { p = Promise.resolve({ reach: 'down', body: null }); }
    p.then(r => r, () => ({ reach: 'down', body: null })).then(r => {
      if (seq !== S.helperSeq || !S.shown) return;
      S.helper = r && typeof r === 'object' ? { reach: r.reach, body: r.body } : { reach: 'down', body: null };
      render();
      S.helperTimer = setTimeout(pollHelper, HELPER_POLL_MS);
    });
  }
  function showTab(on) {
    on = !!on;
    if (on === S.shown) return;
    S.shown = on;
    if (tabBtn) { tabBtn.setAttribute('aria-pressed', String(on)); if (on) tabBtn.hidden = false; }
    if (!on) { endAsk(); endArmAsk(); dropLanePanels(); dropDesk(); unmountLive(); clearTimeout(S.helperTimer); S.helperSeq++; S.built = false; if (view) view.innerHTML = ''; offer(); }
    /* Escape cancels a question wherever the focus is while the tab is open (build answers 15, section 3) */
    if (DOC) { if (on) DOC.addEventListener('keydown', onKey, true); else DOC.removeEventListener('keydown', onKey, true); }
    if (typeof o.onTab === 'function') o.onTab(on);
    render();
    if (on) { loadRoster(); pollHelper(); }
  }
  function onKey(e) {
    if (!e || e.key !== 'Escape' || !(S.ask || S.armAsk) || e.flSeen) return;
    e.flSeen = true;                                       // the tab's own listener and the document's both hear one key
    if (S.ask) { endAsk(); hint('', false); }
    if (S.armAsk) { endArmAsk(); armSay('', false); }
    render();
    if (typeof e.preventDefault === 'function') e.preventDefault();
  }
  function onInput(e) {
    const t = e && e.target;
    if (!t || !t.dataset || t.dataset.do !== 'find') return;
    const v = String(t.value || '').slice(0, 40);
    if (v !== S.find) { S.find = v; S.rosterDirty = true; render(); }
  }
  function onChange(e) {
    const t = e && e.target;
    if (!t || !t.dataset || t.dataset.do !== 'pick') return;
    pick(String(t.dataset.agent || ''), t.value ? String(t.value) : null);
  }
  const DOC = typeof document !== 'undefined' && document && typeof document.addEventListener === 'function' ? document : null;
  if (view) view.addEventListener('click', onClick);
  if (view) view.addEventListener('change', onChange);
  if (view) view.addEventListener('input', onInput);
  if (view) view.addEventListener('keydown', onKey);
  if (tabBtn) tabBtn.addEventListener('click', () => showTab(!S.shown));
  const unlisten = V3 ? V3.listen({ message: onMessage, closed: () => lost() }) : () => {};
  return {
    showTab, shown: () => S.shown, offered: () => !!tabBtn && !tabBtn.hidden,
    hello: m => onMessage(m),
    state: () => ({ lanes: laneList(), arm: Object.assign({ asking: S.armAsk > 0, said: S.armSaid, bad: S.armBad }, armNow(laneList())),
      shown: S.shown, sub: S.sub, fills: S.fills.size, live: { chart: !!S.pane, rows: !!S.rows }, version: S.version, connected: S.connected, signedIn: S.signedIn, asking: S.ask > 0, hint: S.hint, answer: S.answer, answerBad: S.answerBad, pending: !!S.pending, sent: S.sent, draws: Object.assign({}, S.draws),
      traders: C.traders(agentList(), S.accounts, S.version), accounts: C.propAccounts(S.accounts, S.groups, agentList()),
      roster: { state: S.roster.state, text: S.roster.text, asked: S.roster.asked, bots: S.roster.cards ? S.roster.cards.bots.map(c => c.name) : [], lineups: S.roster.cards ? S.roster.cards.lineups.map(c => c.name) : [], notShown: S.roster.cards ? S.roster.cards.notShown.length : 0 } }),
    reloadRoster: loadRoster,
    destroy: () => { dropLanePanels(); dropDesk(); unmountLive(); clearTimeout(S.helperTimer); S.helperSeq++; S.roster.seq++; clearTimeout(S.settleTimer); clearTimeout(S.rosterTimer); clearTimeout(S.waitTimer); unlisten(); endAsk(); endArmAsk(); if (DOC) DOC.removeEventListener('keydown', onKey, true); if (view) { view.removeEventListener('click', onClick); view.removeEventListener('change', onChange); view.removeEventListener('input', onInput); view.removeEventListener('keydown', onKey); } },
  };
}
window.FleetView = { create };
})();
