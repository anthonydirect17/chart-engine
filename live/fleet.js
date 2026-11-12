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
 * Accounts tab, the account's group), starting the runner's program with Armed (the helper, B4), and each bot's own state
 * from the spec runner.
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

/** The accounts one trader is on, from its `agent` message: its account, or its group's seats. */
function traderAccounts(agent) {
  const a = agent || {};
  if (plainObj(a.group) && Array.isArray(a.seats)) return a.seats.filter(x => plainObj(x) && typeof x.account === 'string').map(x => x.account);
  return typeof a.account === 'string' && a.account ? [a.account] : [];
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
    const kind = seatsKind(names.map(n => { const row = idx.get(n.toLowerCase()); return row ? kindOf(row) : (accountsMsg && accountsMsg.personalNamed === true ? 'unlisted' : ''); }));
    const r = plainObj(a.rules) ? a.rules : {};
    const mode = own(MODE_NAME, a.mode) ? a.mode : '';
    const can = a.enabled !== false && !a.killed && !a.standDown;
    out.push({
      id: a.agent, name: str(a.name, 40) || a.agent, build: str(a.build, 40), mode, modeText: mode ? MODE_NAME[mode] : 'Not known',
      connected: a.connected === true, autoProp: can && mode === 'auto' && (kind === 'prop' || kind === 'propsim' || kind === 'unlisted' || kind === 'mixed'),
      status: statusText(a), tone: a.enabled === false ? 'off' : a.killed ? 'killed' : a.standDown ? 'standDown' : !a.connected ? 'lost' : 'on',
      accounts: names, accountText: !names.length ? 'None' : plainObj(a.group) ? 'Group ' + (str(a.group.name, 40) || str(a.group.id, 12)) + ': ' + names.join(', ') : names[0],
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
      const b = botPart(d);
      if (!b) { no('its bot, its run or whether it runs live is not in the format\'s shape'); continue; }
      if (quick) { b.whyNot = b.runsLive ? QUICK_WHY : b.whyNot + '; and ' + QUICK_WHY; b.runsLive = false; }
      out.bots.push(Object.assign({ kind: 'bot' }, base, b));
    } else {
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
  if (mixed.length) parts.push('In Auto on a group with your personal account in it (Kill all will NOT stop it: stop it on the Agent tab): ' + mixed.map(nm).join(', '));
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
      groupId: '', groupName: '', seats: [], benched: [], sim: false, pick: '', sha: '', pickKnown: atLeast(version, PICK_MIN), card: null, pickText: '', exposed: false, why: '', armable: false, runnerNote: '' };
    if (!groupsMsg) { L.why = 'Not heard from ChartBridge yet'; return L; }
    if (!on.length) {
      L.why = 'No trader is on a group of Type ' + stage + '. ChartBridge\'s 17:00 reset puts a flat trader on None each trading day, so give the trader its group again on the Agent tab each day (a group with Type ' + stage + ': Settings, Account groups).';
      return L;
    }
    if (on.length > 1) { L.why = on.length + ' traders are on ' + stage + ' groups (' + on.map(a => a.agent).join(', ') + '): Legion runs one lane a stage. Take all but one off on the Agent tab.'; return L; }
    const a = on[0], g = groups.get(a.group.id);
    L.id = a.agent; L.name = str(a.name, 40) || a.agent; L.mode = own(MODE_NAME, a.mode) ? a.mode : ''; L.modeText = L.mode ? MODE_NAME[L.mode] : 'Not known';
    L.connected = a.connected === true; L.status = laneStatus(a); L.exposed = a.owns === true;
    L.groupId = a.group.id; L.groupName = str(g.name, 40) || a.group.id;
    const bench = new Set(Array.isArray(g.benched) ? g.benched.filter(x => typeof x === 'string') : []);
    const all = traderAccounts(a);
    L.seats = all.filter(n => !bench.has(n)); L.benched = all.filter(n => bench.has(n));
    L.pick = typeof a.pick === 'string' && FILE_RX.test(a.pick) ? a.pick : '';
    L.card = L.pick ? files.get(L.pick) || null : null;
    L.sha = L.card && SHA_RX.test(String(L.card.sha256 || '')) ? L.card.sha256 : '';
    L.pickText = !L.pick ? 'None' : L.card ? L.card.name + (L.card.kind === 'lineup' ? ' (lineup of ' + L.card.bots.length + ')' : '') : L.pick;
    const kinds = L.seats.map(n => { const row = idx.get(n.toLowerCase()); return row ? kindOf(row) : ''; });
    L.sim = kinds.length > 0 && kinds.every(k => k === 'sim');
    const r = plainObj(a.rules) ? a.rules : {};
    const allowed = AGC && typeof AGC.modesAllowed === 'function' && typeof AGC.groupTradable === 'function'
      ? AGC.modesAllowed({ tradable: AGC.groupTradable(accountsMsg, null, L.seats), account: L.groupName }).auto : { ok: false, why: 'The page\'s mode rules (agent-core.js) are not loaded' };
    L.why = !L.pickKnown ? 'The pick needs ChartBridge ' + PICK_MIN + ' or later (this one is ' + (version || 'not known') + ')'
      : !ID_RX.test(a.agent) ? 'Its id is not one ChartBridge takes'
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
/** The traders in Auto on something Kill all counts that are on no lane (the review of 94, FIX 2). -> [ids] */
function outsideAuto(ls, agents, accountsMsg, version) {
  const onLane = new Set([].concat.apply([], (ls || []).map(l => l.traders)));
  return traders(agents, accountsMsg, version).filter(t => t.autoProp && !onLane.has(t.id)).map(t => t.id);
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
  const busy = ls.filter(l => l.traders.length && (l.auto || (l.mode && l.mode !== 'shadow'))), ready = ls.filter(l => l.armable);
  const reasons = [];
  for (const l of ls) if (l.mode === 'copilot') reasons.push(l.title + ' is in Copilot');
  for (const l of busy) if (l.auto && !l.armable) reasons.push(l.title + ' is in Auto but not ready (' + l.why + ')');
  for (const l of ready) if (!l.auto && l.mode === 'shadow' && busy.length) reasons.push(l.title + ' is not in Auto');
  if (out.length) reasons.push('Not a lane, so not armed from here: ' + out.join(', ') + ' in Auto (a click sends it to Shadow; or the Agent tab, or Kill all)');
  const state = !busy.length && !out.length ? 'off' : !reasons.length && ready.length && ready.every(l => l.auto) ? 'on' : 'partly';
  const why = !kill.ok ? kill.why : !atLeast(version, PICK_MIN) ? 'Armed needs ChartBridge ' + PICK_MIN + ' or later (this one is ' + (version || 'not known') + ')'
    : !ready.length ? 'No lane is ready: ' + ls.map(l => l.title + ': ' + l.why).join(' ') : '';
  return { state, text: state === 'on' ? 'Armed: ON' : state === 'partly' ? 'Armed: PARTLY' : 'Armed: off', can: !why, canOff: true, why, reasons, outside: out };
}
/** The messages one use of the switch sends, built by AgentCore.modeMsg. on: every ready lane not yet in Auto goes to Auto,
 *  naming its pick and that file's sha256 (the review of 93, FIX 2). Off: every trader of every lane that is not in Shadow,
 *  and every trader in Auto outside the lanes, goes to Shadow. */
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
  return ls.map(l => (l.armable ? l.title + ': ' + l.name + ' goes to Auto and trades ' + l.pickText + ' on ' + one(l.seats.length, l.sim ? 'Sim account' : 'account') + (l.benched.length ? ' (' + one(l.benched.length, 'account') + ' on the bench sit' + (l.benched.length === 1 ? 's' : '') + ' out)' : '') + (l.connected ? '' : ' (its runner is not connected: nothing trades there until it is)')
    : l.title + ': stays off (' + l.why + ')') + '.').join(' ');
}
/** The files a lane can pick: every card that runs live, lineups first. -> [{ file, text }] */
function pickChoices(cards) {
  if (!cards || !cards.ok) return [];
  return cards.lineups.concat(cards.bots).filter(c => c.runsLive && FILE_RX.test(c.file)).slice(0, MAX_CARDS)
    .map(c => ({ file: c.file, text: c.name + (c.kind === 'lineup' ? ' (lineup of ' + c.bots.length + ')' : '') }));
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
    /* Auto names the pick and its file's sha256 (the review of 93, FIX 2): both, or neither for a trader with no pick */
    if (m.mode === 'auto') return only(['type', 'cid', 'agent', 'mode', 'pick', 'pickSha']) && own(m, 'pick') === own(m, 'pickSha') &&
      (!own(m, 'pick') || (typeof m.pick === 'string' && FILE_RX.test(m.pick) && typeof m.pickSha === 'string' && SHA_RX.test(m.pickSha)));
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
    const row = { card: c, file: c.file, name: c.name, readable: readableName(c.name), kind: c.kind, runsLive: c.runsLive,
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
    if (q) list = list.filter(r => (r.readable + ' ' + fam.name + ' ' + r.file).toLowerCase().includes(q));
    if (!list.length) continue;
    out.shown += list.length;
    out.families.push({ key: fam.key, kind: fam.kind, name: fam.name, settings: list, count: fam.settings.length,
      best: Math.max.apply(null, list.map(r => r.ppd)), bestPass: Math.max.apply(null, list.map(r => (isNum(r.evalPass) ? r.evalPass : -1))),
      bestPaid: Math.max.apply(null, list.map(r => (isNum(r.paid) ? r.paid : -1))),
      where: list.filter(r => r.where).map(r => r.readable + ': ' + r.where).join('; ') });
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
 */
function laneLock(l) {
  if (!plainObj(l) || !Array.isArray(l.traders) || !l.traders.length) return '';
  if (l.traders.length > 1) return 'Two traders are on this lane\'s groups: no account moves here until one is taken off (the Agent tab).';
  if (l.auto || l.mode === 'auto') return 'The lane is in Auto: switch Armed off before an account moves.';
  if (l.exposed) return 'The lane\'s trader holds a position or a working entry: an account moves once it is flat.';
  if (l.mode !== 'shadow') return 'The lane\'s trader is not in Shadow (' + (l.modeText || 'not known') + '): an account moves only while it is.';
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
 */
function laneFeed(feed, locked) {
  const refused = [], why = () => { try { const w = typeof locked === 'function' ? locked() : ''; return typeof w === 'string' ? w : 'not known'; } catch (e) { return 'not known'; } };
  const no = name => { refused.push(String(name)); if (refused.length > 50) refused.shift(); return false; };
  const out = {
    get S() { return feed.S; },
    joinRefusal: (name, g) => feed.joinRefusal(name, g),
    joinPlan: (name, g, acc) => feed.joinPlan(name, g, acc),
    joinWords: j => feed.joinWords(j),
    post: m => (laneMaySend(m) && !why() ? feed.post(m) === true : no(plainObj(m) && typeof m.type === 'string' ? m.type : 'not a message')),
    accountGroup: (name, group, highText, rules, useCid) => (typeof name === 'string' && name && (group === null || typeof group === 'string') && !why() ? feed.accountGroup(name, group, highText, rules, useCid) === true : no('accountGroup')),
    refused,
  };
  return Object.freeze(out);
}

/** Does ChartBridge's own answer to Kill all say something was not stopped? (PROP 1: then the tab marks it bad.) */
const badAnswer = text => /NOT STOPPED|FAILED|could NOT/.test(String(text || ''));
/** "09:41:07" of a Date (the PC's own clock), for the time in front of a Kill all answer. */
const clock = d => [d.getHours(), d.getMinutes(), d.getSeconds()].map(x => String(x).padStart(2, '0')).join(':');

return Object.freeze({ readableName, rosterFamilies, FILTERS, laneLock, laneMaySend, laneFeed, PICK_MIN, STAGES, lanes, outsideAuto, armState, armMsgs, armWords, pickChoices, pickMsg, maySend, KILL_MIN, SWITCH_MIN, DAYSTOP_MIN, ROSTER_MIN, ROSTER_FORMAT, LINEUP_FORMAT, CONFIRM_MS, ARM_MS, ANSWER_WAIT_MS, ROSTER_WAIT_MS, MAX_CARDS, MAX_MEMBERS, MAX_NOT_SHOWN, MODE_NAME, atLeast, usd, signed, stageCard, rosterCards, rosterProblem,
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
  const S = { shown: false, built: false, version: '', connected: false, signedIn: false, accounts: null, groups: null, agents: new Map(),
    ask: 0, askTimer: 0, hint: '', hintBad: false, hintState: false, answer: '', answerBad: false, cidSeq: 0, pending: '', pendingAt: 0, waitTimer: 0, sent: 0,
    armAsk: 0, armTimer: 0, armSaid: '', armBad: false, modeSent: new Map(), pickSent: new Map(),
    sub: 'setup', filter: 'all', find: '', famShut: new Set(), othersOpen: false, lanePanels: {},
    roster: { state: 'idle', text: '', cards: null, seq: 0, asked: 0, at: 0, version: '' }, rosterDirty: true, rosterTimer: 0, open: new Set(), drawn: {}, draws: { head: 0, roster: 0, traders: 0, accounts: 0, lanes: 0, 'lane-eval': 0, 'lane-funded': 0 } };
  const el = {};
  const agentList = () => [...S.agents.values()];
  const cid = () => 'fl' + (++S.cidSeq).toString(36) + Math.random().toString(36).slice(2, 6);
  const killState = () => C.killAllState(S.version, S.accounts, S.signedIn, S.connected);
  const laneList = () => C.lanes(agentList(), S.groups, S.accounts, S.version, S.roster.cards);
  const outside = ls => C.outsideAuto(ls, agentList(), S.accounts, S.version);
  const armNow = ls => C.armState(ls, S.version, S.signedIn, S.connected, S.accounts, S.groups, S.agents.size > 0, outside(ls));

  function onMessage(m) {
    switch (m && m.type) {
      case 'hello': S.version = typeof m.version === 'string' ? m.version : ''; S.connected = true; offer(); if (S.shown) helloRoster(); break;
      case 'trading': S.signedIn = !!m.enabled; break;
      case 'accounts': S.accounts = m; break;
      case 'groups': S.groups = m; break;
      case 'agent': if (m && typeof m.agent === 'string') S.agents.set(m.agent, m); break;
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
    S.connected = false; S.signedIn = false; S.agents.clear(); S.accounts = null; S.groups = null;
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
      <div class="fl-srow"><span class="fl-sname">${esc(r.readable)} <span class="fl-mut">risk ${esc(C.usd(r.riskEval))} eval, ${esc(C.usd(r.riskFunded))} funded${r.where ? ' · on the ' + esc(r.where) + ' today' : ''}</span>${live}${c.quick ? '<span class="fl-tag" data-kind="quick">Quick look: never traded</span>' : ''}</span>
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

  function traderHtml(t) {
    const sw = t.switchesKnown
      ? `<span class="fl-sw${t.marketEntry ? ' on' : ''}">Market entry: ${t.marketEntry ? 'on' : 'off'}</span><span class="fl-sw${t.noTarget ? ' on' : ''}">No target: ${t.noTarget ? 'on' : 'off'}</span>`
      : `<span class="fl-sw">Entry switches: need ChartBridge ${esc(C.SWITCH_MIN)}</span>`;
    const ds = !t.dayStopKnown ? 'needs ChartBridge ' + esc(C.DAYSTOP_MIN) : t.dayStop !== null ? esc(C.usd(t.dayStop)) + ' (from its plan)' : 'none sent with a plan this session';
    const kind = { prop: 'prop', propsim: 'prop and sim', personal: 'personal', sim: 'sim', unlisted: 'not listed in NinjaTrader now', mixed: 'personal and prop: Kill all will not stop it' }[t.kind] || '';
    return `<li class="fl-trader" data-id="${esc(t.id)}" data-tone="${esc(t.tone)}">
      <div class="fl-trow"><span class="fl-tname">${esc(t.name)}</span>${t.build ? `<span class="fl-mut">${esc(t.build)}</span>` : ''}
        <span class="fl-mode" data-mode="${esc(t.mode)}">${esc(t.modeText)}</span>${t.autoProp ? '<span class="fl-auto">AUTO ON PROP</span>' : ''}</div>
      <div class="fl-trow"><span class="fl-k">Account</span><span class="fl-v">${esc(t.accountText)}${kind ? ` <span class="fl-tag" data-kind="${esc(t.kind)}">${esc(kind)}</span>` : ''}</span></div>
      <div class="fl-trow"><span class="fl-k">Window</span><span class="fl-v mono">${t.window ? esc(t.window) + ' New York' + (t.flatAt ? ', flat at ' + esc(t.flatAt) : '') : 'not known'}</span></div>
      <div class="fl-trow"><span class="fl-k">Now</span><span class="fl-v fl-status">${esc(t.status)}</span></div>
      <div class="fl-trow"><span class="fl-k">Day stop</span><span class="fl-v mono">${ds}</span></div>
      <div class="fl-trow fl-sws">${sw}</div>
    </li>`;
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
  /* the traders on no lane (the old runners in Shadow and any other program on the agent channel), folded: a trader on a lane
     shows on its lane */
  function tradersHtml(rows, ls) {
    const onLane = new Set([].concat.apply([], (ls || []).map(l => l.traders)));
    const rest = rows.filter(t => !onLane.has(t.id));
    return `<div class="fl-trow"><h3 class="fl-h fl-hsmall">Other connections (${rest.length})</h3><span class="fl-mut">Programs on ChartBridge's agent channel that are on no lane. Kill all still stops those on prop accounts.</span><span class="fl-fill"></span>
        ${rest.length ? `<button type="button" class="fl-pill" data-do="others" aria-expanded="${S.othersOpen}">${S.othersOpen ? 'Hide' : 'Show'}</button>` : ''}</div>
      ${!rest.length ? `<p class="fl-empty">${S.connected ? 'None.' : 'ChartBridge is not connected.'}</p>` : S.othersOpen ? `<ul class="fl-traders">${rest.map(traderHtml).join('')}</ul>
      <p class="fl-note">A trader's mode, account, window and its two entry switches are changed on the Agent tab, by you. Nothing here changes them.</p>` : ''}`;
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
        <section class="fl-box fl-today" aria-label="Today"><div class="fl-btitle"><h3 class="fl-h">Today</h3><span class="fl-sub2">Drop an account into a lane. Pick the bot for the lane. Flip Armed.</span></div>
          <div class="fl-lanegrid"><div data-k="lane-eval"></div><div data-k="lane-funded"></div></div><div data-k="lanes"></div></section>
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
        <section class="fl-box fl-others" aria-label="Other connections"><div data-k="traders"></div></section>
      </div>
      <div class="fl-page" data-k="live" hidden>
        <section class="fl-box" aria-label="Prop accounts"><div data-k="accounts"></div></section>
        <p class="fl-later">Legion Live (the tiles, one chart with each lane's marks, each trader's day, the accounts by group) is the next change. Until then this page shows the prop accounts as before.</p>
      </div>
    </div>`;
    for (const k of ['autoline', 'ask', 'kill', 'yes', 'no', 'hint', 'answer', 'roster', 'traders', 'accounts', 'lanes', 'lane-eval', 'lane-funded', 'arm', 'armyes', 'armno', 'armsaid', 'armask', 'setup', 'live', 'allbtn']) el[k] = view.querySelector('[data-k="' + k + '"]');
    el.cancel = view.querySelector('[data-do="no"]');
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
    const locked = () => { const now = laneList().find(x => x.stage === stage); return C.laneLock(now) || (!S.connected ? 'ChartBridge is not connected' : ''); };
    let mount = null;
    try { mount = o.lanePanel(host, 'legion-' + stage, { group: l.groupId, locked }); } catch (e) { mount = null; }
    if (!mount) return null;
    S.lanePanels[stage] = { groupId: l.groupId, host, mount };
    return S.lanePanels[stage];
  }
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
  function laneHtml(l, choices) {
    const none = !l.id;
    const opts = [{ file: '', text: 'None' }].concat(choices);
    if (l.pick && !choices.some(c => c.file === l.pick)) opts.push({ file: l.pick, text: l.pickText + ' (not offered now)' });
    const locked = l.auto ? 'Switch Armed off first: the pick changes only while the lane is not in Auto' : l.exposed ? 'The trader holds something: the pick changes once it is flat' : !l.pickKnown ? 'The pick needs ChartBridge ' + C.PICK_MIN : '';
    const sel = none ? '' : `<label class="fl-k" for="flPick-${esc(l.stage)}">Bot</label><select class="fl-pick" id="flPick-${esc(l.stage)}" data-do="pick" data-agent="${esc(l.id)}"${locked ? ` disabled title="${esc(locked)}"` : ''}>${opts.map(c => `<option value="${esc(c.file)}"${c.file === l.pick ? ' selected' : ''}>${esc(c.text)}</option>`).join('')}</select>`;
    const c = l.card, st = c ? c.stages[l.stage === 'eval' ? 0 : 1] : null, today = none ? null : laneToday(l);
    const card = none ? '' : c ? `<div class="fl-botcard">
        <div class="fl-trow"><span class="fl-tname">${esc(C.readableName(c.name))}</span><span class="fl-who" data-who="bot">${c.kind === 'lineup' ? 'LINEUP' : 'BOT'}</span><span class="fl-fill"></span><span class="fl-mut mono">risk ${esc(C.usd(st.risk))} a trade</span></div>
        <div class="fl-trow"><span class="fl-status">${esc(l.status)}</span><span class="fl-fill"></span>${today === null ? '<span class="fl-mut">today not known</span>' : `<span class="mono fl-pnl${today > 0 ? ' up' : today < 0 ? ' down' : ''}">${esc(C.usd(today, true))}</span>`}</div>
        ${c.kind === 'lineup' ? `<p class="fl-line fl-mutline">${esc(c.bots.map(b => C.readableName(b.name)).join(', '))}: one open trade at a time, the first listed wins a tie.</p>` : ''}</div>`
      : '<div class="fl-slot">No bot is picked for this lane. A second bot on a lane comes as a lineup file from the Lab.</div>';
    return `<div class="fl-lane" data-stage="${esc(l.stage)}" data-armable="${l.armable}"${l.auto ? ' data-auto="1"' : ''}>
      <div class="fl-trow"><span class="fl-lanetitle"><span class="fl-dot" data-stage="${esc(l.stage)}"></span>${esc(l.title)}</span><span class="fl-mut">${l.stage === 'eval' ? 'Goal: pass the eval' : 'Goal: reach the payout'}</span>
        <span class="fl-fill"></span>${none ? '' : `<span class="fl-mode" data-mode="${esc(l.mode)}">${esc(l.modeText)}</span>`}<span class="fl-tag" data-kind="${l.armable ? 'live' : 'notlive'}">${l.armable ? 'Ready' : 'Not ready'}</span></div>
      ${none ? '' : `<div class="fl-trow"><span class="fl-mut">${esc(l.name)}, group ${esc(l.groupName)}</span>${l.sim ? '<span class="fl-tag" data-kind="sim">Sim: no money at stake</span>' : ''}</div><div class="fl-trow">${sel}</div>${card}`}
      ${l.why ? `<p class="fl-line fl-warn fl-lanewhy">${esc(l.why)}</p>` : ''}
      ${!none && l.runnerNote && l.armable ? `<p class="fl-line fl-mutline">${esc(l.runnerNote)}</p>` : ''}
      ${none ? '' : `<div class="fl-lanepanels" data-panel="${esc(l.stage)}">${typeof o.lanePanel === 'function' ? '' : '<p class="fl-mut">The accounts of this lane show here when the page is open with its accounts part.</p>'}</div>`}
    </div>`;
  }
  /* each lane is drawn on its own (the review of 94, note 3): a change in one never takes an open pick list away in the other */
  function lanesHtml(ls) {
    for (const l of ls) lanePanelFor(l);
    for (const stage of Object.keys(S.lanePanels)) { const l = ls.find(x => x.stage === stage); if (!l || !l.groupId) { try { S.lanePanels[stage].mount.destroy(); } catch (e) { /* gone */ } delete S.lanePanels[stage]; } }
    return `<p class="fl-note">A lane is a trader whose account is a group; the group's Type (eval or funded) says which lane. Its accounts are that group, with the Multi-Account panel's own lanes and bench: drag or click an account in or out. No account moves while the lane is in Auto or holds something. Accounts no bot may touch stay on the bench. Armed sends each ready lane to Auto; off sends every lane to Shadow. What shows here is what ChartBridge says, so a mode changed on the Agent tab, by Kill all or at 17:00 New York shows here too. Off closes no position: Kill all does.</p>`;
  }
  function renderSub() {
    setHidden(el.setup, S.sub !== 'setup'); setHidden(el.live, S.sub !== 'live');
    if (view && typeof view.querySelectorAll === 'function') for (const b of view.querySelectorAll('[data-do="sub"]')) b.setAttribute('aria-pressed', String(b.dataset.sub === S.sub));
    if (view && typeof view.querySelectorAll === 'function') for (const b of view.querySelectorAll('[data-do="filter"]')) b.setAttribute('aria-pressed', String(b.dataset.filter === S.filter));
    const total = S.roster.cards && S.roster.cards.ok ? S.roster.cards.bots.length + S.roster.cards.lineups.length : 0;
    setText(el.allbtn, 'All (' + total + ')');
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
    try { const choices = C.pickChoices(S.roster.cards); section('lanes', lanesHtml(ls)); for (const l of ls) section('lane-' + l.stage, laneHtml(l, choices)); placeLanePanels(); } catch (e) { section('lanes', '<p class="fl-empty fl-warn">The lanes could not be drawn.</p>'); }
    try { if (S.rosterDirty) { S.rosterDirty = false; section('roster', rosterHtml()); if (el.roster) el.roster.setAttribute('data-state', S.roster.state); } } catch (e) { section('roster', '<p class="fl-empty fl-warn">The roster could not be drawn.</p>'); }
    try { renderSub(); } catch (e) { /* the pages are already there */ }
    try { section('traders', tradersHtml(rows, ls)); } catch (e) { section('traders', '<p class="fl-empty fl-warn">The traders could not be drawn.</p>'); }
    try { section('accounts', accountsHtml(C.propAccounts(S.accounts, S.groups, agentList()))); } catch (e) { section('accounts', '<p class="fl-empty fl-warn">The prop accounts could not be drawn.</p>'); }
  }
  function onClick(e) {
    const b = e.target && e.target.closest ? e.target.closest('button[data-do]') : null;
    if (!b) return;
    const what = b.dataset.do;
    if (what === 'roster') { if (S.roster.state !== 'loading') loadRoster(); return; }
    if (what === 'sub') { const sub = b.dataset.sub === 'live' ? 'live' : 'setup'; if (sub !== S.sub) { S.sub = sub; render(); } return; }
    if (what === 'filter') { const f = String(b.dataset.filter || ''); if (C.FILTERS.includes(f) && f !== S.filter) { S.filter = f; S.rosterDirty = true; render(); } return; }
    if (what === 'fam') { const k = String(b.dataset.fam || ''); if (S.famShut.has(k)) S.famShut.delete(k); else S.famShut.add(k); S.rosterDirty = true; render(); return; }
    if (what === 'others') { S.othersOpen = !S.othersOpen; S.drawn.traders = null; render(); return; }
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
  function showTab(on) {
    on = !!on;
    if (on === S.shown) return;
    S.shown = on;
    if (tabBtn) { tabBtn.setAttribute('aria-pressed', String(on)); if (on) tabBtn.hidden = false; }
    if (!on) { endAsk(); endArmAsk(); dropLanePanels(); S.built = false; if (view) view.innerHTML = ''; offer(); }
    /* Escape cancels a question wherever the focus is while the tab is open (build answers 15, section 3) */
    if (DOC) { if (on) DOC.addEventListener('keydown', onKey, true); else DOC.removeEventListener('keydown', onKey, true); }
    if (typeof o.onTab === 'function') o.onTab(on);
    render();
    if (on) loadRoster();
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
      shown: S.shown, version: S.version, connected: S.connected, signedIn: S.signedIn, asking: S.ask > 0, hint: S.hint, answer: S.answer, answerBad: S.answerBad, pending: !!S.pending, sent: S.sent, draws: Object.assign({}, S.draws),
      traders: C.traders(agentList(), S.accounts, S.version), accounts: C.propAccounts(S.accounts, S.groups, agentList()),
      roster: { state: S.roster.state, text: S.roster.text, asked: S.roster.asked, bots: S.roster.cards ? S.roster.cards.bots.map(c => c.name) : [], lineups: S.roster.cards ? S.roster.cards.lineups.map(c => c.name) : [], notShown: S.roster.cards ? S.roster.cards.notShown.length : 0 } }),
    reloadRoster: loadRoster,
    destroy: () => { dropLanePanels(); S.roster.seq++; clearTimeout(S.rosterTimer); clearTimeout(S.waitTimer); unlisten(); endAsk(); endArmAsk(); if (DOC) DOC.removeEventListener('keydown', onKey, true); if (view) { view.removeEventListener('click', onClick); view.removeEventListener('change', onChange); view.removeEventListener('input', onInput); view.removeEventListener('keydown', onKey); } },
  };
}
window.FleetView = { create };
})();
