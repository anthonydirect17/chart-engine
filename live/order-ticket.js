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

/** Bracket ticks from storage or inputs: whole numbers 0 to `max` (200 unless given; 0 means none). */
function cleanBracket(v, max) {
  const cap = max > 0 ? max : MAX_BRACKET_TICKS;
  const one = x => { const n = Math.round(+x); return isFinite(n) ? Math.min(cap, Math.max(0, n)) : 0; };
  return { stop: one(v && v.stop), target: one(v && v.target) };
}

/*
 * The bracket's cap (1.13.0): ChartBridge before 0.3.7 takes at most 200 ticks; 0.3.7 and newer have no limit unless
 * config.txt sets maxBracketTicks (its `trading` message names it). NO_CAP keeps a typed number sane, nothing more.
 */
const NO_CAP = 100000;
/** [major, minor, patch] of a version text ("0.3.8", "fake-0.3.7"), or null. */
function versionOf(v) { const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')); return m ? [+m[1], +m[2], +m[3]] : null; }
/** Whether version text v is at least `want` ("0.3.7"); false when v names no version. */
function versionAtLeast(v, want) {
  const a = versionOf(v), b = versionOf(want);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}
function bracketCap(version, maxBracketTicks) {
  if (!versionAtLeast(version, '0.3.7')) return MAX_BRACKET_TICKS;
  return Number.isInteger(maxBracketTicks) && maxBracketTicks > 0 ? maxBracketTicks : NO_CAP;
}

/*
 * Planned stop and target (ChartBridge 0.3.8, Anthony's ATM rule 2026-10-01): a working limit or stop entry whose order
 * message carries `planned: { stopTicks, targetTicks }` gets a stop and a target as distances in ticks from its fill.
 * The chart shows them at the entry's price minus / plus the ticks (a sell entry the other way) and they travel with
 * the entry. Their ids are the entry's with ":sl" or ":tp".
 */
const PLAN_ID = /^(.+):(sl|tp)$/;
/** { entry, which: 'stop' | 'target' } of a planned line's id, or null for any other id. */
function planIdOf(id) { const m = PLAN_ID.exec(String(id)); return m ? { entry: m[1], which: m[2] === 'sl' ? 'stop' : 'target' } : null; }
const hasPlan = o => !!o && OT_RESTING.includes(o.kind) && o.role === 'entry' && !!o.planned && typeof o.planned === 'object';
const OT_RESTING = ['limit', 'stop', 'stopLimit', 'mit'];   // 1.16.0: a stop-limit or MIT entry rests too (ChartBridge 0.4.0, orderTypes)
/**
 * The chart items for one working entry's planned lines: [{ id, side, kind, price, qty, filled, role, plan }] (the
 * engine's `plan` shape), plus `adds` (what can be added: 'stop' and/or 'target') for the entry itself. Empty for an
 * order without `planned` (an older ChartBridge, a market entry, a leg, an order placed elsewhere).
 */
function plannedLines(o, tick) {
  if (!hasPlan(o) || !isWorking(o) || !(tick > 0) || typeof o.price !== 'number') return { lines: [], adds: [] };
  const dir = o.side === 'sell' ? -1 : 1, closing = o.side === 'sell' ? 'buy' : 'sell', left = Math.max(0, (+o.qty || 0) - (+o.filled || 0));
  const lines = [], adds = [];
  for (const [which, key, sign, sfx] of [['stop', 'stopTicks', -1, 'sl'], ['target', 'targetTicks', 1, 'tp']]) {
    const t = o.planned[key];
    if (!(Number.isInteger(t) && t >= 1)) { adds.push(which); continue; }
    const offset = sign * dir * t;
    lines.push({ id: o.id + ':' + sfx, side: closing, kind: which === 'stop' ? 'stop' : 'limit', price: Math.round((o.price + offset * tick) / tick) * tick, qty: left, filled: 0, role: null,
      plan: { parent: o.id, offset, role: which } });
  }
  return { lines, adds };
}
/**
 * A planned line dragged to `price` (1.13.0): the new distance from the entry's price in whole ticks (at least 1), or
 * the reason it is refused (a stop at or past the entry on the profit side, a target at or past it on the loss side).
 * `from`: the entry price the chart drew the line from (the F2 review): while a move of the entry waits for its answer
 * the chart draws the line from the moved price, so the distance sent is the one Anthony saw. Without it, o.price.
 */
function planDrag(o, which, price, tick, from) {
  if (!o || !(tick > 0) || !isFinite(price) || typeof o.price !== 'number') return { error: 'Not sent: that entry is no longer working.' };
  const dir = o.side === 'sell' ? -1 : 1;
  const base = typeof from === 'number' && isFinite(from) && from > 0 ? Math.round(from / tick) * tick : o.price;
  const d = Math.round((price - base) / tick) * dir;         // ticks toward profit (+) or loss (-) for this entry
  if (which === 'stop') return d <= -1 ? { ticks: -d } : { error: 'Not sent: a stop goes on the loss side of the entry (' + (dir > 0 ? 'below' : 'above') + ' it). Drag it back past the entry.' };
  return d >= 1 ? { ticks: d } : { error: 'Not sent: a target goes on the profit side of the entry (' + (dir > 0 ? 'above' : 'below') + ' it). Drag it back past the entry.' };
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

const KIND = { market: 'MKT', limit: 'LMT', stop: 'STP', stopLimit: 'STL', mit: 'MIT' };
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
 * Whether an order opens a position (F2 review, for the NO STOP question): flat, adding, or a reversal (a sell of 3
 * while long 1 opens short 2). A reversal still takes no bracket (bracketAllowed, the 1.12.0 rule), so its opening part
 * has no stop whatever the bracket says.
 */
function opensPosition(side, positionQty, qty) {
  if (bracketAllowed(side, positionQty)) return true;
  return (+qty || 0) > Math.abs(+positionQty || 0);
}

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

/**
 * The protection line of the position readout (1.13.0, Anthony: calm, one line): "Stop 4/4 · Target 4/4". A gap reads
 * "NO STOP on 1" in its place; cover over the position says so. { text, warn } from a legSummary (null when flat).
 */
function protectionLine(l) {
  if (!l) return { text: '', warn: false };
  const parts = [l.stopsShort ? 'NO STOP on ' + (l.position - l.stops) : 'Stop ' + l.stops + '/' + l.position, 'Target ' + l.targets + '/' + l.position];
  if (l.stopsOver || l.targetsOver) parts.push('over the position');
  if (l.notCounted) parts.push(l.notCounted + ' other not counted');
  return { text: parts.join(' · '), warn: !!l.level };
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
function ratioBracket(stop, ratio, max) {
  const s = cleanBracket({ stop, target: 0 }, max).stop;
  return cleanBracket({ stop: s, target: Math.round(s * ratio) }, max);
}
/** A preset name as kept: trimmed, inner spaces as one, at most 24 characters; '' when nothing is left. */
function bracketPresetName(v) { return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, BRACKET_PRESET_NAME_MAX).trim() : ''; }
/** The name a new preset gets when none is typed: "12/24t". */
function defaultPresetName(stop, target) { return stop + '/' + target + 't'; }
/** Saved presets as read: bad shapes, names and non-numbers dropped, a name used twice (any case) kept once, at most
    12, ticks cleaned by cleanBracket. Never throws. */
function cleanBracketPresets(v, max) {
  const out = [], names = new Set();
  if (!Array.isArray(v)) return out;
  for (const p of v) {
    if (out.length >= BRACKET_PRESET_MAX) break;
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    const name = bracketPresetName(p.name);
    if (!name || names.has(name.toLowerCase())) continue;
    if (typeof p.stop !== 'number' || typeof p.target !== 'number' || !isFinite(p.stop) || !isFinite(p.target)) continue;
    names.add(name.toLowerCase());
    out.push(Object.assign({ name }, cleanBracket(p, max)));
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

/*
 * Flatten all (1.11.0, Anthony 2026-10-01): the instruments of one account that have a position or a working order, one
 * flatten each. `positions` is a Map of 'account|root' -> { qty }; `served` (optional) says whether ChartBridge serves a
 * root. In `order` (the page's instrument list) first, then any other root by name.
 */
function flattenAllRoots(orders, positions, account, served, order) {
  const set = new Set();
  for (const o of orders || []) if (isWorking(o) && o.account === account && o.root) set.add(o.root);
  for (const [k, p] of positions || []) {
    const i = k.lastIndexOf('|');
    if (i > 0 && k.slice(0, i) === account && p && +p.qty) set.add(k.slice(i + 1));
  }
  const ok = [...set].filter(r => !served || served(r));
  const rank = r => { const i = (order || []).indexOf(r); return i < 0 ? Infinity : i; };
  return ok.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/*
 * Trading hotkeys (1.11.0, Anthony 2026-10-01). Five actions, each with a key Anthony assigns in Settings; none has a
 * default. A combo is kept as text, the modifiers in a fixed order then the key: "Alt+B", "Ctrl+Shift+F9", "Num1".
 * The key is the physical key (KeyboardEvent.code), so Shift never changes it ("Shift+1", not "!"). Only letters,
 * digits, F-keys, the numpad (not its Enter) and the punctuation keys can be hotkeys; Meta (the Windows key) never.
 */
const HOTKEY_ACTIONS = [
  { id: 'buy', name: 'Buy MKT' }, { id: 'sell', name: 'Sell MKT' }, { id: 'be', name: 'B/E' },
  { id: 'close', name: 'Close' }, { id: 'flattenAll', name: 'Flatten all' },
];
const HOTKEY_IDS = HOTKEY_ACTIONS.map(a => a.id);
const PUNCT = { Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`' };
const NUMPAD = { NumpadAdd: 'Num+', NumpadSubtract: 'Num-', NumpadMultiply: 'Num*', NumpadDivide: 'Num/', NumpadDecimal: 'Num.' };
const MOD_CODES = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$|^(AltGraph|CapsLock|NumLock|ScrollLock|Fn|FnLock|Hyper|Super|Symbol|SymbolLock)$/;
const MOD_KEYS = ['Shift', 'Control', 'Alt', 'Meta', 'OS', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'Hyper', 'Super'];
/** The key part of a combo for a KeyboardEvent.code: a hotkey key, another key's code (refused later), or '' for a modifier or no code. */
function hotkeyKeyName(code) {
  if (typeof code !== 'string' || !code || MOD_CODES.test(code)) return '';
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit([0-9])$/.exec(code))) return m[1];
  if ((m = /^Numpad([0-9])$/.exec(code))) return 'Num' + m[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (NUMPAD[code]) return NUMPAD[code];
  if (PUNCT[code]) return PUNCT[code];
  return code;                                                    // Enter, Space, ArrowLeft, Escape, ...: refused by hotkeyRefused
}
const HOTKEY_KEY = /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Num[0-9]|Num[-+*/.]|[-=[\];',./\\`])$/;
/** The combo of a KeyboardEvent ({ code, key, ctrlKey, altKey, shiftKey, metaKey }), or '' for a modifier pressed alone. */
function hotkeyCombo(e) {
  if (!e) return '';
  const k = hotkeyKeyName(e.code) || (typeof e.key === 'string' && !MOD_KEYS.includes(e.key) && /^[a-z0-9]$/i.test(e.key) ? e.key.toUpperCase() : '');
  if (!k) return '';
  return (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + (e.metaKey ? 'Meta+' : '') + k;
}
/** { ctrl, alt, shift, meta, key } of a combo text, or null when it is not one. */
function parseHotkey(s) {
  if (typeof s !== 'string') return null;
  const m = /^(Ctrl\+)?(Alt\+)?(Shift\+)?(Meta\+)?(.+)$/.exec(s);
  return m ? { ctrl: !!m[1], alt: !!m[2], shift: !!m[3], meta: !!m[4], key: m[5] } : null;
}
/* Kept by the browser or Windows (Anthony's list, and a few more of the same kind: Ctrl+Shift+W, Ctrl+Shift+R,
   Ctrl+Shift+Q, Ctrl+F4, Ctrl+0 to Ctrl+9 and F10; 1.12.0: Ctrl+Shift+C, Ctrl+O, Ctrl+U, Ctrl+G, Ctrl+K, Ctrl+E,
   Ctrl+Shift+B, Ctrl+Shift+O, Alt+Shift+I and F4). Exact combos; the F-keys below go with any modifiers. */
const RESERVED = {
  'Ctrl+W': 'closes the tab', 'Ctrl+Shift+W': 'closes the window', 'Ctrl+T': 'opens a tab', 'Ctrl+N': 'opens a window',
  'Ctrl+Shift+T': 'opens the last closed tab', 'Ctrl+R': 'reloads the page', 'Ctrl+Shift+R': 'reloads the page',
  'Ctrl+L': 'goes to the address bar', 'Ctrl+P': 'prints', 'Ctrl+S': 'saves the page', 'Ctrl+F': 'finds on the page',
  'Ctrl+H': 'opens the history', 'Ctrl+J': 'opens the downloads', 'Ctrl+D': 'bookmarks the page', 'Ctrl+Q': 'quits the browser',
  'Ctrl+Shift+Q': 'quits the browser', 'Ctrl+Shift+N': 'opens a private window', 'Ctrl+Shift+I': 'opens the developer tools',
  'Ctrl+Shift+J': 'opens the console', 'Ctrl+F4': 'closes the tab', 'Alt+F4': 'closes the window', 'Alt+D': 'goes to the address bar',
  'Alt+E': 'opens the browser menu', 'Alt+F': 'opens the browser menu', 'Ctrl+0': 'resets the page zoom',
  'Ctrl+Tab': 'switches browser tabs', 'Ctrl+Shift+Tab': 'switches browser tabs', 'Ctrl+Shift+Delete': 'clears browsing data',
  'Alt+Tab': 'switches windows in Windows', 'Alt+ArrowLeft': 'goes back', 'Alt+ArrowRight': 'goes forward', 'Alt+Home': 'opens the home page',
  // 1.12.0 (the 1.11.0 review): more the browser keeps
  'Ctrl+Shift+C': 'opens the developer tools', 'Ctrl+O': 'opens a file', 'Ctrl+U': 'shows the page source', 'Ctrl+G': 'finds the next match',
  'Ctrl+K': 'searches from the address bar', 'Ctrl+E': 'searches from the address bar', 'Ctrl+Shift+B': 'shows or hides the bookmarks bar',
  'Ctrl+Shift+O': 'opens the bookmarks', 'Alt+Shift+I': 'opens the feedback form',
};
for (let n = 1; n <= 9; n++) RESERVED['Ctrl+' + n] = 'switches browser tabs';
const RESERVED_F = { F1: 'opens help', F3: 'finds on the page', F4: 'opens the address bar list', F5: 'reloads the page', F6: 'goes to the address bar', F7: 'turns on caret browsing', F10: 'opens the browser menu', F11: 'goes full screen', F12: 'opens the developer tools' };
/* The chart's own keys, as the engine and the page read them: with any modifiers unless noted. */
const CHART_KEYS = { A: 'A fits the price axis', '=': '+ and = zoom in', 'Num+': '+ zooms in', '-': '- zooms out', 'Num-': '- zooms out' };
const OTHER_KEYS = {
  Escape: 'Escape cancels a drag and closes menus', Tab: 'Tab moves the focus', End: 'End jumps the chart to live',
  ArrowLeft: 'the arrow keys pan the chart', ArrowRight: 'the arrow keys pan the chart', Delete: 'Delete removes the selected drawing',
  Backspace: 'Backspace removes the selected drawing',
};
/** Whether a KeyboardEvent is one of the chart's own keys, read as the chart reads it (e.key, so any keyboard layout). */
function isChartKey(e) {
  if (!e || typeof e.key !== 'string') return false;
  if (['a', 'A', '+', '=', '-', '_', 'End', 'ArrowLeft', 'ArrowRight', 'Delete', 'Backspace', 'Escape'].includes(e.key)) return true;
  return e.key === '/' && !e.ctrlKey && !e.altKey && !e.metaKey;
}
/**
 * Why a combo cannot be a hotkey ('' when it can). `e`, when given, is the KeyboardEvent it came from: its e.key is
 * checked against the chart's own keys too (a layout where another key gives "a" or "/").
 */
function hotkeyRefused(combo, e) {
  const c = parseHotkey(combo);
  if (!c || !c.key) return 'Press a key.';
  if (c.meta || (e && e.metaKey)) return 'The Windows key is kept by Windows.';
  if (RESERVED[combo]) return combo + ' is kept by the browser (it ' + RESERVED[combo] + ').';
  if (RESERVED_F[c.key]) return c.key + ' is kept by the browser (it ' + RESERVED_F[c.key] + ').';
  if (CHART_KEYS[c.key]) return combo + ' is the chart\'s: ' + CHART_KEYS[c.key] + '.';
  if ((c.key === '/' || c.key === 'Num/') && !c.ctrl && !c.alt) return combo + ' is the chart\'s: / opens the Indicators menu.';
  if (OTHER_KEYS[c.key]) return combo + ' is kept: ' + OTHER_KEYS[c.key] + '.';
  if (e && isChartKey(e)) return combo + ' gives "' + e.key + '" on this keyboard, one of the chart\'s own keys.';
  if (!HOTKEY_KEY.test(c.key)) return c.key + ' cannot be a hotkey: use a letter, a digit, an F-key, the numpad or a punctuation key.';
  return '';
}
/** Hotkeys as read from storage: { buy, sell, be, close, flattenAll }, each a combo or ''. A combo that is refused, or
    already given to an action before it in the list, is dropped. Never throws. */
function cleanHotkeys(v) {
  const out = {}, used = new Set();
  for (const id of HOTKEY_IDS) {
    let c = '';
    try { c = v && typeof v === 'object' && !Array.isArray(v) && typeof v[id] === 'string' ? v[id] : ''; } catch (e) { c = ''; }
    if (c && (c.length > 32 || hotkeyRefused(c) || used.has(c))) c = '';
    if (c) used.add(c);
    out[id] = c;
  }
  return out;
}
/**
 * Setting a hotkey from a key press: { combo, error, held }. `held` is true for a modifier pressed alone (the field
 * shows it while the key is held). `keys` are the hotkeys in use, `id` the action being set.
 */
function hotkeyFromEvent(e, keys, id) {
  const combo = hotkeyCombo(e);
  if (!combo) {
    const mods = [e && e.ctrlKey ? 'Ctrl' : '', e && e.altKey ? 'Alt' : '', e && e.shiftKey ? 'Shift' : ''].filter(Boolean);
    if (e && (e.metaKey || e.key === 'Meta' || e.key === 'OS')) return { combo: '', error: 'The Windows key is kept by Windows.', held: false };
    return { combo: '', error: (mods.length ? mods.join('+') + ' alone is' : 'A modifier alone is') + ' not a hotkey: hold it and press a key.', held: true };
  }
  const why = hotkeyRefused(combo, e);
  if (why) return { combo, error: why, held: false };
  const other = HOTKEY_ACTIONS.find(a => a.id !== id && keys && keys[a.id] === combo);
  if (other) return { combo, error: combo + ' is already ' + other.name + '. Clear it there first.', held: false };
  return { combo, error: '', held: false };
}
/** The action a combo fires ('' for none). */
function hotkeyAction(keys, combo) {
  if (!combo || !keys) return '';
  const a = HOTKEY_ACTIONS.find(x => keys[x.id] === combo);
  return a ? a.id : '';
}

return { HOTKEY_ACTIONS, hotkeyKeyName, hotkeyCombo, parseHotkey, hotkeyRefused, isChartKey, cleanHotkeys, hotkeyFromEvent, hotkeyAction, flattenAllRoots,
  MAX_BRACKET_TICKS, NO_CAP, versionOf, versionAtLeast, bracketCap, planIdOf, plannedLines, planDrag, BRACKET_RATIOS, BRACKET_PRESET_MAX, BRACKET_PRESET_NAME_MAX, QTY_CHOICES, ratioOf, ratioBracket, bracketPresetName, defaultPresetName, cleanBracketPresets, qtyOptions, breakEvenPrice, breakEvenLegs, breakEvenAllowed, paceChunks, isWorking, bracketAllowed, opensPosition, placeKind, maxQtyFor, checkQty, cleanBracket, defaultAccount, openEntryFills, cancelAllIds, orderEvent, legSummary, protectionLine, repeatGuard };
});
