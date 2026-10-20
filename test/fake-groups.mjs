// Reference behaviour for ChartBridge 0.5.8's prop groups (nt8/PROTOCOL.md "Prop groups and account state (0.5.8)") in the
// fake bridge (test/fake-v3.mjs): groupSave, groupDelete, accountGroup (highClose), accountLimits, the groups message, the
// accounts message's new fields and the one-direction check on the page's entries. 0.6.5 (Anthony 2026-10-19): each member's own
// rules (accountGroup with the rule keys, memberRules), the groups message's riskPct and ownRules, the accounts entry's rules. Everything simulated: made-up groups
// (Lucid, Apex), made-up accounts and money; nothing reaches a broker. ChartBridgeGroups.cs is the real thing (its Mono
// harness, nt8/check/GroupsHarness.cs); this keeps the page's smokes honest about the messages and the words.
import { checkStrategy } from './fake-v3.mjs';   // 0.6.5: a group entry's strategy is checked as an order's (a cycle: called only at run time)
const isNum = v => typeof v === 'number' && isFinite(v);
const MONEY = /^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?$/;
const usd = v => '$' + (+v).toLocaleString('en-US', { maximumFractionDigits: 2 });

export const GROUP_KEYS = {
  groupSave: ['type', 'cid', 'group', 'name', 'noHedge', 'dailyLoss', 'drawdown', 'drawdownType', 'target', 'size', 'lockAt', 'consistency', 'accountType', 'hero', 'riskPct'],
  groupDelete: ['type', 'cid', 'group'],
  accountGroup: ['type', 'cid', 'account', 'group', 'highClose', 'size', 'dailyLoss', 'drawdown', 'drawdownType', 'lockAt', 'target', 'consistency', 'maxMinis', 'maxMicros', 'typeId'],   // 0.6.5: the member's own rules
  memberRules: ['type', 'cid', 'account', 'size', 'dailyLoss', 'drawdown', 'drawdownType', 'lockAt', 'target', 'consistency', 'maxMinis', 'maxMicros', 'typeId'],   // 0.6.5
  firmMinimum: ['type', 'cid', 'account', 'minBalance'],   // 0.6.6: the firm dashboard's minimum balance seeds the floor
  /* 0.6.5 (Anthony 2026-10-19): trade the group from the ticket (ChartBridgeGroups.cs GroupEntry, on the order connection) */
  groupPreview: ['type', 'cid', 'group', 'root', 'side', 'kind', 'price', 'limitOffset', 'bracket'],
  groupOrder: ['type', 'cid', 'group', 'root', 'side', 'kind', 'price', 'limitOffset', 'bracket', 'sizes'],
  accountLimits: ['type', 'cid', 'account', 'floor', 'dailyLoss'],
};
export const GROUP_TYPES = Object.keys(GROUP_KEYS);
/* 0.6.5: the rule keys a join or memberRules may carry (all of them, or none: the group's apply) */
const RULE_KEYS = ['size', 'dailyLoss', 'drawdown', 'drawdownType', 'lockAt', 'target', 'consistency', 'maxMinis', 'maxMicros', 'typeId'];
const TYPE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
 const MICRO_ROOTS = ['MNQ', 'MES', 'M2K', 'MYM', 'MGC', 'MCL', 'SIL', 'MBT', 'MET', 'M6E'];
const usd2 = v => '$' + (+v).toLocaleString('en-US', { maximumFractionDigits: 2 });
export const miniEquivalent = root => (MICRO_ROOTS.includes(root) ? 0.1 : 1);
/* ChartBridge 0.6.6 (FirmMaxFor): the root's contracts the firm's max still allows (-1: no max). Micros against maxMicros where the
   firm gives one, minis against maxMinis; with only one set, 10 micros to a mini. usedMini: held and working, every instrument. */
export const firmMaxLeft = (minis, micros, root, usedMini) => {
  if (!(minis > 0) && !(micros > 0)) return -1;
  const inMicros = MICRO_ROOTS.includes(root) ? micros > 0 : !(minis > 0), k = inMicros ? 10 : 1;
  const cap = inMicros ? micros : minis, used = Math.round(Math.max(0, usedMini) * k * 1e6) / 1e6, per = miniEquivalent(root) * k;
  return Math.max(0, Math.floor((cap - used) / per + 1e-6));
};
/** 0.6.5: one member's contracts, exactly ChartBridgeOrders.GroupSize (its guards in its order, its words) */
export function groupSize(o) {
  const budget = Math.round(o.riskPct * o.drawdown) / 100, per = o.stopTicks * o.tickValue;
  const out = (why) => ({ size: 0, budget, why });
  if (!isNum(o.roomFloor)) return out('its room to the floor is not known (' + (o.floorWhy || 'not known') + ')');
  if (o.hasDaily && !isNum(o.roomDaily)) return out('its daily room is not known (' + (o.dailyWhy || 'not known') + ')');
  if (!isNum(o.openRisk)) return out('its open stop risk is not known (' + (o.openWhy || 'not known') + ')');   // answer 4
  const open = Math.round(o.openRisk * 100) / 100, less = open > 0 ? ' less its open stop risk ' + usd2(open) : '';
  let n = Math.floor(budget / per + 1e-9);
  if (n < 1) return out('its risk ' + usd2(budget) + ' (' + +o.riskPct.toFixed(2) + '% of its max loss ' + usd2(o.drawdown) + ') is less than one contract\'s stop (' + usd2(per) + ' at ' + o.stopTicks + ' ticks)');
  const held = Math.max(0, o.held);
  if (o.maxLeft >= 0 && o.maxLeft < n) { n = o.maxLeft; if (n < 1) return out('it is at its max size (' + o.maxWords + ')'); }   // review 3: every instrument, in mini equivalents
  if (o.cap - held < n) { n = o.cap - held; if (n < 1) return out('it is at the cap of ' + o.cap + ' (' + o.capWords + '; it holds or has working ' + held + ')'); }
  const byFloor = Math.floor((o.roomFloor - open) / per + 1e-9);
  if (byFloor < n) { n = byFloor; if (n < 1) return out('its room to the floor ' + usd2(o.roomFloor) + less + ' is less than one contract\'s stop (' + usd2(per) + ')'); }
  if (o.hasDaily) { const byDay = Math.floor((o.roomDaily - open) / per + 1e-9); if (byDay < n) { n = byDay; if (n < 1) return out('its daily room ' + usd2(o.roomDaily) + less + ' is less than one contract\'s stop (' + usd2(per) + ')'); } }
  return { size: n, budget, why: null };
}
const PCT = /^(?:0|[1-9][0-9]?|100)(?:\.[0-9]{1,2})?$/;

/** Adds the groups to OrderDeskV3's prototype. o.groups: false is a ChartBridge before 0.5.8 (no groups message, every group
 *  message unknown); o.groupsSeed: [{ name, size, drawdown, drawdownType, dailyLoss, target, lockAt, noHedge, members }]. */
export function installGroups(Desk) {
  Object.assign(Desk.prototype, {
    groupsInit(o) {
      this.gr = { on: o.groups !== false, perMember: o.groupRules !== false, firm: o.firmFloor === true, list: new Map(), members: new Map(), personal: new Map(), peaks: new Map(), own: new Map(), ntRoom: new Map(), next: 1 };   // firm: ChartBridge 0.6.6   // groupRules false: a ChartBridge 0.5.8 to 0.6.4 (one rule set per group)
      for (const s of o.groupsSeed || []) {
        const id = 'g' + this.gr.next++;
        this.gr.list.set(id, { id, name: s.name, noHedge: s.noHedge !== false, dailyLoss: s.dailyLoss || 0, drawdown: s.drawdown, drawdownType: s.drawdownType || 'eod', target: s.target || 0, size: s.size, lockAt: s.lockAt || 0, accountType: s.accountType || null, hero: s.hero || null, riskPct: s.riskPct || 0 });
        for (const a of s.members || []) {
          this.gr.members.set(a, id);
          const r = s.rules && s.rules[a];   // 0.6.5: a seeded member's own rules
          if (r && this.gr.perMember) this.gr.own.set(a, Object.assign({ dailyLoss: 0, lockAt: 0, target: 0, consistency: 0, maxMinis: 0, maxMicros: 0, typeId: null }, r));
          this.gr.peaks.set(a, Math.max(r ? r.size : s.size, s.highClose || 0));
        }
      }
    },
    groupsMsg() {
      const list = [...this.gr.list.values()].map(g => {
        const members = [...this.gr.members].filter(([, id]) => id === g.id).map(([a]) => a).sort();
        const holders = members.flatMap(a => this.groupHoldings(a));
        const longs = holders.some(h => h.side === 'long'), shorts = holders.some(h => h.side === 'short');
        return Object.assign({ id: g.id, name: g.name, noHedge: g.noHedge, dailyLoss: g.dailyLoss || null, drawdown: g.drawdown, drawdownType: g.drawdownType, target: g.target || null,
          size: g.size, lockAt: g.lockAt || null, consistency: g.consistency || null, accountType: g.accountType || null, hero: g.hero || null, members, side: longs && shorts ? 'mixed' : longs ? 'long' : shorts ? 'short' : null, holders },
          this.gr.perMember ? { riskPct: g.riskPct || null, ownRules: members.filter(a => this.gr.own.has(a)), tradeOut: members.map(a => ({ account: a, why: this.groupTakenWhy(a) })).filter(x => x.why) } : {});   // review 4: tradeOut   // 0.6.5, after holders as ChartBridge writes them
      });
      return { type: 'groups', list, error: null };
    },
    sendGroups() { if (!this.gr || !this.gr.on) return; const m = this.groupsMsg(); for (const c of this.conns()) if (c.v3 && c.origin === this.origin()) this.send(c, m); },
    groupHoldings(account) {
      const out = [];
      for (const [k, p] of this.positions) { const [acc, root] = k.split('|'); if (acc === account && p.qty) out.push({ account, root, side: p.qty > 0 ? 'long' : 'short', what: 'position', qty: Math.abs(p.qty) }); }
      for (const o of this.orders.values()) {
        if (o.account !== account || !(o.state === 'working' || o.state === 'partFilled') || (o.role && o.role !== 'entry')) continue;
        const left = o.qty - (o.filled || 0), pos = (this.positions.get(account + '|' + o.root) || {}).qty || 0;
        if (pos && (o.side === 'buy' ? pos < 0 : pos > 0) && left <= Math.abs(pos)) continue;
        out.push({ account, root: o.root, side: o.side === 'buy' ? 'long' : 'short', what: 'entry', qty: left });
      }
      return out;
    },
    /** the one-direction check (G3 a), with ChartBridge's words; exits of the account's own position pass */
    groupEntryCheck(m) {
      if (!this.gr || !this.gr.on) return null;
      const id = this.gr.members.get(m.account), g = id && this.gr.list.get(id);
      if (!g || !g.noHedge) return null;
      const pos = (this.positions.get(m.account + '|' + m.root) || {}).qty || 0, legs = m.strategy || (m.bracket && (m.bracket.stop > 0 || m.bracket.target > 0));
      if (!legs && pos && (m.side === 'buy' ? pos < 0 : pos > 0) && m.qty <= Math.abs(pos)) return null;
      const held = [...this.gr.members].filter(([, gid]) => gid === id).map(([a]) => a).sort().flatMap(a => this.groupHoldings(a));
      const words = held.map(h => h.what === 'position' ? h.account + ' ' + (h.side === 'long' ? '+' : '-') + h.qty + ' ' + h.root : h.account + ' ' + (h.side === 'long' ? 'buy' : 'sell') + ' ' + h.qty + ' ' + h.root + ' working').join('; ');
      const longs = held.some(h => h.side === 'long'), shorts = held.some(h => h.side === 'short'), tail = '; prop firms ban hedged accounts. Exits and flattens still work.';
      if (longs && shorts) return 'Group ' + g.name + ' is long and short (' + words + '): no new entry on either side until it is one direction' + tail;
      if (m.side === 'buy' && shorts) return 'Group ' + g.name + ' is short (' + words + '): a buy on ' + m.account + ' would hedge the group' + tail;
      if (m.side === 'sell' && longs) return 'Group ' + g.name + ' is long (' + words + '): a sell on ' + m.account + ' would hedge the group' + tail;
      return null;
    },
    /** the accounts message's new fields (PROTOCOL.md): group, myFloor, myDailyLoss, floor, roomFloor, roomDaily, targetLeft, src, why */
    groupFields(a, msg) {
      if (!this.gr || !this.gr.on) return msg;
      const id = this.gr.members.get(a.name), g = id ? this.gr.list.get(id) : null, mine = this.gr.personal.get(a.name) || { floor: 0, daily: 0 };
      const up = a.connection === 'connected', eq = msg.balance + msg.unrealized, src = {}, why = {};
      let floor = null, roomFloor = null, roomDaily = null, targetLeft = null;
      /* 0.6.5: the member's own rules, else its group's; 0.6.6: an account in no group with its own (the firm's) rules too */
      const r = g ? this.groupRulesOf(a.name, g) : this.gr.firm && this.gr.own.has(a.name) ? Object.assign({ own: true }, this.gr.own.get(a.name)) : null;
      if (r) {
        const whose = !g ? a.name + '\'s rules have' : r.own ? a.name + '\'s rules in ' + g.name + ' have' : 'group ' + g.name + ' has';
        const pk = this.gr.peaks.get(a.name);
        if (!g && r.drawdownType !== 'static' && !pk) why.floor = 'no end-of-day high is known for this account: give the minimum balance from the firm\'s dashboard (the account\'s settings)';
        else { const peak = Math.max(pk || r.size, r.size); floor = r.drawdownType === 'static' ? r.size - r.drawdown : Math.min(peak - r.drawdown, r.lockAt > 0 ? r.lockAt : Infinity); }
        roomDaily = r.dailyLoss > 0 ? r.dailyLoss + msg.pnlToday : null; targetLeft = r.target > 0 ? r.size + r.target - msg.balance : null;
        if (roomDaily === null) why.roomDaily = whose + ' no daily loss limit';
        if (targetLeft === null) why.targetLeft = whose + ' no profit target';
      } else {
        floor = mine.floor > 0 ? mine.floor : null; roomDaily = mine.daily > 0 ? mine.daily + msg.pnlToday : null;
        if (floor === null) why.floor = 'no group and no floor of its own (the Accounts tab)';
        if (roomDaily === null) why.roomDaily = 'no group and no daily limit of its own (the Accounts tab)';
        why.targetLeft = 'a personal account has no profit target';
      }
      if (floor !== null) roomFloor = +(eq - floor).toFixed(2); else why.roomFloor = why.floor;
      const nt = this.gr.ntRoom.has(a.name) ? this.gr.ntRoom.get(a.name) : null;   // 0.6.6: NinjaTrader's own figure, beside the room (made up)
      if (nt !== null && roomFloor === null && up) { roomFloor = nt; src.roomFloor = 'ninjatrader'; delete why.roomFloor; }
      if (!up) { for (const k of ['roomFloor', 'roomDaily', 'targetLeft']) if (k !== 'targetLeft' || g) why[k] = 'the account is not connected'; roomFloor = roomDaily = null; if (g) targetLeft = null; }
      for (const [k, v] of [['floor', floor], ['roomFloor', roomFloor], ['roomDaily', roomDaily], ['targetLeft', targetLeft]]) if (v !== null) { src[k] = src[k] || (k === 'floor' && !g && !r ? 'settings' : 'computed'); delete why[k]; }
      const r2 = v => (v === null ? null : +(+v).toFixed(2)), nz = v => (v > 0 ? v : null);
      return Object.assign(msg, { group: id || null, myFloor: mine.floor || null, myDailyLoss: mine.daily || null, myLimitsSet: this.gr.personal.has(a.name), floor: r2(floor), roomFloor: r2(roomFloor), roomDaily: r2(roomDaily), targetLeft: r2(targetLeft) },
        this.gr.firm ? { roomFloorNt: r2(nt) } : {}, { src, why },
        this.gr.perMember ? { rules: r ? { size: r.size, dailyLoss: nz(r.dailyLoss), drawdown: r.drawdown, drawdownType: r.drawdownType, lockAt: nz(r.lockAt), target: nz(r.target), consistency: nz(r.consistency), maxMinis: nz(r.maxMinis), maxMicros: nz(r.maxMicros), typeId: r.typeId || null, own: !!r.own } : null } : {});   // 0.6.5
    },
    /** 0.6.5: a member's rules: its own, else its group's (own false) */
    groupRulesOf(account, g) {
      const o = this.gr.own.get(account);
      if (o) return Object.assign({ own: true }, o);
      return { own: false, size: g.size, dailyLoss: g.dailyLoss || 0, drawdown: g.drawdown, drawdownType: g.drawdownType, lockAt: g.lockAt || 0, target: g.target || 0, consistency: g.consistency || 0, maxMinis: 0, maxMicros: 0, typeId: null };
    },
    /** 0.6.5: the rule keys of a message (ChartBridge's RulesFrom, its words): { rules } or { error }; none and not needed: {} */
    groupRulesFrom(m, needed) {
      if (!RULE_KEYS.some(k => k in m)) return needed ? { error: 'size is needed' } : {};
      for (const [k, z] of [['size', false], ['dailyLoss', true], ['drawdown', false]]) { if (!(k in m)) return { error: k + ' is needed' }; const w = this.groupMoney(m, k, z); if (w) return { error: w }; }
      if (!('drawdownType' in m)) return { error: 'drawdownType is needed' };
      for (const k of ['lockAt', 'target']) { if (!(k in m)) return { error: k + ' is needed' }; const w = this.groupMoney(m, k, true); if (w) return { error: w }; }
      if ('consistency' in m && m.consistency !== 0 && !(isNum(m.consistency) && PCT.test(String(m.consistency)) && m.consistency > 0 && m.consistency <= 100)) return { error: 'consistency must be a percent from 0 (none) to 100, at most 2 decimals' };
      for (const k of ['maxMinis', 'maxMicros']) if (k in m && !(Number.isInteger(m[k]) && m[k] >= 0 && m[k] <= 1000)) return { error: k + ' must be a whole number of contracts from 0 (none) to 1000' };
      if ('typeId' in m && !(typeof m.typeId === 'string' && (m.typeId === '-' || TYPE_ID.test(m.typeId)))) return { error: 'typeId must be The Desk\'s account type id (1 to 120 letters, digits, dots, underscores or hyphens), or - (none)' };
      const t = m.drawdownType;
      if (!['eod', 'intraday', 'static'].includes(t)) return { error: 'drawdownType must be eod, intraday or static' };
      if (m.drawdown >= m.size) return { error: 'the drawdown must be less than the account size' };
      if (m.lockAt > 0 && t === 'static') return { error: 'floor stops at applies to a trailing drawdown only (end of day or intraday); 0 for none' };
      if (m.lockAt > 0 && m.lockAt <= m.size - m.drawdown) return { error: 'floor stops at must be above the starting floor (' + (m.size - m.drawdown) + ')' };
      return { rules: { size: m.size, dailyLoss: m.dailyLoss, drawdown: m.drawdown, drawdownType: t, lockAt: m.lockAt, target: m.target, consistency: m.consistency || 0, maxMinis: m.maxMinis || 0, maxMicros: m.maxMicros || 0, typeId: m.typeId && m.typeId !== '-' ? m.typeId : null } };
    },
    groupMoney(m, k, zeroOk) {
      const v = m[k];
      if (!isNum(v) || v < 0 || !MONEY.test(String(v))) return k + ' must be a plain number of dollars (at most 2 decimals)';
      if (!zeroOk && !(v > 0)) return k + ' must be more than 0';
      return null;
    },
    check_groupSave(m) {
      const name = m.name;
      if (typeof name !== 'string' || name.length < 1 || name.length > 30) return 'a group name is 1 to 30 characters';
      if (typeof m.noHedge !== 'boolean') return 'noHedge must be true or false';
      if (!['eod', 'intraday', 'static'].includes(m.drawdownType)) return 'drawdownType must be eod, intraday or static';
      for (const [k, z] of [['dailyLoss', true], ['drawdown', false], ['target', true], ['size', false], ['lockAt', true]]) { if (!(k in m)) return k + ' is needed'; const w = this.groupMoney(m, k, z); if (w) return w; }
      if (m.drawdown >= m.size) return 'the drawdown must be less than the account size';
      if (m.lockAt > 0 && m.drawdownType === 'static') return 'floor stops at applies to a trailing drawdown only (end of day or intraday); 0 for none';
      if (m.lockAt > 0 && m.lockAt <= m.size - m.drawdown) return 'floor stops at must be above the starting floor (' + (m.size - m.drawdown) + ')';
      if (m.accountType !== undefined && !['eval', 'funded', '-'].includes(m.accountType)) return 'accountType must be eval, funded or - (not set)';   // 0.6.1
      if (m.hero !== undefined && (typeof m.hero !== 'string' || !(m.hero === '-' || /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(m.hero)))) return 'hero must be a build name of 1 to 64 letters, digits, dots, underscores or hyphens, or - (none)';
      if (m.riskPct !== undefined && m.riskPct !== 0 && !(isNum(m.riskPct) && PCT.test(String(m.riskPct)) && m.riskPct > 0 && m.riskPct <= 100)) return 'riskPct must be a percent of each member\'s max loss from 0 (off) to 100, at most 2 decimals';   // 0.6.5
      if (m.group !== undefined && !this.gr.list.has(m.group)) return 'no group ' + m.group;
      if ([...this.gr.list.values()].some(g => g.id !== m.group && g.name.toLowerCase() === name.toLowerCase())) return 'a group named ' + name + ' is there already';
      return null;
    },
    do_groupSave(m) {
      const id = m.group || 'g' + this.gr.next++, was = this.gr.list.get(id) || {};
      const keep = (k, v) => (v === undefined ? was[k] || null : v === '-' ? null : v);   // 0.6.1: absent keeps, - clears
      this.gr.list.set(id, { riskPct: m.riskPct === undefined ? was.riskPct || 0 : m.riskPct, accountType: keep('accountType', m.accountType), hero: keep('hero', m.hero), id, name: m.name, noHedge: m.noHedge, dailyLoss: m.dailyLoss, drawdown: m.drawdown, drawdownType: m.drawdownType, target: m.target, size: m.size, lockAt: m.lockAt, consistency: m.consistency || 0 });
      this.groupsChanged();
    },
    check_groupDelete(m) { return this.gr.list.has(m.group) ? null : 'no group ' + m.group; },
    do_groupDelete(m) { this.gr.list.delete(m.group); for (const [a, id] of [...this.gr.members]) if (id === m.group) { this.gr.members.delete(a); this.gr.peaks.delete(a); this.gr.own.delete(a); } this.groupsChanged(); },
    check_accountGroup(m) {
      if (typeof m.account !== 'string' || !this.acct.has(m.account)) return 'no account ' + m.account;
      if (!('group' in m) || (m.group !== null && typeof m.group !== 'string')) return 'group must be a group id or null (None)';
      if (m.highClose !== undefined && m.group === null) return 'highClose goes with joining a group only';
      if (m.highClose !== undefined) { const w = this.groupMoney(m, 'highClose', false); if (w) return w; }
      if (m.group === null && RULE_KEYS.some(k => k in m)) return 'rules go with joining a group only';   // 0.6.5
      const rr = this.groupRulesFrom(m, false); if (rr.error) return rr.error;
      if (m.group === null) return null;
      const g = this.gr.list.get(m.group);
      if (!g) return 'no group ' + m.group;
      if (this.gr.members.get(m.account) === m.group) return m.account + ' is in ' + g.name + ' already';
      if (!g.noHedge) return null;
      const mine = this.groupHoldings(m.account), theirs = [...this.gr.members].filter(([a, id]) => id === m.group && a !== m.account).flatMap(([a]) => this.groupHoldings(a));
      const side = h => (h.some(x => x.side === 'long') && h.some(x => x.side === 'short') ? 'mixed' : h.some(x => x.side === 'long') ? 'long' : h.some(x => x.side === 'short') ? 'short' : null);
      const ms = side(mine), ts = side(theirs);
      if (ms === 'mixed') return m.account + ' holds both sides: it cannot join ' + g.name + ' (No hedging) until it is one direction';
      if (ms && ts && ms !== ts) return m.account + ' is ' + ms + ' and ' + g.name + ' is ' + ts + ': joining would hedge the group; prop firms ban hedged accounts';
      return null;
    },
    do_accountGroup(m) {
      if (m.group === null) { this.gr.members.delete(m.account); this.gr.peaks.delete(m.account); }
      else {
        const g = this.gr.list.get(m.group), a = this.acct.get(m.account), own = this.groupRulesFrom(m, false).rules;
        this.gr.members.set(m.account, m.group);
        if (own) this.gr.own.set(m.account, own); else this.gr.own.delete(m.account);   // 0.6.5: no rules sent: the group's apply
        this.gr.peaks.set(m.account, m.highClose || Math.max(own ? own.size : g.size, a.balance + this.pnl(a.name).realized));
      }
      if (m.group === null) this.gr.own.delete(m.account);
      this.groupsChanged();
    },
    /** a ChartBridge before 0.6.5 (o.groupRules false): memberRules and the new keys are unknown to it, in its words */
    groupOldKeys(m) {
      if (m.type === 'memberRules' || m.type === 'groupPreview' || m.type === 'groupOrder') return 'Unknown message type ' + m.type + '.';
      const extra = m.type === 'groupSave' ? ['riskPct'] : m.type === 'accountGroup' ? RULE_KEYS : [];
      const k = Object.keys(m).find(x => extra.includes(x));
      return k ? 'Unknown key "' + k + '" in ' + m.type + '.' : null;
    },
    /* 0.6.5: every member's size for one group entry, in seat order: { seats, name, riskPct } or { error } */
    groupPlan(m) {
      const g = this.gr.list.get(m.group);
      if (!g) return { error: 'no group ' + m.group };
      if (!(g.riskPct > 0)) return { error: 'group ' + g.name + ' has no risk percent: set Risk % of max loss in Settings, Account groups' };
      const stop = m.strategy && isNum(m.strategy.stop) ? m.strategy.stop + Math.max(0, isNum(m.strategy.stopLimit) ? m.strategy.stopLimit : 0) : m.bracket && isNum(m.bracket.stop) ? m.bracket.stop : 0;   // answer 2: a strategy's stop sizes too
      if (!(stop >= 1)) return { error: 'a group entry needs a stop: each member is sized from its stop loss (set the bracket\'s stop)' };
      const members = [...this.gr.members].filter(([, id]) => id === g.id).map(([a]) => a).sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1);
      if (!members.length) return { error: 'group ' + g.name + ' has no accounts' };
      const ins = this.instruments[m.root];
      if (!ins || ins.quoteOnly) return { error: 'instrument ' + m.root + ' is not served by ChartBridge' };
      const tickValue = ins.tick * ins.pointValue, micro = MICRO_ROOTS.includes(m.root), buy = m.side === 'buy';
      const seats = members.map(name => {
        const s = { account: name, size: 0, risk: 0, budget: 0, out: null }, a = this.acct.get(name);
        /* never an account another lane trades (ChartBridgeAgents.CopierUses, AccountTakenWhy, the bot's) */
        const taken = this.groupTakenWhy(name);
        if (taken) { s.out = taken; return s; }
        if (!a) { s.out = 'it is not in NinjaTrader now'; return s; }
        const f = this.groupFields(a, this.accountMsg058(a)), r = this.groupRulesOf(name, g);
        const pos = (this.positions.get(name + '|' + m.root) || {}).qty || 0;
        const pend = [...this.orders.values()].filter(o => o.account === name && o.root === m.root && (o.state === 'working' || o.state === 'partFilled') && o.side === m.side).reduce((t, o) => t + o.qty - (o.filled || 0), 0);
        const held = buy ? pos + pend : -pos + pend, risk = this.groupOpenRisk(name);
        const maxLeft = firmMaxLeft(r.maxMinis, r.maxMicros, m.root, risk.usedMini);   // ChartBridge 0.6.6
        const maxWords = maxLeft < 0 ? '' : (r.maxMinis > 0 && r.maxMicros > 0 ? r.maxMinis + ' minis / ' + r.maxMicros + ' micros' : r.maxMinis > 0 ? r.maxMinis + ' minis' : r.maxMicros + ' micros') + '; it holds or has working ' + +risk.usedMini.toFixed(1) + ' in mini equivalents, every instrument';
        const z = groupSize({ riskPct: g.riskPct, drawdown: r.drawdown, stopTicks: stop, tickValue, maxLeft, maxWords, cap: this.capFor(m.root), capWords: 'maxQty.' + m.root + ' in config.txt',
          held, roomFloor: f.roomFloor, floorWhy: f.why.roomFloor, hasDaily: r.dailyLoss > 0, roomDaily: f.roomDaily, dailyWhy: f.why.roomDaily, openRisk: risk.openRisk, openWhy: risk.openWhy });
        s.size = z.size; s.budget = z.budget; s.out = z.why; s.risk = Math.round(z.size * stop * tickValue * 100) / 100;
        return s;
      });
      return { seats, name: g.name, riskPct: g.riskPct, stop };
    },
    /* answer 4 (ChartBridgeOrders.OpenStopRisk): the loss if every position on that side is stopped at its working stops, from the last
       price; { openRisk } or { openRisk: null, openWhy } */
    groupOpenRisk(account) {
      /* ChartBridgeOrders.OpenStopRisk (answer 4, review 1 and 5): every position on both sides at its working stops from its own last
         price, every working entry at its own stop; usedMini every instrument in mini equivalents (review 3) */
      let total = 0, usedMini = 0, unknown = null;
      const roots = new Set();
      for (const [k] of this.positions) { const [acc, root] = k.split('|'); if (acc === account) roots.add(root); }
      for (const o of this.orders.values()) if (o.account === account && (o.state === 'working' || o.state === 'partFilled')) roots.add(o.root);
      for (const root of roots) {
        const pos = (this.positions.get(account + '|' + root) || {}).qty || 0, ins = this.instruments[root] || {}, pv = ins.pointValue, tick = ins.tick;
        const heldL = Math.max(pos, 0), heldS = Math.max(-pos, 0);
        usedMini += (heldL + heldS) * miniEquivalent(root);
        const on = [...this.orders.values()].filter(o => o.account === account && o.root === root && (o.state === 'working' || o.state === 'partFilled'));
        for (const dir of [1, -1]) {
          const held = dir > 0 ? heldL : heldS;
          if (!held) continue;
          const last = this.last[root];
          if (!(last > 0) || !pv) { unknown = unknown || 'no recent price for ' + ((ins.name) || root) + ' to measure its stops from'; continue; }
          const stops = on.filter(o => (o.side === 'buy') === (dir < 0) && (o.kind === 'stop' || o.kind === 'stopLimit')).map(o => [Math.max(0, (last - o.price) * dir), o.qty - (o.filled || 0)]).filter(x => x[1] > 0).sort((a, b) => b[0] - a[0]);
          let left = held;
          for (const [d, q] of stops) { if (left <= 0) break; const n = Math.min(left, q); total += n * d * pv; left -= n; }
          if (left > 0) unknown = unknown || 'it holds ' + held + ' ' + root + ' with no working stop for ' + left + ' of them';
        }
        let exitBuy = heldS, exitSell = heldL;
        const cand = on.filter(o => !(o.role && o.role !== 'entry') && o.qty - (o.filled || 0) > 0), rests = new Map(cand.map(o => [o, o.qty - (o.filled || 0)]));   // legs are never entries
        /* re-review 1: a closing side OCO set is one exit up to the position (at its largest); adding side OCO orders all count */
        const sets = new Map();
        for (const o of cand) if (o.oco && (o.side === 'buy' ? heldS : heldL) > 0) { const k = o.side + '|' + o.oco; if (!sets.has(k)) sets.set(k, []); sets.get(k).push(o); }
        for (const [k, set] of sets) { const sb = k.startsWith('buy'), big = Math.max(...set.map(o => rests.get(o))), x = Math.min(sb ? exitBuy : exitSell, big); if (sb) exitBuy -= x; else exitSell -= x; for (const o of set) rests.set(o, Math.max(0, rests.get(o) - x)); }
        for (const o of cand) {
          let rest = rests.get(o);
          if (!rest) continue;
          if (!o.oco) { if (o.side === 'buy') { const x = Math.min(exitBuy, rest); exitBuy -= x; rest -= x; } else { const x = Math.min(exitSell, rest); exitSell -= x; rest -= x; } }
          if (rest <= 0) continue;
          usedMini += rest * miniEquivalent(root);
          const t = o.strategy ? o.strategy.stop + Math.max(0, o.strategy.stopLimit || 0) : o.bracket && o.bracket.stop > 0 ? o.bracket.stop : o.planned && o.planned.stopTicks > 0 ? o.planned.stopTicks : 0;
          if (!(t >= 1) || !pv) { unknown = unknown || 'a working ' + o.side + ' ' + (o.kind === 'stopLimit' ? 'stop limit' : o.kind) + ' ' + rest + ' ' + root + ' has no stop ChartBridge knows'; continue; }
          total += rest * t * tick * pv;
        }
      }
      return unknown ? { openRisk: null, openWhy: unknown, usedMini } : { openRisk: total, openWhy: null, usedMini };
    },
    groupTakenWhy(name) {
      const cp = this.sw.copier && this.copier ? (this.copier.leader === name ? name + ' is the copier\'s leader' : this.copier.followers.has(name) ? name + ' is a copier follower' : null) : null;
      return cp || (this.botAccount && this.botAccount.toLowerCase() === name.toLowerCase() ? name + ' is the bot\'s account' : null);
    },
    groupEntryWhy(m) {
      if (typeof m.group !== 'string') return m.type + ' needs group (a group id)';
      if (m.side !== 'buy' && m.side !== 'sell') return 'side must be buy or sell';
      if (!['market', 'limit', 'stop'].includes(m.kind) && !(this.sw.orderTypes && (m.kind === 'stopLimit' || m.kind === 'mit'))) return 'kind must be market, limit or stop';
      if (m.strategy !== undefined && !this.sw.strategies) return 'message has an unexpected nested object or list';
      if (m.strategy !== undefined && m.bracket !== undefined) return 'bracket and strategy on one order are refused: send one of them';
      if (m.strategy !== undefined) { const w = m.strategy && typeof m.strategy === 'object' ? checkStrategy(m.strategy, this.config.maxBracketTicks) : 'A strategy must be one flat object.'; if (w) return w; return this.groupPlan(m).error || null; }
      if (!m.bracket) return 'a group entry needs a stop: each member is sized from its stop loss (set the bracket\'s stop)';
      if (!isNum(m.bracket.stop) || !isNum(m.bracket.target) || !Number.isInteger(m.bracket.stop) || !Number.isInteger(m.bracket.target) || m.bracket.stop < 0 || m.bracket.target < 0) return 'bracket needs both stop and target as whole numbers of ticks (0 for none)';
      if (this.config.maxBracketTicks > 0 && (m.bracket.stop > this.config.maxBracketTicks || m.bracket.target > this.config.maxBracketTicks)) return 'bracket ticks must be from 0 to ' + this.config.maxBracketTicks + ' (maxBracketTicks in config.txt)';   // review 7
      const p = this.groupPlan(m);
      return p.error || null;
    },
    groupHead(m, p) { return { cid: m.cid !== undefined ? m.cid : null, group: m.group, name: p.name, root: m.root, side: m.side, kind: m.kind, stopTicks: p.stop, riskPct: p.riskPct }; },
    check_groupPreview(m) { return this.gr.perMember ? this.groupEntryWhy(m) : 'Unknown message type groupPreview.'; },
    do_groupPreview(m, conn) { const p = this.groupPlan(m); this.send(conn, Object.assign({ type: 'groupPreview' }, this.groupHead(m, p), { members: p.seats })); },
    check_groupOrder(m) {
      if (!this.gr.perMember) return 'Unknown message type groupOrder.';
      const why = this.groupEntryWhy(m); if (why) return why;
      if (typeof m.sizes !== 'string' || !/^[^,:"]{1,200}:(?:0|[1-9][0-9]{0,3})(?:,[^,:"]{1,200}:(?:0|[1-9][0-9]{0,3})){0,99}$/.test(m.sizes)) return 'sizes must be the sizes confirmed with their accounts, in seat order ("SIM-A:4,SIM-B:0")';
      const p = this.groupPlan(m), want = m.sizes.split(',').map(x => x.split(':'));   // review 2: the names go with the sizes
      if (want.length !== p.seats.length || want.some((w, i) => w[0].toLowerCase() !== p.seats[i].account.toLowerCase())) return 'the group\'s accounts changed since the preview (' + p.seats.map(x => x.account).join(', ') + ' now, ' + want.map(w => w[0]).join(', ') + ' confirmed): nothing was sent; look again and send';
      const changed = p.seats.map((s, i) => (String(s.size) !== want[i][1] ? s.account + ' ' + want[i][1] + ' confirmed, ' + s.size + ' now' : null)).filter(Boolean);
      if (changed.length) return 'the sizes changed since the preview (' + changed.join('; ') + '): nothing was sent; look again and send';
      if (p.seats.every(s => s.size < 1)) return 'no account of group ' + p.name + ' can take this entry: ' + p.seats.map(s => s.account + ': ' + s.out).join('; ');
      return null;
    },
    do_groupOrder(m, conn) {
      const p = this.groupPlan(m);
      p.seats.forEach((s, i) => {
        if (s.size < 1) return;
        const om = Object.assign({ type: 'order', cid: m.cid !== undefined ? m.cid + ':' + (i + 1) : undefined, account: s.account, root: m.root, side: m.side, kind: m.kind, qty: s.size },
          m.strategy ? { strategy: Object.assign({}, m.strategy) } : { bracket: { stop: m.bracket.stop, target: m.bracket.target } },
          m.price !== undefined ? { price: m.price } : {}, m.limitOffset !== undefined ? { limitOffset: m.limitOffset } : {});
        if (om.cid === undefined) delete om.cid;
        const why = this.check_order(om);
        if (why) { s.out = 'refused: ' + why; s.size = 0; s.risk = 0; } else this.do_order(om);
      });
      (this.log || (this.log = [])).push({ file: 'Output', line: 'group entry on ' + p.name + ': ' + m.side + ' ' + m.root + ' ' + m.kind + (m.strategy ? ' with a strategy' : '') + ', stop ' + p.stop + ' ticks, risk ' + p.riskPct + '%: ' + p.seats.map(s => s.account + ' ' + (s.size > 0 ? s.size + ' (' + usd2(s.risk) + ')' : 'out: ' + s.out)).join('; ') });
      this.send(conn, Object.assign({ type: 'groupPlaced' }, this.groupHead(m, p), { placed: p.seats.filter(s => s.size > 0).length, members: p.seats }));
    },
    check_memberRules(m) {   // 0.6.5
      if (!this.gr.perMember) return 'unknown message type memberRules';
      if (typeof m.account !== 'string') return 'memberRules needs account (a plain string)';
      const rr = this.groupRulesFrom(m, true); if (rr.error) return rr.error;
      if (!this.acct.has(m.account)) return 'no account ' + m.account;
      if (!this.gr.firm && !this.gr.members.has(m.account)) return m.account + ' is in no group: its own rules are for a member of a group (My floor and My daily are for an account in no group)';
      return null;
    },
    check_firmMinimum(m) {   // 0.6.6: as ChartBridgeGroups.FirmMinimum
      if (!this.gr.firm) return 'unknown message type firmMinimum';
      if (typeof m.account !== 'string') return 'firmMinimum needs account (a plain string)';
      if (!this.acct.has(m.account)) return 'no account ' + m.account;
      const w = this.groupMoney(m, 'minBalance', false); if (w) return w;
      const id = this.gr.members.get(m.account), g = id ? this.gr.list.get(id) : null;
      const r = g ? this.groupRulesOf(m.account, g) : this.gr.own.get(m.account);
      if (!r) return m.account + ' has no firm rules yet: apply its account type first (the floor comes from its drawdown and lock)';
      if (r.drawdownType === 'static') return m.account + '\'s drawdown is static: its floor is fixed at ' + (r.size - r.drawdown).toFixed(2) + ', nothing to give';
      if (m.minBalance < r.size - r.drawdown - 0.004) return 'the minimum balance ' + m.minBalance.toFixed(2) + ' is below the starting floor (' + (r.size - r.drawdown).toFixed(2) + '): check the firm\'s dashboard';
      if (r.lockAt > 0 && m.minBalance > r.lockAt + 0.004) return 'the minimum balance ' + m.minBalance.toFixed(2) + ' is above where the floor stops (' + r.lockAt.toFixed(2) + '): check the firm\'s dashboard or the account\'s type';
      return null;
    },
    do_firmMinimum(m) {
      const id = this.gr.members.get(m.account), g = id ? this.gr.list.get(id) : null, r = g ? this.groupRulesOf(m.account, g) : this.gr.own.get(m.account);
      this.gr.peaks.set(m.account, +(m.minBalance + r.drawdown).toFixed(2)); this.groupsChanged();
    },
    do_memberRules(m) { this.gr.own.set(m.account, this.groupRulesFrom(m, true).rules); this.groupsChanged(); },
    check_accountLimits(m) {
      if (typeof m.account !== 'string' || !this.acct.has(m.account)) return 'no account ' + m.account;
      for (const k of ['floor', 'dailyLoss']) { if (!(k in m)) return k + ' is needed'; const w = this.groupMoney(m, k, true); if (w) return w; }
      const id = this.gr.members.get(m.account);
      if (id) return m.account + ' is in group ' + this.gr.list.get(id).name + ": its group's rules apply (put it in None for limits of its own)";
      return null;
    },
    do_accountLimits(m) { this.gr.personal.set(m.account, { floor: m.floor, daily: m.dailyLoss }); this.groupsChanged(); },
    groupsChanged() { this.sendAccounts(); },   // sendAccounts sends the groups too
    groupSummary(id) { const g = this.gr.list.get(id); return g ? g.name + ' ' + usd(g.size) : ''; },
  });
}
