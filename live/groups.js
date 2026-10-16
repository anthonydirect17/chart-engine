/*
 * Account groups (chart 1.26.0, ChartBridge 0.5.8; Anthony's decisions of 2026-10-14, items 4 and 5 with G1, G2 and G3):
 * the group manager in Settings and the words the Accounts tab uses for groups. nt8/PROTOCOL.md "Prop groups and account
 * state (0.5.8)".
 *
 *   Settings, Account groups   each group as one row: its name, the firm's rules in a line, the No hedging switch, Edit,
 *                              Rename and Delete (an in-page confirm); New group. Edit and New open the rules dialog (as
 *                              Order Strategies): name, account size, daily loss limit, drawdown size and type, "floor stops
 *                              at" (G1), profit target, No hedging. Shown only when ChartBridge sends groups (0.5.8 and on).
 *   Accounts tab               (live/accounts.js) each account's Group dropdown, "highest close so far" asked once when an
 *                              account joins a group (G2 b), and My floor and My daily for an account in no group.
 *
 * The page asks; ChartBridge decides and saves (groups.txt, account-marks.txt): every message is the contract's
 * (groupSave, groupDelete, accountGroup, accountLimits), on the window's v3 connection (live/accounts.js createFeed), and
 * ChartBridge refuses what is wrong with its own words. One direction per group (G3 a) is ChartBridge's check under its order
 * lock; this page only shows the side and the holders it reports. No motion: nothing here moves (rule R3).
 *
 * Two parts, as accounts.js:
 *   GroupsCore   the pure parts (money words, the rules line, the form's checks and the messages). No DOM; it also loads in
 *                Node for test/groups.test.js.
 *   GroupsPage   runs only in a browser: mountSettings (the Settings section and its dialogs), used by workspace.js.
 * Chart 1.28.0 (ChartBridge 0.6.1, SPEC CE-1): each group's Type (Evals, Funded or not set) and its default hero (a build name)
 * in the rules dialog; ChartBridge saves both in groups.txt and checks only their shapes. The heroes and their tiers come from
 * the PC helper's GET /status (host.heroes, live/agent-helper.js), every hero for every group with a warning when its tier
 * does not fit the Type (shown only, nothing enforced). The message's own "type" is its kind, so the Type travels as accountType.
 * Chart 1.30.0 (wave 5, Anthony 2026-10-16): account types, the one ledger on The Desk (GET /api/account-types, read by the feed in
 * live/accounts.js). The rules dialog's Account type select at the top fills every rule box and the Type (never the name); Save sends
 * groupSave as before. The group remembers the type and version it was filled from in this browser's storage, keyed by group id
 * (LINKS_KEY): groups.txt has no place for it, since ChartBridge 0.6.2's groupSave refuses any key it does not know and keeps a
 * line's extra fields only as written there. A group whose rules differ from its type's current values shows "rules differ from
 * <type>: Update", and a member whose own type is another is named; warnings only, nothing is blocked.
 * Made-up names only in tests and docs (Lucid, Apex, SIM-A, SIM-B).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GroupsCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const NAME_MAX = 30, MONEY_MAX = 100000000;
const TYPES = [['eod', 'Trails end of day'], ['intraday', 'Trails intraday'], ['static', 'Static']];
const TYPE_WORD = { eod: 'end of day', intraday: 'intraday', static: 'static' };
const isNum = v => typeof v === 'number' && isFinite(v);
/* 1.28.0: the group's Type and its default hero's shape (ChartBridge 0.6.1 checks the same) */
const ACCOUNT_TYPES = [['', 'Not set'], ['eval', 'Evals'], ['funded', 'Funded']];
const HERO_RX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Dollars as Settings shows them: whole dollars with separators, cents only when there are any: $50,000, $1,000.50. */
function usd(v) {
  if (!isNum(v)) return '';
  const cents = Math.round(Math.abs(v) * 100), whole = Math.floor(cents / 100), c = cents % 100;
  return (v < 0 && cents ? '-' : '') + '$' + String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (c ? '.' + String(c).padStart(2, '0') : '');
}
/** A dollar box as typed: '' is none (0); "50,000", "$50000", "1000.5" are numbers; anything else (or 3 decimals) NaN. */
function parseMoney(text) {
  const t = String(text === null || text === undefined ? '' : text).trim().replace(/^\$/, '').replace(/,/g, '');
  if (t === '') return 0;
  if (!/^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?$/.test(t)) return NaN;
  return Number(t);
}
/** The box's text for a number ChartBridge sent (null: empty). */
const moneyBox = v => (isNum(v) && v > 0 ? String(+v.toFixed(2)) : '');

/** The firm's rules in one line: "$50,000 · daily $1,000 · drawdown $2,000 end of day, stops at $50,100 · target $3,000". */
function summary(g) {
  if (!g) return '';
  return [usd(g.size), 'daily ' + (isNum(g.dailyLoss) && g.dailyLoss > 0 ? usd(g.dailyLoss) : 'none'),
    'drawdown ' + usd(g.drawdown) + ' ' + (TYPE_WORD[g.drawdownType] || g.drawdownType) + (isNum(g.lockAt) && g.lockAt > 0 ? ', stops at ' + usd(g.lockAt) : ''),
    'target ' + (isNum(g.target) && g.target > 0 ? usd(g.target) : 'none')].concat(isNum(g.consistency) && g.consistency > 0 ? ['consistency ' + g.consistency + '%'] : []).join(' · ');
}
/** 1.28.0: the Type in a word ("Evals", "Funded", "type not set"), and the default hero's words ("hero Demo", "no hero"); heroName:
 *  the hero's name for a build (the PC helper's), else the build itself. */
const typeText = g => (g && g.accountType === 'eval' ? 'Evals' : g && g.accountType === 'funded' ? 'Funded' : 'type not set');
const heroText = (g, heroName) => (g && g.hero ? 'hero ' + ((heroName && heroName(g.hero)) || g.hero) : 'no hero');
/** "3 accounts" */
const membersText = g => { const n = g && Array.isArray(g.members) ? g.members.length : 0; return n + (n === 1 ? ' account' : ' accounts'); };
/** The group's side as ChartBridge reports it, in words: "long (SIM-A +2 MNQ; SIM-B buy 1 NQ)", "flat", "long and short (...)". */
function sideText(g) {
  if (!g || !g.side) return 'flat';
  const hs = (Array.isArray(g.holders) ? g.holders : []).map(h => h.what === 'position'
    ? h.account + ' ' + (h.side === 'long' ? '+' : '-') + h.qty + ' ' + h.root
    : h.account + ' ' + (h.side === 'long' ? 'buy ' : 'sell ') + h.qty + ' ' + h.root + ' working');
  const words = g.side === 'mixed' ? 'long and short' : g.side;
  return words + (hs.length ? ' (' + hs.slice(0, 4).join('; ') + (hs.length > 4 ? '; and ' + (hs.length - 4) + ' more' : '') + ')' : '');
}

/**
 * The rules dialog as typed ({ name, size, dailyLoss, drawdown, drawdownType, lockAt, target, noHedge }, boxes as text) to a
 * groupSave, or the first problem: { msg } or { error, field }. ChartBridge's own checks (PROTOCOL.md): a name of 1 to 30
 * characters, unique ignoring case (others: the other groups), a size and a drawdown above 0 with the drawdown below the
 * size, "floor stops at" only on a trailing drawdown and above the starting floor, at most 2 decimals. id: the group being
 * changed (absent: a new one).
 */
function groupMessage(f, others, id, cid) {
  const name = String(f.name === undefined ? '' : f.name).trim();
  if (!name || name.length > NAME_MAX) return { error: 'Name: 1 to ' + NAME_MAX + ' characters.', field: 'name' };
  if (/[\u0000-\u001f\u007f"\\]/.test(name)) return { error: 'Name: plain letters, numbers and spaces.', field: 'name' };
  if ((others || []).some(g => g && g.id !== id && String(g.name).toLowerCase() === name.toLowerCase())) return { error: 'A group named ' + name + ' is there already.', field: 'name' };
  const n = {};
  for (const [k, label, need] of [['size', 'Account size', true], ['dailyLoss', 'Daily loss limit', false], ['drawdown', 'Drawdown size', true], ['lockAt', 'Floor stops at', false], ['target', 'Profit target', false]]) {
    const v = parseMoney(f[k]);
    if (!isFinite(v)) return { error: label + ': dollars, at most 2 decimals' + (need ? '.' : ', or empty for none.'), field: k };
    if (v > MONEY_MAX) return { error: label + ': at most $100,000,000.', field: k };
    if (need && !(v > 0)) return { error: label + ': more than $0.', field: k };
    n[k] = v;
  }
  /* CON (a), Anthony 2026-10-15: the consistency percent (no day over N percent of the profit), informational; empty is none */
  const ct = String(f.consistency === undefined || f.consistency === null ? '' : f.consistency).trim().replace(/%$/, '').trim();
  const con = ct === '' ? 0 : /^(?:[1-9][0-9]?|100)(?:\.[0-9]{1,2})?$/.test(ct) && Number(ct) <= 100 ? Number(ct) : NaN;
  if (!isFinite(con)) return { error: 'Consistency: a percent from 1 to 100, or empty for none.', field: 'consistency' };
  const type = f.drawdownType;
  if (!TYPES.some(t => t[0] === type)) return { error: 'Drawdown type: end of day, intraday or static.', field: 'drawdownType' };
  if (n.drawdown >= n.size) return { error: 'The drawdown must be less than the account size.', field: 'drawdown' };
  if (n.lockAt > 0 && type === 'static') return { error: 'Floor stops at is for a trailing drawdown only (leave it empty for static).', field: 'lockAt' };
  if (n.lockAt > 0 && n.lockAt <= n.size - n.drawdown) return { error: 'Floor stops at must be above the starting floor (' + usd(n.size - n.drawdown) + ').', field: 'lockAt' };
  const at = f.accountType === undefined || f.accountType === null ? '' : f.accountType, hero = String(f.hero === undefined || f.hero === null ? '' : f.hero).trim();
  if (!ACCOUNT_TYPES.some(t => t[0] === at)) return { error: 'Type: Evals, Funded or not set.', field: 'accountType' };
  if (hero && !HERO_RX.test(hero)) return { error: 'Hero on duty: a build name of 1 to 64 letters, digits, dots, underscores or hyphens, or none.', field: 'hero' };
  return { msg: Object.assign({ type: 'groupSave' }, cid ? { cid } : {}, id ? { group: id } : {}, { name, noHedge: f.noHedge !== false,
    dailyLoss: n.dailyLoss, drawdown: n.drawdown, drawdownType: type, target: n.target, size: n.size, lockAt: n.lockAt, consistency: con }, f.accountType !== undefined ? { accountType: at || '-' } : {}, f.hero !== undefined ? { hero: hero || '-' } : {}) };   // 1.28.0: absent keeps them (ChartBridge 0.6.1)
}
/** groupSave for a group as ChartBridge sent it, with one change (a new name, the switch): every field, as the contract asks. */
function saveFrom(g, change, cid) {
  const x = Object.assign({}, g, change || {});
  return Object.assign({ type: 'groupSave' }, cid ? { cid } : {}, { group: g.id, name: x.name, noHedge: x.noHedge !== false, dailyLoss: x.dailyLoss || 0, drawdown: x.drawdown,
    drawdownType: x.drawdownType, target: x.target || 0, size: x.size, lockAt: x.lockAt || 0, consistency: x.consistency || 0 });   // 1.28.0: no accountType or hero: ChartBridge 0.6.1 keeps the group's own
}
/** The rules dialog's boxes from a group (null: a new group's defaults: a 50,000 account, a 2,000 end-of-day drawdown, no hedging). */
function formOf(g) {
  if (!g) return { name: '', size: '50000', dailyLoss: '', drawdown: '2000', drawdownType: 'eod', lockAt: '', target: '', consistency: '', noHedge: true };
  return { name: g.name, size: moneyBox(g.size), dailyLoss: moneyBox(g.dailyLoss), drawdown: moneyBox(g.drawdown), drawdownType: g.drawdownType, lockAt: moneyBox(g.lockAt), target: moneyBox(g.target),
    consistency: isNum(g.consistency) && g.consistency > 0 ? String(g.consistency) : '', noHedge: g.noHedge !== false };
}

/** The join question's words for a group: an intraday drawdown trails the balance with open P&L, so "highest balance so far
 *  (intraday)"; ChartBridge takes the one number as the start of both its highs (highClose), so only the words differ. */
const highWord = g => (g && g.drawdownType === 'intraday' ? 'highest balance so far (intraday)' : 'highest close so far');
/** G2 (b): the "highest close so far" box's prefill: the larger of the group's account size and the account's balance now. */
function highCloseDefault(g, account) {
  const size = g && isNum(g.size) ? g.size : 0, bal = account && isNum(account.balance) ? account.balance : 0;
  return Math.max(size, bal);
}
/** accountGroup: into a group with the highest close typed ('' : none, ChartBridge then takes the prefill's rule), or out (group null). */
function joinMessage(account, groupId, highText, cid, word) {
  const m = Object.assign({ type: 'accountGroup' }, cid ? { cid } : {}, { account, group: groupId || null });
  if (groupId && highText !== undefined && highText !== null && String(highText).trim() !== '') {
    const v = parseMoney(highText);
    if (!(v > 0) || v > MONEY_MAX) return { error: (word || 'Highest close so far') + ': dollars above $0, or empty.' };
    m.highClose = v;
  }
  return { msg: m };
}
/** accountLimits for a personal account: My floor and My daily ('' : none). */
function limitsMessage(account, floorText, dailyText, cid) {
  const floor = parseMoney(floorText), daily = parseMoney(dailyText);
  if (!isFinite(floor) || floor > MONEY_MAX) return { error: 'My floor: dollars, or empty for none.', field: 'floor' };
  if (!isFinite(daily) || daily > MONEY_MAX) return { error: 'My daily: dollars, or empty for none.', field: 'daily' };
  return { msg: Object.assign({ type: 'accountLimits' }, cid ? { cid } : {}, { account, floor, dailyLoss: daily }) };
}
/** The groups ChartBridge sent, clean: [{ id, name, ... }] by id order; anything malformed is left out; never throws. */
function cleanGroups(m) {
  const list = m && Array.isArray(m.list) ? m.list : [];
  return list.filter(g => g && typeof g.id === 'string' && /^g[1-9][0-9]{0,8}$/.test(g.id) && typeof g.name === 'string')
    .map(g => ({ id: g.id, name: g.name, noHedge: g.noHedge !== false, dailyLoss: isNum(g.dailyLoss) ? g.dailyLoss : null, drawdown: isNum(g.drawdown) ? g.drawdown : null,
      drawdownType: g.drawdownType, target: isNum(g.target) ? g.target : null, size: isNum(g.size) ? g.size : null, lockAt: isNum(g.lockAt) ? g.lockAt : null, consistency: isNum(g.consistency) ? g.consistency : null,
      accountType: g.accountType === 'eval' || g.accountType === 'funded' ? g.accountType : null, hero: typeof g.hero === 'string' && HERO_RX.test(g.hero) ? g.hero : null,
      members: Array.isArray(g.members) ? g.members.filter(x => typeof x === 'string') : [], side: ['long', 'short', 'mixed'].includes(g.side) ? g.side : null,
      holders: Array.isArray(g.holders) ? g.holders.filter(h => h && typeof h.account === 'string') : [] }));
}

/* ---------------- 1.30.0 (wave 5, Anthony 2026-10-16): account types, the one ledger on The Desk (GET /api/account-types).
   Money in dollars, as The Desk's prop tables and GET /api/chart-accounts. A type's status is "checked" only when The Desk says
   exactly that; anything else reads as not checked. */
const TYPE_ID_RX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const TYPES_CACHE_KEY = 'live-account-types-v1';   // the last good list, for when The Desk is not reachable
const LINKS_KEY = 'live-group-types-v1';           // { g1: { id, version, label } }: the type each group was filled from
const posMoney = v => (isNum(v) && v > 0 && v <= MONEY_MAX ? v : null);
/* "floor stops at" only where it can mean something: a trailing drawdown, above the starting floor (size less the drawdown); else
   none. Checked again on every use, since this browser's copy of the list is not checked by The Desk again. */
const lockOf = t => (t && isNum(t.lockAt) && t.lockAt > 0 && t.drawdownType !== 'static' && !(isNum(t.size) && isNum(t.drawdown) && t.lockAt <= t.size - t.drawdown) ? t.lockAt : null);
/** The Desk's answer ({ v, types, asOf }) clean: { types: [...] by firm then name, archived left out, asOf } or null for a bad shape. */
function cleanTypes(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.types)) return null;
  const seen = new Set(), out = [];
  for (const t of json.types) {
    if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !TYPE_ID_RX.test(t.id) || seen.has(t.id) || t.archived === true) continue;
    const firm = typeof t.firm === 'string' ? t.firm.trim() : '', name = typeof t.name === 'string' ? t.name.trim() : '';
    if (!firm || firm.length > 40 || !name || name.length > 60 || /[\u0000-\u001f\u007f]/.test(firm + name)) continue;
    seen.add(t.id);
    out.push({ id: t.id, firm, name, accountType: t.account_type === 'eval' || t.account_type === 'funded' ? t.account_type : '',
      size: posMoney(t.account_size), dailyLoss: posMoney(t.daily_loss), drawdown: posMoney(t.drawdown),
      drawdownType: TYPES.some(x => x[0] === t.drawdown_type) ? t.drawdown_type : null, lockAt: posMoney(t.lock_at), target: posMoney(t.profit_target),
      consistency: isNum(t.consistency_pct) && t.consistency_pct > 0 && t.consistency_pct <= 100 ? t.consistency_pct : null,
      status: t.status === 'checked' ? 'checked' : 'not_checked', version: Number.isInteger(t.version) && t.version >= 0 ? t.version : 0 });
    out[out.length - 1].lockAt = lockOf(out[out.length - 1]);
  }
  out.sort((a, b) => a.firm.localeCompare(b.firm, 'en', { sensitivity: 'base' }) || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.id < b.id ? -1 : 1));
  return { types: out, asOf: typeof json.asOf === 'string' && json.asOf.length <= 40 ? json.asOf : '' };
}
/** "Lucid 50K Flex, no DLL", with " (not checked)" until Anthony marks the type checked on The Desk. */
const typeLabel = t => (t ? t.firm + ' ' + t.name + (t.status === 'checked' ? '' : ' (not checked)') : '');
/** The rules dialog's boxes and Type from a type; missing: what the type has no value for that a group needs. */
function typeForm(t) {
  const f = { size: moneyBox(t.size), dailyLoss: moneyBox(t.dailyLoss), drawdown: moneyBox(t.drawdown), drawdownType: t.drawdownType || null,
    lockAt: moneyBox(lockOf(t)), target: moneyBox(t.target), consistency: isNum(t.consistency) && t.consistency > 0 ? String(t.consistency) : '', accountType: t.accountType || '' };
  f.missing = [[!t.size, 'account size'], [!t.drawdown, 'drawdown size'], [!t.drawdownType, 'drawdown type']].filter(x => x[0]).map(x => x[1]);
  return f;
}
const r2 = v => (isNum(v) && v > 0 ? Math.round(v * 100) / 100 : 0);
const RULE_WORDS = [['size', 'account size'], ['dailyLoss', 'daily loss limit'], ['drawdown', 'drawdown size'], ['drawdownType', 'drawdown type'], ['lockAt', 'floor stops at'],
  ['target', 'profit target'], ['consistency', 'consistency'], ['accountType', 'Type']];
/** What a group's rules (as ChartBridge sent them) differ in from a type's current values: [] when they match. */
function rulesDiffer(g, t) {
  if (!g || !t) return [];
  const gv = { size: r2(g.size), dailyLoss: r2(g.dailyLoss), drawdown: r2(g.drawdown), drawdownType: g.drawdownType || '', lockAt: r2(g.lockAt), target: r2(g.target), consistency: r2(g.consistency), accountType: g.accountType || '' };
  const tv = { size: r2(t.size), dailyLoss: r2(t.dailyLoss), drawdown: r2(t.drawdown), drawdownType: t.drawdownType || '', lockAt: r2(lockOf(t)), target: r2(t.target), consistency: r2(t.consistency), accountType: t.accountType || '' };
  /* a type with no Type (Evals or Funded) set leaves the group's own Type as it is: not a difference */
  return RULE_WORDS.filter(([k]) => gv[k] !== tv[k] && !(k === 'accountType' && !tv.accountType)).map(x => x[1]);
}
/**
 * "Apply its rules" for an account in no group: My floor and My daily from a type, each with how it was worked out.
 *   static drawdown      My floor = account size less the drawdown
 *   trailing (eod, intraday)  My floor is never set from the type: ChartBridge does not trail My floor (an account in no group
 *                        keeps the floor as typed), so any fixed floor would go stale after a new high and overstate the room.
 *                        floor null: the account's own My floor is sent again unchanged, and the question says why
 *   My daily             the type's daily loss limit (none: empty)
 * Returns { trailing, floor (box text, or null: not from the type), floorHow, daily, dailyHow } or { error }.
 */
const TRAILING_FLOOR_WORDS = 'A trailing floor is tracked only in a group: put this account in a group (a one-account group is fine) so ChartBridge trails it from its highest close.';
function typeLimits(t) {
  if (!t || !(t.size > 0) || !(t.drawdown > 0) || t.drawdown >= t.size) return { error: typeLabel(t) + ' has no account size and drawdown to take a floor from.' };
  const daily = moneyBox(t.dailyLoss), dailyHow = t.dailyLoss > 0 ? 'its daily loss limit' : 'it has no daily loss limit';
  if (t.drawdownType === 'static') return { trailing: false, floor: moneyBox(t.size - t.drawdown), floorHow: 'a static drawdown: account size ' + usd(t.size) + ' less the drawdown ' + usd(t.drawdown), daily, dailyHow };
  if (t.drawdownType === 'eod' || t.drawdownType === 'intraday') return { trailing: true, floor: null, floorHow: TRAILING_FLOOR_WORDS, daily, dailyHow };
  return { trailing: false, floor: null, floorHow: 'it has no drawdown type, so no floor is taken from it', daily, dailyHow };
}
/** The question's words: My floor and My daily as they will be sent, and how each was worked out. own: the account's My floor
 *  and My daily now (numbers or null). */
function applyWords(l, own) {
  const of = own && isNum(own.floor) && own.floor > 0 ? own.floor : null, od = own && isNum(own.daily) && own.daily > 0 ? own.daily : null;
  const daily = 'My daily ' + (l.daily ? usd(+l.daily) + ' (' + l.dailyHow + ')' : 'none (' + l.dailyHow + (od ? '; it replaces your ' + usd(od) : '') + ')') + '.';
  if (l.floor !== null) return 'My floor ' + usd(+l.floor) + ' (' + l.floorHow + (of && of > +l.floor ? '; it replaces your ' + usd(of) : '') + '), ' + daily;   // a stricter floor of his own is named
  const stays = 'My floor stays as it is (' + (of ? usd(of) : 'none') + ')';
  return (l.trailing ? stays + '. ' + l.floorHow : stays + ': ' + l.floorHow + '.') + ' ' + daily;
}
/** What Apply sends (the accountLimits boxes): the type's floor, or the account's own My floor again as it is; { error } when the
 *  account is not on ChartBridge's list any more (nothing sent: never an empty box that would clear My floor). */
function applySend(l, acc) {
  if (!l || l.error) return { error: (l && l.error) || 'no type' };
  if (!acc || typeof acc !== 'object') return { error: 'the account is not on ChartBridge\'s list now' };
  return { floor: l.floor !== null ? l.floor : moneyBox(acc.myFloor), daily: l.daily };
}
/** "Oct 16 14:02 ET" for an ISO time or ms ('' when it cannot be read). */
function asOfText(at) {
  const ms = typeof at === 'number' ? at : Date.parse(at || '');
  if (!isFinite(ms)) return '';
  try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms)).replace(',', '') + ' ET'; }
  catch (e) { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
}
/* the page's own storage ({ getItem, setItem, removeItem } or null); every call wrapped: the page works without it */
const sget = (st, k) => { try { return st ? st.getItem(k) : null; } catch (e) { return null; } };
const sset = (st, k, v) => { try { if (!st) return false; st.setItem(k, v); return true; } catch (e) { return false; } };
/** The last good list kept in this browser: { types, asOf, savedAt } or null. */
function readTypesCache(st) {
  try { const j = JSON.parse(sget(st, TYPES_CACHE_KEY)); const c = j && j.v === 1 ? cleanTypes(j.desk) : null; return c ? { types: c.types, asOf: c.asOf, savedAt: isNum(j.savedAt) ? j.savedAt : 0 } : null; } catch (e) { return null; }
}
const writeTypesCache = (st, desk, now) => sset(st, TYPES_CACHE_KEY, JSON.stringify({ v: 1, savedAt: isNum(now) ? now : Date.now(), desk }));
/** Each group's link to the type it was filled from: { g1: { id, version, label } }; bad entries dropped. */
function readLinks(st) {
  const out = {};
  try {
    const j = JSON.parse(sget(st, LINKS_KEY));
    if (j && typeof j === 'object' && !Array.isArray(j)) for (const k of Object.keys(j)) {
      const l = j[k];
      if (/^g[1-9][0-9]{0,8}$/.test(k) && l && typeof l.id === 'string' && TYPE_ID_RX.test(l.id) && Number.isInteger(l.version) && l.version >= 0)
        out[k] = { id: l.id, version: l.version, label: typeof l.label === 'string' ? l.label.slice(0, 120) : l.id };
    }
  } catch (e) { /* none */ }
  return out;
}
/** Sets (link) or removes (null) one group's link; true when written. */
function saveLink(st, gid, link) {
  const all = readLinks(st);
  if (link) all[gid] = { id: link.id, version: link.version, label: link.label || link.id }; else delete all[gid];
  return sset(st, LINKS_KEY, JSON.stringify(all));
}
/** The member accounts whose own type (The Desk's accountType) is not the type the group was filled from: [{ account, type }]. */
function membersOff(g, link, typeOfAccount) {
  if (!g || !link) return [];
  return (g.members || []).map(a => ({ account: a, type: typeOfAccount(a) })).filter(x => x.type && x.type.id !== link.id);
}

return { NAME_MAX, MONEY_MAX, TYPES, TYPE_WORD, ACCOUNT_TYPES, HERO_RX, typeText, heroText, usd, parseMoney, moneyBox, summary, membersText, sideText, groupMessage, saveFrom, formOf,
  highCloseDefault, highWord, joinMessage, limitsMessage, cleanGroups,
  TYPE_ID_RX, TYPES_CACHE_KEY, LINKS_KEY, cleanTypes, typeLabel, typeForm, rulesDiffer, typeLimits, applyWords, applySend, TRAILING_FLOOR_WORDS, asOfText, readTypesCache, writeTypesCache, readLinks, saveLink, membersOff };
});

/* ======================================================================== GroupsPage (browser only) */
if (typeof window !== 'undefined' && typeof document !== 'undefined') window.GroupsPage = (function () {
'use strict';
const GC = window.GroupsCore;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Settings, Account groups. host:
 *   feed            the window's createFeed (live/accounts.js): S.groups (null until ChartBridge 0.5.8 sends them), post()
 *   sec, list, add, note    the section, its rows, the New group button and its status line
 *   dialog          the page's <dialog> (#wsDialog); showDialog(d, onOk, onCancel) as workspace.js's
 *   heroes          (1.28.0, optional) () => Promise of the PC helper's GET /status ({ reach, body }, AgentHelper.createClient):
 *                   the heroes and tiers for Hero on duty; without it, or with the helper not answering, only the hero saved
 * Returns { render }.
 */
function mountSettings(host) {
  const F = host.feed, P = { confirm: '', seq: 0, heroes: null };
  const AH = window.AgentHelper || null;
  const heroName = b => { const st = P.heroes && P.heroes.status, r = st && Array.isArray(st.builds) ? st.builds.find(x => x && x.build === b && x.hero) : null; return r ? String(r.hero) : ''; };
  function askHeroes() {
    if (typeof host.heroes !== 'function') return Promise.resolve(P.heroes);
    return Promise.resolve(host.heroes()).then(r => { P.heroes = { reach: r && r.reach === 'ok' && r.body ? 'ok' : (r && r.reach) || 'down', status: r && r.reach === 'ok' ? r.body : null }; render(); return P.heroes; },
      () => { P.heroes = { reach: 'down', status: null }; return P.heroes; });
  }
  const cid = () => 'gp' + Date.now().toString(36) + '-' + (++P.seq);
  const say = (text, warn) => { host.note.textContent = text || ''; host.note.className = 'ws-help' + (warn ? ' ws-warn' : ''); };
  const groups = () => (F && F.S.groups) || [];
  /* 1.30.0: The Desk's account types (the feed's list, read now or this browser's copy) and each group's link to the type it
     was filled from (this browser's storage, keyed by group id: groups.txt has no place for it without a ChartBridge change) */
  const types = () => (F && F.S.types) || null;
  const typeById = id => { const ts = types(); return ts && id ? ts.find(t => t.id === id) || null : null; };
  const st = () => (F && F.store) || null;
  const typeOfAccount = a => (F && typeof F.typeOf === 'function' ? F.typeOf(a) : null);
  const typesNote = () => { const S = F && F.S; if (!S) return ''; return S.typesState === 'cache' ? 'The Desk is not reachable: the list as of ' + GC.asOfText(S.typesAsOf) + '.' : S.typesState === 'none' ? 'The Desk is not reachable and this browser has no copy of its account types.' : !types() ? 'Reading The Desk\'s account types...' : ''; };
  /* a new group's link waits for ChartBridge's answer (its id), found by its name; links of groups that are gone are dropped */
  function syncLinks() {
    const list = F && F.S.groups;
    if (!list || F.S.groupsError) return;
    if (P.pendingLink) { const g = list.find(x => x.name.toLowerCase() === P.pendingLink.name); if (g) { GC.saveLink(st(), g.id, P.pendingLink.link); P.pendingLink = null; } }
    const links = GC.readLinks(st());
    for (const id of Object.keys(links)) if (!list.some(g => g.id === id)) GC.saveLink(st(), id, null);
  }
  const can = () => !!(F && F.S.groups && F.S.signedIn && F.S.enabled);
  function post(msg, done) {
    if (!can() || !F.post(msg)) { say('Not sent: not connected to ChartBridge.', true); return false; }
    if (done) say(done);
    return true;
  }
  function render() {
    const show = !!(F && F.S.groups);
    if (host.sec.hidden === show) host.sec.hidden = !show;
    if (host.wide) host.wide(show);   // the workspace's third Settings column
    if (!show) return;
    syncLinks();
    const list = groups(), err = F.S.groupsError, links = GC.readLinks(st());
    /* 1.30.0: under a group filled from a type: "rules differ from <type>: Update" when its rules are not the type's current ones, and
       the members whose own type is another (warnings only, nothing blocked) */
    const typeLines = g => {
      const l = links[g.id]; if (!l) return '';
      const t = typeById(l.id), diff = t ? GC.rulesDiffer(g, t) : [], off = GC.membersOff(g, l, typeOfAccount);
      const lines = (diff.length ? `<span class="gp-differ ws-warn" title="${esc('Differs in: ' + diff.join(', ') + '. Filled from version ' + l.version + '; the type is at version ' + t.version + '.')}"><span class="gp-dt">rules differ from ${esc(GC.typeLabel(t))}:</span> <button type="button" class="ws-btn gp-b gp-upd" data-gp="update" data-id="${esc(g.id)}">Update</button></span>` : '') +
        (off.length ? `<span class="gp-differ ws-warn"><span class="gp-dt">${esc(off.slice(0, 3).map(x => x.account + ' is ' + (x.type.firm ? x.type.firm + ' ' : '') + x.type.name).join('; ') + (off.length > 3 ? '; and ' + (off.length - 3) + ' more' : ''))}: not the group's type</span></span>` : '');
      return lines ? '<span class="gp-tlines">' + lines + '</span>' : '';
    };
    const fromText = g => { const l = links[g.id]; if (!l) return ''; const t = typeById(l.id); return ' · from ' + (t ? GC.typeLabel(t) : l.label); };
    const rows = list.map(g => {
      if (P.confirm === g.id) return `<div class="gp-row gp-ask" role="listitem"><span class="gp-askt">Delete ${esc(g.name)}? ${g.members.length ? 'Its ' + esc(GC.membersText(g)) + ' go to None.' : 'It has no accounts.'}</span>` +
        `<button type="button" class="ws-btn gp-yes" data-gp="del-yes" data-id="${esc(g.id)}">Delete</button><button type="button" class="ws-btn" data-gp="del-no">Keep</button></div>`;
      return `<div class="gp-row" role="listitem" data-id="${esc(g.id)}"><span class="gp-txt"><b class="gp-name">${esc(g.name)}</b><span class="gp-sum" title="${esc(GC.summary(g) + ' · ' + GC.membersText(g) + ' · ' + GC.sideText(g))}">${esc(GC.summary(g))} · ${esc(GC.membersText(g))} · ${esc(GC.typeText(g))} · ${esc(GC.heroText(g, heroName))}${g.side ? ' · ' + esc(g.side === 'mixed' ? 'long and short' : g.side) : ''}${esc(fromText(g))}</span></span>` +
        `<button type="button" class="gp-switch" role="switch" aria-checked="${g.noHedge}" data-gp="hedge" data-id="${esc(g.id)}" title="No hedging inside this group: counts positions and working entries; covers agents, bots, copier followers and your ticket; exits always go"><span class="gp-knob" aria-hidden="true"></span><span class="visually-hidden">No hedging in ${esc(g.name)}</span></button>` +
        `<button type="button" class="ws-btn gp-b" data-gp="edit" data-id="${esc(g.id)}">Edit</button><button type="button" class="ws-btn gp-b" data-gp="rename" data-id="${esc(g.id)}">Rename</button><button type="button" class="ws-btn gp-b" data-gp="del" data-id="${esc(g.id)}">Delete</button>${typeLines(g)}</div>`;
    }).join('');
    const html = (err ? `<p class="ws-help ws-warn" role="alert">${esc(err)}</p>` : '') + (rows || '<p class="ws-help gp-none">No groups yet. Personal accounts sit in no group.</p>');
    if (host.list.dataset.html !== html) { host.list.dataset.html = html; host.list.innerHTML = html; }
    host.add.disabled = !can() || !!err;
  }
  host.list.addEventListener('click', e => {
    const b = e.target.closest('[data-gp]'); if (!b) return;
    const g = groups().find(x => x.id === b.dataset.id), act = b.dataset.gp;
    if (act === 'del-no') { P.confirm = ''; render(); return; }
    if (!g) return;
    if (act === 'hedge') post(GC.saveFrom(g, { noHedge: !g.noHedge }, cid()), 'No hedging ' + (g.noHedge ? 'off' : 'on') + ' for ' + g.name + ': sent to ChartBridge.');
    else if (act === 'edit') openRules(g);
    else if (act === 'update') { const l = GC.readLinks(st())[g.id], t = l ? typeById(l.id) : null; if (t) openRules(g, t); }
    else if (act === 'rename') openRename(g);
    else if (act === 'del') { P.confirm = g.id; render(); }
    else if (act === 'del-yes') { P.confirm = ''; if (post({ type: 'groupDelete', cid: cid(), group: g.id }, 'Delete ' + g.name + ': sent to ChartBridge.')) GC.saveLink(st(), g.id, null); render(); }
  });
  host.add.addEventListener('click', () => openRules(null));

  /* Rename: one box (the whole group goes again, as the contract asks) */
  function openRename(g) {
    const d = host.dialog;
    d.innerHTML = `<form class="ws-dlg" method="dialog" aria-label="Rename ${esc(g.name)}"><h2>Rename ${esc(g.name)}</h2><label for="gpName">Group name</label>` +
      `<input id="gpName" type="text" maxlength="${GC.NAME_MAX}" autocomplete="off" spellcheck="false" value="${esc(g.name)}"><p class="ws-err" id="gpNameErr" role="alert"></p>` +
      '<div class="ws-dlg-btns"><button type="button" class="ws-btn" data-act="cancel">Cancel</button><button type="submit" class="ws-btn primary">Save</button></div></form>';
    host.showDialog(d, () => {
      const name = d.querySelector('#gpName').value.trim();
      const r = GC.groupMessage(Object.assign(GC.formOf(g), { name }), groups(), g.id, cid());
      if (r.error) { d.querySelector('#gpNameErr').textContent = r.error; return false; }
      return post(r.msg, 'Rename ' + g.name + ' to ' + name + ': sent to ChartBridge.');
    });
    const i = d.querySelector('#gpName'); i.focus(); i.select();
  }

  /* Edit and New: the firm's rules (Anthony's approved mockup: the name, the firm's rules, one direction) */
  function openRules(g, refill) {
    const d = host.dialog, f = GC.formOf(g);
    /* 1.30.0: the Account type select at the top: Not set, then every type of The Desk's ledger ("(not checked)" until checked) */
    const ts = types() || [], link = g ? GC.readLinks(st())[g.id] || null : null;
    const startType = refill ? refill.id : link && ts.some(t => t.id === link.id) ? link.id : '';
    const typeSel = `<div class="gp-f gp-ftype"><label for="gp-fromType">Account type</label><div class="gp-herorow"><select class="ws-sel gp-in" id="gp-fromType" title="Fills every rule box and the Type from The Desk's ledger; you can still change any box">` +
      '<option value="">Not set</option>' + ts.map(t => `<option value="${esc(t.id)}"${t.id === startType ? ' selected' : ''}>${esc(GC.typeLabel(t))}</option>`).join('') +
      `</select><span class="ws-help gp-herowhy" id="gp-fromWhy" role="status"></span></div></div>`;
    const box = (k, label, help) => `<div class="gp-f"><label for="gp-${k}">${label}</label><input class="ws-in gp-in" id="gp-${k}" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="${help}" value="${esc(f[k])}"></div>`;
    d.innerHTML = `<form class="ws-dlg ws-gp" method="dialog" aria-label="${g ? 'Edit ' + esc(g.name) : 'New group'}">
      <h2>${g ? 'Edit ' + esc(g.name) : 'New group'} <span>${g ? esc(GC.membersText(g)) : 'shows in every account\'s Group dropdown'}</span></h2>
      ${typeSel}
      <div class="gp-f gp-fname"><label for="gp-name">Group name</label><input class="ws-in gp-in" id="gp-name" type="text" maxlength="${GC.NAME_MAX}" autocomplete="off" spellcheck="false" value="${esc(f.name)}"></div>
      <h3 class="gp-h">The firm's rules</h3>
      <p class="ws-help">Set once. With NinjaTrader's balance these give each account its room, so the agent sizes on real numbers.</p>
      <div class="gp-grid">${box('size', 'Account size', '$')}${box('dailyLoss', 'Daily loss limit', '$ or none')}${box('drawdown', 'Drawdown size', '$')}
        <div class="gp-f"><label for="gp-drawdownType">Drawdown type</label><select class="ws-sel gp-in" id="gp-drawdownType">${GC.TYPES.map(t => `<option value="${t[0]}"${t[0] === f.drawdownType ? ' selected' : ''}>${t[1]}</option>`).join('')}</select></div>
        ${box('lockAt', 'Floor stops at', '$ or none')}${box('target', 'Profit target', '$ or none')}${box('consistency', 'Consistency %', '% or none')}
        <div class="gp-f"><label for="gp-accountType">Type</label><select class="ws-sel gp-in" id="gp-accountType" title="Evals or Funded: the Agent tab and this dialog warn when a hero's tier does not fit it (shown only)">${GC.ACCOUNT_TYPES.map(t => `<option value="${t[0]}"${t[0] === (g && g.accountType || '') ? ' selected' : ''}>${t[1]}</option>`).join('')}</select></div></div>
      <p class="ws-help">Daily room counts open P&amp;L, the way the firm does. If a number is missing, the agent uses its model numbers and says so. Consistency (no single day over that share of the profit) is shown to the agent only; nothing is blocked by it.</p>
      <h3 class="gp-h">One direction</h3>
      <label class="gp-hedge"><input type="checkbox" id="gp-noHedge"${f.noHedge ? ' checked' : ''}> No hedging inside this group <span>counts positions and working entries; covers agents, bots, copier followers and your ticket; exits always go</span></label>
      <h3 class="gp-h">Hero on duty</h3>
      <div class="gp-herorow"><select class="ws-sel gp-in" id="gp-hero" aria-label="The group's default hero"></select><span class="ws-help gp-herowhy" id="gp-heroWhy" role="status"></span></div>
      <p class="ws-help">The Agent tab picks this hero first when an agent takes this group; you can pick another there. Every hero is listed; a tier that does not fit the Type is a warning, nothing is blocked.</p>
      <p class="ws-err" id="gp-err" role="alert"></p>
      <div class="ws-dlg-btns">${g ? '<button type="button" class="ws-btn gp-del" id="gp-del">Delete group</button><span class="sg-fill"></span>' : ''}<button type="button" class="ws-btn" data-act="cancel">Close</button><button type="submit" class="ws-btn primary">Save</button></div>
    </form>`;
    const $d = id => d.querySelector('#gp-' + id);
    const lockSync = () => { const st = $d('drawdownType').value === 'static'; $d('lockAt').disabled = st; if (st) $d('lockAt').value = ''; };
    $d('drawdownType').addEventListener('change', lockSync); lockSync();
    /* 1.30.0: choosing a type fills the boxes and the Type (never the name: Anthony names his groups); Save sends groupSave as before */
    let filled = null;
    const fromWhy = (text, warn) => { $d('fromWhy').textContent = text; $d('fromWhy').classList.toggle('ws-warn', !!warn); };
    const fromIdle = () => {
      const id = $d('fromType').value, t = typeById(id), note = typesNote();
      if (!ts.length) { $d('fromType').disabled = true; fromWhy(note || 'The Desk has no account types yet.', !!note); return; }
      if (!id) { fromWhy(note, !!note); return; }
      const diff = t && g ? GC.rulesDiffer(g, t) : [];
      fromWhy((diff.length ? 'Rules differ from ' + GC.typeLabel(t) + ' (' + diff.join(', ') + ').' : 'Filled from ' + (link ? link.label : GC.typeLabel(t)) + '.') + (note ? ' ' + note : ''), diff.length > 0);
    };
    const fill = t => {
      const v = GC.typeForm(t);
      for (const k of ['size', 'dailyLoss', 'drawdown', 'lockAt', 'target', 'consistency']) $d(k).value = v[k];
      if (v.drawdownType) $d('drawdownType').value = v.drawdownType;
      if (v.accountType) $d('accountType').value = v.accountType;   // a type with no Type set keeps the group's own
      lockSync(); $d('lockAt').value = $d('drawdownType').value === 'static' ? '' : v.lockAt;
      for (const el of d.querySelectorAll('.gp-in')) el.removeAttribute('aria-invalid');
      filled = { id: t.id, version: t.version, label: t.firm + ' ' + t.name };
      const note = typesNote();
      fromWhy('Filled from ' + GC.typeLabel(t) + ', version ' + t.version + (v.missing.length ? '; it has no ' + v.missing.join(', ') + ': type ' + (v.missing.length > 1 ? 'them' : 'it') : '') + '. Change any box, then Save.' + (note ? ' ' + note : ''), v.missing.length > 0 || t.status !== 'checked');
    };
    $d('fromType').addEventListener('change', () => { const t = typeById($d('fromType').value); if (t) fill(t); else { filled = null; fromIdle(); } });
    if (refill) fill(refill); else fromIdle();
    /* 1.28.0: Hero on duty: None, then every hero the PC helper knows (its tier, and a warning when it does not fit the Type) */
    let heroWant = g && g.hero ? g.hero : '';
    const heroFill = () => {
      const sel = $d('hero'); if (!sel) return;
      const type = $d('accountType').value, H = P.heroes, reach = H ? H.reach : '';
      const opts = AH ? AH.heroOptions(H && H.status, type, reach) : [];
      const list = [{ build: '', label: 'None' }].concat(opts);
      if (heroWant && !opts.some(o => o.build === heroWant)) list.push({ build: heroWant, label: heroWant + ' (' + (reach === 'ok' ? 'not on this PC\'s helper now' : H ? 'tier unknown (the PC helper is not answering)' : 'asking the PC helper...') + ')' });
      sel.replaceChildren(...list.map(o => new Option(o.label, o.build)));
      sel.value = heroWant;
      const o = opts.find(x => x.build === heroWant);
      $d('heroWhy').textContent = !heroWant ? '' : o ? (o.fit.warn || o.fit.note || 'fits ' + (type === 'eval' ? 'Evals' : 'Funded')) : '';
      $d('heroWhy').classList.toggle('ws-warn', !!(o && o.fit.warn));
    };
    $d('hero').addEventListener('change', () => { heroWant = $d('hero').value; heroFill(); });
    $d('accountType').addEventListener('change', heroFill);
    $d('fromType').addEventListener('change', heroFill);   // 1.30.0: a fill may change the Type
    heroFill();
    askHeroes().then(() => { if (d.open && $d('hero')) heroFill(); });
    let delAsked = false;
    if (g) $d('del').addEventListener('click', () => {
      if (!delAsked) { delAsked = true; $d('del').textContent = 'Delete ' + g.name + '? Click again'; $d('err').textContent = g.members.length ? 'Its ' + GC.membersText(g) + ' go to None.' : ''; return; }
      if (post({ type: 'groupDelete', cid: cid(), group: g.id }, 'Delete ' + g.name + ': sent to ChartBridge.')) { GC.saveLink(st(), g.id, null); d.close(); }
    });
    host.showDialog(d, () => {
      for (const el of d.querySelectorAll('.gp-in')) el.removeAttribute('aria-invalid');
      const form = { name: $d('name').value, size: $d('size').value, dailyLoss: $d('dailyLoss').value, drawdown: $d('drawdown').value, drawdownType: $d('drawdownType').value,
        lockAt: $d('lockAt').value, target: $d('target').value, consistency: $d('consistency').value, noHedge: $d('noHedge').checked, accountType: $d('accountType').value, hero: $d('hero').value };
      const r = GC.groupMessage(form, groups(), g ? g.id : null, cid());
      if (r.error) { $d('err').textContent = r.error; if (r.field && $d(r.field)) { $d(r.field).setAttribute('aria-invalid', 'true'); $d(r.field).focus(); } return false; }
      if (!post(r.msg, (g ? 'Save ' : 'New group ') + r.msg.name + ': sent to ChartBridge.')) return false;
      /* 1.30.0: the group remembers the type and version it was filled from (Not set: no link; unchanged: the link it had) */
      const chosen = $d('fromType').value;
      const next = !chosen ? null : filled && filled.id === chosen ? filled : link && link.id === chosen ? link : null;
      if (g) GC.saveLink(st(), g.id, next); else P.pendingLink = next ? { name: r.msg.name.toLowerCase(), link: next } : null;
      return true;
    });
    if (refill) d.querySelector('button[type="submit"]').focus(); else $d('name').focus();
  }
  render();
  return { render, state: P };
}

return { mountSettings };
})();
