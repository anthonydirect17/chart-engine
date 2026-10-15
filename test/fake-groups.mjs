// Reference behaviour for ChartBridge 0.5.8's prop groups (nt8/PROTOCOL.md "Prop groups and account state (0.5.8)") in the
// fake bridge (test/fake-v3.mjs): groupSave, groupDelete, accountGroup (highClose), accountLimits, the groups message, the
// accounts message's new fields and the one-direction check on the page's entries. Everything simulated: made-up groups
// (Lucid, Apex), made-up accounts and money; nothing reaches a broker. ChartBridgeGroups.cs is the real thing (its Mono
// harness, nt8/check/GroupsHarness.cs); this keeps the page's smokes honest about the messages and the words.
const isNum = v => typeof v === 'number' && isFinite(v);
const MONEY = /^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?$/;
const usd = v => '$' + (+v).toLocaleString('en-US', { maximumFractionDigits: 2 });

export const GROUP_KEYS = {
  groupSave: ['type', 'cid', 'group', 'name', 'noHedge', 'dailyLoss', 'drawdown', 'drawdownType', 'target', 'size', 'lockAt', 'consistency'],
  groupDelete: ['type', 'cid', 'group'],
  accountGroup: ['type', 'cid', 'account', 'group', 'highClose'],
  accountLimits: ['type', 'cid', 'account', 'floor', 'dailyLoss'],
};
export const GROUP_TYPES = Object.keys(GROUP_KEYS);

/** Adds the groups to OrderDeskV3's prototype. o.groups: false is a ChartBridge before 0.5.8 (no groups message, every group
 *  message unknown); o.groupsSeed: [{ name, size, drawdown, drawdownType, dailyLoss, target, lockAt, noHedge, members }]. */
export function installGroups(Desk) {
  Object.assign(Desk.prototype, {
    groupsInit(o) {
      this.gr = { on: o.groups !== false, list: new Map(), members: new Map(), personal: new Map(), peaks: new Map(), next: 1 };
      for (const s of o.groupsSeed || []) {
        const id = 'g' + this.gr.next++;
        this.gr.list.set(id, { id, name: s.name, noHedge: s.noHedge !== false, dailyLoss: s.dailyLoss || 0, drawdown: s.drawdown, drawdownType: s.drawdownType || 'eod', target: s.target || 0, size: s.size, lockAt: s.lockAt || 0 });
        for (const a of s.members || []) { this.gr.members.set(a, id); this.gr.peaks.set(a, Math.max(s.size, s.highClose || 0)); }
      }
    },
    groupsMsg() {
      const list = [...this.gr.list.values()].map(g => {
        const members = [...this.gr.members].filter(([, id]) => id === g.id).map(([a]) => a).sort();
        const holders = members.flatMap(a => this.groupHoldings(a));
        const longs = holders.some(h => h.side === 'long'), shorts = holders.some(h => h.side === 'short');
        return { id: g.id, name: g.name, noHedge: g.noHedge, dailyLoss: g.dailyLoss || null, drawdown: g.drawdown, drawdownType: g.drawdownType, target: g.target || null,
          size: g.size, lockAt: g.lockAt || null, consistency: g.consistency || null, members, side: longs && shorts ? 'mixed' : longs ? 'long' : shorts ? 'short' : null, holders };
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
      if (g) {
        const peak = Math.max(this.gr.peaks.get(a.name) || g.size, g.size);
        floor = g.drawdownType === 'static' ? g.size - g.drawdown : Math.min(peak - g.drawdown, g.lockAt > 0 ? g.lockAt : Infinity);
        roomDaily = g.dailyLoss > 0 ? g.dailyLoss + msg.pnlToday : null; targetLeft = g.target > 0 ? g.size + g.target - msg.balance : null;
        if (roomDaily === null) why.roomDaily = 'group ' + g.name + ' has no daily loss limit';
        if (targetLeft === null) why.targetLeft = 'group ' + g.name + ' has no profit target';
      } else {
        floor = mine.floor > 0 ? mine.floor : null; roomDaily = mine.daily > 0 ? mine.daily + msg.pnlToday : null;
        if (floor === null) why.floor = 'no group and no floor of its own (the Accounts tab)';
        if (roomDaily === null) why.roomDaily = 'no group and no daily limit of its own (the Accounts tab)';
        why.targetLeft = 'a personal account has no profit target';
      }
      if (floor !== null) roomFloor = +(eq - floor).toFixed(2); else why.roomFloor = why.floor;
      if (!up) { for (const k of ['roomFloor', 'roomDaily', 'targetLeft']) if (k !== 'targetLeft' || g) why[k] = 'the account is not connected'; roomFloor = roomDaily = null; if (g) targetLeft = null; }
      for (const [k, v] of [['floor', floor], ['roomFloor', roomFloor], ['roomDaily', roomDaily], ['targetLeft', targetLeft]]) if (v !== null) { src[k] = k === 'floor' && !g ? 'settings' : 'computed'; delete why[k]; }
      const r = v => (v === null ? null : +(+v).toFixed(2));
      return Object.assign(msg, { group: id || null, myFloor: mine.floor || null, myDailyLoss: mine.daily || null, myLimitsSet: this.gr.personal.has(a.name), floor: r(floor), roomFloor: r(roomFloor), roomDaily: r(roomDaily), targetLeft: r(targetLeft), src, why });
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
      if (m.group !== undefined && !this.gr.list.has(m.group)) return 'no group ' + m.group;
      if ([...this.gr.list.values()].some(g => g.id !== m.group && g.name.toLowerCase() === name.toLowerCase())) return 'a group named ' + name + ' is there already';
      return null;
    },
    do_groupSave(m) {
      const id = m.group || 'g' + this.gr.next++;
      this.gr.list.set(id, { id, name: m.name, noHedge: m.noHedge, dailyLoss: m.dailyLoss, drawdown: m.drawdown, drawdownType: m.drawdownType, target: m.target, size: m.size, lockAt: m.lockAt, consistency: m.consistency || 0 });
      this.groupsChanged();
    },
    check_groupDelete(m) { return this.gr.list.has(m.group) ? null : 'no group ' + m.group; },
    do_groupDelete(m) { this.gr.list.delete(m.group); for (const [a, id] of [...this.gr.members]) if (id === m.group) { this.gr.members.delete(a); this.gr.peaks.delete(a); } this.groupsChanged(); },
    check_accountGroup(m) {
      if (typeof m.account !== 'string' || !this.acct.has(m.account)) return 'no account ' + m.account;
      if (!('group' in m) || (m.group !== null && typeof m.group !== 'string')) return 'group must be a group id or null (None)';
      if (m.highClose !== undefined && m.group === null) return 'highClose goes with joining a group only';
      if (m.highClose !== undefined) { const w = this.groupMoney(m, 'highClose', false); if (w) return w; }
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
      else { const g = this.gr.list.get(m.group), a = this.acct.get(m.account); this.gr.members.set(m.account, m.group); this.gr.peaks.set(m.account, m.highClose || Math.max(g.size, a.balance + this.pnl(a.name).realized)); }
      this.groupsChanged();
    },
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
