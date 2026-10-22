/*
 * Account groups (chart 1.26.0, ChartBridge 0.5.8; Anthony's decisions of 2026-10-14, items 4 and 5 with G1, G2 and G3):
 * the words the Accounts tab and the Multi-Account panel use for groups (1.26.0 to 1.36.0 also the group manager in Settings,
 * gone in 1.37.0: see below). nt8/PROTOCOL.md "Prop groups and account state (0.5.8)".
 *
 *   Accounts tab               (live/accounts.js) each account's Group dropdown, "highest close so far" asked once when an
 *                              account joins a group (G2 b), and My floor and My daily for an account in no group.
 *
 * The page asks; ChartBridge decides and saves (groups.txt, account-marks.txt): every message is the contract's
 * (groupSave, groupDelete, accountGroup, accountLimits), on the window's v3 connection (live/accounts.js createFeed), and
 * ChartBridge refuses what is wrong with its own words. One direction per group (G3 a) is ChartBridge's check under its order
 * lock; this page only shows the side and the holders it reports. No motion: nothing here moves (rule R3).
 *
 * GroupsCore: the pure parts (money words, the rules line, the form's checks and the messages). No DOM; it also loads in Node for
 * test/groups.test.js. Chart 1.37.0 (ChartBridge 0.6.7, Anthony 2026-10-22): the Settings section and its group dialog (GroupsPage) are
 * gone: a group is made and set (name, Type, risk percent, Delete) on the Multi-Account panel (live/multi-account.js); its own
 * rules and its hero left the page (each account's rules come from its type on The Desk), and no hedging is always on.
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
 * Chart 1.33.0 (ChartBridge 0.6.5, Anthony 2026-10-19, PRIORITY): a group may hold accounts of different types and sizes. Each member
 * carries its own rules (account size, daily loss, drawdown and type, floor stops at, target, consistency, max minis and micros);
 * the group keeps what is shared (name, Type, hero, No hedging, the risk percent) and its own rules stay as the rules of a member
 * with none of its own (every member of a group made before 0.6.5). Anthony: "I shouldnt have to manually assign the account
 * types": joining takes the account's rules from its type on The Desk (GET /api/chart-accounts accountType, GET /api/account-types),
 * a number set on the account itself on The Desk winning over the type's (its source "account"), and asks only the highest close
 * (prefilled from The Desk's seed floor plus the drawdown when The Desk has one). Only an account with no type on The Desk gets the
 * full rules form. deskRules, rulesForm, rulesCheck, memberRulesMessage below; the Accounts tab draws them (live/accounts.js).
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

/** The firm's rules in one line: "$50,000 · daily $1,000 · drawdown $2,000 end of day, stops at $50,100 · target $3,000"; 1.33.0:
 *  a member's rules add "max 4 minis / 40 micros" when the firm caps the size. */
function summary(g) {
  if (!g) return '';
  return [usd(g.size), 'daily ' + (isNum(g.dailyLoss) && g.dailyLoss > 0 ? usd(g.dailyLoss) : 'none'),
    'drawdown ' + usd(g.drawdown) + ' ' + (TYPE_WORD[g.drawdownType] || g.drawdownType) + (isNum(g.lockAt) && g.lockAt > 0 ? ', stops at ' + usd(g.lockAt) : ''),
    'target ' + (isNum(g.target) && g.target > 0 ? usd(g.target) : 'none')].concat(isNum(g.consistency) && g.consistency > 0 ? ['consistency ' + g.consistency + '%'] : [])
    .concat(maxText(g) ? [maxText(g)] : []).join(' · ');
}
/** 1.33.0: "max 4 minis / 40 micros" ('' when neither is capped; "max - minis / 40 micros" when one is) */
const maxText = r => (r && ((isNum(r.maxMinis) && r.maxMinis > 0) || (isNum(r.maxMicros) && r.maxMicros > 0))
  ? 'max ' + (r.maxMinis > 0 ? r.maxMinis : '-') + ' minis / ' + (r.maxMicros > 0 ? r.maxMicros : '-') + ' micros' : '');
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
  const rc = rulesCheck(f);
  if (rc.error) return rc;
  const n = rc.rules, con = n.consistency, type = n.drawdownType;
  /* 1.33.0 (ChartBridge 0.6.5): the risk percent, of each member's max loss (its drawdown amount); empty or 0 is off. Sent only
     when the dialog has the box (riskPct given), so an older ChartBridge (it refuses a key it does not know) is never sent one */
  let risk;
  if (f.riskPct !== undefined) {
    const rt = String(f.riskPct === null ? '' : f.riskPct).trim().replace(/%$/, '').trim();
    risk = rt === '' ? 0 : /^(?:0|[1-9][0-9]?|100)(?:\.[0-9]{1,2})?$/.test(rt) && Number(rt) <= 100 ? Number(rt) : NaN;
    if (!isFinite(risk)) return { error: 'Risk: a percent of each account\'s max loss from 0.01 to 100, or empty for off.', field: 'riskPct' };
  }
  const at = f.accountType === undefined || f.accountType === null ? '' : f.accountType, hero = String(f.hero === undefined || f.hero === null ? '' : f.hero).trim();
  if (!ACCOUNT_TYPES.some(t => t[0] === at)) return { error: 'Type: Evals, Funded or not set.', field: 'accountType' };
  if (hero && !HERO_RX.test(hero)) return { error: 'Hero on duty: a build name of 1 to 64 letters, digits, dots, underscores or hyphens, or none.', field: 'hero' };
  return { msg: Object.assign({ type: 'groupSave' }, cid ? { cid } : {}, id ? { group: id } : {}, { name, noHedge: f.noHedge !== false,
    dailyLoss: n.dailyLoss, drawdown: n.drawdown, drawdownType: type, target: n.target, size: n.size, lockAt: n.lockAt, consistency: con }, f.accountType !== undefined ? { accountType: at || '-' } : {}, f.hero !== undefined ? { hero: hero || '-' } : {},
    risk !== undefined ? { riskPct: risk } : {}) };   // 1.28.0: absent keeps them (ChartBridge 0.6.1); 1.33.0: riskPct too (0.6.5)
}
/**
 * 1.33.0: one set of rules as typed ({ size, dailyLoss, drawdown, drawdownType, lockAt, target, consistency, maxMinis, maxMicros },
 * boxes as text) checked as ChartBridge checks them: { rules } (numbers, 0 for none) or { error, field }. The group's dialog and a
 * member's rules form both use it.
 */
function rulesCheck(f) {
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
  n.consistency = con;
  const type = f.drawdownType;
  if (!TYPES.some(t => t[0] === type)) return { error: 'Drawdown type: end of day, intraday or static.', field: 'drawdownType' };
  n.drawdownType = type;
  if (n.drawdown >= n.size) return { error: 'The drawdown must be less than the account size.', field: 'drawdown' };
  if (n.lockAt > 0 && type === 'static') return { error: 'Floor stops at is for a trailing drawdown only (leave it empty for static).', field: 'lockAt' };
  if (n.lockAt > 0 && n.lockAt <= n.size - n.drawdown) return { error: 'Floor stops at must be above the starting floor (' + usd(n.size - n.drawdown) + ').', field: 'lockAt' };
  for (const [k, label] of [['maxMinis', 'Max minis'], ['maxMicros', 'Max micros']]) {
    if (f[k] === undefined) continue;
    const t = String(f[k] === null ? '' : f[k]).trim();
    if (t !== '' && !/^(?:0|[1-9][0-9]{0,3})$/.test(t)) return { error: label + ': whole contracts from 1 to 1000, or empty for none.', field: k };
    const v = t === '' ? 0 : Number(t);
    if (v > 1000) return { error: label + ': whole contracts from 1 to 1000, or empty for none.', field: k };
    n[k] = v;
  }
  return { rules: n };
}
/** 1.33.0: the rule keys of a message (accountGroup, memberRules) from checked rules and The Desk's type id (or none). */
function ruleKeys(r, typeId) {
  return Object.assign({ size: r.size, dailyLoss: r.dailyLoss || 0, drawdown: r.drawdown, drawdownType: r.drawdownType, lockAt: r.lockAt || 0, target: r.target || 0, consistency: r.consistency || 0,
    maxMinis: r.maxMinis || 0, maxMicros: r.maxMicros || 0 }, typeId && TYPE_ID_RX.test(typeId) ? { typeId } : {});
}
/** 1.33.0: memberRules for a member's rules form ({ ...boxes, typeId }): { msg } or { error, field }. */
function memberRulesMessage(account, f, cid) {
  const rc = rulesCheck(f);
  if (rc.error) return rc;
  return { msg: Object.assign({ type: 'memberRules' }, cid ? { cid } : {}, { account }, ruleKeys(rc.rules, f.typeId)) };
}
/** 1.33.0: a member's rules form's boxes from rules (as ChartBridge or deskRules gave them; null numbers are empty boxes). */
function rulesForm(r) {
  r = r || {};
  const whole = v => (isNum(v) && v > 0 ? String(Math.round(v)) : '');
  return { size: moneyBox(r.size), dailyLoss: moneyBox(r.dailyLoss), drawdown: moneyBox(r.drawdown), drawdownType: r.drawdownType || 'eod', lockAt: moneyBox(r.lockAt), target: moneyBox(r.target),
    consistency: isNum(r.consistency) && r.consistency > 0 ? String(r.consistency) : '', maxMinis: whole(r.maxMinis), maxMicros: whole(r.maxMicros), typeId: typeof r.typeId === 'string' ? r.typeId : '' };
}
/**
 * 1.33.0 (Anthony 2026-10-19: "match the accounts going into a group to our desk pool ... so its all automatic"): an account's rules
 * from The Desk. row: its GET /api/chart-accounts row (live/accounts.js cleanDesk), types: the account types list (cleanTypes).
 * The type's rules, then each number Anthony set on the account itself on The Desk (source "account") in its place: account size,
 * daily loss limit, and the trailing drawdown (a trailing type's drawdown). Returns { rules, type, from: words, overrides: [words] }
 * or { error } when there is nothing to take them from (no type on The Desk, its type not on the list, or a size, drawdown or
 * drawdown type missing): the page then shows the full form.
 */
function deskRules(row, types) {
  const at = row && row.accountType;
  if (!at) return { error: 'no account type on The Desk' };
  const t = (types || []).find(x => x.id === at.id);
  if (!t) return { error: 'its account type (' + (at.name || at.id) + ') is not on The Desk\'s list now' };
  const r = { size: t.size, dailyLoss: t.dailyLoss, drawdown: t.drawdown, drawdownType: t.drawdownType, lockAt: lockOf(t), target: t.target, consistency: t.consistency, maxMinis: t.maxMinis, maxMicros: t.maxMicros, typeId: t.id };
  const src = row.source && typeof row.source === 'object' ? row.source : {}, over = [];
  if (src.account_size === 'account' && posMoney(row.account_size)) { r.size = row.account_size; over.push('account size ' + usd(r.size)); }
  if (src.daily_loss_limit === 'account' && posMoney(row.daily_loss_limit)) { r.dailyLoss = row.daily_loss_limit; over.push('daily loss ' + usd(r.dailyLoss)); }
  if (src.trailing_drawdown === 'account' && posMoney(row.trailing_drawdown) && r.drawdownType !== 'static') { r.drawdown = row.trailing_drawdown; over.push('drawdown ' + usd(r.drawdown)); }
  const missing = [[!r.size, 'account size'], [!r.drawdown, 'drawdown size'], [!r.drawdownType, 'drawdown type']].filter(x => x[0]).map(x => x[1]);
  if (missing.length) return { error: typeLabel(t) + ' has no ' + missing.join(', ') };
  const rc = rulesCheck(Object.assign(rulesForm(r), { drawdownType: r.drawdownType }));
  if (rc.error) return { error: typeLabel(t) + ': ' + rc.error };
  return { rules: Object.assign(rc.rules, { typeId: t.id }), type: t, from: typeLabel(t), overrides: over };
}
/** 1.33.0: the "highest close so far" prefill from The Desk's seed floor (its seed_floor for the account plus the drawdown), or null
 *  when The Desk has none for it: { value, words }. */
function seedHigh(row, rules) {
  const f = row && posMoney(row.seedFloor);
  if (!f || !rules || !(rules.drawdown > 0)) return null;
  const v = Math.round((f + rules.drawdown) * 100) / 100;
  return { value: v, date: row.seedDate || '', words: 'The Desk\'s seed floor ' + usd(f) + (row.seedDate ? ' (' + row.seedDate + ')' : '') + ' plus the drawdown ' + usd(rules.drawdown) };
}
/** 1.33.0: the risk percent in words, and one member's dollars at it (the percent of its max loss, its drawdown amount). */
/** 1.33.0: ChartBridge 0.6.5 or later keeps each member's own rules (its hello's version, "0.6.5"). */
function perMemberVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  if (!m) return false;
  const n = [+m[1], +m[2], +m[3]];
  return n[0] > 0 || n[1] > 6 || (n[1] === 6 && n[2] >= 5);
}
const riskText = g => (g && isNum(g.riskPct) && g.riskPct > 0 ? 'risk ' + g.riskPct + '% of each account\'s max loss' : 'risk off');
const riskDollars = (g, r) => (g && isNum(g.riskPct) && g.riskPct > 0 && r && isNum(r.drawdown) && r.drawdown > 0 ? Math.round(g.riskPct * r.drawdown) / 100 : null);
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
    consistency: isNum(g.consistency) && g.consistency > 0 ? String(g.consistency) : '', noHedge: g.noHedge !== false, riskPct: isNum(g.riskPct) && g.riskPct > 0 ? String(g.riskPct) : '' };
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
function joinMessage(account, groupId, highText, cid, word, rules) {
  const m = Object.assign({ type: 'accountGroup' }, cid ? { cid } : {}, { account, group: groupId || null });
  /* 1.33.0 (ChartBridge 0.6.5): the account's own rules ({ rules, typeId } from rulesCheck or deskRules) go with the join */
  if (groupId && rules) Object.assign(m, ruleKeys(rules, rules.typeId));
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
    .map(g => Object.assign({ id: g.id, name: g.name, noHedge: g.noHedge !== false, dailyLoss: isNum(g.dailyLoss) ? g.dailyLoss : null, drawdown: isNum(g.drawdown) ? g.drawdown : null,
      drawdownType: g.drawdownType, target: isNum(g.target) ? g.target : null, size: isNum(g.size) ? g.size : null, lockAt: isNum(g.lockAt) ? g.lockAt : null, consistency: isNum(g.consistency) ? g.consistency : null,
      accountType: g.accountType === 'eval' || g.accountType === 'funded' ? g.accountType : null, hero: typeof g.hero === 'string' && HERO_RX.test(g.hero) ? g.hero : null,
      members: Array.isArray(g.members) ? g.members.filter(x => typeof x === 'string') : [], side: ['long', 'short', 'mixed'].includes(g.side) ? g.side : null,
      holders: Array.isArray(g.holders) ? g.holders.filter(h => h && typeof h.account === 'string') : [],
      /* 1.33.0: ChartBridge 0.6.5 sends riskPct and ownRules (perMember: it keeps each member's own rules) */
      perMember: 'riskPct' in g && Array.isArray(g.ownRules), riskPct: isNum(g.riskPct) && g.riskPct > 0 ? g.riskPct : null, ownRules: Array.isArray(g.ownRules) ? g.ownRules.filter(x => typeof x === 'string') : [],
      /* review 4: the members a group entry leaves out (the copier's, the bot's, an agent's), with why */
      tradeOut: Array.isArray(g.tradeOut) ? g.tradeOut.filter(x => x && typeof x.account === 'string' && typeof x.why === 'string') : [] },
      /* 1.37.0 (ChartBridge 0.6.7): the members on the bench (members still); absent from an older ChartBridge */
      Array.isArray(g.benched) ? { benched: g.benched.filter(x => typeof x === 'string') } : {}));
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
      status: t.status === 'checked' ? 'checked' : 'not_checked', version: Number.isInteger(t.version) && t.version >= 0 ? t.version : 0,
      maxMinis: Number.isInteger(t.max_nq) && t.max_nq > 0 && t.max_nq <= 1000 ? t.max_nq : null, maxMicros: Number.isInteger(t.max_mnq) && t.max_mnq > 0 && t.max_mnq <= 1000 ? t.max_mnq : null });   // 1.33.0: the firm's max size
    out[out.length - 1].lockAt = lockOf(out[out.length - 1]);
  }
  out.sort((a, b) => a.firm.localeCompare(b.firm, 'en', { sensitivity: 'base' }) || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.id < b.id ? -1 : 1));
  return { types: out, asOf: typeof json.asOf === 'string' && json.asOf.length <= 40 ? json.asOf : '' };
}
/** "Lucid 50K Flex, no DLL", with " (not checked)" until Anthony marks the type checked on The Desk. */
const typeLabel = t => (t ? t.firm + ' ' + t.name + (t.status === 'checked' ? '' : ' (not checked)') : '');
/*
 * Chart 1.32.0 (Anthony 2026-10-19: "far to many accounts for just a drop down"; he chose Firm > Plan > Size, "firms I actually
 * trade first"): the type picker as three short selects. The Desk's names follow "<Plan> <Size>K <rest>" ("LucidFlex 50K Eval",
 * "Trading Combine 50K", "Master 25K Option 2 EOD"). Pure: the Accounts tab and the rules dialog both draw from cascadeView and
 * move with cascadePick; only the last select (a type) or "Not set" gives a value to send (the Accounts tab sends it on Save,
 * the rules dialog fills from it and saves on its Save).
 */
const SIZE_RX = /(^|[\s(])(\d+(?:\.\d+)?)[kK](?=$|[^A-Za-z0-9])/;
const PLAN_OTHER = 'Other';
const cmpText = (a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' });
/** A type's name split: { plan, size (the number before K, or null), sizeText ("50K"), rest, short (the last select's label) }.
 *  plan is the text before the first "<number>K" token; no size token (or nothing before it): plan "Other" and the whole name as
 *  the label. */
function typeParts(t) {
  const name = t && typeof t.name === 'string' ? t.name.trim() : '';
  const m = SIZE_RX.exec(name);
  const plan = m ? name.slice(0, m.index).trim() : '';
  if (!m || !plan) return { plan: PLAN_OTHER, size: null, sizeText: '', rest: name, short: name };
  const sizeText = m[2] + 'K', rest = name.slice(m.index + m[0].length).replace(/^[\s,]+/, '').trim();
  return { plan, size: +m[2], sizeText, rest, short: rest ? sizeText + ' ' + rest : sizeText };
}
/** The stage within a size: 0 Eval, Challenge or Test; 2 Funded, Qualified, Sim-Funded or Account; 1 anything else. */
function stageRank(rest) {
  const s = ' ' + String(rest || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
  if (/ (eval|evaluation|challenge|test) /.test(s)) return 0;
  if (/ (funded|qualified|sim funded|account) /.test(s)) return 2;
  return 1;
}
/** The firms in use, as a list: each chart-accounts row's accountType.firm (an account whose type is set on The Desk) and the
 *  row's own firm (the firm The Desk gives the account, type set or not; Anthony 2026-10-19). */
function usedFirms(rows) {
  const out = new Set(), add = f => { if (typeof f === 'string' && f.trim()) out.add(f.trim()); };
  for (const r of rows || []) { if (!r) continue; if (r.accountType) add(r.accountType.firm); add(r.firm); }
  return [...out];
}
/** The types as a tree: [{ firm, used, plans: [{ plan, types: [{ t, parts }] }] }]. Firms in use first (A to Z), then the other
 *  firms A to Z; within a firm, plans A to Z; within a plan by size, then the stage (Eval before Funded), then the rest A to Z. */
function typeTree(types, used) {
  const inUse = new Set((used || []).map(f => String(f).toLowerCase())), firms = new Map();
  for (const t of types || []) {
    if (!t || !t.firm) continue;
    const key = t.firm.toLowerCase();
    if (!firms.has(key)) firms.set(key, { firm: t.firm, used: inUse.has(key), plans: new Map() });
    const f = firms.get(key), parts = typeParts(t), pk = parts.plan.toLowerCase();
    if (!f.plans.has(pk)) f.plans.set(pk, { plan: parts.plan, types: [] });
    f.plans.get(pk).types.push({ t, parts });
  }
  const byType = (a, b) => (a.parts.size === null) - (b.parts.size === null) || (a.parts.size || 0) - (b.parts.size || 0) ||
    stageRank(a.parts.rest) - stageRank(b.parts.rest) || cmpText(a.parts.rest, b.parts.rest) || cmpText(a.t.name, b.t.name) || (a.t.id < b.t.id ? -1 : 1);
  return [...firms.values()].sort((a, b) => (b.used - a.used) || cmpText(a.firm, b.firm))
    .map(f => ({ firm: f.firm, used: f.used, plans: [...f.plans.values()].sort((a, b) => cmpText(a.plan, b.plan)).map(p => ({ plan: p.plan, types: p.types.sort(byType) })) }));
}
const sameText = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
/** Where a type id sits in the tree: { firm, plan } or null. */
function cascadeOf(tree, id) {
  if (!id) return null;
  for (const f of tree || []) for (const p of f.plans) if (p.types.some(x => x.t.id === id)) return { firm: f.firm, plan: p.plan };
  return null;
}
/** The picker's place for a saved type id (or a type no longer on the list, gone = { firm, name }): { firm, plan, id }. */
function cascadeStart(tree, id, gone) {
  const at = cascadeOf(tree, id);
  if (at) return { firm: at.firm, plan: at.plan, id };
  if (id && gone) return { firm: gone.firm || '', plan: typeParts(gone).plan, id };
  return { firm: '', plan: '', id: '' };
}
/**
 * One choice in the picker. state { firm, plan, id } (id: the type chosen now, '' = Not set); which 'firm', 'plan' or 'type'.
 * Returns { state, send }: send undefined (nothing is sent), null (Not set) or a type id. Changing Firm or Plan never sends;
 * Not set sends null only when a type was set; a type sends its id (not the one already chosen).
 */
function cascadePick(tree, state, which, value) {
  const s = Object.assign({ firm: '', plan: '', id: '' }, state || {}), v = value || '';
  if (which === 'firm') {
    if (!v) return { state: { firm: '', plan: '', id: '' }, send: s.id ? null : undefined };
    const f = (tree || []).find(x => sameText(x.firm, v)), at = cascadeOf(tree, s.id);
    const plan = at && sameText(at.firm, v) ? at.plan : f && f.plans.length === 1 ? f.plans[0].plan : '';
    return { state: { firm: f ? f.firm : v, plan, id: s.id }, send: undefined };
  }
  if (which === 'plan') return { state: { firm: s.firm, plan: v, id: s.id }, send: undefined };
  if (which === 'type') {
    if (!v || v === s.id) return { state: s, send: undefined };
    const at = cascadeOf(tree, v);
    return { state: { firm: at ? at.firm : s.firm, plan: at ? at.plan : s.plan, id: v }, send: v };
  }
  return { state: s, send: undefined };
}
/**
 * The three selects as data: { firm: { value, options }, plan: {...}, type: {...} }, each option { value, label, title }.
 * Firm: "Not set", then the firms (in use first). Plan: that firm's plans ("Plan" until one is picked). Size: that plan's types
 * by their short label ("50K Eval", "(not checked)" after it until checked; "Size" until one is picked), the whole name in each
 * option's title. gone ({ firm, name } of a saved type no longer on the list) shows where it was, "(not on The Desk's list now)".
 */
function cascadeView(tree, state, gone) {
  const s = Object.assign({ firm: '', plan: '', id: '' }, state || {});
  const f = (tree || []).find(x => sameText(x.firm, s.firm)) || null, p = f ? f.plans.find(x => sameText(x.plan, s.plan)) || null : null;
  const goneHere = !!(gone && s.id && !cascadeOf(tree, s.id) && sameText(gone.firm, s.firm) && sameText(typeParts(gone).plan, s.plan));
  const firms = [{ value: '', label: 'Not set', title: 'Not set' }].concat((tree || []).map(x => ({ value: x.firm, label: x.firm, title: x.firm + (x.used ? ' (an account of yours has a type of it)' : '') })));
  if (s.firm && !f) firms.push({ value: s.firm, label: s.firm, title: s.firm });
  const plans = f ? f.plans.map(x => ({ value: x.plan, label: x.plan, title: f.firm + ' ' + x.plan })) : [];
  if (s.plan && !p) plans.push({ value: s.plan, label: s.plan, title: (s.firm ? s.firm + ' ' : '') + s.plan });
  if (!s.plan) plans.unshift({ value: '', label: 'Plan', title: 'Pick a plan' });
  const types = p ? p.types.map(x => ({ value: x.t.id, label: x.parts.short + (x.t.status === 'checked' ? '' : ' (not checked)'), title: typeLabel(x.t) })) : [];
  if (goneHere) { const gp = typeParts(gone), w = gp.short + ' (not on The Desk\'s list now)'; types.push({ value: s.id, label: w, title: (gone.firm ? gone.firm + ' ' : '') + gone.name + ' (not on The Desk\'s list now)' }); }
  const typeVal = types.some(x => x.value === s.id) ? s.id : '';
  if (!typeVal) types.unshift({ value: '', label: 'Size', title: s.plan ? 'Pick the size and stage' : 'Pick a firm and a plan first' });
  return { firm: { value: f ? f.firm : s.firm, options: firms }, plan: { value: s.plan ? (p ? p.plan : s.plan) : '', options: plans }, type: { value: typeVal, options: types } };
}

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
  TYPE_ID_RX, TYPES_CACHE_KEY, LINKS_KEY, cleanTypes, typeLabel, typeForm, rulesDiffer, typeLimits, applyWords, applySend, TRAILING_FLOOR_WORDS, asOfText, readTypesCache, writeTypesCache, readLinks, saveLink, membersOff,
  PLAN_OTHER, typeParts, stageRank, usedFirms, typeTree, cascadeOf, cascadeStart, cascadePick, cascadeView,
  maxText, perMemberVersion, rulesCheck, ruleKeys, memberRulesMessage, rulesForm, deskRules, seedHigh, riskText, riskDollars };
});
