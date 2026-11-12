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
 * Not in this cut, and said plainly on the tab: the pick of which bots run today on the eval and the funded accounts, the one
 * Armed slider (D2), and each bot's own state from the spec runner (B3).
 *
 * "Prop" is ChartBridge's word (`prop` on each row of the `accounts` message, 0.6.16): every live account that is not the
 * personal account Anthony picked. With no pick nothing is prop, and the tab says how to pick.
 *
 * Nothing here places an order. The one message it can send is `agentKillAllProp`. The one request it makes is GET /roster.
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
    name: b.bot, runsLive: b.runs_live, whyNot: b.runs_live ? '' : str(b.why_not, 400),
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
    const base = { file: name, quick, planText: planText(d.plan), stages };
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
  if (!accountsMsg || accountsMsg.personalNamed !== true) return { ok: false, why: 'No personal account is picked yet, so no account is prop: pick it on the Accounts tab (an account\'s settings, This is my personal account)' };
  return { ok: true, why: '' };
}
const killAllMsg = cid => Object.assign({ type: 'agentKillAllProp' }, cid ? { cid } : {});

/**
 * The line beside the title: every trader in Auto that Kill all counts, and which of them it will NOT stop (the review of
 * 92, PROP 3). It never says nobody is trading while a trader is in Auto on a group with the personal account in it, or on
 * an account NinjaTrader does not list now.
 */
function autoLine(rows) {
  const on = rows.filter(t => t.autoProp), nm = t => t.name + (t.connected ? '' : ' (its program is not connected now)');
  const plain = on.filter(t => t.kind === 'prop' || t.kind === 'propsim'), unl = on.filter(t => t.kind === 'unlisted'), mixed = on.filter(t => t.kind === 'mixed');
  const parts = [];
  if (plain.length) parts.push('In Auto on prop accounts: ' + plain.map(nm).join(', '));
  if (unl.length) parts.push('In Auto on an account NinjaTrader does not list now (Kill all stops it): ' + unl.map(nm).join(', '));
  if (mixed.length) parts.push('In Auto on a group with your personal account in it (Kill all will NOT stop it: stop it on the Agent tab): ' + mixed.map(nm).join(', '));
  if (parts.length) return parts.join('. ');
  return rows.length ? 'No trader is in Auto on a prop account' : 'No traders yet';
}
/** Does ChartBridge's own answer to Kill all say something was not stopped? (PROP 1: then the tab marks it bad.) */
const badAnswer = text => /NOT STOPPED|FAILED|could NOT/.test(String(text || ''));
/** "09:41:07" of a Date (the PC's own clock), for the time in front of a Kill all answer. */
const clock = d => [d.getHours(), d.getMinutes(), d.getSeconds()].map(x => String(x).padStart(2, '0')).join(':');

return { KILL_MIN, SWITCH_MIN, DAYSTOP_MIN, ROSTER_MIN, ROSTER_FORMAT, LINEUP_FORMAT, CONFIRM_MS, ARM_MS, ANSWER_WAIT_MS, ROSTER_WAIT_MS, MAX_CARDS, MAX_MEMBERS, MAX_NOT_SHOWN, MODE_NAME, atLeast, usd, signed, stageCard, rosterCards, rosterProblem,
  kindOf, seatsKind, dayMark, traderAccounts, statusText, traders, propAccounts, killAllState, killAllMsg, autoLine, badAnswer, clock };
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
 * THE QUESTION (STOP 1). A click on Kill all opens it in the same place, with CANCEL where the button was and Yes to its left.
 * No answer is taken for ARM_MS after it opens, and never from the second click of a double click (detail above 1), so a
 * double click anywhere on the button answers nothing. Yes counts only while the question is up and not older than CONFIRM_MS
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
    roster: { state: 'idle', text: '', cards: null, seq: 0, asked: 0, at: 0, version: '' }, rosterDirty: true, rosterTimer: 0, open: new Set(), drawn: {}, draws: { head: 0, roster: 0, traders: 0, accounts: 0 } };
  const el = {};
  const agentList = () => [...S.agents.values()];
  const cid = () => 'fl' + (++S.cidSeq).toString(36) + Math.random().toString(36).slice(2, 6);
  const killState = () => C.killAllState(S.version, S.accounts, S.signedIn, S.connected);

  function onMessage(m) {
    switch (m && m.type) {
      case 'hello': S.version = typeof m.version === 'string' ? m.version : ''; S.connected = true; offer(); if (S.shown) helloRoster(); break;
      case 'trading': S.signedIn = !!m.enabled; break;
      case 'accounts': S.accounts = m; break;
      case 'groups': S.groups = m; break;
      case 'agent': if (m && typeof m.agent === 'string') S.agents.set(m.agent, m); break;
      case 'reject': if (S.pending && m.cid === S.pending) answered(typeof m.reason === 'string' && m.reason ? 'ChartBridge refused Kill all: ' + m.reason : 'ChartBridge refused Kill all', true); break;
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
  /* One line a bot or a lineup (Anthony 2026-11-11: "detail should be there, but expandable when needed"): the name, whether
     it runs live, in-sample and the try count, and each stage's profit per $1 with the file's own word against no edge.
     Everything else (the file, the run, why not, the playbook, the ranges, a lineup's bots) opens under it with Details. */
  function stageShort(st) {
    return `<span class="fl-short" data-stage="${esc(st.stage)}"><span class="fl-stname">${esc(st.title)}</span> <span class="mono">${esc(C.signed(st.profitPerDollar))}</span> <span class="fl-tag" data-kind="${st.aboveNoEdge ? 'edge' : 'noedge'}">${esc(st.edgeText)}</span></span>`;
  }
  function cardHtml(c) {
    const open = S.open.has(c.kind + ':' + c.name);
    const live = c.runsLive ? '<span class="fl-tag" data-kind="live">Runs live</span>' : '<span class="fl-tag" data-kind="notlive">Does not run live</span>';
    let more = '';
    if (open) {
      const shown = c.kind === 'lineup' ? c.bots.slice(0, C.MAX_MEMBERS) : [];
      const members = c.kind === 'lineup' ? `<ol class="fl-members">${shown.map(b => `<li><span class="fl-mname">${esc(b.name)}</span> <span class="fl-mut">took ${b.taken}, skipped ${b.skipped}${b.sessionsLeftOut ? ', ' + b.sessionsLeftOut + ' of its sessions left out' : ''}; ${esc(b.recordText)}</span></li>`).join('')}</ol>
          ${c.bots.length > shown.length ? `<p class="fl-line fl-mutline">And ${c.bots.length - shown.length} more bots in this lineup, not drawn.</p>` : ''}
          <p class="fl-line fl-mutline">${esc(c.joinedText)}. One playbook for the lineup; the bot listed first takes a tie.</p>` : `<p class="fl-line fl-mutline">${esc(c.recordText)}</p>${c.verdictText ? `<p class="fl-line fl-mutline fl-verdict">${esc(c.verdictText)}</p>` : ''}`;
      more = `<div class="fl-more">
        <p class="fl-line fl-mutline">File <span class="mono">${esc(c.file)}</span>, ${esc(c.planText)}</p>
        ${c.runsLive ? '' : `<p class="fl-line fl-warn">Why not: ${esc(c.whyNot)}</p>`}
        ${members}
        <div class="fl-stages">${c.stages.map(stageHtml).join('')}</div>
      </div>`;
    }
    return `<li class="fl-card" data-kind="${c.kind}" data-name="${esc(c.name)}"${c.runsLive ? '' : ' data-tone="notlive"'}${open ? ' data-open="1"' : ''}>
      <div class="fl-row"><span class="fl-tname">${esc(c.name)}</span><span class="fl-mut">${c.kind === 'lineup' ? 'Lineup of ' + c.bots.length : 'Bot'}</span>${live}${c.quick ? '<span class="fl-tag" data-kind="quick">Quick look: never traded</span>' : ''}
        <span class="fl-evidence">${esc(c.evidenceText)}</span><span class="fl-fill"></span>${c.stages.map(stageShort).join('')}
        <button type="button" class="ws-btn fl-morebtn" data-do="more" data-card="${esc(c.kind + ':' + c.name)}" aria-expanded="${open}">${open ? 'Hide' : 'Details'}</button></div>
      ${more}
    </li>`;
  }
  function rosterHtml() {
    const R = S.roster, c = R.cards;
    let body;
    if (c && (c.bots.length || c.lineups.length || c.notShown.length)) {
      const all = c.lineups.concat(c.bots), cards = all.slice(0, C.MAX_CARDS), not = c.notShown.slice(0, C.MAX_NOT_SHOWN);
      body = (R.state === 'loading' ? '<p class="fl-empty">Reading the roster again...</p>' : '') +
        (cards.length ? `<ul class="fl-cards">${cards.map(cardHtml).join('')}</ul>` : '<p class="fl-empty">No roster file here can be shown.</p>') +
        (all.length > cards.length ? `<p class="fl-note">${all.length - cards.length} more cards not drawn (the tab draws ${C.MAX_CARDS} at most).</p>` : '') +
        (not.length ? `<ul class="fl-notshown">${not.map(x => `<li><span class="mono">${esc(x.name)}</span>: not shown, ${esc(x.why)}</li>`).join('')}</ul>` : '') +
        (c.notShown.length > not.length ? `<p class="fl-note">And ${c.notShown.length - not.length} more files not shown.</p>` : '') +
        (c.left ? `<p class="fl-note">${c.left} more file${c.left === 1 ? '' : 's'} in the folder not read (ChartBridge reads 200 at most).</p>` : '');
    } else if (R.state === 'ok') body = '<p class="fl-empty">The roster folder on this PC is empty. A bot shows here once the Lab has built its roster file and Bot-Lab is installed on this PC.</p>';
    else if (R.state === 'loading') body = '<p class="fl-empty">Reading the roster...</p>';
    else if (R.state === 'idle') body = `<p class="fl-empty">${S.connected ? 'The roster is not read yet.' : 'ChartBridge is not connected.'}</p>`;
    else body = `<p class="fl-empty${R.state === 'error' ? ' fl-warn' : ''}">${esc(R.text)}</p>`;
    return `<div class="fl-trow"><h3 class="fl-h">Roster</h3><span class="fl-fill"></span>
        <button type="button" class="ws-btn" data-do="roster"${R.state === 'loading' ? ' aria-disabled="true"' : ''}>Read again</button></div>
      ${body}
      <p class="fl-note">The number on each line is profit per $1. Every number is from in-sample runs, and none is a promise. "No edge" is what the same trades would show with their edge taken out, so only a number above that range says anything. Details shows the rest.</p>`;
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
  function tradersHtml(rows) {
    return `<h3 class="fl-h">Traders</h3>
      ${rows.length ? `<ul class="fl-traders">${rows.map(traderHtml).join('')}</ul>` : `<p class="fl-empty">${S.connected ? 'No trader is set up in ChartBridge yet.' : 'ChartBridge is not connected.'}</p>`}
      <p class="fl-note">A trader's mode, account, window and its two entry switches are changed on the Agent tab, by you. Nothing here changes them.</p>`;
  }
  function accountsHtml(accts) {
    return `<h3 class="fl-h">Prop accounts</h3>
      ${accts.length ? `<div class="fl-scroll"><table class="fl-table"><thead><tr><th>Account</th><th>Progress</th><th>Cushion to floor</th><th>Today</th><th>Day stop</th><th>Status</th></tr></thead>
          <tbody>${accts.map(accountHtml).join('')}</tbody></table></div>`
        : `<p class="fl-empty">${!S.connected ? 'ChartBridge is not connected.' : S.accounts && S.accounts.personalNamed === true ? 'No prop account is connected.' : 'No personal account is picked yet, so no account is prop. Pick it once on the Accounts tab: an account\'s settings, This is my personal account.'}</p>`}
      <p class="fl-note">Today counts realized plus open. The day stop is held by ChartBridge itself: reached while a trader holds something on the account, that trader is flattened and stops until 18:00 New York.</p>`;
  }

  /* built once for each time the tab opens; nothing in the head is ever replaced after that */
  function build() {
    view.innerHTML = `<div class="fl-wrap">
      <div class="fl-top"><div class="fl-head">
        <span class="fl-title">Legion</span><span class="fl-autoline" data-k="autoline"></span><span class="fl-fill"></span>
        <span class="fl-ask" data-k="ask" role="alertdialog" aria-label="Kill all" hidden><span data-k="askText">Close every trader's position on the prop accounts and stop them?</span>
          <button type="button" class="ws-btn fl-kill" data-do="yes">Yes, kill all</button><button type="button" class="ws-btn fl-cancel" data-do="no">Cancel</button></span>
        <button type="button" class="ws-btn fl-kill" data-do="ask" data-k="kill">Kill all: flatten and stop</button>
      </div>
      <p class="fl-said" data-k="hint" role="status" aria-live="polite"></p>
      <p class="fl-answer" data-k="answer" role="status" aria-live="polite" hidden></p></div>
      <section class="fl-box fl-roster" aria-label="Roster" data-k="roster"></section>
      <div class="fl-cols">
        <section class="fl-box" aria-label="Traders" data-k="traders"></section>
        <section class="fl-box" aria-label="Prop accounts" data-k="accounts"></section>
      </div>
      <p class="fl-later">Not built yet, so not shown: the pick of which bots run today on the eval accounts and on the funded accounts, the one Armed slider, and each bot's own state from the runner. Until then nothing on this tab starts a bot: a trader's mode is changed on the Agent tab.</p>
    </div>`;
    for (const k of ['autoline', 'ask', 'kill', 'hint', 'answer', 'roster', 'traders', 'accounts']) el[k] = view.querySelector('[data-k="' + k + '"]');
    el.cancel = view.querySelector('[data-do="no"]');
    S.built = true; S.drawn = {}; S.rosterDirty = true;
  }
  const setText = (e, t) => { if (e && e.textContent !== t) e.textContent = t; };
  const setHidden = (e, h) => { if (e && e.hidden !== h) e.hidden = h; };
  function section(key, html) {
    if (S.drawn[key] === html || !el[key]) return;
    S.drawn[key] = html; el[key].innerHTML = html; S.draws[key]++;
  }
  function renderHead(rows) {
    const st = killState(), asking = S.ask > 0;
    setText(el.autoline, C.autoLine(rows));
    setHidden(el.ask, !asking); setHidden(el.kill, asking);
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
    try { if (S.rosterDirty) { S.rosterDirty = false; section('roster', rosterHtml()); if (el.roster) el.roster.setAttribute('data-state', S.roster.state); } } catch (e) { section('roster', '<p class="fl-empty fl-warn">The roster could not be drawn.</p>'); }
    try { section('traders', tradersHtml(rows)); } catch (e) { section('traders', '<p class="fl-empty fl-warn">The traders could not be drawn.</p>'); }
    try { section('accounts', accountsHtml(C.propAccounts(S.accounts, S.groups, agentList()))); } catch (e) { section('accounts', '<p class="fl-empty fl-warn">The prop accounts could not be drawn.</p>'); }
  }
  function onClick(e) {
    const b = e.target && e.target.closest ? e.target.closest('button[data-do]') : null;
    if (!b) return;
    const what = b.dataset.do;
    if (what === 'roster') { if (S.roster.state !== 'loading') loadRoster(); return; }
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
    if (what !== 'yes' && what !== 'no') return;
    if (!S.ask) return;
    const age = now() - S.ask;
    if (age > C.CONFIRM_MS) { endAsk(); render(); return; }                 // the 8 seconds, by the clock (PROP 6)
    if (what === 'no' && !realClick(e)) { endAsk(); hint('', false); render(); return; }   // Cancel by the keyboard: always
    if (what === 'yes' && !realClick(e)) { hint('Kill all is confirmed by a click on Yes only, not by keyboard. Cancel and Escape work from the keyboard.', true); render(); return; }
    if (e.detail > 1 || age < C.ARM_MS) return;                             // a double click, or too soon: no answer (STOP 1)
    if (what === 'yes') killAll();
    else { endAsk(); hint('', false); render(); }
  }
  function showTab(on) {
    on = !!on;
    if (on === S.shown) return;
    S.shown = on;
    if (tabBtn) { tabBtn.setAttribute('aria-pressed', String(on)); if (on) tabBtn.hidden = false; }
    if (!on) { endAsk(); S.built = false; if (view) view.innerHTML = ''; offer(); }
    if (typeof o.onTab === 'function') o.onTab(on);
    render();
    if (on) loadRoster();
  }
  function onKey(e) { if (e && e.key === 'Escape' && S.ask) { endAsk(); hint('', false); render(); if (typeof e.preventDefault === 'function') e.preventDefault(); } }
  if (view) view.addEventListener('click', onClick);
  if (view) view.addEventListener('keydown', onKey);
  if (tabBtn) tabBtn.addEventListener('click', () => showTab(!S.shown));
  const unlisten = V3 ? V3.listen({ message: onMessage, closed: () => lost() }) : () => {};
  return {
    showTab, shown: () => S.shown, offered: () => !!tabBtn && !tabBtn.hidden,
    hello: m => onMessage(m),
    state: () => ({ shown: S.shown, version: S.version, connected: S.connected, signedIn: S.signedIn, asking: S.ask > 0, hint: S.hint, answer: S.answer, answerBad: S.answerBad, pending: !!S.pending, sent: S.sent, draws: Object.assign({}, S.draws),
      traders: C.traders(agentList(), S.accounts, S.version), accounts: C.propAccounts(S.accounts, S.groups, agentList()),
      roster: { state: S.roster.state, text: S.roster.text, asked: S.roster.asked, bots: S.roster.cards ? S.roster.cards.bots.map(c => c.name) : [], lineups: S.roster.cards ? S.roster.cards.lineups.map(c => c.name) : [], notShown: S.roster.cards ? S.roster.cards.notShown.length : 0 } }),
    reloadRoster: loadRoster,
    destroy: () => { S.roster.seq++; clearTimeout(S.rosterTimer); clearTimeout(S.waitTimer); unlisten(); endAsk(); if (view) { view.removeEventListener('click', onClick); view.removeEventListener('keydown', onKey); } },
  };
}
window.FleetView = { create };
})();
