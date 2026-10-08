// Reference behaviour for ChartBridge protocol v3 (0.4.0): nt8/PROTOCOL.md, "Protocol v3 (ChartBridge 0.4.0)".
// The fake bridge runs it with --v3 (test/fake-bridge.mjs); test/fake-v3.test.js checks it. Everything is simulated:
// made-up accounts (Sim101, EVAL-A, EVAL-B, FUNDED-C, SIM-F1, SIM-F2), a made-up bot, sample prices; nothing reaches a
// broker. OrderDeskV3 extends the v2 OrderDesk (test/fake-orders.mjs, unchanged) with: account checkmarks and Gone,
// stop-limit and MIT, Order Strategies (allocation, a pair per target bucket per fill, breakeven, trailing), Merge,
// cancel from the Working orders tab, quote-only roots, the copier, the bot channel's rails and (ChartBridge 0.5.0, contract
// AGENT_CHANNEL v1, chart 1.17.0) the agent channel: any number of agents, each with its own rules and account, the owner lock,
// proposals that live until the plan's own expiry; the agent in the tests is the made-up "Demo Agent" (id demo). Anthony 2026-10-07: no switches
// (every v3 switch on unless options.switches names it false, as config.txt's off line), no Sim locks (a real follower is copied
// through every gate; the bot trades the account chosen with botAccount, Sim101 by default, Sim or LIVE).
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
  botAccount: ['type', 'cid', 'account'],                          // Anthony 2026-10-07: the bot's account (ChartBridgeBot.cs SetAccount)
  // ChartBridge 0.5.0, the agent channel (contract AGENT_CHANNEL v1, section 7): flat keys only
  agentMode: ['type', 'cid', 'agent', 'mode'],
  agentKill: ['type', 'cid', 'agent', 'on'],
  agentSeen: ['type', 'agent', 'id', 'at'],
  agentAnswer: ['type', 'cid', 'agent', 'id', 'answer', 'at'],
  agentAccount: ['type', 'cid', 'agent', 'account'],
  agentRules: ['type', 'cid', 'agent', 'roots', 'maxQtyNQ', 'maxQtyMNQ', 'maxQtyES', 'maxQtyMES', 'entryFrom', 'entryUntil', 'flatAt', 'maxExpireSec', 'maxTrades', 'maxLosses'],
});
export const STRATEGY_KEYS = ['name', 'stop', 'stopLimit', 't1', 't1Share', 't2', 't2Share', 't3', 't3Share', 'beAfter', 'bePlus', 'trailAfter', 'trailBy', 'trailStep'];
export const BOOL_KEYS = { accountTrade: ['on'], accountArchive: ['confirm'], copierFollower: ['on'], botKill: ['on'], agentKill: ['on'] };
export const BOT_KEYS = {
  botHello: ['type', 'name'], beat: ['type'], withdraw: ['type', 'id', 'reason'], flatten: ['type'],
  signal: ['type', 'id', 'action', 'side', 'kind', 'price', 'stopTicks', 'targetTicks', 'reason'],
};
export const AGENT_PAGE_TYPES = ['agentMode', 'agentKill', 'agentSeen', 'agentAnswer', 'agentAccount', 'agentRules'];
const V3_TYPES = ['accountTrade', 'accountArchive', 'merge', 'copierGet', 'copierSet', 'copierFollower', 'copierRearm', 'botMode', 'botKill', 'botSeen', 'botAnswer', 'botRails', 'botAccount'].concat(AGENT_PAGE_TYPES);
const SWITCH_OF = { accountTrade: 'accountChecks', accountArchive: null, merge: 'merge', copierGet: 'copier', copierSet: 'copier', copierFollower: 'copier', copierRearm: 'copier', botMode: 'bot', botKill: 'bot', botSeen: 'bot', botAnswer: 'bot', botRails: 'bot', botAccount: 'bot' };

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
  /** extra options: switches {accountChecks, ...} (each on unless false: config.txt's off line), accountList [{name, sim,
   *  balance}], quoteRoots [roots], botRoot, graceMs (Gone after this long, default 10000), ownOrigin. */
  constructor(o) {
    super(o);
    this.sw = Object.fromEntries(SWITCHES.map(k => [k, !(o.switches && o.switches[k] === false)]));   // Anthony 2026-10-07: on by default
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
    this.botAccount = 'Sim101';                  // the bot's account (botAccount; bot-account.txt), Sim101 until Anthony chooses another
    this.bot = { connected: false, simulated: false, name: null, mode: 'shadow', killed: false, standDown: null, trades: 0, losses: 0, lastBeat: 0, lastSignal: null, conn: null, maxTrades: 5, maxLosses: 3,
      proposals: new Map(), signals: [], stats: { signals: 0, proposals: 0, answered: 0, notAnswered: 0, placed: 0, refused: 0, heartbeatLost: 0 } };
    this.agentsInit(o);
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
    if (connection === 'connected' && a.state === 'gone') {   // 0.4.2: back with whatever checkmark it had
      a.state = 'active'; a.goneWhy = null; a.goneSince = null; this.logLine('accounts', name, 'active again: ' + (a.trade ? 'checked: entries are taken again' : 'not checked for trading'));
      this.broadcastV3({ type: 'status', level: 'info', text: name + ' is back (connected): ' + (a.trade ? 'its checkmark is kept, entries are taken again' : 'it is not checked for trading') });
    }
    if (connection !== 'connected') this.copierDrop(name);
    this.refreshAccounts(); this.sendAccounts();
  }
  /** every second (and in tests): the 10 s grace, then Gone; the checkmark is kept and NinjaTrader's drawdown never counts (0.4.2) */
  checkGone() {
    const t = this.now();
    for (const a of this.acct.values()) {
      if (a.state !== 'active') continue;
      const why = a.connection !== 'connected' ? (a.connection === 'disabled' ? 'disabled' : 'disconnected') : null;
      if (!why) { a.badSince = null; continue; }
      if (a.badSince == null) a.badSince = a.since;   // the grace runs from the connection change
      if (t - a.badSince < this.graceMs) continue;
      a.state = 'gone'; a.goneWhy = why; a.goneSince = t;   // the checkmark is kept (0.4.2)
      this.logLine('accounts', a.name, 'gone: ' + why + (a.trade ? '; the checkmark is kept: entries wait until it is back' : ''));
      this.broadcastV3({ type: 'status', level: 'warn', text: a.name + ' is gone (' + why + ' for ' + Math.round(this.graceMs / 1000) + ' s): entries wait until it is back' + (a.trade ? '; its checkmark is kept' : '') });
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
    this.agentsOnAuth(conn);                     // 0.5.0: every agent's state, its open proposals, last 200 notes and 50 plans
  }
  orderMsg(o, v3) {
    const m = super.orderMsg(o);
    if (o.kind === 'stopLimit' && o.limitPrice !== undefined) m.limitPrice = o.limitPrice;
    /* as ChartBridge 0.4.0 built it: `by` for a strategy's entry and legs (ChartBridgeStrategies.cs V3OrderFields, every
       page while strategies is on); review 2: on a v3 page only, `by: "bot"` for a bot entry and the legs the bot channel
       follows, `by: "copier"` for an order the copier placed on a follower (ChartBridgeV3.OrderBy via ChartBridgeAccounts.ForPage;
       an order that already says `by` keeps it). Merge marks nothing. `tradable` to a v3 page only. */
    if (o.by === 'strategy') m.by = o.by;
    else if (v3 && this.agentOfOrder(o)) m.by = 'agent:' + this.agentOfOrder(o);   // 0.5.0: an agent's entry and its legs
    else if (v3 && this.isBotOrder(o)) m.by = 'bot';
    else if (v3 && (o.copier || o.by === 'copier')) m.by = 'copier';
    if (o.bucket && o.by === 'strategy') m.bucket = o.bucket;
    if (v3) m.tradable = this.accounts.includes(o.account);
    return m;
  }
  emitOrder(o) {
    if (!this.instruments[o.root] || this.instruments[o.root].quoteOnly) return;
    const msg = this.orderMsg(o), msg3 = this.orderMsg(o, true);
    for (const c of this.conns()) if (c.authed && this.visible(o.account, c)) this.send(c, c.v3 ? msg3 : msg);
    if (this.bot.conn && this.isBotOrder(o)) this.send(this.bot.conn, msg);     // the bot sees its own orders only
    const ag = this.agentOfOrder(o), a = ag ? this.agents.get(ag) : null;
    if (a && a.conn) this.send(a.conn, msg);                                     // an agent sees its own orders only
  }
  isBotOrder(o) { return o.by === 'bot' || (o.parent && (this.orders.get(o.parent) || {}).by === 'bot'); }

  /* ---------------- page to server */
  handle(conn, m, text) {
    const ref = {};
    if (typeof m.cid === 'string') ref.cid = m.cid;
    if (typeof m.id === 'string') ref.id = m.id;
    if (m.type === 'botSeen') { const why = this.blocked(conn) || checkKeysV3(m, text) || this.check_botSeen(m); if (why) this.send(conn, Object.assign({ type: 'reject' }, ref, { reason: why })); else this.do_botSeen(m); return !why; }
    let why = this.checkAction(conn) || checkKeysV3(m, text);
    if (!why && V3_TYPES.includes(m.type) && SWITCH_OF[m.type] && !this.sw[SWITCH_OF[m.type]]) why = m.type + ' is off (' + SWITCH_OF[m.type] + ' = off in config.txt).';
    if (!why && m.type === 'accountArchive' && !this.sw.accountChecks) why = 'accountArchive is off (accountChecks = off in config.txt).';
    if (!why && AGENT_PAGE_TYPES.includes(m.type)) why = this.agentPageCheck(m);
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
      return a.state === 'gone' ? account + ' is gone: entries wait until it is back (its checkmark is kept).' : a.connection !== 'connected' ? account + ' is not connected.' : account + ' is not checked for trading (the Accounts tab).';
    }
    return null;
  }
  check_order(m) {
    const q = this.quoteOnly(m.root); if (q) return q;
    const e = this.checkEntryAccount(m.account); if (e) return e;
    const lock = this.agentLockFor(m.account, m.root, 'page', m.side, m.qty); if (lock) return lock;   // 0.5.0: the owner lock (section 6)
    if ((m.kind === 'stopLimit' || m.kind === 'mit') && !this.sw.orderTypes) return 'Stop-limit and MIT orders are off (orderTypes = off in config.txt).';
    if (m.strategy !== undefined && !this.sw.strategies) return 'Order Strategies are off (strategies = off in config.txt).';
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
    if (m.from === 'list' && !this.sw.cancelFromList) return 'Cancel from the Working orders tab is off (cancelFromList = off in config.txt).';
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
    if (a.state === 'gone') return a.name + ' is gone (' + a.goneWhy + '); it can be checked once it is back.';
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
    this.agentBeforeFill(o, qty, price);         // 0.5.0: an agent's trade, its realized dollars
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
    this.agentAfterFill(o, qty, price);
  }
  isBotPosition(o) { return o.account === this.botAccount && o.root === this.botRoot && this.bot.position; }
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

  /* ---------------- the copier (PROTOCOL.md "Copier engine"): Sim or real followers, every account gate (no Sim lock) */
  followerRoot(leaderRoot, size) {
    const fam = { NQ: ['MNQ', 'NQ'], MNQ: ['MNQ', 'NQ'], ES: ['MES', 'ES'], MES: ['MES', 'ES'] }[leaderRoot];
    return fam ? fam[size === 'micro' ? 0 : 1] : null;
  }
  copierMsg() {
    const c = this.copier, la = this.acct.get(c.leader);
    const lpos = c.leader ? [...this.positions].find(([k, p]) => k.startsWith(c.leader + '|') && p.qty) : null;
    return { type: 'copier', enabled: this.sw.copier, simOnly: false, armed: c.armed, standDownWhy: c.standDownWhy,
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
    if (m.leader !== undefined && m.leader !== null && !this.watched(m.leader)) return 'No account ' + m.leader + '.';   // 0.4.3: null is no leader
    if (m.leader !== undefined && m.leader !== null && this.copier.followers.has(m.leader)) return m.leader + ' is a follower; the leader cannot be one.';
    if (m.leader !== undefined && m.leader !== null && this.agentOfAccount(m.leader)) return m.leader + ' is agent ' + this.agentOfAccount(m.leader).id + '\'s account: it cannot be the copier\'s leader.';
    const L = this.copier.leader;
    if (L && [...this.positions].some(([k, p]) => k.startsWith(L + '|') && p.qty)) return 'The copier cannot change while the leader ' + L + ' has a position.';
    return null;
  }
  do_copierSet(m) {
    if (m.leader !== undefined) this.copier.leader = m.leader;
    if (m.leader === null) { this.copier.armed = false; this.copier.standDownWhy = 'No leader is set.'; }   // 0.4.3: no leader: stood down
    if (m.mode !== undefined) this.copier.mode = m.mode;
    this.broadcastV3(this.copierMsg());
  }
  check_copierFollower(m) {
    for (const k of ['account', 'on', 'qty', 'size', 'lossLimit']) if (m[k] === undefined) return 'copierFollower needs ' + k + '.';
    const a = this.acct.get(m.account);
    if (!a || a.state === 'archived') return 'No account ' + m.account + '.';
    { const ag = this.agentOfAccount(m.account); if (ag) return m.account + ' is agent ' + ag.id + '\'s account: it cannot be a copier follower.'; }   // 0.5.0, section 6
    if (m.on === true && this.sw.bot && m.account === this.botAccount) return m.account + ' is the bot\'s account: it cannot be a copier follower while the bot trades it (choose another account for the bot on the Bot tab first).';
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
        // 0.4.3 (Anthony 2026-10-07): a fixed quantity, once per leader entry, on its first fill (never per leader contract)
        o.copiedTo = o.copiedTo || new Set();
        if (o.copiedTo.has(f.account)) continue;
        o.copiedTo.add(f.account);
        const a = this.acct.get(f.account), root = this.followerRoot(o.root, f.size), fq = f.qty;
        f.root = root;
        let why = !a ? 'not connected' : this.sw.bot && f.account === this.botAccount ? 'bot account' : !this.connected(f.account) ? 'not connected' : a.state !== 'active' ? 'gone' : !this.accounts.includes(f.account) ? 'not checked for trading'
          : f.lossLimit !== null && this.pnl(f.account).today <= -f.lossLimit ? 'loss limit' : this.exposure(f.account, root, o.side, fq) > this.capFor(root) ? 'position limit' : null;
        if (why) { f.skipped = why; f.lastAction = 'skip'; f.lastAt = this.now(); this.copierEvent({ action: 'skip', account: f.account, root, qty: fq, text: 'skipped: ' + why }); continue; }
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
        // 0.4.3 (Anthony 2026-10-07): the same share, nearest contract (half up), no minimum cut
        const keep = Math.min(Math.abs(p.qty), Math.round(Math.abs(p.qty) * Math.abs(now) / Math.abs(was)));
        const red = Math.abs(p.qty) - keep;
        if (red <= 0) continue;                           // less than half a contract of its share: it keeps what it holds
        if (keep <= 0) { this.followerFlatten(f, root, 'the leader scaled out'); continue; }
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
    const b = this.bot, p = this.pos(this.botAccount, this.botRoot);
    return { type: 'bot', enabled: this.sw.bot, connected: b.connected, name: b.name, mode: b.mode, account: this.botAccount, sim: this.botSim(), root: this.botRoot,
      position: { qty: b.position ? p.qty : 0, avgPrice: b.position && p.qty ? p.avgPrice : null }, pnlToday: +(b.pnl || 0).toFixed(2), trades: b.trades, maxTrades: b.maxTrades,
      losses: b.losses, maxLosses: b.maxLosses, maxQty: 1, killed: b.killed, standDown: b.standDown, lastBeatMs: b.connected ? (b.simulated ? 400 : this.now() - b.lastBeat) : null, lastSignal: b.lastSignal };   // the simulated bot never misses a beat
  }
  botSim(name) { const a = this.acct.get(name || this.botAccount); return !!(a && a.sim); }
  botStateMsg() { const b = this.bot; return { type: 'botState', mode: b.mode, killed: b.killed, standDown: b.standDown, trades: b.trades, losses: b.losses }; }
  botNotify() { this.broadcastV3(this.botMsg()); if (this.bot.conn) this.send(this.bot.conn, this.botStateMsg()); }
  botClosed(pts) {
    const b = this.bot; b.pnl = (b.pnl || 0) + pts * this.instruments[this.botRoot].pointValue;
    if (pts < 0) { b.losses++; if (b.losses >= b.maxLosses) b.standDown = b.maxLosses + ' losing trades today: no new bot entries until 18:00 ET'; }
    if (!this.pos(this.botAccount, this.botRoot).qty) b.position = false;
    this.botNotify();
  }
  check_botMode(m) {
    if (!['shadow', 'copilot', 'auto'].includes(m.mode)) return 'mode must be shadow, copilot or auto.';
    if (m.mode === 'auto' && !this.accounts.includes(this.botAccount)) return 'auto refused: ' + this.botAccount + ' may not trade from the chart: the bot needs it tradable';
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
    const why = p.account !== this.botAccount ? 'the bot\'s account changed from ' + p.account + ' to ' + this.botAccount + ' after this proposal: nothing placed'
      : this.botPlace(p);                               // the ORDER comes from the proposal's parameters, never from the page
    p.state = why ? 'rejected' : 'accepted';
    this.broadcastV3(p);
    this.botAnswerToBot(p.id, why ? 'refused' : 'accepted', why || 'placed on ' + p.account);
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
    this.logLine('bot', this.botAccount, 'rails set by the page: ' + b.maxTrades + ' trades, ' + b.maxLosses + ' losing trades, ' + this.botRoot);
    if (b.conn) this.send(b.conn, this.welcomeMsg());   // so the bot knows its root and rails
    this.botNotify();
  }
  /* botAccount (Anthony 2026-10-07; ChartBridgeBot.cs SetAccount): the bot trades the account Anthony chooses, Sim or LIVE.
     Refused unless it passes the account gates now (watched, tradable, connected), while the copier uses it (a follower that is
     on, or the leader), and while the bot has a position or a working entry. Open proposals expire (they were for the old one). */
  check_botAccount(m) {
    const name = m.account, a = typeof name === 'string' ? this.acct.get(name) : null;
    if (typeof name !== 'string' || !name || name.trim() !== name) return 'account must be an account name';
    if (/^(Backtest|Playback)/i.test(name)) return name + ' is a Backtest or Playback account: the bot never trades one';
    const ag = this.agentOfAccount(name); if (ag) return name + ' is agent ' + ag.id + '\'s account: the bot trades an account of its own';   // 0.5.0, section 6
    if (!a || a.state === 'archived') return name + ' is not in NinjaTrader';
    if (!this.config.trading) return 'trading is off in config.txt';
    if (!this.accounts.includes(name)) return (this.checkEntryAccount(name) || name + ' may not trade from the chart (tradeAccounts in config.txt)') + ': the bot needs it tradable';
    if (!this.connected(name)) return name + ' is not connected';
    if (this.sw.copier && this.copier.leader === name) return name + ' is the copier\'s leader: the bot cannot trade the leader\'s account while the copier is on (its exits would be copied to the followers).';
    const f = this.copier.followers.get(name);
    if (this.sw.copier && f && f.on) return name + ' is a copier follower: the bot does not trade while the copier copies to its account (turn that follower off on the page).';
    if (this.bot.position || [...this.orders.values()].some(o => isWorking(o) && o.by === 'bot' && o.role === 'entry')) return 'the bot has a position or a working entry: choose its account when it is flat';
    return null;
  }
  do_botAccount(m) {
    const b = this.bot, old = this.botAccount;
    if (m.account === old) { this.botNotify(); return; }
    this.botAccount = m.account;
    for (const p of b.proposals.values()) if (p.state === 'open') { p.state = 'not answered'; b.stats.notAnswered++; this.broadcastV3(p); this.botAnswerToBot(p.id, 'not answered', 'the bot\'s account changed to ' + m.account); }
    this.logLine('bot', m.account, 'account ' + m.account + ' (' + (this.botSim() ? 'Sim' : 'LIVE') + '), was ' + old + ', set by the page');
    if (b.conn) this.send(b.conn, this.welcomeMsg());
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
    const acct = this.botAccount, f = this.copier.followers.get(acct);
    if (this.sw.copier && f && f.on) return acct + ' is a copier follower: the bot does not trade while the copier copies to its account (turn that follower off on the page).';
    const m = { type: 'order', account: acct, root: this.botRoot, side: s.side, kind: s.kind, qty: 1, bracket: { stop: s.stopTicks, target: s.targetTicks || 0 } };
    if (s.kind !== 'market') m.price = s.price;
    const why = this.checkEntryAccount(acct) || (this.accounts.includes(acct) ? null : acct + ' may not trade from the chart (tradeAccounts in config.txt)') || this.check_order(m);
    if (why) { b.stats.refused++; return why; }
    const o = this.newOrder({ cid: null, account: acct, root: this.botRoot, side: s.side, kind: s.kind, qty: 1, price: s.kind === 'market' ? null : s.price, role: 'entry', by: 'bot', botId: s.id });
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
      if (p && p.state === 'open') { p.state = 'not answered'; b.stats.notAnswered++; this.broadcastV3(p); this.botAnswerToBot(p.id, 'not answered', 'withdrawn by the bot: ' + m.reason); this.logLine('bot', this.botAccount, m.id + ' not answered'); }
      for (const o of [...this.orders.values()]) if (isWorking(o) && o.by === 'bot' && o.botId === m.id && o.role === 'entry') this.cancelOne(o);
      return null;
    }
    if (m.type === 'flatten') { if (b.mode !== 'auto') return 'flatten is for auto mode only.'; this.do_flatten({ account: this.botAccount, root: this.botRoot }); return null; }
    // signal
    b.stats.signals++;
    const sig = { type: 'botSignal', id: m.id, at: this.now(), action: m.action, side: m.side || null, kind: m.kind || null, price: m.price === undefined ? null : m.price,
      stopTicks: m.stopTicks === undefined ? null : m.stopTicks, targetTicks: m.targetTicks === undefined ? null : m.targetTicks, reason: m.reason, result: 'skipped' };
    if (m.action === 'fired') {
      if (b.mode === 'shadow') sig.result = 'shadow';
      else if (b.mode === 'copilot') {
        sig.result = 'proposed'; b.stats.proposals++;
        b.proposals.set(m.id, { type: 'botProposal', id: m.id, at: sig.at, account: this.botAccount, sim: this.botSim(), root: this.botRoot, side: m.side, kind: m.kind, price: sig.price, qty: 1,
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
    return { type: 'welcome', version: '0.4.0', mode: this.bot.mode, account: this.botAccount, sim: this.botSim(), root: this.botRoot, rails: { maxQty: 1, maxTrades: this.bot.maxTrades, maxLosses: this.bot.maxLosses },
      instruments: i ? [{ root: this.botRoot, name: i.name, tick: i.tick, pointValue: i.pointValue, quoteOnly: false }] : [] };
  }
  /** every second: the heartbeat (5 s), the copier's sweep, Gone */
  everySecond() {
    this.checkGone();
    this.agentsEverySecond();
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
    return Object.assign({ merges: this.merges, copier: { decisions: this.copier.decisions, skipped: this.copier.skipped, standDowns: this.copier.standDowns, leaderMsMedian: med(this.copier.leaderMs) }, bot: this.bot.stats },
      this.agents.size ? { agents: this.agentsDiag() } : {});
  }
}

/* ======================================================================== the agent channel (ChartBridge 0.5.0)
   Contract AGENT_CHANNEL v1 (docs/AGENT_TAB.md has the page's side). Any number of agents (`agents` in config.txt, here the
   option agents: ['demo']), each with its own account (agent-<id>-account.txt; no file: Sim101), its own rules
   (agent-<id>-rules.txt; no file: the defaults below, Manrae's), its own day. AI is never in the order path: the fake, as
   ChartBridge, places every agent entry itself from the plan's numbers, inside the agent's rules. Every start puts every
   agent in shadow. The agent here is made up ("Demo Agent", id demo); nothing reaches a broker. */
export const AGENT_KEYS = {
  agentHello: ['type', 'name', 'build'], beat: ['type'], subscribe: ['type', 'root', 'days', 'tickHours', 'sub'],
  plan: ['type', 'id', 'root', 'side', 'kind', 'price', 'limitPrice', 'qty', 'stopTicks', 'targetTicks', 'expireSec', 'riskDollars', 'setup', 'reason', 'confidence'],
  skip: ['type', 'id', 'setup', 'reason'], withdraw: ['type', 'id', 'reason'], note: ['type', 'kind', 'text'], flatten: ['type'],
};
/* the size ceiling (a ChartBridge constant: raising it is a code change and a review): minis 2, micros 20 */
export const AGENT_CEILING = { NQ: 2, ES: 2, MNQ: 20, MES: 20 };
export const AGENT_DEFAULT_RULES = { roots: ['NQ', 'MNQ'], maxQty: { NQ: 2, MNQ: 20 }, entryFrom: '09:45', entryUntil: '15:00', flatAt: '15:55', maxExpireSec: 1800, maxTrades: null, maxLosses: null };
export const AGENT_NOTE_KINDS = ['look', 'thinking', 'lesson', 'notebook', 'status'];
const AGENT_ID_RX = /^[a-z][a-z0-9]{0,11}$/;
const TIME_RX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const hhmm = t => +t.slice(0, 2) * 60 + +t.slice(3);
const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
/** minutes after midnight in New York of a UTC ms time */
export function nyMinutes(ms) { const o = {}; for (const x of NY.formatToParts(new Date(ms))) o[x.type] = x.value; return (+o.hour % 24) * 60 + +o.minute; }
const pad2 = n => String(n).padStart(2, '0');
const hm = m => pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);

/** The strict parser for an agent's message (gate 8 as the contract says it): one flat object, no unknown or duplicate keys,
 *  plain strings (no backslash, no control characters) of at most 200 characters, except note.text (at most 1,000). */
export function checkAgentMessage(m, text) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'The message is not one JSON object.';
  if (text !== undefined && /\\/.test(text)) return 'The message has a backslash escape.';
  const keys = AGENT_KEYS[m.type];
  if (!keys) return 'Unknown message type ' + JSON.stringify(m.type) + '.';
  if (text !== undefined) { const seen = new Set(); for (const x of text.matchAll(/"([^"]*)"\s*:/g)) { if (seen.has(x[1])) return 'Key "' + x[1] + '" twice.'; seen.add(x[1]); } }
  for (const [k, v] of Object.entries(m)) {
    if (!keys.includes(k)) return 'Unknown key "' + k + '" in ' + m.type + '.';
    if (v !== null && typeof v === 'object') return 'The message has a nested object or list.';
    if (typeof v === 'boolean') return k + ' cannot be true or false.';
    if (typeof v === 'string' && (/[\u0000-\u001f\u007f]/.test(v) || v.length > (m.type === 'note' && k === 'text' ? 1000 : 200))) return k + ' is not a plain string of at most ' + (m.type === 'note' && k === 'text' ? '1,000' : '200') + ' characters.';
  }
  return null;
}

Object.assign(OrderDeskV3.prototype, {
  /** options: agents [ids] (config.txt `agents`), agentAccounts {id: account} (agent-<id>-account.txt), agentRules {id: rules},
   *  agentAnyTime (tests and smokes only: no entry window and no flat time, so they run at any hour). */
  agentsInit(o) {
    this.agents = new Map();
    this.agentAnyTime = !!o.agentAnyTime;
    for (const id of o.agents || []) {
      if (!AGENT_ID_RX.test(id) || this.agents.has(id)) continue;
      const r = (o.agentRules || {})[id] || AGENT_DEFAULT_RULES;
      this.agents.set(id, { id, name: null, build: null, connected: false, simulated: false, conn: null, mode: 'shadow', killed: false, standDown: null,
        trades: 0, losses: 0, pnl: 0, account: (o.agentAccounts || {})[id] || 'Sim101', rules: JSON.parse(JSON.stringify(r)), lastBeat: 0, lastPlan: null,
        plans: [], notes: [], planIds: new Set(), proposals: new Map(), trade: null, msgTimes: [], flattenedDay: null, flatWarnAt: 0,
        stats: { plans: 0, proposals: 0, placed: 0, refused: 0, heartbeatLost: 0, flattenedAt: null } });
    }
  },
  agentLogLine(a, what) { this.logLine('agent-' + a.id, a.account, what); },
  agentOfAccount(name) { for (const a of this.agents.values()) if (a.account === name) return a; return null; },
  /** the agent an order belongs to: its own mark, or its parent's (a leg) */
  agentOfOrder(o) { if (!o) return ''; if (o.agentId) return o.agentId; const p = o.parent ? this.orders.get(o.parent) : null; return p && p.agentId ? p.agentId : ''; },
  agentRootsOf(a) { return a.rules.roots.slice(); },
  agentSim(a) { const x = this.acct.get(a.account); return !!(x && x.sim); },
  agentWorkingEntries(a) { return [...this.orders.values()].filter(o => isWorking(o) && o.agentId === a.id && o.role === 'entry'); },
  agentOpenProposals(a) { return [...a.proposals.values()].filter(p => p.state === 'open'); },
  agentPosition(a) {
    if (!a.trade) return null;
    const p = this.pos(a.account, a.trade.root);
    return p.qty ? { root: a.trade.root, qty: p.qty, avgPrice: p.avgPrice } : null;
  },
  /** the owner of (account, root): 'agent:<id>', 'bot', 'copier', 'page', or null (flat, no entry working) */
  ownerOf(account, root) {
    for (const a of this.agents.values()) if (a.account === account && ((a.trade && a.trade.root === root && this.pos(account, root).qty) || this.agentWorkingEntries(a).some(o => o.root === root))) return 'agent:' + a.id;
    const entry = [...this.orders.values()].find(o => isWorking(o) && o.account === account && o.root === root && o.role === 'entry');
    if (entry) return entry.by === 'bot' ? 'bot' : entry.copier ? 'copier' : 'page';
    if (this.pos(account, root).qty) return 'page';
    return null;
  },
  agentOwns(a) { for (const r of new Set(this.agentRootsOf(a).concat(a.trade ? [a.trade.root] : []))) if (this.ownerOf(a.account, r) === 'agent:' + a.id) return true; return false; },
  /** the owner lock for a new entry (section 6): while an agent owns (account, root) every entry from another source is
   *  refused; a page order that only reduces the position is an exit and passes */
  agentLockFor(account, root, source, side, qty) {
    if (!this.agents || !this.agents.size) return null;
    const owner = this.ownerOf(account, root);
    if (!owner || !owner.startsWith('agent:') || owner === source) return null;
    const p = this.pos(account, root).qty;
    if (side && p && (side === 'buy') === (p < 0) && qty <= Math.abs(p)) return null;
    return account + ' ' + root + ' belongs to agent ' + owner.slice(6) + ' until it is flat';
  },
  agentRulesOut(a) { const r = a.rules; return { roots: r.roots.join(','), maxQty: Object.assign({}, r.maxQty), entryFrom: r.entryFrom, entryUntil: r.entryUntil, flatAt: r.flatAt, maxExpireSec: r.maxExpireSec, maxTrades: r.maxTrades, maxLosses: r.maxLosses }; },
  agentMsg(a) {
    return { type: 'agent', agent: a.id, name: a.name, build: a.build, enabled: true, connected: a.connected, mode: a.mode, account: a.account, sim: this.agentSim(a), rules: this.agentRulesOut(a),
      position: this.agentPosition(a), pnlToday: +a.pnl.toFixed(2), trades: a.trades, losses: a.losses, killed: a.killed, standDown: a.standDown, owns: this.agentOwns(a),
      lastBeatMs: a.connected ? (a.simulated ? 400 : this.now() - a.lastBeat) : null, lastPlan: a.lastPlan };
  },
  agentStateMsg(a) { return { type: 'agentState', mode: a.mode, killed: a.killed, standDown: a.standDown, trades: a.trades, losses: a.losses, pnlToday: +a.pnl.toFixed(2), owns: this.agentOwns(a) }; },
  agentWelcome(a) {
    return { type: 'welcome', version: '0.5.0', agent: a.id, mode: a.mode, account: a.account, sim: this.agentSim(a), rules: Object.assign(this.agentRulesOut(a), { roots: a.rules.roots.join(',') }),
      instruments: a.rules.roots.filter(r => this.instruments[r]).map(r => ({ root: r, name: this.instruments[r].name, tick: this.instruments[r].tick, pointValue: this.instruments[r].pointValue })) };
  },
  agentNotify(a) { this.broadcastV3(this.agentMsg(a)); if (a.conn) this.send(a.conn, this.agentStateMsg(a)); },
  agentToAgent(a, msg) { if (a.conn) this.send(a.conn, msg); },
  agentAnswer(a, id, answer, text) { this.agentToAgent(a, { type: 'answer', id, answer, text }); },
  /** a v3 page that signs in gets every agent's `agent`, its open proposals, its last 200 notes and last 50 plans */
  agentsOnAuth(conn) {
    if (!conn.v3 || !conn.authed) return;
    for (const a of this.agents.values()) {
      this.send(conn, this.agentMsg(a));
      for (const p of this.agentOpenProposals(a)) this.send(conn, p);
      for (const n of a.notes) this.send(conn, n);
      for (const p of a.plans) this.send(conn, p);
    }
  },
  /** once a second (the fake bridge): `agent` to the pages while connected */
  agentsBeat() { for (const a of this.agents.values()) if (a.connected) this.broadcastV3(this.agentMsg(a)); },
  agentsDiag() {
    const out = {};
    for (const a of this.agents.values()) out[a.id] = { connected: a.connected, mode: a.mode, killed: a.killed, plans: a.stats.plans, proposals: a.stats.proposals, placed: a.stats.placed,
      refused: a.stats.refused, heartbeatLost: a.stats.heartbeatLost, flattenedAt: a.stats.flattenedAt, secretFile: 'ok' };
    return out;
  },

  /* ---------------- page to server (section 7) */
  agentPageCheck(m) {
    if (!this.agents.size) return m.type + ' is refused: there are no agents on this ChartBridge (agents in config.txt).';
    if (typeof m.agent !== 'string' || !this.agents.has(m.agent)) return 'No agent ' + m.agent + '.';
    return null;
  },
  check_agentMode(m) {
    const a = this.agents.get(m.agent);
    if (!['shadow', 'copilot', 'auto'].includes(m.mode)) return 'mode must be shadow, copilot or auto.';
    if (m.mode === 'auto' && !(this.accounts.includes(a.account) && this.connected(a.account))) return 'auto refused: ' + a.account + ' is not tradable now (its checkmark, Connected): ' + a.id + ' needs it tradable';
    return null;
  },
  do_agentMode(m) {
    const a = this.agents.get(m.agent), was = a.mode;
    if (was === m.mode) { this.agentNotify(a); return; }
    if (was === 'copilot') this.agentExpireProposals(a, 'not answered', 'the mode left copilot');
    if (was === 'auto') this.agentCancelEntries(a, 'expired', 'the mode left auto');
    a.mode = m.mode;
    this.agentLogLine(a, 'mode ' + m.mode + ' (was ' + was + '), set by the page');
    this.agentToAgent(a, this.agentWelcome(a));
    this.agentNotify(a);
  },
  check_agentKill(m) { return typeof m.on === 'boolean' ? null : 'on must be true or false.'; },
  do_agentKill(m) {
    const a = this.agents.get(m.agent);
    a.killed = m.on;
    if (m.on) {
      this.agentCancelEntries(a, 'expired', 'the kill switch');
      this.agentExpireProposals(a, 'not answered', 'the kill switch');
      this.broadcastV3({ type: 'status', level: 'warn', text: 'Agent ' + a.id + ': the kill switch: its unfilled entries are cancelled; any position keeps its stop and target' });
    }
    this.agentLogLine(a, 'kill switch ' + (m.on ? 'on' : 'off') + ' by the page');
    this.agentNotify(a);
  },
  check_agentSeen(m) {
    const a = this.agents.get(m.agent), p = a.proposals.get(m.id);
    if (!p) return 'No proposal ' + m.id + ' from ' + a.id + '.';
    if (!isInt(m.at) || m.at < 1) return 'at must be page UTC ms.';
    return null;
  },
  do_agentSeen(m) { const a = this.agents.get(m.agent), p = a.proposals.get(m.id); if (p.seenAt === null) { p.seenAt = m.at; this.broadcastV3(p); } },
  check_agentAnswer(m) {
    const a = this.agents.get(m.agent), p = a.proposals.get(m.id);
    if (!p) return 'No proposal ' + m.id + ' from ' + a.id + '.';
    if (p.state !== 'open') return 'Proposal ' + m.id + ' is ' + p.state + '.';
    if (m.answer !== 'accept' && m.answer !== 'reject') return 'answer must be accept or reject.';
    if (!isInt(m.at) || m.at < 1) return 'at must be page UTC ms.';
    return null;
  },
  do_agentAnswer(m, conn) {
    const a = this.agents.get(m.agent), p = a.proposals.get(m.id);
    p.answeredAt = m.at;
    if (m.answer === 'reject') { p.state = 'rejected'; this.broadcastV3(p); this.agentAnswer(a, p.id, 'rejected', 'rejected by the page'); this.agentLogLine(a, p.id + ' rejected'); return; }
    const left = p.expiresAt - this.now();
    if (left < 5000) {                              // accepted with under 5 s left: refused as expired
      p.state = 'expired'; this.broadcastV3(p); this.agentAnswer(a, p.id, 'expired', 'accepted with under 5 s left');
      this.send(conn, Object.assign({ type: 'reject' }, m.cid ? { cid: m.cid } : {}, { reason: 'Proposal ' + p.id + ' expired: under 5 s were left when it was accepted' }));
      return;
    }
    const why = this.agentPlanChecks(a, p, { placing: p.id });   // every check again at this moment
    if (why) {
      p.state = 'rejected'; a.stats.refused++; this.broadcastV3(p); this.agentAnswer(a, p.id, 'refused', why);
      this.agentLogLine(a, p.id + ' accepted but refused: ' + why);
      this.send(conn, Object.assign({ type: 'reject' }, m.cid ? { cid: m.cid } : {}, { reason: 'Proposal ' + p.id + ' was accepted but refused: ' + why }));
      return;
    }
    p.state = 'accepted'; this.broadcastV3(p);
    this.agentAnswer(a, p.id, 'accepted', 'accepted by the page');
    this.agentPlace(a, p, p.expiresAt);
    this.agentAnswer(a, p.id, 'placed', 'placed on ' + a.account);
    this.agentNotify(a);
  },
  /* agentAccount (sections 6 and 7) */
  check_agentAccount(m) {
    const a = this.agents.get(m.agent), name = m.account, x = typeof name === 'string' ? this.acct.get(name) : null;
    if (typeof name !== 'string' || !name || name.trim() !== name) return 'account must be an account name';
    if (/^(Backtest|Playback)/i.test(name)) return name + ' is a Backtest or Playback account: an agent never trades one';
    if (!x || x.state === 'archived') return name + ' is not in NinjaTrader';
    if (name === a.account) return name + ' is already ' + a.id + '\'s account';
    if (this.sw.bot && name === this.botAccount) return name + ' is the bot\'s account: an agent trades an account of its own';
    if (this.sw.copier && name === this.copier.leader) return name + ' is the copier\'s leader: an agent trades an account of its own';
    if (this.sw.copier && this.copier.followers.has(name)) return name + ' is a copier follower: an agent trades an account of its own';
    const other = this.agentOfAccount(name); if (other) return name + ' is agent ' + other.id + '\'s account: an agent trades an account of its own';
    if (!this.config.trading || !this.accounts.includes(name) || !this.connected(name) || x.state === 'gone') return name + ' is not tradable now (its checkmark on the Accounts tab, Connected)';
    if (a.trade || this.agentWorkingEntries(a).length || this.agentOpenProposals(a).length) return a.id + ' has a position, a working entry or a proposal: choose its account when it is flat';
    for (const acc of [a.account, name]) for (const r of this.agentRootsOf(a)) {
      if (this.pos(acc, r).qty || [...this.orders.values()].some(o => isWorking(o) && o.account === acc && o.root === r))
        return (acc === name ? name : a.id + '\'s account ' + acc) + ' holds a position or a working order on ' + r + ': choose ' + a.id + '\'s account when both accounts are flat on ' + a.rules.roots.join(' and ');
    }
    return null;
  },
  do_agentAccount(m) {
    const a = this.agents.get(m.agent), old = a.account;
    a.account = m.account;
    this.agentLogLine(a, 'account ' + m.account + ' (' + (this.agentSim(a) ? 'Sim' : 'LIVE') + '), was ' + old + ', set by the page');
    this.agentToAgent(a, this.agentWelcome(a));
    this.agentNotify(a);
  },
  /* agentRules (sections 3 and 7): flat keys */
  check_agentRules(m) {
    const a = this.agents.get(m.agent);
    if (typeof m.roots !== 'string' || !m.roots) return 'roots must be a comma list such as NQ,MNQ';
    const roots = m.roots.split(',').map(x => x.trim());
    if (new Set(roots).size !== roots.length) return 'roots names a root twice';
    for (const r of roots) {
      if (!AGENT_CEILING[r]) return r + ' cannot be an agent\'s root (NQ, MNQ, ES or MES)';
      if (!this.instruments[r] || this.instruments[r].quoteOnly) return r + ' is not traded by ChartBridge (served, not quote only)';
      const q = m['maxQty' + r];
      if (!isInt(q) || q < 1 || q > AGENT_CEILING[r]) return 'maxQty' + r + ' must be a whole number from 1 to ' + AGENT_CEILING[r] + ' (the ceiling)';
    }
    for (const r of Object.keys(AGENT_CEILING)) if (!roots.includes(r) && m['maxQty' + r] !== undefined) return 'maxQty' + r + ' is for a root not in roots';
    for (const k of ['entryFrom', 'entryUntil', 'flatAt']) if (typeof m[k] !== 'string' || !TIME_RX.test(m[k])) return k + ' must be a New York time HH:MM';
    if (hhmm(m.entryFrom) < hhmm('09:30')) return 'entryFrom must be 09:30 or later';
    if (!(hhmm(m.entryFrom) < hhmm(m.entryUntil))) return 'entryFrom must be before entryUntil';
    if (!(hhmm(m.flatAt) > hhmm(m.entryUntil))) return 'flatAt must be after entryUntil';
    if (hhmm(m.flatAt) > hhmm('15:59')) return 'flatAt must be 15:59 at the latest';
    if (!isInt(m.maxExpireSec) || m.maxExpireSec < 60 || m.maxExpireSec > 1800) return 'maxExpireSec must be a whole number from 60 to 1800';
    if (!isInt(m.maxTrades) || m.maxTrades < 0 || m.maxTrades > 50) return 'maxTrades must be 0 (none) or a whole number from 1 to 50';
    if (!isInt(m.maxLosses) || m.maxLosses < 0 || m.maxLosses > 20) return 'maxLosses must be 0 (none) or a whole number from 1 to 20';
    if (a.trade || this.agentWorkingEntries(a).length || this.agentOpenProposals(a).length) return a.id + ' has a position, a working entry or an open proposal: change its rules when it is flat';
    return null;
  },
  do_agentRules(m) {
    const a = this.agents.get(m.agent), roots = m.roots.split(',').map(x => x.trim());
    a.rules = { roots, maxQty: Object.fromEntries(roots.map(r => [r, m['maxQty' + r]])), entryFrom: m.entryFrom, entryUntil: m.entryUntil, flatAt: m.flatAt, maxExpireSec: m.maxExpireSec,
      maxTrades: m.maxTrades || null, maxLosses: m.maxLosses || null };
    const lossRule = /losing trades today/;
    if (a.rules.maxLosses && a.losses >= a.rules.maxLosses && !a.standDown) a.standDown = a.losses + ' losing trades today: no new entries until 18:00 ET';
    if ((!a.rules.maxLosses || a.losses < a.rules.maxLosses) && a.standDown && lossRule.test(a.standDown)) a.standDown = null;
    this.agentLogLine(a, 'rules set by the page: ' + JSON.stringify(this.agentRulesOut(a)));
    this.agentToAgent(a, this.agentWelcome(a));
    this.agentNotify(a);
  },

  /* ---------------- agent to server (section 4) */
  /** connect a simulated agent (tests and smokes) or note a real one's socket; returns the agent or null */
  agentConnect(id, conn) {
    const a = this.agents.get(id); if (!a) return null;
    a.conn = conn || null; a.simulated = !conn; a.lastBeat = this.now(); a.helloed = false;
    return a;
  },
  agentDrop(id, why) {
    const a = this.agents.get(id); if (!a || (!a.connected && !a.conn)) return;
    a.connected = false; a.conn = null; a.simulated = false; a.helloed = false; a.stats.heartbeatLost++;
    this.agentCancelEntries(a, 'expired', why);
    this.agentExpireProposals(a, 'not answered', why);
    this.broadcastV3({ type: 'status', level: 'warn', text: 'Agent ' + a.id + ': ' + why + ': its unfilled entries are cancelled, its proposals not answered; any position keeps its stop and target' });
    this.agentLogLine(a, 'heartbeat lost: ' + why);
    this.agentNotify(a);
  },
  /** one message from agent id; returns the reject's reason, or null */
  agentMessage(id, m, text) {
    const a = this.agents.get(id);
    if (!a) return 'No agent ' + id + '.';
    a.lastBeat = this.now();
    const strict = checkAgentMessage(m, text);
    if (strict) { if (m && m.type === 'plan' && typeof m.id === 'string') this.agentRefusePlan(a, m, strict); return strict; }
    if (!a.helloed && m.type !== 'agentHello') return 'send agentHello first';
    if (m.type !== 'beat') {
      const t = this.now(); a.msgTimes = a.msgTimes.filter(x => t - x < 1000); a.msgTimes.push(t);
      if (a.msgTimes.length > 10) return 'More than 10 messages in one second. Slow down.';
    }
    switch (m.type) {
      case 'beat': return null;
      case 'agentHello': {
        if (typeof m.name !== 'string' || !m.name || m.name.length > 40 || typeof m.build !== 'string' || !m.build || m.build.length > 40) return 'agentHello needs name and build of 1 to 40 characters';
        a.name = m.name; a.build = m.build; a.connected = true; a.helloed = true;
        this.agentToAgent(a, this.agentWelcome(a)); this.agentToAgent(a, this.agentStateMsg(a));
        this.agentLogLine(a, 'hello ' + m.name + ' ' + m.build);
        this.agentNotify(a);
        return null;
      }
      case 'subscribe': this.agentToAgent(a, { type: 'ready', root: m.root }); return null;   // the fake keeps no history for an agent (lead's default)
      case 'note': {
        if (!AGENT_NOTE_KINDS.includes(m.kind)) return 'kind must be look, thinking, lesson, notebook or status';
        if (typeof m.text !== 'string' || !m.text) return 'text must be 1 to 1,000 characters';
        const n = { type: 'agentNote', agent: a.id, at: this.now(), kind: m.kind, text: m.text };
        a.notes.push(n); if (a.notes.length > 200) a.notes.shift();
        this.broadcastV3(n);
        return null;
      }
      case 'skip': {
        if (typeof m.id !== 'string' || !m.id || m.id.length > 40) return 'id must be 1 to 40 characters';
        if (typeof m.reason !== 'string' || !m.reason) return 'reason must be 1 to 200 characters';
        const p = { type: 'agentPlan', agent: a.id, id: m.id, at: this.now(), action: 'skip', setup: m.setup === undefined ? null : m.setup, reason: m.reason, result: 'skipped' };
        this.agentKeepPlan(a, p); this.agentLogLine(a, m.id + ' skipped: ' + m.reason);
        return null;
      }
      case 'withdraw': {
        const p = a.proposals.get(m.id);
        if (p && p.state === 'open') { p.state = 'withdrawn'; this.broadcastV3(p); this.agentAnswer(a, p.id, 'withdrawn', 'withdrawn: ' + m.reason); }
        for (const o of this.agentWorkingEntries(a)) if (o.planId === m.id) { this.cancelOne(o); this.agentAnswer(a, m.id, 'withdrawn', 'entry cancelled: ' + m.reason); }
        this.agentLogLine(a, m.id + ' withdrawn: ' + m.reason);
        this.agentNotify(a);
        return null;
      }
      case 'flatten': {
        if (a.mode !== 'auto') return 'flatten is for auto mode only';
        if (a.killed) return 'the kill switch is on';
        this.agentFlatten(a, 'the agent asked');
        return null;
      }
      case 'plan': return this.agentPlan(a, m);
    }
    return 'Unknown message.';
  },
  agentKeepPlan(a, p) {
    a.plans = a.plans.filter(x => x.id !== p.id); a.plans.push(p); if (a.plans.length > 50) a.plans.shift();
    a.lastPlan = p;
    this.broadcastV3(p);
  },
  agentPlanFields(m) {
    const f = { root: m.root, side: m.side, kind: m.kind, price: m.price };
    if (m.limitPrice !== undefined) f.limitPrice = m.limitPrice;
    return Object.assign(f, { qty: m.qty, stopTicks: m.stopTicks, targetTicks: m.targetTicks, expireSec: m.expireSec, riskDollars: m.riskDollars, setup: m.setup, reason: m.reason, confidence: m.confidence });
  },
  agentRefusePlan(a, m, why) {
    a.stats.refused++;
    this.agentToAgent(a, { type: 'reject', id: typeof m.id === 'string' ? m.id : null, reason: why });
    this.agentKeepPlan(a, Object.assign({ type: 'agentPlan', agent: a.id, id: m.id, at: this.now(), action: 'plan' }, this.agentPlanFields(m), { result: 'refused: ' + why }));
    this.agentLogLine(a, m.id + ' refused: ' + why);
    return why;
  },
  /** the checks on a plan, in the contract's order (section 4); returns why, or null. o.placing: the id of an accepted
   *  proposal being placed (its own id and its own open proposal do not count against it) */
  agentPlanChecks(a, m, o) {
    const placing = o && o.placing;
    const str = (v, max) => typeof v === 'string' && v.length >= 1 && v.length <= max;
    // 1. strict message; id new today
    if (!str(m.id, 40)) return 'id must be 1 to 40 characters';
    if (!placing && a.planIds.has(m.id)) return 'plan id ' + m.id + ' was used today';
    if (m.side !== 'buy' && m.side !== 'sell') return 'side must be buy or sell';
    for (const k of ['price', 'qty', 'stopTicks', 'targetTicks', 'expireSec', 'riskDollars', 'confidence']) if (typeof m[k] !== 'number' || !isFinite(m[k])) return k + ' must be a number';
    if (m.kind === 'stopLimit' && typeof m.limitPrice !== 'number') return 'a stop-limit plan needs limitPrice';
    if (m.kind !== 'stopLimit' && m.limitPrice !== undefined) return 'limitPrice goes on a stop-limit plan only';
    if (!str(m.setup, 40)) return 'setup must be 1 to 40 characters';
    if (!str(m.reason, 200)) return 'reason must be 1 to 200 characters';
    if (m.confidence < 0 || m.confidence > 1) return 'confidence must be from 0 to 1';
    // 2. not killed, not stood down, the account tradable now (and an account of its own: lead's default)
    if (a.killed) return 'the kill switch is on';
    if (a.standDown) return a.standDown;
    if (!this.config.trading) return 'trading is off in config.txt';
    const acc = this.acct.get(a.account);
    if (!acc || !this.accounts.includes(a.account) || !this.connected(a.account) || acc.state === 'gone') return a.account + ' is not tradable now (its checkmark, Connected)';
    if (this.sw.bot && a.account === this.botAccount) return a.account + ' is the bot\'s account: choose ' + a.id + '\'s own account on the Agent tab';
    if (this.sw.copier && (a.account === this.copier.leader || this.copier.followers.has(a.account))) return a.account + ' is the copier\'s: choose ' + a.id + '\'s own account on the Agent tab';
    // 3. root and kind
    if (!a.rules.roots.includes(m.root)) return m.root + ' is not one of ' + a.id + '\'s roots (' + a.rules.roots.join(', ') + ')';
    if (!this.instruments[m.root] || this.instruments[m.root].quoteOnly) return m.root + ' is not traded by ChartBridge';
    if (m.kind !== 'limit' && m.kind !== 'stopLimit') return 'an agent\'s entry is a limit or a stop-limit';
    // 4. quantity, stop and target
    const cap = a.rules.maxQty[m.root];
    if (!isInt(m.qty) || m.qty < 1 || m.qty > cap) return 'qty must be a whole number from 1 to ' + cap + ' (maxQty.' + m.root + ')';
    if (!isInt(m.stopTicks) || m.stopTicks < 1 || !isInt(m.targetTicks) || m.targetTicks < 1) return 'stopTicks and targetTicks must be whole numbers of 1 or more';
    // 5. risk
    const ins = this.instruments[m.root], risk = m.stopTicks * ins.tick * ins.pointValue * m.qty;
    if (Math.abs(m.riskDollars - risk) > 0.01 + 1e-9) return 'riskDollars ' + m.riskDollars + ' is not stopTicks x tick x point value x qty (' + risk.toFixed(2) + ')';
    // 6. expiry
    if (!isInt(m.expireSec) || m.expireSec < 60 || m.expireSec > a.rules.maxExpireSec) return 'expireSec must be from 60 to ' + a.rules.maxExpireSec;
    // 7. the entry window
    if (!this.agentAnyTime) { const t = nyMinutes(this.now()); if (t < hhmm(a.rules.entryFrom) || t >= hhmm(a.rules.entryUntil)) return 'outside the entry window (' + a.rules.entryFrom + ' to ' + a.rules.entryUntil + ' ET)'; }
    // 8. one at a time
    if (a.trade) return a.id + ' has a position: one at a time';
    if (this.agentWorkingEntries(a).length) return a.id + ' has a working entry: one at a time';
    if (this.agentOpenProposals(a).some(p => p.id !== placing)) return a.id + ' has an open proposal: one at a time';
    // 9. trades and losing trades
    if (a.rules.maxTrades && a.trades >= a.rules.maxTrades) return a.id + ' has made ' + a.rules.maxTrades + ' trades today (its rules)';
    if (a.rules.maxLosses && a.losses >= a.rules.maxLosses) return a.losses + ' losing trades today (its rules)';
    // 10. the owner lock
    const owner = this.ownerOf(a.account, m.root);
    if (owner && owner !== 'agent:' + a.id) return a.account + ' ' + m.root + ' belongs to ' + (owner.startsWith('agent:') ? 'agent ' + owner.slice(6) : owner === 'page' ? 'your own trading' : 'the ' + owner) + ' until it is flat';
    // 11. price
    const last = this.last[m.root], tick = ins.tick;
    if (!onTickGrid(m.price, tick) || (m.kind === 'stopLimit' && !onTickGrid(m.limitPrice, tick))) return 'the price is not on the ' + m.root + ' tick grid (' + tick + ')';
    if (!(last > 0) || !(this.now() - (this.lastAt[m.root] || -Infinity) <= 300000)) return 'the last trade on ' + m.root + ' is over 300 s old';
    const buy = m.side === 'buy';
    if (m.kind === 'limit') { if (buy ? m.price > last : m.price < last) return 'a ' + m.side + ' limit must be at or ' + (buy ? 'below' : 'above') + ' the last trade (' + fmt(last) + ')'; }
    else {
      if (buy ? !(m.price > last) : !(m.price < last)) return 'a ' + m.side + ' stop-limit\'s price must be ' + (buy ? 'above' : 'below') + ' the last trade (' + fmt(last) + ')';
      const off = Math.round((m.limitPrice - m.price) / tick) * (buy ? 1 : -1);
      if (off < 0 || off > 20) return 'a ' + m.side + ' stop-limit\'s limitPrice must be from its price to 20 ticks ' + (buy ? 'above' : 'below') + ' it';
    }
    return null;
  },
  agentPlan(a, m) {
    a.stats.plans++;
    const why = this.agentPlanChecks(a, m);
    if (why) return this.agentRefusePlan(a, m, why);
    a.planIds.add(m.id);
    const at = this.now(), fields = this.agentPlanFields(m);
    const out = Object.assign({ type: 'agentPlan', agent: a.id, id: m.id, at, action: 'plan' }, fields, { result: a.mode === 'shadow' ? 'shadow' : a.mode === 'copilot' ? 'proposed' : 'placed' });
    if (a.mode === 'shadow') { this.agentKeepPlan(a, out); this.agentLogLine(a, m.id + ' shadow'); this.agentNotify(a); return null; }
    if (a.mode === 'copilot') {
      a.stats.proposals++;
      const p = Object.assign({ type: 'agentProposal', agent: a.id, id: m.id, at, account: a.account, sim: this.agentSim(a) }, fields, { expiresAt: at + m.expireSec * 1000, state: 'open', seenAt: null, answeredAt: null });
      a.proposals.set(m.id, p);
      this.agentKeepPlan(a, out);
      this.broadcastV3(p);
      this.agentAnswer(a, m.id, 'proposed', 'proposed to the page');
      this.agentLogLine(a, m.id + ' proposed');
      this.agentNotify(a);
      return null;
    }
    this.agentKeepPlan(a, out);
    this.agentPlace(a, Object.assign({ id: m.id }, fields), at + m.expireSec * 1000);
    this.agentAnswer(a, m.id, 'placed', 'placed on ' + a.account);
    this.agentNotify(a);
    return null;
  },
  /** ChartBridge places the entry from the plan's own numbers: limit or stop-limit, Day, its stop and target from each fill */
  agentPlace(a, p, expiresAt) {
    const o = this.newOrder({ cid: null, account: a.account, root: p.root, side: p.side, kind: p.kind, qty: p.qty, price: p.price, role: 'entry', agentId: a.id, planId: p.id, expiresAt });
    if (p.kind === 'stopLimit') { o.limitPrice = p.limitPrice; o.limitOffset = Math.round(Math.abs(p.limitPrice - p.price) / this.instruments[p.root].tick); }
    o.planned = { stopTicks: p.stopTicks, targetTicks: p.targetTicks };
    o.tag = 'CB#' + o.id.toLowerCase() + ' ag:' + a.id + ' s' + p.stopTicks + ' t' + p.targetTicks;
    a.stats.placed++;
    this.agentLogLine(a, p.id + ' placed: ' + o.tag);
    this.emitOrder(o); this.matchOne(o, this.last[o.root], true);
    return o;
  },
  agentCancelEntries(a, answer, why) {
    for (const o of this.agentWorkingEntries(a)) { this.cancelOne(o); this.agentAnswer(a, o.planId, answer, 'entry cancelled: ' + why); }
  },
  agentExpireProposals(a, state, why) {
    for (const p of this.agentOpenProposals(a)) { p.state = state; this.broadcastV3(p); this.agentAnswer(a, p.id, state, why); this.agentLogLine(a, p.id + ' ' + state + ': ' + why); }
  },
  /** cancel every working order of the agent on its account and roots (entries and legs), then close its position at market */
  agentFlatten(a, why) {
    for (const o of [...this.orders.values()]) if (isWorking(o) && this.agentOfOrder(o) === a.id) this.cancelOne(o);
    const pos = this.agentPosition(a);
    if (pos) {
      const x = this.newOrder({ cid: null, account: a.account, root: pos.root, side: pos.qty > 0 ? 'sell' : 'buy', kind: 'market', qty: Math.abs(pos.qty), price: null, role: 'other', agentId: a.id });
      this.emitOrder(x); this.matchOne(x, this.last[pos.root], true);
    }
    this.agentLogLine(a, 'flattened: ' + why);
    this.agentNotify(a);
  },
  /* fills: an agent's trade opens with the first fill of its entry and closes when its account is flat on that root */
  agentBeforeFill(o, qty, price) {
    if (!this.agents || !this.agents.size) return;
    for (const a of this.agents.values()) {
      if (!a.trade || a.account !== o.account || a.trade.root !== o.root) continue;
      const p = this.pos(o.account, o.root), signed = o.side === 'buy' ? qty : -qty;
      if (p.qty && Math.sign(p.qty) !== Math.sign(signed)) a.trade.pnl += (price - p.avgPrice) * Math.min(Math.abs(p.qty), qty) * Math.sign(p.qty) * this.instruments[o.root].pointValue;
    }
  },
  agentAfterFill(o, qty, price) {
    if (!this.agents || !this.agents.size) return;
    const mine = this.agentOfOrder(o), a0 = mine ? this.agents.get(mine) : null;
    if (a0 && o.role === 'entry' && !a0.trade) { a0.trade = { root: o.root, pnl: 0 }; a0.trades++; }
    for (const a of this.agents.values()) {
      if (a.conn && (a === a0 || (a.account === o.account && a.trade && a.trade.root === o.root))) {
        this.send(a.conn, { type: 'exec', account: o.account, name: o.name, root: o.root, side: o.side, qty, p: price, t: +this.barTime().toFixed(3), u: this.now(), id: 'X' + this.execSeq, order: o.id });
        const p = this.pos(o.account, o.root); this.send(a.conn, { type: 'position', account: o.account, root: o.root, qty: p.qty, avgPrice: p.qty ? p.avgPrice : null });
      }
      if (a.trade && a.account === o.account && a.trade.root === o.root && !this.pos(o.account, o.root).qty) {
        const t = a.trade; a.trade = null; a.pnl += t.pnl;
        if (t.pnl < 0) { a.losses++; if (a.rules.maxLosses && a.losses >= a.rules.maxLosses) a.standDown = a.losses + ' losing trades today: no new entries until 18:00 ET'; }
        this.agentLogLine(a, 'trade closed: ' + t.pnl.toFixed(2));
      }
      if (a === a0 || a.account === o.account) this.agentNotify(a);
    }
  },
  /** every second: the heartbeat, expiry, the entry window and the flat time (ChartBridge's own timers, the agent gone or not) */
  agentsEverySecond() {
    if (!this.agents || !this.agents.size) return;
    const t = this.now(), ny = nyMinutes(t);
    for (const a of this.agents.values()) {
      if (a.connected && !a.simulated && t - a.lastBeat > 5000) { const c = a.conn; this.agentDrop(a.id, 'no heartbeat for 5 s'); if (c && typeof this.closeAgentConn === 'function') this.closeAgentConn(c); }
      for (const p of this.agentOpenProposals(a)) if (p.expiresAt <= t) { p.state = 'expired'; this.broadcastV3(p); this.agentAnswer(a, p.id, 'expired', 'the plan\'s entry time ran out'); this.agentLogLine(a, p.id + ' expired'); this.agentNotify(a); }
      for (const o of this.agentWorkingEntries(a)) if (o.expiresAt <= t) { this.cancelOne(o); this.agentAnswer(a, o.planId, 'expired', 'the entry\'s time ran out'); this.agentNotify(a); }
      if (this.agentAnyTime) continue;
      if (ny >= hhmm(a.rules.entryUntil)) { if (this.agentWorkingEntries(a).length || this.agentOpenProposals(a).length) { this.agentCancelEntries(a, 'expired', 'the entry window ended'); this.agentExpireProposals(a, 'expired', 'the entry window ended'); this.agentNotify(a); } }
      if (ny >= hhmm(a.rules.flatAt)) {
        const day = new Date(t).toISOString().slice(0, 10), busy = this.agentPosition(a) || [...this.orders.values()].some(o => isWorking(o) && this.agentOfOrder(o) === a.id);
        if (busy && a.flattenedDay !== day) {
          a.flattenedDay = day; a.stats.flattenedAt = t; a.flatWarnAt = t;
          this.agentFlatten(a, 'flat time');
          this.broadcastV3({ type: 'status', level: 'info', text: a.id + ' flattened at ' + a.rules.flatAt + ' by its rules' });
        } else if (a.flattenedDay === day && this.agentPosition(a) && t - a.flatWarnAt >= 10000) {
          a.flatWarnAt = t;
          this.broadcastV3({ type: 'status', level: 'error', text: a.id + ' is not flat ' + Math.round((t - a.stats.flattenedAt) / 1000) + ' s after its flat time: check ' + a.account + ' in NinjaTrader' });
        }
      }
    }
  },
});

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
