// Reference behaviour for ChartBridge protocol v3 (0.4.0): nt8/PROTOCOL.md, "Protocol v3 (ChartBridge 0.4.0)".
// The fake bridge runs it with --v3 (test/fake-bridge.mjs); test/fake-v3.test.js checks it. Everything is simulated:
// made-up accounts (Sim101, EVAL-A, EVAL-B, FUNDED-C, SIM-F1, SIM-F2), a made-up bot, sample prices; nothing reaches a
// broker. OrderDeskV3 extends the v2 OrderDesk (test/fake-orders.mjs, unchanged) with: account checkmarks and Gone,
// stop-limit and MIT, Order Strategies (allocation, a pair per target bucket per fill, breakeven, trailing), Merge,
// cancel from the Working orders tab, quote-only roots, the Sim-only copier and the bot channel's rails.
import { OrderDesk, KEYS as V2_KEYS, allowedAccounts, onTickGrid } from './fake-orders.mjs';

export const SWITCHES = ['accountChecks', 'orderTypes', 'strategies', 'merge', 'cancelFromList', 'copier', 'bot'];
export const V3_ACCOUNTS = [
  { name: 'EVAL-A', sim: false, balance: 51240.5 }, { name: 'EVAL-B', sim: false, balance: 49870 },
  { name: 'FUNDED-C', sim: false, balance: 52010 }, { name: 'SIM-F1', sim: true, balance: 50000 },
  { name: 'SIM-F2', sim: true, balance: 50000 }, { name: 'Sim101', sim: true, balance: 100000 },
];
// quote-only markets (PROTOCOL.md "0.4.0 hardening and markets"): tick, point value, price format ("decimal", or "32nds" for
// ZN and ZB, as ChartBridge 0.4.0's hello says it); decimals only round the fake's prices (float noise), never on the wire;
// scale turns the sample feed (about 25,400) into a plausible price level. Sample data, never market data.
export const QUOTE_INSTR = {
  YM: { name: 'YM 12-26', tick: 1, pointValue: 5, scale: 1.817, priceFormat: 'decimal', decimals: 0 },
  RTY: { name: 'RTY 12-26', tick: 0.1, pointValue: 50, scale: 0.0964, priceFormat: 'decimal', decimals: 1 },
  GC: { name: 'GC 12-26', tick: 0.1, pointValue: 100, scale: 0.1554, priceFormat: 'decimal', decimals: 1 },
  SI: { name: 'SI 12-26', tick: 0.005, pointValue: 5000, scale: 0.001868, priceFormat: 'decimal', decimals: 3 },
  CL: { name: 'CL 12-26', tick: 0.01, pointValue: 1000, scale: 0.002439, priceFormat: 'decimal', decimals: 2 },
  '6E': { name: '6E 12-26', tick: 0.00005, pointValue: 125000, scale: 0.00004602, priceFormat: 'decimal', decimals: 5 },
  ZN: { name: 'ZN 12-26', tick: 0.015625, pointValue: 1000, scale: 0.004425, priceFormat: '32nds', decimals: 6 },
  ZB: { name: 'ZB 12-26', tick: 0.03125, pointValue: 1000, scale: 0.004621, priceFormat: '32nds', decimals: 5 },
};
for (const i of Object.values(QUOTE_INSTR)) i.quoteOnly = true;

/** A price as the page shows it (PROTOCOL.md "0.4.0 hardening and markets"): "32nds" is NinjaTrader's bond format, whole
 *  points, an apostrophe, the 32nds in two digits, and with a tick under 1/32 (ZN, 1/64) a third digit for the half:
 *  ZB 118.46875 is 118'15, ZN 104.109375 is 104'035. "decimal" shows the tick's decimals. */
export function formatPrice(p, priceFormat, tick) {
  if (priceFormat === '32nds') {
    const half = tick > 0 && tick < 1 / 32 - 1e-12, steps = Math.round(Math.abs(p) * (half ? 64 : 32));
    const whole = Math.floor(steps / (half ? 64 : 32)), rest = steps - whole * (half ? 64 : 32);
    const n32 = half ? Math.floor(rest / 2) : rest;
    return (p < 0 ? '-' : '') + whole + "'" + String(n32).padStart(2, '0') + (half ? (rest % 2 ? '5' : '0') : '');
  }
  const s = String(tick), i = s.indexOf('.');
  return p.toFixed(i < 0 ? 0 : s.length - i - 1);
}

/** The allocation rule (Order Strategies and Merge): q contracts over whole-percent shares, largest remainder, a tie
 *  to the later target, total exactly q. Returns one count per share (0 = that target is dropped). */
export function allocate(q, shares) {
  const raw = shares.map(s => q * s / 100), out = raw.map(x => Math.floor(x + 1e-9));
  let left = q - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => ({ i, r: x - Math.floor(x + 1e-9) })).sort((a, b) => b.r - a.r || b.i - a.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k].i]++;
  return out;
}

// v3 keys (gate 8 extended); v2's for the rest
export const KEYS = Object.assign({}, V2_KEYS, {
  order: V2_KEYS.order.concat(['limitOffset', 'limitPrice', 'strategy']),
  cancel: V2_KEYS.cancel.concat(['from']),
  client: ['type', 'v'],
  accountTrade: ['type', 'cid', 'account', 'on'],
  accountArchive: ['type', 'cid', 'account', 'confirm'],
  merge: ['type', 'cid', 'account', 'root'],
  copierGet: ['type', 'cid'],
  copierSet: ['type', 'cid', 'leader', 'mode'],
  copierFollower: ['type', 'cid', 'account', 'on', 'qty', 'size', 'lossLimit'],
  copierRearm: ['type', 'cid'],
  botMode: ['type', 'cid', 'mode'],
  botKill: ['type', 'cid', 'on'],
  botSeen: ['type', 'id', 'at'],
  botAnswer: ['type', 'cid', 'id', 'answer', 'at'],
  botRails: ['type', 'cid', 'maxTrades', 'maxLosses', 'root'],   // as ChartBridge 0.4.0 built it (ChartBridgeBot.cs SetRails)
});
export const STRATEGY_KEYS = ['name', 'stop', 'stopLimit', 't1', 't1Share', 't2', 't2Share', 't3', 't3Share', 'beAfter', 'bePlus', 'trailAfter', 'trailBy', 'trailStep'];
export const BOOL_KEYS = { accountTrade: ['on'], accountArchive: ['confirm'], copierFollower: ['on'], botKill: ['on'] };
export const BOT_KEYS = {
  botHello: ['type', 'name'], beat: ['type'], withdraw: ['type', 'id', 'reason'], flatten: ['type'],
  signal: ['type', 'id', 'action', 'side', 'kind', 'price', 'stopTicks', 'targetTicks', 'reason'],
};
const V3_TYPES = ['accountTrade', 'accountArchive', 'merge', 'copierGet', 'copierSet', 'copierFollower', 'copierRearm', 'botMode', 'botKill', 'botSeen', 'botAnswer', 'botRails'];
const SWITCH_OF = { accountTrade: 'accountChecks', accountArchive: null, merge: 'merge', copierGet: 'copier', copierSet: 'copier', copierFollower: 'copier', copierRearm: 'copier', botMode: 'bot', botKill: 'bot', botSeen: 'bot', botAnswer: 'bot', botRails: 'bot' };

const isInt = v => typeof v === 'number' && Number.isInteger(v);
const BOT_SIBLING = { MNQ: 'NQ', NQ: 'MNQ', MES: 'ES', ES: 'MES' };   // ChartBridgeBot.cs Sibling
const WORKING = new Set(['working', 'partFilled']);
const isWorking = o => WORKING.has(o.state);
const isLeg = o => o.role === 'stop' || o.role === 'target';
const fmt = p => (p < 0 ? '-' : '') + Math.abs(p).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Strict keys and value shapes for a v3 page message (gate 8 extended), or null when fine. text: the raw message. */
export function checkKeysV3(m, text) {
  if (text !== undefined && /\\/.test(text)) return 'The message has a backslash escape.';
  const allowed = KEYS[m.type];
  if (!allowed) return 'Unknown message type ' + m.type + '.';
  for (const k of Object.keys(m)) if (!allowed.includes(k) && !(m.type === 'flatten' && k === 'bracket')) return 'Unknown key "' + k + '" in ' + m.type + '.';
  for (const [k, v] of Object.entries(m)) {
    if (v !== null && typeof v === 'object' && !(m.type === 'order' && (k === 'bracket' || k === 'strategy'))) return 'The message has an unexpected nested object or list.';
    if (typeof v === 'boolean' && !(BOOL_KEYS[m.type] || []).includes(k)) return k + ' cannot be true or false.';
    if (typeof v === 'string' && v.length > 200) return k + ' is over 200 characters.';
  }
  for (const k of BOOL_KEYS[m.type] || []) if (typeof m[k] !== 'boolean') return k + ' must be true or false.';
  if (m.bracket !== undefined && m.strategy !== undefined) return 'An order takes a bracket or a strategy, not both.';
  if (m.strategy !== undefined) {
    const s = m.strategy;
    if (s === null || typeof s !== 'object' || Array.isArray(s)) return 'A strategy must be one flat object.';
    for (const [k, v] of Object.entries(s)) {
      if (!STRATEGY_KEYS.includes(k)) return 'Unknown key "' + k + '" in strategy.';
      if (v !== null && typeof v === 'object') return 'A strategy must be one flat object.';
    }
  }
  if (m.bracket !== undefined && m.bracket !== null && typeof m.bracket === 'object' && !Array.isArray(m.bracket))
    for (const k of Object.keys(m.bracket)) if (k !== 'stop' && k !== 'target') return 'Unknown key "' + k + '" in bracket.';
  if (m.cid !== undefined && typeof m.cid !== 'string') return 'cid must be a string.';
  return null;
}

/** A strategy's rule check (PROTOCOL.md "Order Strategies"), or null. */
export function checkStrategy(s, maxB) {
  const whole = (k, min) => { const v = s[k]; if (!isInt(v) || v < min) return k + ' must be a whole number of ' + min + ' or more.'; if (maxB > 0 && v > maxB && !/Share$/.test(k)) return k + ' must be at most ' + maxB + ' (maxBracketTicks in config.txt).'; return null; };
  if (typeof s.name !== 'string' || !s.name.trim() || s.name.length > 40) return 'The strategy needs a name of 1 to 40 characters.';
  let why = whole('stop', 1); if (why) return why;
  if (s.stopLimit !== undefined && s.stopLimit !== null && (why = whole('stopLimit', 0))) return why;
  let n = 0, sum = 0;
  for (const i of [1, 2, 3]) {
    const t = s['t' + i], sh = s['t' + i + 'Share'];
    if (t === undefined && sh === undefined) continue;
    if (n !== i - 1) return 't' + i + ' needs t' + (i - 1) + '.';
    if ((why = whole('t' + i, 1))) return why;
    if (!isInt(sh) || sh < 1 || sh > 100) return 't' + i + 'Share must be a whole percent from 1 to 100.';
    n = i; sum += sh;
  }
  if (n && sum !== 100) return 'The target shares add up to ' + sum + '; they must add up to 100.';
  if ((s.beAfter === undefined) !== (s.bePlus === undefined)) return 'beAfter and bePlus go together.';
  if (s.beAfter !== undefined) {
    if ((why = whole('beAfter', 1)) || (why = whole('bePlus', 0))) return why;
    if (s.bePlus >= s.beAfter) return 'bePlus must be below beAfter.';
  }
  const tr = ['trailAfter', 'trailBy', 'trailStep'].filter(k => s[k] !== undefined).length;
  if (tr !== 0 && tr !== 3) return 'trailAfter, trailBy and trailStep go together.';
  if (tr) for (const k of ['trailAfter', 'trailBy', 'trailStep']) if ((why = whole(k, 1))) return why;
  return null;
}
export const targetsOf = s => [1, 2, 3].filter(i => s['t' + i] !== undefined).map(i => ({ ticks: s['t' + i], share: s['t' + i + 'Share'] }));

export class OrderDeskV3 extends OrderDesk {
  /** extra options: switches {accountChecks, ...}, accountList [{name, sim, balance}], quoteRoots [roots], botRoot,
   *  graceMs (Gone after this long, default 10000), ownOrigin. */
  constructor(o) {
    super(o);
    this.sw = Object.fromEntries(SWITCHES.map(k => [k, !!(o.switches && o.switches[k])]));
    this.graceMs = o.graceMs === undefined ? 10000 : o.graceMs;
    this.botConfigRoot = o.botRoot || 'MNQ';   // config.txt botRoot
    this.botRoot = this.botConfigRoot;          // the root in force: botRoot, or its micro or mini set from the page (bot-rails.txt)
    this.acct = new Map();
    const pre = allowedAccounts(this.config.tradeAccounts, (o.accountList || []).map(a => a.name));   // first start: tradeAccounts pre-checked
    for (const a of o.accountList || []) this.acct.set(a.name, { name: a.name, sim: !!a.sim, connection: 'connected', since: this.now(), trade: pre.includes(a.name),
      state: 'active', goneWhy: null, goneSince: null, archivedAt: null, balance: a.balance || 0, realized: 0, drawdown: a.drawdown === undefined ? null : a.drawdown });
    this.log = [];                 // accounts.log, copier.log and merges, as lines
    this.managed = new Map();      // entry id -> { entry, s, pairs, best, state, text }
    this.merges = { ok: 0, restored: 0, failed: 0, refused: 0, lastAtUtcMs: null };
    this.mergedSets = new Map();   // 'account|root' -> { stopId, targetIds } for a multi-target merge
    this.copier = { leader: 'Sim101', mode: 'executions', armed: false, standDownWhy: 'ChartBridge started: press Re-arm', followers: new Map(), drops: [], decisions: 0, skipped: 0, standDowns: 0, leaderMs: [] };
    this.bot = { connected: false, simulated: false, name: null, mode: 'shadow', killed: false, standDown: null, trades: 0, losses: 0, lastBeat: 0, lastSignal: null, conn: null, maxTrades: 5, maxLosses: 3,
      proposals: new Map(), signals: [], stats: { signals: 0, proposals: 0, answered: 0, notAnswered: 0, placed: 0, refused: 0, heartbeatLost: 0 } };
    this.refreshAccounts();
  }

  /* ---------------- accounts (PROTOCOL.md "Accounts") */
  watched(name) { const a = this.acct.get(name); return !!a && a.state !== 'archived'; }
  connected(name) { const a = this.acct.get(name); return !!a && a.connection === 'connected'; }
  /** gate 2 for entries */
  refreshAccounts() {
    if (!this.sw.accountChecks) { this.accounts = allowedAccounts(this.config.tradeAccounts, [...this.acct.keys()]); return; }
    this.accounts = [...this.acct.values()].filter(a => a.trade && a.state === 'active' && a.connection === 'connected').map(a => a.name);
  }
  /** gate 2 for exits: watched, Connected, not Backtest or Playback (closing always works) */
  exitAllowed(name) { return this.accounts.includes(name) || (this.watched(name) && this.connected(name) && name !== 'Backtest' && !/^Playback/i.test(name)); }
  logLine(file, who, what) { this.log.push({ file, at: new Date(this.now()).toISOString(), who, what }); if (this.log.length > 500) this.log.shift(); }
  setConnection(name, connection) {
    const a = this.acct.get(name); if (!a || a.connection === connection) return;
    a.connection = connection; a.since = this.now();
    a.badSince = null;
    if (connection === 'connected' && a.state === 'gone') { a.state = 'active'; a.goneWhy = null; a.goneSince = null; this.logLine('accounts', name, 'back: connected (the checkmark stays off)'); }
    if (connection !== 'connected') this.copierDrop(name);
    this.refreshAccounts(); this.sendAccounts();
  }
  /** every second (and in tests): the 10 s grace, then Gone and the checkmark off */
  checkGone() {
    const t = this.now();
    for (const a of this.acct.values()) {
      if (a.state !== 'active') continue;
      const why = a.connection !== 'connected' ? (a.connection === 'disabled' ? 'disabled' : 'disconnected') : a.drawdown !== null && this.room(a) <= 0 ? 'drawdown' : null;
      if (!why) { a.badSince = null; continue; }
      if (a.badSince == null) a.badSince = why === 'drawdown' ? t : a.since;   // the grace runs from the connection change
      if (t - a.badSince < this.graceMs) continue;
      a.state = 'gone'; a.goneWhy = why; a.goneSince = t; a.trade = false;
      this.logLine('accounts', a.name, 'gone: ' + why + '; trading off');
      this.broadcastV3({ type: 'status', level: 'warn', text: a.name + ' is gone (' + why + ' for ' + Math.round(this.graceMs / 1000) + ' s): trading is off for it' });
      this.refreshAccounts(); this.sendAccounts();
    }
  }
  room(a) { return a.drawdown === null ? null : +(a.drawdown + Math.min(0, this.pnl(a.name).today)).toFixed(2); }
  pnl(name) {
    const a = this.acct.get(name); let unreal = 0;
    for (const [k, p] of this.positions) {
      const [acc, root] = k.split('|'); if (acc !== name || !p.qty || !this.instruments[root]) continue;
      unreal += (this.last[root] - p.avgPrice) * p.qty * this.instruments[root].pointValue;
    }
    return { realized: +a.realized.toFixed(2), unrealized: +unreal.toFixed(2), today: +(a.realized + unreal).toFixed(2) };
  }
  accountMsg(a) {
    const p = this.pnl(a.name), positions = [];
    for (const [k, x] of this.positions) { const [acc, root] = k.split('|'); if (acc === a.name && x.qty) positions.push({ root, name: this.instruments[root].name, qty: x.qty, avgPrice: x.avgPrice }); }
    const off = a.connection !== 'connected' ? 'the account is not connected' : null, room = this.room(a);
    return { name: a.name, sim: a.sim, connection: a.connection === 'disabled' ? 'disconnected' : a.connection, trade: this.sw.accountChecks ? a.trade : this.accounts.includes(a.name),
      tradable: this.config.trading && this.accounts.includes(a.name), state: a.state, goneWhy: a.goneWhy, goneSince: a.goneSince,
      balance: +(a.balance + p.realized).toFixed(2), pnlToday: p.today, realizedToday: p.realized, unrealized: p.unrealized, positions,
      roomDrawdown: off ? null : room, roomDrawdownWhy: off || (room === null ? 'NinjaTrader does not report a trailing drawdown for this account' : null),
      roomDailyLoss: null, roomDailyLossWhy: off || 'NinjaTrader does not report a daily loss limit for this account' };
  }
  accountsMsg() {
    return { type: 'accounts', list: [...this.acct.values()].filter(a => a.state !== 'archived').sort((x, y) => x.name < y.name ? -1 : 1).map(a => this.accountMsg(a)),
      archived: [...this.acct.values()].filter(a => a.state === 'archived').map(a => ({ name: a.name, at: a.archivedAt })) };
  }
  /** to v3 pages from the own origin, signed in or not */
  sendAccounts() { const m = this.accountsMsg(); for (const c of this.conns()) if (c.v3 && c.origin === this.origin()) this.send(c, m); }
  broadcastV3(msg) { for (const c of this.conns()) if (c.authed && c.v3) this.send(c, msg); }

  /** the page's `client` message */
  client(conn, m) {
    if (m.v !== 3 || Object.keys(m).some(k => k !== 'type' && k !== 'v')) return this.send(conn, { type: 'status', level: 'warn', text: 'ChartBridge refused a client message: v must be 3' });
    conn.v3 = true;
    if (conn.origin === this.origin()) this.send(conn, this.accountsMsg());
  }

  /* ---------------- connection and auth: v3 pages see every watched account */
  tradingMsg(conn) {
    const m = super.tradingMsg(conn);
    if (conn.v3 && m.enabled) m.switches = Object.assign({}, this.sw);
    return m;
  }
  visible(account, conn) { return conn.v3 ? this.watched(account) : this.accounts.includes(account); }
  auth(conn, token) {
    const out = [];
    const send0 = this.send; this.send = (c, msg) => out.push(msg);
    try { super.auth(conn, token); } finally { this.send = send0; }
    for (const msg of out) {
      if (msg.type === 'orders' && conn.v3) msg.list = [...this.orders.values()].filter(o => isWorking(o) && this.watched(o.account) && this.instruments[o.root]).map(o => this.orderMsg(o, true));
      this.send(conn, msg);
    }
    if (!conn.authed || !conn.v3) return;
    for (const [k, p] of this.positions) { const [account, root] = k.split('|'); if (p.qty && this.watched(account) && !this.accounts.includes(account)) this.send(conn, { type: 'position', account, root, qty: p.qty, avgPrice: p.avgPrice }); }
    for (const x of this.managed.values()) this.send(conn, this.managedMsg(x));
    if (this.sw.copier) this.send(conn, this.copierMsg());
    if (this.sw.bot) this.send(conn, this.botMsg());
  }
  orderMsg(o, v3) {
    const m = super.orderMsg(o);
    if (o.kind === 'stopLimit' && o.limitPrice !== undefined) m.limitPrice = o.limitPrice;
    /* as ChartBridge 0.4.0 built it: `by` only for a strategy's entry and legs (ChartBridgeStrategies.cs V3OrderFields, every
       page while strategies is on); Merge, the copier and the bot mark nothing on the page (the bot's names, CB#... bot s8
       t16, stay in NinjaTrader: ChartBridgeBot.cs). `tradable` to a v3 page only (ChartBridgeAccounts.ForPage). */
    if (o.by === 'strategy') m.by = o.by;
    if (o.bucket && o.by === 'strategy') m.bucket = o.bucket;
    if (v3) m.tradable = this.accounts.includes(o.account);
    return m;
  }
  emitOrder(o) {
    if (!this.instruments[o.root] || this.instruments[o.root].quoteOnly) return;
    const msg = this.orderMsg(o), msg3 = this.orderMsg(o, true);
    for (const c of this.conns()) if (c.authed && this.visible(o.account, c)) this.send(c, c.v3 ? msg3 : msg);
    if (this.bot.conn && this.isBotOrder(o)) this.send(this.bot.conn, msg);     // the bot sees its own orders only
  }
  isBotOrder(o) { return o.by === 'bot' || (o.parent && (this.orders.get(o.parent) || {}).by === 'bot'); }

  /* ---------------- page to server */
  handle(conn, m, text) {
    const ref = {};
    if (typeof m.cid === 'string') ref.cid = m.cid;
    if (typeof m.id === 'string') ref.id = m.id;
    if (m.type === 'botSeen') { const why = this.blocked(conn) || checkKeysV3(m, text) || this.check_botSeen(m); if (why) this.send(conn, Object.assign({ type: 'reject' }, ref, { reason: why })); else this.do_botSeen(m); return !why; }
    let why = this.checkAction(conn) || checkKeysV3(m, text);
    if (!why && V3_TYPES.includes(m.type) && SWITCH_OF[m.type] && !this.sw[SWITCH_OF[m.type]]) why = m.type + ' is off (' + SWITCH_OF[m.type] + ' in config.txt).';
    if (!why && m.type === 'accountArchive' && !this.sw.accountChecks) why = 'accountArchive is off (accountChecks in config.txt).';
    if (!why) why = this['check_' + m.type](m);
    if (why) { this.send(conn, Object.assign({ type: 'reject' }, ref, { reason: why })); if (m.type === 'merge') this.merges.refused++; return false; }
    this['do_' + m.type](m, conn);
    return true;
  }
  /** ChartBridge 0.4.0's one early check (PROTOCOL.md "Quote-only markets"), with its exact words */
  quoteOnly(root) { return this.instruments[root] && this.instruments[root].quoteOnly ? root + ' is quote only: ChartBridge shows its prices on the Quote board and refuses every order for it (quoteRoots in config.txt)' : null; }
  checkEntryAccount(account) {
    if (this.sw.accountChecks && this.acct.has(account) && !this.accounts.includes(account)) {
      const a = this.acct.get(account);
      return a.state === 'gone' ? account + ' is gone: trading is off for it.' : a.connection !== 'connected' ? account + ' is not connected.' : account + ' is not checked for trading (the Accounts tab).';
    }
    return null;
  }
  check_order(m) {
    const q = this.quoteOnly(m.root); if (q) return q;
    const e = this.checkEntryAccount(m.account); if (e) return e;
    if ((m.kind === 'stopLimit' || m.kind === 'mit') && !this.sw.orderTypes) return 'Stop-limit and MIT orders are off (orderTypes in config.txt).';
    if (m.strategy !== undefined && !this.sw.strategies) return 'Order Strategies are off (strategies in config.txt).';
    if ((m.limitOffset !== undefined || m.limitPrice !== undefined) && m.kind !== 'stopLimit') return 'limitOffset and limitPrice go on a stopLimit order only.';
    if (this.sw.copier && this.copier.armed && m.account === this.copier.leader && [...this.copier.followers.values()].some(f => f.on)) {
      const st = m.strategy ? m.strategy.stop : m.bracket ? m.bracket.stop : 0;
      if (!(st > 0)) return 'The copier needs a stop on every leader entry.';
    }
    const base = Object.assign({}, m, { kind: m.kind === 'stopLimit' ? 'stop' : m.kind === 'mit' ? 'limit' : m.kind });
    delete base.limitOffset; delete base.limitPrice; delete base.strategy;
    if (m.strategy !== undefined) {
      const why = m.strategy && typeof m.strategy === 'object' ? checkStrategy(m.strategy, this.config.maxBracketTicks) : 'A strategy must be one flat object.';
      if (why) return why;
      base.bracket = { stop: m.strategy.stop, target: 0 };
    }
    const v2 = super.check_order(base);
    if (v2) return v2.replace('Kind must be market, limit or stop.', 'Kind must be market, limit, stop, stopLimit or mit.');
    if (m.kind === 'mit' && m.price === this.last[m.root]) return 'An MIT at the last price would trigger at once; use a market order.';
    if (m.kind === 'stopLimit') {
      const tick = this.instruments[m.root].tick, buy = m.side === 'buy';
      if ((m.limitOffset === undefined) === (m.limitPrice === undefined)) return 'A stopLimit needs exactly one of limitOffset or limitPrice.';
      if (m.limitOffset !== undefined) {
        if (!isInt(m.limitOffset) || m.limitOffset < 0) return 'limitOffset must be a whole number of ticks, 0 or more.';
        if (this.config.maxBracketTicks > 0 && m.limitOffset > this.config.maxBracketTicks) return 'limitOffset must be at most ' + this.config.maxBracketTicks + ' (maxBracketTicks in config.txt).';
      } else {
        if (typeof m.limitPrice !== 'number' || !onTickGrid(m.limitPrice, tick)) return 'limitPrice is not on the ' + m.root + ' tick grid (' + tick + ').';
        if (buy ? m.limitPrice < m.price : m.limitPrice > m.price) return 'A ' + m.side + ' stop-limit\'s limit must be at or ' + (buy ? 'above' : 'below') + ' its stop.';
      }
    }
    return null;
  }
  do_order(m) {
    if (m.kind !== 'stopLimit' && m.kind !== 'mit' && !m.strategy) return super.do_order(m);
    const o = this.newOrder({ cid: m.cid, account: m.account, root: m.root, side: m.side, kind: m.kind, qty: m.qty, price: m.kind === 'market' ? null : m.price, role: 'entry', fromPage: true });
    if (m.kind === 'stopLimit') {
      const tick = this.instruments[m.root].tick, off = m.limitOffset !== undefined ? m.limitOffset : Math.round(Math.abs(m.limitPrice - m.price) / tick);
      o.limitOffset = off; o.limitPrice = +(m.price + (m.side === 'buy' ? 1 : -1) * off * tick).toFixed(10);
    }
    if (m.strategy) { o.strategy = Object.assign({}, m.strategy); o.bracket = { strategy: true }; o.by = 'strategy'; this.managed.set(o.id, { entry: o, s: o.strategy, pairs: [], best: null, state: 'waiting', text: null }); }
    else { const b = m.bracket; o.planned = { stopTicks: b && b.stop > 0 ? b.stop : null, targetTicks: b && b.target > 0 ? b.target : null }; }
    this.emitOrder(o);
    if (o.strategy) this.broadcastV3(this.managedMsg(this.managed.get(o.id)));
    this.matchOne(o, this.last[o.root], true);
  }
  check_change(m) {
    const o = this.orders.get(m.id);
    if (o && this.quoteOnly(o.root)) return this.quoteOnly(o.root);
    if (o && isWorking(o) && !this.accounts.includes(o.account)) {
      if (o.role === 'entry' || !this.exitAllowed(o.account)) return 'No working order ' + m.id + '.';
      return this.checkPrice(o.root, o.side, o.kind === 'limit' ? 'limit' : 'stop', m.price);
    }
    if (o && isWorking(o) && (o.kind === 'mit' || (o.kind === 'stopLimit' && o.limitOffset !== undefined))) return this.checkPrice(o.root, o.side, o.kind === 'mit' ? 'limit' : 'stop', m.price);
    return super.check_change(m);
  }
  do_change(m) {
    const o = this.orders.get(m.id);
    o.price = m.price;
    if (o.kind === 'stopLimit' && o.limitOffset !== undefined) o.limitPrice = +(m.price + (o.side === 'buy' ? 1 : -1) * o.limitOffset * this.instruments[o.root].tick).toFixed(10);
    this.emitOrder(o);
    if (o.role === 'stop') this.copierFollowStop(o);
    this.matchOne(o, this.last[o.root], true);
  }
  check_plan(m) {
    const o = this.orders.get(m.id);
    if (o && o.strategy) return 'A strategy entry has no planned stop and target to change; cancel it and place it again.';
    if (o && isWorking(o) && !this.accounts.includes(o.account)) return 'No working order ' + m.id + '.';
    return super.check_plan(m);
  }
  check_cancel(m) {
    const o = this.orders.get(m.id);
    if (m.from !== undefined && m.from !== 'list') return 'from must be "list".';
    if (m.from === 'list' && !this.sw.cancelFromList) return 'Cancel from the Working orders tab is off (cancelFromList in config.txt).';
    if (!o || !isWorking(o) || !this.watched(o.account) || !this.instruments[o.root] || this.instruments[o.root].quoteOnly) return 'No working order ' + m.id + '.';
    if (!this.exitAllowed(o.account)) return 'No working order ' + m.id + '.';
    return null;
  }
  check_flatten(m) {
    const q = this.quoteOnly(m.root); if (q) return q;
    if (!this.exitAllowed(m.account)) return 'Account ' + m.account + ' is not allowed to trade (tradeAccounts in config.txt).';
    if (!this.instruments[m.root]) return m.root + ' is not an instrument ChartBridge serves.';
    if (!(this.last[m.root] > 0)) return 'No last price for ' + m.root + ' yet.';
    return null;
  }
  do_flatten(m) { this.mergedSets.delete(m.account + '|' + m.root); super.do_flatten(m); }

  check_accountTrade(m) {
    const a = this.acct.get(m.account);
    if (!a || a.state === 'archived') return 'No account ' + m.account + '.';
    if (!m.on) return null;
    if (a.name === 'Backtest' || /^Playback/i.test(a.name)) return a.name + ' can never trade.';
    if (a.state === 'gone') return a.name + ' is gone (' + a.goneWhy + '); it can be checked again once it is back.';
    if (a.connection !== 'connected') return a.name + ' is not connected.';
    return null;
  }
  do_accountTrade(m) {
    const a = this.acct.get(m.account); a.trade = m.on;
    this.logLine('accounts', a.name, (m.on ? 'checked' : 'unchecked') + ' by the page');
    this.refreshAccounts(); this.sendAccounts();
    const t = { type: 'trading' };
    for (const c of this.conns()) if (c.authed) this.send(c, Object.assign(this.tradingMsg(c), t));
  }
  check_accountArchive(m) {
    const a = this.acct.get(m.account);
    if (!a || a.state === 'archived') return 'No account ' + m.account + '.';
    if (m.confirm !== true) return 'Archive needs confirm: true.';
    if (a.state !== 'gone') return a.name + ' is not gone; only a gone account can be archived.';
    return null;
  }
  do_accountArchive(m) {
    const a = this.acct.get(m.account); a.state = 'archived'; a.archivedAt = this.now(); a.trade = false;
    this.copier.followers.delete(a.name);
    this.logLine('accounts', a.name, 'archived by the page');
    this.refreshAccounts(); this.sendAccounts();
  }

  /* ---------------- fills: realized P&L, strategies, the copier */
  fill(o, qty, price) {
    const p = this.pos(o.account, o.root), was = p.qty, avg = p.avgPrice, a = this.acct.get(o.account);
    const signed = o.side === 'buy' ? qty : -qty;
    if (a && was && Math.sign(was) !== Math.sign(signed)) {
      const closed = Math.min(Math.abs(was), qty);
      a.realized += (price - avg) * closed * Math.sign(was) * this.instruments[o.root].pointValue;
      if (o.by === 'bot' || this.isBotPosition(o)) this.botClosed((price - avg) * closed * Math.sign(was));
    }
    super.fill(o, qty, price);
    this.lastFillAt = this.now(); this.lastFillKey = o.account + '|' + o.root;
    if (!this.accounts.includes(o.account) && this.watched(o.account))
      for (const c of this.conns()) if (c.authed && c.v3) this.send(c, { type: 'position', account: o.account, root: o.root, qty: p.qty, avgPrice: p.qty ? p.avgPrice : null });
    if (this.bot.conn && this.isBotOrder(o)) {
      this.send(this.bot.conn, { type: 'exec', account: o.account, name: o.name, root: o.root, side: o.side, qty, p: price, t: +this.barTime().toFixed(3), u: this.now(), id: 'X' + this.execSeq, order: o.id });
      this.send(this.bot.conn, { type: 'position', account: o.account, root: o.root, qty: p.qty, avgPrice: p.qty ? p.avgPrice : null });
    }
    const ms = this.mergedSets.get(o.account + '|' + o.root);
    if (ms) this.mergedUpkeep(o, ms);
    if (o.role === 'entry' && o.by === 'bot' && o.filled === qty) this.bot.trades++;
    if (this.sw.copier) this.copierOnFill(o, qty, price, was);
  }
  isBotPosition(o) { return o.account === 'Sim101' && o.root === this.botRoot && this.bot.position; }
  bracketsAfterFill(entry, qty, price) {
    if (!entry.strategy) { super.bracketsAfterFill(entry, qty, price); this.copierAfterLeaderLegs(entry, qty, price); return; }
    const x = this.managed.get(entry.id), s = entry.strategy, tick = this.instruments[entry.root].tick, dir = entry.side === 'buy' ? 1 : -1, exit = entry.side === 'buy' ? 'sell' : 'buy';
    const tg = targetsOf(s), alloc = tg.length ? allocate(qty, tg.map(t => t.share)) : [qty];
    const stopPx = +(price - dir * s.stop * tick).toFixed(10), last = this.last[entry.root], where = entry.root + ' ' + entry.account;
    if (dir > 0 ? stopPx >= last : stopPx <= last) {
      const xo = this.newOrder({ cid: null, account: entry.account, root: entry.root, side: exit, kind: 'market', qty, price: null, role: 'other', parent: entry.id });
      this.broadcast({ type: 'status', level: 'error', text: where + ': price had already passed the stop level ' + fmt(stopPx) + ' (last ' + fmt(last) + '); exited ' + qty + ' at market' });
      this.emitOrder(xo); this.matchOne(xo, last, true);
      return;
    }
    const made = [];
    alloc.forEach((q, i) => {
      if (!q) return;                                  // a target that rounds to 0 is dropped
      const bucket = tg.length ? i + 1 : null, oco = tg.length ? 'cb-' + entry.id + '-f' + entry.filled + '-' + bucket : null;
      const st = this.newOrder({ cid: null, account: entry.account, root: entry.root, side: exit, kind: s.stopLimit != null ? 'stopLimit' : 'stop', qty, price: stopPx, role: 'stop', oco, parent: entry.id, by: 'strategy', bucket });
      st.qty = q;
      if (s.stopLimit != null) { st.limitOffset = s.stopLimit; st.limitPrice = +(stopPx - dir * s.stopLimit * tick).toFixed(10); }
      made.push(st);
      let tgo = null;
      if (tg.length) { tgo = this.newOrder({ cid: null, account: entry.account, root: entry.root, side: exit, kind: 'limit', qty: q, price: +(price + dir * tg[i].ticks * tick).toFixed(10), role: 'target', oco, parent: entry.id, by: 'strategy', bucket }); made.push(tgo); }
      x.pairs.push({ bucket: bucket || 1, qty: q, fill: price, stopId: st.id, stop: st.price, targetId: tgo ? tgo.id : null, target: tgo ? tgo.price : null, be: false, trailing: false, lastMove: 0 });
    });
    x.state = 'active'; if (x.best === null) x.best = price;
    for (const o of made) this.emitOrder(o);
    this.broadcastV3(this.managedMsg(x));
    for (const o of made) this.matchOne(o, this.last[o.root], true);
    this.copierAfterLeaderLegs(entry, qty, price);
  }
  /** a strategy stop-limit leg at the fake's simple matching: a stop that fills at its stop price */
  matchOne(o, price, placing) {
    if (!isWorking(o) || !(price > 0)) return;
    const buy = o.side === 'buy';
    if (o.kind === 'mit') { if (buy ? price <= o.price : price >= o.price) this.fill(o, o.qty - o.filled, price); return; }
    if (o.kind === 'stopLimit' && o.limitPrice !== undefined) {
      if (!o.triggered && (buy ? price >= o.price : price <= o.price)) o.triggered = true;
      if (o.triggered && (buy ? price <= o.limitPrice : price >= o.limitPrice)) this.fill(o, o.qty - o.filled, price);
      return;
    }
    super.matchOne(o, price, placing);
  }
  managedMsg(x) {
    return { type: 'managed', id: x.entry.id, account: x.entry.account, root: x.entry.root, side: x.entry.side, name: x.s.name, strategy: x.s, state: x.state,
      pairs: x.pairs.map(p => ({ bucket: p.bucket, qty: p.qty, fill: p.fill, stopId: p.stopId, stop: p.stop, targetId: p.targetId, target: p.target, be: p.be, trailing: p.trailing })), best: x.best, text: x.text };
  }
  /** breakeven and trailing on every trade (PROTOCOL.md: never back, never through the last trade, 500 ms apart) */
  tick(root, price) {
    super.tick(root, price);
    for (const x of this.managed.values()) {
      if (x.entry.root !== root || x.state === 'done' || x.state === 'unmanaged' || !x.pairs.length) continue;
      const dir = x.entry.side === 'buy' ? 1 : -1, tick = this.instruments[root].tick, s = x.s;
      if (x.best === null || (price - x.best) * dir > 0) x.best = price;
      let changed = false, live = false;
      for (const p of x.pairs) {
        const st = this.orders.get(p.stopId);
        if (!st || !isWorking(st)) continue;
        live = true;
        const profit = Math.round((x.best - p.fill) * dir / tick);
        let level = null;
        if (s.beAfter !== undefined && profit >= s.beAfter) level = +(p.fill + dir * s.bePlus * tick).toFixed(10);
        if (s.trailAfter !== undefined && profit >= s.trailAfter) {
          const tr = +(x.best - dir * s.trailBy * tick).toFixed(10);
          if (level === null || (tr - level) * dir > 0) level = tr;
        }
        if (level === null || (level - st.price) * dir <= 0) continue;                       // never back
        if (s.trailAfter !== undefined && profit >= s.trailAfter && !(s.beAfter !== undefined && level === +(p.fill + dir * s.bePlus * tick).toFixed(10))
          && Math.round((level - st.price) * dir / tick) < s.trailStep) continue;          // steps of trailStep
        if ((level - price) * dir >= 0) continue;                                           // never at or through the last trade
        if (this.now() - p.lastMove < 500) continue;
        st.price = level; p.stop = level; p.lastMove = this.now();
        if (st.kind === 'stopLimit') st.limitPrice = +(level - dir * st.limitOffset * tick).toFixed(10);
        if (s.beAfter !== undefined && profit >= s.beAfter) p.be = true;
        if (s.trailAfter !== undefined && profit >= s.trailAfter) p.trailing = true;
        this.emitOrder(st); this.copierFollowStop(st); changed = true;
      }
      if (!live && x.entry.state === 'filled') { x.state = 'done'; changed = true; }
      if (changed) this.broadcastV3(this.managedMsg(x));
    }
  }
  /** a restart (F5) in the fake: resume when the managed record is there, else leave the stops (PROTOCOL.md) */
  simulateRestart(lostRecord) {
    for (const x of this.managed.values()) {
      if (x.state === 'done' || !x.pairs.length) continue;
      if (lostRecord) { x.state = 'unmanaged'; x.text = 'breakeven and trailing could not be resumed after the restart; the stop stays where it is'; this.broadcastV3({ type: 'status', level: 'error', text: x.entry.root + ' ' + x.entry.account + ': ' + x.text + '. Manage it by hand' }); }
      else { x.state = 'resumed'; x.text = 'ChartBridge restarted; breakeven and trailing resumed'; }
      this.broadcastV3(this.managedMsg(x));
    }
  }

  /* ---------------- Merge (PROTOCOL.md "Merge stops and targets") */
  pairsOf(account, root) {
    const pairs = new Map();
    for (const o of this.orders.values()) {
      if (!isWorking(o) || !isLeg(o) || o.account !== account || o.root !== root) continue;
      const key = o.oco || o.id;
      if (!pairs.has(key)) pairs.set(key, { key, stop: null, target: null, seq: +o.id.slice(2) });
      pairs.get(key)[o.role] = o;
      pairs.get(key).seq = Math.min(pairs.get(key).seq, +o.id.slice(2));
    }
    return [...pairs.values()].sort((a, b) => a.seq - b.seq);
  }
  check_merge(m) {
    const q = this.quoteOnly(m.root); if (q) return q;
    if (!this.exitAllowed(m.account)) return 'Account ' + m.account + ' is not allowed to trade.';
    const pos = this.pos(m.account, m.root).qty;
    if (!pos) return 'Nothing to merge: ' + m.account + ' is flat on ' + m.root + '.';
    for (const o of this.orders.values()) if (isWorking(o) && o.account === m.account && o.root === m.root && (o.role === 'entry' || (o.role === 'other' && (o.side === 'buy') === (pos > 0))))
      return 'Merge is refused while an entry is working on ' + m.account + ' ' + m.root + '.';
    if (this.now() - (this.lastFillAt || 0) < 2000 && this.lastFillKey === m.account + '|' + m.root) return 'Merge is refused while the position is changing; try again in a moment.';
    const pairs = this.pairsOf(m.account, m.root);
    if (pairs.length < 2) return 'Nothing to merge: the position has ' + pairs.length + ' stop and target pair(s).';
    const stops = pairs.reduce((s, p) => s + (p.stop ? p.stop.qty - p.stop.filled : 0), 0);
    if (stops !== Math.abs(pos)) return 'Merge is refused: the working stops cover ' + stops + ' of ' + Math.abs(pos) + ' contracts; let the legs check settle first.';
    const first = pairs[0].stop, last = this.last[m.root];
    if (!first) return 'Merge is refused: the first leg has no stop.';
    if (pos > 0 ? first.price >= last : first.price <= last) return 'Merge is refused: the first leg\'s stop ' + fmt(first.price) + ' is already through the market (last ' + fmt(last) + ').';
    return null;
  }
  do_merge(m, conn, failAt) {
    const pos = this.pos(m.account, m.root).qty, size = Math.abs(pos), pairs = this.pairsOf(m.account, m.root), dir = pos > 0 ? 1 : -1;
    const firstEntry = this.orders.get(pairs[0].stop.parent), strat = firstEntry && firstEntry.strategy, tg = strat ? targetsOf(strat) : [];
    const rec = strat && this.managed.get(firstEntry.id), firstFill = rec && rec.pairs.length ? rec.pairs[0].fill : null, tick = this.instruments[m.root].tick;
    // a strategy's targets at the FIRST leg's prices (its fill plus each target's ticks), the whole position allocated over the shares
    const targets = tg.length > 1 && firstFill !== null
      ? allocate(size, tg.map(t => t.share)).map((q, i) => ({ price: +(firstFill + dir * tg[i].ticks * tick).toFixed(10), qty: q })).filter(t => t.qty > 0)
      : pairs[0].target ? [{ price: pairs[0].target.price, qty: size }] : [];
    const stopPx = pairs[0].stop.price, before = pairs.length, done = (result, text, stop, tg) => {
      this.merges[result === 'merged' ? 'ok' : result]++; this.merges.lastAtUtcMs = this.now();
      this.logLine('merges', m.account, m.root + ' ' + result + ': ' + text);
      this.broadcastV3(Object.assign({ type: 'merge' }, m.cid ? { cid: m.cid } : {}, { account: m.account, root: m.root, result, stop, targets: tg, pairsBefore: before, text }));
    };
    if (failAt) {                                       // tests: a step not confirmed; the fake leaves the original brackets
      done('restored', 'The merge stopped (NinjaTrader did not confirm step ' + failAt + ' within 3 s); the original brackets are back', null, []);
      return;
    }
    const exit = pos > 0 ? 'sell' : 'buy';
    if (!(tg.length > 1 && firstFill !== null)) {
      // one target (or none): keep the first pair and grow it, newest pair first
      const keep = pairs[0];
      for (const p of pairs.slice(1).reverse()) {
        const q = p.stop.qty - p.stop.filled;
        this.cancel(p.stop);                            // the OCO takes its target
        keep.stop.qty += q; this.emitOrder(keep.stop);
        if (keep.target) { keep.target.qty += q; this.emitOrder(keep.target); }
      }
      done('merged', 'Merged ' + before + ' pairs into one stop for ' + size + ' contract(s) at ' + fmt(stopPx), { price: stopPx, qty: size }, keep.target ? [{ price: keep.target.price, qty: size }] : []);
      return;
    }
    // two or three targets: a new stop S with no OCO, grown as each pair goes (newest first), then the targets
    let S = null;
    for (const p of pairs.slice().reverse()) {
      const q = p.stop.qty - p.stop.filled;
      this.cancel(p.stop);
      if (!S) { S = this.newOrder({ cid: null, account: m.account, root: m.root, side: exit, kind: 'stop', qty: q, price: stopPx, role: 'stop', oco: null, parent: firstEntry.id, by: 'merge' }); }
      else S.qty += q;
      this.emitOrder(S);
    }
    const tids = targets.map((t, i) => { const o = this.newOrder({ cid: null, account: m.account, root: m.root, side: exit, kind: 'limit', qty: t.qty, price: t.price, role: 'target', oco: null, parent: firstEntry.id, by: 'merge', bucket: i + 1 }); this.emitOrder(o); return o.id; });
    this.mergedSets.set(m.account + '|' + m.root, { stopId: S.id, targetIds: tids });
    done('merged', 'Merged ' + before + ' pairs into one stop for ' + size + ' contract(s) at ' + fmt(stopPx) + ' and ' + targets.length + ' targets', { price: stopPx, qty: size }, targets);
  }
  /** a merged multi-target set: a target fill shrinks S to the position; S filling cancels the targets */
  mergedUpkeep(o, ms) {
    const S = this.orders.get(ms.stopId), pos = Math.abs(this.pos(o.account, o.root).qty);
    if (o.id === ms.stopId || !pos) { for (const id of ms.targetIds) { const t = this.orders.get(id); if (t) this.cancelOne(t); } this.mergedSets.delete(o.account + '|' + o.root); return; }
    if (ms.targetIds.includes(o.id) && S && isWorking(S) && S.qty - S.filled > pos) { S.qty = S.filled + pos; this.emitOrder(S); }
  }

  /* ---------------- the copier (PROTOCOL.md "Copier engine"), Sim followers only */
  followerRoot(leaderRoot, size) {
    const fam = { NQ: ['MNQ', 'NQ'], MNQ: ['MNQ', 'NQ'], ES: ['MES', 'ES'], MES: ['MES', 'ES'] }[leaderRoot];
    return fam ? fam[size === 'micro' ? 0 : 1] : null;
  }
  copierMsg() {
    const c = this.copier, la = this.acct.get(c.leader);
    const lpos = c.leader ? [...this.positions].find(([k, p]) => k.startsWith(c.leader + '|') && p.qty) : null;
    return { type: 'copier', enabled: this.sw.copier, simOnly: true, armed: c.armed, standDownWhy: c.standDownWhy,
      leader: c.leader ? { account: c.leader, connection: la ? la.connection : 'disconnected', position: lpos ? { root: lpos[0].split('|')[1], qty: lpos[1].qty, avgPrice: lpos[1].avgPrice } : null } : null,
      mode: c.mode,
      followers: [...c.followers.values()].map(f => {
        const a = this.acct.get(f.account), root = f.root || this.followerRoot('MNQ', f.size), p = this.pos(f.account, root);
        return { account: f.account, sim: !!(a && a.sim), on: f.on, qty: f.qty, size: f.size, root, position: { qty: p.qty, avgPrice: p.qty ? p.avgPrice : null },
          lastAction: f.lastAction || null, lastAt: f.lastAt || null, slippageTicks: f.slippageTicks === undefined ? null : f.slippageTicks, skipped: f.skipped || null,
          lossLimit: f.lossLimit, pnlToday: a ? this.pnl(f.account).today : 0, connection: a ? a.connection : 'disconnected' };
      }) };
  }
  copierEvent(e) {
    this.copier.decisions++; if (e.action === 'skip') this.copier.skipped++;
    if (e.leaderMs != null) this.copier.leaderMs.push(e.leaderMs);
    const msg = Object.assign({ type: 'copierEvent', at: this.now(), account: null, action: null, root: null, qty: null, price: null, slippageTicks: null, leaderMs: null, fillMs: null, text: '' }, e);
    this.logLine('copier', msg.account || '-', msg.action + ': ' + msg.text);
    this.broadcastV3(msg);
  }
  check_copierGet() { return null; }
  do_copierGet(m, conn) { this.send(conn, this.copierMsg()); }
  check_copierSet(m) {
    if (m.leader === undefined && m.mode === undefined) return 'copierSet needs leader or mode.';
    if (m.mode !== undefined && m.mode !== 'executions' && m.mode !== 'orders') return 'mode must be executions or orders.';
    if (m.leader !== undefined && !this.watched(m.leader)) return 'No account ' + m.leader + '.';
    if (m.leader !== undefined && this.copier.followers.has(m.leader)) return m.leader + ' is a follower; the leader cannot be one.';
    const L = this.copier.leader;
    if (L && [...this.positions].some(([k, p]) => k.startsWith(L + '|') && p.qty)) return 'The copier cannot change while the leader ' + L + ' has a position.';
    return null;
  }
  do_copierSet(m) { if (m.leader !== undefined) this.copier.leader = m.leader; if (m.mode !== undefined) this.copier.mode = m.mode; this.broadcastV3(this.copierMsg()); }
  check_copierFollower(m) {
    for (const k of ['account', 'on', 'qty', 'size', 'lossLimit']) if (m[k] === undefined) return 'copierFollower needs ' + k + '.';
    const a = this.acct.get(m.account);
    if (!a || a.state === 'archived') return 'No account ' + m.account + '.';
    if (!a.sim) { this.logLine('copier', m.account, 'refused: not a Sim account'); return m.account + ' is not a Sim account: the copier copies to Sim accounts only.'; }
    if (m.account === this.copier.leader) return m.account + ' is the leader; it cannot be a follower.';
    if (!isInt(m.qty) || m.qty < 1 || m.qty > 9) return 'qty must be a whole number from 1 to 9.';
    if (m.size !== 'micro' && m.size !== 'mini') return 'size must be micro or mini.';
    if (m.lossLimit !== null && (!isInt(m.lossLimit) || m.lossLimit < 1)) return 'lossLimit must be whole dollars of 1 or more, or null for off.';
    return null;
  }
  do_copierFollower(m) {
    const f = this.copier.followers.get(m.account) || { account: m.account };
    Object.assign(f, { on: m.on, qty: m.qty, size: m.size, lossLimit: m.lossLimit, root: this.followerRoot('MNQ', m.size) });
    this.copier.followers.set(m.account, f);
    this.broadcastV3(this.copierMsg());
  }
  check_copierRearm() {
    if (!this.connected(this.copier.leader)) return 'The leader ' + this.copier.leader + ' is not connected.';
    const down = [...this.copier.followers.values()].filter(f => !this.connected(f.account)).length;
    if (down >= 3) return down + ' followers are not connected.';
    return null;
  }
  do_copierRearm() { this.copier.armed = true; this.copier.standDownWhy = null; this.copierEvent({ action: 'rearm', text: 'Re-armed by the page' }); this.broadcastV3(this.copierMsg()); }
  copierDrop(name) {
    if (!this.sw.copier) return;
    const c = this.copier, t = this.now();
    if (name !== c.leader && !c.followers.has(name)) return;
    c.drops = c.drops.filter(d => t - d.at < 10000 && d.name !== name).concat([{ name, at: t }]);
    const followersDown = c.drops.filter(d => d.name !== c.leader).length;
    if (c.armed && (name === c.leader || followersDown >= 3)) {
      c.armed = false; c.standDowns++;
      c.standDownWhy = name === c.leader ? 'the leader ' + name + ' left Connected' : followersDown + ' followers left Connected within 10 s';
      this.copierEvent({ action: 'standDown', text: c.standDownWhy + ': the copier stands down until Re-arm' });
      this.broadcastV3(this.copierMsg());
    }
  }
  /** a leader fill: entries from the page are copied (executions mode: market at once); exits always (flatten or reduce) */
  copierOnFill(o, qty, price, was) {
    const c = this.copier;
    if (o.account !== c.leader || o.copier) return;
    const now = this.pos(o.account, o.root).qty, t0 = this.now();
    if (o.role === 'entry' && o.fromPage !== false && o.cid && Math.abs(now) > Math.abs(was)) {
      if (!c.armed) { this.copierEvent({ action: 'skip', root: o.root, text: 'the copier is stood down: entry not copied' }); return; }
      for (const f of c.followers.values()) {
        if (!f.on) continue;
        const a = this.acct.get(f.account), root = this.followerRoot(o.root, f.size), fq = f.qty * qty;
        f.root = root;
        let why = !a || !a.sim ? 'not a Sim account' : !this.connected(f.account) ? 'not connected' : a.state !== 'active' ? 'gone' : !this.accounts.includes(f.account) ? 'not checked for trading'
          : f.lossLimit !== null && this.pnl(f.account).today <= -f.lossLimit ? 'loss limit' : this.exposure(f.account, root, o.side, fq) > this.capFor(root) ? 'position limit' : null;
        if (why) { f.skipped = why; f.lastAction = 'skip'; f.lastAt = this.now(); this.copierEvent({ action: why === 'not a Sim account' ? 'refused' : 'skip', account: f.account, root, qty: fq, text: 'skipped: ' + why }); continue; }
        f.skipped = null;
        const fo = this.newOrder({ cid: null, account: f.account, root, side: o.side, kind: 'market', qty: fq, price: null, role: 'entry', by: 'copier', copier: true, leaderEntry: o.id });
        this.emitOrder(fo); this.matchOne(fo, this.last[root], true);
        const tick = this.instruments[root].tick, slip = fo.avgFill === null ? null : Math.round((fo.avgFill - price) / tick) * (o.side === 'buy' ? 1 : -1);
        f.slippageTicks = slip; f.lastAction = 'enter'; f.lastAt = this.now();
        this.copierEvent({ action: 'enter', account: f.account, root, qty: fq, price: fo.avgFill, slippageTicks: slip, leaderMs: this.now() - t0, fillMs: 0, text: 'entered ' + fq + ' ' + root + ' at market on the leader\'s fill' });
        (f.pending = f.pending || []).push({ fo, leaderEntry: o.id });
      }
      this.copierAfterLeaderLegs(o);                     // the leader's legs for this increment are placed by now
      this.broadcastV3(this.copierMsg());
    } else if (Math.abs(now) < Math.abs(was)) {
      for (const f of c.followers.values()) {
        const root = f.root || this.followerRoot(o.root, f.size), p = this.pos(f.account, root);
        if (!p.qty) continue;                             // a flat follower gets nothing
        if (now === 0) { this.followerFlatten(f, root, 'the leader is flat'); continue; }
        const red = Math.min(Math.abs(p.qty), Math.max(1, Math.round(Math.abs(p.qty) * (Math.abs(was) - Math.abs(now)) / Math.abs(was))));
        if (red >= Math.abs(p.qty)) { this.followerFlatten(f, root, 'the leader scaled out'); continue; }
        const xo = this.newOrder({ cid: null, account: f.account, root, side: p.qty > 0 ? 'sell' : 'buy', kind: 'market', qty: red, price: null, role: 'other', by: 'copier', copier: true });
        this.emitOrder(xo); this.matchOne(xo, this.last[root], true);
        for (const s of this.orders.values()) if (isWorking(s) && s.copier && s.role === 'stop' && s.account === f.account && s.root === root && s.qty - s.filled > Math.abs(this.pos(f.account, root).qty)) { s.qty = s.filled + Math.abs(this.pos(f.account, root).qty); this.emitOrder(s); }
        f.lastAction = 'reduce'; f.lastAt = this.now();
        this.copierEvent({ action: 'reduce', account: f.account, root, qty: red, text: 'reduced by ' + red + ' (the leader\'s share)' });
      }
      this.broadcastV3(this.copierMsg());
    }
  }
  /** after the leader's legs for an increment: each follower's stop at the SAME PRICE as the leader's stop */
  copierAfterLeaderLegs(entry) {
    if (!this.sw.copier || entry.account !== this.copier.leader) return;
    const leaderStop = [...this.orders.values()].reverse().find(x => x.parent === entry.id && x.role === 'stop' && isWorking(x));
    for (const f of this.copier.followers.values()) {
      for (const pd of (f.pending || []).filter(x => x.leaderEntry === entry.id)) {
        if (!leaderStop || !pd.fo.filled) continue;
        const exit = pd.fo.side === 'buy' ? 'sell' : 'buy';
        const so = this.newOrder({ cid: null, account: f.account, root: pd.fo.root, side: exit, kind: 'stop', qty: pd.fo.filled, price: leaderStop.price, role: 'stop', by: 'copier', copier: true, leaderStop: leaderStop.id });
        this.emitOrder(so); this.matchOne(so, this.last[so.root], true);
        this.copierEvent({ action: 'stop', account: f.account, root: so.root, qty: so.qty, price: so.price, text: 'stop at the leader\'s stop price' });
      }
      f.pending = (f.pending || []).filter(x => x.leaderEntry !== entry.id);
    }
  }
  copierFollowStop(leaderStop) {
    if (!this.sw.copier || leaderStop.account !== this.copier.leader) return;
    for (const s of this.orders.values()) if (isWorking(s) && s.leaderStop === leaderStop.id && s.price !== leaderStop.price) {
      s.price = leaderStop.price; this.emitOrder(s);
      this.copierEvent({ action: 'move', account: s.account, root: s.root, price: s.price, text: 'stop moved with the leader\'s' });
    }
  }
  followerFlatten(f, root, why) {
    for (const o of [...this.orders.values()]) if (isWorking(o) && o.account === f.account && o.root === root) this.cancelOne(o);
    const p = this.pos(f.account, root);
    if (p.qty) { const xo = this.newOrder({ cid: null, account: f.account, root, side: p.qty > 0 ? 'sell' : 'buy', kind: 'market', qty: Math.abs(p.qty), price: null, role: 'other', by: 'copier', copier: true }); this.emitOrder(xo); this.matchOne(xo, this.last[root], true); }
    f.lastAction = 'flatten'; f.lastAt = this.now();
    this.copierEvent({ action: 'flatten', account: f.account, root, text: 'flattened: ' + why });
  }
  /** every second: copier orders left on a flat follower are cancelled */
  copierSweep() {
    for (const o of this.orders.values()) {
      if (!isWorking(o) || !o.copier || this.pos(o.account, o.root).qty) continue;
      if (o.role === 'entry' && o.leaderEntry && isWorking(this.orders.get(o.leaderEntry) || {})) continue;
      this.cancelOne(o);
      this.copierEvent({ action: 'sweep', account: o.account, root: o.root, text: 'cancelled a copier order left on a flat follower' });
    }
  }

  /* ---------------- the bot channel's rails (PROTOCOL.md "Bot channel") */
  botMsg() {
    const b = this.bot, p = this.pos('Sim101', this.botRoot);
    return { type: 'bot', enabled: this.sw.bot, connected: b.connected, name: b.name, mode: b.mode, account: 'Sim101', root: this.botRoot,
      position: { qty: b.position ? p.qty : 0, avgPrice: b.position && p.qty ? p.avgPrice : null }, pnlToday: +(b.pnl || 0).toFixed(2), trades: b.trades, maxTrades: b.maxTrades,
      losses: b.losses, maxLosses: b.maxLosses, maxQty: 1, killed: b.killed, standDown: b.standDown, lastBeatMs: b.connected ? (b.simulated ? 400 : this.now() - b.lastBeat) : null, lastSignal: b.lastSignal };   // the simulated bot never misses a beat
  }
  botStateMsg() { const b = this.bot; return { type: 'botState', mode: b.mode, killed: b.killed, standDown: b.standDown, trades: b.trades, losses: b.losses }; }
  botNotify() { this.broadcastV3(this.botMsg()); if (this.bot.conn) this.send(this.bot.conn, this.botStateMsg()); }
  botClosed(pts) {
    const b = this.bot; b.pnl = (b.pnl || 0) + pts * this.instruments[this.botRoot].pointValue;
    if (pts < 0) { b.losses++; if (b.losses >= b.maxLosses) b.standDown = b.maxLosses + ' losing trades today: no new bot entries until 18:00 ET'; }
    if (!this.pos('Sim101', this.botRoot).qty) b.position = false;
    this.botNotify();
  }
  check_botMode(m) {
    if (!['shadow', 'copilot', 'auto'].includes(m.mode)) return 'mode must be shadow, copilot or auto.';
    if (m.mode === 'auto' && !this.accounts.includes('Sim101')) return 'Auto needs Sim101 to be tradable.';
    return null;
  }
  do_botMode(m) { this.bot.mode = m.mode; this.botNotify(); }
  check_botKill() { return null; }
  do_botKill(m) { this.bot.killed = m.on; if (m.on) this.botQuiet('the kill switch'); this.botNotify(); }
  /** heartbeat lost or the kill switch: cancel unfilled bot entries, keep the position's stop and target, never flatten */
  botQuiet(why) {
    for (const o of [...this.orders.values()]) if (isWorking(o) && o.by === 'bot' && o.role === 'entry') this.cancelOne(o);
    this.broadcastV3({ type: 'status', level: 'warn', text: 'Bot: ' + why + ': its unfilled entries are cancelled; any bot position keeps its stop and target' });
  }
  check_botSeen(m) { const p = this.bot.proposals.get(m.id); if (!p) return 'No proposal ' + m.id + '.'; if (!isInt(m.at) || m.at < 1) return 'at must be page UTC ms.'; return null; }
  do_botSeen(m) { const p = this.bot.proposals.get(m.id); if (p.seenAt === null) { p.seenAt = m.at; this.broadcastV3(p); } }
  check_botAnswer(m) {
    const p = this.bot.proposals.get(m.id);
    if (!p) return 'No proposal ' + m.id + '.';
    if (p.state !== 'open') return 'Proposal ' + m.id + ' is ' + p.state + '.';
    if (m.answer !== 'accept' && m.answer !== 'reject') return 'answer must be accept or reject.';
    if (!isInt(m.at) || m.at < 1) return 'at must be page UTC ms.';
    return null;
  }
  do_botAnswer(m) {
    const p = this.bot.proposals.get(m.id);
    p.answeredAt = m.at; this.bot.stats.answered++;
    if (m.answer === 'reject') { p.state = 'rejected'; this.broadcastV3(p); this.botAnswerToBot(p.id, 'rejected', 'rejected by the page'); return; }
    const why = this.botPlace(p);                       // the ORDER comes from the proposal's parameters, never from the page
    p.state = why ? 'rejected' : 'accepted';
    this.broadcastV3(p);
    this.botAnswerToBot(p.id, why ? 'refused' : 'accepted', why || 'placed on Sim101');
    if (why) this.broadcastV3({ type: 'status', level: 'warn', text: 'Bot proposal ' + p.id + ' was accepted but refused: ' + why });
  }
  /* botRails as ChartBridge 0.4.0 built it (ChartBridgeBot.cs SetRails, PROTOCOL.md "The bot channel as built"): maxTrades
     1 to 5, maxLosses 1 to 3 (ChartBridge's own limits), root botRoot or its micro or mini sibling, all three required;
     refused while the bot has a position or a working entry; saved in bot-rails.txt, so a restart and a new day keep them */
  check_botRails(m) {
    const b = this.bot, root = typeof m.root === 'string' ? m.root.toUpperCase() : '', sib = BOT_SIBLING[this.botConfigRoot];
    if (!isInt(m.maxTrades) || m.maxTrades < 1 || m.maxTrades > 5) return 'maxTrades must be a whole number from 1 to 5';
    if (!isInt(m.maxLosses) || m.maxLosses < 1 || m.maxLosses > 3) return 'maxLosses must be a whole number from 1 to 3';
    if (root !== this.botConfigRoot && root !== sib) return 'root must be ' + this.botConfigRoot + (sib ? ' or ' + sib : '') + ' (botRoot and its micro/mini sibling)';
    if (!this.instruments[root] || this.instruments[root].quoteOnly) return 'instrument ' + root + ' is not traded by ChartBridge';
    if (b.position || [...this.orders.values()].some(o => isWorking(o) && o.by === 'bot' && o.role === 'entry')) return 'the bot has a position or a working entry: change its rails when it is flat';
    return null;
  }
  do_botRails(m) {
    const b = this.bot;
    b.maxTrades = m.maxTrades; b.maxLosses = m.maxLosses; this.botRoot = m.root.toUpperCase();
    if (b.losses >= b.maxLosses && !b.standDown) b.standDown = b.losses + ' losing trades today: no new bot entries until 18:00 ET';
    if (b.losses < b.maxLosses && b.standDown && /losing trades today/.test(b.standDown)) b.standDown = null;
    this.logLine('bot', 'Sim101', 'rails set by the page: ' + b.maxTrades + ' trades, ' + b.maxLosses + ' losing trades, ' + this.botRoot);
    if (b.conn) this.send(b.conn, this.welcomeMsg());   // so the bot knows its root and rails
    this.botNotify();
  }
  botAnswerToBot(id, answer, text) { if (this.bot.conn) this.send(this.bot.conn, { type: 'answer', id, answer, text }); }
  /** the rails, then every v2 gate; returns why it was refused or null */
  botPlace(s) {
    const b = this.bot;
    if (b.killed) return 'the kill switch is on';
    if (b.standDown) return b.standDown;
    if (b.trades >= b.maxTrades) return 'The bot has made ' + b.maxTrades + ' trades today (the limit).';
    if (!(s.stopTicks >= 1)) return 'every bot entry needs a stop';
    if (!this.config.trading) return 'Trading is off.';
    const m = { type: 'order', account: 'Sim101', root: this.botRoot, side: s.side, kind: s.kind, qty: 1, bracket: { stop: s.stopTicks, target: s.targetTicks || 0 } };
    if (s.kind !== 'market') m.price = s.price;
    const why = this.checkEntryAccount('Sim101') || (this.accounts.includes('Sim101') ? null : 'Sim101 is not allowed to trade.') || this.check_order(m);
    if (why) { b.stats.refused++; return why; }
    const o = this.newOrder({ cid: null, account: 'Sim101', root: this.botRoot, side: s.side, kind: s.kind, qty: 1, price: s.kind === 'market' ? null : s.price, role: 'entry', by: 'bot', botId: s.id });
    if (s.kind === 'market') o.bracket = { stop: s.stopTicks, target: s.targetTicks || 0 };
    else o.planned = { stopTicks: s.stopTicks, targetTicks: s.targetTicks || null };
    b.position = true; b.stats.placed++;
    this.emitOrder(o); this.matchOne(o, this.last[o.root], true);
    return null;
  }
  /** a bot message (the /bot WebSocket, or the fake's simulated bot); returns a reject reason or null */
  botMessage(m, text) {
    const b = this.bot;
    b.lastBeat = this.now();
    const keys = BOT_KEYS[m && m.type];
    if (!keys || (text !== undefined && /\\/.test(text))) return 'Unknown bot message.';
    for (const k of Object.keys(m)) if (!keys.includes(k)) return 'Unknown key "' + k + '" in ' + m.type + '.';
    if (m.type === 'beat') return null;
    if (m.type === 'botHello') { b.name = String(m.name || '').slice(0, 40); b.connected = true; if (b.conn) this.send(b.conn, this.welcomeMsg()); this.botNotify(); return null; }
    if (m.type === 'withdraw') {
      const p = b.proposals.get(m.id);
      if (p && p.state === 'open') { p.state = 'not answered'; b.stats.notAnswered++; this.broadcastV3(p); this.botAnswerToBot(p.id, 'not answered', 'withdrawn by the bot: ' + m.reason); this.logLine('bot', 'Sim101', m.id + ' not answered'); }
      for (const o of [...this.orders.values()]) if (isWorking(o) && o.by === 'bot' && o.botId === m.id && o.role === 'entry') this.cancelOne(o);
      return null;
    }
    if (m.type === 'flatten') { if (b.mode !== 'auto') return 'flatten is for auto mode only.'; this.do_flatten({ account: 'Sim101', root: this.botRoot }); return null; }
    // signal
    b.stats.signals++;
    const sig = { type: 'botSignal', id: m.id, at: this.now(), action: m.action, side: m.side || null, kind: m.kind || null, price: m.price === undefined ? null : m.price,
      stopTicks: m.stopTicks === undefined ? null : m.stopTicks, targetTicks: m.targetTicks === undefined ? null : m.targetTicks, reason: m.reason, result: 'skipped' };
    if (m.action === 'fired') {
      if (b.mode === 'shadow') sig.result = 'shadow';
      else if (b.mode === 'copilot') {
        sig.result = 'proposed'; b.stats.proposals++;
        b.proposals.set(m.id, { type: 'botProposal', id: m.id, at: sig.at, account: 'Sim101', root: this.botRoot, side: m.side, kind: m.kind, price: sig.price, qty: 1,
          stopTicks: m.stopTicks, targetTicks: sig.targetTicks, reason: m.reason, state: 'open', seenAt: null, answeredAt: null });
      } else { const why = this.botPlace(Object.assign({}, m)); sig.result = why ? 'refused: ' + why : 'placed'; if (why && b.conn) this.send(b.conn, { type: 'reject', id: m.id, reason: why }); }
    }
    b.lastSignal = sig; b.signals.push(sig); if (b.signals.length > 100) b.signals.shift();
    this.broadcastV3(sig);
    if (b.proposals.has(m.id) && sig.result === 'proposed') this.broadcastV3(b.proposals.get(m.id));
    this.botNotify();
    return null;
  }
  welcomeMsg() {
    /* as ChartBridgeBot.cs WelcomeJson builds it: the bot's own root only */
    const i = this.instruments[this.botRoot];
    return { type: 'welcome', version: '0.4.0', mode: this.bot.mode, account: 'Sim101', root: this.botRoot, rails: { maxQty: 1, maxTrades: this.bot.maxTrades, maxLosses: this.bot.maxLosses },
      instruments: i ? [{ root: this.botRoot, name: i.name, tick: i.tick, pointValue: i.pointValue, quoteOnly: false }] : [] };
  }
  /** every second: the heartbeat (5 s), the copier's sweep, Gone */
  everySecond() {
    this.checkGone();
    if (this.sw.copier) this.copierSweep();
    const b = this.bot;
    if (this.sw.bot && b.connected && !b.simulated && this.now() - b.lastBeat > 5000) {
      b.connected = false; b.stats.heartbeatLost++;
      this.botQuiet('no heartbeat for 5 s');
      this.botNotify();
    }
  }
  diag() {
    const med = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
    return { merges: this.merges, copier: { decisions: this.copier.decisions, skipped: this.copier.skipped, standDowns: this.copier.standDowns, leaderMsMedian: med(this.copier.leaderMs) }, bot: this.bot.stats };
  }
}

/* ---------------- tape timing counters, as ChartBridge 0.4.0 built them (PROTOCOL.md "/diag additions", `tape`): per root
   this session's 15-minute slots (from 18:00 ET) and the last session's; medians and p95 read from fixed log buckets (each
   about 41 percent wider than the last; the value is the bucket's upper edge), `max` exact; shares of the prints. */
const SLOTS = 96, NB = 40;
/** bucket 0 holds values below `unit` (and 0, negatives); bucket k holds [unit * 2^((k-1)/2), unit * 2^(k/2)) */
export function bucketOf(v, unit = 1, count = NB) {
  if (!(v >= unit)) return 0;
  const k = 1 + Math.floor(2 * Math.log2(v / unit));
  return k < count - 1 ? k : count - 1;
}
/** the upper edge of the bucket holding quantile q, or null when empty */
export function quantile(counts, q, unit = 1) {
  const n = counts.reduce((a, b) => a + b, 0); if (!n) return null;
  let want = Math.ceil(q * n), k = 0;
  for (; k < counts.length; k++) { want -= counts[k]; if (want <= 0) break; }
  return +(unit * Math.pow(2, k / 2)).toFixed(3);
}
const p2 = n => String(n).padStart(2, '0');
const etText = (et, withDay) => { const d = new Date(et * 1000); return (withDay ? d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' : '') + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()); };
/** the session start (18:00 ET, bar-time seconds) of a trade at bar time t */
export const sessionStart = t => { const day = Math.floor(t / 86400) * 86400; return t - day >= 64800 ? day + 64800 : day - 86400 + 64800; };
function newSession(start) {
  const z = () => new Array(SLOTS).fill(0);
  return { start, prints: z(), pairs: z(), peak: z(), secAt: z(), secN: z(), sameU: z(), sameRx: z(), j: [z(), z(), z(), z()], gap: Array.from({ length: SLOTS }, () => new Array(NB).fill(0)),
    gapMax: z(), delay: Array.from({ length: SLOTS }, () => new Array(NB).fill(0)), neg: z() };
}
function sessionJson(s) {
  if (!s) return null;
  const slots = []; let prints = 0;
  for (let k = 0; k < SLOTS; k++) {
    const n = s.prints[k]; if (n <= 0) continue;
    prints += n;
    const pairs = s.pairs[k], jumps = s.j[0][k] + s.j[1][k] + s.j[2][k] + s.j[3][k], share = (a, b) => b > 0 ? +(a / b).toFixed(3) : null;
    slots.push({ at: etText(s.start + k * 900), prints: n, perSec: +(n / 900).toFixed(3), peakPerSec: s.peak[k],
      gapMs: { p50: quantile(s.gap[k], 0.5), p95: quantile(s.gap[k], 0.95), max: pairs > 0 ? s.gapMax[k] : null },
      sameMsU: share(s.sameU[k], pairs), sameMsRx: share(s.sameRx[k], pairs),
      jumpTicks: { 0: share(s.j[0][k], jumps), 1: share(s.j[1][k], jumps), 2: share(s.j[2][k], jumps), '3+': share(s.j[3][k], jumps) },
      delayMs: { p50: quantile(s.delay[k], 0.5), p95: quantile(s.delay[k], 0.95), below0: s.neg[k] } });
  }
  return { from: etText(s.start, true), slots, prints };
}
export class TapeStats {
  constructor() { this.roots = {}; this.failed = 0; }
  /** one live trade: t bar time (s), p price, u NinjaTrader's time (UTC ms), rx ChartBridge's receipt (UTC ms) */
  add(root, t, p, u, rx, tick) {
    try {
      const r = this.roots[root] = this.roots[root] || { late: 0, cur: null, last: null, prev: null };
      const start = sessionStart(t);
      if (r.cur && start < r.cur.start) { r.late++; return; }
      if (!r.cur || start > r.cur.start) { r.last = r.cur; r.cur = newSession(start); r.prev = null; }
      const s = r.cur, k = Math.min(SLOTS - 1, Math.floor((t - start) / 900)), sec = Math.floor(t);
      s.prints[k]++;
      if (s.secAt[k] !== sec) { s.secAt[k] = sec; s.secN[k] = 0; }
      s.peak[k] = Math.max(s.peak[k], ++s.secN[k]);
      const d = rx - u;
      if (d < 0) s.neg[k]++; else s.delay[k][bucketOf(d)]++;
      if (r.prev) {
        const gap = Math.max(0, u - r.prev.u);
        s.pairs[k]++; s.gap[k][bucketOf(gap)]++; s.gapMax[k] = Math.max(s.gapMax[k], gap);
        if (Math.floor(u) === Math.floor(r.prev.u)) s.sameU[k]++;
        if (Math.floor(rx) === Math.floor(r.prev.rx)) s.sameRx[k]++;
        const jt = Math.round(Math.abs(p - r.prev.p) / tick); s.j[Math.min(3, jt)][k]++;
      }
      r.prev = { u, rx, p };
    } catch (e) { this.failed++; }
  }
  diag() {
    const roots = {};
    for (const root of Object.keys(this.roots).sort()) { const r = this.roots[root]; roots[root] = { late: r.late, session: sessionJson(r.cur), last: sessionJson(r.last) }; }
    return { failed: this.failed, roots };
  }
}
