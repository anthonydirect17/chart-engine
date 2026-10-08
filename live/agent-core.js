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
const LIMITS = Object.freeze({ firstEntry: '09:30', lastFlat: '15:59', expireMin: 60, expireMax: 1800, tradesMax: 50, lossesMax: 20 });
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
  if (minutes(from) < minutes(LIMITS.firstEntry)) return { error: 'New entries start at ' + LIMITS.firstEntry + ' at the earliest: nothing was sent.' };
  if (!(minutes(from) < minutes(until))) return { error: 'New entries must start before they end (' + from + ' to ' + until + '): nothing was sent.' };
  if (!(minutes(flat) > minutes(until))) return { error: 'Flat at must be after new entries end (' + until + '): nothing was sent.' };
  if (minutes(flat) > minutes(LIMITS.lastFlat)) return { error: 'Flat at is ' + LIMITS.lastFlat + ' at the latest: nothing was sent.' };
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
/** The one question before an agent takes a LIVE account: it names the mode, and that the agent goes to Shadow when its
 *  account changes (lead's default, ChartBridge does it: the review's S5). */
function liveQuestion(a, name) {
  const mode = MODE_NAME[a && a.mode] || 'Shadow';
  return agentName(a) + ' is in ' + mode + ': it will trade LIVE account ' + name + (a && a.mode && a.mode !== 'shadow' ? ' once it is back in ' + mode : ' once you put it in Copilot or Auto') +
    '. The agent goes to Shadow when its account changes. Continue?';
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

/* ======================================================================== copilot keys: one handler for the bot and every agent */
/* After a key answer the keys rest this long; a proposal must have been on screen this long before a key may answer it
   (the review of 19e9ef0, B1: a double press must never answer a second, different proposal). */
const KEY_LOCK_MS = 1000, KEY_MIN_SHOWN_MS = 1000;
const KEY_SAY = {
  many: 'More than one proposal is open: click the one you mean',
  locked: 'Key ignored: one copilot answer a second',
  fresh: 'That proposal has just appeared: press again in a moment, or click it',
  late: 'Under 5 s left: the key does not answer it; click it if you mean to',
};
/**
 * The workspace's hotkeys fire one cancelable `chart-copilot-key` event (detail.answer 'accept' or 'reject'). The Bot tab
 * and the Agent tab each give the router their open proposals (an answered one waiting for ChartBridge included: it stays
 * the key's target, so a second press can only find it again). Which one a key answers (lead's default, the review's S1):
 *   - The Agent tab open: only the shown agent's proposals, the oldest of those not in its last 5 s.
 *   - Elsewhere, no agent proposal open: the bot's oldest, exactly as 1.16.0 (no other rule touches it).
 *   - Elsewhere, an agent proposal open: exactly one proposal open (the bot's and every agent's) is answered; more than one,
 *     none is, and the page says "More than one proposal is open: click the one you mean".
 *   And for every key answer but the bot's own 1.16.0 path: the keys rest 1 s after an answer, a proposal must have been on
 *   screen 1 s, and one in its last 5 s (or with no expiry) is never answered by a key.
 * Sources: add(name, { kind ('bot' or 'agents'; 'bot' for the name 'bot'), open: () => [{ id, agent, shownAt, answered,
 * expiresAt, name, answer: ans => bool }], focus: () => the agent shown in the Agent tab, or '' }) -> remove().
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
      if (s.kind !== 'bot' && s.src && typeof s.src.focus === 'function') focus = s.src.focus() || focus;
    }
    const byAge = (a, b) => a.shownAt - b.shownAt;
    bot.sort(byAge); agents.sort(byAge);
    const gate = x => {
      if (t < lockUntil) return { act: 'say', text: KEY_SAY.locked };
      if (t - x.shownAt < KEY_MIN_SHOWN_MS) return { act: 'say', text: KEY_SAY.fresh };
      if (x.kind !== 'bot' && late(x, t)) return { act: 'say', text: KEY_SAY.late };
      return { act: 'answer', entry: x };
    };
    if (focus) {                                       // the Agent tab is open: its agent's proposals only
      const mine = agents.filter(x => x.agent === focus);
      if (!mine.length) return bot.length || agents.length ? { act: 'say', text: 'With the Agent tab open the keys answer only ' + focus + '\'s proposals: click the one you mean' } : { act: 'none' };
      return gate(mine.find(x => !late(x, t)) || mine[0]);
    }
    if (!agents.length) return bot.length ? { act: 'answer', entry: bot[0] } : { act: 'none' };   // the bot alone: 1.16.0
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
  agentOfOrder, isAgentMark, workingEntries, ownsText,
  fmtUsd, positionText, beatText, statusText, stateOf, stripModel, noticesFrom, etClock, etClockSec,
  createCopilotRouter, copilotRouter, KEY_LOCK_MS, KEY_MIN_SHOWN_MS, KEY_SAY,
};
});
