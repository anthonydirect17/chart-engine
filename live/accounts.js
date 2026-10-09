/*
 * The Account page (chart 1.16.0, ChartBridge 0.4.0, protocol v3; Anthony's spec, chart page section 1, items 14, 15 and 20):
 * a grid piece of the workspace (live/workspace.js panel type 'accounts') with six tabs, and the Quote board's formats.
 *
 *   Accounts         every account ChartBridge watches (0.5.1: connected in NinjaTrader this session): connection, balance,
 *                    today's P&L, open position, the room to the trailing drawdown and the daily loss limit, the trading
 *                    checkmark, the Gone list, Hide on any flat account (an in-page confirm) and Show on a hidden one
 *   Positions        every open position on every account: average price, unrealized P&L, the attached stop and target
 *   Working orders   every working order on every account (Cancel only with `cancelFromList` on)
 *   Today's trades   per account, the fills and the flat-to-flat round trips, gross and net (The Desk's commission)
 *   Copier           only with `copier` on: the leader, the mode, a row per follower marked SIM or LIVE (Anthony 2026-10-07:
 *                    no Sim lock; ChartBridge's account gates apply to every follower), Re-arm after a stand-down
 *   Log              what ChartBridge said on this page's connection (account changes, refusals, copier decisions)
 *
 * The page asks; ChartBridge decides. Every control shows only when its switch is true (`trading.switches`, PROTOCOL.md
 * "Protocol v3"); ChartBridge refuses the message anyway when it is off. Messages are exactly the contract's. Nothing here
 * moves: no motion on this page (rule R3: order surfaces, the Accounts warnings and the copier stay instant).
 *
 * The window's one v3 connection (the feed, below). The page opens one more WebSocket to ChartBridge per window, sends
 * `client` v3 on it and signs in on it like the order ticket does. It is shared by every 0.4.0 part of the window: this
 * page, the order ticket's 0.4.0 parts (the switches, `managed`, the Merge result) and the Bot tab (live/bot.js), each
 * through listen() and post(). The order ticket's own connection stays a v2 page exactly as in 0.3.8, and every order
 * action (`order`, `change`, `plan`, `cancel`, `flatten`, `merge`, and this page's cancel from the list) goes on it, the one
 * order path (env.orderSend). The feed starts only when ChartBridge's hello lists "v3", so with an older ChartBridge nothing
 * new is opened. nt8/PROTOCOL.md "The page's v3 connection (chart 1.16.0)".
 *
 * Limits come from ChartBridge (roomDrawdown, roomDailyLoss) where NinjaTrader reports them, else from The Desk's
 * GET /api/chart-accounts. The Desk's address has one source on the page: deskBase() below (ChartBridge's /diag
 * desk.deskUrl, the deskUrl in config.txt). Never estimated.
 *
 * This file has two parts, as workspace.js:
 *   AccountsCore   the pure parts (formats, the limit percent, round trips, gross and net, the copier's rows). No DOM; it
 *                  also loads in Node for test/accounts-page.test.js.
 *   AccountsPage   runs only in a browser: createFeed (the connection) and mount (the panel), used by workspace.js.
 * Made-up account names only in tests and docs (EVAL-A, FUNDED-B, Sim101).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AccountsCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* ---------------- the Quote board (item 20) */
/* ChartBridge 0.4.0's default quoteRoots, in Anthony's order; shown after NQ and ES when hello lists them as quote only */
const QUOTE_ONLY = ['YM', 'RTY', 'GC', 'SI', 'CL', '6E', 'ZN', 'ZB'];
const isNum = v => typeof v === 'number' && isFinite(v);
/** The Quote board's rows: `base` (NQ, ES), then every market hello marks quote only (QUOTE_ONLY's order, any other after,
    by name). `instruments` is hello's list or a { root: instrument } map. */
function quoteRoots(instruments, base) {
  const list = Array.isArray(instruments) ? instruments : Object.values(instruments || {});
  const q = list.filter(i => i && typeof i.root === 'string' && i.quoteOnly === true).map(i => i.root);
  const known = QUOTE_ONLY.filter(r => q.includes(r)), other = q.filter(r => !QUOTE_ONLY.includes(r)).sort();
  const out = (base || []).slice();
  for (const r of known.concat(other)) if (!out.includes(r)) out.push(r);
  return out;
}
/** Decimals that show every tick exactly: 0.25 -> 2, 0.005 -> 3, 0.00005 -> 5, 1 -> 0. */
function decimalsOf(tick) {
  if (!(tick > 0)) return 2;
  for (let d = 0; d <= 8; d++) if (Math.abs(Math.round(tick * Math.pow(10, d)) - tick * Math.pow(10, d)) < 1e-6) return d;
  return 8;
}
/** A number with thousands separators and `dec` decimals: 46210 -> "46,210", -1204.5 -> "-1,204.50". */
function fmtNum(v, dec) {
  const s = Math.abs(v).toFixed(dec), i = s.indexOf('.'), int = i < 0 ? s : s.slice(0, i), frac = i < 0 ? '' : s.slice(i);
  return (v < 0 && +s !== 0 ? '-' : '') + int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + frac;
}
/**
 * NinjaTrader's bond prices (ZN, ZB; hello priceFormat "32nds"): the whole points, an apostrophe, the 32nds in two digits;
 * with a tick under 1/32 (ZN's 1/64) a third digit for the half, 0 or 5. ZB 118.46875 -> 118'15, ZN 104.109375 -> 104'035.
 * The price is taken to the nearest tick of the format (1/64 or 1/32).
 */
function fmt32(p, tick) {
  if (!isNum(p)) return '';
  const half = tick > 0 && tick < 1 / 32 - 1e-12, per = half ? 64 : 32;
  const steps = Math.round(Math.abs(p) * per), whole = Math.floor(steps / per), rest = steps - whole * per;
  const n32 = half ? Math.floor(rest / 2) : rest;
  return (p < 0 && steps ? '-' : '') + whole + "'" + (n32 < 10 ? '0' : '') + n32 + (half ? (rest % 2 ? '5' : '0') : '');
}
/** A price as the Quote board shows it: 32nds for priceFormat "32nds", else the tick's decimals with separators. */
function priceText(p, instr) {
  if (!isNum(p)) return '';
  const i = instr || {}, tick = +i.tick || 0.25;
  return i.priceFormat === '32nds' ? fmt32(p, tick) : fmtNum(p, decimalsOf(tick));
}
/** A change (last minus the prior settlement) in the instrument's own format, signed: +0'045, -12.50; '' for null. */
function changeText(v, instr) {
  if (!isNum(v)) return '';
  const t = priceText(Math.abs(v), instr);
  return (/[1-9]/.test(t) ? (v > 0 ? '+' : '-') : '') + t;                 // no sign on a change that shows as zero
}

/* ---------------- money */
/** Dollars as the panels show them: +$412.50, -$22.00, $0.00; '' for null. */
function fmtUsd(v) { return !isNum(v) ? '' : (v > 0.004 ? '+' : v < -0.004 ? '-' : '') + '$' + fmtNum(Math.abs(v), 2); }
/** Dollars without a sign: $51,240.50 (a balance, a room). */
function fmtUsdPlain(v) { return !isNum(v) ? '' : (v < 0 ? '-' : '') + '$' + fmtNum(Math.abs(v), 2); }

/* ---------------- limits (item 15): the room used to the closer of the daily loss and the trailing drawdown */
const AMBER = 0.70, RED = 0.90;
/**
 * The limit state of one account, from ChartBridge's `accounts` entry `a` and The Desk's row `d` (GET /api/chart-accounts,
 * or null). Never estimated (lead's default, written in nt8/PROTOCOL.md "Account page"):
 *   daily loss   room: ChartBridge's roomDailyLoss, else The Desk's daily_loss_limit less today's loss (pnlToday below 0);
 *                limit: The Desk's daily_loss_limit, else ChartBridge's room plus today's loss
 *   drawdown     room: ChartBridge's roomDrawdown only (The Desk has no high-water mark); limit: The Desk's trailing_drawdown
 *   used         (limit - room) / limit, 0 to 1 (a room at or below 0 is 1)
 * The closer is the one with the least room in dollars; its percent sets the level (amber at 70 percent, red at 90). When
 * the closer's limit is not known, the other's percent is used; a room at or below 0 is always red.
 * Returns { level: '' | 'amber' | 'red', pct (0 to 1 or null), closer: 'dl' | 'dd' | null, dl, dd } with dl and dd each
 * { room, limit, pct, from: 'ninjatrader' | 'desk' } or null.
 */
function limitState(a, d) {
  a = a || {}; d = d || {};
  const loss = isNum(a.pnlToday) ? Math.max(0, -a.pnlToday) : null;
  const deskDl = isNum(d.daily_loss_limit) && d.daily_loss_limit > 0 ? d.daily_loss_limit : null;
  const deskDd = isNum(d.trailing_drawdown) && d.trailing_drawdown > 0 ? d.trailing_drawdown : null;
  let dl = null, dd = null;
  if (isNum(a.roomDailyLoss)) dl = { room: a.roomDailyLoss, limit: deskDl !== null ? deskDl : loss !== null ? a.roomDailyLoss + loss : null, from: 'ninjatrader' };
  else if (deskDl !== null) dl = { room: loss !== null ? deskDl - loss : null, limit: deskDl, from: 'desk' };
  if (isNum(a.roomDrawdown)) dd = { room: a.roomDrawdown, limit: deskDd, from: 'ninjatrader' };
  else if (deskDd !== null) dd = { room: null, limit: deskDd, from: 'desk' };
  for (const x of [dl, dd]) {
    if (!x) continue;
    x.pct = x.room !== null && x.room <= 0 ? 1 : x.room !== null && x.limit > 0 ? Math.min(1, Math.max(0, (x.limit - x.room) / x.limit)) : null;
  }
  const withRoom = [['dl', dl], ['dd', dd]].filter(([, x]) => x && x.room !== null).sort((p, q) => p[1].room - q[1].room);
  const closer = withRoom.length ? withRoom[0][0] : null;
  const c = closer === 'dl' ? dl : closer === 'dd' ? dd : null, other = closer === 'dl' ? dd : dl;
  let pct = c && c.pct !== null ? c.pct : other && other.pct !== null ? other.pct : null;
  if (c && c.room <= 0) pct = 1;
  const level = pct === null ? '' : pct >= RED - 1e-9 ? 'red' : pct >= AMBER - 1e-9 ? 'amber' : '';
  return { level, pct, closer, dl, dd };
}
/** The room cell's text: "DD $1,740.50 · DL $820.00" with the percent used of the closer, or '' with nothing known. */
function limitText(s) {
  if (!s) return '';
  const part = (k, x) => x && x.room !== null ? k + ' ' + fmtUsdPlain(x.room) : x && x.limit !== null ? k + ' limit ' + fmtUsdPlain(x.limit) : '';
  const t = [part('DD', s.dd), part('DL', s.dl)].filter(Boolean).join(' · ');
  return t + (s.pct !== null && t ? ' (' + Math.round(s.pct * 100) + '% used)' : '');
}

/* ---------------- Today's trades (item 14): flat-to-flat round trips per account and instrument */
const SESSION = 18 * 3600;
/** The trading day (from 18:00 ET) of bar time t, as days since 1970; dayText gives its date for The Desk's Review. */
const tradeDayOf = t => Math.floor((t + 86400 - SESSION) / 86400);
const dayText = d => new Date(d * 86400000).toISOString().slice(0, 10);
/**
 * Round trips from one account's fills (any order; { id, root, side, qty, p, t }), flat to flat per instrument, by average
 * price. `start` { root: signed qty } is the position before the first fill (not 0: that first trip's price is unknown, so
 * its gross is null). Returns [{ root, side ('long' | 'short'), qty (the largest size held), openT, closeT (null while
 * open), entry, exit (average prices, null when unknown), gross (dollars of the closed part, null when unknown), contracts
 * (every fill's qty added: what commission is charged on), fills (ids), open (bool) }] by open time.
 */
function roundTrips(fills, pointValue, start) {
  const list = (Array.isArray(fills) ? fills : []).filter(f => f && (f.side === 'buy' || f.side === 'sell') && +f.qty > 0 && isFinite(f.p) && isFinite(f.t))
    .slice().sort((a, b) => a.t - b.t || String(a.id).localeCompare(String(b.id)));
  const st = {}, out = [];
  for (const f of list) {
    const r = f.root, pv = +pointValue(r) || 0, q = (f.side === 'buy' ? 1 : -1) * +f.qty, p = +f.p;
    if (!st[r]) { const q0 = start && +start[r] ? +start[r] : 0; st[r] = { pos: q0, avg: null, known: q0 === 0, trip: null }; }
    const x = st[r];
    if (!x.trip) {
      x.trip = { root: r, side: (x.pos || q) > 0 ? 'long' : 'short', qty: Math.abs(x.pos), openT: +f.t, closeT: null, entry: null, exit: null,
        gross: x.known ? 0 : null, contracts: 0, fills: [], open: true, exitQty: 0, exitSum: 0 };
      out.push(x.trip);
    }
    const T = x.trip;
    T.contracts += +f.qty; T.fills.push(f.id);
    let rest = q;
    if (x.pos !== 0 && Math.sign(rest) !== Math.sign(x.pos)) {              // closes all or part of the position
      const close = Math.sign(rest) * Math.min(Math.abs(rest), Math.abs(x.pos));
      if (x.avg !== null && T.gross !== null) T.gross += (p - x.avg) * -close * pv; else T.gross = null;
      T.exitQty += Math.abs(close); T.exitSum += Math.abs(close) * p;
      x.pos += close; rest -= close;
      if (x.pos === 0) {                                                   // flat: the trip is done
        T.open = false; T.closeT = +f.t; T.exit = T.exitSum / T.exitQty;
        x.trip = null; x.avg = null; x.known = true;
        if (rest !== 0) {                                                 // the same fill turns the position: a new trip
          T.contracts -= Math.abs(rest);                                  // its commission is split as its contracts
          x.trip = { root: r, side: rest > 0 ? 'long' : 'short', qty: 0, openT: +f.t, closeT: null, entry: null, exit: null, gross: 0, contracts: Math.abs(rest), fills: [f.id], open: true, exitQty: 0, exitSum: 0 };
          out.push(x.trip);
        }
      }
    }
    if (rest !== 0) {                                                      // opens or adds
      x.avg = x.pos === 0 || x.avg === null ? p : (x.avg * Math.abs(x.pos) + p * Math.abs(rest)) / (Math.abs(x.pos) + Math.abs(rest));
      if (x.pos !== 0 && !x.known) x.avg = null;                           // added to a position from before: price not known
      x.pos += rest;
      x.trip.qty = Math.max(x.trip.qty, Math.abs(x.pos));
      x.trip.entry = x.avg;                                                // null when the start was not known
    }
  }
  for (const T of out) { if (T.gross !== null) T.gross = Math.round(T.gross * 100) / 100; delete T.exitQty; delete T.exitSum; }
  return out;
}
/** Net of one trip: gross less the commission per side for its instrument on every contract filled; null when either is
    unknown (`rate(root)` is dollars per contract per side, or null). */
function netOf(trip, rate) {
  const c = rate ? rate(trip.root) : null;
  return trip.gross === null || !isNum(c) ? null : Math.round((trip.gross - c * trip.contracts) * 100) / 100;
}
/**
 * Today's trades for the Account page: one group per account with a fill today (from 18:00 ET at bar time `now`), by name.
 * `posOf(account, root)` is the position now (signed), so the position before today's first fill is known; `rateOf(account)`
 * gives that account's `rate(root)` (The Desk's commission per side) or null. Each group: { account, fills (newest first),
 * trips (newest first, each with net), gross (closed trips; null when one is unknown), net (null when one is unknown),
 * day (the date text for The Desk's Review) }.
 */
function tradesToday(fills, now, pointValue, posOf, rateOf) {
  const day = tradeDayOf(now), by = new Map();
  for (const f of Array.isArray(fills) ? fills : []) {
    if (!f || typeof f.account !== 'string' || !isFinite(f.t) || tradeDayOf(+f.t) !== day) continue;
    const g = by.get(f.account) || []; g.push(Object.assign({}, f, { qty: +f.qty, p: +f.p, t: +f.t })); by.set(f.account, g);
  }
  const out = [];
  for (const account of [...by.keys()].sort()) {
    const today = by.get(account), start = {};
    for (const f of today) {
      if (f.root in start) continue;
      const net = today.filter(x => x.root === f.root).reduce((a, x) => a + (x.side === 'buy' ? 1 : -1) * x.qty, 0);
      start[f.root] = (+posOf(account, f.root) || 0) - net;
    }
    const rate = rateOf ? rateOf(account) : null;
    const trips = roundTrips(today, pointValue, start).map(t => Object.assign(t, { net: netOf(t, rate) }));
    const closed = trips.filter(t => !t.open);
    const sum = k => closed.some(t => t[k] === null) ? null : Math.round(closed.reduce((a, t) => a + t[k], 0) * 100) / 100;
    out.push({ account, fills: today.slice().sort((a, b) => b.t - a.t), trips: trips.slice().reverse(), gross: sum('gross'), net: sum('net'), day: dayText(day) });
  }
  return out;
}

/* ---------------- The Desk (GET /api/chart-accounts, read only) */
/**
 * The Desk's rows by account: { daily_loss_limit, trailing_drawdown, account_size, archived, firm, commission }. Numbers
 * must be finite and above 0 (else null). `commission` is { ROOT: dollars per contract per side } when The Desk sends it
 * (lead's default: an optional key per row, the rate The Desk itself uses, the firm's default when the account has none);
 * without it, net is not shown. Bad shapes give an empty map; never throws.
 */
function cleanDesk(json) {
  const out = new Map();
  const list = json && Array.isArray(json.accounts) ? json.accounts : [];
  const n = v => (isNum(v) && v > 0 ? v : null);
  for (const r of list) {
    if (!r || typeof r.account !== 'string' || !r.account || r.account.length > 200) continue;
    const com = {};
    if (r.commission && typeof r.commission === 'object' && !Array.isArray(r.commission))
      for (const k of Object.keys(r.commission)) if (/^[A-Z0-9]{1,6}$/.test(k) && isNum(r.commission[k]) && r.commission[k] >= 0 && r.commission[k] <= 100) com[k] = r.commission[k];
    out.set(r.account, { daily_loss_limit: n(r.daily_loss_limit), trailing_drawdown: n(r.trailing_drawdown), account_size: n(r.account_size),
      archived: r.archived === true, firm: typeof r.firm === 'string' ? r.firm : null, commission: Object.keys(com).length ? com : null });
  }
  return out;
}
/** The Desk's Review of one session (its trade day), on The Desk at `deskUrl` (#/futures/review/<date>). */
function reviewUrl(deskUrl, day) {
  const base = typeof deskUrl === 'string' && /^https?:\/\/[^\s"'<>]+$/.test(deskUrl) ? deskUrl.replace(/\/+$/, '') : 'http://localhost:8800';
  return base + '/#/futures/review/' + encodeURIComponent(day);
}

/* ---------------- the copier (PROTOCOL.md "Copier engine"): a row per account but the leader, each marked SIM or LIVE */
const FOLLOWER_DEFAULT = { on: false, qty: 1, size: 'micro', lossLimit: null };
/** SIM or LIVE (Anthony 2026-10-07): SIM only when ChartBridge says sim true; anything else is LIVE (the careful side). */
const accountMark = sim => (sim === true ? 'SIM' : 'LIVE');
/**
 * The Copier tab's rows: every watched account but the leader, Sim or LIVE (Anthony 2026-10-07: no Sim lock; ChartBridge's
 * account gates decide), each with a saved follower's settings, else off, 1, micro, no loss limit; then any saved follower
 * the accounts list does not name (shown with ChartBridge's own words). Each row carries sim and its mark. By name.
 */
function followerRows(accounts, copier) {
  const leader = copier && copier.leader ? copier.leader.account : null;
  const saved = new Map(((copier && copier.followers) || []).filter(f => f && typeof f.account === 'string').map(f => [f.account, f]));
  const rows = [];
  for (const a of accounts || []) {
    if (!a || typeof a.name !== 'string' || a.name === leader || a.state === 'archived') continue;
    const f = saved.get(a.name);
    rows.push(Object.assign({ account: a.name, sim: a.sim === true, mark: accountMark(a.sim), saved: !!f, connection: a.connection }, FOLLOWER_DEFAULT, f ? {
      on: !!f.on, qty: Number.isInteger(f.qty) && f.qty >= 1 && f.qty <= 9 ? f.qty : 1, size: f.size === 'mini' ? 'mini' : 'micro',
      lossLimit: Number.isInteger(f.lossLimit) && f.lossLimit >= 1 ? f.lossLimit : null, root: f.root || null, position: f.position || null,
      lastAction: f.lastAction || null, lastAt: f.lastAt || null, slippageTicks: isNum(f.slippageTicks) ? f.slippageTicks : null,
      skipped: typeof f.skipped === 'string' && f.skipped ? f.skipped : null, pnlToday: isNum(f.pnlToday) ? f.pnlToday : null } : {}));
  }
  for (const f of saved.values()) if (!rows.some(r => r.account === f.account) && f.account !== leader)
    rows.push(Object.assign({ account: f.account, sim: f.sim === true, mark: accountMark(f.sim), saved: true }, FOLLOWER_DEFAULT, { on: !!f.on,
      qty: Number.isInteger(f.qty) && f.qty >= 1 && f.qty <= 9 ? f.qty : 1, size: f.size === 'mini' ? 'mini' : 'micro',
      lossLimit: Number.isInteger(f.lossLimit) && f.lossLimit >= 1 ? f.lossLimit : null, skipped: typeof f.skipped === 'string' && f.skipped ? f.skipped : null }));
  return rows.sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
}
/** The `copierFollower` message for a row (every key, as the contract requires), or a plain reason it cannot be sent. */
function followerMessage(row, cid) {
  const qty = +row.qty, ll = row.lossLimit === null || row.lossLimit === '' || row.lossLimit === undefined ? null : Number(row.lossLimit);
  if (!Number.isInteger(qty) || qty < 1 || qty > 9) return { error: 'Quantity: 1 to 9 contracts per leader contract.' };
  if (row.size !== 'micro' && row.size !== 'mini') return { error: 'Size: micro or mini.' };
  if (ll !== null && (!Number.isInteger(ll) || ll < 1 || ll > 999999999)) return { error: 'Daily loss: whole dollars, 1 or more.' };
  return { msg: Object.assign({ type: 'copierFollower' }, cid ? { cid } : {}, { account: row.account, on: !!row.on, qty, size: row.size, lossLimit: ll }) };
}

/* ---------------- the Log tab */
/** A changed account, in words, from the previous and the next `accounts` entry (null when nothing worth a line changed). */
function accountChange(prev, next) {
  if (!next) return null;
  if (!prev) return null;
  const out = [];
  if (prev.state !== next.state) out.push(next.state === 'gone' ? 'gone (' + (next.goneWhy || 'unknown') + '): trading is off for it' : 'back: ' + next.connection + ' (the checkmark stays off)');
  else if (prev.connection !== next.connection) out.push('connection ' + next.connection);
  if (prev.trade !== next.trade && prev.state === next.state) out.push(next.trade ? 'checked for trading' : 'unchecked for trading');
  return out.length ? next.name + ': ' + out.join('; ') : null;
}
/** A message from ChartBridge as one Log line, or null for messages the Log does not keep. */
function logText(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.type === 'reject') return 'Refused by ChartBridge: ' + (m.reason || '');
  if (m.type === 'status' && m.text) return (m.level === 'error' ? 'Error: ' : m.level === 'warn' ? 'Warning: ' : '') + m.text;
  if (m.type === 'copierEvent') return 'Copier' + (m.account ? ' ' + m.account : '') + ': ' + (m.text || m.action) +
    (isNum(m.slippageTicks) ? ' (slippage ' + m.slippageTicks + ' t)' : '') + (isNum(m.leaderMs) ? ' (' + m.leaderMs + ' ms from the leader' + (isNum(m.fillMs) ? ', filled in ' + m.fillMs + ' ms' : '') + ')' : '');
  return null;
}

/* ---------------- orders */
const SIDE = { buy: 'Buy', sell: 'Sell' };
const KIND = { market: 'market', limit: 'limit', stop: 'stop', stopLimit: 'stop limit', mit: 'MIT', other: 'order' };
/** "Buy limit", "Sell stop (target)", with what placed it (strategy, merge, copier, bot) when a v3 feature did; an agent's
 *  order (1.17.0, `by: "agent:<id>"`) says "agent <id>". */
function orderName(o) {
  const role = o.role === 'stop' ? 'stop' : o.role === 'target' ? 'target' : '';
  const kind = role === 'target' ? 'target' : role === 'stop' && o.kind === 'stop' ? 'stop' : KIND[o.kind] || 'order';
  return (SIDE[o.side] || '') + ' ' + kind + (role === 'stop' && o.kind !== 'stop' ? ' (stop)' : '') + (o.by ? ' · ' + String(o.by).replace(/^agent:/, 'agent ') : '');
}
/** The working stop and target on one account and instrument: { stop: [prices], target: [prices] } (role from ChartBridge). */
function attachedLegs(orders, account, root) {
  const out = { stop: [], target: [] };
  for (const o of orders || []) {
    if (!o || o.account !== account || o.root !== root || !(o.state === 'working' || o.state === 'partFilled')) continue;
    if (o.role === 'stop' && isNum(o.price)) out.stop.push(o.price);
    else if (o.role === 'target' && isNum(o.price)) out.target.push(o.price);
  }
  return out;
}
const WORKING = new Set(['working', 'partFilled', 'cancelling']);
const isWorking = o => !!o && WORKING.has(o.state);

return { QUOTE_ONLY, quoteRoots, decimalsOf, fmtNum, fmt32, priceText, changeText, fmtUsd, fmtUsdPlain, AMBER, RED, limitState, limitText,
  tradeDayOf, dayText, roundTrips, netOf, tradesToday, cleanDesk, reviewUrl, FOLLOWER_DEFAULT, accountMark, followerRows, followerMessage,
  accountMark, accountChange, logText, orderName, attachedLegs, isWorking };
});

/* ======================================================================== AccountsPage (browser only) */
if (typeof window !== 'undefined' && typeof document !== 'undefined') window.AccountsPage = (function () {
'use strict';
const AC = window.AccountsCore;
const SWITCH_KEYS = ['accountChecks', 'orderTypes', 'strategies', 'merge', 'cancelFromList', 'copier', 'bot'];
const LOG_MAX = 200;
const DESK_EVERY_MS = 60000;
const DESK_DEFAULT = 'http://localhost:8800';

/**
 * The Desk's address, the page's one source of truth (1.16.0): ChartBridge's `deskUrl` in config.txt, read from its /diag
 * (`desk.deskUrl`; this PC only, as the page is). ChartBridge already sends its fills there, so one line in config.txt
 * sets it for the Account page, the shared hotkeys and Order Strategies, and the Bot tab alike. ChartBridge's default,
 * http://localhost:8800, when /diag has none. Read once per page load; a failed read is tried again on the next ask.
 */
let deskAsk = null, deskKnown = '';
function deskBase(fetchFn) {
  if (deskAsk) return deskAsk;
  const f = fetchFn || ((u, o) => fetch(u, o));
  const p = Promise.resolve().then(() => f('/diag', { cache: 'no-store' })).then(r => (r.ok ? r.json() : null)).then(j => {
    const u = j && j.desk && typeof j.desk.deskUrl === 'string' ? j.desk.deskUrl : '';
    deskKnown = /^https?:\/\/[^\s"'<>]+$/.test(u) ? u.replace(/\/+$/, '') : DESK_DEFAULT;
    return deskKnown;
  }, () => { deskAsk = null; return DESK_DEFAULT; });
  deskAsk = p;
  return p;
}
/** the address read so far (for a label), or ChartBridge's default before the first answer */
const deskNow = () => deskKnown || DESK_DEFAULT;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const p2 = n => (n < 10 ? '0' : '') + n;
/* a UTC time in ms as the page's clock shows it: New York time, HH:MM:SS */
const etFmt = (() => { try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (e) { return null; } })();
const hms = ms => { if (etFmt) return etFmt.format(new Date(ms)); const d = new Date(ms); return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()); };

/**
 * The window's v3 connection to ChartBridge, one per window. env:
 *   wsUrl()       the WebSocket address (may return a promise: the PIN unlock)
 *   pin           ChartBridgePin or null (its headers() for GET /session)
 *   framed        true inside another page's frame: never signs in
 *   fetch(u, o)   window.fetch
 *   changed()     the state changed: the host redraws (the panels, the charts' limit warnings)
 *   note(text, warn)  a short note in the window
 *   orderSend(m)  sends an order action on the order ticket's connection (the one order path); true when sent
 *   desk          false: never reads The Desk's limits (the Bot window has no Account page)
 * start(features) opens it when ChartBridge's hello lists "v3" (else it stays closed: nothing new with an older one);
 * startAny() connects at once and lets ChartBridge's own hello decide (the Bot window, which has no other connection).
 * listen({ message, closed }) hands every message ChartBridge sends on it, and the drop, to another part of the window;
 * post(m) sends one of that part's v3 messages (true when sent).
 */
function createFeed(env) {
  const S = {
    v3: false, open: false, signedIn: false, enabled: false, reason: 'Not connected to ChartBridge yet.', trading: null, version: '',
    switches: Object.fromEntries(SWITCH_KEYS.map(k => [k, false])), tradeAccounts: [],
    accounts: [], archived: [], got: false, instruments: {}, orders: new Map(), positions: new Map(), fills: new Map(),
    copier: null, log: [], desk: new Map(), deskUrl: '', deskState: 'not asked', deskAt: 0,
  };
  let ws = null, tries = 0, timer = 0, seq = 0, started = false, deskTimer = 0, changeQueued = false, stopped = false;
  const changed = () => { if (changeQueued) return; changeQueued = true; Promise.resolve().then(() => { changeQueued = false; env.changed(); }); };
  const log = (text, level) => { if (!text) return; S.log.unshift({ at: Date.now(), text, level: level || '' }); if (S.log.length > LOG_MAX) S.log.length = LOG_MAX; };
  const cid = () => 'ap' + Date.now().toString(36) + '-' + (++seq);
  const mine = new Map();                                 // cid -> what was asked (its refusal goes to the window's note)
  const subs = new Set();                                // listen(): the window's other v3 parts
  const tell = (k, m) => { for (const s of subs) { if (typeof s[k] === 'function') { try { s[k](m); } catch (e) { setTimeout(() => { throw e; }); } } } };

  function start(features) {
    const v3 = Array.isArray(features) && features.includes('v3');
    if (!v3) { if (started) stop(); S.v3 = false; S.reason = 'The Account page needs ChartBridge 0.4.0 or newer.'; changed(); return; }
    S.v3 = true;
    if (started) return;
    started = true; stopped = false;
    connect();
    if (env.desk !== false) readDesk();
  }
  function startAny() {
    if (started) return;
    started = true; stopped = false;
    connect();
  }
  function stop() {
    started = false; stopped = true; clearTimeout(timer); clearTimeout(deskTimer);
    const s = ws; ws = null; S.open = false; S.signedIn = false; S.enabled = false;
    if (s) { s.onopen = s.onmessage = s.onclose = s.onerror = null; try { s.close(); } catch (e) { /* closed */ } }
  }
  function connect() {
    timer = 0;
    if (stopped) return;
    Promise.resolve().then(() => env.wsUrl()).then(url => {
      let sock;
      try { sock = new WebSocket(url); } catch (e) { retry(); return; }
      ws = sock;
      sock.onopen = () => { if (sock === ws) { tries = 0; S.open = true; } };
      sock.onmessage = ev => { if (sock !== ws) return; let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (!m || typeof m !== 'object') return; message(m, sock); tell('message', m); };
      sock.onclose = () => {
        if (sock !== ws) return;
        ws = null; S.open = false; S.signedIn = false; S.enabled = false; S.reason = 'Not connected to ChartBridge.'; S.trading = null;
        S.switches = Object.fromEntries(SWITCH_KEYS.map(k => [k, false]));      // controls go until ChartBridge names them again
        changed(); tell('closed'); retry();
      };
      sock.onerror = () => { /* onclose follows */ };
    }, retry);
  }
  function retry() { if (stopped) return; tries++; timer = setTimeout(connect, Math.min(5000, 500 * tries)); }
  const remember = obj => { if (obj.cid) { mine.set(obj.cid, obj.type); if (mine.size > 100) mine.delete(mine.keys().next().value); } };
  function send(obj) {
    if (!ws || ws.readyState !== 1) { env.note('Not sent: not connected to ChartBridge.', true); return false; }
    ws.send(JSON.stringify(obj));
    remember(obj);
    return true;
  }
  /* an order action of this page (cancel from the list) goes on the order ticket's connection, the one order path; its
     refusal comes back there and the host hands it to takeReject */
  function sendOrder(obj) {
    if (typeof env.orderSend !== 'function' || !env.orderSend(obj)) { env.note('Not sent: not connected to ChartBridge.', true); return false; }
    remember(obj);
    return true;
  }
  /** another part's v3 message on this connection: true when sent (it shows its own note when not) */
  function post(obj) {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }
  function signIn(sock) {
    if (env.framed) { S.reason = 'This page is inside another page (a frame): the Account page is read only here.'; changed(); return; }
    env.fetch('/session', { cache: 'no-store', headers: env.pin ? env.pin.headers() : {} })
      .then(r => (r.ok ? r.text() : Promise.reject(new Error('GET /session answered ' + r.status))))
      .then(body => {
        let token = null;
        try { const j = JSON.parse(body); token = typeof j === 'string' ? j : j && j.token; } catch (e) { token = body.trim(); }
        if (!token) throw new Error('no token in GET /session');
        if (sock === ws && sock.readyState === 1) sock.send(JSON.stringify({ type: 'auth', token }));
      })
      .catch(e => { if (sock !== ws) return; S.reason = 'Could not sign in to ChartBridge (' + e.message + ').'; changed(); setTimeout(() => { if (sock === ws) signIn(sock); }, 5000); });
  }
  function message(m, sock) {
    switch (m.type) {
      case 'hello': {
        S.instruments = {};
        for (const i of m.instruments || []) if (i && typeof i.root === 'string') S.instruments[i.root] = i;
        const v3 = Array.isArray(m.features) && m.features.includes('v3');
        S.v3 = v3; S.version = typeof m.version === 'string' ? m.version : '';
        if (!v3) { S.reason = 'The Account page needs ChartBridge 0.4.0 or newer.'; changed(); return; }
        sock.send(JSON.stringify({ type: 'client', v: 3 }));      // first, right after hello (PROTOCOL.md "Telling the page what is on")
        S.orders.clear(); S.positions.clear();
        signIn(sock);
        changed();
        return;
      }
      case 'client': return;
      case 'trading': {
        S.signedIn = true; S.enabled = !!m.enabled; S.reason = m.enabled ? '' : m.reason || 'Trading is off.'; S.trading = m;
        S.tradeAccounts = Array.isArray(m.accounts) ? m.accounts.slice() : [];
        const sw = m.switches && typeof m.switches === 'object' ? m.switches : {};
        S.switches = Object.fromEntries(SWITCH_KEYS.map(k => [k, m.enabled === true && sw[k] === true]));   // strictly true
        if (!S.switches.copier) S.copier = null;
        changed(); return;
      }
      case 'accounts': {
        const prev = new Map(S.accounts.map(a => [a.name, a]));
        const list = Array.isArray(m.list) ? m.list.filter(a => a && typeof a.name === 'string') : [];
        if (S.got) for (const a of list) log(AC.accountChange(prev.get(a.name), a), a.state === 'gone' ? 'warn' : '');
        const was = new Set(S.archived.map(a => a.name));
        S.archived = Array.isArray(m.archived) ? m.archived.filter(a => a && typeof a.name === 'string') : [];
        if (S.got) for (const a of S.archived) if (!was.has(a.name)) log(a.name + ': archived');
        S.accounts = list; S.got = true;
        changed(); return;
      }
      case 'orders': S.orders.clear(); for (const o of m.list || []) if (o && o.id) S.orders.set(o.id, o); changed(); return;
      case 'order': if (!m.id) return; if (AC.isWorking(m)) S.orders.set(m.id, m); else S.orders.delete(m.id); changed(); return;
      case 'position': if (m.account && m.root) { if (m.qty) S.positions.set(m.account + '|' + m.root, { qty: m.qty, avgPrice: m.avgPrice }); else S.positions.delete(m.account + '|' + m.root); changed(); } return;
      case 'execs': S.fills.clear(); for (const f of m.list || []) if (f && f.id) S.fills.set(f.account + '|' + f.id, f); changed(); return;
      case 'exec': if (m.id) { S.fills.set(m.account + '|' + m.id, m); changed(); } return;
      case 'copier': S.copier = m; changed(); return;
      case 'copierEvent': log(AC.logText(m), m.action === 'skip' || m.action === 'standDown' || m.action === 'refused' ? 'warn' : ''); changed(); return;
      case 'reject': {
        log(AC.logText(m), 'warn');
        if (m.cid && mine.has(m.cid)) { mine.delete(m.cid); env.note('Refused by ChartBridge: ' + m.reason, true); }
        changed(); return;
      }
      case 'status': log(AC.logText(m), m.level === 'error' ? 'error' : m.level === 'warn' ? 'warn' : ''); changed(); return;
    }
  }
  /* The Desk's limits (read only): its address as ChartBridge knows it (/diag desk.deskUrl), then GET /api/chart-accounts
     now and every minute while the feed runs. A failure leaves the last rows and says so in the Accounts tab. */
  function readDesk() {
    clearTimeout(deskTimer);
    if (stopped) return;
    deskBase(env.fetch).then(url => { S.deskUrl = url; return env.fetch(url + '/api/chart-accounts', { cache: 'no-store', mode: 'cors', credentials: 'omit' }); })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('The Desk answered ' + r.status))))
      .then(j => { S.desk = AC.cleanDesk(j); S.deskState = 'ok'; S.deskAt = Date.now(); }, e => { S.deskState = 'The Desk\'s limits could not be read (' + (e && e.message ? e.message : 'not reachable') + ').'; })
      .then(() => { changed(); if (!stopped) deskTimer = setTimeout(readDesk, DESK_EVERY_MS); });
  }
  const account = name => S.accounts.find(a => a.name === name) || null;
  const limit = name => { const a = account(name); return a ? AC.limitState(a, S.desk.get(name)) : null; };
  return {
    S, start, startAny, stop, account, limit, post,
    listen(part) { subs.add(part); return () => subs.delete(part); },
    /** a refusal that came back on the order ticket's connection for an action of this page: true when it was one */
    takeReject(m) { if (!m || !m.cid || !mine.has(m.cid)) return false; message(m); return true; },
    /** the limit warning level of an account: '', 'amber' or 'red' */
    level: name => { const s = limit(name); return s ? s.level : ''; },
    /* the page's v3 actions, exactly the contract's messages; each only when its switch is on (ChartBridge checks again) */
    accountTrade: (name, on) => S.switches.accountChecks && send({ type: 'accountTrade', cid: cid(), account: name, on: !!on }),
    accountArchive: name => S.switches.accountChecks && send({ type: 'accountArchive', cid: cid(), account: name, confirm: true }),
    accountUnarchive: name => S.switches.accountChecks && send({ type: 'accountUnarchive', cid: cid(), account: name }),   // ChartBridge 0.5.1: Show
    cancelFromList: id => S.switches.cancelFromList && sendOrder({ type: 'cancel', cid: cid(), id, from: 'list' }),
    copierSet: (what) => S.switches.copier && send(Object.assign({ type: 'copierSet', cid: cid() }, what)),
    copierFollower: row => {
      if (!S.switches.copier) return false;
      const r = AC.followerMessage(row, cid());
      if (r.error) { env.note('Not sent: ' + r.error, true); return false; }
      return send(r.msg);
    },
    copierRearm: () => S.switches.copier && send({ type: 'copierRearm', cid: cid() }),
    rateOf: name => { const d = S.desk.get(name); return d && d.commission ? r => (d.commission[r] === undefined ? null : d.commission[r]) : null; },
    _message: message,                                    // tests
  };
}

/* ---------------- the panel */
const TABS = [
  { id: 'acc', name: 'Accounts', short: 'Accts' }, { id: 'pos', name: 'Positions', short: 'Pos' }, { id: 'ord', name: 'Working orders', short: 'Orders' },
  { id: 'trd', name: 'Today\'s trades', short: 'Trades' }, { id: 'cop', name: 'Copier', short: 'Copier', when: S => S.switches.copier }, { id: 'log', name: 'Log', short: 'Log' },
];
const CONN = { connected: 'Connected', connecting: 'Connecting', lost: 'Lost', disconnected: 'Disconnected' };
const GONE_WHY = { disconnected: 'disconnected', disabled: 'disabled in NinjaTrader', drawdown: 'past the trailing drawdown', dailyLoss: 'past the daily loss limit' };

/**
 * Mount the Account page in a workspace panel view `v` ({ el, body, head }). host:
 *   feed               the window's createFeed
 *   watchQuote(root)   the window's price line for an instrument (returns the undo); quoteOf(root) its { last }
 *   quoteSubs          the Set of renders the price lines call (at most 4 times a second)
 *   fitPanel(v, fn)    the size classes (returns the undo)
 *   note(text, warn)   the window's note
 *   now()              bar time now (New York wall clock as seconds)
 * Returns { render, destroy }.
 */
function mount(v, host) {
  const F = host.feed, S = F.S;
  v.body.innerHTML = '<div class="apg" data-ap>' +
    '<div class="ac-tabs apg-tabs" role="tablist" aria-label="Account page">' + TABS.map((t, i) => `<button type="button" role="tab" class="ac-tab" data-tab="${t.id}" aria-selected="${i === 0}"${t.when ? ' hidden' : ''}><span class="lb-full">${esc(t.name)}</span><span class="lb-short">${esc(t.short)}</span><span class="ac-ct" data-ct="${t.id}"></span></button>`).join('') + '</div>' +
    '<div class="ac-list apg-list" data-list role="tabpanel"></div>' +
    '<p class="ac-foot apg-foot" data-foot></p></div>';
  const q = sel => v.body.querySelector(sel);
  const listEl = q('[data-list]'), footEl = q('[data-foot]');
  const P = { tab: 'acc', key: '', cells: [], props: [], confirm: '', trd: 'trips', offs: new Map(), llPending: new Set() };
  q('.apg-tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    b.blur();
    P.tab = b.dataset.tab; P.confirm = '';
    for (const t of v.body.querySelectorAll('.ac-tab[data-tab]')) t.setAttribute('aria-selected', String(t === b));
    render();
  });
  /* clicks: a button acts at once, as the order ticket's (by mouse only: a key press on a focused button does nothing) */
  listEl.addEventListener('click', e => {
    const b = e.target.closest('button[data-act], [data-review]');
    if (!b || !listEl.contains(b)) return;
    if (b.dataset.review) { window.open(AC.reviewUrl(S.deskUrl, b.dataset.review), '_blank', 'noopener'); return; }
    b.blur();
    if (e.detail === 0) { host.note('The Account page\'s buttons work by click only, not by keyboard.', true); return; }
    const a = b.dataset.act, id = b.dataset.id || '';
    if (a === 'archive') { P.confirm = id; render(); }
    else if (a === 'archive-no') { P.confirm = ''; render(); }
    else if (a === 'archive-yes') { if (P.confirm === id) F.accountArchive(id); P.confirm = ''; render(); }
    else if (a === 'unarchive') F.accountUnarchive(id);
    else if (a === 'cancel') F.cancelFromList(id);
    else if (a === 'rearm') F.copierRearm();
    else if (a === 'mode') F.copierSet({ mode: b.dataset.v });
    else if (a === 'trd') { P.trd = b.dataset.v; render(); }
  });
  listEl.addEventListener('change', e => {
    const el = e.target, a = el.dataset.act;
    if (!a) return;
    if (a === 'trade') { const on = el.checked; el.checked = !on; F.accountTrade(el.dataset.id, on); return; }   // shown as ChartBridge says, not as clicked
    if (a === 'leader') { if (el.value) F.copierSet({ leader: el.value }); return; }
    if (a === 'f-on' || a === 'f-qty' || a === 'f-size' || a === 'f-ll-on' || a === 'f-ll') {
      const tr = el.closest('[data-follower]'); if (!tr) return;
      const name = tr.dataset.follower, row = AC.followerRows(S.accounts, S.copier).find(r => r.account === name);
      if (!row) return;
      const val = k => tr.querySelector(`[data-act="${k}"]`);
      const llOn = val('f-ll-on').checked, llText = val('f-ll').value.trim();
      if (a === 'f-ll-on' && llOn && !llText) { P.llPending.add(name); val('f-ll').disabled = false; val('f-ll').focus(); return; }   // type the amount first
      P.llPending.delete(name);
      const next = Object.assign({}, row, { on: val('f-on').checked, qty: +val('f-qty').value, size: val('f-size').value,
        lossLimit: llOn ? (llText === '' ? null : Number(llText)) : null });
      if (llOn && llText !== '' && !Number.isInteger(Number(llText))) { host.note('Not sent: Daily loss: whole dollars, 1 or more.', true); return; }
      F.copierFollower(next);
    }
  });

  /* the prices of the instruments with an open position (unrealized P&L): watched while this panel shows */
  function watchPositions(roots) {
    for (const r of roots) if (!P.offs.has(r)) P.offs.set(r, host.watchQuote(r));
    for (const [r, off] of P.offs) if (!roots.includes(r)) { off(); P.offs.delete(r); }
  }

  function render() {
    const vals = [], props = [];
    const c = (text, cls, tip) => `<span role="cell" data-c="${vals.push({ text: text === null || text === undefined ? '' : String(text), cls: cls || '', tip: tip || '' }) - 1}"></span>`;
    const ci = (text, cls, tip) => `<span data-c="${vals.push({ text: text === null || text === undefined ? '' : String(text), cls: cls || '', tip: tip || '' }) - 1}"></span>`;   // a value inside a cell
    const pr = (p) => { props.push(p); return `data-p="${props.length - 1}"`; };
    const h = (text, cls) => `<span class="${cls || ''}" role="columnheader">${text}</span>`;
    const row = (k, cells, cls, extra) => `<div class="gr-row${cls ? ' ' + cls : ''}" role="row" data-k="${esc(k)}"${extra || ''}>${cells}</div>`;
    const sw = S.switches;
    /* the tabs: Copier only with its switch on */
    for (const t of TABS) {
      const b = v.body.querySelector(`.ac-tab[data-tab="${t.id}"]`), show = !t.when || !!t.when(S);
      if (b.hidden === show) b.hidden = !show;
    }
    if (P.tab === 'cop' && !sw.copier) { P.tab = 'acc'; for (const t of v.body.querySelectorAll('.ac-tab[data-tab]')) t.setAttribute('aria-selected', String(t.dataset.tab === 'acc')); }
    const accounts = S.accounts, active = accounts.filter(a => a.state !== 'gone'), gone = accounts.filter(a => a.state === 'gone');
    const instr = r => S.instruments[r] || {};
    const pv = r => +instr(r).pointValue || 0;
    const orders = [...S.orders.values()].filter(AC.isWorking);
    /* positions: from ChartBridge's accounts list (every account), by account then instrument */
    const positions = [];
    for (const a of accounts) for (const p of a.positions || []) if (p && p.qty) positions.push({ account: a.name, root: p.root, qty: p.qty, avgPrice: p.avgPrice });
    watchPositions([...new Set(positions.map(p => p.root))]);
    const now = host.now();
    const archived = new Set(S.archived.map(x => x.name));        // an archived account leaves every list (its history stays on The Desk)
    const groups = AC.tradesToday([...S.fills.values()].filter(x => !archived.has(x.account)), now, pv, (acct, r) => { const a = accounts.find(x => x.name === acct); const p = a && (a.positions || []).find(x => x.root === r); return p ? p.qty : 0; }, F.rateOf);
    const counts = { acc: accounts.length, pos: positions.length, ord: orders.length, trd: groups.reduce((n, g) => n + g.trips.filter(t => !t.open).length, 0), cop: (S.copier && S.copier.followers || []).filter(f => f.on).length, log: S.log.length };
    for (const t of TABS) { const el = v.body.querySelector(`[data-ct="${t.id}"]`), x = String(counts[t.id]); if (el.textContent !== x) el.textContent = x; }

    let html, foot = '';
    if (!S.v3) html = `<p class="ac-empty">${esc(S.reason || 'The Account page needs ChartBridge 0.4.0 or newer.')}</p>`;
    else if (!S.got) html = `<p class="ac-empty">${esc(S.open ? 'Waiting for ChartBridge\'s accounts.' : S.reason || 'Connecting to ChartBridge.')}</p>`;
    else if (P.tab === 'acc') {
      const lim = a => AC.limitState(a, S.desk.get(a.name));
      const canAct = sw.accountChecks && S.enabled;
      const canShow = canAct && accounts.some(a => a && 'canHide' in a);   // Show: ChartBridge 0.5.1 and later (its accounts carry canHide)
      /* the in-page confirm for Hide, a row of its own under the account's */
      const ask = a => P.confirm !== a.name ? '' : row('ask|' + a.name, `<span role="cell" class="apg-confirm">Hide ${esc(a.name)}? It leaves every list until you Show it; its history stays. <button type="button" class="ac-btn apg-yes" data-act="archive-yes" data-id="${esc(a.name)}">Hide</button><button type="button" class="ac-btn" data-act="archive-no" data-id="${esc(a.name)}">Keep</button></span>`, 'apg-ask');
      const accRow = a => {
        const s = lim(a), pos = (a.positions || []).filter(p => p.qty).map(p => p.root + ' ' + (p.qty > 0 ? '+' : '') + p.qty).join(', ');
        const lvl = s.level ? ' apg-' + s.level : '';
        const roomTip = [s.dd ? 'Trailing drawdown: ' + (s.dd.room !== null ? AC.fmtUsdPlain(s.dd.room) + ' left' : 'room not reported') + (s.dd.limit ? ' of ' + AC.fmtUsdPlain(s.dd.limit) : '') + (s.dd.from === 'desk' ? ' (The Desk)' : ' (NinjaTrader)') : (a.roomDrawdownWhy || 'No trailing drawdown known'),
          s.dl ? 'Daily loss: ' + (s.dl.room !== null ? AC.fmtUsdPlain(s.dl.room) + ' left' : 'room not known') + (s.dl.limit ? ' of ' + AC.fmtUsdPlain(s.dl.limit) : '') + (s.dl.from === 'desk' ? ' (The Desk)' : ' (NinjaTrader)') : (a.roomDailyLossWhy || 'No daily loss limit known'),
          s.level ? (s.level === 'red' ? 'RED: ' : 'AMBER: ') + Math.round(s.pct * 100) + '% of the room used to the closer limit' : ''].filter(Boolean).join('\n');
        /* the checkmark: a control only with accountChecks on; else what gate 2 says, read only */
        const canCheck = sw.accountChecks && S.enabled;
        /* Hide (ChartBridge 0.5.1): on any account ChartBridge says may be hidden now (flat, not the bot's, the copier's or an agent's) */
        const hide = !canAct ? '' : a.canHide === true
          ? `<span role="cell" class="r"><button type="button" class="ac-btn apg-hide" data-act="archive" data-id="${esc(a.name)}" title="Hide ${esc(a.name)}: it leaves every list until you Show it; its fills and history stay">Hide</button></span>`
          : c('', 'r mut', a.hideWhy || '');
        const mark = canCheck
          ? `<span role="cell" class="r"><input type="checkbox" class="apg-chk" data-act="trade" data-id="${esc(a.name)}" ${pr({ checked: !!a.trade, disabled: !a.trade && (a.state !== 'active' || a.connection !== 'connected') })} aria-label="Trade on ${esc(a.name)}" title="Trading on ${esc(a.name)}: checked, ChartBridge takes entries for it. Unchecking always works; exits always work."></span>`
          : c(a.trade ? '✓' : '', 'r ' + (a.tradable ? 'up' : 'mut'), a.trade ? (a.tradable ? 'Trading is on for ' + a.name : 'Checked, but not tradable now') : 'Not checked for trading');
        return row(a.name, `${c(a.name, 'b', a.sim ? 'NinjaTrader Sim account' : '')}${c(CONN[a.connection] || a.connection, a.connection === 'connected' ? '' : 'warn')}` +
          `${c(AC.fmtUsdPlain(a.balance), 'r')}${c(AC.fmtUsd(a.pnlToday), 'r ' + (a.pnlToday > 0.004 ? 'up' : a.pnlToday < -0.004 ? 'dn' : ''))}${c(pos, 'r')}` +
          `${c(AC.limitText(s) || '-', 'r apg-room' + lvl, roomTip)}${mark}${hide}`, 'apg-acc' + lvl) + ask(a);
      };
      html = !accounts.length ? '<p class="ac-empty">ChartBridge watches no account.</p>' :
        `<div class="gr apg-g apg-acc-g${canAct ? ' apg-hides' : ''}" role="table" aria-label="Accounts">` +
        row('h', h('Account') + h('Conn') + h('Balance', 'r') + h('Today', 'r') + h('Position', 'r') + h('Room', 'r') + h('Trade', 'r') + (canAct ? h('', 'r') : ''), 'gr-h') +
        active.map(accRow).join('') + '</div>' +
        (gone.length ? '<h3 class="apg-h">Gone</h3><div class="gr apg-g apg-gone-g" role="table" aria-label="Gone accounts">' + gone.map(a => {
          const asking = P.confirm === a.name;
          const btn = !canAct ? '' : asking
            ? `<span role="cell" class="apg-confirm">Hide ${esc(a.name)}? It leaves every list until you Show it; its history stays. <button type="button" class="ac-btn apg-yes" data-act="archive-yes" data-id="${esc(a.name)}">Hide</button><button type="button" class="ac-btn" data-act="archive-no" data-id="${esc(a.name)}">Keep</button></span>`
            : a.canHide === false ? c('', 'r mut', a.hideWhy || '')
            : `<span role="cell" class="r"><button type="button" class="ac-btn apg-hide" data-act="archive" data-id="${esc(a.name)}" title="Hide ${esc(a.name)}: it leaves every list (the copier, Working orders) until you Show it; its fills and history stay">Hide</button></span>`;
          return row('g|' + a.name + (asking ? '|ask' : ''), c(a.name, 'b') + c(GONE_WHY[a.goneWhy] || a.goneWhy || 'gone', 'warn') + c(a.goneSince ? 'since ' + hms(a.goneSince) + ' ET' : '', 'mut') + c(AC.fmtUsd(a.pnlToday), 'r') + btn, 'apg-gone');
        }).join('') + '</div>' : '') +
        /* hidden (archived) accounts: Show brings one back, unchecked (ChartBridge 0.5.1) */
        (S.archived.length ? '<h3 class="apg-h">Hidden</h3><div class="gr apg-g apg-arch-g" role="table" aria-label="Hidden accounts">' + S.archived.map(a =>
          row('a|' + a.name, c(a.name, 'b mut') + (canShow ? `<span role="cell" class="r"><button type="button" class="ac-btn apg-show" data-act="unarchive" data-id="${esc(a.name)}" title="Show ${esc(a.name)}: back in the lists, unchecked">Show</button></span>` : ''), 'apg-arch')).join('') + '</div>' : '');
      foot = (S.deskState === 'ok' ? 'Limits: NinjaTrader where it reports them, else The Desk.' : S.deskState === 'not asked' ? 'Limits: NinjaTrader where it reports them.' : S.deskState) +
        (sw.accountChecks ? '' : ' Checkmarks are read only (accountChecks = off in config.txt).') + (S.enabled ? '' : ' ' + (S.reason || ''));
    } else if (P.tab === 'pos') {
      html = !positions.length ? '<p class="ac-empty">Flat on every account.</p>' : '<div class="gr apg-g apg-pos-g" role="table" aria-label="Open positions">' +
        row('h', h('Account') + h('Inst') + h('Qty', 'r') + h('Avg', 'r') + h('Unrealized', 'r') + h('Stop', 'r') + h('Target', 'r'), 'gr-h') +
        positions.map(p => {
          const qq = host.quoteOf(p.root), last = qq && qq.last !== null && qq.last !== undefined ? qq.last : null;
          const un = last !== null && isFinite(p.avgPrice) && pv(p.root) ? (last - p.avgPrice) * p.qty * pv(p.root) : null;
          const legs = AC.attachedLegs(orders, p.account, p.root), px = x => AC.priceText(x, instr(p.root));
          const leg = xs => xs.length ? px(xs[0]) + (xs.length > 1 ? ' +' + (xs.length - 1) : '') : '';
          return row(p.account + '|' + p.root, c(p.account, 'b') + c(p.root, 'b') + c((p.qty > 0 ? '+' : '') + p.qty, 'r ' + (p.qty > 0 ? 'up' : 'dn')) +
            c(AC.priceText(p.avgPrice, instr(p.root)), 'r') + c(un === null ? '' : AC.fmtUsd(un), 'r ' + (un > 0.004 ? 'up' : un < -0.004 ? 'dn' : '')) +
            c(leg(legs.stop) || 'none', 'r' + (legs.stop.length ? '' : ' warn'), legs.stop.length ? '' : 'No working stop on ' + p.account + ' ' + p.root) + c(leg(legs.target), 'r'));
        }).join('') + '</div>';
      foot = 'Every account ChartBridge watches. Unrealized from the last trade.';
    } else if (P.tab === 'ord') {
      const can = sw.cancelFromList && S.enabled;
      const list = orders.slice().sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
      html = !list.length ? '<p class="ac-empty">No working orders.</p>' : `<div class="gr apg-g apg-ord-g${can ? ' apg-can' : ''}" role="table" aria-label="Working orders">` +
        row('h', h('Account') + h('Inst') + h('Order') + h('Qty', 'r') + h('Price', 'r') + (can ? h('<span class="visually-hidden">Cancel</span>') : ''), 'gr-h') +
        list.map(o => row(o.id, c(o.account, 'b') + c(o.root, 'b') + c(AC.orderName(o), o.side === 'sell' ? 'dn' : 'up') + c(String(Math.max(0, (+o.qty || 0) - (+o.filled || 0))), 'r') +
          c(typeof o.price === 'number' ? AC.priceText(o.price, instr(o.root)) : 'market', 'r') +
          (can ? `<span role="cell" class="r"><button type="button" class="ac-x" data-act="cancel" data-id="${esc(o.id)}" aria-label="Cancel this ${esc(o.root)} order on ${esc(o.account)}" title="Cancel it (one order; a bracket leg takes its partner)">×</button></span>` : ''))).join('') + '</div>';
      foot = can ? 'Cancel works on any account ChartBridge watches (closing always works).' : 'Every account ChartBridge watches.';
    } else if (P.tab === 'trd') {
      const seg = `<span class="ws-seg apg-seg" role="group" aria-label="Show"><button type="button" data-act="trd" data-v="trips" aria-pressed="${P.trd === 'trips'}">Round trips</button><button type="button" data-act="trd" data-v="fills" aria-pressed="${P.trd === 'fills'}">Fills</button></span>`;
      html = '<div class="apg-bar">' + seg + '</div>' + (!groups.length ? '<p class="ac-empty">No fills today.</p>' : groups.map(g => {
        const rate = F.rateOf(g.account);
        const head = `<h3 class="apg-h apg-gh"><span>${esc(g.account)}</span><span class="apg-sum">${((n) => n + (n === 1 ? ' trade' : ' trades'))(g.trips.filter(t => !t.open).length)} · gross <b class="${g.gross > 0.004 ? 'up' : g.gross < -0.004 ? 'dn' : ''}">${esc(g.gross === null ? 'n/a' : AC.fmtUsd(g.gross))}</b> · net <b class="${g.net > 0.004 ? 'up' : g.net < -0.004 ? 'dn' : ''}">${esc(g.net === null ? 'n/a' : AC.fmtUsd(g.net))}</b></span></h3>`;
        const netTip = rate ? '' : 'The Desk gives no commission for ' + g.account + ': net needs it';
        if (P.trd === 'fills') return head + '<div class="gr apg-g apg-fil-g" role="table" aria-label="Fills on ' + esc(g.account) + '">' +
          row('h', h('Time') + h('Inst') + h('Side', 'r') + h('Price', 'r'), 'gr-h') +
          g.fills.map(f => row(g.account + '|' + f.id, c(fmtClock(f.t), 'mut') + c(f.root, 'b') + c((f.side === 'buy' ? 'Buy ' : 'Sell ') + f.qty, 'r ' + (f.side === 'buy' ? 'up' : 'dn')) + c(AC.priceText(f.p, instr(f.root)), 'r'),
            'apg-link', ` data-review="${g.day}" title="Open this session's Review on The Desk"`)).join('') + '</div>';
        return head + '<div class="gr apg-g apg-trd-g" role="table" aria-label="Round trips on ' + esc(g.account) + '">' +
          row('h', h('In') + h('Out') + h('Inst') + h('Trade', 'r') + h('Gross', 'r') + h('Net', 'r'), 'gr-h') +
          g.trips.map(t => row(g.account + '|' + t.fills[0], c(fmtClock(t.openT), 'mut') + c(t.open ? 'open' : fmtClock(t.closeT), 'mut') + c(t.root, 'b') +
            c((t.side === 'long' ? 'Long ' : 'Short ') + t.qty + (t.entry !== null ? ' @ ' + AC.priceText(t.entry, instr(t.root)) : '') + (t.exit !== null ? ' to ' + AC.priceText(t.exit, instr(t.root)) : ''), 'r ' + (t.side === 'long' ? 'up' : 'dn')) +
            c(t.gross === null ? 'n/a' : AC.fmtUsd(t.gross) + (t.open ? ' so far' : ''), 'r ' + (t.gross > 0.004 ? 'up' : t.gross < -0.004 ? 'dn' : 'mut'), t.gross === null ? 'This trade began before today: its first fills are not in today\'s list' : '') +
            c(t.net === null ? 'n/a' : AC.fmtUsd(t.net), 'r ' + (t.net > 0.004 ? 'up' : t.net < -0.004 ? 'dn' : 'mut'), t.net === null ? netTip || 'Gross is not known' : ''),
            'apg-link', ` data-review="${g.day}" title="Open this session's Review on The Desk"`)).join('') + '</div>';
      }).join(''));
      foot = 'Today from 18:00 ET, flat to flat. Net uses The Desk\'s commission (the firm\'s default when the account has none). A row opens The Desk\'s Review.';
    } else if (P.tab === 'cop') {
      const C = S.copier || { armed: false, standDownWhy: null, leader: null, mode: 'executions', followers: [] };
      const rows = AC.followerRows(accounts, C), leader = C.leader ? C.leader.account : '';
      const pick = accounts.filter(a => a.state !== 'gone');
      html = `<div class="apg-cop-top"><span class="apg-arm ${C.armed ? 'on' : 'off'}" role="status">${C.armed ? 'ARMED' : 'STOOD DOWN'}</span>` +
        (C.armed ? '' : `<span class="apg-why">${esc(C.standDownWhy || 'Nothing is copied until Re-arm.')}</span><button type="button" class="ac-btn apg-rearm" data-act="rearm" title="Copy again: needs the leader Connected and fewer than 3 followers not Connected">Re-arm</button>`) +
        `<label class="apg-lbl">Leader <select class="ws-sel apg-sel" data-act="leader" ${pr({ value: leader })} aria-label="Leader account"><option value="">none</option>${pick.map(a => `<option value="${esc(a.name)}">${esc(a.name)}</option>`).join('')}</select></label>` +
        `<span class="ws-seg apg-seg" role="group" aria-label="Copy mode"><button type="button" data-act="mode" data-v="executions" aria-pressed="${C.mode === 'executions'}" title="Each leader fill: a market order on every follower">Executions</button><button type="button" data-act="mode" data-v="orders" aria-pressed="${C.mode === 'orders'}" title="Each leader entry order placed on every follower">Orders</button></span>` +
        `<span class="apg-sim">Sim or LIVE followers; every account gate applies</span></div>` +
        (!rows.length ? '<p class="ac-empty">No account to copy to.</p>' : '<div class="gr apg-g apg-cop-g" role="table" aria-label="Copier followers">' +
        row('h', h('Follower') + h('On') + h('Qty') + h('Size') + h('Daily loss') + h('Pos', 'r') + h('Slip', 'r') + h('Last'), 'gr-h') +
        rows.map(r => {
          const dis = false;   // Anthony 2026-10-07: no Sim lock (ChartBridge's account gates decide each copy)
          const qtyOpts = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<option value="${n}">${n}</option>`).join('');
          const llOn = r.lossLimit !== null || P.llPending.has(r.account);
          const pos = r.position && r.position.qty ? (r.position.qty > 0 ? '+' : '') + r.position.qty + ' ' + (r.root || '') : '';
          const last = r.skipped ? 'Skipped: ' + r.skipped : r.lastAction ? r.lastAction + (r.lastAt ? ' ' + hms(r.lastAt) : '') : '';
          return row('f|' + r.account + '|' + r.mark, `<span role="cell" class="apg-fol">${ci(r.account, 'b', r.mark === 'LIVE' ? 'A LIVE account: copies to it are real orders' : 'NinjaTrader Sim account')}<span class="apg-mark ${r.mark === 'LIVE' ? 'live' : 'sim'}">${r.mark}</span></span>` +
            `<span role="cell"><input type="checkbox" data-act="f-on" ${pr({ checked: r.on, disabled: dis })} aria-label="Copy to ${esc(r.account)}"></span>` +
            `<span role="cell"><select class="ws-sel apg-sel" data-act="f-qty" ${pr({ value: String(r.qty), disabled: dis })} aria-label="Contracts per leader contract">${qtyOpts}</select></span>` +
            `<span role="cell"><select class="ws-sel apg-sel" data-act="f-size" ${pr({ value: r.size, disabled: dis })} aria-label="Micro or mini"><option value="micro">micro</option><option value="mini">mini</option></select></span>` +
            `<span role="cell" class="apg-ll"><input type="checkbox" data-act="f-ll-on" ${pr({ checked: llOn, disabled: dis })} aria-label="Daily loss limit on ${esc(r.account)}" title="Daily loss limit: off by default. When on, the follower is skipped for new entries after losing this many dollars today"><input type="text" inputmode="numeric" class="oin apg-ll-in" data-act="f-ll" ${pr({ value: llOn ? String(r.lossLimit) : '', disabled: dis })} placeholder="$" maxlength="9" aria-label="Daily loss limit in dollars"></span>` +
            c(pos, 'r') + c(r.slippageTicks === null || r.slippageTicks === undefined ? '' : (r.slippageTicks > 0 ? '+' : '') + r.slippageTicks + ' t', 'r' + (r.slippageTicks > 0 ? ' dn' : ''), 'Slippage against the leader, ticks (worse is positive)') +
            c(last, r.skipped ? 'apg-skip' : 'mut'), r.skipped ? 'apg-skipped' : '', ` data-follower="${esc(r.account)}"`);
        }).join('') + '</div>');
      foot = 'Each follower is marked SIM or LIVE; a LIVE follower gets real orders. A follower exits by flattening, never by an opposite order. The daily loss limit is off unless set.';
    } else {
      html = !S.log.length ? '<p class="ac-empty">Nothing yet.</p>' : '<div class="apg-log" role="log" aria-label="ChartBridge log">' +
        S.log.map((l, i) => `<p class="apg-ln${l.level ? ' ' + l.level : ''}" data-k="${l.at}-${i}"><span class="mut">${hms(l.at)}</span> ${esc(l.text)}</p>`).join('') + '</div>';
      foot = 'Account changes, refusals and the copier\'s decisions on this page\'s connection, newest first.';
    }
    /* the list is rebuilt only when its rows change; figures write only their cells, so a button is never replaced under
       the mouse, and a box being typed in keeps its value */
    if (P.key !== html) {
      P.key = html; const top = listEl.scrollTop; listEl.innerHTML = html; listEl.scrollTop = top;
      P.cells = []; for (const e of listEl.querySelectorAll('[data-c]')) P.cells[+e.dataset.c] = e;
      P.props = []; for (const e of listEl.querySelectorAll('[data-p]')) P.props[+e.dataset.p] = e;
      P.rebuilt = (P.rebuilt || 0) + 1;
    }
    for (let i = 0; i < vals.length; i++) {
      const e = P.cells[i], x = vals[i]; if (!e) continue;
      if (e.textContent !== x.text) e.textContent = x.text;
      if (e.className !== x.cls) e.className = x.cls;
      if ((e.title || '') !== x.tip) e.title = x.tip;
    }
    for (let i = 0; i < props.length; i++) {
      const e = P.props[i], x = props[i]; if (!e) continue;
      if ('checked' in x && e.checked !== x.checked) e.checked = x.checked;
      if ('disabled' in x && e.disabled !== !!x.disabled) e.disabled = !!x.disabled;
      if ('value' in x && e !== document.activeElement && e.value !== x.value) e.value = x.value;
    }
    if (footEl.textContent !== foot) { footEl.textContent = foot; footEl.title = foot; }
  }
  const fmtClock = t => { const s = ((Math.floor(t) % 86400) + 86400) % 86400; return p2(Math.floor(s / 3600)) + ':' + p2(Math.floor(s / 60) % 60) + ':' + p2(s % 60); };
  host.quoteSubs.add(render);
  const unfit = host.fitPanel(v, (w, hh) => ({ 'gr-narrow': w < 560, 'gr-short': hh < 170 }));
  render();
  return { render, destroy: () => { unfit(); host.quoteSubs.delete(render); for (const off of P.offs.values()) off(); P.offs.clear(); }, state: P };
}

return { createFeed, mount, TABS, deskBase, deskNow, DESK_DEFAULT };
})();
