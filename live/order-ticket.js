/*
 * Order ticket helpers for the live page (protocol v2, nt8/PROTOCOL.md). Pure functions, no DOM.
 * The page asks; ChartBridge decides: every safety gate is enforced there. The page only checks its own
 * inputs (qty within the cap, a price to click) so a slip is caught before anything is sent.
 * Works in the browser (window.OrderTicket) and in Node (tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrderTicket = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const MAX_BRACKET_TICKS = 200;
const isWorking = o => !!o && (o.state === 'working' || o.state === 'partFilled');

/** Shift+click: a price better than the market is a limit, worse is a stop. At the last price: a limit. */
function placeKind(side, price, last) {
  if (!(last > 0)) return 'limit';
  if (side === 'sell') return price < last ? 'stop' : 'limit';
  return price > last ? 'stop' : 'limit';
}

/** The cap for a root from the `trading` message: its own line, else the default under "*", else 1. */
function maxQtyFor(trading, root) {
  const m = (trading && trading.maxQty) || {};
  const v = m[root] !== undefined ? m[root] : m['*'];
  return Number.isInteger(v) && v > 0 ? v : 1;
}

/** Why a qty cannot be sent (null when it can). */
function checkQty(qty, max, root) {
  if (!Number.isInteger(qty) || qty < 1) return 'Qty must be a whole number of at least 1.';
  if (qty > max) return 'Qty ' + qty + ' is over the ' + (root || '') + ' cap of ' + max + '.';
  return null;
}

/** Bracket ticks from storage or inputs: whole numbers 0 to 200 (0 means none). */
function cleanBracket(v) {
  const one = x => { const n = Math.round(+x); return isFinite(n) ? Math.min(MAX_BRACKET_TICKS, Math.max(0, n)) : 0; };
  return { stop: one(v && v.stop), target: one(v && v.target) };
}

/** Default trade account: the one already chosen if still allowed, else Sim101, else the first allowed. */
function defaultAccount(accounts, current) {
  const list = accounts || [];
  if (current && list.includes(current)) return current;
  if (list.includes('Sim101')) return 'Sim101';
  return list[0] || '';
}

/*
 * The fills of the trade still open (1.6.0, Anthony: the live trade always stays visible, whatever is hidden). `fills`
 * are one account's fills on one instrument ({ t, side, qty }). Walked in time order: a fill on the side of the
 * position (or from flat) is an entry and is kept; a fill against it reduces it, and when the position is back to flat
 * every entry is dropped; a fill that turns the position over starts a new trade with it. `posQty`, when known (the
 * position ChartBridge reports, signed, long > 0), is the check: flat gives none, and a walk that ends on the other side
 * or flat (fills missing from the history) gives none rather than marks of a trade that is not open.
 */
function openEntryFills(fills, posQty) {
  if (posQty === 0) return [];
  const list = (fills || []).filter(f => f && (f.side === 'buy' || f.side === 'sell') && +f.qty > 0).slice().sort((a, b) => a.t - b.t);
  let net = 0, open = [];
  for (const f of list) {
    const q = f.side === 'buy' ? +f.qty : -f.qty;
    if (net === 0 || Math.sign(q) === Math.sign(net)) { open.push(f); net += q; continue; }
    const before = net;
    net += q;
    if (net === 0) open = [];
    else if (Math.sign(net) !== Math.sign(before)) open = [f];          // turned over: this fill opens the new trade
  }
  if (net === 0) return [];
  if (typeof posQty === 'number' && isFinite(posQty) && Math.sign(posQty) !== Math.sign(net)) return [];
  return open;
}

/** Cancel all for an account and root: one cancel per order, and one per OCO pair (the partner goes with it). */
/* Cancel all while a position is open keeps every order on the closing side (sells while long, buys while
   short): those are the position's stop and target, from the chart or from NinjaTrader. Returns the ids
   to cancel and how many were kept. */
function cancelAllIds(orders, account, root, posQty) {
  const seen = new Set(), ids = [];
  let kept = 0;
  for (const o of orders) {
    if (!isWorking(o) || o.account !== account || o.root !== root) continue;
    if ((posQty > 0 && o.side === 'sell') || (posQty < 0 && o.side === 'buy')) { kept++; continue; }
    if (o.oco) { if (seen.has(o.oco)) continue; seen.add(o.oco); }
    ids.push(o.id);
  }
  ids.kept = kept;
  return ids;
}

const KIND = { market: 'MKT', limit: 'LMT', stop: 'STP', stopLimit: 'STL' };
function describe(o, fmt) {
  const kind = o.role === 'target' ? 'TGT' : o.role === 'stop' ? 'STP' : (KIND[o.kind] || o.kind);
  return (o.side === 'sell' ? 'SELL' : 'BUY') + ' ' + kind + ' ' + o.qty + (o.price !== null && o.price !== undefined ? ' @ ' + fmt(o.price) : '');
}
/**
 * A status line for an order update, compared with the previous message for the same id.
 * Returns { text, level } or null when nothing worth saying changed (a leg resized, a repeat).
 */
function orderEvent(o, prev, fmt) {
  const f = fmt || (p => String(p));
  const where = ' · ' + o.account;
  if (o.state === 'rejected') return { text: 'Rejected: ' + describe(o, f) + (o.text ? ': ' + o.text : '') + where, level: 'error' };
  if (o.state === 'filled' && (!prev || prev.state !== 'filled')) return { text: 'Filled ' + (o.side === 'sell' ? 'SELL ' : 'BUY ') + o.qty + ' ' + (o.name || o.root) + ' @ ' + f(o.avgFill) + where, level: 'info' };
  if (o.state === 'partFilled' && (!prev || prev.filled !== o.filled)) return { text: 'Part filled ' + (o.side === 'sell' ? 'SELL ' : 'BUY ') + o.filled + ' of ' + o.qty + ' @ ' + f(o.avgFill) + where, level: 'info' };
  if (o.state === 'cancelled' && (!prev || prev.state !== 'cancelled')) return { text: 'Cancelled ' + describe(o, f) + where, level: 'info' };
  if (o.state === 'working' && !prev) return { text: 'Working ' + describe(o, f) + where, level: 'info' };
  if (isWorking(o) && prev && prev.price !== o.price) return { text: 'Moved ' + describe(o, f) + where, level: 'info' };
  return null;
}

/** A bracket goes only on an order that opens or adds: never on one against the current position. */
function bracketAllowed(side, positionQty) { return !positionQty || (positionQty > 0) === (side === 'buy'); }

/**
 * How far the working orders protect an open position: a multi-lot entry that fills in pieces gets one stop and
 * target pair per fill, so the chart shows stacked legs. Counts what is still to fill on the closing side (sells
 * while long, buys while short) for one account and root: stops (bracket stops, and stop or stop-limit orders
 * placed in NinjaTrader) and targets (bracket targets, and limit orders). Orders ChartBridge reports as kind
 * 'other' (MIT, LIT and any type it does not name) carry no price or type the page can read, so they are NOT
 * counted; the summary says how many there are. Read only: it never changes an order.
 * Returns null when flat, else { position, stops, targets, stopLegs, targetLegs, notCounted, stopsShort,
 * stopsOver, targetsOver, level ('error' when stops cover less than the position, 'warn' when stops or targets
 * cover more, so a fill would reverse it, '' otherwise), text }.
 */
function legSummary(orders, account, root, posQty) {
  const pos = Math.abs(+posQty || 0);
  if (!pos) return null;
  const closing = posQty > 0 ? 'sell' : 'buy';
  let stops = 0, targets = 0, stopLegs = 0, targetLegs = 0, notCounted = 0;
  for (const o of orders) {
    if (!isWorking(o) || o.account !== account || o.root !== root || o.side !== closing) continue;
    const left = Math.max(0, (+o.qty || 0) - (+o.filled || 0));
    const isStop = o.role === 'stop' || (o.role !== 'target' && (o.kind === 'stop' || o.kind === 'stopLimit'));
    const isTarget = !isStop && (o.role === 'target' || o.kind === 'limit');
    if (isStop) { stops += left; stopLegs++; }
    else if (isTarget) { targets += left; targetLegs++; }
    else if (o.kind !== 'market') notCounted++;
  }
  const stopsShort = stops < pos, stopsOver = stops > pos, targetsOver = targets > pos;
  const notes = [];
  if (stopsOver || targetsOver) {
    const what = [stopsOver ? 'stops ' + (stops - pos) : '', targetsOver ? 'targets ' + (targets - pos) : ''].filter(Boolean).join(', ');
    notes.push(what + ' over the position: a fill would reverse it');
  }
  if (notCounted) notes.push(notCounted + ' other order' + (notCounted > 1 ? 's' : '') + ' (MIT, LIT) not counted');
  return {
    position: pos, stops, targets, stopLegs, targetLegs, notCounted, stopsShort, stopsOver, targetsOver,
    level: stopsShort ? 'error' : stopsOver || targetsOver ? 'warn' : '',
    text: 'stops cover ' + stops + ' of ' + pos + ', targets cover ' + targets + ' of ' + pos + (notes.length ? ' · ' + notes.join(' · ') : ''),
  };
}

/*
 * Bracket presets (1.10.0, Anthony). A ratio sets target = round(stop x ratio) and stays linked to the stop while it is
 * picked. Saved presets are { name, stop, target } in ticks: at most 12, names 1 to 24 characters, unique (any case).
 */
const BRACKET_RATIOS = [{ id: '1:1', k: 1 }, { id: '1:1.5', k: 1.5 }, { id: '1:2', k: 2 }];
const BRACKET_PRESET_MAX = 12, BRACKET_PRESET_NAME_MAX = 24;
/** The multiplier of a ratio id ('1:1.5' gives 1.5), or null for anything else. */
function ratioOf(id) { const r = BRACKET_RATIOS.find(x => x.id === id); return r ? r.k : null; }
/** The bracket a ratio gives for a stop: the target is round(stop x ratio), both cleaned (and capped) by cleanBracket. */
function ratioBracket(stop, ratio) {
  const s = cleanBracket({ stop, target: 0 }).stop;
  return cleanBracket({ stop: s, target: Math.round(s * ratio) });
}
/** A preset name as kept: trimmed, inner spaces as one, at most 24 characters; '' when nothing is left. */
function bracketPresetName(v) { return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, BRACKET_PRESET_NAME_MAX).trim() : ''; }
/** The name a new preset gets when none is typed: "12/24t". */
function defaultPresetName(stop, target) { return stop + '/' + target + 't'; }
/** Saved presets as read: bad shapes, names and non-numbers dropped, a name used twice (any case) kept once, at most
    12, ticks cleaned by cleanBracket. Never throws. */
function cleanBracketPresets(v) {
  const out = [], names = new Set();
  if (!Array.isArray(v)) return out;
  for (const p of v) {
    if (out.length >= BRACKET_PRESET_MAX) break;
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    const name = bracketPresetName(p.name);
    if (!name || names.has(name.toLowerCase())) continue;
    if (typeof p.stop !== 'number' || typeof p.target !== 'number' || !isFinite(p.stop) || !isFinite(p.target)) continue;
    names.add(name.toLowerCase());
    out.push(Object.assign({ name }, cleanBracket(p)));
  }
  return out;
}

/** The quantity choices (1.10.0): 1 to 9, each with whether the root's cap allows it. */
const QTY_CHOICES = 9;
function qtyOptions(cap) {
  const out = [];
  for (let n = 1; n <= QTY_CHOICES; n++) out.push({ n, ok: n <= cap });
  return out;
}

/*
 * Break-even (1.10.0, Anthony). The price is the position's average price on the tick grid, rounded toward safety:
 * long up to the next tick, short down (a price already on the grid is kept). Only ChartBridge's own stop legs
 * (role 'stop') on the closing side are moved; orders placed in NinjaTrader (role 'other') never are.
 */
function breakEvenPrice(avgPrice, posQty, tick) {
  if (!posQty || !(tick > 0) || typeof avgPrice !== 'number' || !isFinite(avgPrice) || !(avgPrice > 0)) return null;
  const k = avgPrice / tick, r = Math.round(k);
  const steps = Math.abs(k - r) < 1e-6 ? r : posQty > 0 ? Math.ceil(k) : Math.floor(k);
  return Math.round(steps * tick * 1e9) / 1e9;
}
/**
 * Which stops a B/E click moves, for one account and root: `ids`, the working ChartBridge stop legs on the closing side
 * that are not yet at the B/E price or past it; `done`, those already there or past it (moving them would loosen the
 * stop, so they are left); `other`, working stop or stop-limit orders on the closing side placed in NinjaTrader (left
 * alone). With no `price` (null), every stop leg is in `ids`.
 */
function breakEvenLegs(orders, account, root, posQty, price) {
  const out = { ids: [], done: 0, other: 0 };
  if (!posQty) return out;
  const closing = posQty > 0 ? 'sell' : 'buy';
  for (const o of orders || []) {
    if (!isWorking(o) || o.account !== account || o.root !== root || o.side !== closing) continue;
    if (o.role === 'stop') {
      const there = price !== null && price !== undefined && typeof o.price === 'number' && (posQty > 0 ? o.price >= price : o.price <= price);
      if (there) out.done++; else out.ids.push(o.id);
    } else if (o.role === 'other' && (o.kind === 'stop' || o.kind === 'stopLimit')) out.other++;
  }
  return out;
}
/** Whether the last price is past the B/E price on the profitable side (long: above it, short: below it). */
function breakEvenAllowed(posQty, price, last) {
  if (!posQty || price === null || price === undefined || !(last > 0)) return false;
  return posQty > 0 ? last > price : last < price;
}

/**
 * B/E in paced chunks (1.10.0, Anthony 2026-10-01): `items` split by ChartBridge's budget of `limit` order actions a
 * second, with `recent` of them already sent in the last second. The first chunk is what fits now (it may be empty),
 * each later chunk a full second's worth. Every item is in exactly one chunk, in order.
 */
function paceChunks(items, recent, limit) {
  const list = Array.from(items || []), cap = Math.max(1, Math.floor(limit) || 0);
  const room = Math.min(cap, Math.max(0, cap - (Math.floor(recent) || 0)));
  const out = [list.slice(0, room)];
  for (let i = room; i < list.length; i += cap) out.push(list.slice(i, i + cap));
  return out;
}

/** Ignores the same action repeated within `ms` (a double click), so one click sends one order. */
function repeatGuard(ms) {
  let lastKey = null, lastAt = -Infinity;
  return (key, now) => {
    if (key === lastKey && now - lastAt < ms) return false;
    lastKey = key; lastAt = now; return true;
  };
}

return { MAX_BRACKET_TICKS, BRACKET_RATIOS, BRACKET_PRESET_MAX, BRACKET_PRESET_NAME_MAX, QTY_CHOICES, ratioOf, ratioBracket, bracketPresetName, defaultPresetName, cleanBracketPresets, qtyOptions, breakEvenPrice, breakEvenLegs, breakEvenAllowed, paceChunks, isWorking, bracketAllowed, placeKind, maxQtyFor, checkQty, cleanBracket, defaultAccount, openEntryFills, cancelAllIds, orderEvent, legSummary, repeatGuard };
});
