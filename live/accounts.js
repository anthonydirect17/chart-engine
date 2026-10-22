/*
 * The Account page (chart 1.16.0, ChartBridge 0.4.0, protocol v3; Anthony's spec, chart page section 1, items 14, 15 and 20):
 * a grid piece of the workspace (live/workspace.js panel type 'accounts') with six tabs, and the Quote board's formats.
 *
 *   Accounts         every account ChartBridge watches (0.5.1: connected in NinjaTrader this session): connection, balance,
 *                    today's P&L, open position, the room to the trailing drawdown and the daily loss limit, the trading
 *                    checkmark, the Gone list, Hide on any flat account (an in-page confirm) and Show on a hidden one;
 *                    1.26.0 (ChartBridge 0.5.8, Anthony 2026-10-14): each account's Group dropdown (None and the groups made
 *                    in Settings, live/groups.js), the highest close asked once when it joins a group (G2 b), My floor and
 *                    My daily for an account in no group, and the room from ChartBridge's own numbers (roomFloor,
 *                    roomDaily, targetLeft) before NinjaTrader's and The Desk's; 1.30.0 (wave 5): each account's Account type
 *                    from The Desk's ledger (GET /api/account-types; PUT /api/accounts/{account}/account-type), the last good
 *                    list kept in this browser and shown "as of" its time while The Desk is not reachable, and Apply its rules
 *                    (asks first) for an account in no group: My floor and My daily from its type (accountLimits)
 *   Positions        every open position on every account: average price, unrealized P&L, the attached stop and target
 *   Working orders   every working order on every account (Cancel only with `cancelFromList` on)
 *   Today's trades   per account, the fills and the flat-to-flat round trips, gross and net (The Desk's commission)
 *   Copier           only with `copier` on: the leader, the mode, a row per follower marked SIM or LIVE (Anthony 2026-10-07:
 *                    no Sim lock; ChartBridge's account gates apply to every follower), Re-arm after a stand-down. 1.37.0: shown
 *                    on the Multi-Account panel's Copier tab only (mount with only: 'cop'); the Account page has no Copier tab
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
/* 1.26.0 (ChartBridge 0.5.8): an account with ChartBridge's own numbers (roomFloor, roomDaily: its group's rules or its own
   limits with NinjaTrader's balance and P&L) is read from those first; g is its group as the groups message gave it (the
   limits for the percent: the group's daily loss and drawdown, or the account's own daily limit). */
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
function limitState(a, d, g) {
  a = a || {}; d = d || {}; g = g || null;
  const loss = isNum(a.pnlToday) ? Math.max(0, -a.pnlToday) : null;
  const deskDl = isNum(d.daily_loss_limit) && d.daily_loss_limit > 0 ? d.daily_loss_limit : null;
  const deskDd = isNum(d.trailing_drawdown) && d.trailing_drawdown > 0 ? d.trailing_drawdown : null;
  const src = a.src && typeof a.src === 'object' ? a.src : {};
  let dl = null, dd = null, tg = null, cb = false;
  if (isNum(a.roomDaily)) { cb = true; dl = { room: a.roomDaily, limit: g && isNum(g.dailyLoss) && g.dailyLoss > 0 ? g.dailyLoss : isNum(a.myDailyLoss) && a.myDailyLoss > 0 ? a.myDailyLoss : deskDl, from: 'chartbridge' }; }
  else if (isNum(a.roomDailyLoss)) dl = { room: a.roomDailyLoss, limit: deskDl !== null ? deskDl : loss !== null ? a.roomDailyLoss + loss : null, from: 'ninjatrader' };
  else if (deskDl !== null) dl = { room: loss !== null ? deskDl - loss : null, limit: deskDl, from: 'desk' };
  if (isNum(a.roomFloor)) { cb = true; dd = { room: a.roomFloor, limit: g && isNum(g.drawdown) && g.drawdown > 0 ? g.drawdown : deskDd, from: src.roomFloor === 'ninjatrader' ? 'ninjatrader' : 'chartbridge', floor: isNum(a.floor) ? a.floor : null }; }
  else if (isNum(a.roomDrawdown)) dd = { room: a.roomDrawdown, limit: deskDd, from: 'ninjatrader' };
  else if (deskDd !== null) dd = { room: null, limit: deskDd, from: 'desk' };
  if (isNum(a.targetLeft)) { cb = true; tg = { left: a.targetLeft, target: g && isNum(g.target) ? g.target : null }; }
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
  return { level, pct, closer, dl, dd, tg, cb };
}
/** The room cell's text: "DD $1,740.50 · DL $820.00" with the percent used of the closer, or '' with nothing known. 1.26.0, from
    ChartBridge's own numbers: "$900.00 daily · $1,700.00 to floor · $2,500.00 to target" (Anthony's mockup: "daily, to floor"). */
function limitText(s) {
  if (!s) return '';
  if (s.cb) {
    const parts = [s.dl && s.dl.room !== null ? fmtUsdPlain(s.dl.room) + ' daily' : '', s.dd && s.dd.room !== null ? fmtUsdPlain(s.dd.room) + ' to floor' : '',
      s.tg ? (s.tg.left <= 0 ? 'target reached' : fmtUsdPlain(s.tg.left) + ' to target') : ''].filter(Boolean);
    const t2 = parts.join(' · ');
    return t2 + (s.pct !== null && t2 ? ' (' + Math.round(s.pct * 100) + '% used)' : '');
  }
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
      archived: r.archived === true, firm: typeof r.firm === 'string' ? r.firm : null, commission: Object.keys(com).length ? com : null,
      /* 1.30.0: the account's type on The Desk's ledger ({ id, firm, name, version, status }) or null */
      accountType: r.accountType && typeof r.accountType === 'object' && typeof r.accountType.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(r.accountType.id)
        ? { id: r.accountType.id, firm: typeof r.accountType.firm === 'string' ? r.accountType.firm : '', name: typeof r.accountType.name === 'string' ? r.accountType.name : r.accountType.id,
          version: Number.isInteger(r.accountType.version) ? r.accountType.version : 0, status: r.accountType.status === 'checked' ? 'checked' : 'not_checked' } : null,
      /* 1.33.0: where each prop number came from ("account": set on the account itself on The Desk, which wins over its type) and
         The Desk's seed for a prop account (seed_floor, seed_date, seed_balance), each null when The Desk has none */
      source: r.source && typeof r.source === 'object' && !Array.isArray(r.source) ? Object.fromEntries(['daily_loss_limit', 'trailing_drawdown', 'account_size'].map(k => [k, typeof r.source[k] === 'string' ? r.source[k] : null])) : {},
      seedFloor: n(r.seed_floor), seedBalance: n(r.seed_balance), seedDate: typeof r.seed_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.seed_date) ? r.seed_date : null });
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
/** 1.32.1 (WORK 2026-10-19: the leader would not go back to none): the Leader picker's choice as copierSet's leader: an
 *  account name, or null for "none" (ChartBridge 0.4.3 or later takes null as no leader: the copier stands down). */
const leaderSet = value => ({ leader: typeof value === 'string' && value ? value : null });
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
/**
 * 1.27.0 (ChartBridge 0.6.0): the hero whose seat an account is, from the `agent` messages (heroes: agent id -> the message):
 * its name, or ''. A seat: the account an agent trades, each account of the group it trades, and one that left the group while
 * it still holds that agent's trade. The copier and the bot never trade a seat (ChartBridge refuses them).
 */
function heroOf(heroes, account) {
  for (const m of heroes && typeof heroes.values === 'function' ? heroes.values() : []) {
    if (!m || typeof account !== 'string' || !account) continue;
    const name = typeof m.name === 'string' && m.name ? m.name : m.agent;
    if (m.account === account) return name;
    if (Array.isArray(m.seats) && m.seats.some(x => x && x.account === account)) return name;
  }
  return '';
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
/** 1.37.0 (review N2): ChartBridge 0.6.7's answer for a groups change made but not yet in groups.txt ("changed, but groups.txt could
 *  not be saved ..."): it comes as a reject with its cid, but the change is in effect, so the pages show it as done with a warning. */
const keptChange = reason => typeof reason === 'string' && /^changed, but /.test(reason);
/** A message from ChartBridge as one Log line, or null for messages the Log does not keep. */
function logText(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.type === 'reject') return keptChange(m.reason) ? 'Done by ChartBridge, with a warning: ' + m.reason : 'Refused by ChartBridge: ' + (m.reason || '');
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

/* ---------------- 1.35.0: Update floors from The Desk (Anthony 2026-10-21) */
/**
 * What "Update floors from The Desk" would send, from The Desk's GET /api/chart-floors ({ accounts, skipped }) and ChartBridge's
 * accounts (each with its rules: its group's, or its own). Returns { send: [{ account, floor, now, source, note }], skip:
 * [{ account, label, why }] }. An account is sent only when ChartBridge lists it and has firm rules for it with a trailing
 * drawdown (firmMinimum's own conditions; ChartBridge checks again and may still refuse, said in the Log); every other one is
 * skipped with why, The Desk's own skips included. `rulesOf(a)` gives the rules that hold for ChartBridge's account a.
 */
function floorPlan(desk, accounts, rulesOf) {
  const out = { send: [], skip: [] };
  const list = Array.isArray(accounts) ? accounts : [];
  const money = v => isNum(v) && v > 0 && v < 1e8;
  /* review 8: one row per account: when The Desk sends two for the same account, the newer is kept (the later seed date; the same
     or none: the later row), the other skipped with why */
  const rows = [];
  for (const r of desk && Array.isArray(desk.accounts) ? desk.accounts : []) {
    if (!r || typeof r.account !== 'string' || !r.account) continue;
    const k = rows.findIndex(x => x.account === r.account);
    if (k < 0) { rows.push(r); continue; }
    const old = rows[k], newer = String(r.seed_date || '') >= String(old.seed_date || '');
    const keep = newer ? r : old, drop = newer ? old : r;
    rows[k] = keep;
    out.skip.push({ account: r.account, label: typeof drop.prop === 'string' && drop.prop !== r.account ? drop.prop : '', why: 'The Desk sent two floors for it: the newer one (' + (keep.prop || 'its other prop account') + (keep.seed_date ? ', seed of ' + keep.seed_date : '') + ') is the one shown' });
  }
  for (const r of rows) {
    if (!r || typeof r.account !== 'string' || !r.account) continue;
    const label = typeof r.prop === 'string' && r.prop !== r.account ? r.prop : '';
    if (!money(r.floor)) { out.skip.push({ account: r.account, label, why: 'The Desk sent no floor for it' }); continue; }
    const a = list.find(x => x && x.name === r.account);
    if (!a || a.state === 'gone') { out.skip.push({ account: r.account, label, why: 'ChartBridge does not list it on this PC' }); continue; }
    const rules = typeof rulesOf === 'function' ? rulesOf(a) : a.rules;
    if (!rules || typeof rules !== 'object') { out.skip.push({ account: r.account, label, why: 'no firm rules on ChartBridge yet: apply its account type first (in ⋯)' }); continue; }
    if (rules.drawdownType === 'static') { out.skip.push({ account: r.account, label, why: 'its drawdown is static on ChartBridge: the floor is fixed' }); continue; }
    out.send.push({ account: r.account, label, floor: Math.round(r.floor * 100) / 100, now: isNum(a.floor) ? a.floor : null,
      source: typeof r.source === 'string' ? r.source.slice(0, 200) : '', note: typeof r.note === 'string' ? r.note.slice(0, 200) : '' });
  }
  for (const k of desk && Array.isArray(desk.skipped) ? desk.skipped : []) {
    if (!k || typeof k.why !== 'string') continue;
    out.skip.push({ account: typeof k.account === 'string' ? k.account : '', label: typeof k.prop === 'string' ? k.prop : '', why: k.why.slice(0, 200) });
  }
  out.send.sort((x, y) => x.account.localeCompare(y.account));
  return out;
}

/* 1.35.0 (G): the accounts whose firm minimum was set from this page (sent, and not refused by ChartBridge within the wait),
   kept in this browser: { name: { min, at } }. Once one is set, NinjaTrader's own room to the floor (it never locks, so it
   always differs) is no flag; it stays in the Room's hover. */
const FIRM_MIN_KEY = 'live-firm-min-v1';
function cleanFirmMins(raw) {
  let v = raw;
  if (typeof raw === 'string') { try { v = JSON.parse(raw); } catch (e) { v = null; } }
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (k && k.length <= 200 && x && isNum(x.min) && x.min > 0 && Number.isInteger(x.at) && x.at > 0) out[k] = Object.assign({ min: x.min, at: x.at }, typeof x.sig === 'string' && x.sig.length <= 200 ? { sig: x.sig } : {});
  }
  return out;
}
/** Whether to flag "NinjaTrader shows X to the floor, ChartBridge Y" for account a: only when no firm minimum was set for it. */
function ntFloorFlag(a, firmMins) {
  if (!a || !isNum(a.roomFloorNt) || !isNum(a.roomFloor) || Math.abs(a.roomFloor - a.roomFloorNt) <= 25) return false;
  if (a.src && a.src.roomFloor === 'ninjatrader') return false;
  return !(firmMins && firmMins[a.name]);
}

return { QUOTE_ONLY, quoteRoots, decimalsOf, fmtNum, fmt32, priceText, changeText, fmtUsd, fmtUsdPlain, AMBER, RED, limitState, limitText,
  tradeDayOf, dayText, roundTrips, netOf, tradesToday, cleanDesk, reviewUrl, FOLLOWER_DEFAULT, leaderSet, accountMark, followerRows, followerMessage,
  accountMark, accountChange, logText, keptChange, orderName, attachedLegs, isWorking, heroOf, floorPlan, FIRM_MIN_KEY, cleanFirmMins, ntFloorFlag };
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
    copier: null, log: [], rejects: new Map(), desk: new Map(), deskUrl: '', deskState: 'not asked', deskAt: 0,
    groups: null, groupsError: null,   // 1.26.0: ChartBridge 0.5.8's groups (null: none sent, an older ChartBridge or not connected)
    /* 1.30.0: The Desk's account types (GET /api/account-types): null until read or found in this browser's copy; typesState
       'not asked', 'ok' (The Desk answered), 'cache' (not reachable: the last good list, as of typesAsOf) or 'none' (neither) */
    types: null, typesState: 'not asked', typesAsOf: '', typesError: '',
    heroes: new Map(),   // 1.27.0: each agent's `agent` message (its account, or its group's seats), for the seat marks
    /* 1.31.0 (audit C6): when ChartBridge dropped (ms), until its next accounts list: the rows stay, dimmed and marked as of then;
       hadGroups: ChartBridge sent groups this page session (the Group, Account type and Limits columns stay while not known) */
    lostAt: null, hadGroups: false,
  };
  let ws = null, tries = 0, timer = 0, seq = 0, started = false, deskTimer = 0, changeQueued = false, stopped = false;
  /* 1.30.0: this browser's storage for the account types' copy and the groups' links (every call wrapped; works without it) */
  const store = env.storage !== undefined ? env.storage : (() => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; } })();
  /* 1.35.0: the firm minimums set from this page (G), and what "Update floors from The Desk" sent this time, by account */
  S.firmMins = AC.cleanFirmMins((() => { try { return store ? store.getItem(AC.FIRM_MIN_KEY) : null; } catch (e) { return null; } })());
  S.firmSent = {};
  const changed = () => { if (changeQueued) return; changeQueued = true; Promise.resolve().then(() => { changeQueued = false; env.changed(); }); };
  const log = (text, level) => { if (!text) return; S.log.unshift({ at: Date.now(), text, level: level || '' }); if (S.log.length > LOG_MAX) S.log.length = LOG_MAX; };
  const cid = () => 'ap' + Date.now().toString(36) + '-' + (++seq);
  const mine = new Map();                                 // cid -> what was asked (its refusal goes to the window's note)
  const firmPending = new Map();                          // 1.35.0: cid -> { name, min } of a firmMinimum not refused yet
  const firmDone = new Map();                             // review 7: cid -> {name, at} of a firmMinimum taken as set (a late refusal undoes it)
  const FIRM_WAIT_MS = 3000;
  /* review 7: the firm rules a remembered minimum was set under (size, drawdown and its type, lock): another type applied, or a
     reset, changes them, and the minimum set before is forgotten (the NinjaTrader flag can come back) */
  const firmSig = name => { const a = S.accounts.find(x => x.name === name), r = a && (rulesOf(a) || (a.rules && typeof a.rules === 'object' ? a.rules : null)); return r ? [r.size, r.drawdown, r.drawdownType, r.lockAt || 0].join('|') : ''; };
  const firmWrite = all => { S.firmMins = all; try { if (store) store.setItem(AC.FIRM_MIN_KEY, JSON.stringify(all)); } catch (e) { /* blocked: this window's memory */ } };
  function firmForget(name) { const all = Object.assign({}, S.firmMins); if (!all[name]) return; delete all[name]; firmWrite(all); }
  function firmPrune() {
    let changed2 = false; const all = Object.assign({}, S.firmMins);
    for (const n of Object.keys(all)) { const now = firmSig(n); if (all[n].sig && now && all[n].sig !== now) { delete all[n]; changed2 = true; } }
    if (changed2) firmWrite(all);
  }
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
        ws = null; S.open = false; S.signedIn = false; S.enabled = false; S.reason = 'Not connected to ChartBridge.'; S.trading = null; S.groups = null; S.groupsError = null; S.heroes.clear();
        if (S.got && S.lostAt === null) S.lostAt = Date.now();   // 1.31.0 (audit C6): the last snapshot is kept but marked stale
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
        S.orders.clear(); S.positions.clear(); S.groups = null; S.groupsError = null;
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
        S.accounts = list; S.got = true; S.lostAt = null;
        firmPrune();                                          // review 7: a minimum set under other rules is forgotten
        changed(); return;
      }
      case 'orders': S.orders.clear(); for (const o of m.list || []) if (o && o.id) S.orders.set(o.id, o); changed(); return;
      case 'order': if (!m.id) return; if (AC.isWorking(m)) S.orders.set(m.id, m); else S.orders.delete(m.id); changed(); return;
      case 'position': if (m.account && m.root) { if (m.qty) S.positions.set(m.account + '|' + m.root, { qty: m.qty, avgPrice: m.avgPrice }); else S.positions.delete(m.account + '|' + m.root); changed(); } return;
      case 'execs': S.fills.clear(); for (const f of m.list || []) if (f && f.id) S.fills.set(f.account + '|' + f.id, f); changed(); return;
      case 'exec': if (m.id) { S.fills.set(m.account + '|' + m.id, m); changed(); } return;
      case 'copier': S.copier = m; changed(); return;
      case 'agent': if (typeof m.agent === 'string') { S.heroes.set(m.agent, { agent: m.agent, name: m.name, account: m.account, seats: m.seats }); changed(); } return;   // 1.27.0: seats marked with the hero's name
      case 'groups': {   // 1.26.0 (ChartBridge 0.5.8): the groups, their rules, side and holders
        const GC = typeof GroupsCore !== 'undefined' ? GroupsCore : null;
        S.groups = GC ? GC.cleanGroups(m) : (Array.isArray(m.list) ? m.list.filter(g => g && typeof g.id === 'string') : []);
        S.groupsError = typeof m.error === 'string' && m.error ? m.error : null;
        S.hadGroups = true;
        changed(); return;
      }
      case 'copierEvent': log(AC.logText(m), m.action === 'skip' || m.action === 'standDown' || m.action === 'refused' ? 'warn' : ''); changed(); return;
      case 'reject': {
        log(AC.logText(m), 'warn');
        if (m.cid && firmPending.has(m.cid)) { const p = firmPending.get(m.cid); firmPending.delete(m.cid); S.firmSent[p.name] = 'refused: ' + String(m.reason || '').slice(0, 200); }   // 1.35.0
        else if (m.cid && firmDone.has(m.cid)) {                // review 7: a late refusal undoes its own minimum only, never a newer one
          const d = firmDone.get(m.cid); firmDone.delete(m.cid);
          if (S.firmMins && S.firmMins[d.name] && S.firmMins[d.name].at === d.at) { firmForget(d.name); S.firmSent[d.name] = 'refused: ' + String(m.reason || '').slice(0, 200); }
        }
        if (m.cid && mine.has(m.cid)) { mine.delete(m.cid); env.note(AC.logText(m), true); }
        /* 1.37.0: the last refusals by cid, for a panel that shows its own reason (the Multi-Account panel's chips) */
        if (typeof m.cid === 'string' && m.cid) { S.rejects.set(m.cid, String(m.reason || '').slice(0, 400)); if (S.rejects.size > 50) S.rejects.delete(S.rejects.keys().next().value); }
        changed(); return;
      }
      case 'status': log(AC.logText(m), m.level === 'error' ? 'error' : m.level === 'warn' ? 'warn' : ''); changed(); return;
      case 'riskAlert': if (typeof m.text === 'string' && m.text) { log(m.text, m.kind === 'dailyLoss' ? 'error' : 'warn'); changed(); } return;   // 1.34.0 (ChartBridge 0.6.6): kept in the page's log too
    }
  }
  /* The Desk's limits (read only): its address as ChartBridge knows it (/diag desk.deskUrl), then GET /api/chart-accounts
     now and every minute while the feed runs. A failure leaves the last rows and says so in the Accounts tab. */
  function readDesk() {
    clearTimeout(deskTimer);
    if (stopped) return;
    const limits = deskBase(env.fetch).then(url => { S.deskUrl = url; return env.fetch(url + '/api/chart-accounts', { cache: 'no-store', mode: 'cors', credentials: 'omit' }); })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('The Desk answered ' + r.status))))
      .then(j => { S.desk = AC.cleanDesk(j); S.deskState = 'ok'; S.deskAt = Date.now(); }, e => { S.deskState = 'The Desk\'s limits could not be read (' + (e && e.message ? e.message : 'not reachable') + ').'; });
    Promise.all([limits, readTypes()]).then(() => { changed(); if (!stopped) deskTimer = setTimeout(readDesk, DESK_EVERY_MS); });
  }
  /* 1.30.0: The Desk's account types, now and with the limits every minute; the last good list kept in this browser and shown
     "as of" its time while The Desk is not reachable. Never throws. */
  function readTypes() {
    const GC = typeof GroupsCore !== 'undefined' ? GroupsCore : null;
    if (!GC) return Promise.resolve();
    if (!S.types) { const c = GC.readTypesCache(store); if (c) { S.types = c.types; S.typesAsOf = c.asOf || (c.savedAt ? new Date(c.savedAt).toISOString() : ''); } }
    return deskBase(env.fetch).then(url => env.fetch(url + '/api/account-types', { cache: 'no-store', mode: 'cors', credentials: 'omit' }))
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('The Desk answered ' + r.status))))
      .then(j => {
        const c = GC.cleanTypes(j);
        if (!c) throw new Error('an answer the page cannot read');
        S.types = c.types; S.typesAsOf = c.asOf || new Date().toISOString(); S.typesState = 'ok'; S.typesError = '';
        GC.writeTypesCache(store, j);
      }).catch(e => {
        S.typesError = e && e.message ? e.message : 'not reachable';
        if (!S.types) { const c = GC.readTypesCache(store); if (c) { S.types = c.types; S.typesAsOf = c.asOf || (c.savedAt ? new Date(c.savedAt).toISOString() : ''); } }
        S.typesState = S.types ? 'cache' : 'none';
      });
  }
  /* 1.30.0: an account's type on The Desk (PUT /api/accounts/{account}/account-type, id or null); then the rows again.
     Resolves { ok } or { ok: false, error }; never rejects. */
  function setAccountType(name, id) {
    if (env.desk === false) return Promise.resolve({ ok: false, error: 'this window does not read The Desk' });
    return deskBase(env.fetch).then(url => env.fetch(url + '/api/accounts/' + encodeURIComponent(name) + '/account-type', { method: 'PUT', mode: 'cors', credentials: 'omit', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_type: id || null }) }))
      .then(r => {
        if (r.ok) { readDesk(); return { ok: true }; }
        return r.json().then(j => j && typeof j.detail === 'string' ? j.detail : '', () => '').then(d => ({ ok: false, error: 'The Desk answered ' + r.status + (d ? ': ' + d : '') }));
      }, e => ({ ok: false, error: 'The Desk is not reachable (' + (e && e.message ? e.message : 'no answer') + ')' }));
  }
  /* 1.33.0 (Anthony 2026-10-19: "match the accounts going into a group to our desk pool ... so its all automatic"): what a join
     asks. ChartBridge 0.6.5 (the group is perMember): the account's rules from its type on The Desk (auto: one compact row with the
     rules taken and the highest close, prefilled from The Desk's seed floor when it has one), or the full form when The Desk has no
     type for it (or is not reachable, or the type misses a rule). An older ChartBridge: the 1.26.0 question only (old).
     1.37.0: on the feed, so the Accounts tab and the Multi-Account panel's join step on a chip ask exactly the same. */
  const verAtLeast = (v, want) => { const p = x => String(x || '').split('.').map(n => parseInt(n, 10) || 0); const A = p(v), B = p(want); for (let k = 0; k < 3; k++) { if ((A[k] || 0) !== (B[k] || 0)) return (A[k] || 0) > (B[k] || 0); } return true; };
  function joinRefusal(name, g) {
    if (!verAtLeast(S.version, '0.6.7') || !S.deskAt) return '';   // an older ChartBridge (its group's own rules), or The Desk not read: as before
    const row = S.desk.get(name), MC = typeof MultiAccountCore !== 'undefined' ? MultiAccountCore : null;
    if (!row || !row.accountType) return name + ' has no account type on The Desk: set its type there first (an account with no type cannot trade with a group until it has one).';
    const gf = MC ? MC.groupFirm(g, S.desk) : '', af = MC ? MC.firmOfRow(row) : '';
    if (gf && af && gf.toLowerCase() !== af.toLowerCase()) return g.name + ' holds ' + gf + ' accounts and ' + name + ' is ' + af + '\'s: a group holds one firm\'s accounts.';
    return '';
  }
  function joinPlan(name, g, acc) {
    const GC = GroupsCore, base = { account: name, group: g.id };
    if (!g.perMember) return Object.assign(base, { mode: 'old', prefill: String(+GC.highCloseDefault(g, acc).toFixed(2)) });
    const row = S.desk.get(name);
    const dr = !S.deskAt ? { error: 'The Desk is not reachable, so its account type cannot be read' } : !S.types ? { error: 'The Desk\'s account types are not known' } : GC.deskRules(row, S.types);
    if (dr.error) {
      const form = GC.rulesForm(g);
      return Object.assign(base, { mode: 'form', form, why: dr.error, prefill: String(+GC.highCloseDefault(g, acc).toFixed(2)), seed: null });
    }
    const seed = GC.seedHigh(row, dr.rules);
    return Object.assign(base, { mode: 'auto', rules: dr.rules, from: dr.from, overrides: dr.overrides, seed, prefill: seed ? String(seed.value) : String(+GC.highCloseDefault(dr.rules, acc).toFixed(2)) });
  }
  /** an auto join's words: "Put SIM-E in Lucid with its rules from <type>: <rules> · risk 5% ...: $100." */
  function joinWords(j) {
    const GC = GroupsCore, jg = (S.groups || []).find(x => x.id === j.group), gn = jg ? jg.name : j.group, rs = GC.summary(j.rules), risk = GC.riskDollars(jg, j.rules);
    return `Put ${j.account} in ${gn} with its rules from ${j.from}${j.overrides.length ? ' (its own on The Desk: ' + j.overrides.join(', ') + ')' : ''}: ${rs}${risk !== null ? ' · ' + GC.riskText(jg) + ': ' + GC.usd(risk) : ''}.`;
  }
  const account = name => S.accounts.find(a => a.name === name) || null;
  const groupOf = a => (a && a.group && S.groups ? S.groups.find(g => g.id === a.group) || null : null);
  /* 1.33.0: the rules that hold for an account in a group: its own (ChartBridge 0.6.5's accounts entry rules) over its group's */
  const rulesOf = a => { const g = groupOf(a); return g && a.rules && typeof a.rules === 'object' ? Object.assign({}, g, a.rules) : g; };
  const limit = name => { const a = account(name); return a ? AC.limitState(a, S.desk.get(name), rulesOf(a)) : null; };
  return {
    S, start, startAny, stop, account, limit, post, groupOf, rulesOf, store, setAccountType, readTypes, joinRefusal, joinPlan, joinWords,   // 1.37.0: the join, shared
    /** 1.30.0: an account's type on The Desk ({ id, firm, name, version, status }) or null */
    typeOf: name => { const d = S.desk.get(name); return d && d.accountType ? d.accountType : null; },
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
    /* 1.34.0 (ChartBridge 0.6.6; WORK 2026-10-20): a follower row removed (refused while it is on or the copier still holds
       something there): its account is then its own again, so a group or an agent may trade it */
    copierFollowerRemove: name => S.switches.copier && send({ type: 'copierFollowerRemove', cid: cid(), account: name }),
    /* 1.26.0 (ChartBridge 0.5.8): an account's group (null: None; highText: the highest close typed, G2 b) and a personal
       account's own floor and daily limit; each only once ChartBridge has sent groups (ChartBridge checks again) */
    accountGroup: (name, group, highText, rules, useCid) => {   // 1.33.0: rules (checked, with typeId) go with a join on ChartBridge 0.6.5; 1.37.0: useCid (the panel follows its answer)
      if (!S.groups || typeof GroupsCore === 'undefined') return false;
      const jg = (S.groups || []).find(x => x.id === group), hw = GroupsCore.highWord(rules || jg), r = GroupsCore.joinMessage(name, group, highText, useCid || cid(), hw.charAt(0).toUpperCase() + hw.slice(1), jg && jg.perMember ? rules : null);
      if (r.error) { env.note('Not sent: ' + r.error, true); return false; }
      return send(r.msg);
    },
    /* 1.33.0 (ChartBridge 0.6.5): a member's own rules changed later (the form's boxes as typed) */
    memberRules: (name, form) => {
      if (!S.groups || typeof GroupsCore === 'undefined') return false;
      const r = GroupsCore.memberRulesMessage(name, form, cid());
      if (r.error) { env.note('Not sent: ' + r.error, true); return false; }
      return send(r.msg);
    },
    /* 1.34.0 (ChartBridge 0.6.6, Anthony 2026-10-20: the floor "still wrong ... so it stops being an issue"): the firm dashboard's
       minimum balance seeds the account's floor, so ChartBridge's floor equals the firm's from then on */
    firmMinimum: (name, text) => {
      if (!S.groups || typeof GroupsCore === 'undefined') return false;
      const v = GroupsCore.parseMoney(text);
      if (!(v > 0)) { env.note('Not sent: Minimum balance: the firm\'s number in dollars (at most 2 decimals).', true); return false; }
      const c = cid();
      if (!send({ type: 'firmMinimum', cid: c, account: name, minBalance: v })) return false;
      /* 1.35.0: set once ChartBridge has not refused it within FIRM_WAIT_MS (a refusal comes back by its cid at once) */
      firmPending.set(c, { name, min: v });
      setTimeout(() => {
        const p = firmPending.get(c); if (!p) return;
        firmPending.delete(c);
        const all = AC.cleanFirmMins(store ? (() => { try { return store.getItem(AC.FIRM_MIN_KEY); } catch (e) { return null; } })() : null);
        const at = Date.now();
        all[p.name] = { min: p.min, at, sig: firmSig(p.name) };
        firmWrite(all);
        firmDone.set(c, { name: p.name, at }); if (firmDone.size > 100) firmDone.delete(firmDone.keys().next().value);
        S.firmSent[p.name] = 'set'; changed();
      }, FIRM_WAIT_MS);
      S.firmSent[name] = 'sent'; changed();
      return true;
    },
    /* 1.35.0: The Desk's floor for each prop account (GET /api/chart-floors), for "Update floors from The Desk". Resolves
       { ok, json } or { ok: false, error }; never rejects. */
    readFloors: () => {
      if (env.desk === false) return Promise.resolve({ ok: false, error: 'this window does not read The Desk' });
      return deskBase(env.fetch).then(url => env.fetch(url + '/api/chart-floors', { cache: 'no-store', mode: 'cors', credentials: 'omit' }))
        .then(r => (r.ok ? r.json().then(j => ({ ok: true, json: j })) : r.json().then(j => j && typeof j.detail === 'string' ? j.detail : '', () => '')
          .then(d => ({ ok: false, error: r.status === 404 ? 'The Desk has no floors to give (it needs The Desk of this release)' : 'The Desk answered ' + r.status + (d ? ': ' + d : '') }))),
        e => ({ ok: false, error: 'The Desk is not reachable (' + (e && e.message ? e.message : 'no answer') + ')' }));
    },
    firmMins: () => S.firmMins,
    accountLimits: (name, floorText, dailyText) => {
      if (!S.groups || typeof GroupsCore === 'undefined') return false;
      const r = GroupsCore.limitsMessage(name, floorText, dailyText, cid());
      if (r.error) { env.note('Not sent: ' + r.error, true); return false; }
      return send(r.msg);
    },
    rateOf: name => { const d = S.desk.get(name); return d && d.commission ? r => (d.commission[r] === undefined ? null : d.commission[r]) : null; },
    _message: message,                                    // tests
  };
}

/* ---------------- the panel */
/* 1.37.0 (Anthony 2026-10-22: "copier can just be a secondary tab on the Multi-Account panel"): the Copier tab left the Account page;
   the Multi-Account panel (live/multi-account.js) mounts this page with only: 'cop', so the copier is exactly as it was */
const TABS = [
  { id: 'acc', name: 'Accounts', short: 'Accts' }, { id: 'pos', name: 'Positions', short: 'Pos' }, { id: 'ord', name: 'Working orders', short: 'Orders' },
  { id: 'trd', name: 'Today\'s trades', short: 'Trades' }, { id: 'log', name: 'Log', short: 'Log' },
];
const COPIER_TAB = { id: 'cop', name: 'Copier', short: 'Copier', when: S => S.switches.copier };
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
  /* 1.37.0: host.only 'cop': the copier alone (the Multi-Account panel's Copier tab), with no tab strip */
  const only = host.only === 'cop';
  const TABS = only ? [COPIER_TAB] : TABS_PAGE;
  v.body.innerHTML = '<div class="apg' + (only ? ' apg-only' : '') + '" data-ap>' +
    '<div class="ac-tabs apg-tabs" role="tablist" aria-label="Account page"' + (only ? ' hidden' : '') + '>' + TABS.map((t, i) => `<button type="button" role="tab" class="ac-tab" data-tab="${t.id}" aria-selected="${i === 0}"${t.when ? ' hidden' : ''}><span class="lb-full">${esc(t.name)}</span><span class="lb-short">${esc(t.short)}</span><span class="ac-ct" data-ct="${t.id}"></span></button>`).join('') + '</div>' +
    '<div class="ac-list apg-list" data-list role="tabpanel"></div>' +
    '<p class="ac-foot apg-foot" data-foot></p></div>';
  const q = sel => v.body.querySelector(sel);
  const listEl = q('[data-list]'), footEl = q('[data-foot]');
  const P = { tab: only ? 'cop' : 'acc', key: '', cells: [], props: [], confirm: '', trd: 'trips', offs: new Map(), llPending: new Set(), join: null, rulesEdit: null, apply: '', typePending: new Map(), typeEdit: '', typePick: null, typeFocus: '',
    drawer: '', simOpen: false, allOpen: false, colDrag: null, colClick: null };   // 1.34.0: the account whose settings drawer is open; the Sim section open; every drawer open
  /* 1.34.0 (Anthony 2026-10-20: "make the rows or columns adjustable, so I can click and drag them and make them larger or
     smaller"): the Accounts tab's column widths (px, or null for the default share), kept in this browser; and each account's
     short label, kept in this browser too (the full name on hover) */
  const COLS_KEY = 'live-acc-cols-v1', LABELS_KEY = 'live-acc-labels-v1';
  const isNum = v => typeof v === 'number' && isFinite(v);
  const ACC_COLS = [['Account', 'minmax(96px, 1.5fr)'], ['Balance', 'minmax(0, 1fr)'], ['Today', 'minmax(0, .8fr)'], ['Position', 'minmax(0, 1fr)'],
    ['Room', 'minmax(0, 1.6fr)'], ['Group', 'minmax(0, 1fr)'], ['Trade', '44px'], ['', '34px']];
  const sread = k => { try { return JSON.parse(F.store ? F.store.getItem(k) : 'null'); } catch (e) { return null; } };
  const swrite = (k, v) => { try { if (F.store) F.store.setItem(k, JSON.stringify(v)); } catch (e) { /* blocked: the default */ } };
  const colWidths = () => { const w = sread(COLS_KEY); return Array.isArray(w) && w.length === ACC_COLS.length ? w.map(x => (Number.isFinite(x) && x >= 36 && x <= 2000 ? Math.round(x) : null)) : ACC_COLS.map(() => null); };
  const colsCss = w => ACC_COLS.map((c, i) => (w[i] ? w[i] + 'px' : c[1])).join(' ');
  const labels = () => { const l = sread(LABELS_KEY); return l && typeof l === 'object' && !Array.isArray(l) ? l : {}; };
  const OPEN_KEY = 'live-acc-open-v1';   // 1.34.0: { sim, all } as last chosen here
  { const o = sread(OPEN_KEY); if (o && typeof o === 'object') { P.simOpen = o.sim === true; P.allOpen = o.all === true; } }
  const saveOpen = () => swrite(OPEN_KEY, { sim: P.simOpen, all: P.allOpen });
  const labelOf = name => { const l = labels()[name]; return typeof l === 'string' && l.trim() ? l.trim().slice(0, 24) : ''; };
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
    /* 1.32.0 (review): the Change row's Save works by click or by Enter, as Anthony asked; every other button by click only */
    if (e.detail === 0 && b.dataset.act !== 'type-save') { host.note('The Account page\'s buttons work by click only, not by keyboard.', true); return; }
    const a = b.dataset.act, id = b.dataset.id || '';
    if (a === 'archive') { P.confirm = id; render(); }
    else if (a === 'archive-no') { P.confirm = ''; render(); }
    else if (a === 'archive-yes') { if (P.confirm === id) F.accountArchive(id); P.confirm = ''; render(); }
    else if (a === 'unarchive') F.accountUnarchive(id);
    else if (a === 'cancel') F.cancelFromList(id);
    else if (a === 'rearm') F.copierRearm();
    else if (a === 'f-remove') F.copierFollowerRemove(id);   // 1.34.0
    else if (a === 'drawer') { P.drawer = P.drawer === id ? '' : id; render(); }   // 1.34.0: the account's settings drawer
    else if (a === 'sim-toggle') { P.simOpen = !P.simOpen; saveOpen(); render(); }
    else if (a === 'drawers-all') { P.allOpen = !P.allOpen; P.drawer = ''; saveOpen(); render(); }   // 1.34.0: every account's settings at once (a setup day)
    else if (a === 'floors-desk' || a === 'floors-desk-again') {   // 1.35.0: read The Desk's floors; nothing is sent until Send
      if (a === 'floors-desk' && P.floors) { P.floors = null; render(); return; }
      P.floors = { state: 'loading' }; S.firmSent = {}; render();
      F.readFloors().then(r => { if (!P.floors) return; P.floors = r.ok ? { state: 'ready', json: r.json } : { state: 'error', error: r.error }; render(); });
    }
    else if (a === 'floors-close') { P.floors = null; render(); }
    else if (a === 'floors-send') {   // the one confirm: each floor as ChartBridge's own firmMinimum, a little apart
      const fl = P.floors; if (!fl || fl.state !== 'ready' || fl.sentAt) return;
      const plan = AC.floorPlan(fl.json, S.accounts, F.rulesOf);
      fl.sentAt = Date.now(); fl.sentN = plan.send.length;
      plan.send.forEach((r, i) => setTimeout(() => { if (!F.firmMinimum(r.account, String(r.floor))) S.firmSent[r.account] = 'refused: not sent (not connected to ChartBridge)'; render(); }, i * 150));
      host.note('Sending ' + plan.send.length + ' floor' + (plan.send.length > 1 ? 's' : '') + ' from The Desk to ChartBridge.');
      render();
    }
    else if (a === 'firm-min-set') {   // 1.34.0 (ChartBridge 0.6.6): the firm's minimum balance seeds the floor
      const tr = b.closest('[data-k]'), box = tr ? tr.querySelector('[data-act="firm-min"]') : null;
      if (box && F.firmMinimum(id, box.value)) { host.note(id + '\'s floor from the firm\'s minimum balance: sent to ChartBridge.'); box.value = ''; }
    }
    else if (a === 'mode') F.copierSet({ mode: b.dataset.v });
    else if (a === 'trd') { P.trd = b.dataset.v; render(); }
    else if (a === 'join-no') { P.join = null; render(); }
    /* 1.33.0: Edit rules on the join row opens the full form, prefilled with what The Desk gave; Rules on a member opens it with its
       rules now (sends memberRules); Cancel closes either and sends nothing */
    else if (a === 'join-edit') { if (P.join && P.join.account === id && P.join.mode === 'auto') { P.join = Object.assign({}, P.join, { mode: 'form', form: GroupsCore.rulesForm(P.join.rules), why: 'edited by hand' }); render(); focusRules(id); } }
    else if (a === 'rules-edit') { const acc = S.accounts.find(x => x.name === id); P.rulesEdit = P.rulesEdit && P.rulesEdit.account === id ? null : { account: id, form: GroupsCore.rulesForm(acc && acc.rules) }; render(); if (P.rulesEdit) focusRules(id); }
    else if (a === 'rules-no') { P.rulesEdit = null; render(); }
    else if (a === 'rules-save') {
      const ed = P.rulesEdit;
      if (!ed || ed.account !== id) return;
      const f = readRules(id, ed.form);
      const rc = GroupsCore.rulesCheck(f);
      if (rc.error) { host.note('Not sent: ' + rc.error, true); return; }
      P.rulesEdit = null;
      if (F.memberRules(id, f)) host.note(id + '\'s rules: sent to ChartBridge.');
      render();
    }
    else if (a === 'apply-type') { P.apply = P.apply === id ? '' : id; render(); }   // 1.30.0: asks first, never applied silently
    else if (a === 'apply-no') { P.apply = ''; render(); }
    /* 1.32.0 (Anthony 2026-10-19, "Text + Change"): Change (or Set) opens the picker in a row under the account, one row at a time;
       Cancel closes it and sends nothing; Not set sends null and closes it; Save sends the Size chosen and closes it (review: the
       Size select alone never sends, as an arrow key on a closed select fires change). Each puts the focus back on Change or Set */
    else if (a === 'type-edit') { const open = P.typeEdit !== id && canTypeNow(); P.typeEdit = open ? id : ''; P.typePick = null; render(); if (open) { const f = listEl.querySelector(`select[data-act="acct-firm"][data-id="${CSS.escape(id)}"]`); if (f) f.focus(); } }
    else if (a === 'type-cancel') { P.typeEdit = ''; P.typePick = null; P.typeFocus = id; render(); }
    else if (a === 'type-clear') { const ok = P.typeEdit === id && canTypeNow() && !P.typePending.has(id) && !!typeVal(id); P.typeEdit = ''; P.typePick = null; P.typeFocus = id; if (ok) sendType(id, ''); else render(); }
    else if (a === 'type-save') { const want = saveWant(id); P.typeEdit = ''; P.typePick = null; P.typeFocus = id; if (want) sendType(id, want); else render(); }
    else if (a === 'apply-yes' && firmOn()) {   // 1.34.0 (ChartBridge 0.6.6): the type's rules become the account's own; its floor trails and locks
      const dr = P.apply === id ? GroupsCore.deskRules(S.desk.get(id), S.types) : { error: 'no type' };
      P.apply = '';
      if (dr.error) { host.note('Not sent: ' + dr.error + '.', true); render(); return; }
      if (F.memberRules(id, GroupsCore.rulesForm(dr.rules))) { host.note(id + '\'s rules from ' + dr.from + ': sent to ChartBridge. Give its minimum balance from the firm\'s dashboard (its ⋯) so the floor matches the firm.'); P.drawer = id; }
      render();
    }
    else if (a === 'apply-yes') {
      const t = P.apply === id ? typeFor(id) : null, acc = S.accounts.find(x => x.name === id);
      const l = t ? GroupsCore.typeLimits(t) : { error: 'Its type is not on The Desk\'s list now.' };
      P.apply = '';
      /* a trailing type (or one with no drawdown type): My floor is never set from the type; the account's own is sent again as it
         is; an account gone from ChartBridge's list sends nothing (never an empty floor) */
      const x = GroupsCore.applySend(l, acc);
      if (x.error) { host.note('Not sent: ' + x.error + (/[.!?]$/.test(x.error) ? '' : '.'), true); render(); return; }
      if (F.accountLimits(id, x.floor, x.daily)) host.note((l.floor !== null ? 'My floor and My daily' : 'My daily (My floor as it was)') + ' from ' + GroupsCore.typeLabel(t) + ' for ' + id + ': sent to ChartBridge.');
      render();
    }
    else if (a === 'join-yes') {   // G2 (b): the highest close, asked once when an account joins a group
      const j = P.join;
      if (!j || j.account !== id) return;
      const box = listEl.querySelector('[data-act="join-high"]'), high = box ? box.value : '';
      /* 1.33.0: the rules go with the join: The Desk's (auto), or the form's as typed (checked first: nothing sent on a mistake) */
      let rules = null;
      if (j.mode === 'auto') rules = j.rules;
      else if (j.mode === 'form') {
        const f = readRules(id, j.form), rc = GroupsCore.rulesCheck(f);
        if (rc.error) { host.note('Not sent: ' + rc.error, true); return; }
        rules = Object.assign(rc.rules, { typeId: f.typeId || null });
      }
      P.join = null;
      F.accountGroup(j.account, j.group, high, rules);
      render();
    }
  });
  /* 1.34.0: a column's width dragged at its header's right edge (the Accounts tab); kept in this browser; a double-click on the
     edge gives that column its default share back */
  listEl.addEventListener('pointerdown', e => {
    const hnd = e.target.closest && e.target.closest('.apg-rs');
    if (!hnd || !listEl.contains(hnd) || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const grid = hnd.closest('.apg-acc2'), cells = grid ? [...grid.querySelector('.gr-h').children] : [];
    if (!grid || !cells.length) return;
    const col = +hnd.dataset.col, x0 = e.clientX, start = cells.map(el => Math.round(el.getBoundingClientRect().width));
    /* a double-click on the edge gives the column its default back; told by column and time, as a re-render between the two
       clicks makes them land on two handles (no dblclick event then) */
    const t = Date.now(), last = P.colClick; P.colClick = { col, t };
    if (last && last.col === col && t - last.t < 450) { P.colClick = null; const next = colWidths(); next[col] = null; swrite(COLS_KEY, next); P.key = ''; render(); return; }
    /* the list re-renders as the accounts tick (a new header, a new handle): the drag lives in P.colDrag, which render keeps,
       and its move and up are the window's, not the handle's */
    P.colDrag = { col, px: start[col] };
    hnd.classList.add('on');
    const css = () => colsCss(ACC_COLS.map((c, i) => (i === col ? P.colDrag.px : colWidths()[i])));
    const move = ev => {
      P.colDrag.px = Math.max(36, Math.min(900, start[col] + ev.clientX - x0));
      const g = listEl.querySelector('.apg-acc2'); if (g) g.style.setProperty('--apg-cols', css());
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      const px = P.colDrag.px; P.colDrag = null;
      if (px === start[col]) { const g = listEl.querySelector('.apg-acc2'); if (g) g.style.setProperty('--apg-cols', colsCss(colWidths())); return; }   // a click, no drag
      const next = colWidths(); next[col] = px; swrite(COLS_KEY, next); P.key = ''; render();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  });
  listEl.addEventListener('change', e => {
    const el = e.target, a = el.dataset.act;
    if (!a) return;
    if (a === 'trade') { const on = el.checked; el.checked = !on; F.accountTrade(el.dataset.id, on); return; }   // shown as ChartBridge says, not as clicked
    if (a === 'leader') {   // none sends leader null (1.32.1); shown as ChartBridge says until its copier message comes back
      const want = el.value;
      el.value = S.copier && S.copier.leader ? S.copier.leader.account : '';
      F.copierSet(AC.leaderSet(want));
      return;
    }
    if (a === 'group') {   // 1.26.0: None goes at once; a group first asks for the highest close so far (G2 b)
      const name = el.dataset.id, acc = S.accounts.find(x => x.name === name), want = el.value;
      el.value = acc && acc.group ? acc.group : '';                                       // shown as ChartBridge says, not as picked
      if (!want) { P.join = null; F.accountGroup(name, null); render(); return; }
      const g = (S.groups || []).find(x => x.id === want);
      /* 1.37.0 (ChartBridge 0.6.7, Anthony 2026-10-22): an account with no type on The Desk cannot join a group until it has one, and a
         group holds one firm's accounts (the firm of its members' types; the bench pool of the Multi-Account panel) */
      const no = g ? joinRefusal(name, g) : '';
      if (no) { P.join = null; host.note(no, true); render(); return; }
      if (g) { P.join = joinPlan(name, g, acc); P.rulesEdit = null; render(); const box = listEl.querySelector('[data-act="join-high"]'); if (box) { box.focus(); box.select(); } }
      return;
    }
    if (a === 'acct-firm' || a === 'acct-plan' || a === 'acct-type') {   // 1.30.0: the account's type, saved on The Desk; shown as The Desk says once it answers
      /* 1.32.0: the open Change row's Firm, then Plan, then Size; none of them sends (review: in Chromium an arrow key on a closed
         select fires change). Firm and Plan move the picker from the account's own type and keep the focus where it is (the row
         is drawn again, the focus put back on the same select); the Size is kept for Save (Not set is a button of its own) */
      const name = el.dataset.id, which = a === 'acct-firm' ? 'firm' : a === 'acct-plan' ? 'plan' : 'type';
      if (P.typeEdit !== name || !canTypeNow() || P.typePending.has(name)) return;
      const tree = typeTreeNow();
      if (which === 'type') { P.typePick = Object.assign({}, pickState(name, tree), { id: el.value, sized: true }); render(); return; }
      if (!el.value) return;
      const r = GroupsCore.cascadePick(tree, Object.assign(pickState(name, tree), { id: typeVal(name) }), which, el.value);
      P.typePick = { firm: r.state.firm, plan: r.state.plan }; render();
      return;
    }
    if (a === 'label') {   // 1.34.0: a short label, this browser only (empty: the account's name)
      const all = labels(), t = el.value.trim().slice(0, 24);
      if (t) all[el.dataset.id] = t; else delete all[el.dataset.id];
      swrite(LABELS_KEY, all); render();
      return;
    }
    if (a === 'my-floor' || a === 'my-daily') {   // 1.26.0: a personal account's own limits, both sent together
      const tr = el.closest('[data-k]'); if (!tr) return;
      const f = tr.querySelector('[data-act="my-floor"]'), d = tr.querySelector('[data-act="my-daily"]');
      F.accountLimits(el.dataset.id, f ? f.value : '', d ? d.value : '');
      return;
    }
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

  /* 1.30.0: the account's type from The Desk's list (its current version), or null */
  const typeFor = name => { const at = F.typeOf(name); return at && S.types ? S.types.find(t => t.id === at.id) || null : null; };
  /* 1.34.0: what ChartBridge 0.6.6 adds (the firm's rules on an account in no group, firmMinimum), from hello's version */
  const verAtLeast = (v, want) => { const p = x => String(x || '').split('.').map(n => parseInt(n, 10) || 0); const A = p(v), B = p(want); for (let k = 0; k < 3; k++) { if ((A[k] || 0) !== (B[k] || 0)) return (A[k] || 0) > (B[k] || 0); } return true; };
  const firmOn = () => verAtLeast(S.version, '0.6.6');
  /* 1.32.0: the picker's tree (the firms in use on The Desk first) and where an account's picker stands: its
     type (or the one just picked, until The Desk's rows say it), moved in the open Change row by Firm and Plan without sending */
  /* 1.33.0 (Anthony 2026-10-19: "match the accounts going into a group to our desk pool ... so its all automatic"): what a join
     asks. ChartBridge 0.6.5 (the group is perMember): the account's rules from its type on The Desk (auto: one compact row with the
     rules taken and the highest close, prefilled from The Desk's seed floor when it has one), or the full form when The Desk has no
     type for it (or is not reachable, or the type misses a rule). An older ChartBridge: the 1.26.0 question only (old). */
  /* 1.37.0: the join's checks and plan live on the feed (F.joinRefusal, F.joinPlan, F.joinWords), shared with the Multi-Account
     panel's join step on a chip */
  const joinRefusal = (name, g) => F.joinRefusal(name, g), joinPlan = (name, g, acc) => F.joinPlan(name, g, acc);
  const RULE_BOXES = [['size', 'Size', 'Account size, dollars'], ['dailyLoss', 'Daily', 'Daily loss limit, dollars (empty: none)'], ['drawdown', 'Drawdown', 'Drawdown size (max loss), dollars'],
    ['lockAt', 'Stops at', 'Floor stops at, dollars (empty: none; trailing only)'], ['target', 'Target', 'Profit target, dollars (empty: none)'], ['consistency', 'Cons. %', 'Consistency percent (empty: none)'],
    ['maxMinis', 'Max minis', 'Max size in minis (NQ, ES; empty: none)'], ['maxMicros', 'Max micros', 'Max size in micros (MNQ, MES; empty: none)']];
  /** the form's boxes as HTML (from the values it opened with: the row is not drawn again while it is typed in) */
  const rulesBoxes = (name, f) => RULE_BOXES.map(([k, label, tip]) => `<label class="apg-rf">${esc(label)} <input type="text" inputmode="decimal" class="oin apg-ll-in apg-rin" data-rf="${k}" data-id="${esc(name)}" value="${esc(f[k] || '')}" maxlength="12" aria-label="${esc(tip)} for ${esc(name)}" title="${esc(tip)}"></label>`).slice(0, 3).join('') +
    `<label class="apg-rf">Type <select class="ws-sel apg-sel apg-rin" data-rf="drawdownType" data-id="${esc(name)}" aria-label="Drawdown type for ${esc(name)}" title="How the floor trails">${GroupsCore.TYPES.map(t => `<option value="${t[0]}"${t[0] === f.drawdownType ? ' selected' : ''}>${esc(t[1])}</option>`).join('')}</select></label>` +
    RULE_BOXES.slice(3).map(([k, label, tip]) => `<label class="apg-rf">${esc(label)} <input type="text" inputmode="decimal" class="oin apg-ll-in apg-rin" data-rf="${k}" data-id="${esc(name)}" value="${esc(f[k] || '')}" maxlength="12" aria-label="${esc(tip)} for ${esc(name)}" title="${esc(tip)}"></label>`).join('');
  /** the form's values now, as typed (the type id it opened with stays: a typed box does not unlink The Desk's type) */
  function readRules(name, f0) {
    const out = Object.assign({}, f0);
    for (const el of listEl.querySelectorAll(`[data-rf][data-id="${CSS.escape(name)}"]`)) out[el.dataset.rf] = el.value;
    return out;
  }
  const focusRules = name => { const el = listEl.querySelector(`[data-rf="size"][data-id="${CSS.escape(name)}"]`); if (el) { el.focus(); el.select(); } };
  const typeTreeNow = () => GroupsCore.typeTree(S.types || [], GroupsCore.usedFirms([...S.desk.values()]));
  const typeVal = name => { const at = F.typeOf(name), pd = P.typePending.get(name); return pd ? pd.v : at ? at.id : ''; };
  const goneOf = name => { const at = F.typeOf(name); return at && !(S.types || []).some(t => t.id === at.id) ? { firm: at.firm, name: at.name } : null; };
  const pickState = (name, tree) => {
    const id = typeVal(name), b = P.typeEdit === name ? P.typePick : null;
    return Object.assign(GroupsCore.cascadeStart(tree, id, goneOf(name)), b ? { firm: b.firm, plan: b.plan } : {}, { id: b && b.sized ? b.id : id });
  };
  /* the type Save sends: the Size chosen in the open row, on The Desk's list in the plan shown, and not the account's own; or '' */
  const saveWant = name => {
    if (P.typeEdit !== name || !canTypeNow() || P.typePending.has(name) || !P.typePick || !P.typePick.sized) return '';
    const tree = typeTreeNow(), want = GroupsCore.cascadeView(tree, pickState(name, tree), goneOf(name)).type.value;
    return want && want !== typeVal(name) && (S.types || []).some(t => t.id === want) ? want : '';
  };
  /* the type can be changed only while The Desk answers (its list read now, and its rows) */
  const canTypeNow = () => !!S.types && S.typesState === 'ok' && S.deskState === 'ok';
  /* the one send: PUT /api/accounts/{account}/account-type (1.30.0), a type id or null (Not set) */
  function sendType(name, want) {
    P.typePending.set(name, { v: want, after: null }); render();
    F.setAccountType(name, want || null).then(r => {
      /* saved: shown as picked until The Desk's rows are read again (no flash of the old value); refused: back at once */
      if (r.ok) { const pd = P.typePending.get(name); if (pd) pd.after = S.deskAt; }
      else { P.typePending.delete(name); host.note('Account type for ' + name + ' not saved: ' + r.error, true); }
      render();
    });
  }
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
    if (P.tab === 'cop' && !sw.copier && !only) { P.tab = 'acc'; for (const t of v.body.querySelectorAll('.ac-tab[data-tab]')) t.setAttribute('aria-selected', String(t.dataset.tab === 'acc')); }
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
    for (const t of TABS) { const el = v.body.querySelector(`[data-ct="${t.id}"]`), x = String(counts[t.id]); if (el && el.textContent !== x) el.textContent = x; }

    let html, foot = '';
    /* 1.31.0 (audit C6): after a drop the last snapshot is shown dimmed, as of the drop; nothing in it is current */
    const stale = S.lostAt !== null && S.got, NK = stale || !S.open ? 'not known (not connected)' : 'not known yet';
    const staleWords = stale ? 'As of ' + hms(S.lostAt) + ' ET (not connected): ChartBridge\'s last balances, positions and orders, not current.' : '';
    if (!S.v3) html = `<p class="ac-empty">${esc(S.reason || 'The Account page needs ChartBridge 0.4.0 or newer.')}</p>`;
    else if (!S.got) html = `<p class="ac-empty">${esc(S.open ? 'Waiting for ChartBridge\'s accounts.' : S.reason || 'Connecting to ChartBridge.')}</p>`;
    else if (P.tab === 'acc') {
      const lim = a => AC.limitState(a, S.desk.get(a.name), F.rulesOf(a));   // 1.33.0: the member's own rules
      const canAct = sw.accountChecks && S.enabled;
      const grpKnown = !!S.groups, grpOn = grpKnown || S.hadGroups, canGroup = grpKnown && S.enabled && !S.groupsError;   // 1.26.0: ChartBridge 0.5.8 sends groups; 1.31.0: the columns stay while not known
      const gName = id => { const g = (S.groups || []).find(x => x.id === id); return g ? g.name : id; };
      /* 1.30.0: the Account type column (The Desk's ledger), once its list is known (read now, or this browser's copy) */
      const typesOn = grpOn && !!S.types, canType = typesOn && S.typesState === 'ok' && S.deskState === 'ok';
      const links = typesOn ? GroupsCore.readLinks(F.store) : {};
      const tree = typesOn ? typeTreeNow() : [];
      const opts = list => list.map(o => `<option value="${esc(o.value)}" title="${esc(o.title)}">${esc(o.label)}</option>`).join('');
      if (!canType || !grpKnown) { P.typeEdit = ''; P.typePick = null; }   // read only: no Change row
      /* 1.32.0 (Anthony 2026-10-19, "Text + Change"): the type as plain text (the whole label and the firm in the tooltip), with
         Change, or "Not set" with Set; the picker opens in a row under the account (typeRow) */
      const typeCell = a => {
        if (!typesOn) return '';
        if (!grpKnown) return c(NK, 'mut apg-nk', 'Not connected to ChartBridge: the account\'s group, type and limits are not known now');
        const pd = P.typePending.get(a.name);
        if (pd && pd.after !== null && S.deskAt > pd.after) P.typePending.delete(a.name);   // The Desk's rows read since the save
        /* 1.32.0 (Anthony 2026-10-19): no Desk rows read (The Desk not reachable since this page opened): the type is not known,
           not "Not set"; no Change or Set */
        if (!S.deskAt) return `<span role="cell" class="apg-type">` + ci('not known', 'apg-ttext mut apg-tnk', 'The Desk is not reachable, so the account\'s type cannot be read now') + '</span>';
        const at = F.typeOf(a.name), pend = P.typePending.has(a.name), val = typeVal(a.name);
        if (pend && P.typeEdit === a.name) { P.typeEdit = ''; P.typePick = null; }
        const t = typeFor(a.name), canApply = !a.group && !!t && canGroup;
        const off = a.group && links[a.group] && at && at.id !== links[a.group].id;
        const cur = S.types.find(x => x.id === val), g = goneOf(a.name), goneNow = !cur && g && val === at.id;
        const text = cur ? cur.name : goneNow ? (g.firm ? g.firm + ' ' : '') + g.name + ' (not on The Desk\'s list now)' : val ? val : 'Not set';
        const tip = (cur ? GroupsCore.typeLabel(cur) + '. ' : goneNow ? text + '. ' : '') + (S.typesState === 'ok' ? 'The account\'s type on The Desk\'s ledger (saved on The Desk)' + (canType ? ': ' + (val ? 'Change' : 'Set') + ' picks the firm, then the plan, then the size' : '') : 'The Desk is not reachable: the list as of ' + GroupsCore.asOfText(S.typesAsOf) + '; the type cannot be changed now');
        const edit = canType && !pend ? `<button type="button" class="ac-btn apg-tedit" data-act="type-edit" data-id="${esc(a.name)}" aria-expanded="${P.typeEdit === a.name}" aria-label="${val ? 'Change' : 'Set'} the account type for ${esc(a.name)}" title="${val ? 'Change' : 'Set'} the account type: firm, plan and size in a row under ${esc(a.name)}">${val ? 'Change' : 'Set'}</button>` : '';
        return `<span role="cell" class="apg-type">` + ci(text, 'apg-ttext' + (val ? '' : ' mut') + (off ? ' apg-toff' : ''), tip) + edit +
          (canApply ? `<button type="button" class="ac-btn apg-apply" data-act="apply-type" data-id="${esc(a.name)}" aria-label="Apply its rules to ${esc(a.name)}" title="Apply its rules: My floor and My daily from ${esc(GroupsCore.typeLabel(t))} (asks first)">Apply</button>` : '') + '</span>';
      };
      /* 1.32.0: the Change row: Firm, Plan and Size at full width with full labels, then Save (once a Size other than the account's
         own is chosen: sends it and closes the row), Not set (only when a type is set: sends null) and Cancel (sends nothing). One row
         at a time; no select sends */
      const typeRow = a => {
        if (!typesOn || P.typeEdit !== a.name || !canType || P.typePending.has(a.name)) return '';
        const val = typeVal(a.name), vw = GroupsCore.cascadeView(tree, pickState(a.name, tree), goneOf(a.name));
        const firm = { value: vw.firm.value, options: vw.firm.options.filter(o => o.value) };
        if (!firm.value) firm.options.unshift({ value: '', label: 'Firm', title: 'Pick a firm' });
        const sel = (act, cls, v, label, dis) => `<select class="ws-sel apg-sel apg-tpick ${cls}" data-act="${act}" data-id="${esc(a.name)}" ${pr({ value: v.value, disabled: dis })} aria-label="${label} for ${esc(a.name)}" title="${esc(label)}">${opts(v.options)}</select>`;
        return row('type|' + a.name, `<span role="cell" class="apg-confirm apg-typeask"><span class="apg-tasklbl">Account type for ${esc(a.name)}:</span>` +
          sel('acct-firm', 'apg-tfirm', firm, 'Account type firm', false) + sel('acct-plan', 'apg-tplan', vw.plan, 'Account type plan', !vw.firm.value) +
          sel('acct-type', 'apg-tsel', vw.type, 'Account type size and stage', !vw.plan.value) +
          `<button type="button" class="ac-btn apg-yes" data-act="type-save" data-id="${esc(a.name)}" ${pr({ disabled: !saveWant(a.name) })} title="Save: sends the size chosen as ${esc(a.name)}'s type on The Desk">Save</button>` +
          (val ? `<button type="button" class="ac-btn" data-act="type-clear" data-id="${esc(a.name)}" title="Not set: clears ${esc(a.name)}'s type on The Desk">Not set</button>` : '') +
          `<button type="button" class="ac-btn" data-act="type-cancel" data-id="${esc(a.name)}">Cancel</button></span>`, 'apg-ask');
      };
      /* 1.30.0: "Apply its rules" asks first, a row of its own (never applied silently) */
      /* the question: the numbers as they will be sent and how each was worked out; a trailing type never sets My floor (ChartBridge
         trails a floor only in a group), so the account's own is sent again unchanged and the question says why */
      const askApply = a => {
        if (P.apply !== a.name) return '';
        const t = typeFor(a.name), l = t ? GroupsCore.typeLimits(t) : { error: 'Its type is not on The Desk\'s list now.' };
        const dr = firmOn() && t ? GroupsCore.deskRules(S.desk.get(a.name), S.types) : null;
        /* 1.34.0 (ChartBridge 0.6.6): the type's rules become the account's own, so its floor trails and locks as the firm's does */
        const words = dr ? (dr.error ? dr.error : `Apply ${GroupsCore.typeLabel(t)} to ${a.name}: ${GroupsCore.summary(dr.rules)}. ChartBridge then works out its floor the firm's way (highest close less the drawdown, never above where it stops); give its minimum balance from the firm's dashboard next, in its ⋯.`)
          : l.error ? l.error : `Apply its rules from ${GroupsCore.typeLabel(t)} to ${a.name}: ` + GroupsCore.applyWords(l, { floor: a.myFloor, daily: a.myDailyLoss });
        return row('apply|' + a.name, `<span role="cell" class="apg-confirm apg-applyask"><span class="apg-applysum">${esc(words)}</span> ` +
          ((dr ? dr.error : l.error) ? '' : `<button type="button" class="ac-btn apg-yes" data-act="apply-yes" data-id="${esc(a.name)}">Apply its rules</button>`) + `<button type="button" class="ac-btn" data-act="apply-no" data-id="${esc(a.name)}">Cancel</button></span>`, 'apg-ask');
      };
      /* 1.30.0: a member whose type is not the one its group was filled from: a warning row (nothing is blocked) */
      const typeWarn = a => {
        if (!typesOn || !a.group || !links[a.group]) return '';
        const at = F.typeOf(a.name), l = links[a.group];
        if (!at || at.id === l.id) return '';
        return row('toff|' + a.name, `<span role="cell" class="apg-confirm apg-twarn">${esc(a.name)} is ${esc((at.firm ? at.firm + ' ' : '') + at.name)}; its group ${esc(gName(a.group))} was filled from ${esc(l.label)}. A warning only: nothing is blocked.</span>`, 'apg-ask');
      };
      /* G2 (b): the one question when an account joins a group, a row of its own under the account's */
      const askJoin = a => {
        if (!P.join || P.join.account !== a.name) return '';
        const j = P.join, jg = (S.groups || []).find(x => x.id === j.group), hw = GroupsCore.highWord(j.mode === 'auto' ? j.rules : jg), gn = gName(j.group);
        const high = `${esc(hw)} <input type="text" inputmode="decimal" class="oin apg-ll-in apg-high" data-act="join-high" value="${esc(j.prefill)}" aria-label="${esc(hw.charAt(0).toUpperCase() + hw.slice(1))} for ${esc(a.name)}, from the firm's dashboard" title="${esc(j.seed ? 'From ' + j.seed.words + '. ' : 'From the firm\'s dashboard. ')}Optional: empty takes the larger of the account size and its balance. ChartBridge starts the trailing floor from it."> <span class="mut">(${esc(j.seed ? (hw.startsWith('highest balance') ? 'highest balance' : 'highest close') + ' from The Desk\'s seed' + (j.seed.date ? ' of ' + j.seed.date : '') : 'the firm\'s dashboard; optional')})</span>`;
        const yes = `<button type="button" class="ac-btn apg-yes" data-act="join-yes" data-id="${esc(a.name)}">Put in ${esc(gn)}</button>`, no = `<button type="button" class="ac-btn" data-act="join-no" data-id="${esc(a.name)}">Cancel</button>`;
        if (j.mode === 'old') return row('join|' + a.name + '|' + j.group, `<span role="cell" class="apg-confirm apg-join">Put ${esc(a.name)} in ${esc(gn)}: ${high} ${yes}${no}</span>`, 'apg-ask');
        /* 1.33.0: one compact row: the rules taken from The Desk (and what the account's own Desk numbers changed), the highest close */
        if (j.mode === 'auto') {
          const words = F.joinWords(j);   // 1.37.0: the same words as the Multi-Account panel's join step
          return row('join|' + a.name + '|' + j.group + '|auto', `<span role="cell" class="apg-confirm apg-join apg-jauto"><span class="apg-jrules" title="${esc(words)}">${esc(words)}</span> ${high} ${yes}<button type="button" class="ac-btn" data-act="join-edit" data-id="${esc(a.name)}" title="Change any of the rules before ${esc(a.name)} joins">Edit rules</button>${no}</span>`, 'apg-ask');
        }
        /* the full form: every rule box, prefilled (the group's own rules when The Desk has no type for it) */
        return row('join|' + a.name + '|' + j.group + '|form', `<span role="cell" class="apg-confirm apg-join apg-rform"><span class="apg-jrules">Put ${esc(a.name)} in ${esc(gn)} with these rules (${esc(j.why)}):</span>${rulesBoxes(a.name, j.form)} ${high} ${yes}${no}</span>`, 'apg-ask');
      };
      /* 1.33.0: a member's rules changed later (Rules on its Limits cell): the full form, sent as memberRules */
      const askRules = a => {
        if (!P.rulesEdit || P.rulesEdit.account !== a.name || !(a.group || (firmOn() && a.rules && a.rules.own))) return '';
        return row('rules|' + a.name, `<span role="cell" class="apg-confirm apg-rform"><span class="apg-jrules">${esc(a.name)}'s rules${a.group ? ' in ' + esc(gName(a.group)) : ''}:</span>${rulesBoxes(a.name, P.rulesEdit.form)} <button type="button" class="ac-btn apg-yes" data-act="rules-save" data-id="${esc(a.name)}">Save rules</button><button type="button" class="ac-btn" data-act="rules-no" data-id="${esc(a.name)}">Cancel</button></span>`, 'apg-ask');
      };
      const canShow = canAct && accounts.some(a => a && 'canHide' in a);   // Show: ChartBridge 0.5.1 and later (its accounts carry canHide)
      /* the in-page confirm for Hide, a row of its own under the account's */
      const ask = a => P.confirm !== a.name ? '' : row('ask|' + a.name, `<span role="cell" class="apg-confirm">Hide ${esc(a.name)}? It leaves every list until you Show it; its history stays. <button type="button" class="ac-btn apg-yes" data-act="archive-yes" data-id="${esc(a.name)}">Hide</button><button type="button" class="ac-btn" data-act="archive-no" data-id="${esc(a.name)}">Keep</button></span>`, 'apg-ask');
      /* 1.34.0 (Anthony 2026-10-20: "this accounts tab needs cleaned up, its too messy, too much info in one area"; "I do like to see
         the position on this screen, so leave that, make the rows or columns adjustable"): the row keeps what is watched while
         trading (the account, balance, today, position, the tightest room with a bar, the group, Trade); the settings (group,
         type, limits, the firm's minimum, a label, Hide) are in a drawer under it (⋯); rows by group, then those in no group,
         then the Sim accounts (folded); a problem is an amber flag on the name, its reasons in the flag's tooltip */
      const usd0 = v => (isNum(v) ? (v < 0 ? '-$' : '$') + Math.round(Math.abs(v)).toLocaleString('en-US') : '');
      const followerSet = new Set(((S.copier && S.copier.followers) || []).filter(f => f && typeof f.account === 'string').map(f => f.account));
      const roomShort = s => {
        if (!s) return '-';
        if (s.cb) {
          const cx = s.closer === 'dl' ? s.dl : s.closer === 'dd' ? s.dd : null;
          if (cx) return usd0(cx.room) + (s.closer === 'dl' ? ' daily' : ' to floor');
          if (s.tg) return s.tg.left <= 0 ? 'target reached' : usd0(s.tg.left) + ' to target';
          return '-';
        }
        return AC.limitText(s) || '-';
      };
      /* 1.35.0 (C): "Update floors from The Desk": every prop account's floor as The Desk has it, what would be sent and what is
         skipped and why; Anthony confirms once (Send), then the page sends ChartBridge's firmMinimum for each (it checks each
         again; a refusal shows here and in the Log). Repeatable. */
      function floorsPanel() {
        const fl = P.floors;
        if (!fl) return '';
        if (fl.state === 'loading') return '<div class="apg-floors" role="region" aria-label="Floors from The Desk"><p class="mut">Reading the floors from The Desk...</p></div>';
        if (fl.state === 'error') return `<div class="apg-floors" role="region" aria-label="Floors from The Desk"><p class="warn">${esc(fl.error)}</p><button type="button" class="ac-btn" data-act="floors-close">Close</button></div>`;
        const plan = AC.floorPlan(fl.json, S.accounts, F.rulesOf);
        const state = n => S.firmSent[n] || '';
        /* review 9: the row's own label on this page first (as the rows below show it), then ChartBridge's name and The Desk's prop name */
        const who = r => { const l = labelOf(r.account); return (l ? `<b>${esc(l)}</b> <span class="mut">${esc(r.account)}</span>` : `<b>${esc(r.account)}</b>`) + (r.label ? ` <span class="mut">· The Desk: ${esc(r.label)}</span>` : ''); };
        const line = r => `<li class="apg-fl-row">${who(r)}: floor <b class="mono">${esc(AC.fmtUsdPlain(r.floor))}</b>` +
          ` <span class="mut">ChartBridge now ${r.now === null ? 'not known' : esc(AC.fmtUsdPlain(r.now))}</span>` +
          `<span class="mut apg-fl-src" title="${esc(r.source + (r.note ? '. ' + r.note : ''))}"> · ${esc(r.source)}${r.note ? '; ' + esc(r.note) : ''}</span>` +
          (state(r.account) ? ` <span class="${/^refused/.test(state(r.account)) ? 'warn' : 'b'}">${esc(state(r.account) === 'set' ? 'set' : state(r.account) === 'sent' ? 'sent...' : state(r.account))}</span>` : '') + '</li>';
        const skip = r => `<li class="apg-fl-row mut"><b>${esc((r.account && labelOf(r.account)) || r.account || r.label || 'a prop account')}</b>${r.account && labelOf(r.account) ? ' ' + esc(r.account) : ''}${r.account && r.label ? ` · The Desk: ${esc(r.label)}` : ''}: skipped, ${esc(r.why)}</li>`;
        const sent = fl.sentAt ? `<p class="mut">Sent ${fl.sentN} at ${esc(hms(fl.sentAt))} ET; ChartBridge checks each (a refusal shows on its row and in the Log). Read them again to send again.</p>` : '';
        return '<div class="apg-floors" role="region" aria-label="Floors from The Desk">' +
          `<p class="apg-fl-head">Floors from The Desk (its Prop seeds from the firm dashboard plus the tracked fills). ${fl.sentAt ? '' : plan.send.length ? 'Send them to ChartBridge as each firm\'s minimum?' : 'Nothing to send.'}</p>` +
          (plan.send.length ? '<ul class="apg-fl-list">' + plan.send.map(line).join('') + '</ul>' : '') +
          (plan.skip.length ? '<ul class="apg-fl-list">' + plan.skip.map(skip).join('') + '</ul>' : '') + sent +
          '<div class="apg-fl-btns">' + (plan.send.length && !fl.sentAt ? `<button type="button" class="ac-btn apg-yes" data-act="floors-send">Send ${plan.send.length} floor${plan.send.length > 1 ? 's' : ''} to ChartBridge</button>` : '') +
          (fl.sentAt ? '<button type="button" class="ac-btn" data-act="floors-desk-again">Read again</button>' : '') +
          '<button type="button" class="ac-btn" data-act="floors-close">' + (fl.sentAt ? 'Close' : 'Cancel') + '</button></div></div>';
      }
      const flagsOf = a => {
        const why = a.why && typeof a.why === 'object' ? a.why : {}, out = [];
        if (typeof why.floor === 'string' && /minimum balance/.test(why.floor)) out.push('Floor not known: ' + why.floor);
        /* 1.35.0 (Anthony): once its firm minimum is set, NinjaTrader's figure (it never locks, so it always differs) is no flag;
           it stays in the Room's hover */
        if (AC.ntFloorFlag(a, F.firmMins()))
          out.push('NinjaTrader shows ' + usd0(a.roomFloorNt) + ' to the floor, ChartBridge ' + usd0(a.roomFloor) + ' (from the firm\'s rules): check the firm\'s dashboard; its minimum balance goes in ⋯');
        if (followerSet.has(a.name)) out.push('A copier follower: group entries and the agents leave it out (the Copier tab: turn it off, then Remove)');
        const at = typesOn ? F.typeOf(a.name) : null, l = a.group ? links[a.group] : null;
        if (at && l && at.id !== l.id) out.push(a.name + ' is ' + (at.firm ? at.firm + ' ' : '') + at.name + '; its group ' + gName(a.group) + ' was filled from ' + l.label);
        if (!a.group && !(a.rules && a.rules.own) && a.myLimitsSet === false && typesOn && typeFor(a.name)) out.push('No limits set: Apply its type\'s rules (in ⋯)');
        return out;
      };
      const accRow = a => {
        const s = lim(a), pos = (a.positions || []).filter(p => p.qty).map(p => p.root + ' ' + (p.qty > 0 ? '+' : '') + p.qty).join(', ');
        const lvl = s.level ? ' apg-' + s.level : '';
        const why = a.why && typeof a.why === 'object' ? a.why : {}, from = x => (x.from === 'desk' ? ' (The Desk)' : x.from === 'chartbridge' ? ' (ChartBridge, from NinjaTrader\'s balance and P&L)' : ' (NinjaTrader)');
        /* 1.32.0 ("Narrower Room"): the Room's whole text first in its tooltip (the cell may cut it at 1366) */
        /* 2026-10-21 (review of b4bc612): groups.txt could not be read: the floor and rooms come from its copy, and say of when */
        const ntTip = isNum(a.roomFloorNt) && !(a.src && a.src.roomFloor === 'ninjatrader') ? 'NinjaTrader shows ' + AC.fmtUsdPlain(a.roomFloorNt) + ' to the floor (its own trailing figure, which never locks)' + (F.firmMins()[a.name] ? '; the firm minimum ' + AC.fmtUsdPlain(F.firmMins()[a.name].min) + ' was set from this page' : '') : '';
        const roomTip = [typeof a.fromCopy === 'string' && a.fromCopy ? 'groups.txt could not be read: ' + a.fromCopy : '', AC.limitText(s), s.dd ? (s.cb ? 'Room to the floor' + (s.dd.floor !== null && s.dd.floor !== undefined ? ' (' + AC.fmtUsdPlain(s.dd.floor) + ')' : '') + ': ' : 'Trailing drawdown: ') + (s.dd.room !== null ? AC.fmtUsdPlain(s.dd.room) + ' left' : 'room not reported') + (s.dd.limit ? ' of ' + AC.fmtUsdPlain(s.dd.limit) : '') + from(s.dd) : (why.roomFloor || a.roomDrawdownWhy || 'No trailing drawdown known'),
          s.dl ? 'Daily loss: ' + (s.dl.room !== null ? AC.fmtUsdPlain(s.dl.room) + ' left' : 'room not known') + (s.dl.limit ? ' of ' + AC.fmtUsdPlain(s.dl.limit) : '') + (s.cb ? ' (open P&L counted)' : '') + from(s.dl) : (why.roomDaily || a.roomDailyLossWhy || 'No daily loss limit known'),
          s.tg ? 'Profit target: ' + (s.tg.left <= 0 ? 'reached' : AC.fmtUsdPlain(s.tg.left) + ' left') + (s.tg.target ? ' of ' + AC.fmtUsdPlain(s.tg.target) : '') : '',
          s.level ? (s.level === 'red' ? 'RED: ' : 'AMBER: ') + Math.round(s.pct * 100) + '% of the room used to the closer limit' : '', ntTip].filter(Boolean).join('\n');
        /* the checkmark: a control only with accountChecks on; else what gate 2 says, read only */
        const canCheck = sw.accountChecks && S.enabled;
        /* Hide (ChartBridge 0.5.1): on any account ChartBridge says may be hidden now (flat, not the bot's, the copier's or an agent's) */
        const hide = !canAct ? '' : a.canHide === true
          ? `<span role="cell" class="r"><button type="button" class="ac-btn apg-hide" data-act="archive" data-id="${esc(a.name)}" title="Hide ${esc(a.name)}: it leaves every list until you Show it; its fills and history stay">Hide</button></span>`
          : c('', 'r mut', a.hideWhy || '');
        const mark = canCheck
          ? `<span role="cell" class="r"><input type="checkbox" class="apg-chk" data-act="trade" data-id="${esc(a.name)}" ${pr({ checked: !!a.trade, disabled: !a.trade && (a.state !== 'active' || a.connection !== 'connected') })} aria-label="Trade on ${esc(a.name)}" title="Trading on ${esc(a.name)}: checked, ChartBridge takes entries for it. Unchecking always works; exits always work."></span>`
          : c(a.trade ? '✓' : '', 'r ' + (a.tradable ? 'up' : 'mut'), a.trade ? (a.tradable ? 'Trading is on for ' + a.name : 'Checked, but not tradable now') : 'Not checked for trading');
        /* 1.26.0: the Group dropdown (None and every group) and the Limits cell: the group's floor, or My floor and My daily */
        const grp = !grpOn ? '' : !grpKnown ? c(NK, 'mut apg-nk', 'Not connected to ChartBridge: the account\'s group is not known now') : `<span role="cell"><select class="ws-sel apg-sel apg-grp" data-act="group" data-id="${esc(a.name)}" ${pr({ value: a.group || '', disabled: !canGroup })} aria-label="Group for ${esc(a.name)}" title="${esc(a.group ? GroupsCore.summary(F.groupOf(a)) : 'None: a personal account, in no group')}"><option value="">None</option>${(S.groups || []).map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}</select></span>`;
        const mg = a.group ? F.groupOf(a) : null, mr = a.rules && typeof a.rules === 'object' ? a.rules : null;
        const ownFree = !a.group && firmOn() && mr && mr.own;   // 1.34.0 (ChartBridge 0.6.6): the firm's rules on an account in no group
        const lims = !grpOn ? '' : !grpKnown ? c(NK, 'r mut apg-nk', 'Not connected to ChartBridge: the limits are not known now') : (a.group && mg && mg.perMember) || ownFree
          /* 1.33.0: a member's floor by its own rules, and Rules to change them (its rules in the tooltip) */
          ? `<span role="cell" class="apg-my apg-mrules">` + ci(typeof a.floor === 'number' ? 'floor ' + AC.fmtUsdPlain(a.floor) : 'floor ?', 'mut apg-mfloor', (typeof a.floor === 'number' ? 'The floor by ' + (mr && mr.own ? 'its own rules' : 'its group\'s rules') : (why.floor || '')) + (mr ? '\n' + (mr.own ? 'Its rules' : 'Its group\'s rules') + ': ' + GroupsCore.summary(mr) : '')) +
            (canGroup ? `<button type="button" class="ac-btn apg-redit" data-act="rules-edit" data-id="${esc(a.name)}" aria-expanded="${!!(P.rulesEdit && P.rulesEdit.account === a.name)}" title="${esc(a.name)}'s rules${a.group ? ' in ' + esc(gName(a.group)) : ''}: change any of them">Rules</button>` : '') + '</span>'
          : a.group
          ? c(typeof a.floor === 'number' ? 'floor ' + AC.fmtUsdPlain(a.floor) : 'floor ?', 'r mut', typeof a.floor === 'number' ? 'The floor by its group\'s rules' : (why.floor || ''))
          : `<span role="cell" class="apg-my"><input type="text" inputmode="decimal" class="oin apg-ll-in" data-act="my-floor" data-id="${esc(a.name)}" ${pr({ value: GroupsCore.moneyBox(a.myFloor), disabled: !canGroup })} placeholder="${a.myLimitsSet === false ? 'not set' : 'floor $'}" maxlength="12" aria-label="My floor for ${esc(a.name)}" title="My floor: the balance this account must stay above (empty: none)"><input type="text" inputmode="decimal" class="oin apg-ll-in" data-act="my-daily" data-id="${esc(a.name)}" ${pr({ value: GroupsCore.moneyBox(a.myDailyLoss), disabled: !canGroup })} placeholder="${a.myLimitsSet === false ? 'not set' : 'daily $'}" maxlength="12" aria-label="My daily limit for ${esc(a.name)}" title="My daily limit: the most this account may lose today, open P&amp;L counted (empty: none)"></span>`;
        const hero = AC.heroOf(S.heroes, a.name);   // 1.27.0: a seat shows its hero's name
        const lab = labelOf(a.name), flags = flagsOf(a), up = a.connection === 'connected', open = P.allOpen || P.drawer === a.name;
        const nameTip = [a.name, a.sim ? 'NinjaTrader Sim account' : '', hero ? 'A seat of ' + hero + ' (the Agent tab): the copier and the bot never trade it' : '',
          stale ? 'Not connected to ChartBridge since ' + hms(S.lostAt) + ' ET: this account\'s connection is not known' : up ? '' : (CONN[a.connection] || a.connection)].filter(Boolean).join('\n');
        const bucket = s.pct === null || s.pct === undefined ? 'n' : String(Math.max(0, Math.min(10, Math.round(s.pct * 10))));
        const nameCell = `<span role="cell" class="apg-name">` + ci('', stale ? 'apg-dot unk' : up ? 'apg-dot' : 'apg-dot down', stale ? 'Connection not known' : up ? '' : (CONN[a.connection] || a.connection) + ': not connected') +
          ci((lab || a.name) + (hero ? ' · ' + hero + '\'s seat' : ''), 'b', nameTip) + ci(flags.length ? '!' : '', flags.length ? 'apg-flag' : 'apg-flag off', flags.join('\n')) + '</span>';
        const roomCell = `<span role="cell" class="r apg-room${lvl}">` + ci(roomShort(s), 'apg-rtext', roomTip) + `<span class="apg-track">` + ci('', 'apg-bar apg-b' + bucket + lvl, roomTip) + '</span></span>';
        const grpText = !grpOn ? '' : !grpKnown ? 'not known' : a.group ? gName(a.group) : 'None';
        const more = `<span role="cell" class="r"><button type="button" class="ac-btn apg-more" data-act="drawer" data-id="${esc(a.name)}" aria-expanded="${open}" aria-label="Settings for ${esc(a.name)}" title="Settings: group, type, limits, the firm's minimum, a label, Hide">⋯</button></span>`;
        const main = row(a.name, nameCell + `${c(AC.fmtUsdPlain(a.balance), 'r')}${c(AC.fmtUsd(a.pnlToday), 'r ' + (a.pnlToday > 0.004 ? 'up' : a.pnlToday < -0.004 ? 'dn' : ''))}${c(pos, 'r')}` +
          roomCell + c(grpText, a.group ? '' : 'mut', a.group ? GroupsCore.summary(F.groupOf(a)) : 'In no group') + mark + more, 'apg-acc' + lvl + (open ? ' apg-open' : ''));
        if (!open) return main + ask(a) + askJoin(a) + askRules(a) + typeRow(a) + askApply(a);
        const unrole = x => String(x || '').replace(/role="cell" ?/g, '');
        const fld = (label, html2) => html2 ? `<span class="apg-dfield"><span class="apg-dlbl">${label}</span>${html2}</span>` : '';
        const trailing = mr && (mr.drawdownType === 'eod' || mr.drawdownType === 'intraday');
        const firm = firmOn() && grpKnown && canGroup && trailing ? `<input type="text" inputmode="decimal" class="oin apg-ll-in apg-fmin" data-act="firm-min" data-id="${esc(a.name)}" placeholder="${esc(S.desk.get(a.name) && isNum(S.desk.get(a.name).seedFloor) ? 'Desk seed ' + GroupsCore.usd(S.desk.get(a.name).seedFloor) : 'from the dashboard')}" maxlength="12" aria-label="Minimum balance from the firm's dashboard for ${esc(a.name)}" title="The minimum balance the firm's dashboard shows for ${esc(a.name)}: ChartBridge's floor equals it from then on (and trails from there)"><button type="button" class="ac-btn" data-act="firm-min-set" data-id="${esc(a.name)}">Set floor</button>` : '';
        const labBox = `<input type="text" class="oin apg-ll-in apg-label" data-act="label" data-id="${esc(a.name)}" ${pr({ value: lab })} placeholder="${esc(a.name.slice(0, 12))}" maxlength="24" aria-label="Short label for ${esc(a.name)}" title="A short name shown in place of ${esc(a.name)} on this page (this browser only; empty: the name)">`;
        const hideBtn = canAct && a.canHide === true ? `<button type="button" class="ac-btn apg-hide" data-act="archive" data-id="${esc(a.name)}" title="Hide ${esc(a.name)}: it leaves every list until you Show it; its fills and history stay">Hide</button>` : '';
        const drawer = row('dr|' + a.name, `<span role="cell" class="apg-drawer">` + fld('Group', unrole(grp)) + fld('Account type', unrole(typeCell(a))) + fld('Limits', unrole(lims)) +
          fld('Firm minimum', firm) + fld('Label', labBox) + fld('', hideBtn) + (flags.length ? `<span class="apg-dflags">${esc(flags.join(' · '))}</span>` : '') + '</span>', 'apg-ask apg-drawerrow');
        return main + drawer + ask(a) + askJoin(a) + askRules(a) + typeRow(a) + askApply(a);
      };
      /* the sections: each group (its members), then the accounts in no group, then the Sim accounts (folded until opened) */
      const secRow = (k, title, tot, extra) => row('sec|' + k, `<span role="cell" class="apg-sec">` + ci(title, 'apg-stitle') + ci(tot, 'apg-stot') + (extra || '') + '</span>', 'apg-secrow');
      const totText = list => { const t = list.reduce((x, a) => x + (isNum(a.pnlToday) ? a.pnlToday : 0), 0); return list.length + (list.length === 1 ? ' account' : ' accounts') + ' · today ' + AC.fmtUsd(t); };
      const sections = [];
      const inGroup = new Set();
      for (const g of S.groups || []) {
        const list = active.filter(a => a.group === g.id);
        if (!list.length) continue;
        list.forEach(a => inGroup.add(a.name));
        sections.push(secRow('g|' + g.id, g.name, totText(list)) + list.map(accRow).join(''));
      }
      const rest = active.filter(a => !inGroup.has(a.name)), real = rest.filter(a => !a.sim), sims = rest.filter(a => a.sim);
      if (real.length) sections.push(secRow('none', S.groups && S.groups.length ? 'Not in a group' : 'Accounts', totText(real)) + real.map(accRow).join(''));
      if (sims.length) sections.push(secRow('sim', 'Sim', totText(sims), `<button type="button" class="ac-btn apg-simtg" data-act="sim-toggle" aria-expanded="${P.simOpen}" title="${P.simOpen ? 'Fold' : 'Show'} the Sim accounts">${P.simOpen ? 'Hide' : 'Show'}</button>`) + (P.simOpen ? sims.map(accRow).join('') : ''));
      const widths = colWidths();
      if (P.colDrag) widths[P.colDrag.col] = P.colDrag.px;   // a drag going on
      const headRow = row('h', ACC_COLS.map((cdef, i) => h(cdef[0] + (i < ACC_COLS.length - 1 ? `<span class="apg-rs" data-col="${i}" title="Drag to make this column wider or narrower; double-click for its default"></span>` : ''), i >= 1 && i <= 4 || i >= 6 ? 'r' : '')).join(''), 'gr-h');
      html = !accounts.length ? '<p class="ac-empty">ChartBridge watches no account.</p>' :
        (stale ? `<p class="apg-stalenote" role="status">${esc(staleWords)}</p>` : '') +
        `<div class="apg-acc-top"><button type="button" class="ac-btn apg-alltg" data-act="drawers-all" aria-pressed="${P.allOpen}" title="${P.allOpen ? 'Fold every account\'s settings' : 'Show every account\'s settings (group, type, limits, the firm\'s minimum, a label, Hide) at once'}">${P.allOpen ? 'Fold settings' : 'Settings for every account'}</button>` +
          (firmOn() && canGroup ? `<button type="button" class="ac-btn apg-floorsbtn" data-act="floors-desk" aria-expanded="${!!P.floors}" title="Show every prop account's floor as The Desk has it (its seed from the firm dashboard plus the tracked fills); you confirm once, then each goes to ChartBridge as the firm's minimum">Update floors from The Desk</button>` : '') + '</div>' +
          floorsPanel() +
        `<div class="gr apg-g apg-acc-g apg-acc2${stale ? ' apg-stale' : ''}" style="--apg-cols: ${colsCss(widths)}" role="table" aria-label="Accounts${stale ? ' as of ' + esc(hms(S.lostAt)) + ' ET (not connected)' : ''}">` +
        headRow + sections.join('') + '</div>' +
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
      foot = (grpOn ? (S.groupsError ? S.groupsError + ' ' : 'Room: ChartBridge from each group\'s rules or your own limits, NinjaTrader\'s balance and P&L. Groups are made on the Multi-Account panel. ') : '') +
        (S.deskState === 'ok' ? 'Limits: NinjaTrader where it reports them, else The Desk.' : S.deskState === 'not asked' ? 'Limits: NinjaTrader where it reports them.' : S.deskState) +
        (!grpOn ? '' : S.typesState === 'cache' ? ' Account types: The Desk is not reachable; the list as of ' + GroupsCore.asOfText(S.typesAsOf) + '.' : S.typesState === 'none' ? ' Account types: The Desk is not reachable and this browser has no copy.' : '') +
        (sw.accountChecks ? '' : ' Checkmarks are read only (accountChecks = off in config.txt).') + (S.enabled ? '' : ' ' + (S.reason || ''));
      if (stale) foot = staleWords + (grpKnown ? '' : ' Groups, account types and limits are not known until ChartBridge is back.');
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
      foot = stale ? staleWords + ' Unrealized from the last trade on the chart.' : 'Every account ChartBridge watches. Unrealized from the last trade.';
      if (stale && positions.length) html = html.replace('class="gr apg-g apg-pos-g"', 'class="gr apg-g apg-pos-g apg-stale"');
    } else if (P.tab === 'ord') {
      const can = sw.cancelFromList && S.enabled;
      const list = orders.slice().sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
      html = !list.length ? '<p class="ac-empty">No working orders.</p>' : `<div class="gr apg-g apg-ord-g${can ? ' apg-can' : ''}" role="table" aria-label="Working orders">` +
        row('h', h('Account') + h('Inst') + h('Order') + h('Qty', 'r') + h('Price', 'r') + (can ? h('<span class="visually-hidden">Cancel</span>') : ''), 'gr-h') +
        list.map(o => row(o.id, c(o.account, 'b') + c(o.root, 'b') + c(AC.orderName(o), o.side === 'sell' ? 'dn' : 'up') + c(String(Math.max(0, (+o.qty || 0) - (+o.filled || 0))), 'r') +
          c(typeof o.price === 'number' ? AC.priceText(o.price, instr(o.root)) : 'market', 'r') +
          (can ? `<span role="cell" class="r"><button type="button" class="ac-x" data-act="cancel" data-id="${esc(o.id)}" aria-label="Cancel this ${esc(o.root)} order on ${esc(o.account)}" title="Cancel it (one order; a bracket leg takes its partner)">×</button></span>` : ''))).join('') + '</div>';
      foot = stale ? staleWords : can ? 'Cancel works on any account ChartBridge watches (closing always works).' : 'Every account ChartBridge watches.';
      if (stale && list.length) html = html.replace('class="gr apg-g apg-ord-g', 'class="gr apg-g apg-stale apg-ord-g');
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
    } else if (P.tab === 'cop' && only && !sw.copier) {
      html = '<p class="ac-empty">The copier is off: config.txt has copier = false (ChartBridge says so in its switches).</p>';
    } else if (P.tab === 'cop') {
      const C = S.copier || { armed: false, standDownWhy: null, leader: null, mode: 'executions', followers: [] };
      const rows = AC.followerRows(accounts, C), leader = C.leader ? C.leader.account : '';
      const pick = accounts.filter(a => a.state !== 'gone');
      html = `<div class="apg-cop-top"><span class="apg-arm ${C.armed ? 'on' : 'off'}" role="status">${C.armed ? 'ARMED' : 'STOOD DOWN'}</span>` +
        (C.armed ? '' : `<span class="apg-why">${esc(C.standDownWhy || 'Nothing is copied until Re-arm.')}</span><button type="button" class="ac-btn apg-rearm" data-act="rearm" title="Copy again: needs the leader Connected and fewer than 3 followers not Connected">Re-arm</button>`) +
        `<label class="apg-lbl">Leader <select class="ws-sel apg-sel" data-act="leader" ${pr({ value: leader })} aria-label="Leader account"><option value="">none</option>${pick.map(a => { const hero = AC.heroOf(S.heroes, a.name); return `<option value="${esc(a.name)}"${hero && a.name !== leader ? ' disabled' : ''}>${esc(a.name + (hero ? ' (' + hero + '\'s seat: never the copier\'s)' : ''))}</option>`; }).join('')}</select></label>` +
        `<span class="ws-seg apg-seg" role="group" aria-label="Copy mode"><button type="button" data-act="mode" data-v="executions" aria-pressed="${C.mode === 'executions'}" title="Each leader fill: a market order on every follower">Executions</button><button type="button" data-act="mode" data-v="orders" aria-pressed="${C.mode === 'orders'}" title="Each leader entry order placed on every follower">Orders</button></span>` +
        `<span class="apg-sim">Sim or LIVE followers; every account gate applies</span></div>` +
        (!rows.length ? '<p class="ac-empty">No account to copy to.</p>' : '<div class="gr apg-g apg-cop-g" role="table" aria-label="Copier followers">' +
        row('h', h('Follower') + h('On') + h('Qty') + h('Size') + h('Daily loss') + h('Pos', 'r') + h('Slip', 'r') + h('Last'), 'gr-h') +
        rows.map(r => {
          const hero = AC.heroOf(S.heroes, r.account);   // 1.27.0: a hero's seat is never a follower (ChartBridge refuses it)
          const dis = !!hero && !r.on;   // Anthony 2026-10-07: no Sim lock (ChartBridge's account gates decide each copy); turning one off always works
          const qtyOpts = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<option value="${n}">${n}</option>`).join('');
          const llOn = r.lossLimit !== null || P.llPending.has(r.account);
          const pos = r.position && r.position.qty ? (r.position.qty > 0 ? '+' : '') + r.position.qty + ' ' + (r.root || '') : '';
          const last = hero ? hero + '\'s seat: the copier never trades it' : r.skipped ? 'Skipped: ' + r.skipped : r.lastAction ? r.lastAction + (r.lastAt ? ' ' + hms(r.lastAt) : '') : '';
          /* 1.34.0 (WORK 2026-10-20): a saved follower row is marked (even off, it keeps its account out of groups and agents), and
             an off one has Remove (ChartBridge 0.6.6 refuses it while the copier still holds something there) */
          const rm = r.saved && !r.on && C.canRemove === true ? `<button type="button" class="ac-btn apg-frm" data-act="f-remove" data-id="${esc(r.account)}" title="Remove ${esc(r.account)} as a follower: it is an account of its own again (a group or an agent may trade it). Refused while the copier still holds a position or orders there.">Remove</button>` : '';
          const fmark = r.saved ? `<span class="apg-mark apg-fmark" title="${esc(r.account)} is a copier follower${r.on ? '' : ' (off)'}: a group entry and the agents leave it out until it is removed">follower</span>` : '';
          return row('f|' + r.account + '|' + r.mark + '|' + (r.saved ? 's' : '') + (rm ? 'r' : ''), `<span role="cell" class="apg-fol">${ci(r.account, 'b', r.mark === 'LIVE' ? 'A LIVE account: copies to it are real orders' : 'NinjaTrader Sim account')}<span class="apg-mark ${r.mark === 'LIVE' ? 'live' : 'sim'}">${r.mark}</span>${fmark}${rm}</span>` +
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
    /* 1.32.0 (review): a control with the focus keeps it when the list is rebuilt (the same data-act and data-id), so an arrow key
       on the Change row's Firm or Plan moves through the list there */
    const had = document.activeElement, keep = had && had !== listEl && listEl.contains(had) && had.dataset && had.dataset.act ? { act: had.dataset.act, id: had.dataset.id || '' } : null;
    let rebuilt = false;
    if (P.key !== html) {
      rebuilt = true;
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
    const findAct = (act, id) => [...listEl.querySelectorAll(`[data-act="${act}"]`)].find(e => (e.dataset.id || '') === id) || null;
    if (rebuilt && keep) { const e = findAct(keep.act, keep.id); if (e && !e.disabled) e.focus(); }
    /* after Cancel, Not set or Save: the account's Change or Set button (once it is back, after a save; only while nothing else
       has the focus) */
    if (P.typeFocus) {
      const act = document.activeElement;
      if (act && act !== document.body && !(listEl.contains(act) && act.dataset && act.dataset.act === 'type-edit')) P.typeFocus = '';
      else { const e = findAct('type-edit', P.typeFocus); if (e) { e.focus(); P.typeFocus = ''; } else if (!P.typePending.has(P.typeFocus)) P.typeFocus = ''; }
    }
    if (footEl.textContent !== foot) { footEl.textContent = foot; footEl.title = foot; }
  }
  const fmtClock = t => { const s = ((Math.floor(t) % 86400) + 86400) % 86400; return p2(Math.floor(s / 3600)) + ':' + p2(Math.floor(s / 60) % 60) + ':' + p2(s % 60); };
  host.quoteSubs.add(render);
  const unfit = host.fitPanel(v, (w, hh) => ({ 'gr-narrow': w < 560, 'gr-short': hh < 170 }));
  render();
  return { render, destroy: () => { unfit(); host.quoteSubs.delete(render); for (const off of P.offs.values()) off(); P.offs.clear(); }, state: P };
}

const TABS_PAGE = TABS;
return { createFeed, mount, TABS, COPIER_TAB, deskBase, deskNow, DESK_DEFAULT };
})();
