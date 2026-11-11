/*
 * The Bots tab (chart 1.45.0; build answers 7, part D1): the Prop Business on the chart page. One place for the roster (the
 * bots and lineups the Lab built, with their numbers), the traders (the slots on ChartBridge's agent channel) and the prop
 * accounts they trade. It was drafted as "Fleet" (the file and the fl- names keep that word); on screen it is Bots.
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
const CONFIRM_MS = 8000;         // the Kill all question stays this long
const MODE_NAME = { shadow: 'Shadow', copilot: 'Copilot', auto: 'Auto' };
const isNum = v => typeof v === 'number' && isFinite(v);
const plainObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n || 200) : '');

function parseVersion(v) { const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')); return m ? [+m[1], +m[2], +m[3]] : null; }
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
 * The traders, one row each, in id order. agents: the `agent` messages (a list); accountsMsg; version: ChartBridge's.
 * -> [{ id, name, build, mode, modeText, connected, onDuty, status, tone, accounts, accountText, kind, window, flatAt,
 *       marketEntry, noTarget, switchesKnown, dayStop, dayStopKnown, pnlToday, trades }]
 * onDuty: in Auto, connected, not killed, not stood down, on prop accounts only: it can place an order now.
 */
function traders(agents, accountsMsg, version) {
  const idx = accountIndex(accountsMsg);
  const out = [];
  for (const a of (Array.isArray(agents) ? agents : [])) {
    if (!plainObj(a) || typeof a.agent !== 'string') continue;
    const names = traderAccounts(a);
    const kinds = names.map(n => kindOf(idx.get(n.toLowerCase())));
    const kind = !names.length ? 'none' : kinds.every(k => k === 'prop') ? 'prop' : kinds.every(k => k === 'personal') ? 'personal' : kinds.every(k => k === 'sim') ? 'sim' : kinds.some(k => k === '') ? '' : 'mixed';
    const r = plainObj(a.rules) ? a.rules : {};
    const mode = MODE_NAME[a.mode] ? a.mode : '';
    const live = a.enabled !== false && a.connected === true && !a.killed && !a.standDown;
    out.push({
      id: a.agent, name: str(a.name, 40) || a.agent, build: str(a.build, 40), mode, modeText: MODE_NAME[mode] || 'Not known',
      connected: a.connected === true, onDuty: live && mode === 'auto' && kind === 'prop',
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
 * stage: 'eval', 'funded' or '' (its group has no Type, or it is in no group: the runner sizes it 0 and Fleet says so).
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
const pct = v => (isNum(v) ? Math.round(v * 100) + '%' : '');
const count = v => (Number.isInteger(v) && v >= 0 ? v : null);
const one = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

/** One stage of a roster file as the tab shows it, or null when the file's playbook or numbers are not in the format's shape. */
function stageCard(d, stage) {
  const pb = plainObj(d.playbook) ? d.playbook[stage] : null, n = plainObj(d.numbers) ? d.numbers[stage] : null;
  if (!plainObj(pb) || !plainObj(n) || !isNum(pb.risk_dollars) || pb.risk_dollars <= 0 || !isNum(n.profit_per_dollar)) return null;
  const ne = n.no_edge, r = n.range95;
  if (!plainObj(ne) || !isNum(ne.median) || !isNum(ne.p5) || !isNum(ne.p95) || typeof n.above_no_edge !== 'boolean') return null;
  const opt = v => (isNum(v) && v > 0 ? v : null);
  const out = {
    stage, title: stage === 'eval' ? 'Eval' : 'Funded',
    risk: pb.risk_dollars, dayLoss: opt(pb.daily_loss_stop), dayProfit: opt(pb.daily_profit_stop), maxTrades: opt(pb.max_trades),
    payoutAt: stage === 'funded' ? opt(pb.payout_at) : null,
    profitPerDollar: n.profit_per_dollar, range: Array.isArray(r) && isNum(r[0]) && isNum(r[1]) ? [r[0], r[1]] : null,
    noEdge: { median: ne.median, p5: ne.p5, p95: ne.p95 }, aboveNoEdge: n.above_no_edge,
    notSearchedOn: isNum(n.not_searched_on) ? n.not_searched_on : null,
  };
  out.playbookText = 'Risk ' + usd(out.risk) + ' a trade; day loss stop ' + (out.dayLoss === null ? 'none' : usd(out.dayLoss)) + '; day profit stop ' + (out.dayProfit === null ? 'none' : usd(out.dayProfit)) +
    '; ' + (out.maxTrades === null ? 'no cap on trades a day' : 'at most ' + one(out.maxTrades, 'trade') + ' a day') + (stage === 'funded' ? '; payout ' + (out.payoutAt === null ? 'not set' : 'at ' + usd(out.payoutAt)) : '');
  out.profitText = 'Profit per $1: ' + signed(out.profitPerDollar) + (out.range ? ' (95%: ' + signed(out.range[0]) + ' to ' + signed(out.range[1]) + ')' : '');
  out.noEdgeText = 'No edge would show ' + signed(ne.median) + ' (5th to 95th: ' + signed(ne.p5) + ' to ' + signed(ne.p95) + ')';
  out.edgeText = out.aboveNoEdge ? 'Above no edge' : 'Not above no edge';
  out.heldBackText = 'On the sessions not searched: ' + (out.notSearchedOn === null ? 'none were held back' : signed(out.notSearchedOn));
  if (stage === 'eval') out.stageText = (isNum(n.eval_pass) ? 'Passes ' + pct(n.eval_pass) + ' of evals' : 'Pass rate not known') + (isNum(n.sessions_to_pass) ? ', in ' + n.sessions_to_pass + ' sessions (median)' : '');
  else out.stageText = (isNum(n.paid_per_funded) ? 'Paid ' + usd(n.paid_per_funded) + ' per funded account' : 'Paid per funded account not known') + (isNum(n.share_paid) ? '; ' + pct(n.share_paid) + ' reach a payout' : '') +
    (isNum(n.sessions_to_first_payout) ? ', the first in ' + n.sessions_to_first_payout + ' sessions (median)' : '');
  return out;
}
/** A bot's part (its own file, or one row of a lineup's `bots`): the name, whether it runs live and why not, its run. Or null. */
function botPart(b) {
  if (!plainObj(b) || typeof b.bot !== 'string' || !NAME_RX.test(b.bot) || typeof b.runs_live !== 'boolean' || !plainObj(b.record) || typeof b.record.run_id !== 'string') return null;
  const r = b.record, sess = count(r.sessions), trades = count(r.trades), tries = count(r.try);
  return {
    name: b.bot, runsLive: b.runs_live, whyNot: b.runs_live ? '' : str(b.why_not, 400) || 'the file does not say why',
    runId: str(r.run_id, 80), sessions: sess, trades, tries, instrument: str(r.instrument, 12), verdict: str(r.verdict, 200),
    recordText: 'Run ' + str(r.run_id, 80) + ': ' + (sess === null ? 'sessions not known' : one(sess, 'session')) + ', ' + (trades === null ? 'trades not known' : one(trades, 'trade')) + (str(r.instrument, 12) ? ', ' + str(r.instrument, 12) : ''),
    /* a roster/1 file carries no confirmation on locked weeks: every number in it is in-sample (build answers 8, section 4) */
    evidenceText: 'In-sample, not confirmed' + (tries === null ? '; try count not known' : '; try ' + tries),
  };
}
const planText = p => (plainObj(p) && typeof p.size === 'string' && typeof p.dll === 'boolean' ? str(p.size, 8) + (p.dll ? ' with the daily loss limit' : ' without the daily loss limit') : 'plan not known');

/**
 * The body of GET /roster as the tab shows it. body: the parsed JSON ({ files: [{ name, ok, roster | why }], left }).
 * -> { ok, why, bots: [card], lineups: [card], notShown: [{ name, why }], left }
 * A card: { kind: 'bot' | 'lineup', file, name, runsLive, whyNot, quick, planText, stages: [eval, funded], ... } and, for a bot,
 * its botPart; for a lineup, bots: [botPart + { taken, skipped, sessionsLeftOut }] in the lineup's order and joinedText.
 * The tab is not Bot-Lab's strict reader: a file whose shape it cannot show is listed under notShown with why, never half shown.
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
    const quick = plainObj(d.counts) && d.counts.quick === true;
    const base = { file: name, quick, planText: planText(d.plan), stages };
    if (d.format === ROSTER_FORMAT) {
      const b = botPart(d);
      if (!b) { no('its bot, its run or whether it runs live is not in the format\'s shape'); continue; }
      out.bots.push(Object.assign({ kind: 'bot' }, base, b));
    } else {
      const parts = Array.isArray(d.bots) ? d.bots.map(x => { const b = botPart(x); return b && Object.assign(b, { taken: count(x.taken), skipped: count(x.skipped), sessionsLeftOut: count(x.sessions_left_out) }); }) : [];
      if (typeof d.lineup !== 'string' || !NAME_RX.test(d.lineup) || parts.length < 2 || parts.some(b => !b) || typeof d.runs_live !== 'boolean') { no('its name or its bots are not in the format\'s shape'); continue; }
      const j = plainObj(d.joined) ? d.joined : {};
      const stopped = parts.filter(b => !b.runsLive);
      out.lineups.push(Object.assign({ kind: 'lineup' }, base, {
        name: d.lineup, bots: parts,
        /* the lineup runs live only when the file says so AND every bot in it does: the stricter of the two */
        runsLive: d.runs_live === true && !stopped.length,
        whyNot: stopped.length ? stopped.map(b => b.name + ': ' + b.whyNot).join('; ') : d.runs_live ? '' : 'the file says the lineup does not run live',
        joinedText: (count(j.sessions) === null ? 'sessions in common not known' : one(j.sessions, 'session') + ' in common') + ', ' + (count(j.trades) === null ? 'trades not known' : one(j.trades, 'trade') + ' taken') +
          ', ' + (count(j.skipped) === null ? 'skips not known' : j.skipped + ' skipped because another bot\'s trade was open'),
        evidenceText: 'In-sample, not confirmed; tries: ' + parts.map(b => b.name + ' ' + (b.tries === null ? 'not known' : b.tries)).join(', '),
      }));
    }
  }
  const byName = (x, y) => (x.name.toLowerCase() < y.name.toLowerCase() ? -1 : x.name.toLowerCase() > y.name.toLowerCase() ? 1 : 0);
  out.bots.sort(byName); out.lineups.sort(byName);
  return out;
}
/** Why the roster is not shown, for an answer of GET /roster that is not 200 (0: the request itself failed). */
function rosterProblem(status, error) {
  if (status === 404) return 'No roster folder is set on this PC. It is one line in ChartBridge\'s config.txt (rosterFolder), filled in when Bot-Lab is installed here.';
  if (status === 403) return 'ChartBridge serves the roster only to a page opened by the localhost name. Open the chart page as localhost, not by a number.';
  if (status === 500) return 'ChartBridge could not read the roster folder' + (str(error, 200) ? ': ' + str(error, 200) : '') + '.';
  if (status === 0) return 'The roster could not be asked for: ChartBridge did not answer.';
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

/** The line under the title: who can place an order now. */
function dutyLine(rows) {
  const on = rows.filter(t => t.onDuty);
  if (on.length > 1) return 'On duty: ' + on.map(t => t.name).join(', ') + ' (more than one trader in Auto on prop accounts)';
  if (on.length === 1) return 'On duty: ' + on[0].name + ', Auto on ' + on[0].accountText;
  return rows.length ? 'Nobody on duty: no trader is in Auto on prop accounts' : 'No traders yet';
}

return { KILL_MIN, SWITCH_MIN, DAYSTOP_MIN, ROSTER_MIN, ROSTER_FORMAT, LINEUP_FORMAT, CONFIRM_MS, MODE_NAME, atLeast, usd, signed, stageCard, rosterCards, rosterProblem, kindOf, dayMark, traderAccounts, statusText, traders, propAccounts, killAllState, killAllMsg, dutyLine };
});

/* ================================================================================================ the tab (browser only) */
(function () {
'use strict';
if (typeof window === 'undefined' || typeof document === 'undefined') return;
const C = window.FleetCore;
const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function create(o) {
  o = o || {};
  const view = o.view || null, tabBtn = o.tab || null, V3 = o.v3 || null;
  const S = { shown: false, version: '', connected: false, signedIn: false, accounts: null, groups: null, agents: new Map(), ask: 0, askTimer: 0, said: '', saidBad: false, saidState: false, cidSeq: 0, pending: '', sent: 0,
    roster: { state: 'idle', text: '', cards: null, seq: 0, asked: 0 } };
  const agentList = () => [...S.agents.values()];
  const cid = () => 'fl' + (++S.cidSeq).toString(36) + Math.random().toString(36).slice(2, 6);

  function onMessage(m) {
    switch (m && m.type) {
      case 'hello': S.version = typeof m.version === 'string' ? m.version : ''; S.connected = true; offer(); if (S.shown && S.roster.state !== 'loading') loadRoster(); break;
      case 'trading': S.signedIn = !!m.enabled; break;
      case 'accounts': S.accounts = m; break;
      case 'groups': S.groups = m; break;
      case 'agent': if (m && typeof m.agent === 'string') S.agents.set(m.agent, m); break;
      case 'reject': if (S.pending && m.cid === S.pending) { S.pending = ''; say(typeof m.reason === 'string' ? m.reason : 'ChartBridge refused it', true); } break;
      case 'status': if (typeof m.text === 'string' && /^Kill all \(prop accounts\)/.test(m.text)) { S.pending = ''; say(m.text, m.level === 'error'); } break;
      default: return;
    }
    if (S.saidState && C.killAllState(S.version, S.accounts, S.signedIn, S.connected).why !== S.said) say('', false);
    if (S.shown) render();
  }
  function lost() { S.roster.seq++; S.roster = { state: 'idle', text: '', cards: null, seq: S.roster.seq, asked: S.roster.asked }; S.connected = false; S.signedIn = false; S.agents.clear(); S.accounts = null; S.groups = null; S.pending = ''; say('', false); endAsk(); if (S.shown) render(); }
  /* the tab button shows with a ChartBridge that has prop accounts (0.6.17: Kill all) */
  function offer() { if (tabBtn) tabBtn.hidden = !C.atLeast(S.version, C.KILL_MIN); }
  /* fromState: the line only repeats why Kill all is not offered; it goes as soon as that reason does */
  function say(text, bad, fromState) { S.said = String(text || ''); S.saidBad = !!bad; S.saidState = !!fromState; }
  function endAsk() { clearTimeout(S.askTimer); S.askTimer = 0; S.ask = 0; }

  function killAll() {
    const st = C.killAllState(S.version, S.accounts, S.signedIn, S.connected);
    endAsk();
    if (!st.ok) { say(st.why, true, true); render(); return; }
    S.pending = cid();
    S.sent++;
    const ok = !!V3 && V3.post(C.killAllMsg(S.pending));
    say(ok ? 'Kill all sent: waiting for ChartBridge' : 'Kill all could not be sent: ChartBridge is not connected', !ok);
    if (!ok) S.pending = '';
    render();
  }

  /* The roster: one GET /roster (ChartBridge 0.6.20), when the tab opens, when ChartBridge says hello while it is open, and on
     Read again. Read only: nothing is sent about a file, and nothing here decides from one. A late answer of an older ask is dropped. */
  function loadRoster() {
    const R = S.roster, doFetch = typeof o.fetch === 'function' ? o.fetch : typeof fetch === 'function' ? fetch : null;
    if (!S.connected) { S.roster = { state: 'idle', text: '', cards: null, seq: R.seq + 1, asked: R.asked }; render(); return; }
    if (!C.atLeast(S.version, C.ROSTER_MIN)) { S.roster = { state: 'old', text: 'The roster needs ChartBridge ' + C.ROSTER_MIN + ' or later (this one is ' + (S.version || 'not known') + ').', cards: null, seq: R.seq + 1, asked: R.asked }; render(); return; }
    if (!doFetch) return;
    const seq = R.seq + 1;
    S.roster = { state: 'loading', text: '', cards: R.cards, seq, asked: R.asked + 1 };
    render();
    const done = (state, text, cards) => { if (S.roster.seq !== seq) return; S.roster = { state, text, cards: cards || null, seq, asked: S.roster.asked }; if (S.shown) render(); };
    const h = typeof o.headers === 'function' ? o.headers() : {};
    Promise.resolve().then(() => doFetch('/roster', { cache: 'no-store', headers: h || {} }))
      .then(r => {
        if (r.status === 200) return r.json().then(b => { const c = C.rosterCards(b); if (c.ok) done('ok', '', c); else done('error', c.why + '.'); });
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
  function cardHtml(c) {
    const live = c.runsLive ? '<span class="fl-tag" data-kind="live">Runs live</span>' : '<span class="fl-tag" data-kind="notlive">Does not run live</span>';
    const members = c.kind === 'lineup' ? `<ol class="fl-members">${c.bots.map(b => `<li><span class="fl-mname">${esc(b.name)}</span> <span class="fl-mut">took ${b.taken === null ? 'not known' : b.taken}, skipped ${b.skipped === null ? 'not known' : b.skipped}${b.sessionsLeftOut ? ', ' + b.sessionsLeftOut + ' of its sessions left out' : ''}; ${esc(b.recordText)}</span></li>`).join('')}</ol>
        <p class="fl-line fl-mutline">${esc(c.joinedText)}. One playbook for the lineup; the bot listed first takes a tie.</p>` : `<p class="fl-line fl-mutline">${esc(c.recordText)}${c.verdict ? '. ' + esc(c.verdict) : ''}</p>`;
    return `<li class="fl-card" data-kind="${c.kind}" data-name="${esc(c.name)}"${c.runsLive ? '' : ' data-tone="notlive"'}>
      <div class="fl-trow"><span class="fl-tname">${esc(c.name)}</span><span class="fl-mut">${c.kind === 'lineup' ? 'Lineup' : 'Bot'}, ${esc(c.planText)}</span>${live}${c.quick ? '<span class="fl-tag" data-kind="quick">Quick look: never traded</span>' : ''}</div>
      ${c.runsLive ? '' : `<p class="fl-line fl-warn">Why not: ${esc(c.whyNot)}</p>`}
      <p class="fl-line fl-evidence">${esc(c.evidenceText)}</p>${members}
      <div class="fl-stages">${c.stages.map(stageHtml).join('')}</div>
    </li>`;
  }
  function rosterHtml() {
    const R = S.roster, c = R.cards;
    let body;
    if (c && (c.bots.length || c.lineups.length || c.notShown.length)) {
      body = (c.bots.length || c.lineups.length ? `<ul class="fl-cards">${c.lineups.concat(c.bots).map(cardHtml).join('')}</ul>` : '<p class="fl-empty">No roster file here can be shown.</p>') +
        (c.notShown.length ? `<ul class="fl-notshown">${c.notShown.map(x => `<li><span class="mono">${esc(x.name)}</span>: not shown, ${esc(x.why)}</li>`).join('')}</ul>` : '') +
        (c.left ? `<p class="fl-note">${c.left} more file${c.left === 1 ? '' : 's'} in the folder not read (ChartBridge reads 200 at most).</p>` : '');
    } else if (R.state === 'ok') body = '<p class="fl-empty">The roster folder on this PC is empty. A bot shows here once the Lab has built its roster file and Bot-Lab is installed on this PC.</p>';
    else if (R.state === 'loading') body = '<p class="fl-empty">Reading the roster...</p>';
    else if (R.state === 'idle') body = `<p class="fl-empty">${S.connected ? 'The roster is not read yet.' : 'ChartBridge is not connected.'}</p>`;
    else body = `<p class="fl-empty${R.state === 'error' ? ' fl-warn' : ''}">${esc(R.text)}</p>`;
    return `<section class="fl-box fl-roster" aria-label="Roster" data-state="${esc(R.state)}"><div class="fl-trow"><h3 class="fl-h">Roster</h3><span class="fl-fill"></span>
        <button type="button" class="ws-btn" data-do="roster"${R.state === 'loading' ? ' aria-disabled="true"' : ''}>Read again</button></div>
      ${body}
      <p class="fl-note">From the Lab's roster files on this PC, read as they are. Every number is from in-sample runs unless a card says confirmed, and none is a promise. Profit per $1 counts what the accounts cost; "no edge" is what the same trades would show with their edge taken out, so only a number above that range says anything.</p>
    </section>`;
  }
  function traderHtml(t) {
    const sw = t.switchesKnown
      ? `<span class="fl-sw${t.marketEntry ? ' on' : ''}">Market entry: ${t.marketEntry ? 'on' : 'off'}</span><span class="fl-sw${t.noTarget ? ' on' : ''}">No target: ${t.noTarget ? 'on' : 'off'}</span>`
      : `<span class="fl-sw">Entry switches: need ChartBridge ${esc(C.SWITCH_MIN)}</span>`;
    const ds = !t.dayStopKnown ? 'needs ChartBridge ' + esc(C.DAYSTOP_MIN) : t.dayStop !== null ? esc(C.usd(t.dayStop)) + ' (from its plan)' : 'none sent with a plan this session';
    const kind = t.kind === 'prop' ? 'prop' : t.kind === 'personal' ? 'personal' : t.kind === 'sim' ? 'sim' : t.kind === 'mixed' ? 'mixed' : '';
    return `<li class="fl-trader" data-id="${esc(t.id)}" data-tone="${esc(t.tone)}">
      <div class="fl-trow"><span class="fl-tname">${esc(t.name)}</span>${t.build ? `<span class="fl-mut">${esc(t.build)}</span>` : ''}
        <span class="fl-mode" data-mode="${esc(t.mode)}">${esc(t.modeText)}</span>${t.onDuty ? '<span class="fl-duty">ON DUTY</span>' : ''}</div>
      <div class="fl-trow"><span class="fl-k">Account</span><span class="fl-v">${esc(t.accountText)}${kind ? ` <span class="fl-tag" data-kind="${kind}">${kind}</span>` : ''}</span></div>
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
  function render() {
    if (!view || !S.shown) return;
    const rows = C.traders(agentList(), S.accounts, S.version), accts = C.propAccounts(S.accounts, S.groups, agentList());
    const st = C.killAllState(S.version, S.accounts, S.signedIn, S.connected);
    const asking = S.ask > 0;
    view.innerHTML = `<div class="fl-wrap">
      <div class="fl-head">
        <span class="fl-title">Bots</span><span class="fl-dutyline">${esc(C.dutyLine(rows))}</span><span class="fl-fill"></span>
        ${asking
          ? `<span class="fl-ask" role="alertdialog" aria-label="Kill all">Close every trader's position on the prop accounts and stop them?
               <button type="button" class="ws-btn fl-kill" data-do="yes">Yes, kill all</button><button type="button" class="ws-btn" data-do="no">Cancel</button></span>`
          : `<button type="button" class="ws-btn fl-kill" data-do="ask"${st.ok ? '' : ` aria-disabled="true" title="${esc(st.why)}"`}>Kill all: flatten and stop</button>`}
      </div>
      <p class="fl-said${S.saidBad ? ' bad' : ''}" role="status" aria-live="polite">${esc(S.said || (st.ok ? 'Kill all stops every trader on a prop account and closes its position there whole, a contract you added by hand on that account and contract included. Your personal account, a trader on Sim accounts only, the bot and the copier are never touched.' : st.why))}</p>
      ${rosterHtml()}
      <div class="fl-cols">
        <section class="fl-box" aria-label="Traders"><h3 class="fl-h">Traders</h3>
          ${rows.length ? `<ul class="fl-traders">${rows.map(traderHtml).join('')}</ul>` : `<p class="fl-empty">${S.connected ? 'No trader is set up in ChartBridge yet.' : 'ChartBridge is not connected.'}</p>`}
          <p class="fl-note">A trader's mode, account, window and its two entry switches are changed on the Agent tab, by you. Nothing here changes them.</p>
        </section>
        <section class="fl-box" aria-label="Prop accounts"><h3 class="fl-h">Prop accounts</h3>
          ${accts.length ? `<div class="fl-scroll"><table class="fl-table"><thead><tr><th>Account</th><th>Progress</th><th>Cushion to floor</th><th>Today</th><th>Day stop</th><th>Status</th></tr></thead>
              <tbody>${accts.map(accountHtml).join('')}</tbody></table></div>`
            : `<p class="fl-empty">${!S.connected ? 'ChartBridge is not connected.' : S.accounts && S.accounts.personalNamed === true ? 'No prop account is connected.' : 'No personal account is picked yet, so no account is prop. Pick it once on the Accounts tab: an account\'s settings, This is my personal account.'}</p>`}
          <p class="fl-note">Today counts realized plus open. The day stop is held by ChartBridge itself: reached while a trader holds something on the account, that trader is flattened and stops until 18:00 New York.</p>
        </section>
      </div>
      <p class="fl-later">Not built yet, so not shown: the pick of which bots run today on the eval accounts and on the funded accounts, the one Armed slider, and each bot's own state from the runner. Until then nothing on this tab starts a bot: a trader's mode is changed on the Agent tab.</p>
    </div>`;
  }
  function onClick(e) {
    const b = e.target.closest('button[data-do]');
    if (!b) return;
    if (b.dataset.do === 'roster') { if (S.roster.state !== 'loading') loadRoster(); return; }
    if (b.dataset.do === 'ask') {
      const st = C.killAllState(S.version, S.accounts, S.signedIn, S.connected);
      if (!st.ok) { say(st.why, true, true); render(); return; }
      S.ask = Date.now();
      clearTimeout(S.askTimer);
      S.askTimer = setTimeout(() => { endAsk(); render(); }, C.CONFIRM_MS);
      render();
      const yes = view.querySelector('[data-do="no"]'); if (yes) yes.focus();      // the safe answer has the focus
    } else if (b.dataset.do === 'yes') { if (S.ask) killAll(); }
    else if (b.dataset.do === 'no') { endAsk(); say('', false); render(); }
  }
  function showTab(on) {
    on = !!on;
    if (on === S.shown) return;
    S.shown = on;
    if (tabBtn) { tabBtn.setAttribute('aria-pressed', String(on)); if (on) tabBtn.hidden = false; }
    if (!on) { endAsk(); if (view) view.innerHTML = ''; }
    if (typeof o.onTab === 'function') o.onTab(on);
    render();
    if (on) loadRoster();
  }
  if (view) view.addEventListener('click', onClick);
  if (tabBtn) tabBtn.addEventListener('click', () => showTab(!S.shown));
  const unlisten = V3 ? V3.listen({ message: onMessage, closed: () => lost() }) : () => {};
  return {
    showTab, shown: () => S.shown, offered: () => !!tabBtn && !tabBtn.hidden,
    hello: m => onMessage(m),
    state: () => ({ shown: S.shown, version: S.version, connected: S.connected, signedIn: S.signedIn, asking: S.ask > 0, said: S.said, sent: S.sent,
      traders: C.traders(agentList(), S.accounts, S.version), accounts: C.propAccounts(S.accounts, S.groups, agentList()),
      roster: { state: S.roster.state, text: S.roster.text, asked: S.roster.asked, bots: S.roster.cards ? S.roster.cards.bots.map(c => c.name) : [], lineups: S.roster.cards ? S.roster.cards.lineups.map(c => c.name) : [], notShown: S.roster.cards ? S.roster.cards.notShown.length : 0 } }),
    reloadRoster: loadRoster,
    destroy: () => { S.roster.seq++; unlisten(); endAsk(); if (view) view.removeEventListener('click', onClick); },
  };
}
window.FleetView = { create };
})();
