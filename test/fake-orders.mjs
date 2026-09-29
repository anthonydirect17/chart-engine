// Reference behaviour for ChartBridge order entry: nt8/PROTOCOL.md, "Orders (protocol v2)".
// The fake bridge (test/fake-bridge.mjs) runs this, the tests check it, and the C# side should match it.
// Everything here is simulated: prices are sample data, not market data, and nothing reaches a broker.
//
// Reading order: the safety gates (checkAction, checkOrder, checkPrice), then the matching engine
// (tick, fill), then brackets (bracketsAfterFill, resizeLegs).

export const MAX_TICKS_AWAY = 200;          // gate 5: limit and stop prices within 200 ticks of the last price
export const RATE_LIMIT = 10;               // gate 7: order actions per connection in any 1 second window
export const DEFAULT_MAX_QTY = 1;           // gate 3: roots without a maxQty line
export const MAX_BRACKET_TICKS = 200;       // bracket stop and target, like gate 5 (not in the spec text; see README)
// Gate 3, extended: the cap also limits the position a new order could build (position plus working
// orders on that side). The spec text caps each order; this closes the "click Buy five times" gap.
export const CAP_COUNTS_POSITION = true;
// A limit touched (traded at exactly its price) fills this many contracts per trade; traded through fills all.
export const TOUCH_FILL = 1;

const WORKING = new Set(['working', 'partFilled']);
const isWorking = o => WORKING.has(o.state);
const isLeg = o => o.role === 'stop' || o.role === 'target';

/** Accounts orders may use: named in tradeAccounts, known to NinjaTrader, never Backtest or Playback, no wildcards. */
export function allowedAccounts(tradeAccounts, known) {
  return (tradeAccounts || []).map(a => String(a).trim())
    .filter(a => a && !a.includes('*') && a !== 'Backtest' && !/^Playback/i.test(a) && known.includes(a));
}

export function onTickGrid(price, tick) { return Math.abs(price / tick - Math.round(price / tick)) < 1e-6; }

const fmt = p => (p < 0 ? '-' : '') + Math.abs(p).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export class OrderDesk {
  /**
   * config: { trading, tradeAccounts: [names], maxQty: { ROOT: n }, port }
   * instruments: { ROOT: { name, tick, pointValue } }; knownAccounts: every account NinjaTrader has.
   * send(conn, msg) delivers to one connection; conns() lists open connections.
   * now() is wall milliseconds (injectable for tests); barTime() is exchange seconds for exec `t`.
   */
  constructor({ config, instruments, knownAccounts, token, send, conns, now, barTime }) {
    this.config = Object.assign({ trading: false, tradeAccounts: [], maxQty: {}, port: 8765 }, config || {});
    this.instruments = instruments;
    this.accounts = allowedAccounts(this.config.tradeAccounts, knownAccounts || []);
    this.token = token;
    this.send = send; this.conns = conns;
    this.now = now || (() => Date.now());
    this.barTime = barTime || (() => this.now() / 1000);
    this.last = {};                 // root -> last traded price
    this.orders = new Map();        // id -> order (every order this session, final ones included)
    this.positions = new Map();     // 'account|root' -> { qty, avgPrice }
    this.seq = 0; this.execSeq = 0;
  }

  /* ---------------- connection and auth (gates 1, 4) */
  origin() { return 'http://localhost:' + this.config.port; }
  maxQtyMap() { return Object.assign({ '*': DEFAULT_MAX_QTY }, this.config.maxQty); }
  capFor(root) { const m = this.config.maxQty; return m[root] !== undefined ? m[root] : DEFAULT_MAX_QTY; }

  /** Why this connection cannot trade, or null when it can. */
  blocked(conn) {
    if (!this.config.trading) return 'Trading is off. Set trading = true in config.txt to turn it on.';
    if (conn.origin !== this.origin()) return 'Orders are only taken from ChartBridge\'s own page (' + this.origin() + ').';
    if (!this.accounts.length) return 'No account is allowed to trade. Name them in tradeAccounts in config.txt.';
    if (!conn.authed) return 'This page has not signed in yet (auth with the session token).';
    return null;
  }
  tradingMsg(conn) {
    const why = this.blocked(conn);
    return why ? { type: 'trading', enabled: false, reason: why, accounts: [], maxQty: {} }
      : { type: 'trading', enabled: true, accounts: this.accounts.slice(), maxQty: this.maxQtyMap() };
  }
  /** The `trading` field of `hello`: always disabled until auth. */
  helloTrading(conn) { const m = this.tradingMsg(Object.assign({}, conn, { authed: false })); delete m.type; return m; }

  auth(conn, token) {
    conn.authed = false;
    const pre = this.blocked(Object.assign({}, conn, { authed: true }));
    if (pre) { this.send(conn, this.tradingMsg(conn)); return; }
    if (typeof token !== 'string' || token !== this.token) {
      this.send(conn, { type: 'trading', enabled: false, reason: 'The session token does not match. Reload the page.', accounts: [], maxQty: {} });
      return;
    }
    conn.authed = true;
    this.send(conn, this.tradingMsg(conn));
    this.send(conn, { type: 'orders', list: [...this.orders.values()].filter(o => isWorking(o) && this.accounts.includes(o.account)).map(o => this.orderMsg(o)) });
    for (const [k, p] of this.positions) if (p.qty && this.accounts.includes(k.split('|')[0])) { const [account, root] = k.split('|'); this.send(conn, { type: 'position', account, root, qty: p.qty, avgPrice: p.avgPrice }); }
  }

  /* ---------------- page to server: order, change, cancel, flatten */
  handle(conn, m) {
    const ref = m.type === 'order' ? { cid: m.cid } : m.type === 'flatten' ? {} : { id: m.id };
    const why = this.checkAction(conn) || this['check_' + m.type](m);
    if (why) { this.send(conn, Object.assign({ type: 'reject' }, ref, { reason: why })); return false; }
    this['do_' + m.type](m);
    return true;
  }

  /** Gates for every order action: 1 and 4 (signed in on the right page), then 7 (rate). */
  checkAction(conn) {
    const why = this.blocked(conn);
    if (why) return why;
    const t = this.now();
    conn.actions = (conn.actions || []).filter(x => t - x < 1000);
    conn.actions.push(t);                   // refused actions count too, so a burst stays refused
    if (conn.actions.length > RATE_LIMIT) return 'More than ' + RATE_LIMIT + ' order actions in one second. Slow down.';
    return null;
  }
  checkAccountRoot(account, root) {
    if (!this.accounts.includes(account)) return 'Account ' + account + ' is not allowed to trade (tradeAccounts in config.txt).';
    if (!this.instruments[root]) return root + ' is not an instrument ChartBridge serves.';
    if (!(this.last[root] > 0)) return 'No last price for ' + root + ' yet.';
    return null;
  }
  /** Gate 5: on the tick grid, within 200 ticks of the last price, stops on the right side. */
  checkPrice(root, side, kind, price) {
    const tick = this.instruments[root].tick, last = this.last[root];
    if (typeof price !== 'number' || !isFinite(price) || price <= 0) return 'A ' + kind + ' order needs a price.';
    if (!onTickGrid(price, tick)) return fmt(price) + ' is not on the ' + root + ' tick grid (' + tick + ').';
    const away = Math.round(Math.abs(price - last) / tick);
    if (away > MAX_TICKS_AWAY) return fmt(price) + ' is ' + away + ' ticks from the last price ' + fmt(last) + '; the limit is ' + MAX_TICKS_AWAY + '.';
    if (kind === 'stop' && side === 'buy' && !(price > last)) return 'A buy stop must be above the last price (' + fmt(last) + ').';
    if (kind === 'stop' && side === 'sell' && !(price < last)) return 'A sell stop must be below the last price (' + fmt(last) + ').';
    return null;
  }
  check_order(m) {
    if (typeof m.cid !== 'string' || !m.cid) return 'The order has no cid.';
    const ar = this.checkAccountRoot(m.account, m.root); if (ar) return ar;
    if (m.side !== 'buy' && m.side !== 'sell') return 'Side must be buy or sell.';
    if (!['market', 'limit', 'stop'].includes(m.kind)) return 'Kind must be market, limit or stop.';
    if (!Number.isInteger(m.qty) || m.qty < 1) return 'Qty must be a whole number of at least 1.';
    const cap = this.capFor(m.root);
    if (m.qty > cap) return 'Qty ' + m.qty + ' is over the ' + m.root + ' cap of ' + cap + ' (maxQty.' + m.root + ' in config.txt).';
    if (CAP_COUNTS_POSITION) {
      const would = this.exposure(m.account, m.root, m.side, m.qty);
      if (would > cap) return (m.side === 'buy' ? 'Buying ' : 'Selling ') + m.qty + ' could take the ' + m.root + ' position on ' + m.account + ' to ' + would + ' (with working orders), over the cap of ' + cap + '.';
    }
    if (m.kind !== 'market') { const p = this.checkPrice(m.root, m.side, m.kind, m.price); if (p) return p; }
    if (m.bracket !== undefined && m.bracket !== null) {
      const b = m.bracket;
      for (const k of ['stop', 'target']) {
        const v = b[k] === undefined ? 0 : b[k];
        if (!Number.isInteger(v) || v < 0 || v > MAX_BRACKET_TICKS) return 'Bracket ' + k + ' must be 0 to ' + MAX_BRACKET_TICKS + ' ticks.';
      }
    }
    return null;
  }
  check_change(m) {
    const o = this.orders.get(m.id);
    if (!o || !isWorking(o) || !this.accounts.includes(o.account)) return 'No working order ' + m.id + '.';
    if (o.kind === 'market') return 'A market order has no price to move.';
    return this.checkPrice(o.root, o.side, o.kind, m.price);
  }
  check_cancel(m) {
    const o = this.orders.get(m.id);
    if (!o || !isWorking(o) || !this.accounts.includes(o.account)) return 'No working order ' + m.id + '.';
    return null;
  }
  check_flatten(m) {
    if (!this.accounts.includes(m.account)) return 'Account ' + m.account + ' is not allowed to trade (tradeAccounts in config.txt).';
    if (!this.instruments[m.root]) return m.root + ' is not an instrument ChartBridge serves.';
    if (!(this.last[m.root] > 0)) return 'No last price for ' + m.root + ' yet.';
    return null;
  }

  /** Contracts a side could reach with `extra` more: the position plus working non-bracket orders on that side. */
  exposure(account, root, side, extra) {
    const pos = this.pos(account, root).qty;
    let working = 0;
    for (const o of this.orders.values()) if (isWorking(o) && !isLeg(o) && o.account === account && o.root === root && o.side === side) working += o.qty - o.filled;
    return Math.max(0, (side === 'buy' ? pos : -pos) + working + (extra || 0));
  }

  do_order(m) {
    const o = this.newOrder({ cid: m.cid, account: m.account, root: m.root, side: m.side, kind: m.kind, qty: m.qty,
      price: m.kind === 'market' ? null : m.price, role: 'entry' });
    const b = m.bracket || {};
    o.bracket = (b.stop > 0 || b.target > 0) ? { stop: b.stop || 0, target: b.target || 0 } : null;
    this.emitOrder(o);
    this.matchOne(o, this.last[o.root], true);
  }
  do_change(m) {
    const o = this.orders.get(m.id);
    o.price = m.price;
    this.emitOrder(o);
    this.matchOne(o, this.last[o.root], true);
  }
  do_cancel(m) { this.cancel(this.orders.get(m.id)); }
  do_flatten(m) {
    for (const o of [...this.orders.values()]) if (isWorking(o) && o.account === m.account && o.root === m.root) this.cancelOne(o);
    const p = this.pos(m.account, m.root);
    if (p.qty) {                        // close at market; no cap check, closing must always work
      const o = this.newOrder({ cid: null, account: m.account, root: m.root, side: p.qty > 0 ? 'sell' : 'buy', kind: 'market', qty: Math.abs(p.qty), price: null, role: 'other' });
      this.emitOrder(o);
      this.matchOne(o, this.last[o.root], true);
    }
  }

  /** An order placed in NinjaTrader itself (role 'other'); it shows on the chart and can be moved or cancelled. */
  placeElsewhere(f) {
    const o = this.newOrder(Object.assign({ cid: null, role: 'other' }, f));
    this.emitOrder(o); this.matchOne(o, this.last[o.root], true);
    return o;
  }

  /* ---------------- orders */
  newOrder(f) {
    const o = Object.assign({ id: 'NT' + (++this.seq), filled: 0, avgFill: null, state: 'working', oco: null, text: null, bracket: null, parent: null }, f);
    o.name = this.instruments[o.root].name;
    this.orders.set(o.id, o);
    return o;
  }
  orderMsg(o) {
    return { type: 'order', id: o.id, cid: o.cid || null, account: o.account, root: o.root, name: o.name, side: o.side, kind: o.kind,
      qty: o.qty, filled: o.filled, price: o.price, avgFill: o.avgFill, state: o.state, role: o.role, oco: o.oco, text: o.text };
  }
  broadcast(msg) { for (const c of this.conns()) if (c.authed) this.send(c, msg); }
  emitOrder(o) { if (this.accounts.includes(o.account)) this.broadcast(this.orderMsg(o)); }
  cancelOne(o) { if (isWorking(o)) { o.state = 'cancelled'; this.emitOrder(o); } }
  /** Cancel one order; a bracket leg takes its OCO partner with it. */
  cancel(o) {
    this.cancelOne(o);
    if (o.oco) for (const x of this.orders.values()) if (x.oco === o.oco && x !== o) this.cancelOne(x);
  }

  /* ---------------- matching engine: every trade on a root runs through the working orders */
  tick(root, price) {
    this.last[root] = price;
    for (const o of [...this.orders.values()]) if (o.root === root && isWorking(o)) this.matchOne(o, price, false);
  }
  /**
   * Market: fills at once at the last price. Buy limit: traded below its price fills all at the limit, traded at
   * it fills TOUCH_FILL. Buy stop: traded at or above its price fills all at the trade price. Sells mirror.
   * On placement (or a move) a limit already through the market fills at once at the last price.
   */
  matchOne(o, price, placing) {
    if (!isWorking(o) || !(price > 0)) return;
    const left = o.qty - o.filled, buy = o.side === 'buy';
    if (o.kind === 'market') return this.fill(o, left, price);
    if (o.kind === 'stop') { if (buy ? price >= o.price : price <= o.price) this.fill(o, left, price); return; }
    const through = buy ? price < o.price : price > o.price;
    if (through) return this.fill(o, left, placing ? price : o.price);
    if (price === o.price && !placing) this.fill(o, Math.min(left, TOUCH_FILL), o.price);
  }

  pos(account, root) {
    const k = account + '|' + root;
    if (!this.positions.has(k)) this.positions.set(k, { qty: 0, avgPrice: 0 });
    return this.positions.get(k);
  }
  fill(o, qty, price) {
    if (qty <= 0) return;
    o.avgFill = ((o.avgFill || 0) * o.filled + price * qty) / (o.filled + qty);
    o.filled += qty;
    o.state = o.filled >= o.qty ? 'filled' : 'partFilled';
    const signed = o.side === 'buy' ? qty : -qty;
    this.broadcastAll({ type: 'exec', account: o.account, name: o.name, root: o.root, side: o.side, qty, p: price,
      t: +this.barTime().toFixed(3), u: this.now(), id: 'X' + (++this.execSeq), order: o.id });
    // position: adding keeps a weighted average, reducing keeps the average, crossing zero starts at the fill
    const p = this.pos(o.account, o.root), was = p.qty, now = was + signed;
    if (now === 0) p.avgPrice = 0;
    else if (was === 0 || Math.sign(was) !== Math.sign(now)) p.avgPrice = price;
    else if (Math.abs(now) > Math.abs(was)) p.avgPrice = (p.avgPrice * Math.abs(was) + price * qty) / Math.abs(now);
    p.qty = now;
    this.emitOrder(o);
    if (this.accounts.includes(o.account)) this.broadcast({ type: 'position', account: o.account, root: o.root, qty: p.qty, avgPrice: p.avgPrice });
    if (o.role === 'entry' && o.bracket) this.bracketsAfterFill(o);
    if (isLeg(o)) this.legFilled(o);
  }
  broadcastAll(msg) { for (const c of this.conns()) this.send(c, msg); }   // exec goes to every page (the fills layer)

  /* ---------------- brackets: an OCO pair for the filled quantity, following partial fills */
  legsOf(entry) { return [...this.orders.values()].filter(x => x.parent === entry.id); }
  /** First fill places the legs around the entry's average fill; later fills resize them. */
  bracketsAfterFill(entry) {
    const legs = this.legsOf(entry);
    if (!legs.length) {
      const tick = this.instruments[entry.root].tick, dir = entry.side === 'buy' ? 1 : -1, exit = entry.side === 'buy' ? 'sell' : 'buy';
      const b = entry.bracket, both = b.stop > 0 && b.target > 0, oco = both ? 'OCO-' + entry.id : null;
      const made = [];
      if (b.stop > 0) made.push(this.newOrder({ cid: null, account: entry.account, root: entry.root, side: exit, kind: 'stop', qty: entry.filled,
        price: entry.avgFill - dir * b.stop * tick, role: 'stop', oco, parent: entry.id }));
      if (b.target > 0) made.push(this.newOrder({ cid: null, account: entry.account, root: entry.root, side: exit, kind: 'limit', qty: entry.filled,
        price: entry.avgFill + dir * b.target * tick, role: 'target', oco, parent: entry.id }));
      for (const x of made) this.emitOrder(x);
      for (const x of made) this.matchOne(x, this.last[x.root], true);
      return;
    }
    this.resizeLegs(entry);
  }
  /** Each working leg covers what is still open: entry filled minus what the legs have already closed. */
  resizeLegs(entry) {
    const legs = this.legsOf(entry);
    const open = entry.filled - legs.reduce((s, x) => s + x.filled, 0);
    for (const x of legs) {
      if (!isWorking(x)) continue;
      if (open <= 0) { this.cancelOne(x); continue; }
      if (x.qty - x.filled !== open) { x.qty = x.filled + open; this.emitOrder(x); }
    }
  }
  /** A leg filled: the partner shrinks to match (OCO). Once the bracket has closed everything, the entry's rest is cancelled. */
  legFilled(leg) {
    const entry = this.orders.get(leg.parent);
    if (!entry) return;
    this.resizeLegs(entry);
    if (leg.state === 'filled' && isWorking(entry)) this.cancelOne(entry);
  }
}
