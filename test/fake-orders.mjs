// Reference behaviour for ChartBridge order entry: nt8/PROTOCOL.md, "Orders (protocol v2)".
// The fake bridge (test/fake-bridge.mjs) runs this, the tests check it, and the C# side should match it.
// Everything here is simulated: prices are sample data, not market data, and nothing reaches a broker.
//
// Reading order: the safety gates (checkAction, check_order, checkPrice, check_plan), then the matching
// engine (tick, fill), then brackets (bracketsAfterFill, legFilled, flatLegs).

// ChartBridge 0.3.7 (Anthony, 2026-10-01): no distance limits unless config.txt sets them (config.maxTicksAway: a limit
// or stop price at most this many ticks from the last price; config.maxBracketTicks: a bracket at most this many
// ticks; absent or 0 = no limit). Bracket ticks are JSON whole numbers of 0 or more (0 = none).
export const RATE_LIMIT = 10;               // gate 7: order actions per connection in any 1 second window
export const DEFAULT_MAX_QTY = 1;           // gate 3: roots without a maxQty line
export const STALE_MS = 300000;             // gate 5: limit and stop prices refused when the last trade is older than 300 s
// Gate 3 caps the POSITION (coordinator, 2026-09-29): the worst case after this order (position plus working
// orders on the same side plus this order) must stay within maxQty. Orders that reduce are allowed.
// Working orders placed elsewhere (role 'other') count as entries here too, the safer reading.
export const CAP_COUNTS_POSITION = true;
// A limit touched (traded at exactly its price) fills this many contracts per trade; traded through fills all.
export const TOUCH_FILL = 1;

const WORKING = new Set(['working', 'partFilled']);
const isWorking = o => WORKING.has(o.state);
const isLeg = o => o.role === 'stop' || o.role === 'target';

// Gate 8, as ChartBridge 0.3 checks it: only the protocol's keys (a misspelt "bracket" is refused, never
// ignored), and a bracket must be an object with exactly stop and target.
export const KEYS = {
  order: ['type', 'cid', 'account', 'root', 'side', 'kind', 'qty', 'price', 'bracket'],
  change: ['type', 'cid', 'id', 'price'],
  plan: ['type', 'cid', 'id', 'stopTicks', 'targetTicks'],   // 0.3.8: a resting entry's planned stop and target distances
  cancel: ['type', 'cid', 'id'],
  flatten: ['type', 'cid', 'account', 'root'],
};
function checkKeys(m) {
  const allowed = KEYS[m.type];
  if (!allowed) return 'Unknown message type ' + m.type + '.';
  for (const k of Object.keys(m)) if (!allowed.includes(k) && !(m.type === 'flatten' && k === 'bracket')) return 'Unknown key "' + k + '" in ' + m.type + '.';   // as ChartBridge: a bracket on flatten is ignored, never a reason to refuse it
  for (const [k, v] of Object.entries(m)) if (k !== 'bracket' && v !== null && typeof v === 'object') return 'The message has an unexpected nested object or list.';
  if (m.type === 'flatten') return null;
  if (m.bracket !== undefined && m.bracket !== null && typeof m.bracket === 'object' && !Array.isArray(m.bracket))
    for (const k of Object.keys(m.bracket)) if (k !== 'stop' && k !== 'target') return 'Unknown key "' + k + '" in bracket.';
  if (m.cid !== undefined && typeof m.cid !== 'string') return 'cid must be a string.';
  return null;
}

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
    this.lastAt = {};               // root -> when it traded (now() ms), for the stale check
    this.orders = new Map();        // id -> order (every order this session, final ones included)
    this.positions = new Map();     // 'account|root' -> { qty, avgPrice }
    this.seq = 0; this.execSeq = 0; this.ocoSeq = 0;
  }

  /* ---------------- connection and auth (gates 1, 4) */
  origin() { return 'http://localhost:' + this.config.port; }
  maxQtyMap() { return Object.assign({ '*': DEFAULT_MAX_QTY }, this.config.maxQty); }
  capFor(root) { const m = this.config.maxQty; return m[root] !== undefined ? m[root] : DEFAULT_MAX_QTY; }
  /** gate 3's cap for an order, its words and whether the order is an exit that skips the per-order qty check (ChartBridge
   *  0.5.3 names the cap that applied; the v3 desk adds a page exit from an agent's position) */
  orderCap(m) { return [this.capFor(m.root), 'maxQty.' + m.root + ' in config.txt', false]; }

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
      : Object.assign({ type: 'trading', enabled: true, accounts: this.accounts.slice(), maxQty: this.maxQtyMap() },
        this.config.maxTicksAway > 0 ? { maxTicksAway: this.config.maxTicksAway } : {}, this.config.maxBracketTicks > 0 ? { maxBracketTicks: this.config.maxBracketTicks } : {});
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
    for (const w of this.config.warnings || []) this.send(conn, { type: 'status', level: 'warn', text: w });   // 0.3.7: e.g. a mistyped maxTicksAway
    this.send(conn, { type: 'orders', list: [...this.orders.values()].filter(o => isWorking(o) && this.accounts.includes(o.account)).map(o => this.orderMsg(o)) });
    for (const [k, p] of this.positions) if (p.qty && this.accounts.includes(k.split('|')[0])) { const [account, root] = k.split('|'); this.send(conn, { type: 'position', account, root, qty: p.qty, avgPrice: p.qty ? p.avgPrice : null }); }
  }

  /* ---------------- page to server: order, change, plan (0.3.8), cancel, flatten */
  handle(conn, m) {
    const ref = {};
    if (typeof m.cid === 'string') ref.cid = m.cid;
    if (typeof m.id === 'string') ref.id = m.id;
    const why = this.checkAction(conn) || checkKeys(m) || this['check_' + m.type](m);
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
  /** Gate 5: on the tick grid, within maxTicksAway of the last price when config.txt sets it, stops on the right side. */
  checkPrice(root, side, kind, price) {
    const tick = this.instruments[root].tick, last = this.last[root], max = this.config.maxTicksAway;
    if (typeof price !== 'number' || !isFinite(price) || price <= 0) return 'A ' + kind + ' order needs a price.';
    if (!(this.now() - (this.lastAt[root] || -Infinity) <= STALE_MS)) return 'The last price for ' + root + ' is stale (no trade for over ' + STALE_MS / 1000 + ' seconds).';
    if (!onTickGrid(price, tick)) return fmt(price) + ' is not on the ' + root + ' tick grid (' + tick + ').';
    const away = Math.round(Math.abs(price - last) / tick);
    if (max > 0 && away > max) return fmt(price) + ' is ' + away + ' ticks from the last price ' + fmt(last) + '; the limit is ' + max + ' (maxTicksAway in config.txt).';
    if (kind === 'stop' && side === 'buy' && !(price > last)) return 'A buy stop must be above the last price (' + fmt(last) + ').';
    if (kind === 'stop' && side === 'sell' && !(price < last)) return 'A sell stop must be below the last price (' + fmt(last) + ').';
    if (kind === 'limit' && side === 'buy' && price > last) return 'A buy limit above the last price (' + fmt(last) + ') would fill at once; use a buy stop or a market order.';
    if (kind === 'limit' && side === 'sell' && price < last) return 'A sell limit below the last price (' + fmt(last) + ') would fill at once; use a sell stop or a market order.';
    return null;
  }
  check_order(m) {
    const ar = this.checkAccountRoot(m.account, m.root); if (ar) return ar;
    if (m.side !== 'buy' && m.side !== 'sell') return 'Side must be buy or sell.';
    if (!['market', 'limit', 'stop'].includes(m.kind)) return 'Kind must be market, limit or stop.';
    if (!Number.isInteger(m.qty) || m.qty < 1) return 'Qty must be a whole number of at least 1.';
    const [cap, capWhy, exit] = this.orderCap(m);
    if (!exit && m.qty > cap) return 'Qty ' + m.qty + ' is over the ' + m.root + ' cap of ' + cap + ' (' + capWhy + ').';
    if (exit) { const over = this.exitOver(m); if (over) return over; }   // ChartBridge 0.5.3 re-review (the v3 desk): an exit closes at most the position
    if (CAP_COUNTS_POSITION) {
      const would = this.exposure(m.account, m.root, m.side, m.qty);
      if (would > cap) return (m.side === 'buy' ? 'Buying ' : 'Selling ') + m.qty + ' could take the ' + m.root + ' position on ' + m.account + ' to ' + would + ' (with working orders), over the cap of ' + cap + '.';
    }
    if (m.kind !== 'market') { const p = this.checkPrice(m.root, m.side, m.kind, m.price); if (p) return p; }
    const maxB = this.config.maxBracketTicks;
    if (m.bracket !== undefined) {
      const b = m.bracket;
      if (b === null || typeof b !== 'object') return 'A bracket must be { "stop": ticks, "target": ticks }.';
      for (const k of ['stop', 'target']) {        // JSON numbers only: "8" or null is refused, never read as 0
        const v = b[k];
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return 'Bracket ' + k + ' must be a whole number of ticks, 0 or more.';
        if (maxB > 0 && v > maxB) return 'Bracket ' + k + ' must be from 0 to ' + maxB + ' ticks (maxBracketTicks in config.txt).';
      }
    }
    const b = m.bracket || {};
    const wants = b.stop > 0 || b.target > 0;
    const pos = this.pos(m.account, m.root).qty;
    if (wants && pos !== 0 && (pos > 0) !== (m.side === 'buy')) return 'A bracket can only go on an order that opens or adds to a position.';
    return null;
  }
  check_change(m) {
    const o = this.orders.get(m.id);
    if (!o || !isWorking(o) || !this.accounts.includes(o.account)) return 'No working order ' + m.id + '.';
    if (o.kind === 'market') return 'A market order has no price to move.';
    if (o.kind !== 'limit' && o.kind !== 'stop') return 'Only limit and stop market orders can be moved (this one is ' + o.kind + ').';
    return this.checkPrice(o.root, o.side, o.kind, m.price);   // 0.3.8: the planned distances travel with the entry, never a reason to refuse
  }
  /** 0.3.8 (Anthony's ATM rule): set (a whole number of ticks, 1 or more), keep (absent) or remove (null) a resting entry's
   *  planned stop and target distances, for the fill increments still to come. */
  check_plan(m) {
    const o = this.orders.get(m.id);
    if (!o || !isWorking(o) || !this.accounts.includes(o.account)) return 'No working order ' + m.id + '.';
    if (o.role !== 'entry') return 'Only a ChartBridge entry has a planned stop and target; a working leg moves with change.';
    if (!o.planned) return 'Only a resting limit or stop entry has a planned stop and target.';
    if (m.stopTicks === undefined && m.targetTicks === undefined) return 'plan needs stopTicks or targetTicks (a whole number of ticks to set it, null to remove it).';
    const maxB = this.config.maxBracketTicks;
    for (const k of ['stopTicks', 'targetTicks']) {
      const v = m[k];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return k + ' must be a whole number of 1 or more, or null to remove it.';
      if (maxB > 0 && v > maxB) return k + ' must be at most ' + maxB + ' (maxBracketTicks in config.txt).';
    }
    const next = this.nextPlan(o, m), was = o.planned, pos = this.pos(o.account, o.root).qty;
    if (!was.stopTicks && !was.targetTicks && (next.stopTicks || next.targetTicks) && pos !== 0 && (pos > 0) !== (o.side === 'buy')) return 'A bracket can only go on an order that opens or adds to a position.';
    return null;
  }
  nextPlan(o, m) {
    const pick = (v, had) => v === undefined ? had || 0 : v === null ? 0 : v;
    return { stopTicks: pick(m.stopTicks, o.planned.stopTicks), targetTicks: pick(m.targetTicks, o.planned.targetTicks) };
  }
  do_plan(m) {
    const o = this.orders.get(m.id), next = this.nextPlan(o, m);
    o.planned = { stopTicks: next.stopTicks || null, targetTicks: next.targetTicks || null };   // for the fill increments still to come
    this.emitOrder(o);
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

  /** Contracts a side could reach with `extra` more: the position plus every working order on that side
   *  (bracket legs and orders placed elsewhere too; orders sharing an OCO id count once, at the largest). */
  exposure(account, root, side, extra) {
    const pos = this.pos(account, root).qty, groups = new Map();
    let working = 0;
    for (const o of this.orders.values()) {
      if (!isWorking(o) || o.account !== account || o.root !== root || o.side !== side) continue;
      const left = o.qty - o.filled;
      if (o.oco) groups.set(o.oco, Math.max(groups.get(o.oco) || 0, left)); else working += left;
    }
    for (const v of groups.values()) working += v;
    return (side === 'buy' ? pos : -pos) + working + (extra || 0);
  }

  do_order(m) {
    const o = this.newOrder({ cid: m.cid, account: m.account, root: m.root, side: m.side, kind: m.kind, qty: m.qty,
      price: m.kind === 'market' ? null : m.price, role: 'entry' });
    const b = m.bracket;
    if (m.kind === 'market') o.bracket = b && (b.stop > 0 || b.target > 0) ? { stop: b.stop, target: b.target } : null;   // ticks from the fill
    else o.planned = { stopTicks: b && b.stop > 0 ? b.stop : null, targetTicks: b && b.target > 0 ? b.target : null };      // 0.3.8: ticks from the fill, changeable by plan
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
    for (const o of this.orders.values()) if (o.account === m.account && o.root === m.root && o.role === 'entry') o.afterFlatten = true;   // a late fill still gets legs, and an alarm
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
    const o = Object.assign({ id: 'NT' + (++this.seq), filled: 0, avgFill: null, state: 'working', oco: null, text: null, bracket: null, planned: null, parent: null }, f);
    o.name = this.instruments[o.root] ? this.instruments[o.root].name : o.root;
    this.orders.set(o.id, o);
    return o;
  }
  orderMsg(o) {
    // like ChartBridge 0.3: cid only when placed from a page, text only when NinjaTrader gave one
    const m = { type: 'order', id: o.id };
    if (o.cid) m.cid = o.cid;
    Object.assign(m, { account: o.account, root: o.root, name: o.name, side: o.side, kind: o.kind,
      qty: o.qty, filled: o.filled, price: o.price, avgFill: o.avgFill, state: o.state, role: o.role, oco: o.oco });
    if (o.text) m.text = o.text;
    if (o.planned && isWorking(o)) m.planned = { stopTicks: o.planned.stopTicks, targetTicks: o.planned.targetTicks };   // 0.3.8: a working resting entry's planned distances
    return m;
  }
  broadcast(msg) { for (const c of this.conns()) if (c.authed) this.send(c, msg); }
  emitOrder(o) { if (this.accounts.includes(o.account) && this.instruments[o.root]) this.broadcast(this.orderMsg(o)); }
  cancelOne(o) { if (isWorking(o)) { o.state = 'cancelled'; this.emitOrder(o); } }
  /** Cancel one order; a bracket leg takes its OCO partner with it. */
  cancel(o) {
    this.cancelOne(o);
    if (o.oco) for (const x of this.orders.values()) if (x.oco === o.oco && x !== o) this.cancelOne(x);
  }

  /* ---------------- matching engine: every trade on a root runs through the working orders */
  tick(root, price) {
    this.last[root] = price; this.lastAt[root] = this.now();
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
    if (o.kind === 'stopLimit') { if (buy ? price >= o.price : price <= o.price) this.fill(o, left, o.price); return; }   // only from NinjaTrader (role other); stop and limit at one price here
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
    if (this.accounts.includes(o.account)) this.broadcast({ type: 'position', account: o.account, root: o.root, qty: p.qty, avgPrice: p.qty ? p.avgPrice : null });   // null when flat
    if (isLeg(o)) this.legFilled(o);
    if (p.qty === 0) this.flatLegs(o.account, o.root);
    else if (o.role === 'entry' && (o.bracket || o.planned)) this.bracketsAfterFill(o, qty, price);
  }
  broadcastAll(msg) { for (const c of this.conns()) this.send(c, msg); }   // exec goes to every page (the fills layer)

  /* ---------------- brackets: each entry fill gets its own OCO pair (stop and target) for that quantity */
  /** Every entry's legs go around this fill's actual price (0.3.8, the ATM rule): a market entry's bracket ticks, a resting
   *  entry's planned ticks as they are now. Several pairs can exist for one entry. Legs are GTC in ChartBridge. */
  bracketsAfterFill(entry, qty, price) {
    const tick = this.instruments[entry.root].tick, dir = entry.side === 'buy' ? 1 : -1, exit = entry.side === 'buy' ? 'sell' : 'buy';
    const pl = entry.planned, b = entry.bracket;
    const st = pl ? pl.stopTicks || 0 : b.stop || 0, tt = pl ? pl.targetTicks || 0 : b.target || 0;
    const stopPx = st > 0 ? +(price - dir * st * tick).toFixed(10) : 0, targetPx = tt > 0 ? +(price + dir * tt * tick).toFixed(10) : 0;
    const where = entry.root + ' ' + entry.account;
    if (entry.afterFlatten) this.broadcast({ type: 'status', level: 'error', text: where + ': an entry filled AFTER Flatten (' + qty + ' contract(s)); a position may be open. It gets its stop and target now; check NinjaTrader' });
    if (!stopPx && !targetPx) return;
    const both = stopPx > 0 && targetPx > 0, oco = both ? 'OCO-' + entry.id + '-' + (++this.ocoSeq) : null;
    const last = this.last[entry.root];
    if (stopPx > 0 && (dir > 0 ? stopPx >= last : stopPx <= last)) {   // the stop level has already traded: exit now, as the stop would have
      const x = this.newOrder({ cid: null, account: entry.account, root: entry.root, side: exit, kind: 'market', qty, price: null, role: 'other', parent: entry.id });
      this.broadcast({ type: 'status', level: 'error', text: where + ': price had already passed the stop level ' + fmt(stopPx) + ' (last ' + fmt(last) + '); exited ' + qty + ' at market' });
      this.emitOrder(x); this.matchOne(x, last, true);
      return;
    }
    const made = [];
    if (stopPx > 0) made.push(this.newOrder({ cid: null, account: entry.account, root: entry.root, side: exit, kind: 'stop', qty,
      price: stopPx, role: 'stop', oco, parent: entry.id }));
    if (targetPx > 0) made.push(this.newOrder({ cid: null, account: entry.account, root: entry.root, side: exit, kind: 'limit', qty,
      price: targetPx, role: 'target', oco, parent: entry.id }));
    for (const x of made) this.emitOrder(x);
    for (const x of made) this.matchOne(x, this.last[x.root], true);
  }
  /** A leg filled: its OCO partner shrinks to what the leg still has open, or is cancelled when the leg is done. */
  legFilled(leg) {
    if (!leg.oco) return;
    const open = leg.qty - leg.filled;
    for (const x of this.orders.values()) {
      if (x === leg || x.oco !== leg.oco || !isWorking(x)) continue;
      if (open <= 0) this.cancelOne(x);
      else if (x.qty - x.filled !== open) { x.qty = x.filled + open; this.emitOrder(x); }
    }
  }
  /** Flat: any ChartBridge legs left for that account and instrument are cancelled. */
  flatLegs(account, root) {
    for (const x of [...this.orders.values()]) if (isLeg(x) && isWorking(x) && x.account === account && x.root === root) this.cancelOne(x);
  }
}
