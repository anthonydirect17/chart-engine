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

/** Ignores the same action repeated within `ms` (a double click), so one click sends one order. */
function repeatGuard(ms) {
  let lastKey = null, lastAt = -Infinity;
  return (key, now) => {
    if (key === lastKey && now - lastAt < ms) return false;
    lastKey = key; lastAt = now; return true;
  };
}

return { MAX_BRACKET_TICKS, isWorking, bracketAllowed, placeKind, maxQtyFor, checkQty, cleanBracket, defaultAccount, cancelAllIds, orderEvent, legSummary, repeatGuard };
});
