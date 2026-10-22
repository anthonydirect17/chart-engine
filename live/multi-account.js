/*
 * The Multi-Account panel (chart 1.37.0, ChartBridge 0.6.7; Anthony 2026-10-22: "I would like to have the ability to quickly swap out
 * accounts in and out of the group while flat ... a group panel, showing each account chip thats in the group and the ones on the
 * side line, when I click and drag a chip into the group, it trades with, when its on the bench, it sits out"). + Add panel,
 * one a layout. nt8/PROTOCOL.md "The bench (0.6.7)".
 *
 *   Groups   the group dropdown, the group's risk percent (of each account's own max loss, changed only while the group is flat),
 *            Group settings (name, Type, Delete) and New group; two lanes of account chips: "Trades with the group" and "Bench".
 *            A click or a drag moves a chip: memberBench to ChartBridge, refused unless that account is flat with no working
 *            orders (the reason shows on the chip). A benched account stays a member (its rules, highest close and firm are
 *            kept; nothing is asked again) and sits out every new group entry; its exits, stops, cancels and flattens go as
 *            always. Each chip shows its own dollar risk at the group's percent; the lane sums the dollars at risk a trade.
 *            Only this firm's accounts show (the firm of the members' types on The Desk): the bench also lists the firm's
 *            accounts in no group, which join on the Accounts tab (Group). An account with no type on The Desk cannot trade
 *            with a group until it has one.
 *   Copier   the copier exactly as it was on the Account page (live/accounts.js, mounted with only: 'cop'); the Account page has
 *            no Copier tab from 1.37.0.
 *
 * Real data only: every chip is ChartBridge's account (its room, its rules) and The Desk's type; nothing here is sample data.
 * No motion (rule R3: order surfaces stay instant).
 *
 * Two parts, as accounts.js:
 *   MultiAccountCore   the pure parts (the lanes, the sums, the checks and the messages). No DOM; it also loads in Node for
 *                      test/multi-account.test.js.
 *   MultiAccount       runs only in a browser: mount(el, host), used by workspace.js.
 * Made-up names only in tests and docs (Lucid, Apex, SIM-A, SIM-B).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MultiAccountCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const BENCH_VERSION = '0.6.7';
const NAME_MAX = 30;
const isNum = v => typeof v === 'number' && isFinite(v);
/** "1.2.3" at least "0.6.7" */
function verAtLeast(v, min) {
  const a = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')), b = /^(\d+)\.(\d+)\.(\d+)/.exec(min);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) { if (+a[i] !== +b[i]) return +a[i] > +b[i]; }
  return true;
}
/** ChartBridge 0.6.7 keeps the bench: its groups carry `benched` (or its hello says 0.6.7 or later) */
const benchOn = (g, version) => !!(g && Array.isArray(g.benched)) || verAtLeast(version, BENCH_VERSION);
/** Dollars as the panel shows them: $1,840, $1,840.50 */
function usd(v) {
  if (!isNum(v)) return '';
  const cents = Math.round(Math.abs(v) * 100), whole = Math.floor(cents / 100), c = cents % 100;
  return (v < 0 && cents ? '-' : '') + '$' + String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (c ? '.' + String(c).padStart(2, '0') : '');
}
/** An account's firm on The Desk: its type's firm, else the firm The Desk gives the account itself ('' when neither) */
const firmOfRow = row => (row && row.accountType && row.accountType.firm ? String(row.accountType.firm) : row && typeof row.firm === 'string' ? row.firm : '').trim();
const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
/**
 * The group's firm: the firm most of its members' types on The Desk name (Anthony names groups per firm); with no typed member, the
 * firm whose name is the group's name; else ''. desk: Map account -> The Desk's row (live/accounts.js cleanDesk).
 */
function groupFirm(g, desk) {
  if (!g) return '';
  const count = new Map();
  for (const m of g.members || []) { const row = desk && desk.get(m), f = row && row.accountType ? firmOfRow(row) : ''; if (f) count.set(f.toLowerCase(), { f, n: ((count.get(f.toLowerCase()) || {}).n || 0) + 1 }); }
  if (count.size) return [...count.values()].sort((a, b) => b.n - a.n || a.f.localeCompare(b.f))[0].f;
  if (desk) for (const row of desk.values()) { const f = firmOfRow(row); if (f && same(f, g.name)) return f; }
  return '';
}
/** What an account holds or has working now, in words ('' when flat with nothing working): "long 2 MNQ", "1 working order" */
function busyWords(a, orders) {
  const pos = (a && Array.isArray(a.positions) ? a.positions : []).filter(p => p && p.qty).map(p => (p.qty > 0 ? 'long ' : 'short ') + Math.abs(p.qty) + ' ' + p.root);
  const n = (orders || []).filter(o => o && o.account === (a && a.name)).length;
  return pos.concat(n ? [n + ' working order' + (n === 1 ? '' : 's')] : []).join(', ');
}
/**
 * The two lanes of group g. S: the feed's state ({ accounts, desk, groups }); orders: the working orders now (every account).
 * Returns { firm, active: [chip], bench: [chip], flat (no member holds or has working anything), risk (the dollars at risk a trade,
 * the active lane summed) }. A chip: { name, member, benched, label (its type on The Desk), notype, room (ChartBridge's room to the
 * floor, null not known), risk (its own dollars at the group's percent, null none), busy (words, '' flat), sim, gone }.
 */
function lanes(g, S, orders) {
  const accounts = (S && Array.isArray(S.accounts) ? S.accounts : []), desk = S && S.desk instanceof Map ? S.desk : new Map();
  const firm = groupFirm(g, desk), benched = new Set(Array.isArray(g && g.benched) ? g.benched : []);
  const chip = (name, member) => {
    const a = accounts.find(x => x && x.name === name) || null, row = desk.get(name) || null, t = row && row.accountType;
    const own = !!(a && a.rules && a.rules.own === true && isNum(a.rules.drawdown) && a.rules.drawdown > 0);
    const risk = member && own && g && isNum(g.riskPct) && g.riskPct > 0 ? Math.round(g.riskPct * a.rules.drawdown) / 100 : null;
    return { name, member, benched: member && benched.has(name), label: t ? (t.name || t.id) : 'no type on The Desk', notype: !t || (member && !own), room: a && isNum(a.roomFloor) ? a.roomFloor : null,
      risk, busy: busyWords(a, orders), sim: !!(a && a.sim === true), gone: !a || a.state === 'gone' };
  };
  const members = (g && g.members) || [];
  const active = [], bench = [];
  for (const m of members) (benched.has(m) ? bench : active).push(chip(m, true));
  /* the firm's accounts in no group sit on the bench, to be joined on the Accounts tab */
  if (firm) {
    const inGroup = new Set(accounts.filter(a => a && a.group).map(a => a.name));
    for (const [name, row] of desk) {
      if (!row || row.archived || members.includes(name) || inGroup.has(name) || !same(firmOfRow(row), firm)) continue;
      if (!accounts.some(a => a && a.name === name && a.state !== 'gone')) continue;   // only accounts ChartBridge lists now
      bench.push(chip(name, false));
    }
  }
  const byName = (x, y) => x.name.localeCompare(y.name, 'en', { sensitivity: 'base' });
  active.sort(byName); bench.sort((x, y) => (y.member - x.member) || byName(x, y));
  const flat = members.every(m => !busyWords(accounts.find(a => a && a.name === m), orders)) && !(g && g.side);
  return { firm, active, bench, flat, risk: Math.round(active.reduce((t, c) => t + (c.risk || 0), 0) * 100) / 100 };
}
/** The active lane's line: "3 accounts · $425 at risk a trade" */
const sumText = (L) => L.active.length + ' account' + (L.active.length === 1 ? '' : 's') + ' · ' + usd(L.risk) + ' at risk a trade';
const benchText = (L) => { const n = L.bench.filter(c => c.member).length, o = L.bench.length - n; return n + ' sitting out' + (o ? ', ' + o + ' not in the group' : ''); };
/**
 * Why a chip may not move to the other lane, before anything is sent ('' when it may; ChartBridge checks again and its reason wins).
 * toActive: to "Trades with the group".
 */
function moveWhy(c, toActive, groupName) {
  if (!c) return 'That account is not here any more.';
  if (!c.member) return c.name + ' is not in ' + groupName + ': put it in the group on the Accounts tab (Group) first; it joins with its rules from its type on The Desk.';
  if (toActive && c.notype) return c.name + ' has no account type on The Desk, so its risk and rules are unknown. Set its type there first (then Apply its rules on the Accounts tab).';
  if (c.busy) return c.name + ' is in a trade or has working orders (' + c.busy + '). It moves once it is flat with no working orders.';
  return '';
}
/** memberBench (ChartBridge 0.6.7): to the bench (true) or back (false) */
const benchMessage = (account, benched, cid) => Object.assign({ type: 'memberBench' }, cid ? { cid } : {}, { account, benched: !!benched });
/** The risk box as typed: { value } (0.01 to 100, at most 2 decimals) or { error } */
function parseRisk(text) {
  const t = String(text === null || text === undefined ? '' : text).trim().replace(/%$/, '').trim();
  if (!/^(?:[0-9]{1,3})(?:\.[0-9]{1,2})?$/.test(t) || !(Number(t) > 0) || Number(t) > 100) return { error: 'Risk: a percent of each account\'s max loss from 0.01 to 100.' };
  return { value: Number(t) };
}
/** A group name as typed: { name } or { error } (ChartBridge's own checks: 1 to 30 characters, unique ignoring case) */
function nameCheck(text, groups, id) {
  const name = String(text === null || text === undefined ? '' : text).trim();
  if (!name || name.length > NAME_MAX) return { error: 'Group name: 1 to ' + NAME_MAX + ' characters.' };
  if (/[\u0000-\u001f\u007f"\\]/.test(name)) return { error: 'Group name: plain letters, numbers and spaces.' };
  if ((groups || []).some(g => g && g.id !== id && String(g.name).toLowerCase() === name.toLowerCase())) return { error: 'A group named ' + name + ' is there already.' };
  return { name };
}
/**
 * groupSave for the panel: a group's name, Type and risk percent (change: { name?, accountType?, riskPct? }). ChartBridge 0.6.7 takes
 * them alone (the group's own rules are gone from the panel, each account's come from its type). An older ChartBridge needs every rule
 * of the group again (its groupSave asks for them), so its own are sent back as they are, with no hedging on. new group: g null.
 */
function saveMessage(g, change, groups, cid, bench) {
  const x = Object.assign({}, change || {});
  const nc = nameCheck(x.name !== undefined ? x.name : g && g.name, groups, g ? g.id : null);
  if (nc.error) return nc;
  const at = x.accountType !== undefined ? x.accountType : g && g.accountType;
  if (at !== undefined && at !== null && at !== '' && at !== 'eval' && at !== 'funded') return { error: 'Type: Evals or Funded.' };
  const msg = Object.assign({ type: 'groupSave' }, cid ? { cid } : {}, g ? { group: g.id } : {}, { name: nc.name });
  if (!bench) {
    if (!g || !isNum(g.size) || !isNum(g.drawdown) || !g.drawdownType) return { error: 'This needs ChartBridge ' + BENCH_VERSION + ' (it keeps no rules for the group itself).' };
    Object.assign(msg, { noHedge: true, dailyLoss: g.dailyLoss || 0, drawdown: g.drawdown, drawdownType: g.drawdownType, target: g.target || 0, size: g.size, lockAt: g.lockAt || 0, consistency: g.consistency || 0 });
  }
  if (x.accountType !== undefined || !g) msg.accountType = at || '-';
  if (x.riskPct !== undefined) msg.riskPct = x.riskPct;
  return { msg };
}

return { BENCH_VERSION, verAtLeast, benchOn, usd, firmOfRow, groupFirm, busyWords, lanes, sumText, benchText, moveWhy, benchMessage, parseRisk, nameCheck, saveMessage };
});

/* ======================================================================== MultiAccount (browser only) */
if (typeof window !== 'undefined' && typeof document !== 'undefined') window.MultiAccount = (function () {
'use strict';
const MC = window.MultiAccountCore;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PICK_KEY = 'live-ma-group-v1';   // { <panel id>: <group id> }: the group each panel shows, kept in this browser
const DEFAULT_TOAST = 'Only this firm\'s accounts show here. A chip moves only while that account is flat with no working orders.';

/**
 * Mount the panel in el. host:
 *   feed        the window's createFeed (live/accounts.js): S (accounts, desk, groups, orders, version, rejects), post(msg)
 *   panelId     this panel's id (its group pick is kept per panel)
 *   copier(el)  mounts the copier (the Account page's Copier tab, unchanged) in el; returns { render, destroy }
 *   working()   the working orders now (live/accounts.js AccountsCore.isWorking over S.orders)
 *   note(text, warn)
 * Returns { render, destroy, state }.
 */
function mount(el, host) {
  const F = host.feed, S = F.S;
  const P = { tab: 'groups', gid: '', settings: false, creating: false, delAsk: false, toast: { text: DEFAULT_TOAST, warn: false }, pending: new Map(), chipWhy: new Map(), seq: 0, key: '', drag: '' };
  const store = (() => { try { return window.localStorage; } catch (e) { return null; } })();
  const readPick = () => { try { const j = JSON.parse(store ? store.getItem(PICK_KEY) : 'null'); return j && typeof j === 'object' && typeof j[host.panelId] === 'string' ? j[host.panelId] : ''; } catch (e) { return ''; } };
  const savePick = id => { try { if (!store) return; const j = JSON.parse(store.getItem(PICK_KEY) || '{}') || {}; j[host.panelId] = id; store.setItem(PICK_KEY, JSON.stringify(j)); } catch (e) { /* blocked: this window only */ } };
  P.gid = readPick();
  el.innerHTML = '<div class="ma" data-ma>' +
    '<div class="ac-tabs ma-tabs" role="tablist" aria-label="Multi-Account"><button type="button" role="tab" class="ac-tab" data-tab="groups" aria-selected="true">Groups</button>' +
    '<button type="button" role="tab" class="ac-tab" data-tab="copier" aria-selected="false">Copier</button></div>' +
    '<div class="ma-body" data-pane="groups" role="tabpanel" aria-label="Groups"></div>' +
    '<div class="ma-cop" data-pane="copier" role="tabpanel" aria-label="Copier" hidden></div></div>';
  const q = s => el.querySelector(s);
  const body = q('[data-pane="groups"]'), copEl = q('[data-pane="copier"]');
  let cop = null;
  const cid = () => 'ma' + Date.now().toString(36) + '-' + (++P.seq);
  const say = (text, warn) => { P.toast = { text, warn: !!warn }; };
  const groups = () => S.groups || [];
  const group = () => groups().find(g => g.id === P.gid) || null;
  const benchNow = g => MC.benchOn(g, S.version);
  const can = () => !!(S.groups && S.signedIn && S.enabled && !S.groupsError);
  function post(msg, pend) {
    if (!can()) { say('Not sent: ' + (!S.groups ? 'ChartBridge sends no groups (it needs 0.5.8 or newer)' : S.groupsError ? 'groups.txt cannot be read now' : 'not connected to ChartBridge, or the page is locked') + '.', true); render(); return false; }
    if (!F.post(msg)) { say('Not sent: not connected to ChartBridge.', true); render(); return false; }
    if (pend) P.pending.set(msg.cid, Object.assign({ at: Date.now() }, pend));
    return true;
  }
  /* the answers: a refusal by its cid (its reason on the chip or the line), else the next groups message settles it */
  function settle() {
    const rej = S.rejects instanceof Map ? S.rejects : new Map();
    for (const [c, p] of [...P.pending]) {
      if (rej.has(c)) {
        const why = rej.get(c); P.pending.delete(c);
        if (p.chip) P.chipWhy.set(p.chip, why);
        say((p.what || 'Refused') + ': ' + why, true);
      } else if (p.chip && p.gid) {
        const g = groups().find(x => x.id === p.gid), on = g && Array.isArray(g.benched) && g.benched.includes(p.chip);
        if (g && on === p.benched) { P.pending.delete(c); P.chipWhy.delete(p.chip); say(p.chip + (p.benched ? ' is on the bench: it sits out new entries and keeps its rules.' : ' trades with ' + g.name + ' from the next entry.')); }
        else if (Date.now() - p.at > 8000) { P.pending.delete(c); say('ChartBridge did not answer for ' + p.chip + ': look again.', true); }
      } else if (Date.now() - p.at > 1500) { P.pending.delete(c); if (p.done) say(p.done); }
    }
  }

  function chipHtml(c, g) {
    const pend = [...P.pending.values()].some(p => p.chip === c.name);
    const why = P.chipWhy.get(c.name) || '';
    const locked = !c.member || !!c.busy || (c.notype && c.benched) || pend;   // a benched chip with no type cannot go in; one trading may still go out
    const tags = [];
    if (c.notype) tags.push('set its type on The Desk first');
    if (!c.member) tags.push('not in the group: join it on the Accounts tab');
    if (c.busy) tags.push('in a trade: ' + c.busy);
    if (pend) tags.push('moving...');
    if (why && !pend) tags.push(why);
    const aria = c.name + (c.member ? (c.benched ? ', on the bench' : ', trades with the group') : ', not in the group') + (c.busy ? ', in a trade' : '');
    return `<button type="button" class="ma-chip${locked ? ' locked' : ''}${c.member && !c.benched ? ' in' : ''}" data-chip="${esc(c.name)}" draggable="${!locked}" aria-label="${esc(aria)}">` +
      `<span class="ma-cname"><span class="ma-dot" aria-hidden="true"></span>${esc(c.name)}<span class="ma-mark ${c.sim ? 'sim' : 'live'}">${c.sim ? 'SIM' : 'LIVE'}</span></span>` +
      `<span class="ma-ctype">${esc(c.label)}</span>` +
      `<span class="ma-crow"><span>Room <b>${c.room === null ? 'not known' : esc(MC.usd(c.room))}</b></span><span>Risk <b>${c.risk === null ? 'none' : esc(MC.usd(c.risk))}</b></span></span>` +
      tags.map(t => `<span class="ma-ctag">${esc(t)}</span>`).join('') + '</button>';
  }

  function render() {
    settle();
    if (P.tab === 'copier') { if (cop) cop.render(); return; }
    const list = groups();
    if (!P.gid || !list.some(g => g.id === P.gid)) { const first = list[0]; if (first && P.gid !== first.id && !P.creating) { P.gid = first.id; } }
    const g = group(), orders = typeof host.working === 'function' ? host.working() : [];
    const bench = benchNow(g), version = S.version || 'an older one';
    let html;
    if (!S.v3 || !S.got) html = `<p class="ac-empty">${esc(S.reason || 'Waiting for ChartBridge\'s accounts.')}</p>`;
    else if (!S.groups) html = '<p class="ac-empty">ChartBridge sends no groups: the Multi-Account panel needs ChartBridge 0.5.8 or newer (0.6.7 for the bench).</p>';
    else {
      const L = g ? MC.lanes(g, S, orders) : null;
      /* a reason about a trade or working orders goes once that account is flat with nothing working */
      if (L) for (const c of L.active.concat(L.bench)) { const w = P.chipWhy.get(c.name); if (w && !c.busy && /in a trade|working order/.test(w)) P.chipWhy.delete(c.name); }
      const opts = list.map(x => `<option value="${esc(x.id)}"${x.id === P.gid ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
      const flat = L ? L.flat : true;
      const bar = `<div class="ma-bar">` +
        (list.length ? `<label class="ma-lbl" for="ma-grp-${esc(host.panelId)}">Group</label><select class="ws-sel ma-sel" id="ma-grp-${esc(host.panelId)}" data-ma="group">${opts}</select>` : '<span class="ma-rules">No groups yet.</span>') +
        (g ? `<span class="ma-risk"><label class="ma-lbl" for="ma-risk-${esc(host.panelId)}">Risk</label><input class="ws-num ma-rin" id="ma-risk-${esc(host.panelId)}" data-ma="risk" inputmode="decimal" autocomplete="off" value="${isFinite(g.riskPct) && g.riskPct > 0 ? g.riskPct : ''}"${flat && can() ? '' : ' disabled'} title="${esc(flat ? 'Of each account\'s own max loss (its drawdown on its type); changed only while the group is flat' : 'The group is not flat: the risk changes once it is')}" aria-label="Risk percent"><span class="ma-rules">% of each account's max loss</span></span>` : '') +
        (g ? '<span class="ma-rules">One direction, always (no hedging inside a group)</span>' : '') +
        '<span class="ma-fill"></span>' +
        (g ? `<button type="button" class="ws-btn" data-ma="settings" aria-expanded="${P.settings}">Group settings</button>` : '') +
        `<button type="button" class="ws-btn primary" data-ma="new" aria-expanded="${P.creating}">New group</button></div>`;
      const settings = g && P.settings ? `<div class="ma-set" role="group" aria-label="Group settings"><div class="ma-srow">` +
        `<div class="ma-field"><label for="ma-name-${esc(host.panelId)}">Group name</label><input class="ws-in ma-in" id="ma-name-${esc(host.panelId)}" data-ma="name" maxlength="30" autocomplete="off" spellcheck="false" value="${esc(g.name)}"></div>` +
        `<div class="ma-field"><label for="ma-type-${esc(host.panelId)}">Type</label><select class="ws-sel ma-in" id="ma-type-${esc(host.panelId)}" data-ma="type"><option value="eval"${g.accountType === 'eval' ? ' selected' : ''}>Evals</option><option value="funded"${g.accountType === 'funded' ? ' selected' : ''}>Funded</option>${g.accountType ? '' : '<option value="" selected>Not set</option>'}</select></div>` +
        `<button type="button" class="ws-btn primary" data-ma="save">Save</button><span class="ma-fill"></span>` +
        `<button type="button" class="ws-btn ma-danger" data-ma="delete">${P.delAsk ? 'Delete ' + esc(g.name) + '? Click again' : 'Delete group'}</button></div>` +
        `<p class="ma-fixed">Each account keeps its own rules from its type on The Desk (size, drawdown, daily limit, floor). An account with no type set on The Desk cannot trade with a group until it has one. Risk changes and moves only while the group is flat.</p></div>` : '';
      const creating = P.creating ? `<div class="ma-set" role="group" aria-label="New group"><div class="ma-srow">` +
        `<div class="ma-field"><label for="ma-nname-${esc(host.panelId)}">Group name</label><input class="ws-in ma-in" id="ma-nname-${esc(host.panelId)}" data-ma="nname" maxlength="30" autocomplete="off" spellcheck="false" placeholder="the firm's name"></div>` +
        `<div class="ma-field"><label for="ma-ntype-${esc(host.panelId)}">Type</label><select class="ws-sel ma-in" id="ma-ntype-${esc(host.panelId)}" data-ma="ntype"><option value="eval">Evals</option><option value="funded">Funded</option></select></div>` +
        `<div class="ma-field"><label for="ma-nrisk-${esc(host.panelId)}">Risk %</label><input class="ws-num ma-in ma-rin" id="ma-nrisk-${esc(host.panelId)}" data-ma="nrisk" inputmode="decimal" autocomplete="off" value="5"></div>` +
        `<button type="button" class="ws-btn primary" data-ma="create">Create</button><button type="button" class="ws-btn" data-ma="create-no">Cancel</button></div>` +
        `<p class="ma-fixed">Name it for the firm; then put that firm's accounts in it on the Accounts tab (Group). Each joins with its rules from its type on The Desk.</p></div>` : '';
      const lane = (kind, chips, head) => `<div class="ma-lane ${kind}" data-lane="${kind}"><div class="ma-lhead">${head}</div><div class="ma-chips">` +
        (chips.length ? chips.map(c => chipHtml(c, g)).join('') : `<div class="ma-empty">${kind === 'in' ? 'No account trades with this group now. Drag one here.' : 'Nothing on the bench.'}</div>`) + '</div></div>';
      const lanes = !g ? '' : `<div class="ma-lanes">` +
        lane('in', L.active, `<span class="ma-lname">Trades with the group</span><span class="ma-lsum">${esc(MC.sumText(L))}</span>`) +
        lane('bench', L.bench, `<span class="ma-lname">Bench</span><span class="ma-lsub">sits out new entries, keeps its rules</span><span class="ma-lsum">${esc(MC.benchText(L))}</span>`) + '</div>';
      const old = g && !bench ? `<p class="ma-toast warn" role="status">ChartBridge ${esc(version)} keeps no bench: moving a chip needs ChartBridge ${MC.BENCH_VERSION}.</p>` : '';
      const err = S.groupsError ? `<p class="ma-toast warn" role="alert">${esc(S.groupsError)}</p>` : '';
      html = bar + settings + creating + err + lanes + old + `<p class="ma-toast${P.toast.warn ? ' warn' : ''}" role="status">${esc(P.toast.text)}</p>`;
    }
    if (html !== P.key) {
      /* a box being typed in keeps its text, its focus and its caret when the figures around it change */
      const had = document.activeElement, keep = had && body.contains(had) && had.dataset ? had.dataset.ma : '', val = keep && 'value' in had ? had.value : null;
      let sel = null; try { sel = keep && typeof had.selectionStart === 'number' ? [had.selectionStart, had.selectionEnd] : null; } catch (e) { sel = null; }
      const typed = {}; for (const k of ['name', 'type', 'nname', 'ntype', 'nrisk']) { const e = body.querySelector(`[data-ma="${k}"]`); if (e) typed[k] = e.value; }
      P.key = html; body.innerHTML = html;
      for (const k of Object.keys(typed)) { const e = body.querySelector(`[data-ma="${k}"]`); if (e) e.value = typed[k]; }
      if (keep) {
        const e = body.querySelector(`[data-ma="${keep}"]`);
        if (e && !e.disabled) { if (val !== null && keep === 'risk') e.value = val; e.focus(); if (sel) try { e.setSelectionRange(sel[0], sel[1]); } catch (x) { /* a select */ } }
      }
    }
  }

  function move(name, toActive) {
    const g = group(); if (!g) return;
    const L = MC.lanes(g, S, typeof host.working === 'function' ? host.working() : []), c = L.active.concat(L.bench).find(x => x.name === name);
    if (!c) return;
    if (c.member && c.benched === !toActive) return;   // already there
    if (!benchNow(g)) { say('Moving a chip needs ChartBridge ' + MC.BENCH_VERSION + ' (this PC has ' + (S.version || 'an older one') + ').', true); render(); return; }
    const why = MC.moveWhy(c, toActive, g.name);
    if (why) { P.chipWhy.set(name, why); say(why, true); render(); return; }
    const m = MC.benchMessage(name, !toActive, cid());
    if (post(m, { chip: name, gid: g.id, benched: !toActive, what: name + ' did not move' })) { P.chipWhy.delete(name); say('Sent to ChartBridge: ' + name + (toActive ? ' back to trade with ' + g.name : ' to the bench') + '.'); }
    render();
  }

  el.addEventListener('click', e => {
    const tab = e.target.closest('.ma-tabs [data-tab]');
    if (tab) {
      P.tab = tab.dataset.tab;
      for (const t of el.querySelectorAll('.ma-tabs [data-tab]')) t.setAttribute('aria-selected', String(t === tab));
      body.hidden = P.tab !== 'groups'; copEl.hidden = P.tab !== 'copier';
      if (P.tab === 'copier' && !cop) cop = host.copier(copEl);
      render(); return;
    }
    const chip = e.target.closest('[data-chip]');
    if (chip && body.contains(chip)) { const g = group(), name = chip.dataset.chip, L = g ? MC.lanes(g, S, host.working ? host.working() : []) : null, c = L ? L.active.concat(L.bench).find(x => x.name === name) : null; if (c) move(name, !(c.member && !c.benched)); return; }
    const b = e.target.closest('button[data-ma]'); if (!b || !body.contains(b)) return;
    const g = group(), act = b.dataset.ma;
    if (act === 'settings') { P.settings = !P.settings; P.creating = false; P.delAsk = false; }
    else if (act === 'new') { P.creating = !P.creating; P.settings = false; P.delAsk = false; if (P.creating && !benchNow(g) && !MC.verAtLeast(S.version, MC.BENCH_VERSION)) say('New group needs ChartBridge ' + MC.BENCH_VERSION + ' (a group keeps no rules of its own from then; this PC has ' + (S.version || 'an older one') + ').', true); }
    else if (act === 'create-no') P.creating = false;
    else if (act === 'create') {
      const name = (body.querySelector('[data-ma="nname"]') || {}).value, type = (body.querySelector('[data-ma="ntype"]') || {}).value, rt = (body.querySelector('[data-ma="nrisk"]') || {}).value;
      const rk = MC.parseRisk(rt);
      if (rk.error) { say(rk.error, true); render(); return; }
      const r = MC.saveMessage(null, { name, accountType: type, riskPct: rk.value }, groups(), cid(), MC.verAtLeast(S.version, MC.BENCH_VERSION));
      if (r.error) { say(r.error, true); render(); return; }
      if (post(r.msg, { what: 'New group ' + r.msg.name + ' not made', done: 'New group ' + r.msg.name + ': made by ChartBridge. Put that firm\'s accounts in it on the Accounts tab.' })) {
        P.creating = false; P.wantName = r.msg.name.toLowerCase(); say('New group ' + r.msg.name + ': sent to ChartBridge.');
      }
    }
    else if (act === 'save' && g) {
      const name = (body.querySelector('[data-ma="name"]') || {}).value, type = (body.querySelector('[data-ma="type"]') || {}).value;
      const r = MC.saveMessage(g, Object.assign({ name }, type ? { accountType: type } : {}), groups(), cid(), benchNow(g));
      if (r.error) { say(r.error, true); render(); return; }
      if (post(r.msg, { what: 'Group settings not saved', done: 'Group settings of ' + r.msg.name + ': saved by ChartBridge.' })) say('Group settings of ' + r.msg.name + ': sent to ChartBridge.');
    }
    else if (act === 'delete' && g) {
      const L = MC.lanes(g, S, host.working ? host.working() : []);
      if (!L.flat) { say('Delete only while every account in ' + g.name + ' is flat with no working orders.', true); P.delAsk = false; }
      else if (!P.delAsk) P.delAsk = true;
      else { P.delAsk = false; P.settings = false; if (post({ type: 'groupDelete', cid: cid(), group: g.id }, { what: 'Delete ' + g.name + ' refused', done: g.name + ' deleted: its accounts are in no group now.' })) say('Delete ' + g.name + ': sent to ChartBridge.'); }
    }
    render();
  });
  el.addEventListener('change', e => {
    const t = e.target, act = t.dataset && t.dataset.ma;
    if (act === 'group') { P.gid = t.value; savePick(P.gid); P.settings = false; P.delAsk = false; P.chipWhy.clear(); say(DEFAULT_TOAST); render(); }
    else if (act === 'risk') {
      const g = group(); if (!g) return;
      const rk = MC.parseRisk(t.value);
      if (rk.error) { say(rk.error, true); t.value = g.riskPct || ''; render(); return; }
      if (rk.value === g.riskPct) return;
      const L = MC.lanes(g, S, host.working ? host.working() : []);
      if (!L.flat) { say('The risk changes only while ' + g.name + ' is flat.', true); t.value = g.riskPct || ''; render(); return; }
      const r = MC.saveMessage(g, { riskPct: rk.value }, groups(), cid(), benchNow(g));
      if (r.error) { say(r.error, true); render(); return; }
      if (post(r.msg, { what: 'Risk not changed', done: 'Risk ' + rk.value + '% of each account\'s max loss in ' + g.name + ' from the next entry.' })) say('Risk ' + rk.value + '% for ' + g.name + ': sent to ChartBridge.');
      render();
    }
  });
  el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset && e.target.dataset.ma === 'risk') { e.preventDefault(); e.target.blur(); } });
  /* drag a chip to the other lane (the same move as a click) */
  el.addEventListener('dragstart', e => { const c = e.target.closest && e.target.closest('[data-chip]'); if (!c) return; P.drag = c.dataset.chip; c.classList.add('dragging'); try { e.dataTransfer.setData('text/plain', P.drag); e.dataTransfer.effectAllowed = 'move'; } catch (x) { /* fine */ } });
  el.addEventListener('dragend', e => { const c = e.target.closest && e.target.closest('[data-chip]'); if (c) c.classList.remove('dragging'); P.drag = ''; for (const l of el.querySelectorAll('.ma-lane.over')) l.classList.remove('over'); });
  el.addEventListener('dragover', e => { const l = e.target.closest && e.target.closest('.ma-lane'); if (!l || !P.drag) return; e.preventDefault(); for (const x of el.querySelectorAll('.ma-lane.over')) if (x !== l) x.classList.remove('over'); l.classList.add('over'); });
  el.addEventListener('dragleave', e => { const l = e.target.closest && e.target.closest('.ma-lane'); if (l && !l.contains(e.relatedTarget)) l.classList.remove('over'); });
  el.addEventListener('drop', e => {
    const l = e.target.closest && e.target.closest('.ma-lane'); if (!l) return;
    e.preventDefault(); l.classList.remove('over');
    let name = P.drag; try { name = e.dataTransfer.getData('text/plain') || name; } catch (x) { /* fine */ }
    P.drag = '';
    if (name) move(name, l.dataset.lane === 'in');
  });
  /* a new group made here is chosen once ChartBridge sends it */
  const pickNew = () => { if (!P.wantName) return; const g = groups().find(x => x.name.toLowerCase() === P.wantName); if (g) { P.gid = g.id; savePick(g.id); P.wantName = ''; } };
  const renderAll = () => { pickNew(); render(); };
  renderAll();
  return { render: renderAll, destroy: () => { if (cop) cop.destroy(); }, state: P };
}

return { mount, PICK_KEY, DEFAULT_TOAST };
})();
