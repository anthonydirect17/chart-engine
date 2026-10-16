/*
 * AgentHelper: the Agent tab's On/Off, spend and hero picker, with no page in it (chart page 1.20.0; DECISION 2026-10-09 v
 * and w, docs/AGENT_TAB.md "On/Off"). live/agent.js draws it; test/agent-helper.test.js runs it in Node. One
 * dependency-free file: a plain <script> sets window.AgentHelper; Node requires it.
 *
 * The PC helper is Bot-Lab's manrae/helper.py: a small process on this PC (started at sign-in) that starts and stops the
 * agent's runner. It listens on http://localhost:8767 only, answers only this page's origin, and checks this page's PIN
 * unlock with ChartBridge on every request (the X-ChartBridge-Unlock header the PIN page already sends to GET /session).
 *
 *   On         the helper starts the runner with the build picked here (it fetches a missing build from The Desk)
 *   Off        the helper ends the runner process: no more model calls, so spend stops. ChartBridge cancels his unfilled
 *              entries when he disconnects (as built); a position keeps its stop and target.
 *   Off in a trade   asks "Flatten and turn him off?" (offStep), for that agent only. Yes (flatOffStart, flatOffStep):
 *              first Shadow (ChartBridge then places nothing more for him and cancels his unfilled entries; SHADOW_WAIT_MS
 *              at most), then the page's own Flatten for his account and root (the chart's Flatten path, never an order built
 *              here), then Off once ChartBridge says he is flat (FLAT_WAIT_MS at most). Not in Shadow or not flat in time: he
 *              stays on, and the line says so until Anthony acts. No: nothing is sent.
 *   Spend      this session's and the overall dollars of the live agent only (the runner's own journal of its calls)
 *   Picker     DECISION w: Copilot, Auto and a LIVE account list heroes only; Shadow on a Sim account lists heroes and the
 *              builds that pass the Shadow bar (pickerRows). A build that is not a hero keeps the mode at Shadow on Sim:
 *              modeBlock says why Copilot and Auto are closed (the runner refuses them too).
 *   Names      DECISION v: a hero's name (Manrae, Manrae 2) in the header; the build id and stamp in the details.
 *   Tiers      chart 1.28.0 (SPEC CE-1, DECISION 2026-10-15k): each build row of GET /status may carry tier (Not ready,
 *              Acceptable, Good, Great, Exceptional), edge, examEdge, liveEdge, liveN, standingAt, standingNote; all optional
 *              (absent: "tier unknown", with why). tierFit says how a hero's tier fits a group's Type (Evals, Funded, not set):
 *              shown only, never enforced; every hero is listed for every group.
 *   Proving    chart 1.29.0 (SPEC CE-2): a league seat's "PROVING n of 100" from its build row's liveN (proving).
 *   Missed poll chart 1.29.1: one GET /status that times out, fails to connect or answers 5xx keeps the last good answer
 *              (pollStep) while that answer is at most MISS_GRACE_MS old; the next miss in a row is 'down'. In the grace slow is
 *              true: the page shows "PC helper slow" and nothing starts on the old answer (On, Start in Shadow, Assign wait).
 *   Assign     the heroes-on-duty board's Assign hero (freeSlot, assignStart, assignStep): a free slot is an agent id on None
 *              and Off; agentAccount {group} first (ChartBridge checks it), then POST /on with the group's default hero, in Shadow.
 *
 * Nothing here sends an order.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentHelper = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const VERSION = '1.0.0';
const PORT = 8767;
const BASE = 'http://localhost:' + PORT;
const POLL_MS = 3000;
const TIMEOUT_MS = 4000;
const MISS_GRACE_MS = 8000;
const FLAT_WAIT_MS = 30000;
const SHADOW_WAIT_MS = 10000;
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const isNum = v => typeof v === 'number' && isFinite(v);
const str = v => (typeof v === 'string' ? v : '');

/** Dollars as the readout shows them: "$0.00", "$12.34", "$1,234.50". */
function usd(x) {
  if (!isNum(x)) return '-';
  return '$' + x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The readout next to On/Off: { session, overall } in dollars, or dashes while the helper has not answered. */
function spendText(spend) {
  const s = spend || {};
  return { session: usd(s.session), overall: usd(s.overall) };
}

/** The helper's word for one agent, for the line under On/Off. h: the agent's entry in GET /status (or null). */
function stateText(h, reach, why) {
  if (reach === 'down') return 'The PC helper is not running on this PC (tools\\manrae_helper.ps1 register).';
  if (reach === 'forbidden') return 'The PC helper refused this page' + (why ? ': ' + why : '') + '.';
  if (reach === 'locked') return 'Unlock ChartBridge\'s page with its PIN.';
  if (!h) return reach === 'none' ? 'This PC\'s helper does not run this agent.' : 'Asking the PC helper...';
  if (!h.on) return h.running ? 'Turning off...' : 'Off: no model calls, no spend.';
  if (h.running) return 'On' + (h.runningBuild ? ': ' + (h.hero || h.runningBuild) : '') + '.';
  return 'On, not running yet: ' + str(h.why) + '.';
}

/**
 * Chart 1.29.1: one GET /status answer r ({ reach, body } from the client) folded into the poll's state prev at time now:
 * { reach, status, why, okAt, misses, slow }. A miss is reach 'down' (no answer in TIMEOUT_MS, no connection, or an HTTP
 * status the client reads as down, 500 too) or a 200 with no agents. One miss right after a good answer at most MISS_GRACE_MS
 * old keeps that answer (reach 'ok', the old status, slow true); a second miss in a row, or a miss after an old or no good
 * answer, is 'down' (status null), as before. Every real answer (ok, locked 401, forbidden 403, refused 400 or 409) is taken
 * as it comes, exactly as before the grace, and ends it.
 */
function pollStep(prev, r, now) {
  const p = prev || {}, x = r || {}, b = x.body || null;
  const why = b && typeof b.error === 'string' ? b.error : '';
  const miss = x.reach === 'down' || (x.reach === 'ok' && !(b && b.agents)) || !x.reach;
  if (!miss) return { reach: x.reach, status: x.reach === 'ok' ? b : null, why, okAt: x.reach === 'ok' ? now : 0, misses: 0, slow: false };
  const misses = (p.misses || 0) + 1;
  if (misses === 1 && p.reach === 'ok' && p.status && isNum(p.okAt) && p.okAt > 0 && now - p.okAt <= MISS_GRACE_MS)
    return { reach: 'ok', status: p.status, why: p.why || '', okAt: p.okAt, misses, slow: true };
  return { reach: 'down', status: null, why, okAt: p.okAt || 0, misses, slow: false };
}
/** The quiet note while one poll was missed (pollStep's slow). */
const SLOW_TEXT = 'PC helper slow';

/* ---------------- tiers (chart 1.28.0, SPEC CE-1): shown only, nothing enforced */
const TIERS = ['Not ready', 'Acceptable', 'Good', 'Great', 'Exceptional'];
const TYPE_NAME = { eval: 'Evals', funded: 'Funded' };
/** A build row's tier as one of TIERS (any case), or '' (absent or not one of them: tier unknown). */
function tierOf(row) {
  const t = row && typeof row.tier === 'string' ? row.tier.trim().toLowerCase() : '';
  return TIERS.find(x => x.toLowerCase() === t) || '';
}
const fmtEdge = v => (isNum(v) ? (v > 0 ? '+' : v < 0 ? '-' : '') + Math.abs(v).toFixed(2) + 'R' : '');
/**
 * The tier chip of a build row: { text, tone, title }. tone: 'top' (Good, Great, Exceptional), 'ok' (Acceptable), 'no' (Not
 * ready), 'unknown'. reach: the helper's ('ok' when it answered). "GOOD +0.10R"; unknown: "TIER UNKNOWN" with why in title.
 */
function tierChip(row, reach) {
  const t = tierOf(row);
  if (!t) {
    const why = reach && reach !== 'ok' ? 'the PC helper is not answering' : 'no rating on this PC yet';
    return { text: 'tier unknown', tone: 'unknown', title: 'Tier unknown (' + why + ')' };
  }
  const r = row || {}, e = fmtEdge(r.edge);
  const bits = [isNum(r.examEdge) ? 'exam edge ' + fmtEdge(r.examEdge) : '', isNum(r.liveEdge) ? 'live edge ' + fmtEdge(r.liveEdge) + (isNum(r.liveN) ? ' over ' + r.liveN + ' trades' : '') : '',
    str(r.standingAt) ? 'standing of ' + str(r.standingAt) : '', str(r.standingNote)].filter(Boolean);
  return { text: t + (e ? ' ' + e : ''), tone: t === 'Not ready' ? 'no' : t === 'Acceptable' ? 'ok' : 'top', title: t + (e ? ', edge ' + e : '') + (bits.length ? ': ' + bits.join('; ') : '') };
}
/**
 * Chart 1.29.0 (SPEC CE-2): a league seat's record toward promotion, "PROVING n of 100" (n: the build row's liveN, the helper's
 * count of his live trades; read only, never computed here). No liveN: the words say it is not reported. { n, text, title }.
 */
const PROVING_OF = 100;
function proving(row) {
  const n = row && isNum(row.liveN) && row.liveN >= 0 ? Math.floor(row.liveN) : null;
  return n !== null ? { n, text: 'PROVING ' + n + ' of ' + PROVING_OF, title: 'A league seat: ' + n + ' live trades of the ' + PROVING_OF + ' that build his record (the PC helper\'s count)' }
    : { n: null, text: 'PROVING (live trades not reported)', title: 'A league seat: the PC helper does not report his live trades yet' };
}
/**
 * How a tier fits a group's Type (DECISION 2026-10-15k), shown only: { warn, note }. warn: the fit warning ('' when it fits);
 * note: a guidance line (Acceptable "at most 3 evals at once") or "type not set". Not ready fits nothing, whatever the Type;
 * with no Type there is no other fit warning; with a Type and no tier: "tier unknown".
 */
function tierFit(tier, accountType) {
  const t = TIERS.includes(tier) ? tier : '', type = accountType === 'eval' || accountType === 'funded' ? accountType : '';
  if (t === 'Not ready') return { warn: 'Not ready: gym and Sim only', note: '' };
  if (!type) return { warn: '', note: 'type not set' };
  if (!t) return { warn: 'tier unknown', note: '' };
  if (t === 'Acceptable') return type === 'funded' ? { warn: 'Acceptable: evals only; funded only when no Good or better hero is on duty', note: '' } : { warn: '', note: 'Acceptable: at most 3 evals at once' };
  return { warn: '', note: '' };
}
/** The heroes the helper knows, for Settings' Hero on duty: [{ build, hero, tier, chip, fit, label }], every hero for every
 *  group (no filter), with its fit for the group's Type. */
function heroOptions(status, accountType, reach) {
  const rows = status && Array.isArray(status.builds) ? status.builds : [];
  return rows.filter(r => r && typeof r.build === 'string' && r.hero).map(r => {
    const chip = tierChip(r, reach), fit = tierFit(tierOf(r), accountType);
    return { build: r.build, hero: String(r.hero), tier: tierOf(r), chip, fit, label: r.hero + ' (' + r.build + ') · ' + chip.text + (fit.warn && fit.warn !== chip.text ? ' · ' + fit.warn : '') };
  });
}

/**
 * The picker's rows for the agent shown: [{ build, label, hero, stamp, title, warn }]. mode and sim from ChartBridge's `agent`
 * message (sim true for a Sim account). Copilot, Auto or anything but a Sim account: heroes only. Shadow on Sim: heroes and
 * the builds over the bar (shadowOk from the helper). group (chart 1.28.0): the group he trades ({ accountType }), or absent
 * for one account: then each hero's label adds its tier fit warning for the group's Type (listed all the same).
 */
function pickerRows(status, mode, sim, group) {
  const rows = status && Array.isArray(status.builds) ? status.builds : [];
  const heroesOnly = mode !== 'shadow' || sim !== true;
  return rows.filter(r => r && typeof r.build === 'string' && (r.hero || (!heroesOnly && r.shadowOk))).map(r => {
    const fit = group && r.hero ? tierFit(tierOf(r), group.accountType) : { warn: '', note: '' };
    return {
      build: r.build, hero: r.hero || null, stamp: str(r.stamp), warn: fit.warn,
      label: (r.hero ? r.hero + ' (' + r.build + ')' : r.build + ' (Shadow only)') + (fit.warn ? ', ' + fit.warn : ''),
      title: (r.hero ? 'Hero ' + r.hero + ': ' : 'Not a hero, Shadow on Sim only: ') + r.build + (r.stamp ? ' ' + r.stamp : '') +
        (isNum(r.trades) ? ', ' + r.trades + ' trades' : '') + (isNum(r.meanR) ? ', mean R ' + r.meanR : '') + (r.here === false ? ', fetched from The Desk on On' : '') +
        (group && r.hero ? '. ' + tierChip(r).title + (fit.warn ? '. ' + fit.warn : fit.note ? '. ' + fit.note : '') : ''),
    };
  });
}
/**
 * The build the picker shows (piece 3): the one picked here, else the one he runs, else the default hero of the group he trades
 * (when the picker offers it), else the helper's last build, else the first row; '' with no rows. He can always pick another.
 */
function preselect(rows, picked, h, groupHero) {
  const has = b => !!b && (rows || []).some(r => r.build === b);
  for (const b of [picked, h && h.runningBuild, groupHero, h && h.build]) if (has(b)) return b;
  return rows && rows[0] ? rows[0].build : '';
}

/** Why the picker is short, or '': the heroes-only rule in force, or no bar set yet. */
function pickerNote(status, mode, sim) {
  if (mode !== 'shadow' || sim !== true) return 'Heroes only in ' + (mode === 'copilot' ? 'Copilot' : mode === 'auto' ? 'Auto' : 'this mode') + (sim === true ? '' : ' and on a LIVE account') + '.';
  return status && status.barSet === false ? 'No Shadow bar set: every build is listed in Shadow.' : '';
}

/**
 * The build he runs is not a hero (DECISION w): its name, or '' when he is one or nothing runs. Fails closed: the helper's
 * word when it has one, and always his own hello as well, since a runner that is not a hero says its build id as its name
 * (Bot-Lab manrae/live.py), whether or not the helper answers. a: his `agent` message; h: the helper's entry or null.
 */
function nonHero(a, h) {
  if (h && h.running && !h.hero) return h.runningBuild || 'This build';
  const x = a || {}, build = str(x.build).split(' ')[0];
  if (x.connected && build && str(x.name) === build) return build;
  return '';
}
/**
 * The mode buttons while a build that is not a hero runs: { copilot, auto } each null (allowed) or why not. Only heroes trade
 * in Copilot or Auto (DECISION w); the runner refuses them too.
 */
function modeBlock(h, a) {
  const b = nonHero(a, h);
  if (!b) return { copilot: null, auto: null };
  const why = b + ' is not a hero: Shadow on a Sim account only.';
  return { copilot: why, auto: why };
}
/** A LIVE account while a build that is not a hero runs: why not, or ''. sim: the account chosen is a Sim one. */
function accountBlock(a, h, sim) {
  const b = nonHero(a, h);
  return b && sim !== true ? b + ' is not a hero: it trades a Sim account only. Turn him Off and pick a hero first.' : '';
}

/** Chart 1.27.0 (ChartBridge 0.6.0): a hero on a group (its strip carries group and seats). */
const onGroup = a => !!(a && a.group && Array.isArray(a.seats));
/** The seats holding his trade now (a group): [{ account, root, qty }]. */
function seatsHeld(a) {
  return onGroup(a) ? a.seats.filter(x => x && typeof x.account === 'string' && x.position && isNum(x.position.qty) && x.position.qty !== 0)
    .map(x => ({ account: x.account, root: str(x.position.root), qty: x.position.qty })) : [];
}
const heldText = h => (h.qty > 0 ? 'long ' : 'short ') + Math.abs(h.qty) + (h.root ? ' ' + h.root : '') + ' on ' + h.account;

/** Off pressed: 'off' (send it), 'ask' (he holds a position: "Flatten and turn him off?"). a: his `agent` message. A group:
 *  'ask' while any seat holds his trade. */
function offStep(a) {
  if (onGroup(a) && seatsHeld(a).length) return 'ask';
  const p = a && a.position;
  return p && isNum(p.qty) && p.qty !== 0 ? 'ask' : 'off';
}

/** The question for Off in a trade (a group: every seat holding his trade). */
function offQuestion(a, name) {
  const held = seatsHeld(a);
  if (held.length) return (name || 'He') + ' holds ' + held.map(heldText).join(', ') + '. Flatten and turn him off?';
  const p = (a && a.position) || {};
  return (name || 'He') + ' holds ' + (p.qty > 0 ? 'long ' : 'short ') + Math.abs(p.qty || 0) + (p.root ? ' ' + p.root : '') + ' on ' + str(a && a.account) + '. Flatten and turn him off?';
}
/** What the job flattens, in words: "SIM-A MNQ" or, for a group, "SIM-A MNQ, SIM-B MNQ". */
const jobWhere = j => (Array.isArray(j.seats) && j.seats.length ? j.seats.map(x => x.account + ' ' + x.root).join(', ') : j.account + ' ' + j.root);

/** Is he flat now (his `agent` message)? A group: every seat. */
function flat(a) { return offStep(a) === 'off'; }

/**
 * "Flatten and turn off" pressed for agent a: { job, action } or { error } (nothing sent). The job: { agent, account, root,
 * phase, until }. action: 'shadow' (send agentMode shadow first), 'flatten' (already in Shadow), or 'off' (he is flat now).
 * His account must be known: never a default.
 */
function flatOffStart(a, now) {
  const x = a || {}, p = x.position || {};
  if (flat(x)) return { job: { agent: str(x.agent), account: str(x.account), root: str(p.root), phase: 'off', until: 0 }, action: 'off' };
  // chart 1.27.0 (ChartBridge 0.6.0): a group, as one account: Shadow first (no new entries), then the page's Flatten on every
  // seat holding his trade (one per seat and root), then Off once every seat is flat
  if (onGroup(x)) {
    const held = seatsHeld(x);
    if (held.some(h => !h.root)) return { error: 'A seat\'s instrument is not known: nothing was sent. Flatten in NinjaTrader, then press Off.' };
    const gj = { agent: str(x.agent), account: '', root: '', seats: held.map(h => ({ account: h.account, root: h.root })), phase: x.mode === 'shadow' ? 'flatten' : 'shadow', until: now + (x.mode === 'shadow' ? FLAT_WAIT_MS : SHADOW_WAIT_MS) };
    return { job: gj, action: gj.phase };
  }
  if (!str(x.account)) return { error: 'His account is not known yet: nothing was sent. Flatten in NinjaTrader, then press Off.' };
  if (!str(p.root)) return { error: 'His position\'s instrument is not known: nothing was sent. Flatten in NinjaTrader, then press Off.' };
  const job = { agent: str(x.agent), account: x.account, root: p.root, phase: x.mode === 'shadow' ? 'flatten' : 'shadow', until: now + (x.mode === 'shadow' ? FLAT_WAIT_MS : SHADOW_WAIT_MS) };
  return { job, action: job.phase };
}

/**
 * The job's next step, at each `agent` message and each second: { action, job, line }. action: '' (wait), 'flatten' (he is
 * in Shadow now: send the Flatten), 'off' (flat: send Off), 'giveup' (time is up: he stays on; line says why and stays).
 * a: his `agent` message now (null when ChartBridge no longer tells of him). sent: the Flatten has gone.
 */
function flatOffStep(job, a, now, sent) {
  const j = job, x = a || {};
  if (!j) return { action: '', job: null, line: '' };
  if (!a) {                                     // no word from ChartBridge (the connection dropped): never read as flat
    if (now > j.until) return { action: 'giveup', job: null, line: 'ChartBridge did not answer: ' + (j.phase === 'shadow' ? 'nothing was flattened and he stays on' : 'he may still hold ' + jobWhere(j) + ' and stays on') + '. Check NinjaTrader, then press Off.' };
    return { action: '', job: j, line: 'Waiting for ChartBridge (the connection dropped): nothing is read as flat meanwhile...' };
  }
  if (j.phase === 'shadow') {
    if (x.mode === 'shadow') return { action: flat(x) ? 'off' : 'flatten', job: Object.assign({}, j, { phase: flat(x) ? 'off' : 'flatten', until: now + FLAT_WAIT_MS }), line: flat(x) ? 'In Shadow and flat: turning him off...' : 'In Shadow: flattening ' + jobWhere(j) + '...' };
    if (now > j.until) return { action: 'giveup', job: null, line: 'ChartBridge did not put him in Shadow within ' + SHADOW_WAIT_MS / 1000 + ' s: nothing was flattened and he stays on.' };
    return { action: '', job: j, line: 'Putting him in Shadow first (no new entries)...' };
  }
  if (j.phase === 'flatten') {
    if (sent && flat(x)) return { action: 'off', job: Object.assign({}, j, { phase: 'off' }), line: 'Flat: turning him off...' };
    if (now > j.until) return { action: 'giveup', job: null, line: 'Not flat ' + FLAT_WAIT_MS / 1000 + ' s after the Flatten for ' + jobWhere(j) + ': he stays on, in Shadow. Flatten in NinjaTrader, then press Off.' };
    return { action: '', job: j, line: 'Flatten sent for ' + jobWhere(j) + ' (he is in Shadow): turning him off once flat...' };
  }
  return { action: '', job: j, line: 'Turning him off...' };
}

/* ---------------- Assign hero (the heroes-on-duty board, SPEC CE-1) */
const ASSIGN_WAIT_MS = 10000;
/**
 * A free slot for Assign hero: an agent id ChartBridge knows that is on None and Off (the helper says it is not on and runs
 * nothing): { agent } or { error }. agents: every `agent` message; status/reach: the helper's GET /status. ChartBridge never
 * writes config.txt: with no free slot he adds an agent id there himself.
 */
function freeSlot(agents, status, reach) {
  if (reach !== 'ok' || !status || !status.agents) return { error: 'The PC helper is not answering: an agent\'s Off cannot be checked, so nothing was sent.' };
  const free = (Array.isArray(agents) ? agents : []).filter(a => slotFree(a, status, reach) === '');
  /* fix round 1: a slot whose kill switch is off first; a killed one only when no other is free (the Kill is never undone here) */
  const pick = free.find(a => !a.killed) || free[0];
  if (pick) return pick.killed ? { agent: pick.agent, killed: true } : { agent: pick.agent };
  return { error: 'No free agent (an agent id on None and Off): add an agent id to config.txt (agents = ...); ChartBridge never writes config.txt.' };
}
/** Is this agent still a free slot (on None, not connected, Off in the helper)? '' when it is, else why not (fix round 1: asked
 *  again at Continue, right before agentAccount goes). */
function slotFree(a, status, reach) {
  if (!a || typeof a.agent !== 'string') return 'that agent is not on this ChartBridge any more';
  if (reach !== 'ok' || !status || !status.agents) return 'the PC helper is not answering, so his Off cannot be checked';
  const h = status.agents[a.agent];
  if (!h) return 'this PC\'s helper does not run agent ' + a.agent;
  if ((a.group && a.group.id) || (typeof a.account === 'string' && a.account)) return 'agent ' + a.agent + ' is no longer on None';
  if (a.connected) return 'agent ' + a.agent + ' is connected now';
  if (h.on || h.running) return 'agent ' + a.agent + ' is On in the helper now';
  return '';
}
/**
 * Assign hero pressed for group g ({ id, name, hero, members }): { agent, build, need } or { error }. need 'pick' when the group
 * has no default hero the helper offers (he picks a build, from rows). rows: pickerRows for Shadow on the group.
 */
function assignStart(g, agents, status, reach, rows) {
  if (!g || typeof g.id !== 'string') return { error: 'No such group.' };
  if (!Array.isArray(g.members) || !g.members.length) return { error: 'Group ' + g.name + ' has no accounts: put accounts in it on the Accounts tab first.' };
  const slot = freeSlot(agents, status, reach);
  if (slot.error) return slot;
  const def = g.hero && (rows || []).some(r => r.build === g.hero) ? g.hero : '';
  return Object.assign({ agent: slot.agent, build: def, need: def ? '' : 'pick' }, slot.killed ? { killed: true } : {});
}
/**
 * An Assign under way ({ agent, group, build, until }), at each `agent` message and each second: { action, line }. action: ''
 * (wait), 'on' (ChartBridge put him on the group: POST /on now), 'giveup' (not on the group in time: nothing started).
 */
function assignStep(job, a, now) {
  if (!job) return { action: '', line: '' };
  const x = a || {};
  if (x.group && x.group.id === job.group) return { action: 'on', line: 'On ' + job.groupName + ': starting ' + job.build + ' in Shadow...' };
  if (now > job.until) return { action: 'giveup', line: 'ChartBridge did not put agent ' + job.agent + ' on ' + job.groupName + ' within ' + ASSIGN_WAIT_MS / 1000 + ' s: nothing was started.' };
  return { action: '', line: 'Asking ChartBridge to put agent ' + job.agent + ' on ' + job.groupName + '...' };
}

/**
 * Fix round 2: the board's Start in Shadow really starts in Shadow. ChartBridge keeps an agent's mode across runner stops, so an
 * agent left in Auto is first put in Shadow (the existing agentMode), and the helper's POST /on goes only once his `agent` message
 * shows Shadow. startBegin(a, build, now): { job, action } with action 'shadow' (send agentMode shadow first) or 'on' (in Shadow
 * already: straight on). startStep(job, a, now): { action ('' wait, 'on', 'giveup'), line }, the desk's Shadow wait and words.
 */
function startBegin(a, build, now) {
  const x = a || {}, inShadow = x.mode === 'shadow';
  return { job: { agent: str(x.agent), build, until: now + SHADOW_WAIT_MS, phase: inShadow ? 'on' : 'shadow' }, action: inShadow ? 'on' : 'shadow' };
}
function startStep(job, a, now) {
  if (!job) return { action: '', line: '' };
  if (!a) return now > job.until ? { action: 'giveup', line: 'ChartBridge did not answer: he was not put in Shadow, so nothing was started.' } : { action: '', line: 'Waiting for ChartBridge (the connection dropped): nothing is started meanwhile...' };
  if (a.mode === 'shadow') return { action: 'on', line: 'In Shadow: asking the PC helper to start agent ' + job.agent + ' with ' + job.build + '...' };
  if (now > job.until) return { action: 'giveup', line: 'ChartBridge did not put him in Shadow within ' + SHADOW_WAIT_MS / 1000 + ' s: nothing was started.' };
  return { action: '', line: 'Putting him in Shadow first (no new entries)...' };
}

/** Round 3: the last check before any board On (Assign hero's and Start in Shadow's): '' when his latest `agent` message says
 *  Shadow, else why nothing is started. The On then passes his own mode and sim, as the desk's On. */
function onGate(a) {
  if (!a) return 'ChartBridge no longer tells of him: nothing was started.';
  return a.mode === 'shadow' ? '' : 'He is in ' + (a.mode === 'auto' ? 'Auto' : a.mode === 'copilot' ? 'Copilot' : 'another mode') + ' now, not Shadow: nothing was started. Every start is Shadow; try again.';
}

/** The header and details (DECISION v): { name, build } where name is the hello's name (a hero's name, or the build id of
 *  a build that is not a hero) and build the build id and stamp for the details row. */
function names(a) {
  const x = a || {};
  return { name: str(x.name) || str(x.agent) || 'Agent', build: str(x.build) };
}

/** The settings form checked: { ok, body } or { error }. autoOn "HH:MM" or ''; cap dollars (0 to 1000) or '' for none. */
function settingsBody(agent, autoOn, cap) {
  const at = str(autoOn).trim();
  if (at && !HHMM.test(at)) return { error: 'Auto-On is HH:MM New York time, or empty for none.' };
  const c = str(cap).trim();
  let n = null;
  if (c) {
    n = Number(c);
    if (!isFinite(n) || n < 0 || n > 1000) return { error: 'The cap is dollars from 0 to 1000, or empty for none.' };
    n = Math.round(n * 100) / 100;
  }
  return { ok: true, body: { agent, autoOn: at, cap: n } };
}

/**
 * The client: env { fetch, headers: () => the PIN page's unlock headers, base }. Each call resolves to
 * { reach: 'ok'|'down'|'locked'|'refused', body }: 'down' the helper did not answer, 'locked' 401 (the PIN), 'refused' its
 * reason in body.error.
 */
function createClient(env) {
  const e = env || {};
  const base = e.base || BASE;
  async function call(method, path, body) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
    try {
      const h = Object.assign({}, e.headers ? e.headers() : {});
      if (body) h['Content-Type'] = 'application/json';
      const r = await e.fetch(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', mode: 'cors', credentials: 'omit', signal: ctl ? ctl.signal : undefined });
      let b = null;
      try { b = await r.json(); } catch (x) { b = null; }
      if (r.status === 401) return { reach: 'locked', body: b };
      if (r.status === 403) return { reach: 'forbidden', body: b };
      if (!r.ok) return { reach: r.status === 409 || r.status === 400 ? 'refused' : 'down', body: b || { error: 'HTTP ' + r.status } };
      return { reach: 'ok', body: b };
    } catch (x) {
      return { reach: 'down', body: null };
    } finally { if (timer) clearTimeout(timer); }
  }
  return {
    status: () => call('GET', '/status'),
    on: (agent, build, mode, sim) => call('POST', '/on', { agent, build, mode, sim: sim === true }),
    off: agent => call('POST', '/off', { agent }),
    settings: body => call('POST', '/settings', body),
  };
}

return { VERSION, PORT, BASE, POLL_MS, TIMEOUT_MS, MISS_GRACE_MS, pollStep, SLOW_TEXT, FLAT_WAIT_MS, SHADOW_WAIT_MS, ASSIGN_WAIT_MS, slotFree, startBegin, startStep, onGate, TIERS, TYPE_NAME, tierOf, tierChip, tierFit, proving, PROVING_OF, heroOptions, preselect, freeSlot, assignStart, assignStep, usd, spendText, stateText, pickerRows, pickerNote, nonHero, modeBlock, accountBlock, offStep, offQuestion, flat, flatOffStart, flatOffStep, seatsHeld, jobWhere, names, settingsBody, createClient };
});
