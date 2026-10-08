/*
 * AgentCore: the Agent tab's logic, with no page in it (chart page 1.17.0; ChartBridge 0.5.0's agent channel, contract
 * AGENT_CHANNEL v1, docs/AGENT_TAB.md). live/agent.js draws the Agent tab from it; the unit tests (test/agent.test.js) run
 * it in Node. One dependency-free file: a plain <script> sets window.AgentCore; Node requires it.
 *
 * The channel serves any number of agents (Manrae is the first). Everything here is per agent id.
 *
 * What lives here:
 *   agents      the `agent` messages by id, the picker's list and choice, the strip's words, the notices between two
 *   proposals   a copilot proposal's life on the page (`agentProposal`): shown (then `agentSeen` once), answered once
 *               (`agentAnswer`), its countdown to `expiresAt` (Accept closes 5 s before: ChartBridge refuses it as expired)
 *   feed        the agent's notes (`agentNote`) and plans (`agentPlan`), newest first, kept as ChartBridge keeps them
 *   rules       the rule set as `agent` carries it, the form's values and the page's change (`agentRules`, flat keys)
 *   account     the agent's account, the accounts it may take (never the bot's, the copier's or another agent's), the
 *               change (`agentAccount`; a LIVE one is asked once in the page)
 *   the agent's which orders are the agent's: a v3 page's order message says `by: "agent:<id>"`
 *   orders
 *   copilot     the one handler of the workspace's `chart-copilot-key` event, shared by the Bot tab and the Agent tab:
 *   keys        the oldest open proposal across the bot and every agent is the one answered (lead's default)
 *   the light   board F (Anthony 2026-10-08): what the agent is doing now, from the messages the page gets (lightState: the
 *               phase, its colour, the panels lit), each stream row's tone and his record of it for the drawer
 *               (rowTone, decisionRecord), his session as a trail (sessionTrail), his account's room (roomLines) and the
 *               tab's Motion switch kept in this browser (motionPref)
 *
 * Nothing here sends an order. The page never builds an order for an agent: ChartBridge places every agent order itself,
 * from the plan's parameters, inside the agent's rules (AI is never in the order path).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const VERSION = '1.0.0';
/* the oldest ChartBridge with the agent channel */
const MIN_BRIDGE = '0.5.0';
const MODES = ['shadow', 'copilot', 'auto'];
const MODE_NAME = { shadow: 'Shadow', copilot: 'Copilot', auto: 'Auto' };
const NOTE_KINDS = ['look', 'thinking', 'lesson', 'notebook', 'status'];
const NOTE_NAME = { look: 'Look', thinking: 'Thinking', lesson: 'Lesson', notebook: 'Notebook', status: 'Status' };
const PROPOSAL_STATES = ['open', 'accepted', 'rejected', 'withdrawn', 'not answered', 'expired'];
/* the roots that have a size ceiling in the contract (section 3), and the ceiling: a ChartBridge constant */
const RULE_ROOTS = ['NQ', 'MNQ', 'ES', 'MES'];
const CEILING = Object.freeze({ NQ: 2, ES: 2, MNQ: 20, MES: 20 });
/* section 3's limits */
const LIMITS = Object.freeze({ sessionOpen: '18:00', lastFlat: '15:59', expireMin: 60, expireMax: 1800, tradesMax: 50, lossesMax: 20 });
/* ChartBridge 0.5.2: the window in session time, minutes since the 18:00 New York open (18:00 is 0, midnight 360, 17:00 1380) */
const sessionMin = m => ((m - 18 * 60) % 1440 + 1440) % 1440;
/* Manrae's defaults (contract section 3); ChartBridge's `agent` message carries the rules in force */
const DEFAULT_RULES = Object.freeze({ roots: ['NQ', 'MNQ'], maxQty: { NQ: 2, MNQ: 20 }, entryFrom: '09:45', entryUntil: '15:00', flatAt: '15:55', maxExpireSec: 1800, maxTrades: null, maxLosses: null });
/* Accept closes this long before expiresAt: ChartBridge refuses an accept with under 5 s left (contract section 4) */
const LATE_MS = 5000;
/* the second click that confirms Auto and the kill switch's release (as the Bot tab) */
const CONFIRM_MS = 4000;
const NOTES_MAX = 200, PLANS_MAX = 50;
const DEFAULT_ACCOUNT = 'Sim101';

const isInt = v => typeof v === 'number' && Number.isInteger(v);
const isNum = v => typeof v === 'number' && isFinite(v);
const plainObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const str = v => (typeof v === 'string' ? v : '');
/** An agent id as the contract allows: 1 to 12 characters, a to z and 0 to 9, starting with a letter. */
const validId = id => typeof id === 'string' && /^[a-z][a-z0-9]{0,11}$/.test(id);

/* ======================================================================== versions */
/** [major, minor, patch] from a version text ("0.5.0", "fake-0.4.0"), or null. */
function parseVersion(v) { const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')); return m ? [+m[1], +m[2], +m[3]] : null; }
/** Is version a at least b? An unknown a is false. */
function atLeast(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
}
/**
 * What the tab says when it has no agent to show. o: { v3 (true, false, null: not known yet), version, signedIn, trading
 * (the `trading` answer), agents (how many are known) }. '' when there is an agent to show.
 */
function offText(o) {
  const x = o || {};
  if (x.agents > 0) return '';
  if (x.v3 === null || x.v3 === undefined) return 'Connecting to ChartBridge...';
  if (x.v3 === false || !atLeast(x.version, MIN_BRIDGE)) return 'No agents on this ChartBridge (' + MIN_BRIDGE + ' or later).';
  if (!x.trading) return 'Signing in to ChartBridge...';
  if (!x.trading.enabled) return 'Trading is not enabled in ChartBridge on this PC, so the agent channel is off.';
  return 'No agents on this ChartBridge: none is named in its config.txt (agents = ...).';
}

/* ======================================================================== agents */
/**
 * The `agent` messages by id. update(m) keeps the latest and returns { id, prev, next } (prev null the first time), or null
 * for a message that is not one. list() is every agent in id order; get(id); ids(); clear() (ChartBridge went away).
 */
function createAgents() {
  const map = new Map();
  function update(m) {
    if (!plainObj(m) || !validId(m.agent)) return null;
    const prev = map.get(m.agent) || null;
    map.set(m.agent, m);
    return { id: m.agent, prev, next: m };
  }
  const list = () => [...map.values()].sort((a, b) => (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0));
  return { update, list, get: id => map.get(id) || null, ids: () => list().map(a => a.agent), size: () => map.size, clear: () => map.clear() };
}
/** The agent the tab shows: the one asked for when it is known, else the first in id order, else ''. */
function pickAgent(ids, wanted) {
  const list = Array.isArray(ids) ? ids : [];
  return list.includes(wanted) ? wanted : list[0] || '';
}
/** The agent's name, as ChartBridge gives it (the agent's own hello), else its id. */
const agentName = a => (a && typeof a.name === 'string' && a.name ? a.name : a && a.agent ? a.agent : 'Agent');

/* ======================================================================== the rules (contract section 3) */
const TIME_RX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutes = t => (TIME_RX.test(t) ? +t.slice(0, 2) * 60 + +t.slice(3) : null);
/** "none" (null), a whole number, from a value ChartBridge or the form gives ('', 0, null, 'none' are none). */
function noneOrInt(v) {
  if (v === null || v === undefined || v === 0 || v === '' || v === 'none') return null;
  if (typeof v === 'string' && /^\s*(\d{1,9})\s*$/.test(v)) { const n = +v.trim(); return n === 0 ? null : n; }
  return v;
}
/**
 * The rules from an `agent` message, in one shape: { roots: [ROOT], maxQty: {ROOT: n}, entryFrom, entryUntil, flatAt,
 * maxExpireSec, maxTrades (null: none), maxLosses (null: none) }. Tolerant of the forms the contract leaves open (roots as
 * "NQ,MNQ" or a list; maxQty as an object or as flat maxQtyNQ keys; none as null, 0 or "none"). null when there are none.
 */
function parseRules(r) {
  if (!plainObj(r)) return null;
  const roots = (Array.isArray(r.roots) ? r.roots : str(r.roots).split(',')).map(x => String(x).trim().toUpperCase()).filter(Boolean);
  const maxQty = {};
  const mq = plainObj(r.maxQty) ? r.maxQty : {};
  for (const k of Object.keys(mq)) if (isInt(mq[k])) maxQty[k.toUpperCase()] = mq[k];
  for (const k of Object.keys(r)) { const m = /^maxQty([A-Z]{1,4})$/.exec(k); if (m && isInt(r[k])) maxQty[m[1]] = r[k]; }
  return {
    roots, maxQty, entryFrom: str(r.entryFrom), entryUntil: str(r.entryUntil), flatAt: str(r.flatAt),
    maxExpireSec: isInt(r.maxExpireSec) ? r.maxExpireSec : null, maxTrades: noneOrInt(r.maxTrades), maxLosses: noneOrInt(r.maxLosses),
  };
}
/** The rules in a few lines for the panel: [[label, value]]. */
function rulesLines(rules) {
  const r = parseRules(rules);
  if (!r) return [];
  return [
    ['Roots', r.roots.join(', ') || '-'],
    ['Size at most', r.roots.map(x => (isInt(r.maxQty[x]) ? r.maxQty[x] + ' ' + x : x + ' -')).join(', ') || '-'],
    ['New entries', (r.entryFrom || '-') + ' to ' + (r.entryUntil || '-') + ' ET'],
    ['Flat at', (r.flatAt || '-') + ' ET'],
    ['Entry lives', isInt(r.maxExpireSec) ? 'at most ' + durationText(r.maxExpireSec) : '-'],
    ['Trades a day', r.maxTrades === null ? 'no limit' : 'at most ' + r.maxTrades],
    ['Losing trades', r.maxLosses === null ? 'no limit' : 'stand down at ' + r.maxLosses],
  ];
}
/** 1800 s is "30 min", 90 s "1 min 30 s". */
function durationText(s) {
  if (!isInt(s) || s < 0) return '-';
  const m = Math.floor(s / 60), r = s % 60;
  return m ? m + ' min' + (r ? ' ' + r + ' s' : '') : r + ' s';
}
/** The form's starting values (strings, as the inputs hold them) from the rules in force. */
function rulesForm(rules) {
  const r = parseRules(rules) || parseRules(DEFAULT_RULES);
  const f = { roots: r.roots.slice(), entryFrom: r.entryFrom, entryUntil: r.entryUntil, flatAt: r.flatAt,
    maxExpireSec: isInt(r.maxExpireSec) ? String(r.maxExpireSec) : '', maxTrades: r.maxTrades === null ? '0' : String(r.maxTrades), maxLosses: r.maxLosses === null ? '0' : String(r.maxLosses), maxQty: {} };
  for (const x of RULE_ROOTS) f.maxQty[x] = isInt(r.maxQty[x]) ? String(r.maxQty[x]) : String(CEILING[x]);
  return f;
}
/**
 * Can the rules be changed now? ChartBridge refuses `agentRules` while the agent has a position, a working entry or an open
 * proposal (section 3); the page offers the change only when it sees none. ctx: { workingEntry (bool), openProposals (n) }.
 * Returns { ok, why }.
 */
function rulesChangeable(agent, ctx) {
  const a = agent || {}, c = ctx || {};
  if (a.position && isNum(a.position.qty) && a.position.qty !== 0) return { ok: false, why: agentName(a) + ' has a position: change its rules when it is flat.' };
  if (c.workingEntry) return { ok: false, why: agentName(a) + ' has a working entry: change its rules when none is working.' };
  if (c.openProposals > 0) return { ok: false, why: agentName(a) + ' has an open proposal: change its rules when it is answered or gone.' };
  return { ok: true, why: '' };
}
/**
 * The page's change of the rules (`agentRules`, contract section 7, flat keys): checked against section 3's allowed values
 * first, so nothing ChartBridge would refuse for its values is sent. agent: the `agent` message; form: the inputs' values
 * (rulesForm's shape); ctx: { roots (the roots this ChartBridge serves and trades: not quote only), workingEntry,
 * openProposals }. Returns { msg } or { error } (said on the page; nothing is sent). ChartBridge checks it all again.
 */
function rulesChange(agent, form, ctx, cid) {
  const a = agent || {}, f = form || {}, c = ctx || {};
  if (!validId(a.agent)) return { error: 'No agent chosen: nothing was sent.' };
  const can = rulesChangeable(a, c);
  if (!can.ok) return { error: can.why + ' Nothing was sent.' };
  const served = Array.isArray(c.roots) ? c.roots : RULE_ROOTS;
  const roots = RULE_ROOTS.filter(x => (f.roots || []).includes(x));
  if (!roots.length) return { error: 'Choose at least one root: nothing was sent.' };
  for (const x of roots) if (!served.includes(x)) return { error: x + ' is not traded on this ChartBridge (served, not quote only): nothing was sent.' };
  const whole = v => (typeof v === 'string' && /^\s*\d{1,9}\s*$/.test(v) ? +v.trim() : v);
  const qty = {};
  for (const x of roots) {
    const n = whole((f.maxQty || {})[x]);
    if (!isInt(n) || n < 1 || n > CEILING[x]) return { error: 'Size for ' + x + ' must be a whole number from 1 to ' + CEILING[x] + ' (ChartBridge\'s ceiling): nothing was sent.' };
    qty[x] = n;
  }
  const from = str(f.entryFrom).trim(), until = str(f.entryUntil).trim(), flat = str(f.flatAt).trim();
  for (const [name, t] of [['New entries from', from], ['New entries until', until], ['Flat at', flat]]) if (minutes(t) === null) return { error: name + ' must be a New York time such as 09:45: nothing was sent.' };
  /* ChartBridge 0.5.2: in session order (the session runs from 18:00 to 17:00 New York time), as ChartBridge checks */
  const sf = sessionMin(minutes(from)), su = sessionMin(minutes(until)), sl = sessionMin(minutes(flat));
  if (sl > sessionMin(minutes(LIMITS.lastFlat))) return { error: 'Flat at is ' + LIMITS.lastFlat + ' at the latest (the session runs from 18:00 to 17:00 New York time): nothing was sent.' };
  if (!(sf < su)) return { error: 'New entries must start before they end in the session, which runs from 18:00 to 17:00 New York time (' + from + ' to ' + until + ' goes the wrong way round): nothing was sent.' };
  if (!(sl > su)) return { error: 'Flat at must be after new entries end (' + until + '), in the session from 18:00: nothing was sent.' };
  const exp = whole(f.maxExpireSec);
  if (!isInt(exp) || exp < LIMITS.expireMin || exp > LIMITS.expireMax) return { error: 'An entry\'s life must be a whole number of seconds from ' + LIMITS.expireMin + ' to ' + LIMITS.expireMax + ': nothing was sent.' };
  const tr = whole(f.maxTrades === '' || f.maxTrades === undefined ? '0' : f.maxTrades), lo = whole(f.maxLosses === '' || f.maxLosses === undefined ? '0' : f.maxLosses);
  if (!isInt(tr) || tr < 0 || tr > LIMITS.tradesMax) return { error: 'Trades a day must be 0 (no limit) or a whole number from 1 to ' + LIMITS.tradesMax + ': nothing was sent.' };
  if (!isInt(lo) || lo < 0 || lo > LIMITS.lossesMax) return { error: 'Losing trades must be 0 (no limit) or a whole number from 1 to ' + LIMITS.lossesMax + ': nothing was sent.' };
  const cur = parseRules(a.rules);
  if (cur && cur.roots.join(',') === roots.join(',') && roots.every(x => cur.maxQty[x] === qty[x]) && cur.entryFrom === from && cur.entryUntil === until &&
    cur.flatAt === flat && cur.maxExpireSec === exp && (cur.maxTrades || 0) === tr && (cur.maxLosses || 0) === lo) return { error: 'Nothing to change.' };
  const msg = { type: 'agentRules' };
  if (cid) msg.cid = cid;
  msg.agent = a.agent;
  msg.roots = roots.join(',');
  for (const x of roots) msg['maxQty' + x] = qty[x];
  Object.assign(msg, { entryFrom: from, entryUntil: until, flatAt: flat, maxExpireSec: exp, maxTrades: tr, maxLosses: lo });
  return { msg };
}

/* ======================================================================== the account (contract sections 6 and 7) */
/** SIM or LIVE: SIM only when ChartBridge says `sim: true`; anything else is LIVE (the careful side, as the Bot tab). */
const accountMark = sim => (sim === true ? 'SIM' : 'LIVE');
/** The agent's account from its `agent` message: { name, sim, mark }; Sim101 unmarked before ChartBridge says. */
function agentAccount(agent) {
  const a = agent || {};
  const name = typeof a.account === 'string' && a.account ? a.account : DEFAULT_ACCOUNT;
  return { name, sim: a.sim === true, mark: typeof a.sim === 'boolean' ? accountMark(a.sim) : '' };
}
/**
 * The accounts the agent may take: every account in the v3 `accounts` list that ChartBridge says is tradable now, with its
 * SIM or LIVE mark, Sim first, then by name; the agent's own account always listed (current). An account the agent may
 * never have is listed with why (lead's default: shown, not offered): the bot's, the copier's leader or a follower (on or
 * off), another agent's. others: { bot (the `bot` message), copier (the `copier` message), agents (every `agent` message) }.
 * Each: { name, sim, mark, tradable, current, why, ok }.
 */
function accountChoices(accountsMsg, agent, others) {
  const o = others || {}, cur = agentAccount(agent).name, me = agent && agent.agent;
  const list = accountsMsg && Array.isArray(accountsMsg.list) ? accountsMsg.list : [];
  const botAcc = o.bot && o.bot.enabled !== false && typeof o.bot.account === 'string' ? o.bot.account : '';
  const cp = o.copier && o.copier.enabled !== false ? o.copier : null;
  const leader = cp && cp.leader && typeof cp.leader.account === 'string' ? cp.leader.account : '';
  const followers = new Set(cp && Array.isArray(cp.followers) ? cp.followers.map(f => f && f.account).filter(Boolean) : []);
  const taken = new Map();
  for (const x of Array.isArray(o.agents) ? o.agents : []) if (x && x.agent !== me && typeof x.account === 'string' && x.account) taken.set(x.account, agentName(x));
  const out = [];
  for (const a of list) {
    if (!a || typeof a.name !== 'string' || !a.name) continue;
    const current = a.name === cur, tradable = a.tradable === true && a.state !== 'gone';
    if (!current && !tradable) continue;
    const why = a.name === botAcc ? 'the bot\'s account' : a.name === leader ? 'the copier\'s leader' : followers.has(a.name) ? 'a copier follower'
      : taken.has(a.name) ? taken.get(a.name) + '\'s account' : '';
    out.push({ name: a.name, sim: a.sim === true, mark: accountMark(a.sim), tradable, current, why, ok: tradable && !why && !current });
  }
  return out.sort((x, y) => (x.sim !== y.sim ? (x.sim ? -1 : 1) : x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}
/**
 * The page's change of the agent's account: { error } or { msg, live, confirm }. confirm, for a LIVE account, is the one
 * question the page asks first, in the page ("Manrae will trade LIVE account X. Continue?"). ChartBridge checks every rule
 * again (section 6).
 */
function accountChange(agent, name, choices, ctx, cid) {
  const a = agent || {}, cur = agentAccount(a).name, c = ctx || {};
  if (!validId(a.agent)) return { error: 'No agent chosen.' };
  if (typeof name !== 'string' || !name) return { error: 'Choose an account.' };
  if (name === cur) return { error: name + ' is already ' + agentName(a) + '\'s account.' };
  const ch = (choices || []).find(x => x.name === name);
  if (!ch || !ch.tradable) return { error: name + ' is not tradable in ChartBridge now (its checkmark on the Accounts tab, Connected).' };
  if (ch.why) return { error: name + ' is ' + ch.why + ': an agent trades an account of its own.' };
  const can = rulesChangeable(a, c);
  if (!can.ok) return { error: can.why.replace('change its rules', 'choose its account') };
  const msg = { type: 'agentAccount' };
  if (cid) msg.cid = cid;
  msg.agent = a.agent; msg.account = name;
  return { msg, live: !ch.sim, confirm: ch.sim ? '' : liveQuestion(a, name) };
}
/** The one question before an agent takes a LIVE account: it names the mode the agent keeps (ChartBridge 0.5.2, Anthony
 *  2026-10-08: an account change keeps the mode; the review's S5). Not confirmed: nothing is sent, the account stays. */
function liveQuestion(a, name) {
  const mode = MODE_NAME[a && a.mode] || 'Shadow';
  return 'Agent ' + (a && validId(a.agent) ? a.agent : agentName(a)) + ' will trade LIVE account ' + name + ' in ' + mode + (mode === 'Shadow' ? ' (nothing is placed until you choose Copilot or Auto)' : '') + '. Continue?';
}

/* ======================================================================== modes */
/** Which modes the panel offers: shadow and copilot always; auto only with the agent's account tradable (ChartBridge says
 *  so again). o: { tradable, account }. { shadow, copilot, auto } of { ok, why }. */
function modesAllowed(o) {
  const x = o || {};
  return { shadow: { ok: true, why: '' }, copilot: { ok: true, why: '' },
    auto: x.tradable ? { ok: true, why: '' } : { ok: false, why: 'Auto needs ' + (x.account || DEFAULT_ACCOUNT) + ' to be tradable in ChartBridge.' } };
}
/** Whether an account can trade now: the v3 `accounts` list (tradable), else the `trading` answer's accounts. */
function accountTradable(accountsMsg, trading, name) {
  const n = name || DEFAULT_ACCOUNT;
  const list = accountsMsg && Array.isArray(accountsMsg.list) ? accountsMsg.list : null;
  if (list) { const a = list.find(x => x && x.name === n); if (a) return !!a.tradable && a.state !== 'gone'; }
  return !!(trading && trading.enabled && Array.isArray(trading.accounts) && trading.accounts.includes(n));
}
/** The page's mode and kill messages (cid optional). */
const modeMsg = (agent, mode, cid) => (MODES.includes(mode) && validId(agent) ? Object.assign({ type: 'agentMode' }, cid ? { cid } : {}, { agent, mode }) : null);
const killMsg = (agent, on, cid) => (validId(agent) ? Object.assign({ type: 'agentKill' }, cid ? { cid } : {}, { agent, on: !!on }) : null);

/* ======================================================================== proposals (contract sections 4 and 7) */
/**
 * The countdown to a proposal's expiresAt (UTC ms): { ms (left, never below 0), text ("4:32", "0:07"), late (Accept is
 * closed: under 5 s left), over (expired) }.
 */
function countdown(expiresAt, now) {
  if (!isNum(expiresAt)) return { ms: null, text: '-', late: false, over: false };
  const ms = Math.max(0, expiresAt - now), s = Math.ceil(ms / 1000);
  return { ms, text: Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'), late: ms < LATE_MS, over: ms <= 0 };
}
/**
 * Copilot proposals on this page, every agent's, keyed by agent and id. update(m) takes every `agentProposal`:
 *   { act: 'show', p }        a new open one: show it now (then shown(agent, id, at))
 *   { act: 'update', p }      still open (seenAt filled in, say)
 *   { act: 'end', p, why }    ended: accepted, rejected, withdrawn, not answered or expired
 *   { act: 'none' }           nothing to do (an unknown shape, an end already handled, one that ended before it showed)
 * shown() gives the `agentSeen` message once per proposal; answer() the `agentAnswer` message once, only while it is open
 * here (an accept with under 5 s left is refused here: ChartBridge would refuse it as expired). Times are UTC ms, whole.
 */
function createProposals() {
  const map = new Map();
  const key = (agent, id) => agent + '|' + id;
  const ok = p => plainObj(p) && validId(p.agent) && typeof p.id === 'string' && p.id.length >= 1 && p.id.length <= 40 && typeof p.state === 'string';
  function update(p) {
    if (!ok(p)) return { act: 'none' };
    const k = key(p.agent, p.id), had = map.get(k);
    if (!had) {
      const e = { p, seen: false, answered: '', ended: p.state !== 'open' };
      map.set(k, e);
      return p.state === 'open' ? { act: 'show', p } : { act: 'none' };
    }
    had.p = p;
    if (had.ended) return { act: 'none' };
    if (p.state === 'open') return { act: 'update', p };
    had.ended = true;
    return { act: 'end', p, why: p.state };
  }
  function shown(agent, id, at) {
    const e = map.get(key(agent, id));
    if (!e || e.ended || e.seen || e.p.state !== 'open') return null;
    e.seen = true;
    return { type: 'agentSeen', agent, id, at: Math.round(at) };
  }
  function answer(agent, id, ans, at, cid) {
    const e = map.get(key(agent, id));
    if (ans !== 'accept' && ans !== 'reject') return { error: 'The answer must be accept or reject.' };
    if (!e) return { error: 'No proposal ' + id + '.' };
    if (e.ended || e.p.state !== 'open') return { error: 'That proposal is ' + e.p.state + ': nothing was sent.' };
    if (e.answered) return { error: 'Already answered (' + e.answered + '): nothing was sent.' };
    if (ans === 'accept' && !isNum(e.p.expiresAt)) return { error: 'No expiry known for this proposal: Accept is refused. Nothing was sent.' };
    if (ans === 'accept' && countdown(e.p.expiresAt, at).late) return { error: 'Too late to accept: under 5 s left (ChartBridge would refuse it as expired). Nothing was sent.' };
    e.answered = ans;
    const msg = { type: 'agentAnswer' };
    if (cid) msg.cid = cid;
    msg.agent = agent; msg.id = id; msg.answer = ans; msg.at = Math.round(at);
    return { msg };
  }
  /** ChartBridge refused this page's answer (a `reject` with its cid): it may be answered again while open. */
  function refused(agent, id) { const e = map.get(key(agent, id)); if (e && !e.ended) e.answered = ''; }
  /** the open ones (one agent's, or every agent's), oldest first */
  const open = agent => [...map.values()].filter(e => !e.ended && e.p.state === 'open' && (!agent || e.p.agent === agent)).map(e => e.p).sort((a, b) => (a.at || 0) - (b.at || 0));
  const get = (agent, id) => (map.has(key(agent, id)) ? map.get(key(agent, id)).p : null);
  const answered = (agent, id) => (map.has(key(agent, id)) ? map.get(key(agent, id)).answered : '');
  /** A dropped connection: every proposal is gone from the page (ChartBridge sends the open ones again on sign-in). */
  function clear() { const was = open(); map.clear(); return was; }
  return { update, shown, answer, refused, open, get, answered, clear };
}
/** How a proposal ended, in words for its card and the notices. */
function endText(why, name, account) {
  const n = name || 'The agent';
  return { accepted: 'Accepted: ChartBridge placed it on ' + (account || 'its account') + '.', rejected: 'Rejected.',
    withdrawn: 'Withdrawn: ' + n + ' took it back; nothing was sent.', 'not answered': 'Not answered: it ended unanswered; nothing was sent.',
    expired: 'Expired: its entry time ran out; nothing was sent.' }[why] || 'Ended (' + why + ').';
}
/** Stop and target prices from the plan's own numbers (the stop and target go around each fill: these are at the entry
 *  price), as { stop, target } (null when the price is not known). */
function legPrices(p, tick) {
  const x = p || {}, t = isNum(tick) && tick > 0 ? tick : 0.25, dir = x.side === 'buy' ? 1 : -1;
  const at = x.kind === 'stopLimit' && isNum(x.limitPrice) ? x.limitPrice : isNum(x.price) ? x.price : null;
  return { stop: at !== null && isInt(x.stopTicks) ? at - dir * x.stopTicks * t : null, target: at !== null && isInt(x.targetTicks) ? at + dir * x.targetTicks * t : null };
}

/* ======================================================================== the feed: notes and plans */
/**
 * The agent's notes and plans as ChartBridge keeps them (the last 200 notes and 50 plans per agent; a page that signs in
 * later gets them again, so a repeat is dropped). note(m) takes an `agentNote`, plan(m) an `agentPlan` (the same id again
 * replaces it: its result). items(agent) is both, newest first: { type: 'note' | 'plan', at, m }. clear() (ChartBridge went
 * away: it sends them again).
 */
function createFeed() {
  const per = new Map();
  const of = id => { if (!per.has(id)) per.set(id, { notes: [], noteKeys: new Set(), plans: new Map() }); return per.get(id); };
  function note(m) {
    if (!plainObj(m) || !validId(m.agent) || !NOTE_KINDS.includes(m.kind) || typeof m.text !== 'string' || !isNum(m.at)) return false;
    const f = of(m.agent), k = m.at + '|' + m.kind + '|' + m.text;
    if (f.noteKeys.has(k)) return false;
    f.noteKeys.add(k); f.notes.push(m);
    f.notes.sort((a, b) => a.at - b.at);
    while (f.notes.length > NOTES_MAX) { const x = f.notes.shift(); f.noteKeys.delete(x.at + '|' + x.kind + '|' + x.text); }
    return true;
  }
  /* the same id again replaces it (its result), except that a refused plan never replaces one that was not refused (a
     duplicate id the agent sent): that one is kept as its own line (the review's S2) */
  const refused = m => /^refused/.test(str(m.result));
  function plan(m) {
    if (!plainObj(m) || !validId(m.agent) || typeof m.id !== 'string' || !m.id) return false;
    const f = of(m.agent), had = f.plans.get(m.id);
    const key = had && !refused(had) && refused(m) ? m.id + '\u0000refused\u0000' + m.at : m.id;
    if (f.plans.has(key) && f.plans.get(key) === m) return false;
    f.plans.delete(key); f.plans.set(key, m);
    if (f.plans.size > PLANS_MAX) { const old = [...f.plans.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0))[0]; f.plans.delete(old[0]); }
    return true;
  }
  function items(agent, filter) {
    const f = per.get(agent);
    if (!f) return [];
    const out = [];
    if (!filter || filter === 'all' || filter === 'notes' || NOTE_KINDS.includes(filter)) for (const m of f.notes) if (!NOTE_KINDS.includes(filter) || m.kind === filter) out.push({ type: 'note', at: m.at, m });
    if (!filter || filter === 'all' || filter === 'plans') for (const m of f.plans.values()) out.push({ type: 'plan', at: isNum(m.at) ? m.at : 0, m });
    return out.sort((a, b) => b.at - a.at);
  }
  const counts = agent => { const f = per.get(agent); return f ? { notes: f.notes.length, plans: f.plans.size } : { notes: 0, plans: 0 }; };
  return { note, plan, items, counts, clear: () => per.clear() };
}
/** A plan for the feed and the strip: { title, tone ('ok', 'skip', 'bad', 'shadow'), result (words), side }. */
function planLine(p) {
  const x = p || {};
  const side = x.side === 'buy' ? 'Buy' : x.side === 'sell' ? 'Sell' : '';
  const res = str(x.result);
  if (x.action === 'skip' || res === 'skipped') return { title: 'Skipped' + (x.setup ? ' · ' + x.setup : ''), tone: 'skip', result: 'skipped', side: '' };
  const words = /^refused/.test(res) ? 'refused' : { shadow: 'shadow (nothing placed)', proposed: 'proposed to you', placed: 'placed' }[res] || res || 'planned';
  return { title: (side + ' ' + (isInt(x.qty) ? x.qty + ' ' : '') + str(x.root)).trim() + (x.setup ? ' · ' + x.setup : ''), tone: /^refused/.test(res) ? 'bad' : res === 'shadow' ? 'shadow' : 'ok',
    result: words + (/^refused: /.test(res) ? ': ' + res.slice(9) : ''), side: x.side || '' };
}

/* ======================================================================== the agent's orders */
/** The agent an order is marked for (`by: "agent:<id>"` on a v3 page), or ''. */
function agentOfOrder(o) { const m = o && typeof o.by === 'string' ? /^agent:([a-z][a-z0-9]{0,11})$/.exec(o.by) : null; return m ? m[1] : ''; }
/** Is this order the agent's? Its mark, and (when the agent's account is known) on that account. Nothing else counts:
 *  Anthony's own orders on the agent's account and root stay his. */
function isAgentMark(o, agent) {
  const a = agent || {};
  if (!validId(a.agent) || agentOfOrder(o) !== a.agent) return false;
  return !(typeof a.account === 'string' && a.account && o.account !== a.account);
}
const WORKING = ['working', 'partFilled'];
/** The agent's working entries among orders (an iterable of order messages). */
function workingEntries(orders, agent) {
  const out = [];
  for (const o of orders || []) if (isAgentMark(o, agent) && WORKING.includes(o.state) && (o.role === 'entry' || !o.role)) out.push(o);
  return out;
}
/** The owner-lock badge: "owns Sim101 MNQ" while ChartBridge says the agent holds the lock (`owns`), else ''. The root is
 *  the position's, else a working entry's. */
function ownsText(agent, orders) {
  const a = agent || {};
  if (a.owns !== true) return '';
  const root = a.position && a.position.root ? a.position.root : (workingEntries(orders, a)[0] || {}).root || '';
  return ('owns ' + agentAccount(a).name + ' ' + root).trim();
}

/**
 * The agent that owns (account, root) by ChartBridge's owner lock, or '' (1.17.0, ChartBridge 0.5.0 as built). An agent owns
 * the pair while ChartBridge says it holds the lock (`owns`) and the pair is its: its position's root, or a root where one
 * of its own orders (entry, stop or target) works on its account. agents: the `agent` messages; orders: order messages.
 */
function pairOwner(agents, orders, account, root) {
  for (const a of agents || []) {
    if (!a || a.owns !== true || agentAccount(a).name !== account) continue;
    if (a.position && a.position.root === root && a.position.qty) return a.agent;
    for (const o of orders || []) if (agentOfOrder(o) === a.agent && o.account === account && o.root === root && WORKING.includes(o.state)) return a.agent;
  }
  return '';
}
/** The only page order that passes an agent's lock (as built): MARKET, the other side of the position, at most its size, with
 *  no bracket and no strategy (an exit). o: { kind, side, qty, bracket, strategy }; posQty: the position on that pair. */
function pageExitPasses(o, posQty) {
  const x = o || {}, q = isNum(posQty) ? posQty : 0;
  return x.kind === 'market' && !x.bracket && !x.strategy && q !== 0 && (x.side === 'buy') === (q < 0) && isInt(x.qty) && x.qty >= 1 && x.qty <= Math.abs(q);
}
/** Which agent a ChartBridge `status` line is about (or ''): the id at its start ("demo flattened at 15:55 by its rules",
 *  "Agent demo: ...") or "agent <id>" anywhere in it, in any case ("agent demo had an open trade on ...", "SIM-AG1 MNQ is no
 *  longer agent demo's", "SIM-AG1 MNQ: agent demo's 1 closed; ..."; ChartBridge 0.5.0 as built, agent-channel 4d4a81f). */
function statusAgent(text, ids) {
  if (typeof text !== 'string' || !text) return '';
  for (const id of ids || []) {
    if (!validId(id)) continue;
    if (new RegExp('^(agent )?' + id + '\\b', 'i').test(text) || new RegExp('\\bagent ' + id + '\\b', 'i').test(text)) return id;
  }
  return '';
}
/** The kill switch on: a second press within KILL_REPEAT_MS of the first is the same press (a double click) and sends
 *  nothing more (ChartBridge has not answered yet, so the page still shows it off). last: when the last kill-on went. */
const KILL_REPEAT_MS = 1000;
const killOnRepeat = (last, now) => isNum(last) && now - last >= 0 && now - last < KILL_REPEAT_MS;
/** ChartBridge's words for the page's refused order on an agent's pair. */
const lockText = (account, root, id) => account + ' ' + root + ' belongs to agent ' + id + ': use Flatten, or move its stop or target';

/* ======================================================================== the strip and its words */
function fmtUsd(v) {
  if (!isNum(v)) return '';
  const s = Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (+Math.abs(v).toFixed(2) === 0 ? '' : v > 0 ? '+' : '-') + '$' + s;
}
/** The position in words: 'Flat', 'Long 2 MNQ @ 24,901.25'. */
function positionText(pos, fmtPrice) {
  const q = pos && isNum(pos.qty) ? pos.qty : 0;
  if (!q) return 'Flat';
  const px = isNum(pos.avgPrice) ? ' @ ' + (typeof fmtPrice === 'function' ? fmtPrice(pos.avgPrice, pos.root) : pos.avgPrice) : '';
  return (q > 0 ? 'Long ' : 'Short ') + Math.abs(q) + (pos.root ? ' ' + pos.root : '') + px;
}
/** The heartbeat's age: '0.4 s ago', '-' when not connected. */
function beatText(a) { return a && a.connected && isNum(a.lastBeatMs) ? (a.lastBeatMs / 1000).toFixed(1) + ' s ago' : '-'; }
/** What the agent is doing, in a few words. */
function statusText(a) {
  if (!a) return 'Not known yet';
  if (a.enabled === false) return 'Off in ChartBridge';
  if (a.killed) return 'Kill switch on: no agent orders';
  if (a.standDown) return 'Stood down: ' + a.standDown;
  if (!a.connected) return 'Not connected: no agent program running';
  if (isNum(a.lastBeatMs) && a.lastBeatMs > 5000) return 'Heartbeat late (' + (a.lastBeatMs / 1000).toFixed(1) + ' s)';
  return 'Watching';
}
/** state for the strip's color: 'on', 'off', 'killed', 'standDown', 'lost' */
function stateOf(a) { return !a || a.enabled === false ? 'off' : a.killed ? 'killed' : a.standDown ? 'standDown' : !a.connected ? 'lost' : 'on'; }
/**
 * The agent strip's model: { name, build, state, connected, beat, mode, account, accountMark, position, pnl, pnlTone,
 * trades, losses, killed, standDown, owns, last }.
 */
function stripModel(a, orders, fmtPrice) {
  const x = a || {}, acc = agentAccount(x), r = parseRules(x.rules) || {};
  const last = x.lastPlan ? planLine(x.lastPlan) : null;
  return {
    name: agentName(x), build: str(x.build), state: stateOf(x), connected: !!x.connected, beat: beatText(x), mode: MODE_NAME[x.mode] || '-',
    account: acc.name, accountMark: acc.mark, position: positionText(x.position, fmtPrice),
    pnl: isNum(x.pnlToday) ? fmtUsd(x.pnlToday) || '$0.00' : '-', pnlTone: isNum(x.pnlToday) ? (x.pnlToday > 0 ? 'pos' : x.pnlToday < 0 ? 'neg' : '') : '',
    trades: (isInt(x.trades) ? x.trades : 0) + (isInt(r.maxTrades) ? ' of ' + r.maxTrades : ''), losses: (isInt(x.losses) ? x.losses : 0) + (isInt(r.maxLosses) ? ' of ' + r.maxLosses : ''),
    killed: !!x.killed, standDown: str(x.standDown), owns: ownsText(x, orders),
    last: last ? 'Last plan ' + (isNum(x.lastPlan.at) ? etClock(x.lastPlan.at) + ' ' : '') + last.title + ': ' + last.result : 'No plan yet today',
  };
}
/**
 * What deserves a corner notice between two `agent` messages of one agent (prev may be null): an entry or exit, a
 * stand-down, the heartbeat lost or back, the kill switch, the owner lock. Returns [{ kind, text, level }].
 */
function noticesFrom(prev, next, fmtPrice) {
  const out = [];
  if (!prev || !next) return out;
  const a = prev, b = next, nm = agentName(b);
  const qa = a.position && isNum(a.position.qty) ? a.position.qty : 0, qb = b.position && isNum(b.position.qty) ? b.position.qty : 0;
  if (!qa && qb) out.push({ kind: 'entry', level: '', text: nm + ': entered ' + positionText(b.position, fmtPrice).toLowerCase() });
  else if (qa && !qb) out.push({ kind: 'exit', level: '', text: nm + ': exited; today ' + (fmtUsd(b.pnlToday) || '$0.00') });
  if (!a.standDown && b.standDown) out.push({ kind: 'standDown', level: 'red', text: nm + ' stood down: ' + b.standDown });
  if (a.connected && !b.connected) out.push({ kind: 'heartbeat', level: 'red', text: nm + ': heartbeat lost. ChartBridge cancelled its unfilled entries; a position keeps its stop and target.' });
  else if (!a.connected && b.connected) out.push({ kind: 'heartbeat', level: '', text: nm + ' is connected' });
  if (!a.killed && b.killed) out.push({ kind: 'kill', level: 'red', text: nm + ': kill switch on, no agent orders until it is released' });
  else if (a.killed && !b.killed) out.push({ kind: 'kill', level: '', text: nm + ': kill switch released' });
  if (a.mode !== b.mode && MODE_NAME[b.mode]) out.push({ kind: 'mode', level: b.mode === 'auto' ? 'amber' : '', text: nm + ' is in ' + MODE_NAME[b.mode] });
  if (a.account !== b.account && b.account) out.push({ kind: 'account', level: b.sim === true ? '' : 'amber', text: nm + ' now trades ' + b.account + ' (' + accountMark(b.sim) + ')' });
  return out;
}

/* ======================================================================== times (New York) */
const ET = (() => { try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (e) { return null; } })();
function etParts(ms) {
  if (!ET) { const d = new Date(ms); return { h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }; }
  const o = {};
  for (const p of ET.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { h: +o.hour % 24, mi: +o.minute, s: +o.second };
}
const p2 = n => (n < 10 ? '0' : '') + n;
const etClock = ms => { const t = etParts(ms); return p2(t.h) + ':' + p2(t.mi); };
const etClockSec = ms => { const t = etParts(ms); return p2(t.h) + ':' + p2(t.mi) + ':' + p2(t.s); };

/* ======================================================================== the light (board F, Anthony 2026-10-08) */
/*
 * One slow light circles the borders of the panels where the agent's attention is, in a colour that says what he is doing.
 * Everything here comes from the messages the page already gets (contract section 7: `agent`, `agentPlan`, `agentNote`,
 * `agentProposal`, the agent's own orders and fills, ChartBridge's refusals); nothing is guessed. The page draws it with CSS
 * only and works it out again only when a message arrives (ChartBridge sends `agent` once a second while connected, so a
 * state older than its hold goes back to watching on the next one).
 */
/** The colours of the light: a step of the tracker, or an outcome. */
const LIGHT = Object.freeze({
  screen: '#5df2ff',     // Screen: watching
  eyes: '#8f7bff',       // Eyes: a look
  judgment: '#c81fe0',   // Judgment: a plan (Anthony 2026-10-08: deeper magenta)
  checks: '#ffd23f',     // Checks: his rules being checked
  bridge: '#3dff9a',     // ChartBridge: placing, filled, a go, a trade in profit, a target
  passed: '#ff8a2a',     // he passed, a plan expired or was rejected
  no: '#ff3b5c',         // a hard no (refused), a trade under water
});
/** The tracker's five steps, in order: [key, label, what it does]. */
const STEPS = Object.freeze([['screen', 'Screen', 'bars, delta, levels'], ['eyes', 'Eyes', 'worth a look?'], ['judgment', 'Judgment', 'plan or skip'], ['checks', 'Checks', 'his rules'], ['bridge', 'ChartBridge', 'places it']]);
/** The panels the light may circle. */
const PANELS = Object.freeze(['acct', 'pipe', 'chart', 'prop', 'stream', 'pnl']);
/** How long a state holds with nothing newer (ms): a look, his thinking or a Shadow plan; an outcome (passed, refused, a go, an exit). */
const LIGHT_HOLD = Object.freeze({ look: 120000, outcome: 30000 });
/** A lap of the light: while he decides, and in a trade (Anthony 2026-10-08: 13 s and 9 s). */
const LAP_MS = Object.freeze({ slow: 13000, fast: 9000 });

const refusedResult = r => /^refused/.test(str(r));
/** The tone of one proposal's end: accepted is a go, anything else ended it without a trade. */
const endTone = s => (s === 'accepted' ? 'bridge' : 'passed');
const END_WORDS = { accepted: 'Accepted', rejected: 'Rejected', withdrawn: 'Withdrawn', 'not answered': 'Not answered', expired: 'Expired' };

/**
 * What the agent is doing now, for the light. x:
 *   agent         its `agent` message (mode, enabled, connected, killed, standDown, position)
 *   notes, plans  its `agentNote` and `agentPlan` messages (any order)
 *   open          its open proposals (`agentProposal` state open), each with answered ('accept', 'reject' or ''): this page's
 *                 answer while it waits for ChartBridge
 *   ends          proposals this window saw end: [{ id, state, at }]
 *   workingEntry  ChartBridge works an entry of its own (by "agent:<id>")
 *   exits         its flat exits this window saw: [{ at, pnl }] (pnl: the change in its P&L today, or null)
 *   openPnl       its open P&L in dollars (null: not known)
 *   now           UTC ms
 * Returns { phase, tone, color, panels, fast, lapMs, step, said, at }: phase one of quiet, stopped, trade, placed, check,
 * plan, look, think, passed, refused, go, exit, watch; tone a key of LIGHT; panels the ones lit (PANELS' names); step the
 * tracker's step now (0 to 4, -1 for none); said the line under "What he is doing now"; at the event's time (or null).
 */
function lightState(x) {
  const o = x || {}, a = o.agent || null, now = isNum(o.now) ? o.now : 0;
  const out = (phase, tone, panels, step, said, at) => ({ phase, tone, color: LIGHT[tone], panels, fast: phase === 'trade', lapMs: phase === 'trade' ? LAP_MS.fast : LAP_MS.slow, step, said, at: isNum(at) ? at : null });
  if (!a) return out('quiet', 'screen', [], -1, 'No agent to show', null);
  const q = a.position && isNum(a.position.qty) ? a.position.qty : 0;
  if (q) {                                             // a position: the light goes to the chart and the P&L, its colour the open P&L
    const p = isNum(o.openPnl) ? o.openPnl : null;
    const pos = (q > 0 ? 'long ' : 'short ') + Math.abs(q) + (a.position.root ? ' ' + a.position.root : '');
    /* plain facts only (Anthony 2026-10-08): the light's colour and the P&L figure say how it is going */
    return out('trade', p === null ? 'screen' : p >= 0 ? 'bridge' : 'no', ['chart', 'pnl'], 4, 'In a trade, ' + pos, null);
  }
  if (a.enabled === false) return out('quiet', 'screen', [], -1, 'Off in ChartBridge', null);
  if (a.killed) return out('stopped', 'no', ['acct'], -1, 'Kill switch on: no agent orders', null);
  if (a.standDown) return out('stopped', 'no', ['acct'], -1, 'Stood down: ' + a.standDown, null);
  if (o.workingEntry) return out('placed', 'bridge', ['prop', 'chart'], 4, 'Entry placed, waiting for a fill', null);
  const open = (Array.isArray(o.open) ? o.open : []).filter(p => p && p.state === 'open');
  const accepting = open.find(p => p.answered === 'accept');
  if (accepting) return out('check', 'checks', ['acct', 'prop'], 3, 'Accepted, checking his rules', accepting.at);
  if (open.length) return out('plan', 'judgment', ['pipe', 'prop'], 2, open.length > 1 ? open.length + ' plans are waiting for you' : 'A plan is waiting for you', open[0].at);
  if (!a.connected) return out('quiet', 'screen', [], -1, 'Not connected: no agent program running', null);
  /* the newest event still inside its hold */
  const ev = [];
  for (const n of Array.isArray(o.notes) ? o.notes : []) {
    if (!n || !isNum(n.at)) continue;
    if (n.kind === 'look') ev.push({ at: n.at, hold: LIGHT_HOLD.look, r: ['look', 'eyes', ['pipe', 'stream'], 1, 'A look'] });
    else if (n.kind === 'thinking') ev.push({ at: n.at, hold: LIGHT_HOLD.look, r: ['think', 'judgment', ['pipe', 'stream'], 2, 'Thinking'] });
  }
  const ends = new Map((Array.isArray(o.ends) ? o.ends : []).filter(e => e && typeof e.id === 'string').map(e => [e.id, e]));
  for (const m of Array.isArray(o.plans) ? o.plans : []) {
    if (!m || !isNum(m.at)) continue;
    const res = str(m.result), what = (m.setup ? ': ' + m.setup : '');
    if (m.action === 'skip' || res === 'skipped') ev.push({ at: m.at, hold: LIGHT_HOLD.outcome, r: ['passed', 'passed', ['prop', 'stream'], 2, 'He passed' + what] });
    else if (refusedResult(res)) ev.push({ at: m.at, hold: LIGHT_HOLD.outcome, r: ['refused', 'no', ['acct', 'prop'], 3, 'Refused by ChartBridge: ' + res.replace(/^refused:?\s*/, '')] });
    else if (res === 'shadow') ev.push({ at: m.at, hold: LIGHT_HOLD.look, r: ['plan', 'judgment', ['pipe', 'prop'], 2, 'A plan in Shadow'] });
    else if (res === 'placed') ev.push({ at: m.at, hold: LIGHT_HOLD.outcome, r: ['go', 'bridge', ['prop', 'stream'], 4, 'Placed by ChartBridge'] });
    else if (res === 'proposed' && ends.has(m.id)) {
      const e = ends.get(m.id), at = isNum(e.at) ? e.at : m.at;
      ev.push({ at, hold: LIGHT_HOLD.outcome, r: [e.state === 'accepted' ? 'go' : 'passed', endTone(e.state), ['prop', 'stream'], e.state === 'accepted' ? 4 : 2, 'Plan ' + (END_WORDS[e.state] || e.state).toLowerCase()] });
    }
  }
  for (const e of Array.isArray(o.exits) ? o.exits : []) {
    if (!e || !isNum(e.at)) continue;
    const p = isNum(e.pnl) ? e.pnl : null;
    ev.push({ at: e.at, hold: LIGHT_HOLD.outcome, r: ['exit', p !== null && p < 0 ? 'no' : 'bridge', ['pipe', 'pnl'], 4, 'Out of the trade' + (p !== null ? ': ' + (fmtUsd(p) || '$0.00') : '')] });
  }
  const live = ev.filter(e => now - e.at <= e.hold).sort((p, r) => r.at - p.at);
  if (live.length) { const r = live[0].r; return out(r[0], r[1], r[2], r[3], r[4], live[0].at); }
  return out('watch', 'screen', ['pipe'], 0, 'Watching', null);
}

/* ======================================================================== the stream and its decision drawer */
/**
 * The tone (a key of LIGHT) and the tag of one stream row. row: { type: 'note' | 'plan' | 'fill' | 'exit', m, end (a proposal's
 * end this window saw: { state }), waiting (its proposal is open here) }.
 */
function rowTone(row) {
  const r = row || {}, m = r.m || {};
  if (r.type === 'note') return { tone: { look: 'eyes', thinking: 'judgment' }[m.kind] || 'screen', tag: (NOTE_NAME[m.kind] || 'Note').toUpperCase() };
  if (r.type === 'fill') return { tone: 'bridge', tag: 'FILL' };
  if (r.type === 'exit') return { tone: isNum(m.pnl) && m.pnl < 0 ? 'no' : 'bridge', tag: 'EXIT' };
  const res = str(m.result);
  if (m.action === 'skip' || res === 'skipped') return { tone: 'passed', tag: 'PASS' };
  if (refusedResult(res)) return { tone: 'no', tag: 'REFUSED' };
  if (res === 'placed') return { tone: 'bridge', tag: 'PLAN' };
  if (res === 'proposed' && r.end) return { tone: endTone(r.end.state), tag: 'PLAN' };
  return { tone: 'judgment', tag: 'PLAN' };
}
/**
 * His full record of one decision, for the drawer: { tag, tone, time, title, words, facts: [[label, value]], words2 } with only
 * what the channel carries (a field it does not carry is left out, never filled in). o: { fmtPx(price, root), tick(root),
 * pointValue(root), sideWord }. The contract has no "for and against", no notebook rule cited by a plan, and no time or cost
 * of his thinking: none of those is shown.
 */
function decisionRecord(row, o) {
  const r = row || {}, m = r.m || {}, f = o || {};
  const px = (p, root) => (isNum(p) ? (typeof f.fmtPx === 'function' ? f.fmtPx(p, root) : String(p)) : '');
  const tk = root => (typeof f.tick === 'function' && f.tick(root) > 0 ? f.tick(root) : 0.25);
  const t = rowTone(r), facts = [];
  const add = (k, v) => { if (v !== '' && v !== null && v !== undefined) facts.push([k, String(v)]); };
  const time = isNum(m.at) ? etClockSec(m.at) : isNum(m.t) ? etClockSec(m.t) : '';
  if (r.type === 'note') {
    add('Logged', time ? time + ' ET' : '');
    return { tag: t.tag, tone: t.tone, time, title: { look: 'A look', thinking: 'His thinking', lesson: 'A lesson', notebook: 'His notebook', status: 'Status' }[m.kind] || 'A note', words: str(m.text), pre: m.kind === 'notebook', facts };
  }
  if (r.type === 'fill') {
    add('Filled', (m.side === 'buy' ? 'Bought ' : 'Sold ') + m.qty + ' ' + str(m.root) + ' at ' + px(m.p, m.root));
    add('Time', time ? time + ' ET' : '');
    add('Account', str(m.account));
    return { tag: t.tag, tone: t.tone, time, title: (m.side === 'buy' ? 'Bought ' : 'Sold ') + m.qty + ' ' + str(m.root) + ' at ' + px(m.p, m.root), words: '', facts };
  }
  if (r.type === 'exit') {
    const dir = m.dir > 0 ? 'Long' : 'Short';
    add('Trade', dir + ' ' + m.qty + ' ' + str(m.root));
    add('In', px(m.pIn, m.root) + (isNum(m.tIn) ? ' at ' + etClockSec(m.tIn) : ''));
    add('Out', px(m.pOut, m.root) + (isNum(m.tOut) ? ' at ' + etClockSec(m.tOut) : ''));
    add('Result', isNum(m.pnl) ? (fmtUsd(m.pnl) || '$0.00') + ' before fees' : '');
    if (isNum(m.tIn) && isNum(m.tOut) && m.tOut >= m.tIn) add('Held', durationText(Math.round((m.tOut - m.tIn) / 1000)));
    return { tag: t.tag, tone: t.tone, time: isNum(m.tOut) ? etClockSec(m.tOut) : time, title: 'Out of ' + dir.toLowerCase() + ' ' + m.qty + ' ' + str(m.root) + (isNum(m.pnl) ? ', ' + (fmtUsd(m.pnl) || '$0.00') : ''), words: '', facts };
  }
  /* a plan or a skip */
  const line = planLine(m), res = str(m.result), root = str(m.root);
  if (m.action === 'skip' || res === 'skipped') {
    add('Decision', 'skip, no trade');
    add('Setup', str(m.setup));
    return { tag: t.tag, tone: t.tone, time, title: 'He passed' + (m.setup ? ': ' + m.setup : ''), words: str(m.reason), facts };
  }
  const lp = legPrices(m, tk(root));
  const at = m.kind === 'stopLimit' ? 'stop-limit ' + px(m.price, root) + ', limit ' + px(m.limitPrice, root) : isNum(m.price) ? 'limit ' + px(m.price, root) : '';
  add('Entry', at ? (m.side === 'buy' ? 'Buy ' : m.side === 'sell' ? 'Sell ' : '') + (isInt(m.qty) ? m.qty + ' ' : '') + root + ', ' + at : '');
  add('Stop', isInt(m.stopTicks) ? m.stopTicks + ' ticks' + (lp.stop !== null ? ', ' + px(lp.stop, root) : '') : '');
  add('Target', isInt(m.targetTicks) ? m.targetTicks + ' ticks' + (lp.target !== null ? ', ' + px(lp.target, root) : '') : '');
  add('Risk', isNum(m.riskDollars) ? fmtUsd(m.riskDollars).replace(/^\+/, '') + (isInt(m.stopTicks) && isInt(m.targetTicks) && m.stopTicks ? ', reward ' + (m.targetTicks / m.stopTicks).toFixed(2) + ' to 1' : '') : '');
  add('Entry lives', isInt(m.expireSec) ? durationText(m.expireSec) : '');
  add('Setup', str(m.setup));
  add('Confidence', isNum(m.confidence) ? m.confidence.toFixed(2) : '');
  add('His rules', refusedResult(res) ? 'refused by ChartBridge: ' + res.replace(/^refused:?\s*/, '') : res === 'shadow' ? 'passed ChartBridge\'s checks (Shadow: nothing placed)' : res === 'proposed' || res === 'placed' ? 'passed ChartBridge\'s checks' : '');
  if (res === 'proposed' || r.proposal) {
    const p = r.proposal || {};
    add('Proposal', r.waiting ? 'waiting for you' : r.end ? (END_WORDS[r.end.state] || r.end.state) : 'proposed');
    if (isNum(p.seenAt)) add('You saw it', etClockSec(p.seenAt) + ' ET');
    if (isNum(p.answeredAt)) add('You answered', etClockSec(p.answeredAt) + ' ET' + (isNum(p.seenAt) ? ', in ' + ((p.answeredAt - p.seenAt) / 1000).toFixed(1) + ' s' : ''));
    else if (r.end && r.end.react) add('You answered', r.end.react.replace(/^ in /, 'in '));
    if (isNum(p.expiresAt)) add('Open until', etClockSec(p.expiresAt) + ' ET');
  }
  if (res === 'placed') add('ChartBridge', 'placed it (Auto)');
  return { tag: t.tag, tone: t.tone, time, title: line.title || 'A plan', words: str(m.reason), facts };
}

/* ======================================================================== the session trail and the room */
/**
 * His session as a trail from the rules' entryFrom to flatAt (09:45 to 15:55 by default; ChartBridge 0.5.2: in session time, so 18:00
 * to 15:55 runs across midnight), New York time. now and each event
 * in UTC ms; events [{ at, mark, tone, title }]. Returns { from, to, nowPct (0 to 100, null outside the trading day's
 * clock), hours: [{ label, pct }], marks: [{ pct, mark, tone, title }] } (marks outside the session are left out).
 */
function sessionTrail(rules, now, events) {
  const r = parseRules(rules) || {};
  const from = minutes(r.entryFrom) !== null ? r.entryFrom : DEFAULT_RULES.entryFrom, to = minutes(r.flatAt) !== null ? r.flatAt : DEFAULT_RULES.flatAt;
  /* in session time (ChartBridge 0.5.2), so a session from 18:00 runs across midnight to its flat time */
  const a = sessionMin(minutes(from)), b = sessionMin(minutes(to)), span = Math.max(1, b - a);
  const minOf = ms => { const t = etParts(ms); return sessionMin(t.h * 60 + t.mi + t.s / 60); };
  const pct = m => Math.round(Math.min(100, Math.max(0, (m - a) / span * 100)) * 100) / 100;
  const hours = [{ label: from, pct: 0 }], step = Math.max(1, Math.ceil(span / 60 / 8));   // at most about 8 hour marks
  for (let h = Math.floor(a / 60) + 1; h * 60 < b; h++) if (h % step === 0 && h * 60 - a >= 30 && b - h * 60 >= 30) hours.push({ label: p2((h + 18) % 24) + ':00', pct: pct(h * 60) });
  hours.push({ label: to, pct: 100 });
  const marks = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || !isNum(e.at)) continue;
    const m = minOf(e.at);
    if (m < a || m > b) continue;
    marks.push({ pct: pct(m), mark: str(e.mark).slice(0, 1) || '.', tone: LIGHT[e.tone] ? e.tone : 'screen', title: str(e.title) });
  }
  const n = isNum(now) ? minOf(now) : null;
  return { from, to, nowPct: n === null ? null : pct(n), hours, marks };
}
/**
 * His account's room, from the Account page's limit state (AccountsCore.limitState: ChartBridge's roomDrawdown and
 * roomDailyLoss, The Desk's limits): [{ key, label, room, limit, leftPct (0 to 100 or null), why, said }]. Never estimated: a
 * room not reported shows "not reported" (why), with ChartBridge's own words (said) for its tooltip. The channel carries no
 * profit target, so there is no "to target" line.
 */
function roomLines(account, limit) {
  const a = account || {}, s = limit || {};
  const line = (key, label, x, why, said) => {
    const room = x && isNum(x.room) ? x.room : null, lim = x && isNum(x.limit) && x.limit > 0 ? x.limit : null;
    return { key, label, room, limit: lim, leftPct: room !== null && lim ? Math.round(Math.min(100, Math.max(0, room / lim * 100))) : null, why: room === null ? why : '', said: room === null ? said : '' };
  };
  return [
    line('dd', 'Max loss room', s.dd, 'not reported', str(a.roomDrawdownWhy)),
    line('dl', 'Daily limit left', s.dl, 'not reported', str(a.roomDailyLossWhy)),
  ];
}

/* ======================================================================== the motion switch */
const MOTION_KEY = 'live-agent-motion-v1';
/** The tab's Motion switch as kept in this browser: 'full' (the default) or 'off'. storage may be null or throw. */
function motionPref(storage) { try { return storage && storage.getItem(MOTION_KEY) === 'off' ? 'off' : 'full'; } catch (e) { return 'full'; } }
function setMotionPref(storage, v) { try { if (storage) storage.setItem(MOTION_KEY, v === 'off' ? 'off' : 'full'); } catch (e) { /* blocked: kept for this page only */ } return v === 'off' ? 'off' : 'full'; }

/* ======================================================================== copilot keys: one handler for the bot and every agent */
/* After a key answer the keys rest this long; a proposal must have been on screen this long before a key may answer it
   (the review of 19e9ef0, B1: a double press must never answer a second, different proposal). */
const KEY_LOCK_MS = 1000, KEY_MIN_SHOWN_MS = 1000;
const KEY_SAY = {
  many: 'More than one proposal is open: click the one you mean',
  locked: 'Key ignored: one copilot answer a second',
  fresh: 'That proposal has just appeared: press again in a moment, or click it',
  late: 'Under 5 s left: the key does not answer it; click it if you mean to',
  arming: 'The bot\'s proposal has just come into the corner: press again in a moment',
};
/**
 * The workspace's hotkeys fire one cancelable `chart-copilot-key` event (detail.answer 'accept' or 'reject'). The Bot tab
 * and the Agent tab each give the router their open proposals (an answered one waiting for ChartBridge included: it stays
 * the key's target, so a second press can only find it again). Which one a key answers (lead's default, the review's S1):
 *   - The Agent tab open: only the shown agent's proposals, the oldest of those not in its last 5 s. The bot's and the other
 *     agents' are not shown on the tab (only counted, under the proposal), so no key answers them there; with no agent shown
 *     (the tab's "no agents" card) no key answers anything.
 *   - Elsewhere, no agent proposal open: the bot's oldest, exactly as 1.16.0 (no other rule touches it).
 *   - Elsewhere, an agent proposal open: exactly one proposal open (the bot's and every agent's) is answered; more than one,
 *     none is, and the page says "More than one proposal is open: click the one you mean".
 *     (The Agent tab gives the router its proposals only while it is shown, the only place an agent's proposal is a card:
 *     the re-review of c47a8a1. So on the page, elsewhere is the bot's alone, as 1.16.0.)
 *   And for every key answer but the bot's own 1.16.0 path: the keys rest 1 s after an answer, a proposal must have been on
 *   screen 1 s, and one in its last 5 s (or with no expiry) is never answered by a key.
 * Sources: add(name, { kind ('bot' or 'agents'; 'bot' for the name 'bot'), open: () => [{ id, agent, shownAt, answered,
 * expiresAt, name, ready (the bot's: false while its card is arming or not whole in the window), answer: ans => bool }], focus: () => the agent shown in the Agent tab, true while the tab is open with no agent shown, or '' })
 * -> remove().
 * decide(ans) is { act: 'answer', entry } or { act: 'say', text } or { act: 'none' } (nothing open: the event is left alone,
 * so the workspace says "no copilot proposal to answer here"); handle(ans) acts on it and returns it.
 */
function createCopilotRouter(clock) {
  const now = typeof clock === 'function' ? clock : () => Date.now();
  const sources = [];
  let lockUntil = 0;
  function add(name, src) { const s = { name: String(name), kind: (src && src.kind) || (name === 'bot' ? 'bot' : 'agents'), src }; sources.push(s); return () => { const i = sources.indexOf(s); if (i >= 0) sources.splice(i, 1); }; }
  const late = (x, t) => !isNum(x.expiresAt) || x.expiresAt - t < LATE_MS;
  function decide(ans) {
    if (ans !== 'accept' && ans !== 'reject') return { act: 'none' };
    const t = now(), bot = [], agents = [];
    let focus = '';
    for (const s of sources) {
      let list = [];
      try { list = s.src && typeof s.src.open === 'function' ? s.src.open() || [] : []; } catch (e) { list = []; }
      for (const x of list) if (x && isNum(x.shownAt) && typeof x.answer === 'function') (s.kind === 'bot' ? bot : agents).push(Object.assign({ source: s.name, kind: s.kind }, x));
      if (s.kind !== 'bot' && s.src && typeof s.src.focus === 'function') focus = s.src.focus() || focus;   // an agent's id, or true
    }
    const byAge = (a, b) => a.shownAt - b.shownAt;
    bot.sort(byAge); agents.sort(byAge);
    const gate = x => {
      if (t < lockUntil) return { act: 'say', text: KEY_SAY.locked };
      if (t - x.shownAt < KEY_MIN_SHOWN_MS) return { act: 'say', text: KEY_SAY.fresh };
      if (x.kind !== 'bot' && late(x, t)) return { act: 'say', text: KEY_SAY.late };
      return { act: 'answer', entry: x };
    };
    if (focus) {                                       // the Agent tab is open: its agent's proposals only (none with no agent shown)
      const mine = focus === true ? [] : agents.filter(x => x.agent === focus);
      if (!mine.length) return bot.length || agents.length ? { act: 'say', text: 'With the Agent tab open the keys answer only ' + (focus === true ? 'the shown agent' : focus) + '\'s proposals: open the Bot tab or that agent for the others' } : { act: 'none' };
      return gate(mine.find(x => !late(x, t)) || mine[0]);
    }
    if (!agents.length) {                              // the bot alone: 1.16.0 (its oldest, the card it shows), once ready
      if (!bot.length) return { act: 'none' };
      return bot[0].ready === false ? { act: 'say', text: KEY_SAY.arming } : { act: 'answer', entry: bot[0] };
    }
    if (bot.length + agents.length > 1) return { act: 'say', text: KEY_SAY.many };
    return gate(agents[0]);
  }
  function handle(ans) {
    const d = decide(ans);
    if (d.act === 'answer') { lockUntil = now() + KEY_LOCK_MS; d.entry.answer(ans); }
    return d;
  }
  return { add, decide, handle, size: () => sources.length, locked: () => now() < lockUntil };
}
/** The one router of a document, with its one `chart-copilot-key` listener (made on first use). What it says (more than one
 *  open, too soon) goes back on the event (detail.said) for the workspace to show. */
function copilotRouter(doc) {
  if (!doc) return null;
  if (doc.__copilotRouter) return doc.__copilotRouter;
  const r = createCopilotRouter();
  doc.addEventListener('chart-copilot-key', e => {
    const d = r.handle(e && e.detail ? e.detail.answer : '');
    if (d.act === 'none') return;                      // nothing open: the workspace says so
    e.preventDefault();
    if (d.act === 'say' && e.detail) e.detail.said = d.text;
  });
  doc.__copilotRouter = r;
  return r;
}

return {
  VERSION, MIN_BRIDGE, MODES, MODE_NAME, NOTE_KINDS, NOTE_NAME, PROPOSAL_STATES, RULE_ROOTS, CEILING, LIMITS, DEFAULT_RULES, LATE_MS, CONFIRM_MS, NOTES_MAX, PLANS_MAX, DEFAULT_ACCOUNT,
  validId, parseVersion, atLeast, offText,
  createAgents, pickAgent, agentName,
  parseRules, rulesLines, rulesForm, rulesChangeable, rulesChange, durationText,
  accountMark, agentAccount, accountChoices, accountChange, liveQuestion,
  modesAllowed, accountTradable, modeMsg, killMsg,
  countdown, createProposals, endText, legPrices,
  createFeed, planLine,
  agentOfOrder, isAgentMark, workingEntries, ownsText, pairOwner, pageExitPasses, lockText, statusAgent, KILL_REPEAT_MS, killOnRepeat,
  fmtUsd, positionText, beatText, statusText, stateOf, stripModel, noticesFrom, etClock, etClockSec,
  createCopilotRouter, copilotRouter, KEY_LOCK_MS, KEY_MIN_SHOWN_MS, KEY_SAY,
  LIGHT, STEPS, PANELS, LIGHT_HOLD, LAP_MS, lightState, rowTone, decisionRecord, sessionTrail, roomLines, MOTION_KEY, motionPref, setMotionPref,
};
});
