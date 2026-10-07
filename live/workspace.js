/*
 * The trading workspace (live/index.html, ChartBridge's main page since E2a; the single chart page is /single.html):
 * independent panels on a 12 x 6 snap grid, one browser window per screen, each window with its own saved layout opened
 * from its URL (?layout=Main, ?layout=Second, any name).
 *
 * Panels: charts (each a read-only ChartLive.mount with its own paneId, instrument and timeframe, under a slim header),
 * Time and Sales tapes, and the order ticket's place (a placeholder in this build; the ticket comes in E2b). Every chart
 * and tape takes its instrument's data from the window's one connection for that instrument (ChartFeed, live/feed.js).
 *
 * This file has two parts:
 *   WorkspaceCore  the pure parts (layout cleaning, snapping, overlap checks, the largest free rectangle, re-flow, the
 *                  large-print floor by time of day, formatting). No DOM; it also loads in Node for test/workspace.test.js.
 *   the page       runs only in a browser, after live.js (ChartLive), feed.js (ChartFeed) and pin.js (ChartBridgePin).
 *
 * Saved in this browser's localStorage under the same prefix as the single chart page (none), so colors, color presets,
 * indicator colors, Glide, Range style, bracket presets, Qty and hotkeys are the same on both pages (each chart keeps its
 * own indicators and drawings under its paneId, the panel id). The workspace's own keys:
 *   live-workspace-v1     { v: 1, layouts: { <name>: { panels: [{ id, type: 'chart' | 'tape' | 'ticket', root, tf, range?,
 *                         x, y, w, h }] } } }  (x, y from 0; w, h in cells; tapes have no tf, the ticket no root)
 *   live-tape-floors-v1   { <root>: { rth, eth } } the large-print floors (Time and Sales), only those set by hand; the same
 *                         key as the charts' bubbles (LivePrefs.largeFloors, read through it since 1.14.0)
 *   live-tape-colors-v1   { above, ask, mid, bid, below } the Time and Sales category colors (1.14.0), only those set by hand
 *   live-ws-keys-v1       { maximize } the workspace's own hotkeys (1.16.0): Maximize panel, a combo or ''; none by default,
 *                         never one of the trading hotkeys (live-hotkeys-v1 wins)
 *   live-ws-laptop-v1     true: this browser shows the layouts as two tabs, Main and Second, with tight margins (1.16.0)
 * Every write reads the key fresh and changes one layout (or one floor), so two windows never undo each other.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WorkspaceCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const COLS = 12, ROWS = 6, MIN_W = 2, MIN_H = 1, MAX_PANELS = 12, MAX_LAYOUTS = 50, NAME_MAX = 40;
/* The same lists as LivePrefs.ROOTS and LivePrefs.TFS in live.js (a test checks they match). */
const ROOTS = ['MNQ', 'NQ', 'MES', 'ES'];
/* 1.16.0 (Anthony 2026-10-05): the Quote board's rows, NQ and ES only. Display only: the charts and the order ticket still
   trade every root in ROOTS. */
const QUOTE_ROOTS = ['NQ', 'ES'];
const TFS = ['s15', 's30', 'm1', 'm5', 'm15', 'h1', 'range', 'h4', 'd1', 'w1'];
/* 1.15.0: NinjaTrader's own 4h, 1D and 1W bars (ChartBridge 0.3.7 htf); with an older ChartBridge the choices show and say
   what they need */
const HTF_TFS = ['h4', 'd1', 'w1'];
const RANGE_MIN = 1, RANGE_MAX = 400;
const KEYS = { store: 'live-workspace-v1', floors: 'live-tape-floors-v1', tapeColors: 'live-tape-colors-v1', viewKeys: 'live-ws-keys-v1', laptop: 'live-ws-laptop-v1' };
/* 1.16.0 (Anthony): the laptop preset: two layout tabs, both blank to start, arranged by hand; tight margins (the grid's gap
   and padding, px) */
const LAPTOP_TABS = ['Main', 'Second'];
const GAP = 6, GAP_TIGHT = 2;
const DEFAULT_NAME = 'Main';
/* Large prints on the tape: RTH 09:30 to 16:15 ET, overnight the rest (Anthony, 2026-10-01). */
const RTH_START = 9 * 3600 + 30 * 60, RTH_END = 16 * 3600 + 15 * 60;
const DEFAULT_FLOORS = { NQ: { rth: 50, eth: 25 }, ES: { rth: 100, eth: 50 }, MNQ: { rth: 100, eth: 50 }, MES: { rth: 100, eth: 50 } };
const FLOOR_MAX = 100000;
const TF_LABEL = { s15: '15 sec', s30: '30 sec', m1: '1 min', m5: '5 min', m15: '15 min', h1: '1 hour', range: 'Range', h4: '4 hour', d1: '1 day', w1: '1 week' };

const own = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const ID_RX = /^[A-Za-z0-9_-]{1,40}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

/** A layout name as kept: trimmed, inner spaces as one, at most 40 characters; '' when nothing usable is left. */
function layoutName(v) {
  if (typeof v !== 'string') return '';
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
  return s && !RESERVED.has(s) ? s : '';
}
/** A range size in ticks (a whole number 1 to 400), else null. */
function parseRange(v) { const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return Number.isInteger(n) && n >= RANGE_MIN && n <= RANGE_MAX ? n : null; }

/* 1.15.0: the Account panel and the Quote board (Anthony's consolidated form, 2026-10-02) take no instrument; nor does the
   Data Box (1.16.0: the bar under the cursor on any chart) */
const TYPES = ['chart', 'tape', 'ticket', 'account', 'quotes', 'databox'];
/** One panel, or null when its shape is bad. Position and size are whole cells; re-flow puts them inside the grid. */
function cleanPanel(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (!TYPES.includes(p.type)) return null;
  if (typeof p.id !== 'string' || !ID_RX.test(p.id)) return null;
  if ((p.type === 'chart' || p.type === 'tape') && !ROOTS.includes(p.root)) return null;
  const { x, y, w, h } = p;
  if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1 || x > 99 || y > 99 || w > 99 || h > 99) return null;
  const out = { id: p.id, type: p.type };
  if (p.type === 'chart') {
    if (!TFS.includes(p.tf)) return null;
    out.root = p.root; out.tf = p.tf;
    const r = parseRange(p.range);
    if (r !== null) out.range = r;
  } else if (p.type === 'tape') out.root = p.root;
  return Object.assign(out, { x, y, w, h });
}

/** A layout as kept: { panels } with bad panels dropped, ids unique, at most 12 panels, at most one order ticket, every
    panel inside the grid and none overlapping (re-flow). Never throws. */
function cleanLayout(l) {
  const list = l && typeof l === 'object' && Array.isArray(l.panels) ? l.panels : [];
  const seen = new Set(), panels = [];
  let ticket = false;
  for (const raw of list) {
    if (panels.length >= MAX_PANELS) break;
    const p = cleanPanel(raw);
    if (!p || seen.has(p.id)) continue;
    if (p.type === 'ticket') { if (ticket) continue; ticket = true; }
    seen.add(p.id);
    panels.push(p);
  }
  return { panels: reflow(panels) };
}

/** The whole store, from a JSON string or an object: { v: 1, layouts }. Bad shapes dropped; never throws. */
function cleanStore(raw) {
  let v = raw;
  if (typeof raw === 'string') { try { v = JSON.parse(raw); } catch (e) { v = null; } }
  const out = { v: 1, layouts: {} };
  if (!v || typeof v !== 'object' || !v.layouts || typeof v.layouts !== 'object' || Array.isArray(v.layouts)) return out;
  let n = 0;
  for (const k of Object.keys(v.layouts)) {
    const name = layoutName(k);
    if (!name || name !== k || n >= MAX_LAYOUTS) continue;
    const l = v.layouts[k];
    if (!l || typeof l !== 'object' || !Array.isArray(l.panels)) continue;
    out.layouts[name] = cleanLayout(l);
    n++;
  }
  return out;
}

/* ---------------- cells */
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inGrid = (r, cols = COLS, rows = ROWS) => r.x >= 0 && r.y >= 0 && r.w >= MIN_W && r.h >= MIN_H && r.x + r.w <= cols && r.y + r.h <= rows;
/** True when rect r is inside the grid and overlaps no panel but the one with id ignoreId. */
function fits(r, panels, ignoreId, cols = COLS, rows = ROWS) {
  return inGrid(r, cols, rows) && !panels.some(q => q.id !== ignoreId && overlaps(q, r));
}
function occupancy(panels, cols, rows) {
  const g = Array.from({ length: rows }, () => new Array(cols).fill(false));
  for (const p of panels) for (let y = Math.max(0, p.y); y < Math.min(rows, p.y + p.h); y++) for (let x = Math.max(0, p.x); x < Math.min(cols, p.x + p.w); x++) g[y][x] = true;
  return g;
}
/** The largest free rectangle (by area; the top-left one on a tie), at least 2 x 1 cells, or null when there is none. */
function largestFree(panels, cols = COLS, rows = ROWS) {
  const g = occupancy(panels, cols, rows);
  let best = null;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (g[y][x]) continue;
    let maxW = cols - x;                       // the widest free run so far, narrowing as rows are added
    for (let h = 1; y + h <= rows; h++) {
      let w = 0;
      while (w < maxW && !g[y + h - 1][x + w]) w++;
      maxW = w;
      if (!maxW) break;
      if (maxW >= MIN_W && h >= MIN_H && (!best || maxW * h > best.w * best.h)) best = { x, y, w: maxW, h };
    }
  }
  return best;
}
/** The first place (top row first) where a w x h panel fits, or null. */
function findSpot(panels, w, h, cols = COLS, rows = ROWS) {
  for (let y = 0; y + h <= rows; y++) for (let x = 0; x + w <= cols; x++) if (fits({ x, y, w, h }, panels, null, cols, rows)) return { x, y, w, h };
  return null;
}
/**
 * Re-flow: every panel inside a cols x rows grid, at least 2 x 1, none overlapping. A panel past the edge is moved back
 * in (shrunk only when it is bigger than the grid); one that overlaps an earlier one goes to the first place its size
 * fits, else into the largest free rectangle; only when the grid has no free 2 x 1 left is it dropped.
 */
function reflow(panels, cols = COLS, rows = ROWS) {
  const placed = [];
  for (const p of panels) {
    const w = clamp(p.w, MIN_W, cols), h = clamp(p.h, MIN_H, rows);
    let r = { x: clamp(p.x, 0, cols - w), y: clamp(p.y, 0, rows - h), w, h };
    if (placed.some(q => overlaps(q, r))) {
      r = findSpot(placed, w, h, cols, rows) || largestFree(placed, cols, rows);
      if (!r) continue;
    }
    placed.push(Object.assign({}, p, r));
  }
  return placed;
}

/* ---------------- pixels to cells: the grid's metrics, and a drag or a resize snapped to whole cells */
/** Cell size from the grid element's inner size: { cw, ch, gap, pad, cols, rows }. */
function metrics(width, height, gap = 6, pad = 6, cols = COLS, rows = ROWS) {
  return { cw: Math.max(1, (width - 2 * pad - (cols - 1) * gap) / cols), ch: Math.max(1, (height - 2 * pad - (rows - 1) * gap) / rows), gap, pad, cols, rows };
}
/** A panel moved by (dx, dy) pixels, snapped to the nearest whole cell and kept inside the grid. */
function snapMove(p, dx, dy, m) {
  const w = p.w, h = p.h;
  return { x: clamp(p.x + Math.round(dx / (m.cw + m.gap)), 0, m.cols - w), y: clamp(p.y + Math.round(dy / (m.ch + m.gap)), 0, m.rows - h), w, h };
}
/** A panel resized from its bottom right corner by (dw, dh) pixels, snapped to whole cells, at least 2 x 1. */
function snapResize(p, dw, dh, m) {
  return { x: p.x, y: p.y, w: clamp(p.w + Math.round(dw / (m.cw + m.gap)), MIN_W, m.cols - p.x), h: clamp(p.h + Math.round(dh / (m.ch + m.gap)), MIN_H, m.rows - p.y) };
}
/* The resize handles (1.14.0, Anthony: "from any edge or corner"): the edges each handle moves. */
const EDGES = { n: 'n', s: 's', e: 'e', w: 'w', ne: 'ne', nw: 'nw', se: 'se', sw: 'sw' };
/**
 * A panel resized from an edge or corner (`edge`: 'n', 's', 'e', 'w' or two of them, 'ne', 'nw', 'se', 'sw') by (dx, dy)
 * pixels, snapped to whole cells: the edges handled move, the opposite ones stay put; at least 2 x 1, inside the grid.
 */
function snapResizeEdge(p, edge, dx, dy, m) {
  const e = typeof edge === 'string' ? edge : '';
  const kx = Math.round(dx / (m.cw + m.gap)), ky = Math.round(dy / (m.ch + m.gap));
  let x0 = p.x, x1 = p.x + p.w, y0 = p.y, y1 = p.y + p.h;
  if (e.includes('e')) x1 = clamp(x1 + kx, x0 + MIN_W, m.cols);
  if (e.includes('w')) x0 = clamp(x0 + kx, 0, x1 - MIN_W);
  if (e.includes('s')) y1 = clamp(y1 + ky, y0 + MIN_H, m.rows);
  if (e.includes('n')) y0 = clamp(y0 + ky, 0, y1 - MIN_H);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/* ---------------- Time and Sales: large prints */
/** Seconds into the New York day of a bar-time stamp (exchange wall clock stored as if UTC). */
const secOfDay = t => ((Math.floor(t) % 86400) + 86400) % 86400;
/** RTH, 09:30 to 16:15 ET, by the trade's own time. */
const isRth = t => { const s = secOfDay(t); return s >= RTH_START && s < RTH_END; };
function cleanFloor(v) { const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return Number.isInteger(n) && n >= 1 && n <= FLOOR_MAX ? n : null; }
/** The floors for every root: saved ones where valid, else the defaults. */
function cleanFloors(v) {
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
  const out = {};
  for (const r of ROOTS) {
    const s = own(v, r) ? v[r] : null, d = DEFAULT_FLOORS[r];
    const rth = own(s, 'rth') ? cleanFloor(s.rth) : null, eth = own(s, 'eth') ? cleanFloor(s.eth) : null;
    out[r] = { rth: rth === null ? d.rth : rth, eth: eth === null ? d.eth : eth };
  }
  return out;
}
/** The large-print floor for a root at trade time t (RTH or overnight). */
function floorAt(root, t, floors) {
  const f = floors && own(floors, root) ? floors[root] : DEFAULT_FLOORS[root] || { rth: Infinity, eth: Infinity };
  return isRth(t) ? f.rth : f.eth;
}

/* ---------------- Time and Sales categories (1.14.0, Anthony: "NinjaTrader style"; ChartBridge 0.3.8's q): where a trade
   printed against the quote, each with its own color (CHART_STYLE --tape-*), editable in the tape's gear. Above the ask and
   below the bid are the brighter pair. A trade with no q (ChartBridge before 0.3.8, or no usable quote) is colored by its
   side as before (buy green, sell red, unknown plain). */
const TAPE_CATS = [
  { q: 2, key: 'above', name: 'Above the ask', def: '#9CF5CB' },
  { q: 1, key: 'ask', name: 'At the ask', def: '#3DDC97' },
  { q: 0, key: 'mid', name: 'Between', def: '#9AA8B8' },
  { q: -1, key: 'bid', name: 'At the bid', def: '#FF5C7A' },
  { q: -2, key: 'below', name: 'Below the bid', def: '#FFA3B4' },
];
const TAPE_HEX = /^#[0-9a-f]{6}$/i;
/** The category colors: the ones set by hand (#RRGGBB, upper case) where valid, else the defaults. */
function cleanTapeColors(v) {
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
  const out = {};
  for (const c of TAPE_CATS) out[c.key] = own(v, c.key) && typeof v[c.key] === 'string' && TAPE_HEX.test(v[c.key]) ? v[c.key].toUpperCase() : c.def;
  return out;
}
/** The row class of a trade: its category ('q2', 'q1', 'q0', 'qm1', 'qm2') when q is known, else its side ('buy',
    'sell') or '' (unknown side). q: -2 to 2, or anything else for unknown. */
function tapeClass(q, s) {
  if (q === 2 || q === 1 || q === 0 || q === -1 || q === -2) return q < 0 ? 'qm' + -q : 'q' + q;
  return s > 0 ? 'buy' : s < 0 ? 'sell' : '';
}
function readTapeColors(storage) { try { return cleanTapeColors(storage.getItem(KEYS.tapeColors)); } catch (e) { return cleanTapeColors(null); } }
/** Set one category's color (read fresh, only that one written); null goes back to its default. false when not allowed. */
function setTapeColor(storage, key, hex) {
  if (!TAPE_CATS.some(c => c.key === key) || (hex !== null && !(typeof hex === 'string' && TAPE_HEX.test(hex)))) return false;
  let saved = {};
  try { const v = JSON.parse(storage.getItem(KEYS.tapeColors)); if (v && typeof v === 'object' && !Array.isArray(v)) saved = v; } catch (e) { saved = {}; }
  const out = {};
  for (const c of TAPE_CATS) if (own(saved, c.key) && typeof saved[c.key] === 'string' && TAPE_HEX.test(saved[c.key])) out[c.key] = saved[c.key].toUpperCase();
  if (hex === null) delete out[key]; else out[key] = hex.toUpperCase();
  try { storage.setItem(KEYS.tapeColors, JSON.stringify(out)); return true; } catch (e) { return false; }
}
function resetTapeColors(storage) { try { storage.setItem(KEYS.tapeColors, JSON.stringify({})); return true; } catch (e) { return false; } }

/* ---------------- the Account panel (1.15.0): today's fills as flat-to-flat trades, from the fills ChartBridge sends */
const SESSION = 18 * 3600;
const tradeDayOf = t => Math.floor((t + 86400 - SESSION) / 86400);   // the engine's util.tradeDay with the 18:00 ET session
/**
 * Round trips from one account's fills: for each instrument, the fills in time order from flat to flat are one trade.
 * `fills` [{ id, t, root, side: 'buy' | 'sell', qty, p }]; `pointValue(root)`; `start` { root: signed qty } the position
 * each instrument had before the first of these fills (0 when left out; not flat: that first trade's P&L is unknown, null,
 * since its earlier fills are not here). A fill that reverses the position closes the trade and opens the next with the
 * rest. Realized P&L by average price, also for a trade still open (its closed part), dollars, before commissions.
 * Returns { byFill: Map id -> { pnl, open } (on the fill that went flat: the trade's P&L or null; on the last fill of a
 * trade still open: open true), trades (closed ones), realized (dollars, or null when a closed part is unknown),
 * unknown (trades whose P&L is unknown) }.
 */
function roundTrips(fills, pointValue, start) {
  const list = (Array.isArray(fills) ? fills : []).filter(f => f && (f.side === 'buy' || f.side === 'sell') && +f.qty > 0 && isFinite(f.p) && isFinite(f.t))
    .slice().sort((a, b) => a.t - b.t || String(a.id).localeCompare(String(b.id)));
  const st = {}, byFill = new Map();
  let trades = 0, realized = 0, unknown = 0, realizedKnown = true;
  for (const f of list) {
    const r = f.root, pv = +pointValue(r) || 0;
    if (!st[r]) { const q0 = start && +start[r] ? +start[r] : 0; st[r] = { pos: q0, avg: null, pnl: 0, known: q0 === 0, last: null }; }
    const x = st[r], q = (f.side === 'buy' ? 1 : -1) * +f.qty, p = +f.p;
    let rest = q;
    if (x.pos !== 0 && Math.sign(rest) !== Math.sign(x.pos)) {           // closes all or part of the position
      const close = Math.sign(rest) * Math.min(Math.abs(rest), Math.abs(x.pos));
      if (x.avg !== null) x.pnl += (p - x.avg) * -close * pv; else x.known = false;
      x.pos += close; rest -= close;
      if (x.pos === 0) {                                                 // flat: the trade is done
        trades++;
        if (x.known) realized += x.pnl; else { unknown++; realizedKnown = false; }
        byFill.set(f.id, { pnl: x.known ? x.pnl : null, open: false });
        x.avg = null; x.pnl = 0; x.known = true;
      }
    }
    if (rest !== 0) {                                                    // opens or adds: the average price
      x.avg = x.pos === 0 || x.avg === null ? p : (x.avg * Math.abs(x.pos) + p * Math.abs(rest)) / (Math.abs(x.pos) + Math.abs(rest));
      if (x.pos !== 0 && !x.known) x.avg = null;                        // added to a position from before: its price is not known
      x.pos += rest;
    }
    x.last = f.id;
  }
  for (const r of Object.keys(st)) {
    const x = st[r];
    if (x.pos !== 0 && x.last !== null && !byFill.has(x.last)) byFill.set(x.last, { pnl: null, open: true });
    if (x.pos !== 0) { if (x.known) realized += x.pnl; else if (x.pnl) realizedKnown = false; }   // the closed part of a trade still open
  }
  return { byFill, trades, realized: realizedKnown ? realized : null, unknown };
}
/** The fills of one trading day (from 18:00 ET the day before), at bar time `now` (New York wall clock as seconds). */
function fillsToday(fills, account, now) {
  const d = tradeDayOf(now);
  return (Array.isArray(fills) ? fills : []).filter(f => f && f.account === account && isFinite(f.t) && tradeDayOf(+f.t) === d);
}

/* ---------------- the Quote board (1.15.0): last, change and percent from the prior settlement (ChartBridge 0.3.7; blank
   without, never estimated), the session's high and low */
/** { chg, pct } of `last` against the prior settlement, or nulls when either is missing. */
function quoteChange(last, settle) {
  const ok = typeof last === 'number' && typeof settle === 'number' && isFinite(last) && isFinite(settle) && settle > 0;
  return ok ? { chg: last - settle, pct: (last - settle) / settle * 100 } : { chg: null, pct: null };
}
/** The session's high and low (from 18:00 ET) at bar time `now` from 1-minute bars [{ t, h, l }], or nulls. */
function sessionRange(bars, now) {
  const d = tradeDayOf(now);
  let hi = null, lo = null;
  for (const b of bars || []) { if (!b || tradeDayOf(b.t) !== d) continue; if (hi === null || b.h > hi) hi = b.h; if (lo === null || b.l < lo) lo = b.l; }
  return { high: hi, low: lo };
}
/** A signed number with thousands separators: +293.25, -1,204.50 (decimals), '' for null. */
function fmtSignedNum(v, dec) { return v === null || v === undefined || !isFinite(v) ? '' : (v > 0 ? '+' : v < 0 ? '-' : '') + fmtPrice(Math.abs(v), dec); }
/** Dollars as the panels show them: +$412.50, -$22.00, $0.00; '' for null. */
function fmtUsd(v) { return v === null || v === undefined || !isFinite(v) ? '' : (v > 0.004 ? '+' : v < -0.004 ? '-' : '') + '$' + fmtPrice(Math.abs(v), 2); }

/* ---------------- formatting */
const p2 = n => (n < 10 ? '0' : '') + n;
/** HH:MM:SS of a bar-time stamp (New York time). */
function fmtClock(t) { const s = secOfDay(t); return p2(Math.floor(s / 3600)) + ':' + p2(Math.floor(s / 60) % 60) + ':' + p2(s % 60); }
/** A price with thousands separators and `dec` decimals: 30604.25 -> "30,604.25". */
function fmtPrice(p, dec) {
  const s = Math.abs(p).toFixed(dec), i = s.indexOf('.'), int = i < 0 ? s : s.slice(0, i), frac = i < 0 ? '' : s.slice(i);
  return (p < 0 ? '-' : '') + int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + frac;
}
const decimalsOf = tick => { const s = String(tick); const i = s.indexOf('.'); return i < 0 ? 0 : Math.min(6, s.length - i - 1); };
/** The header text of a chart's timeframe: "5 min", "1 hour", "Range 40". */
function tfLabel(tf, range) { return tf === 'range' ? 'Range' + (range ? ' ' + range : '') : TF_LABEL[tf] || tf; }

/* ---------------- the workspace's own hotkeys (1.16.0): Maximize panel */
const VIEW_KEYS = [{ id: 'maximize', name: 'Maximize panel' }];
/** The workspace's hotkeys as kept: { maximize } each a combo or ''. `trading` are the trading hotkeys in use (they win: a
    combo one of them has is dropped here), `refused(combo)` the trading hotkeys' own rule ('' when a combo can be a hotkey,
    OrderTicket.hotkeyRefused). Never throws. */
function cleanViewKeys(v, trading, refused) {
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
  const used = new Set(Object.values(trading || {}).filter(Boolean)), out = {};
  for (const k of VIEW_KEYS) {
    let c = own(v, k.id) && typeof v[k.id] === 'string' ? v[k.id] : '';
    if (c && (c.length > 32 || (typeof refused === 'function' && refused(c)) || used.has(c))) c = '';
    if (c) used.add(c);
    out[k.id] = c;
  }
  return out;
}

/* ---------------- the Data Box (1.16.0) */
/** How long a bar lasted, or has lasted so far, from whole seconds: "12 s", "4:05", "1:02:03", "2d 04h". */
function fmtSpan(sec) {
  if (!(sec >= 0) || !isFinite(sec)) return '';
  const s = Math.round(sec);
  if (s < 60) return s + ' s';
  if (s >= 86400) return Math.floor(s / 86400) + 'd ' + p2(Math.floor(s % 86400 / 3600)) + 'h';
  if (s >= 3600) return Math.floor(s / 3600) + ':' + p2(Math.floor(s % 3600 / 60)) + ':' + p2(s % 60);
  return Math.floor(s / 60) + ':' + p2(s % 60);
}

/* ---------------- layouts */
let idSeq = 0;
/** A new panel id (also the chart's paneId): stable once saved. */
function newId() { return 'p' + Date.now().toString(36) + (++idSeq).toString(36) + Math.random().toString(36).slice(2, 6); }
/**
 * The default layout (Anthony, 2026-10-01: the mockup's, with the order ticket in place of the execution chart): MNQ
 * Range 40 top left (cols 1 to 7, rows 1 to 4), MNQ under it (cols 1 to 7, rows 5 to 6; 1 hour bars until ChartBridge
 * 0.3.7 brings daily bars), NQ 5 min and ES 1 min stacked in the middle (cols 8 to 10), the order ticket top right
 * (cols 11 to 12) and Time and Sales under it (cols 11 to 12). The first chart starts with the
 * single chart page's indicators (the page's main pane defaults); every other new chart with none.
 * 1.12.0: the ticket takes rows 1 to 3 and Time and Sales rows 4 to 6, so the whole ticket shows at 1366x768 (Anthony:
 * Time and Sales gives up rows). A layout saved before keeps its own sizes (the ticket scrolls inside if it is short).
 */
function defaultLayout(makeId = newId) {
  return { panels: [
    { id: makeId(), type: 'chart', root: 'MNQ', tf: 'range', range: 40, x: 0, y: 0, w: 7, h: 4 },
    { id: makeId(), type: 'chart', root: 'MNQ', tf: 'h1', x: 0, y: 4, w: 7, h: 2 },
    { id: makeId(), type: 'chart', root: 'NQ', tf: 'm5', x: 7, y: 0, w: 3, h: 3 },
    { id: makeId(), type: 'chart', root: 'ES', tf: 'm1', x: 7, y: 3, w: 3, h: 3 },
    { id: makeId(), type: 'ticket', x: 10, y: 0, w: 2, h: 3 },
    { id: makeId(), type: 'tape', root: 'MNQ', x: 10, y: 3, w: 2, h: 3 },
  ] };
}

/* ---------------- the store in a storage ({ getItem, setItem }); every call is wrapped and reads the key fresh */
function readStore(storage) { try { return cleanStore(storage.getItem(KEYS.store)); } catch (e) { return cleanStore(null); } }
function writeStore(storage, s) { try { storage.setItem(KEYS.store, JSON.stringify(s)); return true; } catch (e) { return false; } }
/** Save one layout (read fresh, only that layout written). */
function saveLayout(storage, name, layout) {
  name = layoutName(name); if (!name) return false;
  const s = readStore(storage);
  if (!own(s.layouts, name) && Object.keys(s.layouts).length >= MAX_LAYOUTS) return false;
  s.layouts[name] = cleanLayout(layout);
  return writeStore(storage, s);
}
function deleteLayout(storage, name) {
  const s = readStore(storage);
  if (!own(s.layouts, name)) return false;
  delete s.layouts[name];
  return writeStore(storage, s);
}
/** Rename a layout; false when the new name is taken or not usable. */
function renameLayout(storage, from, to) {
  to = layoutName(to);
  const s = readStore(storage);
  if (!to || !own(s.layouts, from) || (to !== from && own(s.layouts, to))) return false;
  const next = {};
  for (const k of Object.keys(s.layouts)) next[k === from ? to : k] = s.layouts[k];   // keeps the order
  s.layouts = next;
  return writeStore(storage, s);
}
function readFloors(storage) { try { return cleanFloors(storage.getItem(KEYS.floors)); } catch (e) { return cleanFloors(null); } }
/** Set one floor ('rth' or 'eth') of one root; false when the value is not a whole number 1 to 100000. */
function setFloor(storage, root, which, value) {
  const n = cleanFloor(value);
  if (n === null || !ROOTS.includes(root) || (which !== 'rth' && which !== 'eth')) return false;
  let saved = {};
  try { const v = JSON.parse(storage.getItem(KEYS.floors)); if (v && typeof v === 'object' && !Array.isArray(v)) saved = v; } catch (e) { saved = {}; }
  const out = {};
  for (const r of ROOTS) if (own(saved, r) && saved[r] && typeof saved[r] === 'object') out[r] = Object.assign({}, saved[r]);
  out[root] = Object.assign({}, out[root] || {}, { [which]: n });
  try { storage.setItem(KEYS.floors, JSON.stringify(out)); return true; } catch (e) { return false; }
}

return { COLS, ROWS, MIN_W, MIN_H, MAX_PANELS, MAX_LAYOUTS, NAME_MAX, ROOTS, TFS, TYPES, KEYS, DEFAULT_NAME, DEFAULT_FLOORS, RTH_START, RTH_END,
  layoutName, parseRange, cleanPanel, cleanLayout, cleanStore, overlaps, fits, largestFree, findSpot, reflow, metrics, snapMove, snapResize, snapResizeEdge, EDGES,
  isRth, cleanFloors, floorAt, fmtClock, fmtPrice, decimalsOf, tfLabel, newId, defaultLayout, LAPTOP_TABS, GAP, GAP_TIGHT, VIEW_KEYS, cleanViewKeys, fmtSpan,
  readStore, saveLayout, deleteLayout, renameLayout, readFloors, setFloor, HTF_TFS,
  roundTrips, fillsToday, QUOTE_ROOTS, quoteChange, sessionRange, fmtSignedNum, fmtUsd, tradeDayOf,
  TAPE_CATS, cleanTapeColors, tapeClass, readTapeColors, setTapeColor, resetTapeColors };
});




/* ======================================================================== the page (browser only) */
/* A window loaded while the PC updater writes the page files can get this workspace.js with an older index.html (which
   does not load trade.js or ticket-link.js: they are fetched here first) or an older live.js (then nothing would work:
   the window says to reload instead of breaking). */
if (typeof document !== 'undefined' && typeof window !== 'undefined' && window.ChartLive && window.ChartFeed) (function boot(page) {
  const me = document.currentScript;
  const ok = () => !!window.TradeCore && !!window.TicketLink && typeof window.ChartLive.hotkeyHandler === 'function';
  const stop = () => { const d = document.createElement('div'); d.className = 'ws-reload'; d.setAttribute('role', 'alert'); d.textContent = 'The page files were being updated as this window opened. Reload it (when flat) to trade from it.'; document.body.prepend(d); };
  if (ok()) { page(); return; }
  const load = f => new Promise(res => { const sc = document.createElement('script'); sc.src = new URL(f, me ? me.src : location.href).href; sc.onload = sc.onerror = res; document.head.appendChild(sc); });
  Promise.all([['TradeCore', 'trade.js'], ['TicketLink', 'ticket-link.js']].filter(([g]) => !window[g]).map(([, f]) => load(f))).then(() => { if (ok()) page(); else stop(); });
})(() => {
'use strict';
const W = window.WorkspaceCore, LP = window.LivePrefs, OT = window.OrderTicket, PIN = window.ChartBridgePin || null;
const PREFIX = '';                                 // the single chart page's prefix (none): its settings are this page's
const TAPE_MAX = 500, TAPE_ROW = 18;
const TF_SHORT = { s15: '15s', s30: '30s', m1: '1m', m5: '5m', m15: '15m', h1: '1h', range: 'Range', h4: '4h', d1: '1D', w1: '1W' };
/* 1.15.0: the 1 hour chart loads 30 days of 1-minute history (15 minute 10, the rest 5); 4h, 1D and 1W are NinjaTrader's
   own bars from ChartBridge 0.3.7 */
const H1_NOTE = 'Built from 30 days of 1-minute history.';
const HTF_NOTE = 'NinjaTrader\'s own bars (about 300), from ChartBridge 0.3.7 or newer.';
const HTF_OLD = 'Needs ChartBridge 0.3.7 or newer';
/* ChartBridge's version from this window's hello: 4h, 1D and 1W need 0.3.7 (the choices show and say so before it) */
const htfServed = () => !bridgeVer || bridgeFeatures.includes('htf');

/* ---------------- storage, wrapped (private windows and blocked site data throw) */
const LS = (() => { try { return window.localStorage; } catch (e) { return null; } })();
const store = {
  getItem: k => { try { return LS ? LS.getItem(PREFIX + k) : null; } catch (e) { return null; } },
  setItem: (k, v) => { try { if (LS) LS.setItem(PREFIX + k, v); } catch (e) { /* full or blocked */ } },
};
const prefs = LP.create(store);                    // the single chart page's settings (Glide, Range style, hotkeys)

/* ---------------- ChartBridge: the page's own origin, unlocked with ChartBridge's PIN (0.3.2) like the single chart page.
   One connection per instrument for the whole window (live/feed.js), shared by every chart and tape showing it. */
const BASE_WS = (() => {
  const onBridge = location.protocol.startsWith('http') && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(location.host);
  return onBridge ? 'ws://' + location.host + '/ws' : 'ws://localhost:8765/ws';
})();
const wsUrl = () => (PIN ? PIN.wsUrl(BASE_WS) : BASE_WS);
const hub = window.ChartFeed.create({ wsUrl });

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const grid = $('wsGrid'), ghost = $('wsGhost');

let layout = '';                                   // the open layout's name
let panels = [];                                   // its panels (the saved shape)
const views = new Map();                           // panel id -> { panel, el, head, body, destroy, state, ... }
/* The large-print floors: the one key the charts' bubbles use (LivePrefs.largeFloors, live-tape-floors-v1), looked up by
   the signals' own rule (ChartEngine.largeFloorAt: RTH 09:30 to 16:15 ET, else overnight). */
let floors = prefs.largeFloors();
const bigFloor = (root, t) => window.ChartEngine.largeFloorAt(floors[root] || { rth: Infinity, eth: Infinity }, t);
const readFloorsNow = () => { floors = prefs.largeFloors(); };
/* The Time and Sales category colors (1.14.0): CSS variables on the page, so every tape follows a change at once. */
let tapeColors = W.readTapeColors(store);
function applyTapeColors() { for (const c of W.TAPE_CATS) document.documentElement.style.setProperty('--tape-' + c.key, tapeColors[c.key]); }
applyTapeColors();

/* ---------------- top bar: clock, connection, notes */
const clockFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function tickClock() { $('wsClock').textContent = clockFmt.format(new Date()); }
tickClock();
setTimeout(() => { tickClock(); setInterval(tickClock, 1000); }, 1000 - (Date.now() % 1000));

function syncConn() {
  const states = [...views.values()].filter(v => v.state).map(v => v.state);
  const el = $('wsConn');
  let text, cls;
  if (!states.length) { text = 'No charts'; cls = ''; }
  else if (states.includes('offline')) { text = 'OFFLINE · ChartBridge'; cls = 'bad'; }
  else if (states.every(s => s === 'live')) { text = 'LIVE · ChartBridge'; cls = 'live'; }
  else { text = (states.includes('loading') ? 'LOADING' : 'CONNECTING') + ' · ChartBridge'; cls = 'wait'; }
  if (el.dataset.text !== text) { el.dataset.text = text; el.className = 'ws-conn' + (cls ? ' ' + cls : ''); $('wsConnText').textContent = text; }
  const t = versionText();
  if (el.title !== t) el.title = t;
  // 1.16.0: the update notice's "copied: press F5" goes once the ChartBridge this window talks to is that version
  if (window.ChartUpdateNotice && window.ChartUpdateNotice.bridge) window.ChartUpdateNotice.bridge(bridgeVer);
}
/* 1.14.0 (Anthony): the versions, quietly: the LIVE badge's tooltip and the foot of Settings */
let bridgeVer = '', bridgeFeatures = [];
const versionText = () => 'chart ' + (window.ChartEngine ? window.ChartEngine.VERSION : '') + ' · ChartBridge ' + (bridgeVer || '-');
let noteTimer = 0;
function note(text, warn, ms) {
  const el = $('wsNote');
  el.textContent = text; el.title = text || ''; el.className = 'ws-note' + (warn ? ' warn' : ''); el.hidden = !text;
  clearTimeout(noteTimer);
  if (text) noteTimer = setTimeout(() => { el.hidden = true; }, ms || 4000);
}

/* One status line for the window (the charts' own are not shown here): the worst feed and local delay over the
   instruments (each one's in the tooltip) and the charts' frame rate, every second. */
function fmtDelay(v) { return v === null || v === undefined ? '-' : (v < 1 && v >= 0 ? '<1' : Math.round(v)) + ' ms' + (v < 0 ? ' (PC clock behind)' : ''); }
function syncStats() {
  const per = new Map();
  let fps = 0, busy = false, frame = null, frameMax = null;
  for (const v of chartViews()) {
    const s = v.pane.stats();
    if (s.chart && !s.chart.idle) { busy = true; fps = Math.max(fps, s.chart.fps || 0); }
    // 1.16.0: tape timing, ChartBridge's receipt of a trade to the frame that drew it: the worst chart's, last second
    if (typeof s.drawMax === 'number' && (frameMax === null || s.drawMax > frameMax)) { frameMax = s.drawMax; frame = s.draw; }
    if (!s.root) continue;
    const r = per.get(s.root) || { feed: null, local: null };
    if (s.feed !== null && (r.feed === null || s.feed > r.feed)) r.feed = s.feed;
    if (s.local !== null && (r.local === null || s.local > r.local)) r.local = s.local;
    if (s.localP95 !== null && s.localP95 !== undefined && (r.l95 === null || r.l95 === undefined || s.localP95 > r.l95)) r.l95 = s.localP95;
    per.set(s.root, r);
  }
  let feed = null, local = null, l95 = null, worst = '';
  for (const [root, r] of per) {
    if (r.feed !== null && (feed === null || r.feed > feed)) { feed = r.feed; worst = root; }
    if (r.local !== null && (local === null || r.local > local)) local = r.local;
    if (r.l95 !== null && r.l95 !== undefined && (l95 === null || r.l95 > l95)) l95 = r.l95;
  }
  const ft = fmtDelay(feed) + (feed !== null && per.size > 1 ? ' ' + worst : '');
  if ($('wsFeed').textContent !== ft) $('wsFeed').textContent = ft;
  // 1.15.0 (review): the local delay's p95 beside its median
  const lt = fmtDelay(local) + (local !== null && l95 !== null ? ' (p95 ' + fmtDelay(l95) + ')' : '');
  if ($('wsLocal').textContent !== lt) $('wsLocal').textContent = lt;
  $('wsFps').textContent = !chartViews().length ? '-' : busy ? Math.round(fps) + ' fps' : 'idle';
  $('wsStat').title = 'Feed delay (ChartBridge to here) and local delay per instrument, the worst shown. Frame: a trade\'s receipt by ChartBridge to the chart frame that drew it, ' +
    (frameMax === null ? 'no trade drawn in the last second' : fmtDelay(frameMax) + ' at worst in the last second (latest ' + fmtDelay(frame) + ')') + '; each chart\'s in the Data Box.\n' +
    ([...per].map(([root, r]) => root + ': feed ' + fmtDelay(r.feed) + ', local ' + fmtDelay(r.local)).join('\n') || 'no data yet');
}
setInterval(syncStats, 1000);

/* ======================================================================== orders (1.12.0)
 * Every window has its own order connection to ChartBridge (signed in like the single chart page) and its own TradeCore
 * (live/trade.js: the order bar's very functions). The order ticket lives in one window at a time (TicketLink, live/
 * ticket-link.js: the browser's lock decides, so two windows never both hold it):
 *   - the ticket's window is the only one that arms and sends Buy, Sell, B/E, chart clicks, drags and cancels; a chart
 *     click, drag or cancel on the ticket's instrument in another window, and the Buy, Sell and B/E keys there, are
 *     forwarded to it and acted on there with the same checks (no answer in 300 ms: a note, nothing sent);
 *   - Close, Flatten all (keys) and the top bar's Flatten all go from whichever window they are pressed in, on its own
 *     connection, on the ticket's account (as the ticket's window says it; with no ticket, the account trading came on
 *     with, as on the single chart page);
 *   - every chart shows its own instrument's working orders, position and fills on that account (Armed or not); the
 *     charts on the ticket's instrument take order clicks and drags while it is Armed, with the Armed border.
 * Saved here: live-ticket-v1 { root, account } (the ticket's instrument and account, kept for the next time it opens).
 */
const TC = window.TradeCore, TL = window.TicketLink, U = window.ChartEngine.util;
const TICKET_KEY = 'live-ticket-v1';
const readTicket = () => { try { const v = JSON.parse(store.getItem(TICKET_KEY)); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } };
const TK = {
  root: W.ROOTS.includes(readTicket().root) ? readTicket().root : 'MNQ',   // the ticket's instrument
  bar: null, el: null, view: null,                    // the shared order bar wiring and the ticket's element, while this window holds it
  price: null, last: {}, priceSeq: 0,                // the ticket's price feed: { root: { p, at, seq } } (its instrument's last trade)
  noteTimer: 0, published: '',
};
const FRAMED = (() => { try { return window.top !== window.self; } catch (e) { return true; } })();
let tws = null, tTries = 0, tTimer = 0, instruments = {};
const tfills = new Map();                             // 'account|id' -> fill (the order connection's execs)
const tickOf = r => (instruments[r] && +instruments[r].tick) || 0.25;
const precisionOf = r => W.decimalsOf(tickOf(r));
const fmtPx = (p, r) => U.fmtPrice(p, precisionOf(r || ticketRoot()));
let sentCount = 0;                                    // order actions sent here (a forwarded action's answer says how many)
/* The ticket's last price for root r: from the ticket's current price feed, or seen in the last 10 s (the single chart
   page's LAST_SEEN_MS); an older one (an earlier visit of the instrument) is no price at all. */
const LAST_SEEN_MS = 10000;
function ticketPrice(r) {
  const x = TK.last[r];
  if (!x) return null;
  const current = TK.price && TK.price.root === r && x.seq === TK.priceSeq;
  return current || Date.now() - x.at < LAST_SEEN_MS ? x.p : null;
}
/* the forwards whose orders this window sent: cid -> the window that asked (ChartBridge's refusal goes back to it) */
const fwdCids = new Map();
let capture = null;                                   // the notes of a forwarded action, for its answer

/* the ticket as this window knows it: its own, or the one another window announced */
const linkInfo = () => link ? link.info() : { held: false, holder: null, supported: false };
const holds = () => !!link && link.held();
const holder = () => linkInfo().holder;
function ticketRoot() { if (holds()) return TK.root; const h = holder(); return h && W.ROOTS.includes(h.root) ? h.root : TK.root; }
function ticketArmed() { if (holds()) return core.TR.armed; const h = holder(); return !!(h && h.armed); }
function ticketAccount() { if (holds()) return core.TR.account; const h = holder(); return h && typeof h.account === 'string' && h.account ? h.account : core.TR.account; }
const ticketQty = () => { if (holds() && TK.el) { const v = +tk('oQty').value; return Number.isInteger(v) ? v : 1; } const h = holder(); return h && Number.isInteger(h.qty) ? h.qty : 1; };
const accountPick = () => { try { const v = JSON.parse(store.getItem('live-account-v1')); return typeof v === 'string' ? v : ''; } catch (e) { return ''; } };

/* notes: the ticket's own line in the ticket's window, else the top bar's */
function tnote(text, level) {
  if (capture) capture.push(text);
  // the ticket shows its last fill on its own line: a "Filled ..." note would only repeat it (1.13.0, Anthony)
  if (holds() && TK.el && !level && /^(Part filled|Filled) /.test(text || '')) return;
  if (holds() && TK.el) {
    const el = tk('note');
    el.textContent = text || ''; el.className = 'tk-note' + (level ? ' ' + level : ''); el.title = text || '';
    clearTimeout(TK.noteTimer);
    const t = text;
    if (text) TK.noteTimer = setTimeout(() => { if (el.textContent === t) { el.textContent = ''; el.title = ''; } }, level === 'error' ? 12000 : 6000);
  } else note(text, !!level, level === 'error' ? 12000 : 6000);
}
const tTimers = new Set();
const tlater = (fn, ms) => { const id = setTimeout(() => { tTimers.delete(id); fn(); }, ms); tTimers.add(id); return id; };

const core = TC.create({
  LP, prefs, pin: PIN, framed: FRAMED, framedReason: 'This page is inside another page (a frame), so it cannot trade. Open ' + location.href + ' directly in its own window.',
  fetch: (u, o) => fetch(u, o),
  send: obj => { tws.send(JSON.stringify(obj)); if (TC.ORDER_ACTIONS.includes(obj.type)) sentCount++; },
  open: () => !!tws && tws.readyState === 1, sock: () => tws,
  root: () => ticketRoot(),
  lastPrice: () => ticketPrice(ticketRoot()),
  qty: () => (holds() && TK.el ? Number(tk('oQty').value === '' ? NaN : +tk('oQty').value) : NaN),
  pickerAccount: () => (holds() && TK.el ? tk('oAcct').value : ticketAccount()),
  /* the ticket's account; with no ticket anywhere, the last account picked on this PC (as the single chart page) */
  wantedAccount: () => { const h = holder(); return holds() ? readTicket().account || accountPick() : h && h.account ? h.account : accountPick(); },
  tick: tickOf, served: r => !Object.keys(instruments).length || !!instruments[r], fmt: p => fmtPx(p),
  flash: tnote, later: tlater, destroyed: () => false,
  changed: () => renderOrders(), armed: on => ticketArmedUi(on),
  applied: (pick, cameOn) => { if (TK.bar) TK.bar.syncTradeAccounts(); if (holds() && core.TR.enabled && core.TR.account && (cameOn || pick.missed)) ticketAccountNote(pick); renderOrders(); },
  lost: () => {}, syncAccounts: () => { if (TK.bar) TK.bar.syncTradeAccounts(); },
  batch: () => { if (TK.bar) TK.bar.renderBatch(); }, unsent: renderUnsent, positionChanged: () => {},
  armBlocked: () => (holds() ? '' : 'The order ticket is in another window: arm it there.'),
  /* NO STOP (1.13.0): asked in this window (the one Anthony is looking at); a click forwarded from another window was
     asked there before it came (its noStopOk), so here it is only refused */
  confirmNoStop: (root, go) => {
    if (forwarding) return false;
    askNoStop('The ' + root + ' order has no stop (the bracket stop is 0). Later orders with no stop go without asking until this window is loaded again.', go,
      () => tnote('Not sent: no stop. Set the bracket stop, or send again and choose Send.', 'warn'), { root });
    return true;
  },
  dropNoStop: () => dropNoStop(),
  flattened: r => flattenedHere(r),
});
let forwarding = false;                               // acting on another window's forward (it asked its own questions)
let noStopQ = null;                                   // the NO STOP question open in this window (askNoStop, below)
const flatAt = { all: 0 };                            // the last Close or Flatten per instrument, Flatten all, any window
const noteFlat = (r, at) => { if (r) flatAt[r] = Math.max(flatAt[r] || 0, at); else flatAt.all = Math.max(flatAt.all, at); };

/* ---------------- this window's order connection: no subscribe, only sign-in and order messages */
function tconnect() {
  tTimer = 0;
  let sock;
  Promise.resolve().then(() => wsUrl()).then(url => {
    try { sock = new WebSocket(url); } catch (e) { tretry(); return; }
    tws = sock;
    sock.onopen = () => { if (sock === tws) tTries = 0; };
    sock.onmessage = ev => { if (sock !== tws) return; let m; try { m = JSON.parse(ev.data); } catch (e) { return; } tmessage(m); };
    sock.onclose = () => { if (sock !== tws) return; tws = null; if (core.TR.armed) armOffWhy = 'drop'; core.lost('Not connected to ChartBridge.'); tretry(); };
    sock.onerror = () => { /* onclose follows */ };
  }, tretry);
}
/* 1.15.0 (review): the first try after a drop at once (not twice within 5 s), then the backoff as before */
let tFast = 0;
function tretry() { tTries++; const now = Date.now(), fast = tTries === 1 && now - tFast > 5000; if (fast) tFast = now; tTimer = setTimeout(tconnect, fast ? 0 : Math.min(5000, 500 * tTries)); }
function tmessage(m) {
  switch (m.type) {
    case 'hello':
      bridgeVer = typeof m.version === 'string' ? m.version : ''; bridgeFeatures = Array.isArray(m.features) ? m.features.slice() : []; syncConn();
      instruments = {};
      for (const i of m.instruments || []) instruments[i.root] = i;
      core.hello(m);
      renderOrders();
      return;
    case 'execs': tfills.clear(); for (const f of m.list || []) if (f && f.id) tfills.set(f.account + '|' + f.id, f); renderOrders(); return;
    case 'exec': if (m.id) { tfills.set(m.account + '|' + m.id, m); renderOrders(); } return;
    // errors stay until dismissed; a warning (a mistyped maxTicksAway or maxBracketTicks in config.txt, 0.3.7) too, in amber
    case 'status': if (m.level === 'error') alertLoud(m.text); else if (m.level === 'warn' && m.text) alertLoud(m.text, true); else if (m.text) note('ChartBridge: ' + m.text, false); return;
  }
  // an order this window sent for a click in another window: ChartBridge's refusal (or NinjaTrader's rejection) goes
  // back to that window's note too
  const f = m.cid && fwdCids.get(m.cid);
  if (f && link && (m.type === 'reject' || (m.type === 'order' && m.state === 'rejected'))) {
    link.tell(f.from, m.type === 'reject' ? 'Refused by ChartBridge: ' + m.reason : 'Rejected: ' + (m.text || m.name || m.root));
    fwdCids.delete(m.cid);
  }
  core.message(m);
}
/* ChartBridge's error about orders stays until dismissed (the newest three), as on the single chart page */
const alerts = [];
let alertErr = false;
function alertLoud(text, warn) {
  alerts.push(new Date().toLocaleTimeString() + '  ' + text); while (alerts.length > 3) alerts.shift();
  if (!warn) alertErr = true;
  $('wsAlertText').textContent = alerts.join('\n'); $('wsAlert').hidden = false;
  $('wsAlert').classList.toggle('warn', !alertErr);                // red once an error is in it
}
$('wsAlertClose').addEventListener('click', () => { alerts.length = 0; alertErr = false; $('wsAlert').hidden = true; });
function renderUnsent() { const n = core.unsentNote(); $('wsUnsent').hidden = !n.show; $('wsUnsentText').textContent = n.text; }
$('wsUnsentClose').addEventListener('click', () => core.dismissUnsent());

/* ---------------- what every chart shows, and which charts take orders */
function chartTrade(v) {
  const r = v.panel.root, TR = core.TR, acct = ticketAccount(), on = TR.enabled && !!acct;
  const pos = on ? TR.positions.get(acct + '|' + r) : null;
  return { root: r, account: acct, live: on && ticketArmed() && r === ticketRoot(), orders: on ? core.chartOrders(acct, r) : [],
    position: pos && pos.qty ? pos : null, pointValue: (instruments[r] || {}).pointValue || 0, qty: ticketQty() };
}
function renderCharts() { for (const v of chartViews()) v.pane.setTrade(chartTrade(v)); }
function renderOrders() {
  if (holds() && TK.bar) { TK.bar.render(); renderTicketExtras(); publish(); }
  renderCharts();
  renderAccounts();                                      // 1.15.0: the Account panels
  renderFlat();
  syncTitle();
}
/* The window's title says when this window's ticket is Armed, and on which account (as the single chart page's tab). */
function syncTitle() {
  const t = (holds() && core.TR.armed ? 'ARMED · ' + ticketRoot() + ' · ' + core.TR.account + ' · ' : '') + (layout || W.DEFAULT_NAME) + ' · Workspace';
  if (document.title !== t) document.title = t;
}
function renderFlat() {
  const b = $('wsFlat'), a = ticketAccount(), on = core.TR.enabled && !!a;
  b.disabled = !on;
  const t = on ? 'Flatten all on ' + a + ': every instrument with a position or a working order, cancel its orders and close its position at market. Works with Armed off.'
    : 'Flatten all: ' + (core.TR.reason || 'not connected to ChartBridge yet');
  if (b.title !== t) b.title = t;
}
$('wsFlat').addEventListener('click', e => {
  e.currentTarget.blur();
  if (e.detail === 0) { note('Order buttons work by click only, not by keyboard.', true); return; }
  core.flattenAll();
});

/* A chart's click, drag or cancel (ChartLive.mount's `trade`): in the ticket's window straight to TradeCore, else
   forwarded to it. Either way only for the ticket's instrument. */
function chartAction(action) {
  if (holds()) { actHere(action); renderOrders(); return; }  // its note is on the ticket's notes line
  forward(action);
}
function forward(action) {
  if (!link) { note(TL.NO_CHANNEL, true, 8000); renderCharts(); return; }
  /* NO STOP: the ticket's window has a stop of 0 and has not been told "Send" yet; an order that opens or adds is asked
     about here, where Anthony clicked, and goes with his answer (the ticket's window never asks for another window) */
  const hd = holder(), side = action.kind === 'place' ? action.side : action.kind === 'buy' || action.kind === 'sell' ? action.kind : '';
  if (side && hd && hd.armed && hd.stop === 0 && !hd.noStopOk && !action.noStopOk) {
    const pos = core.TR.positions.get((hd.account || '') + '|' + (hd.root || ''));
    if (OT.opensPosition(side, pos && pos.qty, hd.qty)) {
      /* the answer goes with the instrument and account it was asked about and the time it was asked: the ticket's
         window refuses it for another, or after a Close or Flatten of that instrument since (F2 review, re-review) */
      const asked = { root: hd.root, account: hd.account, askedAt: Date.now() };
      askNoStop('The ' + hd.root + ' order has no stop (the order ticket\'s bracket stop is 0). Later orders with no stop go without asking.',
        () => forward(Object.assign({}, action, { noStopOk: true }, asked)), () => { note('Not sent: no stop.', true); renderCharts(); }, Object.assign({ fwd: true }, asked));
      return;
    }
  }
  link.forward(action).then(r => {
    if (!r.answered || !r.sent) note(r.note || 'Nothing was sent.', true, 8000);
    else note(r.note, false, 6000);
    renderCharts();                                     // a refused drag puts the line back
  });
}
/* Act on a click, drag, cancel or Buy, Sell, B/E key here, in the ticket's window: { sent, note, cid }. A click is sent
   with the kind its chart worked out from its own price, re-checked against the ticket's (TradeCore.placeChecked). */
function actHere(a) {
  const before = sentCount, cid0 = core.lastCid(), notes = [];
  const was = capture; capture = notes;
  try {
    const R = ticketRoot(), plan = typeof a.id === 'string' ? OT.planIdOf(a.id) : null, oid = plan ? plan.entry : a.id;
    const otherRoot = !!a.root && a.root !== R && ['place', 'move', 'cancel', 'planAdd', 'buy', 'sell'].includes(a.kind);
    // asked in the window it came from, and Anthony said Send: only for the instrument and account he was asked about,
    // and not when a Close or Flatten of it went out after he was asked (F2 review, re-review)
    const otherAcct = a.noStopOk === true && !!a.account && a.account !== core.TR.account;
    const stale = a.noStopOk === true && !(a.askedAt > Math.max(flatAt.all, flatAt[R] || 0));
    if (a.noStopOk === true && !otherRoot && !otherAcct && !stale) core.allowNoStop();
    if (otherRoot) tnote('Not sent: the order ticket is on ' + R + ' now, not ' + a.root + '.', 'warn');
    else if (otherAcct) tnote('Not sent: the order ticket is on ' + core.TR.account + ' now, not ' + a.account + '.', 'warn');
    else if (stale) tnote('Not sent: a Close or Flatten of ' + R + ' went out after that order was asked about. Send it again to be asked.', 'warn');
    else if ((a.kind === 'move' || a.kind === 'cancel' || a.kind === 'planAdd') && core.TR.orders.has(oid) && core.TR.orders.get(oid).root !== R) tnote('Not sent: that order is not on ' + R + '.', 'warn');
    else if (a.kind === 'place' && (a.side === 'buy' || a.side === 'sell') && isFinite(a.price)) core.placeChecked(a.side, a.orderKind === 'limit' || a.orderKind === 'stop' ? a.orderKind : null, +a.price);
    else if (a.kind === 'move' && typeof a.id === 'string' && isFinite(a.price)) { if (plan) core.planMove(a.id, +a.price, isFinite(a.from) ? +a.from : undefined); else core.moveOrder(a.id, +a.price); }
    else if ((a.kind === 'cancel' || a.kind === 'cancelAny') && typeof a.id === 'string') { if (plan) core.planRemove(a.id); else core.cancelOrder(a.id); }
    else if (a.kind === 'planAdd' && typeof a.id === 'string' && (a.which === 'stop' || a.which === 'target')) core.planAdd(a.id, a.which);
    else if (a.kind === 'buy') core.sendOrder('buy', 'market', null);
    else if (a.kind === 'sell') core.sendOrder('sell', 'market', null);
    else if (a.kind === 'be') core.breakEven();
  } finally { capture = was; }
  const cid = core.lastCid() !== cid0 ? core.lastCid() : '';
  return { sent: sentCount - before, note: notes.length ? notes[notes.length - 1] : '', cid };
}
/* 1.15.0 (Anthony): a press on an order line that does nothing says why. Armed off for a dropped connection (ChartBridge
   restarted after a recompile, or the line went down) says so, until it is armed again; the ticket's window tells the
   others (its published state's offWhy). */
let armOffWhy = '';
/* in the ticket's window: why its Armed is off, as the others are told it ('reconnected', 'dropped' or '') */
const offWhyNow = () => (core.TR.armed || armOffWhy !== 'drop' ? '' : tws && tws.readyState === 1 && core.TR.enabled ? 'reconnected' : 'dropped');
function pressOffText(root) {
  const R = ticketRoot(), h = holds(), hd = h ? null : holder();
  if (!h && !hd) return 'No window has the order ticket: add it to move or cancel orders.';
  if (root !== R) return 'The order ticket is on ' + R + ': switch it to ' + root + ' to move or cancel these orders.';
  if (ticketArmed()) return '';
  const why = h ? offWhyNow() : hd && typeof hd.offWhy === 'string' ? hd.offWhy : '';   // the ticket's window's reason (review)
  if (why === 'reconnected') return 'Armed went off: ChartBridge reconnected. Arm to move or cancel orders.';
  if (why === 'dropped') return 'Armed went off: the connection to ChartBridge dropped.';
  return 'Armed is off: arm to move or cancel orders.';
}
const tradeHost = {
  pressOff: root => pressOffText(root),
  place: (side, price, root, kind) => chartAction({ kind: 'place', side, price, root, orderKind: kind }),
  move: (id, price, root, from) => chartAction({ kind: 'move', id, price, root, from }),
  cancel: (id, root) => chartAction({ kind: 'cancel', id, root }),
  planAdd: (id, which, root) => chartAction({ kind: 'planAdd', id, which, root }),
};

/* ---------------- the one ticket across windows */
const linkChannel = TL.browserChannel(TL.CHANNEL);
const locks = typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function' ? navigator.locks : null;
const link = linkChannel ? TL.create({
  channel: linkChannel, locks,
  onState: () => linkChanged(),
  onRelease: () => { if (core.TR.armed) core.setArmed(false); },   // moved to another window: Armed off before the lock goes
  onForward: (a, from) => {
    forwarding = true;
    let r;
    try { r = actHere(a); } finally { forwarding = false; }
    if (r.cid) { fwdCids.set(r.cid, { from, at: Date.now() }); for (const [c, x] of fwdCids) if (Date.now() - x.at > 60000) fwdCids.delete(c); }
    renderOrders(); return r;
  },
  onNote: text => note(text, true, 12000),
  onLate: a => note('The order ticket\'s window answered late: ' + a.note, true, 12000),
}) : null;
let wasHeld = false;
function linkChanged() {
  const h = holds();
  if (h !== wasHeld) {
    wasHeld = h;
    if (!h) { if (core.TR.armed) core.setArmed(false); stopTicketPrice(); }
    renderTicketPanel();
  } else if (!h) renderTicketPanel();
  // another window's ticket: this window's orders go to its instrument and account (Close, Flatten all, the charts),
  // and keep doing so once no window has it (the last ticket's instrument, live-ticket-v1; the default account)
  const hd = holder();
  // a question asked here for the ticket's window goes when the ticket is not as it was asked (F2 re-review)
  if (noStopQ && noStopQ.fwd && (h || !hd || !hd.armed || hd.root !== noStopQ.root || hd.account !== noStopQ.account)) dropNoStop();
  if (!h && hd && W.ROOTS.includes(hd.root)) TK.root = hd.root;
  if (!h && hd && hd.account && hd.account !== core.TR.account && core.TR.accounts.includes(hd.account)) core.pickAccount(hd.account);
  if (!h && !hd) noTicketAccount();
  renderOrders();
}
/* No window has the ticket: Close and Flatten all go on the default account (the last one picked on this PC, as the
   single chart page's), for the last ticket's instrument. */
function noTicketAccount() {
  const TR = core.TR;
  if (!TR.enabled || holds() || holder()) return;
  const a = LP.orderAccount(TR.accounts, accountPick()).account;
  if (a && a !== TR.account) core.pickAccount(a);
}
/* What Close and Flatten all here would act on, for KEYS's tooltip and the top bar's Flatten all */
const closeTarget = () => ticketAccount() + ' ' + ticketRoot();
function publish() {
  if (!holds()) return;
  const st = { root: TK.root, account: core.TR.account, armed: core.TR.armed, qty: ticketQty(),
    stop: OT.cleanBracket(core.brackets[TK.root], core.cap()).stop, noStopOk: !core.noStopAsked(),   // NO STOP: other windows ask before they forward
    offWhy: offWhyNow() };                                                                           // 1.15.0: why Armed went off, for their notes
  const k = JSON.stringify(st);
  if (k === TK.published) return;
  TK.published = k;
  link.publish(st);
  try { store.setItem(TICKET_KEY, JSON.stringify({ root: TK.root, account: core.TR.account || readTicket().account || '' })); } catch (e) { /* blocked */ }
}
setInterval(() => { if (link) link.check(); }, 3000);
window.addEventListener('pagehide', () => { if (link) link.close(); });

/* Take the ticket into this window (Add panel, or the placeholder's button): the lock if free, else ask to move it. */
function takeTicket(onDone) {
  if (!link) { note('This browser cannot keep one order ticket across windows: nothing to trade from here.', true); if (onDone) onDone(false); return; }
  link.take().then(r => {
    if (r === 'held') { TK.published = ''; linkChanged(); if (onDone) onDone(true); return; }
    if (r === 'unsupported') { note('This browser has no Web Locks, so it cannot keep one order ticket across windows. Use Chrome or Edge.', true, 12000); if (onDone) onDone(false); return; }
    confirmBox('Move the ticket here? The order ticket is in another window. Armed is off after the move (arm it again here).', 'Move here', () => {
      link.move().then(m => {
        if (m === 'held') { TK.published = ''; linkChanged(); note('The order ticket is in this window now. Armed is off.', false); if (onDone) onDone(true); }
        else { note('The ticket could not be moved here: another window has it.', true); renderTicketPanel(); if (onDone) onDone(false); }
      });
    }, () => { if (onDone) onDone(false); });
  });
}
function releaseTicket() { if (holds()) { if (core.TR.armed) core.setArmed(false); link.release(); } }

/* ---------------- the ticket panel: the live ticket here, or a placeholder */
function renderTicketPanel() {
  const v = [...views.values()].find(x => x.panel.type === 'ticket');
  if (!v) { TK.el = null; TK.bar = null; return; }
  const live = holds();
  if (live && v.mode === 'live') return;
  if (!live && v.mode !== 'live' && v.mode === placeholderKind()) { holdLine(v); return; }
  TK.el = null; TK.bar = null; TK.view = null;
  for (const f of v.cleanups.splice(0)) f();
  if (live) { mountTicket(v); return; }
  v.mode = placeholderKind();
  const sup = !!(link && locks);
  const hd = holder();
  v.body.innerHTML = !sup ? '<div class="tk-hold" role="note"><b>No order ticket in this browser</b><span>It needs the Web Locks API to keep one ticket across windows. Use Chrome or Edge.</span></div>'
    : hd ? '<div class="tk-hold" role="note"><b>Ticket is in the other window</b><span data-tk="line"></span><button type="button" class="ws-btn primary" data-tk="take">Move the ticket here</button></div>'
    : '<div class="tk-hold" role="note"><b>Order ticket</b><span>No window has the ticket.</span><button type="button" class="ws-btn primary" data-tk="take">Use the ticket here</button></div>';
  const b = v.body.querySelector('[data-tk="take"]');
  if (b) b.addEventListener('click', () => takeTicket());
  holdLine(v);
}
/* the other window's ticket in one line, written only when it changed */
function holdLine(v) {
  const el = v.body.querySelector('[data-tk="line"]'), hd = holder();
  if (!el || !hd) return;
  const t = (hd.root || '') + ' ' + (hd.account || '') + (hd.armed ? ' · ARMED' : '');
  if (el.textContent !== t) el.textContent = t;
}
const placeholderKind = () => !(link && locks) ? 'none' : holder() ? 'elsewhere' : 'free';
const tk = id => TK.view ? TK.view[id] || null : null;
function mountTicket(v) {
  v.mode = 'live';
  const opt = r => `<option value="${r}">${r}</option>`;
  v.body.innerHTML = `<div class="chart-live tk">
  <section class="obar tk-bar" data-tk-id="obar" aria-label="Order ticket">
    <div class="tk-row tk-acct"><select class="acct-sel tk-root" data-tk-id="root" data-keep aria-label="Ticket instrument" title="The ticket's instrument: its orders, and the charts on it take order clicks while Armed">${W.ROOTS.map(opt).join('')}</select>
      <select class="acct-sel acct-main" data-tk-id="oAcct" aria-label="Account: orders go to it" title="Orders go to this account"></select></div>
    <div class="tk-row"><button type="button" class="arm" data-tk-id="armBtn" role="switch" aria-checked="false" title="Armed: one click trades, no confirmation. Off after every load and every move of the ticket."><span class="knob" aria-hidden="true"></span><span class="arm-text"><span data-tk-id="armText">Armed off</span></span></button></div>
    <div class="tk-row"><span class="glabel">Qty</span><select class="acct-sel oqty" data-tk-id="oQty" aria-label="Order quantity">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => '<option value="' + n + '">' + n + '</option>').join('')}</select><span class="ounit" data-tk-id="oQtyCap"></span>
      <select class="acct-sel bpre" data-tk-id="bPreset" aria-label="Bracket preset" title="Bracket preset: a ratio links the target to the stop"></select>
      <span class="bsave" data-tk-id="bSaveBox" hidden><input class="oin bname" data-tk-id="bSaveName" type="text" maxlength="24" spellcheck="false" autocomplete="off" aria-label="Name for the bracket preset"><button type="button" class="btn" data-tk-id="bSaveOk">Save</button><button type="button" class="btn" data-tk-id="bSaveNo" aria-label="Do not save">x</button></span></div>
    <div class="tk-row tk-bk"><span class="glabel" title="Stop and target from the fill (0 = none)">Bracket</span><input class="oin" data-tk-id="bStop" type="number" min="0" max="200" step="1" inputmode="decimal" aria-label="Bracket stop in ticks, 0 for none" title="Stop, from the fill (0 = none)">
      <input class="oin" data-tk-id="bTarget" type="number" min="0" max="200" step="1" inputmode="decimal" aria-label="Bracket target in ticks, 0 for none" title="Target, from the fill (0 = none)">
      <span class="seg sans bunit" data-tk-id="bUnit" role="group" aria-label="Bracket stop and target in ticks or points"><button type="button" data-v="t" title="Ticks">t</button><button type="button" data-v="pt" title="Points">pt</button></span>
      <span class="nostop" data-tk-id="bNoStop" title="The stop is 0: an order sent now has no stop" hidden>NO STOP</span></div>
    <div class="tk-row tk-two"><button type="button" class="obtn buy" data-tk-id="buyMkt">Buy MKT</button><button type="button" class="obtn sell" data-tk-id="sellMkt">Sell MKT</button></div>
    <div class="tk-row tk-three"><button type="button" class="btn" data-tk-id="beBtn" title="Move the stop to break-even">B/E</button><button type="button" class="btn" data-tk-id="flattenBtn" title="Close: cancel every working order on this account and instrument, then close the position at market. Works with Armed off.">Close</button><button type="button" class="btn" data-tk-id="cancelAllBtn" title="Cancel every working order on this account and instrument">Cancel all</button></div>
    <div class="tk-state ostate">
      <span class="oinfo" data-tk-id="oPos"></span><span class="oinfo olegs" data-tk-id="oLegs"></span><span class="oinfo tk-fill" data-tk-id="fill"></span>
      <span class="tk-also" data-tk-id="also"></span>
      <span class="oinfo dim oother" data-tk-id="oOther"></span><span class="oinfo acct-note" data-tk-id="oAcctNote" role="status"></span><span class="oinfo acct-note batch-note" data-tk-id="oCancel" role="status"></span><span class="ooff" data-tk-id="oOff"></span>
      <span class="tk-note" data-tk-id="note" role="status"></span>
    </div>
  </section></div>`;
  const map = {};
  for (const el of v.body.querySelectorAll('[data-tk-id]')) map[el.dataset.tkId] = el;
  map.unsentBar = $('wsUnsent'); map.unsentText = $('wsUnsentText'); map.unsentClose = document.createElement('button');   // the window's own note (one per window)
  TK.view = map; TK.el = v.body.firstChild;
  map.root.value = TK.root;
  TK.bar = TC.wire(id => map[id] || null, core, {
    U, LP, prefix: PREFIX, ticket: true, root: () => TK.root, flash: tnote, render: () => renderOrders(), listen: (t, type, fn) => { t.addEventListener(type, fn); v.cleanups.push(() => t.removeEventListener(type, fn)); },
    tick: tickOf, lastPrice: () => (TK.last[TK.root] ? TK.last[TK.root].p : null), pointValue: r => (instruments[r] || {}).pointValue || 0, precision: () => precisionOf(TK.root),
    pickViewAccount: a => { store.setItem('live-account-v1', JSON.stringify(a)); renderOrders(); },
    accountPicked: a => { store.setItem('live-account-v1', JSON.stringify(a)); renderOrders(); },
    clearAccountNote: () => { map.oAcctNote.textContent = ''; map.oAcctNote.title = ''; },
    armBlocked: () => (holds() ? '' : 'The order ticket is in another window: arm it there.'),
  });
  map.root.addEventListener('change', () => {
    const r = map.root.value;
    TK.bar.handBack(map.root);
    if (!W.ROOTS.includes(r) || r === TK.root) return;
    TK.root = r;
    if (core.TR.armed) { core.setArmed(false); tnote('Armed turned off: the instrument changed.', 'warn'); }
    startTicketPrice();
    renderOrders();
  });
  /* "Also open": the ticket's account on another instrument, each with its own Close */
  map.also.addEventListener('click', e => {
    const b = e.target.closest('button[data-close]');
    if (!b) return;
    b.blur();
    if (e.detail === 0) { tnote('Order buttons work by click only, not by keyboard.', 'warn'); return; }
    core.flattenHere(b.dataset.close);
  });
  // the stop the other windows go by for NO STOP: told to them as it is typed
  for (const k of ['bStop', 'bTarget', 'bPreset']) for (const t of ['input', 'change']) map[k].addEventListener(t, () => setTimeout(publish, 0));
  TK.bar.syncTradeAccounts();
  ticketArmedUi(core.TR.armed);
  startTicketPrice();
  renderOrders();
}
function ticketArmedUi(on) {
  if (on) armOffWhy = '';                                // armed again: the reason it went off is no longer news
  if (!TK.view) return;
  tk('armBtn').setAttribute('aria-checked', String(on));
  tk('armText').textContent = on ? 'ARMED' : 'Armed off';
  tk('obar').classList.toggle('armed', on);
}
function ticketAccountNote(pick) {
  const el = tk('oAcctNote');
  if (!el) return;
  const text = pick.missed ? 'Last account ' + pick.missed + ' not available, on ' + pick.account + '.' : 'On ' + pick.account + '. Armed is off.';
  el.textContent = text; el.title = text; el.classList.toggle('warn', !!pick.missed);
  tlater(() => { if (el.textContent === text) { el.textContent = ''; el.title = ''; } }, pick.missed ? 15000 : 8000);
}
/* the last fill of the ticket's account and instrument, and the account's other instruments still open */
function renderTicketExtras() {
  const TR = core.TR, acct = TR.account, r = TK.root;
  const fill = TR.enabled && acct ? [...tfills.values()].filter(f => f.account === acct && f.root === r).sort((a, b) => a.t - b.t).pop() : null;
  const fe = tk('fill');
  const ft = fill ? 'Last fill ' + (fill.side === 'buy' ? 'BUY ' : 'SELL ') + fill.qty + ' at ' + fmtPx(+fill.p, r) + ' · ' + U.fmtHM(fill.t) : '';
  if (fe.textContent !== ft) { fe.textContent = ft; fe.title = ft; }
  const rows = [];
  if (TR.enabled && acct) for (const x of W.ROOTS) {
    if (x === r) continue;
    const p = TR.positions.get(acct + '|' + x), n = core.working(acct, x).length;
    if (!(p && p.qty) && !n) continue;
    rows.push({ root: x, text: x + ' ' + [p && p.qty ? (p.qty > 0 ? '+' : '') + p.qty : '', n ? n + ' order' + (n > 1 ? 's' : '') : ''].filter(Boolean).join(', ') });
  }
  const key = rows.map(x => x.text).join('|');
  const el = tk('also');
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = rows.map(x => `<span class="tk-also-row"><span>Also open: ${esc(x.text)}</span><button type="button" class="btn" data-close="${x.root}" title="Close ${x.root}: cancel its orders and close its position at market on ${esc(acct)}">Close</button></span>`).join('');
}
/* the ticket's price: its instrument's trades from the window's feed (no history kept) */
function startTicketPrice() {
  const root = TK.root;
  if (TK.price && TK.price.root === root) return;
  TK.priceSeq++;                                         // a price kept from an earlier visit is not this feed's
  if (TK.price) { TK.price.sock.send({ type: 'subscribe', root, days: 1, tickHours: 0 }); TK.price.root = root; return; }
  let sock;
  try { sock = hub.open(root); } catch (e) { return; }
  const P = TK.price = { root, sock, retry: 0 };
  sock.onmessage = ev => {
    const m = ev.message;
    if (!m || TK.price !== P) return;
    if (m.type === 'hello') sock.send({ type: 'subscribe', root: P.root, days: 1, tickHours: 0 });
    else if (m.type === 'tick' && m.root === P.root) TK.last[m.root] = { p: +m.p, at: Date.now(), seq: TK.priceSeq };
    else if (m.type === 'history' && m.root === P.root && Array.isArray(m.bars) && m.bars.length) TK.last[m.root] = { p: +m.bars[m.bars.length - 1][4], at: 0, seq: TK.priceSeq };
  };
  sock.onclose = () => { if (TK.price !== P) return; TK.price = null; P.retry = setTimeout(() => { if (holds() && !TK.price) startTicketPrice(); }, 1000); };
}
function stopTicketPrice() {
  const P = TK.price; TK.price = null;
  if (P) { P.sock.onmessage = P.sock.onclose = null; try { P.sock.close(); } catch (e) { /* closed */ } }
}
setInterval(() => { if (holds() && TK.bar) TK.bar.renderPositionInfo(); }, 500);   // the P&L, as the single chart page's

/* ---------------- hotkeys: in either window. Buy, Sell and B/E go to the ticket's window; Close and Flatten all go from
   this one, on the ticket's account (Anthony 2026-10-01). */
let HK = OT.cleanHotkeys(prefs.raw.get(LP.KEYS.hotkeys));
const busy = () => !!pop || $('wsDialog').open || !!document.querySelector('.ws-panel .ind-panel:not([hidden]), .ce-theme-panel:not([hidden]), .ind-chip-list:not([hidden]), .chip-pop:not([hidden]), .cb-pin') || !$('wsSettings').hidden;
/* a Buy or Sell key forwarded names the instrument this window knows the ticket is on (F2 review) */
const keyAct = kind => { if (holds()) { actHere({ kind }); renderOrders(); } else { const hd = holder(); forward(kind === 'be' || !hd || !hd.root ? { kind } : { kind, root: hd.root }); } };
document.addEventListener('keydown', window.ChartLive.hotkeyHandler({
  keys: () => HK, root: document.body, busy,
  actions: { buy: () => keyAct('buy'), sell: () => keyAct('sell'), be: () => keyAct('be'), close: () => core.flattenHere(), flattenAll: () => core.flattenAll() },
  ignored: () => note(window.ChartLive.HOTKEY_IN_BOX, true),
}));
/* 1.16.0: the workspace's own hotkeys (Maximize panel), kept apart from the trading ones (live-ws-keys-v1) and never one
   of them: a trading key always wins (cleanViewKeys drops a combo they have, and the trading handler above takes the
   press first). Never while a box has the focus (HOTKEY_IN_BOX), a menu or dialog is open, or on a key the chart reads. */
const viewKeys = () => W.cleanViewKeys(store.getItem(W.KEYS.viewKeys), HK, OT.hotkeyRefused);
document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.isComposing) return;
  const combo = OT.hotkeyCombo(e), k = combo ? viewKeys().maximize : '';
  if (!k || combo !== k || OT.hotkeyAction(HK, combo)) return;
  const a = document.activeElement;
  if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) { if (!e.repeat) note(window.ChartLive.HOTKEY_IN_BOX, true); return; }
  if (busy() || OT.isChartKey(e)) return;
  e.preventDefault();
  if (e.repeat) return;
  if (maxId) { toggleMax(maxId); return; }
  if (pointerPanel && views.has(pointerPanel)) toggleMax(pointerPanel);
  else note('Point at a panel, then press ' + k + ' to maximize it', true);
});
/* KEYS ON / KEYS OFF: whether a key pressed now would fire a hotkey here */
function keysOn() {
  if (!document.hasFocus() || busy()) return false;
  const a = document.activeElement;
  return !(a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)));
}
function syncKeys() {
  const on = keysOn(), el = $('wsKeys'), k = on + '|' + (core.TR.enabled ? closeTarget() : '');
  if (el.dataset.on === k) return;
  el.dataset.on = k;
  el.textContent = on ? 'KEYS ON' : 'KEYS OFF';
  el.className = 'ws-keys' + (on ? ' on' : '');
  el.title = (on ? 'A hotkey pressed now works in this window' : 'Hotkeys do nothing now: this window does not have the focus, or a box, menu or dialog has it. Click the page (not a box) to turn them on.') +
    (core.TR.enabled ? '\nClose: ' + closeTarget() + '. Flatten all: ' + ticketAccount() + '.' : '');
}
for (const t of ['focusin', 'focusout', 'pointerup', 'keyup']) document.addEventListener(t, () => setTimeout(syncKeys, 0), true);
window.addEventListener('focus', syncKeys); window.addEventListener('blur', syncKeys);
setInterval(syncKeys, 250);

/* ---------------- saving */
function save() { W.saveLayout(store, layout, { panels }); }

/* ---------------- panels */
function place(el, r) { el.style.gridColumn = (r.x + 1) + ' / span ' + r.w; el.style.gridRow = (r.y + 1) + ' / span ' + r.h; }
const chartViews = () => [...views.values()].filter(v => v.pane);
/* A narrow panel (a 1366 px screen) drops the handle's dots, a narrower one says "Ind" for Indicators (workspace.css). */
const sizes = typeof ResizeObserver === 'function' ? new ResizeObserver(list => {
  for (const e of list) { const w = e.contentRect.width; e.target.classList.toggle('narrow', w <= 380); e.target.classList.toggle('narrower', w <= 340); }
}) : null;
/* A panel whose header menu is open sits above its neighbours (workspace.css .ws-up). */
const raise = (el, on) => { const p = el && el.closest && el.closest('.ws-panel'); if (p) p.classList.toggle('ws-up', on); };

/* ---------------- maximize and restore (1.16.0, Anthony): a panel fills the grid (the others stay as they are, hidden
   behind it, and keep running), from the square beside its x or the Maximize panel hotkey (Settings > Hotkeys, none by
   default): the panel under the mouse, or back again. Not saved: a reload shows the layout as arranged. */
const MAX_ICON = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx=".5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
const RESTORE_ICON = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><rect x="1.5" y="3.5" width="7" height="7" rx=".5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 3.5v-2h7v7h-2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
let maxId = null, pointerPanel = null;
function setMaxButton(v, on) {
  const b = v.head.querySelector('[data-act="max"]');
  if (!b) return;
  b.innerHTML = on ? RESTORE_ICON : MAX_ICON;
  b.setAttribute('aria-pressed', String(on));
  const t = on ? 'Restore panel' : 'Maximize panel', k = viewKeys().maximize;
  b.setAttribute('aria-label', t); b.title = t + (k ? ' (' + k + ')' : '');
}
function toggleMax(id) {
  closePops();
  const was = maxId;
  if (was) restoreMax();
  if (!id || was === id) return;
  const v = views.get(id); if (!v) return;
  maxId = id;
  grid.classList.add('ws-maxed'); v.el.classList.add('ws-max-on');
  v.el.style.gridColumn = '1 / -1'; v.el.style.gridRow = '1 / -1';
  setMaxButton(v, true);
}
function restoreMax() {
  const v = maxId ? views.get(maxId) : null;
  maxId = null;
  grid.classList.remove('ws-maxed');
  if (v) { v.el.classList.remove('ws-max-on'); place(v.el, v.panel); setMaxButton(v, false); }
}
grid.addEventListener('pointerover', e => { const el = e.target.closest && e.target.closest('.ws-panel'); if (el && el.dataset.id) pointerPanel = el.dataset.id; });

/* The slim header (Anthony, 2026-10-01): the handle, instrument and bars (a click changes them), the chart's own
   Indicators button, a small menu with the drawing tools and Reset view, and the x. */
function headChart(v) {
  const p = v.panel;
  v.nameEl.textContent = v.contract && v.contract.split(' ')[0] === p.root ? v.contract : p.root;
  v.tfEl.textContent = W.tfLabel(p.tf, p.tf === 'range' ? p.range : 0);
  v.viewBtn.title = 'Instrument and bars' + (p.tf === 'h1' ? '. ' + H1_NOTE : W.HTF_TFS.includes(p.tf) ? '. ' + HTF_NOTE : '');
  v.viewBtn.setAttribute('aria-label', 'Instrument and bars: ' + p.root + ', ' + W.tfLabel(p.tf, p.tf === 'range' ? p.range : 0));
}

function addView(p) {
  const el = document.createElement('section');
  el.className = 'ws-panel ' + p.type;
  el.dataset.id = p.id; el.dataset.type = p.type;
  /* 1.16.0 (Anthony): maximize and restore, the Windows way (a square; two squares while maximized), beside the x */
  const close = '<button type="button" class="ws-ic ws-max" data-act="max" aria-pressed="false" aria-label="Maximize panel" title="Maximize panel">' + MAX_ICON + '</button>' +
    '<button type="button" class="ws-x" data-act="close" aria-label="Close panel" title="Close panel">✕</button>';
  let mid = '';
  if (p.type === 'chart') {
    mid = '<button type="button" class="ws-view" data-act="view" aria-haspopup="dialog" aria-expanded="false"><span class="ws-name"></span><span class="ws-tf"></span><span class="ws-caret" aria-hidden="true"></span></button>' +
      '<span class="chart-live ws-lv ws-badge"></span>' +    // 1.16.0: ARMED and the connection (the chart has no text on it)
      '<span class="chart-live ws-lv ws-ind"></span>' +
      '<button type="button" class="ws-ic ws-more" data-act="more" aria-haspopup="menu" aria-expanded="false" aria-label="Drawing tools and Reset view" title="Drawing tools, Reset view">⋯</button>';
  } else if (p.type === 'tape') {
    mid = '<span class="ws-name">Time and Sales</span><select class="ws-sel" data-act="root" aria-label="Time and Sales instrument">' +
      W.ROOTS.map(r => `<option value="${r}">${r}</option>`).join('') + '</select><span class="ws-fill"></span>' +
      '<button type="button" class="ws-ic" data-act="gear" aria-label="Time and Sales settings: large prints and colors" title="Large prints and colors" aria-expanded="false">⚙</button>';
  } else if (p.type === 'account') mid = '<span class="ws-name">Account</span><span class="ws-acct" title="The order ticket\'s account"></span><span class="ws-fill"></span>';
  else if (p.type === 'quotes') mid = '<span class="ws-name">Quote board</span><span class="ws-fill"></span>';
  else if (p.type === 'databox') mid = '<span class="ws-name">Data Box</span><span class="ws-db-src" title="The chart it follows: the one under the mouse, else the last one"></span><span class="ws-fill"></span>';
  else mid = '<span class="ws-name">Order ticket</span><span class="ws-fill"></span>' +
    '<span class="ws-slot" data-slot="copy"></span>';      // the Copy chip's place (the copier comes later)
  // 1.14.0: a resize handle on every edge and corner (the bottom right one keeps its grip lines); moving stays on the header
  el.innerHTML = `<header class="ws-head"><span class="ws-grip" aria-hidden="true">⋮⋮</span>${mid}${close}</header>` +
    '<div class="ws-body"></div>' + Object.keys(W.EDGES).map(k => `<div class="ws-edge ws-edge-${k}${k === 'se' ? ' ws-size' : ''}" data-edge="${k}" aria-hidden="true" title="Resize"></div>`).join('');
  place(el, p);
  grid.appendChild(el);
  if (sizes) sizes.observe(el);
  const v = { panel: p, el, head: el.querySelector('.ws-head'), body: el.querySelector('.ws-body'), state: null, cleanups: [], destroy: () => {} };
  views.set(p.id, v);
  if (p.type === 'chart') mountChart(v);
  else if (p.type === 'tape') mountTape(v);
  else if (p.type === 'account') mountAccount(v);        // 1.15.0
  else if (p.type === 'quotes') mountQuotes(v);
  else if (p.type === 'databox') mountDataBox(v);        // 1.16.0
  else { v.destroy = () => { for (const f of v.cleanups.splice(0)) f(); }; renderTicketPanel(); }
  // the handle is the whole header, except its buttons and the chart's Indicators menu
  v.head.addEventListener('pointerdown', e => { if (!e.target.closest('button, select, input, .ws-lv')) startDrag(e, v, 'move'); });
  for (const h of el.querySelectorAll('.ws-edge')) h.addEventListener('pointerdown', e => startDrag(e, v, 'size', h.dataset.edge));
  v.head.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b || !v.head.contains(b) || b.closest('.ws-lv')) return;
    if (b.dataset.act === 'close') closePanel(p.id);
    else if (b.dataset.act === 'max') toggleMax(p.id);
    else if (b.dataset.act === 'gear') openTapeGear(v, b);
    else if (b.dataset.act === 'view') openViewPop(v, b);
    else if (b.dataset.act === 'more') openMore(v, b);
  });
  return v;
}

/* A chart: a read-only ChartLive.mount on the window's shared feed, with the panel's own instrument, bars and range size
   (saved in the layout, never in the single chart page's settings), and no toolbar of its own. */
function mountChart(v) {
  const p = v.panel;
  v.state = 'connecting';
  v.nameEl = v.head.querySelector('.ws-name'); v.tfEl = v.head.querySelector('.ws-tf'); v.viewBtn = v.head.querySelector('.ws-view');
  headChart(v);
  const pane = window.ChartLive.mount(v.body, {
    feed: hub, paneId: p.id, storagePrefix: PREFIX, toolbar: false, compact: true, trade: tradeHost,
    view: { root: p.root, tf: p.tf, range: p.tf === 'range' ? p.range : undefined },
    onView: nv => viewChanged(v, nv),
    onColors: () => { for (const o of chartViews()) if (o !== v) o.pane.refreshColors(); },
    onStatus: s => {
      v.state = s.state; syncConn();
      if (s.state === 'live' && v.pane) { v.contract = typeof s.contract === 'string' ? s.contract : ''; headChart(v); }   // 1.16.0: from the status (no legend)
    },
  });
  v.pane = pane;
  pane.setTrade(chartTrade(v));                             // its instrument's orders, position and fills on the ticket's account
  // the chart's own Indicators button and menu, its chips; 1.16.0: no header text toggle (no text on the chart), and its
  // ARMED and connection badge in the header
  v.head.querySelector('.ws-ind').append(pane.indicators, pane.chips);
  if (pane.badge) v.head.querySelector('.ws-badge').append(pane.badge);
  followBars(v);                                            // the Data Box (1.16.0), when the layout has one
  const indBtn = pane.indicators.querySelector('.ind-btn');
  const mo = typeof MutationObserver === 'function' && indBtn ? new MutationObserver(() => raise(v.el, indBtn.getAttribute('aria-expanded') === 'true')) : null;
  if (mo) mo.observe(indBtn, { attributes: true, attributeFilter: ['aria-expanded'] });
  v.destroy = () => { if (v.offBar) v.offBar(); if (mo) mo.disconnect(); pane.destroy(); pane.indicators.remove(); pane.chips.remove(); if (pane.badge) pane.badge.remove(); };
}
function viewChanged(v, nv) {
  const p = v.panel;
  if (nv.root !== p.root) v.contract = '';
  p.root = nv.root; p.tf = nv.tf;
  if (nv.tf === 'range') p.range = nv.range; else delete p.range;
  headChart(v); save();
  if (v.pane) v.pane.setTrade(chartTrade(v));
  if (botDesk) botDesk.chartsChanged();                     // 1.16.0: ghost marks follow the chart's instrument
}
/* The first chart of a new default layout starts with the single chart page's indicators (its main pane's defaults);
   any other new pane starts with none (Anthony's rule for new panes). */
function seedMainIndicators(l) {
  const first = l.panels.find(p => p.type === 'chart');
  if (!first || !LP || typeof LP.create !== 'function') return l;
  try { prefs.updatePane(first.id, () => LP.defaultPane(LP.MAIN_PANE)); } catch (e) { /* the pane keeps the new-pane default */ }
  return l;
}

function closePanel(id) {
  const v = views.get(id); if (!v) return;
  closePops();
  if (maxId === id) restoreMax();
  if (v.panel.type === 'ticket') releaseTicket();           // no window has the ticket until one adds it
  v.destroy(); if (sizes) sizes.unobserve(v.el); v.el.remove(); views.delete(id);
  panels = panels.filter(p => p.id !== id);
  save(); syncConn(); placeColors(); syncAddMenu();
  if (botDesk) botDesk.chartsChanged();
}

function addPanel(type) {
  closePops();
  if (maxId) restoreMax();                                  // the new panel is seen where it goes
  if (panels.length >= W.MAX_PANELS) { note('At most ' + W.MAX_PANELS + ' panels: close one first', true); return; }
  if (type === 'ticket' && panels.some(q => q.type === 'ticket')) { note('This layout has its order ticket already', true); return; }
  const r = W.largestFree(panels);
  if (!r) { note('No free space: close or shrink a panel', true); return; }
  const base = type === 'tape' ? { type: 'tape', root: 'MNQ' } : type === 'ticket' || type === 'account' || type === 'quotes' || type === 'databox' ? { type } : { type: 'chart', root: 'MNQ', tf: 'm1' };
  const p = Object.assign({ id: W.newId() }, base, r);
  panels.push(p);
  addView(p);
  save(); syncConn(); placeColors(); syncAddMenu();
  if (type === 'ticket') takeTicket(ok => { if (!ok && views.has(p.id) && !holds()) closePanel(p.id); });
  else if (type === 'chart') { renderCharts(); if (botDesk) botDesk.chartsChanged(); }
}

/* ---------------- drag and resize: the ghost shows the snapped cells; a place that overlaps is refused */
let dragging = null;
function startDrag(e, v, mode, edge) {
  if (e.button !== 0 || dragging) return;
  if (maxId) { if (mode === 'size') note('Restore the panel to resize it', true); return; }   // 1.16.0: a maximized panel stays put
  e.preventDefault();
  closePops();
  const p = v.panel, m = W.metrics(grid.clientWidth, grid.clientHeight, gridGap(), gridGap()), sx = e.clientX, sy = e.clientY;
  const target = e.currentTarget;
  try { target.setPointerCapture(e.pointerId); } catch (err) { /* fine without */ }
  let r = { x: p.x, y: p.y, w: p.w, h: p.h }, ok = true;
  dragging = { v, mode };
  place(ghost, r); ghost.hidden = false; ghost.className = 'ws-ghost';
  v.el.classList.add(mode === 'move' ? 'dragging' : 'sizing');
  document.body.classList.add('ws-busy');
  if (mode === 'size') document.body.dataset.edge = edge || 'se';      // the resize cursor stays while dragging
  const move = ev => {
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    r = mode === 'move' ? W.snapMove(p, dx, dy, m) : W.snapResizeEdge(p, edge || 'se', dx, dy, m);
    ok = W.fits(r, panels, p.id);
    place(ghost, r);
    ghost.className = 'ws-ghost' + (ok ? '' : ' blocked');
    if (mode === 'move') v.el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
  };
  const end = ev => {
    target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', end); target.removeEventListener('pointercancel', end);
    v.el.style.transform = ''; v.el.classList.remove('dragging', 'sizing'); document.body.classList.remove('ws-busy'); delete document.body.dataset.edge;
    ghost.hidden = true; dragging = null;
    if (ev.type === 'pointercancel') return;
    const changed = r.x !== p.x || r.y !== p.y || r.w !== p.w || r.h !== p.h;
    if (!changed) return;
    if (!ok) { note('That place overlaps another panel: put back', true); return; }
    Object.assign(p, r); place(v.el, p); save();
  };
  target.addEventListener('pointermove', move); target.addEventListener('pointerup', end); target.addEventListener('pointercancel', end);
}

/* ---------------- Time and Sales: live trades from the window's feed for its instrument (no history is shown), newest on
   top. At most 500 trades kept; only the rows that fit are in the page. Once per animation frame at most, the bottom rows
   are refilled with the new trades and moved to the top, so a frame touches only as many rows as trades came in. A tape
   on an instrument a chart already shows starts with the trades since that chart went live. */
function mountTape(v) {
  const p = v.panel;
  v.state = 'connecting';
  const sel = v.head.querySelector('[data-act="root"]');
  sel.value = p.root;
  v.body.innerHTML = '<div class="tp-cols"><span>Time</span><span>Price</span><span>Size</span></div><div class="tp-list" role="log" aria-label="Time and Sales trades" aria-live="off"></div>';
  const list = v.body.querySelector('.tp-list');
  const T = new Float64Array(TAPE_MAX), P = new Float64Array(TAPE_MAX), V = new Float64Array(TAPE_MAX), S = new Int8Array(TAPE_MAX), B = new Uint8Array(TAPE_MAX), Q = new Int8Array(TAPE_MAX);
  let head = -1, count = 0, seq = 0, drawnSeq = 0, full = true, raf = 0, dec = 2;
  const rows = [];                                     // in page order, top first
  let ws = null, tries = 0, reconnect = 0, destroyed = false, root = p.root, ready = false, instruments = [];
  const setState = s => { v.state = s; syncConn(); };

  function fitRows() {
    const n = Math.max(1, Math.ceil(list.clientHeight / TAPE_ROW));
    while (rows.length < n) {
      const row = document.createElement('div');
      row.className = 'tp-row';
      row.innerHTML = '<span class="tp-t"></span><span class="tp-p"></span><span class="tp-v"></span>';
      row.hidden = true;
      rows.push({ el: row, t: row.children[0], p: row.children[1], v: row.children[2], cls: '' });
      list.appendChild(row);
    }
    while (rows.length > n) rows.pop().el.remove();
    full = true; schedule();
  }
  function schedule() { if (!raf && !destroyed) raf = requestAnimationFrame(drawTape); }
  /* row shows the i-th newest trade (0 the newest), or nothing */
  function fill(row, i) {
    if (i >= count) { if (!row.el.hidden) row.el.hidden = true; return; }
    const j = (head - i + TAPE_MAX) % TAPE_MAX;
    const k = W.tapeClass(Q[j], S[j]), cls = 'tp-row' + (k ? ' ' + k : '') + (B[j] ? ' big' : '');
    if (row.cls !== cls) { row.el.className = cls; row.cls = cls; }
    // 1.15.0 (review): a cell's text written only when it changed
    const tt = W.fmtClock(T[j]), pt = W.fmtPrice(P[j], dec), vt = String(V[j]);
    if (row.t.textContent !== tt) row.t.textContent = tt;
    if (row.p.textContent !== pt) row.p.textContent = pt;
    if (row.v.textContent !== vt) row.v.textContent = vt;
    if (row.el.hidden) row.el.hidden = false;
  }
  function drawTape() {
    raf = 0;
    const k = seq - drawnSeq;
    drawnSeq = seq;
    if (full || k >= rows.length) { full = false; for (let i = 0; i < rows.length; i++) fill(rows[i], i); return; }
    // the k new trades: the bottom k rows, refilled and moved to the top (newest first)
    for (let i = k - 1; i >= 0; i--) {
      const row = rows.pop();
      fill(row, i);
      list.insertBefore(row.el, list.firstChild);
      rows.unshift(row);
    }
  }
  function push(m) {
    head = (head + 1) % TAPE_MAX; if (count < TAPE_MAX) count++;
    const t = +m.t, v2 = +m.v;
    T[head] = t; P[head] = +m.p; V[head] = v2; S[head] = m.s === 1 ? 1 : m.s === -1 ? -1 : 0;
    Q[head] = typeof m.q === 'number' ? m.q : -128;     // 0.3.8: the Time and Sales category; -128 unknown
    B[head] = v2 >= bigFloor(root, t) ? 1 : 0;
    seq++;
    schedule();
  }
  function clear() { head = -1; count = 0; full = true; schedule(); }
  function useInstrument() { const i = instruments.find(x => x && x.root === root); if (i && +i.tick > 0) dec = W.decimalsOf(+i.tick); }
  function subscribe() {
    ready = false; setState('loading');
    // days 1 and tickHours 0: the least history ChartBridge sends (none of it is shown); live trades follow "ready"
    if (ws && ws.readyState === 1) ws.send({ type: 'subscribe', root, days: 1, tickHours: 0 });
  }
  function connect() {
    reconnect = 0;
    if (destroyed) return;
    setState('connecting');
    let sock;
    try { sock = hub.open(root); } catch (e) { later(); return; }
    ws = sock;
    sock.onopen = () => { if (sock === ws) tries = 0; };
    sock.onmessage = ev => {
      if (sock !== ws) return;
      const m = ev.message;
      if (!m) return;
      if (m.type === 'tick') { if (ready && m.root === root) push(m); }
      else if (m.type === 'hello') { instruments = m.instruments || []; useInstrument(); subscribe(); }
      else if (m.type === 'ready' && m.root === root) { ready = true; setState('live'); }
    };
    sock.onclose = () => { if (sock !== ws) return; ws = null; ready = false; setState('offline'); later(); };
  }
  let fastAt = 0;
  function later() { if (destroyed) return; tries++; const now = Date.now(), fast = tries === 1 && now - fastAt > 5000; if (fast) fastAt = now; reconnect = setTimeout(connect, fast ? 0 : Math.min(5000, 500 * tries)); }

  sel.addEventListener('change', () => {
    if (!W.ROOTS.includes(sel.value) || sel.value === root) return;
    root = p.root = sel.value;
    useInstrument();
    clear(); subscribe(); save();                      // the feed moves this tape to the new instrument's connection
  });
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fitRows) : null;
  if (ro) ro.observe(list);
  fitRows();
  connect();
  v.tape = { get root() { return root; }, count: () => count, refloor: () => { for (let i = 0; i < count; i++) { const j = (head - i + TAPE_MAX) % TAPE_MAX; B[j] = V[j] >= bigFloor(root, T[j]) ? 1 : 0; } full = true; schedule(); } };
  v.destroy = () => {
    destroyed = true; clearTimeout(reconnect); if (raf) cancelAnimationFrame(raf); raf = 0;
    if (ro) ro.disconnect();
    if (ws) { const s = ws; ws = null; s.onopen = s.onmessage = s.onclose = null; try { s.close(); } catch (e) { /* closed */ } }
  };
}
function refloorTapes() { for (const v of views.values()) if (v.tape) v.tape.refloor(); }

/* ======================================================================== the Account panel and the Quote board (1.15.0)
 * Anthony's consolidated form (2026-10-02), sized to sit under the ticket and anywhere else; nothing scrolls but a list's own
 * rows (as Time and Sales). Read from what the page already has: the order connection's positions, working orders and
 * today's fills (ChartBridge sends them; nothing new is asked), and the prices from the window's feed. The Account panel's
 * Close is the ticket's own "Also open" Close (TradeCore flattenHere(root), works with Armed off, from this window's own
 * connection as every Close); its x is the chart's x (chartAction: TradeCore's cancel in the ticket's window, forwarded
 * from any other, needs Armed). No new way to send an order.
 */
/* ---------------- prices: one stand-in on the window's feed per instrument while a panel needs it (days 1 and no ticks, the
   least ChartBridge sends; a chart's load of the instrument already holds it, so nothing new is asked then): the last
   trade, the session's high and low (from 18:00 ET), the prior settlement (ChartBridge 0.3.7) */
const QT = new Map();                                  // root -> quote line
const quoteSubs = new Set();                           // panels redrawn when a price changes: 4 times a second at most
/* Anthony's ruling (1.15.0): charts and orders first. A trade only notes the price (a few compares, no DOM); the Quote
   board and the Account panel's figures are written at most 4 times a second, in one animation frame, and only the
   cells whose text changed. They may lag a frame or 250 ms; they never cost the charts' frames or the tick path. */
const QUOTE_MS = 250;
let quoteTimer = 0;
const etNowSec = () => U.zoneSeconds(Date.now() / 1000);
function quoteChanged() {
  if (quoteTimer) return;
  quoteTimer = setTimeout(() => requestAnimationFrame(() => { quoteTimer = 0; for (const fn of quoteSubs) fn(); }), QUOTE_MS);
}
function watchQuote(root) {
  let q = QT.get(root);
  if (!q) {
    q = { root, sock: null, users: 0, last: null, high: null, low: null, day: null, settle: null, settleDate: '', timer: 0, tries: 0 };
    QT.set(root, q);
    quoteOpen(q);
  }
  q.users++;
  let done = false;
  return () => { if (done) return; done = true; if (--q.users > 0) return; clearTimeout(q.timer); quoteClose(q); QT.delete(root); };
}
function quoteClose(q) { const s2 = q.sock; q.sock = null; if (s2) { s2.onmessage = s2.onclose = null; try { s2.close(); } catch (e) { /* closed */ } } }
function quoteOpen(q) {
  q.timer = 0;
  let sock;
  try { sock = hub.open(q.root); } catch (e) { return; }
  q.sock = sock;
  const range = (h, l, t) => {                         // the session's high and low (a new one from 18:00 ET)
    const d = W.tradeDayOf(t);
    if (q.day !== d) { if (q.day !== null && d < q.day) return; q.day = d; q.high = h; q.low = l; return; }
    if (q.high === null || h > q.high) q.high = h;
    if (q.low === null || l < q.low) q.low = l;
  };
  sock.onmessage = ev => {
    const m = ev.message;
    if (!m || q.sock !== sock) return;
    if (m.type === 'ready') q.tries = 0;
    if (m.type === 'hello') {
      const i = (m.instruments || []).find(x => x && x.root === q.root);
      if (i) { q.settle = typeof i.settlement === 'number' ? i.settlement : null; q.settleDate = i.settlementDate || ''; }
      q.high = q.low = q.day = null;
      sock.send({ type: 'subscribe', root: q.root, days: 1, tickHours: 0 });
    } else if (m.type === 'history' && m.root === q.root && Array.isArray(m.bars)) {
      const today = W.tradeDayOf(etNowSec());
      for (const b of m.bars) { if (W.tradeDayOf(b[0]) === today) range(b[2], b[3], b[0]); }
      if (m.bars.length) q.last = +m.bars[m.bars.length - 1][4];
      quoteChanged();
    } else if (m.type === 'tick' && m.root === q.root) {
      q.last = +m.p; range(+m.p, +m.p, +m.t); quoteChanged();
    } else if (m.type === 'settlement' && m.root === q.root) {
      q.settle = typeof m.p === 'number' ? m.p : null; q.settleDate = m.date || ''; quoteChanged();
    }
  };
  sock.onclose = () => { if (q.sock !== sock) return; q.sock = null; if (q.users > 0) { const n = ++q.tries; q.timer = setTimeout(() => { if (q.users > 0 && !q.sock) quoteOpen(q); }, n === 1 ? 0 : Math.min(5000, 500 * n)); } };
}
const quoteOf = r => QT.get(r) || null;

/* ---------------- the Quote board: NQ and ES (1.16.0, Anthony 2026-10-05; the micros' rows are gone); read only */
const QUOTE_ROOTS = W.QUOTE_ROOTS;
/* Rows are small grids (ws-grid-rows, workspace.css): on a narrow panel the change and percent, and the high and low, stack
   in one cell each, so the board fits a 2-column panel at 1366 px with nothing cut and nothing scrolling (fitPanel). */
function mountQuotes(v) {
  v.body.innerHTML = '<div class="qb-wrap gr gr-qb" role="table" aria-label="Quote board"><div class="gr-row gr-h" role="row"><span role="columnheader"><span class="visually-hidden">Instrument</span></span><span class="r" role="columnheader">Last</span>' +
    '<span class="pr r"><span role="columnheader">Chg</span><span role="columnheader">%</span></span><span class="pr r"><span role="columnheader">High</span><span role="columnheader">Low</span></span></div>' +
    QUOTE_ROOTS.map(r => `<div class="gr-row" role="row" data-root="${r}"><span class="b" role="cell">${r}</span><span class="r" role="cell" data-q="last"></span><span class="pr r"><span role="cell" data-q="chg"></span><span role="cell" data-q="pct"></span></span><span class="pr r"><span role="cell" data-q="high"></span><span role="cell" data-q="low"></span></span></div>`).join('') +
    '<p class="qb-foot" data-q="foot"></p></div>';
  const offs = QUOTE_ROOTS.map(watchQuote);
  const cells = {};
  for (const tr of v.body.querySelectorAll('[data-root]')) { const c = cells[tr.dataset.root] = {}; for (const td of tr.querySelectorAll('[data-q]')) c[td.dataset.q] = td; }
  const set = (el, text, cls) => { if (el.textContent !== text) el.textContent = text; const k = cls || ''; if (el.className !== k) el.className = k; };
  const render = () => {
    let noSettle = 0;
    for (const r of QUOTE_ROOTS) {
      const q = quoteOf(r), c = cells[r], dec = precisionOf(r), x = q ? W.quoteChange(q.last, q.settle) : { chg: null, pct: null };
      const cls = x.chg > 0 ? 'up' : x.chg < 0 ? 'dn' : '';
      set(c.last, q && q.last !== null ? U.fmtPrice(q.last, dec) : '-', 'r');
      set(c.chg, W.fmtSignedNum(x.chg, dec), cls);
      set(c.pct, x.pct === null ? '' : W.fmtSignedNum(x.pct, 2) + '%', cls);
      set(c.high, q && q.high !== null ? U.fmtPrice(q.high, dec) : '');
      set(c.low, q && q.low !== null ? U.fmtPrice(q.low, dec) : '');
      if (q && q.last !== null && q.settle === null) noSettle++;
    }
    const foot = noSettle ? 'Change from the prior settlement: blank until ChartBridge 0.3.7 or newer gives one.' : '';
    for (const r of QUOTE_ROOTS) {                         // a tight board shows the last and percent: the rest in the row's tooltip
      const q = quoteOf(r), x = q ? W.quoteChange(q.last, q.settle) : { chg: null }, dec = precisionOf(r);
      const tip = r + (q && q.last !== null ? ' ' + U.fmtPrice(q.last, dec) : '') + (x.chg !== null ? ', ' + W.fmtSignedNum(x.chg, dec) + ' from the prior settlement' : '') +
        (q && q.high !== null ? ', high ' + U.fmtPrice(q.high, dec) + ', low ' + U.fmtPrice(q.low, dec) : '');
      const tr = cells[r].last.parentElement;
      if (tr.title !== tip) tr.title = tip;
    }
    const f = v.body.querySelector('[data-q="foot"]');
    if (f.textContent !== foot) { f.textContent = foot; f.hidden = !foot; }
  };
  quoteSubs.add(render);
  render();
  v.state = 'live';
  v.quotes = { render };
  /* wide: one line per instrument; narrow (under 400 px): the change and percent, and the high and low, stack; a board
     with no room for that either (a 2 x 1 panel): the last and percent only, the rest in the row's tooltip */
  const unfit = fitPanel(v, (w, h) => ({ 'gr-narrow': w < 400, 'gr-tight': w < 400 && h < 4 * 30 + 26 + 30, 'gr-tiny': w < 280 && h < 4 * 30 + 26 + 30 }));
  v.destroy = () => { unfit(); quoteSubs.delete(render); for (const f of offs) f(); };
}
/* ---------------- the Data Box (1.16.0, Anthony): the bar under the cursor on any chart (its open, high, low, close, range,
   volume, buys and sells, delta, the largest trade and the bubbles, its open time and how long it lasted); the newest bar of
   the last chart hovered when the mouse is on none. Read only. The charts tell it when their bar may have changed (ChartLive
   onBar, only while a Data Box is open: no cost otherwise); a cell is written only when its text changes. */
const dataBoxes = () => [...views.values()].filter(v => v.dataBox);
let dbChart = null;                                       // the chart view the Data Box follows
const DB_ROWS = [
  ['time', 'Opened'], ['dur', 'Lasted'], ['o', 'Open'], ['h', 'High'], ['l', 'Low'], ['c', 'Close'], ['rng', 'Range'], ['v', 'Volume'],
  ['buy', 'Buy vol'], ['sell', 'Sell vol'], ['dlt', 'Delta'], ['big', 'Largest print'], ['bub', 'Bubbles'], ['hov', 'Bubble'],
  ['tape', 'Tape to frame'],            // 1.16.0 debug: ChartBridge's receipt of a trade to the frame that drew it
];
function mountDataBox(v) {
  v.body.innerHTML = '<div class="db gr" role="table" aria-label="Data Box: the bar under the cursor">' +
    '<div class="db-head" data-db="head" role="row"></div>' +
    DB_ROWS.map(([k, name]) => `<div class="db-row" role="row" data-row="${k}"><span class="db-k" role="rowheader">${esc(name)}</span><span class="db-v" role="cell" data-db="${k}"></span></div>`).join('') +
    '<p class="db-note" data-db="note"></p></div>';
  const cells = {};
  for (const el of v.body.querySelectorAll('[data-db]')) cells[el.dataset.db] = el;
  const rows = {};
  for (const el of v.body.querySelectorAll('[data-row]')) rows[el.dataset.row] = el;
  const src = v.head.querySelector('.ws-db-src');
  const txt = (el, text) => { if (el.textContent !== text) el.textContent = text; };
  const set = (el, text, cls) => { txt(el, text); const k = 'db-v' + (cls ? ' ' + cls : ''); if (el.className !== k) el.className = k; };
  const show = (k, on) => { const r = rows[k]; if (r && r.hidden === on) r.hidden = !on; };
  const render = (c, x, second) => {
    const name = c ? c.panel.root + ' ' + W.tfLabel(c.panel.tf, c.panel.tf === 'range' ? c.panel.range : 0) : '';
    if (src.textContent !== name) src.textContent = name;
    if (!x) {
      txt(cells.head, c ? 'Waiting for ' + c.panel.root : 'Add a chart: the Data Box shows the bar under the cursor on any chart.');
      for (const [k] of DB_ROWS) { set(cells[k], ''); show(k, k !== 'hov'); }
      txt(cells.note, ''); cells.note.hidden = true;
      return;
    }
    const dp = x.dp, px = p => U.fmtPrice(p, dp), tick = x.tick > 0 ? x.tick : 0.25;
    txt(cells.head, (x.hovering ? 'Under the cursor' : 'Newest bar') + (x.forming ? ' · forming' : ''));
    cells.head.classList.toggle('live', !x.hovering);
    set(cells.time, U.fmtDay(x.t) + ' ' + W.fmtClock(x.t) + (Math.abs(x.t - Math.round(x.t)) > 1e-6 ? '.' + Math.floor((x.t % 1) * 10 + 1e-6) : ''));
    set(cells.dur, W.fmtSpan(Math.max(0, x.end - x.t)) + (x.forming ? ' so far' : ''));   // never below 0 (the data's clock a little ahead of the PC's)
    set(cells.o, px(x.o)); set(cells.h, px(x.h)); set(cells.l, px(x.l)); set(cells.c, px(x.c), x.c > x.o ? 'up' : x.c < x.o ? 'dn' : '');
    set(cells.rng, px(x.h - x.l) + ' (' + Math.round((x.h - x.l) / tick) + ' t)');
    set(cells.v, U.fmtPrice(x.v, 0));
    const d = x.delta;
    set(cells.buy, d ? U.fmtPrice(d.buy, 0) : '-', d ? 'up' : 'mut');
    set(cells.sell, d ? U.fmtPrice(d.sell, 0) : '-', d ? 'dn' : 'mut');
    const dl = d ? d.buy - d.sell : null;
    set(cells.dlt, dl === null ? '-' : W.fmtSignedNum(dl, 0) || '0', dl > 0 ? 'up' : dl < 0 ? 'dn' : d ? '' : 'mut');
    set(cells.big, d && d.big > 0 ? U.fmtPrice(d.big, 0) + ' contracts' : '-', d ? '' : 'mut');
    const why = { off: 'Buy and sell volume, delta and the largest print come from the chart\'s Cumulative delta: turn it on in Indicators.',
      old: 'This ChartBridge sends no trade sides: no buy and sell volume.', htf: 'No buy and sell volume on 4h, 1D and 1W bars.',
      building: 'Counting the trades: buy and sell volume shortly.', before: 'Buy and sell volume count from ' + (x.deltaFrom !== null ? W.fmtClock(x.deltaFrom) + ' ET' : 'the page\'s opening') + ': none for this bar.' }[x.deltaWhy] || '';
    txt(cells.note, why); if (cells.note.hidden !== !why) cells.note.hidden = !why;
    const b = x.bubbles;
    set(cells.bub, !b ? 'Off on this chart' : !b.n ? 'None' : b.n + (b.n > 1 ? ', largest ' : ': ') + (b.side > 0 ? 'Buy ' : 'Sell ') + U.fmtPrice(Math.round(b.max), 0),
      !b ? 'mut' : b.n ? (b.side > 0 ? 'up' : 'dn') : '');
    const h = x.bubble;
    show('hov', !!h);
    if (h) set(cells.hov, (h.side > 0 ? 'Buy ' : 'Sell ') + U.fmtPrice(Math.round(h.v), 0) + ' @ ' + px(h.p) + ' ' + W.fmtClock(h.t), h.side > 0 ? 'up' : 'dn');
    if (second || !cells.tape.textContent) {          // once a second (the stamp is one number per frame, kept by the chart)
      const st = typeof c.pane.timing === 'function' ? c.pane.timing() : {};
      set(cells.tape, typeof st.drawMax === 'number' ? fmtDelay(st.draw) + ' (worst ' + fmtDelay(st.drawMax) + ')' : '-', 'mut');
    }
  };
  v.state = 'live';
  v.dataBox = { render };
  const unfit = fitPanel(v, (w, h) => ({ 'db-wide': w >= 360 && h < 15 * 19 + 40, 'db-short': h < 8 * 19 + 40 }));
  v.destroy = () => { unfit(); delete v.dataBox; followAll(); };
  followAll();
  renderDataBoxes();
}
/* The charts' bar changes, while a Data Box is open: the chart hovered becomes the one followed. */
function followBars(v) {
  if (v.offBar) { v.offBar(); v.offBar = null; }
  if (!dataBoxes().length || !v.pane || typeof v.pane.onBar !== 'function') return;
  v.offBar = v.pane.onBar(hovering => {
    if (hovering && dbChart !== v) dbChart = v;
    if (dbChart === v) renderDataBoxes();
  });
}
function followAll() {
  for (const v of chartViews()) followBars(v);
  if (dbChart && (!views.has(dbChart.panel.id) || views.get(dbChart.panel.id) !== dbChart)) dbChart = null;
}
function renderDataBoxes(second) {
  const boxes = dataBoxes();
  if (!boxes.length) return;
  if (!dbChart || views.get(dbChart.panel.id) !== dbChart) dbChart = chartViews()[0] || null;
  const x = dbChart && typeof dbChart.pane.barInfo === 'function' ? dbChart.pane.barInfo() : null;
  for (const b of boxes) b.dataBox.render(dbChart, x, second === true);
}
setInterval(() => renderDataBoxes(true), 1000);                      // the forming bar's "so far", and a chart closed or reloaded

/* The Account panel's and the Quote board's classes from their size (`classes(width, height)` -> { class: on }), from a
   ResizeObserver (container queries cost every chart frame, perf:workspace). Returns the undo. */
function fitPanel(v, classes) {
  if (typeof ResizeObserver !== 'function') return () => {};
  const ro = new ResizeObserver(list => { for (const e of list) { const r = e.contentRect, k = classes(r.width, r.height); for (const c of Object.keys(k)) v.el.classList.toggle(c, !!k[c]); } });
  ro.observe(v.el);
  return () => ro.disconnect();
}

/* ---------------- the Account panel: a summary strip for the ticket's account, then Positions, Orders and Fills */
/* The tabs, in order. A fourth, "Accounts" (the copier, after the cruise: a row per account with its position, P&L and
   copy on or off), goes here as one more entry with its own render; it is not built. */
const ACCOUNT_TABS = [{ id: 'pos', name: 'Positions' }, { id: 'ord', name: 'Orders' }, { id: 'fil', name: 'Fills' }];
const accountViews = () => [...views.values()].filter(v => v.account);
const SIDE_WORD = { buy: 'Buy', sell: 'Sell' };
function orderTypeName(o) {
  if (o.plan) return 'Planned ' + (o.plan.role === 'stop' ? 'stop' : 'target');
  const kind = o.role === 'target' ? 'target' : o.role === 'stop' ? 'stop' : o.kind === 'limit' ? 'limit' : o.kind === 'stop' ? 'stop' : o.kind === 'stopLimit' ? 'stop limit' : o.kind === 'market' ? 'market' : String(o.kind || 'order');
  return SIDE_WORD[o.side] + ' ' + kind;
}
function mountAccount(v) {
  v.body.innerHTML = `<div class="ac">
    <div class="ac-sum" role="group" aria-label="Today on the ticket's account">
      <div title="Open P&amp;L of the positions now"><span>Open</span><b data-a="open"></b></div><div title="Realized today, from the fills (before commissions)"><span><span class="lb-full">Realized</span><span class="lb-short">Real.</span></span><b data-a="real"></b></div>
      <div title="Realized and open together"><span>Day</span><b data-a="day"></b></div><div title="Trades today, flat to flat"><span>Trades</span><b data-a="trades"></b></div></div>
    <div class="ac-tabs" role="tablist" aria-label="Account">${ACCOUNT_TABS.map((t, i) => `<button type="button" role="tab" class="ac-tab" data-tab="${t.id}" aria-selected="${i === 0}">${t.name}<span class="ac-ct" data-ct="${t.id}"></span></button>`).join('')}</div>
    <div class="ac-list" data-list role="tabpanel"></div>
    <p class="ac-foot" data-a="foot" title="Close works with Armed off. × needs Armed, as on the chart.">Close works with Armed off. × needs Armed, as on the chart.</p>
  </div>`;
  const q = sel => v.body.querySelector(sel);
  const A = v.account = { tab: 'pos', keys: {}, offs: new Map(), render: null };
  v.state = 'live';
  q('.ac-tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    b.blur();                                            // the hotkeys work at once (handBack)
    A.tab = b.dataset.tab;
    for (const t of v.body.querySelectorAll('.ac-tab[data-tab]')) t.setAttribute('aria-selected', String(t === b));
    A.keys.list = ''; A.render();
  });
  q('[data-list]').addEventListener('click', e => {
    const b = e.target.closest('button[data-close], button[data-cancel]'); if (!b) return;
    b.blur();
    if (e.detail === 0) { note('Order buttons work by click only, not by keyboard.', true); return; }
    if (b.dataset.close) core.flattenHere(b.dataset.close);                          // the ticket's "Also open" Close
    /* Anthony (1.15.0): the x cancels an order of ANY instrument: TradeCore's own cancel (needs Armed, the order on the
       ticket's account and still working), in the ticket's window or forwarded to it as the chart's x is */
    else chartAction({ kind: 'cancelAny', id: b.dataset.cancel, root: b.dataset.root });
  });
  const put = (k, el, text, cls) => { const key = text + '|' + cls; if (A.keys[k] === key) return; A.keys[k] = key; el.textContent = text; el.className = cls || ''; };
  A.render = () => {
    const TR = core.TR, acct = ticketAccount(), on = TR.enabled && !!acct, now = etNowSec();
    /* the prices of the instruments with a position (their open P&L): watched while open */
    const roots = on ? W.ROOTS.filter(r => { const p = TR.positions.get(acct + '|' + r); return p && p.qty; }) : [];
    for (const r of roots) if (!A.offs.has(r)) A.offs.set(r, watchQuote(r));
    for (const [r, off] of A.offs) if (!roots.includes(r)) { off(); A.offs.delete(r); }
    const pv = r => (instruments[r] || {}).pointValue || 0;
    let open = 0, openKnown = true;
    const posRows = roots.map(r => {
      const p = TR.positions.get(acct + '|' + r), qq = quoteOf(r), last = qq && qq.last !== null ? qq.last : r === ticketRoot() ? ticketPrice(r) : null;
      const pn = last !== null && last !== undefined ? U.openPnl(p.qty, p.avgPrice, last, pv(r)) : null;
      if (pn && pn.dollars !== null) open += pn.dollars; else openKnown = false;
      return { r, p, pn };
    });
    const today = on ? W.fillsToday([...tfills.values()], acct, now).map(f => Object.assign({}, f, { qty: +f.qty, p: +f.p, t: +f.t })) : [];
    /* each instrument's position before today's first fill: what it is now less today's fills (not flat: that first
       trade began before today and its P&L is not known) */
    const start = {};
    for (const r of W.ROOTS) {
      const p = on ? TR.positions.get(acct + '|' + r) : null, net = today.filter(f => f.root === r).reduce((a, f) => a + (f.side === 'buy' ? 1 : -1) * f.qty, 0);
      start[r] = (p ? p.qty : 0) - net;
    }
    const rt = W.roundTrips(today, pv, start);
    const day = rt.realized !== null && openKnown ? rt.realized + open : null;
    const pc = x => (x > 0.004 ? 'up' : x < -0.004 ? 'dn' : '');
    put('open', q('[data-a="open"]'), !on ? '-' : openKnown ? W.fmtUsd(open) : 'waiting', on && openKnown ? pc(open) : '');
    put('real', q('[data-a="real"]'), !on ? '-' : rt.realized === null ? 'n/a' : W.fmtUsd(rt.realized), on ? pc(rt.realized) : '');
    put('day', q('[data-a="day"]'), !on || day === null ? '-' : W.fmtUsd(day), on && day !== null ? pc(day) : '');
    put('trades', q('[data-a="trades"]'), on ? String(rt.trades) : '-', '');
    const orders = on ? W.ROOTS.flatMap(r => core.chartOrders(acct, r).map(o => (o.root ? o : Object.assign({}, o, { root: r })))) : [];   // a planned line has no root of its own
    const counts = { pos: posRows.length, ord: orders.length, fil: today.length };
    for (const t of ACCOUNT_TABS) put('ct-' + t.id, q(`[data-ct="${t.id}"]`), String(counts[t.id]), 'ac-ct');
    put('acct', v.el.querySelector('.ws-acct'), acct || 'No account', 'ws-acct');
    /* the list of the tab shown */
    /* rows as small grids (as the Quote board): on a narrow panel each pair (.pr) stacks in one cell.
       1.15.0 (orders review: a Close replaced between press and release lost the click): the rows are built only when the
       set of rows changes (instruments, order ids, fills); a price or P&L change writes only the text of its cell, so a
       button is never replaced under the mouse. */
    const vals = [];
    const row = (k, cells) => `<div class="gr-row" role="row" data-k="${esc(k)}">${cells}</div>`, head = cells => `<div class="gr-row gr-h" role="row">${cells}</div>`;
    const c = (text, cls, tip) => `<span role="cell" data-c="${vals.push({ text, cls: cls || '', tip: tip || '' }) - 1}"></span>`;   // a cell whose text changes
    const pr = (a, b, cls) => `<span class="pr${cls ? ' ' + cls : ''}">${a}${b}</span>`;
    const st = (html, cls) => `<span class="${cls || ''}" role="cell">${html}</span>`;           // a fixed cell (a button)
    const h = (text, cls) => `<span class="${cls || ''}" role="columnheader">${text}</span>`;
    let html;
    if (!on) html = `<p class="ac-empty">${esc(core.TR.reason || 'Not connected to ChartBridge yet.')}</p>`;
    else if (A.tab === 'pos') html = !posRows.length ? '<p class="ac-empty">Flat on every instrument.</p>' : '<div class="gr gr-pos" role="table" aria-label="Positions">' +
      head(pr(h('Inst'), h('Qty', 'r')) + h('Avg', 'r') + pr(h('Open pt', 'r'), h('Open $', 'r'), 'r') + h('<span class="visually-hidden">Close</span>')) +
      posRows.map(({ r, p, pn }) => row(r, pr(c(r, 'b'), c((p.qty > 0 ? '+' : '-') + Math.abs(p.qty), 'r ' + (p.qty > 0 ? 'up' : 'dn'))) + c(U.fmtPrice(p.avgPrice, precisionOf(r)), 'r') +
        pr(c(pn ? W.fmtSignedNum(pn.points, precisionOf(r)) : '', 'r ' + (pn ? pc(pn.points) : '')), c(pn && pn.dollars !== null ? W.fmtUsd(pn.dollars) : '', 'r ' + (pn ? pc(pn.dollars) : '')), 'r') +
        st(`<button type="button" class="ac-btn ac-close" data-close="${r}" title="Close ${r}: cancel its orders and close its position at market on ${esc(acct)}. Works with Armed off.">Close</button>`, 'r'))).join('') + '</div>';
    else if (A.tab === 'ord') html = !orders.length ? '<p class="ac-empty">No working orders.</p>' : '<div class="gr gr-ord" role="table" aria-label="Working orders">' +
      head(pr(h('Inst'), h('Qty', 'r')) + pr(h('Order'), h('Price', 'r'), 'r2') + h('<span class="visually-hidden">Cancel</span>')) +
      orders.map(o => row(o.id, pr(c(o.root || '', 'b'), c(String(Math.max(0, (+o.qty || 0) - (+o.filled || 0))), 'r')) +
        pr(c(orderTypeName(o), o.side === 'sell' ? 'dn' : 'up'), c(typeof o.price === 'number' ? U.fmtPrice(o.price, precisionOf(o.root)) : '', 'r'), 'r2') +
        st(`<button type="button" class="ac-x" data-cancel="${esc(o.id)}" data-root="${esc(o.root || '')}" aria-label="Cancel this ${esc(o.root || '')} order" title="Cancel it (needs Armed, as the chart's x), on any instrument">×</button>`, 'r'))).join('') + '</div>';
    else html = !today.length ? '<p class="ac-empty">No fills today.</p>' : '<div class="gr gr-fil" role="table" aria-label="Today\'s fills">' +
      head(pr(h('Time'), h('Inst')) + pr(h('Side', 'r'), h('Price', 'r'), 'r') + h('Trade', 'r')) +
      today.slice().sort((a, b) => b.t - a.t).map(f => {
        const x = rt.byFill.get(f.id), trade = !x ? '' : x.open ? 'open' : x.pnl === null ? 'n/a' : W.fmtUsd(x.pnl), cls = !x || x.open || x.pnl === null ? 'mut' : pc(x.pnl);
        const tip = x && x.pnl === null && !x.open ? 'This trade began before today: its first fills are not in today\'s list' : '';
        return row(f.account + '|' + f.id, pr(c(W.fmtClock(f.t), 'mut'), c(f.root, 'b')) + pr(c((f.side === 'buy' ? 'B ' : 'S ') + f.qty, 'r ' + (f.side === 'buy' ? 'up' : 'dn')), c(U.fmtPrice(f.p, precisionOf(f.root)), 'r'), 'r') +
          c(trade, 'r ' + cls, tip));
      }).join('') + '</div>';
    const el = q('[data-list]');
    if (A.keys.list !== html) { A.keys.list = html; const top = el.scrollTop; el.innerHTML = html; el.scrollTop = top; A.cells = [...el.querySelectorAll('[data-c]')]; A.rebuilt = (A.rebuilt || 0) + 1; }
    const cells = A.cells || [];
    for (let i = 0; i < vals.length && i < cells.length; i++) {
      const e = cells[i], x = vals[i];
      if (e.textContent !== x.text) e.textContent = x.text;
      if (e.className !== x.cls) e.className = x.cls;
      if ((e.title || '') !== x.tip) e.title = x.tip;
    }
  };
  A.render();
  quoteSubs.add(A.render);
  const unfit = fitPanel(v, (w, h) => ({ 'gr-narrow': w < 360, 'gr-short': h < 170 }));
  v.destroy = () => { unfit(); quoteSubs.delete(A.render); for (const off of A.offs.values()) off(); A.offs.clear(); };
}
/* order events, fills and positions: the Account panels again, once in the next animation frame */
let accountRaf = 0;
function renderAccounts() { if (!accountRaf && accountViews().length) accountRaf = requestAnimationFrame(() => { accountRaf = 0; for (const v of accountViews()) v.account.render(); }); }
setInterval(renderAccounts, 1000);                       // the clock (a new trading day) and the prices without a trade

/* ---------------- popovers (Add panel, Settings, a chart's instrument and bars or its menu, a tape's gear): one open at a
   time; an outside click or Esc closes */
let pop = null;
function openPop(el, anchor, onClose, align) {
  closePops();
  el.hidden = false;
  if (anchor) {
    anchor.setAttribute('aria-expanded', 'true'); raise(anchor, true);
    const a = anchor.getBoundingClientRect(), w = el.offsetWidth;
    /* 1.14.0 (no scrolling, ever): under its button when it fits, else moved up until it does; only one taller than the
       window scrolls */
    el.style.maxHeight = '';
    const h = el.offsetHeight, room = window.innerHeight - 8, top = Math.max(8, Math.min(a.bottom + 6, room - h));
    el.style.top = Math.round(top) + 'px';
    if (top + h > room) el.style.maxHeight = Math.floor(room - top) + 'px';
    const x = align === 'left' ? a.left : a.right - w;
    el.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, x))) + 'px';
  }
  pop = { el, anchor, onClose };
}
function closePops() {
  if (!pop) return;
  const { el, anchor, onClose } = pop; pop = null;
  el.hidden = true;
  if (anchor) { anchor.setAttribute('aria-expanded', 'false'); raise(anchor, false); }
  if (onClose) onClose();
}
const toggle = (el, anchor, open) => { if (pop && pop.anchor === anchor) { closePops(); return; } open(); };
document.addEventListener('pointerdown', e => { if (pop && !pop.el.contains(e.target) && !(pop.anchor && pop.anchor.contains(e.target))) closePops(); }, true);
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !pop || e.defaultPrevented) return;
  const back = pop.anchor; closePops(); if (back && back.isConnected) back.focus();
});

$('wsAdd').addEventListener('click', e => toggle($('wsAddMenu'), e.currentTarget, () => { syncAddMenu(); openPop($('wsAddMenu'), e.currentTarget); }));
$('wsAddMenu').addEventListener('click', e => { const b = e.target.closest('[data-add]'); if (b && !b.disabled) addPanel(b.dataset.add); });
function syncAddMenu() {
  const b = $('wsAddMenu').querySelector('[data-add="ticket"]'), has = panels.some(p => p.type === 'ticket');
  b.disabled = has; b.title = has ? 'This layout has its order ticket' : '';
}

/* A chart's instrument and bars: the instruments, the bars, and the range size for Range bars. Applied at once. */
function openViewPop(v, anchor) {
  toggle($('wsView'), anchor, () => {
    const p = v.panel, el = $('wsView');
    el.dataset.id = p.id;
    el.innerHTML = '<div class="vw-row" role="group" aria-label="Instrument">' + W.ROOTS.map(r => `<button type="button" data-root="${r}" aria-pressed="${r === p.root}">${r}</button>`).join('') + '</div>' +
      '<div class="vw-row" role="group" aria-label="Bars">' + W.TFS.filter(t => !W.HTF_TFS.includes(t)).map(t => `<button type="button" data-tf="${t}" aria-pressed="${t === p.tf}"${t === 'h1' ? ' title="' + esc(H1_NOTE) + '"' : ''}>${TF_SHORT[t]}</button>`).join('') + '</div>' +
      /* 1.15.0: 4h, 1D and 1W on their own row; with ChartBridge before 0.3.7 they show and say what they need */
      '<div class="vw-row" role="group" aria-label="NinjaTrader bars">' + W.HTF_TFS.map(t => `<button type="button" data-tf="${t}" aria-pressed="${t === p.tf}" title="${esc(htfServed() ? HTF_NOTE : HTF_OLD + ' (this PC: ' + (bridgeVer || '-') + ')')}"${htfServed() ? '' : ' class="vw-old"'}>${TF_SHORT[t]}</button>`).join('') +
      (htfServed() ? '' : `<span class="vw-need">${esc(HTF_OLD)}</span>`) + '</div>' +
      (p.tf === 'range' ? `<label class="vw-range"><span>Range size</span><input type="number" min="1" max="400" step="1" inputmode="numeric" data-f="range" value="${p.range || ''}" aria-label="Range bar size for ${p.root} in ticks"><span>ticks</span></label>` : '') +
      (p.tf === 'h1' ? `<p class="ws-help">${esc(H1_NOTE)}</p>` : W.HTF_TFS.includes(p.tf) ? `<p class="ws-help">${esc(htfServed() ? HTF_NOTE : HTF_OLD + '. This PC runs ChartBridge ' + (bridgeVer || '-') + '.')}</p>` : '');
    openPop(el, anchor, null, 'left');
  });
}
$('wsView').addEventListener('click', e => {
  const b = e.target.closest('button'), v = views.get($('wsView').dataset.id);
  if (!b || !v || !v.pane) return;
  if (b.dataset.root) v.pane.setView({ root: b.dataset.root, range: b.dataset.root === v.panel.root ? undefined : prefs.range(b.dataset.root) });
  else if (b.dataset.tf) v.pane.setView({ tf: b.dataset.tf, range: b.dataset.tf === 'range' && !v.panel.range ? prefs.range(v.panel.root) : undefined });
  const anchor = v.viewBtn;
  closePops(); openViewPop(v, anchor);              // drawn again for the new choice
  const box = $('wsView').querySelector('[data-f="range"]');
  if (box && b.dataset.tf === 'range') box.focus();
});
$('wsView').addEventListener('change', e => {
  const i = e.target.closest('[data-f="range"]'), v = views.get($('wsView').dataset.id);
  if (!i || !v || !v.pane) return;
  const n = W.parseRange(i.value);
  if (n === null) { i.value = v.panel.range || ''; note('Range size: a whole number of ticks, 1 to 400', true); return; }
  v.pane.setView({ range: n });
});
$('wsView').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.closest('[data-f="range"]')) { e.preventDefault(); e.target.dispatchEvent(new Event('change', { bubbles: true })); } });

/* A chart's small menu: Reset view (1.15.0: the drawing tools moved to the ring, a middle-click on the chart). */
function openMore(v, anchor) {
  toggle($('wsMore'), anchor, () => {
    $('wsMore').dataset.id = v.panel.id;
    // 1.16.0: the bot's trades, faint, on this chart (live/bot.js); only while ChartBridge's bot switch is on
    const g = $('wsMore').querySelector('[data-do="ghost"]');
    g.hidden = !(botDesk && botDesk.ghostOffered());
    if (!g.hidden) g.textContent = 'Bot trades (faint): ' + (botDesk.ghostOn(v.panel.id) ? 'on' : 'off');
    openPop($('wsMore'), anchor);
  });
}
$('wsMore').addEventListener('click', e => {
  const b = e.target.closest('button'), v = views.get($('wsMore').dataset.id);
  if (!b || !v || !v.pane) return;
  if (b.dataset.do === 'reset') v.pane.chart.reset();
  else if (b.dataset.do === 'ghost' && botDesk) botDesk.setGhost(v.panel.id, !botDesk.ghostOn(v.panel.id));
  closePops();
});

/* ---------------- the drawing ring (1.15.0, Anthony): a middle-click (no modifier) on a chart's plot opens four tools around
   the pointer: Trend line (top), Price line (right), Clear this chart (bottom), Zone (left). A click arms the tool on THAT
   chart; the armed tool draws one drawing, then is off. A click outside or Escape closes the ring; Escape also takes back
   an armed tool or a drawing half made, on any chart. The middle button never places, moves or cancels an order, and its
   press is kept from the browser over the charts (no Windows auto-scroll). The ring is fixed, never scrolls, stays inside
   the chart (moved in from an edge), and gives the focus back to the page so the hotkeys work at once. */
const RING_R = 40, RING_BTN = 32, RING_HALF = RING_R + RING_BTN / 2 + 2;
const RING_NAMES = { trend: 'Trend line: click two points or drag', hline: 'Price line: click a price', zone: 'Zone: click two corners or drag' };
let ring = null;                                         // { v } while the ring is open
const chartOf = el => { const p = el && el.closest ? el.closest('.ws-panel.chart') : null, v = p ? views.get(p.dataset.id) : null; return v && v.pane ? v : null; };
function plotRect(v) {
  const cv = v.pane.chart && v.body.querySelector('canvas.ce-canvas');
  if (!cv) return null;
  const r = cv.getBoundingClientRect(), dp = v.pane.chart.deltaPane();
  return { left: r.left, top: r.top, right: r.right - 78, bottom: r.top + dp.plotHeight };
}
function openRing(v, x, y) {
  closePops(); closeRing();
  const r = plotRect(v); if (!r) return;
  const el = $('wsRing');
  // centred on the pointer, moved in so the whole ring stays inside the chart's plot ("flips" from an edge)
  const cx = Math.round(Math.max(r.left + RING_HALF, Math.min(r.right - RING_HALF, x))), cy = Math.round(Math.max(r.top + RING_HALF, Math.min(r.bottom - RING_HALF, y)));
  el.style.left = (cx - RING_HALF) + 'px'; el.style.top = (cy - RING_HALF) + 'px';
  const t = v.pane.chart.getTool();
  for (const b of el.querySelectorAll('[data-ring]')) b.setAttribute('aria-pressed', String(t === b.dataset.ring));
  el.hidden = false;
  ring = { v };
}
function closeRing() {
  if (!ring) return;
  ring = null; $('wsRing').hidden = true;
  if (document.activeElement && $('wsRing').contains(document.activeElement)) document.activeElement.blur();   // handBack
}
$('wsRing').addEventListener('click', e => {
  const b = e.target.closest('button[data-ring]'), r = ring;
  if (!b || !r || !views.has(r.v.panel.id)) { closeRing(); return; }
  const c = r.v.pane.chart, what = b.dataset.ring, name = r.v.panel.root + ' ' + W.tfLabel(r.v.panel.tf, r.v.panel.range);
  closeRing();
  if (what === 'clear') { c.clearDrawings(); note('Drawings cleared on ' + name + '.', false); return; }
  for (const o of chartViews()) if (o !== r.v && o.pane.chart.getTool()) o.pane.chart.setTool(null);   // one armed tool at a time
  c.setTool(what);
  note(RING_NAMES[what] + ' on ' + name + '. Escape cancels.', false, 6000);
});
$('wsRing').addEventListener('contextmenu', e => e.preventDefault());
/* the middle button over the charts: the ring on the plot, and never the browser's auto-scroll anywhere on a chart */
grid.addEventListener('pointerdown', e => {
  if (e.button !== 1) return;
  const v = chartOf(e.target);
  if (!v || !e.target.closest('.chart-box')) return;
  e.preventDefault(); e.stopPropagation();               // the chart never sees it: no pan, no order, no drawing
  if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
  const r = plotRect(v);
  if (r && e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom) openRing(v, e.clientX, e.clientY);
}, true);
for (const t of ['mousedown', 'auxclick']) grid.addEventListener(t, e => { if (e.button === 1 && chartOf(e.target) && e.target.closest('.chart-box')) { e.preventDefault(); e.stopPropagation(); } }, true);
document.addEventListener('pointerdown', e => { if (ring && !$('wsRing').contains(e.target)) closeRing(); }, true);
/* Escape closes the ring first (before a chart's own keys see it), then takes back an armed tool on any chart */
document.addEventListener('keydown', e => { if (e.key === 'Escape' && ring) { e.preventDefault(); e.stopPropagation(); closeRing(); } }, true);
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const armed = chartViews().filter(v => v.pane.chart.getTool());
  if (armed.length && !pop) { e.preventDefault(); for (const v of armed) v.pane.chart.setTool(null); note('Drawing tool off.', false, 3000); }
});

/* Large prints: one table in Settings (every instrument), one row in a tape's gear (its instrument). */
function floorRow(r) {
  const f = floors[r];
  return `<div class="fl-row" data-root="${r}"><span class="fl-root">${r}</span>` +
    `<label><span>RTH</span><input type="number" min="1" max="100000" step="1" inputmode="numeric" data-root="${r}" data-w="rth" value="${f.rth}" aria-label="${r} large print floor, RTH"></label>` +
    `<label><span>Overnight</span><input type="number" min="1" max="100000" step="1" inputmode="numeric" data-root="${r}" data-w="eth" value="${f.eth}" aria-label="${r} large print floor, overnight"></label></div>`;
}
function onFloorInput(e) {
  const i = e.target.closest('input[data-w]'); if (!i) return;
  if (prefs.setLargeFloor(i.dataset.root, i.dataset.w, i.value)) { readFloorsNow(); refloorTapes(); refloorCharts(); i.classList.remove('bad'); }
  else i.classList.add('bad');
}
function onFloorBlur(e) { const i = e.target.closest('input[data-w]'); if (i) { i.value = floors[i.dataset.root][i.dataset.w]; i.classList.remove('bad'); } }
for (const el of [$('wsSettings'), $('wsGear')]) { el.addEventListener('input', onFloorInput); el.addEventListener('focusout', onFloorBlur); }

/* The charts' bubbles and absorption bars use the same floors (G1c): a floor set here reaches them at once, and one set
   in a chart's gear ('chartlive-floors') reaches the tapes and this table. */
function refloorCharts() { for (const v of chartViews()) v.pane.refreshSettings(); }
window.addEventListener('chartlive-floors', e => {
  if (!e.detail || e.detail.prefix !== PREFIX) return;
  readFloorsNow(); refloorTapes();
  if (pop && pop.el === $('wsSettings')) $('wsFloors').innerHTML = W.ROOTS.map(floorRow).join('');
});
function openTapeGear(v, anchor) {
  toggle($('wsGear'), anchor, () => { $('wsGearBody').innerHTML = floorRow(v.tape.root); renderTapeColors(); openPop($('wsGear'), anchor); });
}
/* The tape's gear: the five category colors (1.14.0), a picker and a hex box each, and Default colors. */
function renderTapeColors() {
  $('wsTapeColors').innerHTML = W.TAPE_CATS.map(c => `<div class="tc-row" data-key="${c.key}"><span class="tc-name">${esc(c.name)}</span>` +
    `<input type="color" data-tc="${c.key}" value="${tapeColors[c.key].toLowerCase()}" aria-label="${esc(c.name)} color">` +
    `<input type="text" class="tc-hex" data-tchex="${c.key}" value="${tapeColors[c.key]}" maxlength="7" spellcheck="false" autocomplete="off" aria-label="${esc(c.name)} color, hex"></div>`).join('');
}
function setTapeColorHere(key, hex) {
  if (!W.setTapeColor(store, key, hex)) return false;
  tapeColors = W.readTapeColors(store); applyTapeColors(); return true;
}
$('wsGear').addEventListener('input', e => {
  const c = e.target.closest('input[data-tc]');
  if (c && setTapeColorHere(c.dataset.tc, c.value)) { const h = $('wsGear').querySelector(`[data-tchex="${c.dataset.tc}"]`); if (h) h.value = tapeColors[c.dataset.tc]; }
  const h = e.target.closest('input[data-tchex]');
  if (h) { const v = h.value.trim(), hex = /^#?[0-9a-f]{6}$/i.test(v) ? (v[0] === '#' ? v : '#' + v) : ''; h.classList.toggle('bad', !hex); if (hex && setTapeColorHere(h.dataset.tchex, hex)) { const p = $('wsGear').querySelector(`[data-tc="${h.dataset.tchex}"]`); if (p) p.value = hex.toLowerCase(); } }
});
$('wsGear').addEventListener('focusout', e => { const h = e.target.closest('input[data-tchex]'); if (h) { h.value = tapeColors[h.dataset.tchex]; h.classList.remove('bad'); } });
$('wsTapeDefault').addEventListener('click', () => { if (W.resetTapeColors(store)) { tapeColors = W.readTapeColors(store); applyTapeColors(); renderTapeColors(); } });

/* ---------------- Settings: everything general (Anthony): Glide and Range style for every chart (and the single chart
   page), the trading hotkeys (the 1.11.0 Settings), the large-print floors, ChartBridge's PIN, the layout. */
function renderGeneral() {
  const s = prefs.settings();
  for (const b of $('wsGlide').children) b.setAttribute('aria-pressed', String(b.dataset.v === s.glide));
  for (const b of $('wsGridLines').children) b.setAttribute('aria-pressed', String(b.dataset.v === s.grid));
  const room = prefs.roomSaved() ? s.room : LP.DEFAULT_ROOM_WS;   // 1.15.0: 80, 120 or 160 px, 120 until one is picked
  for (const b of $('wsRoom').children) b.setAttribute('aria-pressed', String(+b.dataset.v === room));
  if (document.activeElement !== $('wsAtr')) $('wsAtr').value = s.atr;
  $('wsRangeMode').value = s.rangeMode;
  const less = !!(window.ChartMotion && window.ChartMotion.reduced());   // 1.16.0: Less motion (the motion kit's own setting)
  for (const b of $('wsMotion').children) b.setAttribute('aria-pressed', String((b.dataset.v === 'less') === less));
}
$('wsMotion').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]'); if (!b || !window.ChartMotion) return;
  window.ChartMotion.setReducedMotion(b.dataset.v === 'less'); renderGeneral();
});
/* 1.14.0: grid lines (off by default) and the room right of price, for every chart and the single chart page */
$('wsGridLines').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]'); if (!b || !LP.GRIDS.includes(b.dataset.v)) return;
  prefs.setSetting('grid', b.dataset.v); renderGeneral();
  for (const v of chartViews()) v.pane.refreshSettings();
});
/* the ATR period (review D2, Anthony): every chart's ATR readout; saved as typed when a whole number 2 to 100 */
$('wsAtr').addEventListener('input', e => {
  const n = Number(e.target.value);
  if (String(e.target.value).trim() === '' || LP.cleanAtr(n) !== n) { e.target.setAttribute('aria-invalid', 'true'); return; }
  e.target.removeAttribute('aria-invalid');
  prefs.setSetting('atr', n);
  for (const v of chartViews()) v.pane.refreshSettings();
});
$('wsAtr').addEventListener('change', e => { e.target.removeAttribute('aria-invalid'); e.target.value = prefs.settings().atr; });
$('wsAtr').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
$('wsRoom').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]'); if (!b || !LP.ROOMS_WS.includes(+b.dataset.v)) return;
  prefs.setSetting('room', +b.dataset.v); renderGeneral();
  for (const v of chartViews()) v.pane.refreshSettings();
});
$('wsGlide').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]'); if (!b) return;
  prefs.setSetting('glide', b.dataset.v); renderGeneral();
  for (const v of chartViews()) v.pane.refreshSettings();
});
$('wsRangeMode').addEventListener('change', e => {
  if (!LP.RANGE_MODES.includes(e.target.value)) return;
  prefs.setSetting('rangeMode', e.target.value);
  for (const v of chartViews()) v.pane.refreshSettings();
});

/* Hotkeys: the single chart page's Settings, the same keys (live-hotkeys-v1). Each box reads the keys pressed in it. */
const HKKEY = LP.KEYS.hotkeys;
const readHotkeys = () => (HK = OT.cleanHotkeys(prefs.raw.get(HKKEY)));
$('wsHotkeys').innerHTML = `<div class="hk-list" role="group" aria-labelledby="wsHkCap">${OT.HOTKEY_ACTIONS.map(a => `
  <div class="hk-row" data-hk="${a.id}">
    <label class="hk-name" for="wsHk-${a.id}">${esc(a.name)}</label>
    <input class="hk-in" id="wsHk-${a.id}" data-hk="${a.id}" type="text" readonly autocomplete="off" spellcheck="false" placeholder="None" aria-describedby="wsHkNote-${a.id}">
    <button type="button" class="btn hk-clear" data-hk-clear="${a.id}" aria-label="Clear the ${esc(a.name)} hotkey">Clear</button>
    <span class="hk-note" id="wsHkNote-${a.id}" role="status"></span>
  </div>`).join('')}${W.VIEW_KEYS.map(a => `
  <div class="hk-row hk-view" data-hk="${a.id}">
    <label class="hk-name" for="wsHk-${a.id}">${esc(a.name)}</label>
    <input class="hk-in" id="wsHk-${a.id}" data-hk="${a.id}" type="text" readonly autocomplete="off" spellcheck="false" placeholder="None" aria-describedby="wsHkNote-${a.id}">
    <button type="button" class="btn hk-clear" data-hk-clear="${a.id}" aria-label="Clear the ${esc(a.name)} hotkey">Clear</button>
    <span class="hk-note" id="wsHkNote-${a.id}" role="status"></span>
  </div>`).join('')}</div>`;
const hkNote = (id, text, level) => { const el = $('wsHkNote-' + id); el.textContent = text; el.className = 'hk-note' + (level ? ' ' + level : ''); };
function renderHotkeys() {
  const HK = readHotkeys(), VK = viewKeys();
  for (const a of OT.HOTKEY_ACTIONS) $('wsHk-' + a.id).value = HK[a.id];
  for (const a of W.VIEW_KEYS) $('wsHk-' + a.id).value = VK[a.id];
  for (const v of views.values()) setMaxButton(v, maxId === v.panel.id);   // the key in the square's tooltip
}
const isViewKey = id => W.VIEW_KEYS.some(a => a.id === id);
/* a workspace hotkey (1.16.0): never a trading one (checked by the trading hotkeys' own rule, hotkeyFromEvent) */
function saveViewKey(id, combo) {
  const next = viewKeys();
  next[id] = combo;
  try { store.setItem(W.KEYS.viewKeys, JSON.stringify(next)); } catch (e) { /* blocked */ }
  if (viewKeys()[id] !== combo) { renderHotkeys(); hkNote(id, 'Not saved: this browser blocks site storage.', 'error'); return; }
  renderHotkeys();
  hkNote(id, combo ? 'Saved.' : 'Cleared.', '');
}
function saveHotkey(id, combo) {
  if (isViewKey(id)) { saveViewKey(id, combo); return; }
  const next = Object.assign({}, readHotkeys());
  if (combo) {
    const other = OT.HOTKEY_ACTIONS.find(a => a.id !== id && next[a.id] === combo);
    if (other) { renderHotkeys(); hkNote(id, combo + ' is already ' + other.name + '. Clear it there first.', 'warn'); return; }
    const view = W.VIEW_KEYS.find(a => viewKeys()[a.id] === combo);    // 1.16.0: nor the workspace's own key
    if (view) { renderHotkeys(); hkNote(id, combo + ' is already ' + view.name + '. Clear it there first.', 'warn'); return; }
  }
  next[id] = combo;
  if (!prefs.raw.set(HKKEY, next)) { renderHotkeys(); hkNote(id, 'Not saved: this browser blocks site storage.', 'error'); return; }
  renderHotkeys();
  hkNote(id, combo ? 'Saved.' : 'Cleared.', '');
}
$('wsHotkeys').addEventListener('keydown', e => {
  const id = e.target.classList && e.target.classList.contains('hk-in') ? e.target.dataset.hk : '';
  if (!id) return;
  /* the capture box: every key press is read as a hotkey, never typed and never acted on (plain Tab still moves on) */
  const tab = e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey;
  if (!tab) { e.preventDefault(); e.stopPropagation(); }
  if (e.repeat) return;
  const r = OT.hotkeyFromEvent(e, readHotkeys(), id);
  if (r.error) { hkNote(id, r.error, r.held ? '' : 'warn'); return; }
  saveHotkey(id, r.combo);
});
$('wsHotkeys').addEventListener('click', e => { const b = e.target.closest('button[data-hk-clear]'); if (b) saveHotkey(b.dataset.hkClear, ''); });

$('wsPin').addEventListener('click', () => { closePops(); if (PIN) PIN.openChange(); });

function renderSettings() {
  renderGeneral(); renderHotkeys();
  for (const a of OT.HOTKEY_ACTIONS) hkNote(a.id, '', '');
  $('wsFloors').innerHTML = W.ROOTS.map(floorRow).join('');
  $('wsPinSec').hidden = !(PIN && PIN.active());
  $('wsResetName').textContent = layout;
  $('wsVersion').textContent = versionText() + '. Layouts and settings are kept in this browser.';
}
$('wsSet').addEventListener('click', e => toggle($('wsSettings'), e.currentTarget, () => { renderSettings(); openPop($('wsSettings'), e.currentTarget); }));
$('wsReset').addEventListener('click', () => { closePops(); confirmBox('Reset "' + layout + '" to the default layout? Its panels close and the default ones open.', 'Reset', () => {
  W.saveLayout(store, layout, seedMainIndicators(W.defaultLayout())); openLayout(layout);
}); });

/* ---------------- Colors in the top bar: one chart's Colors panel (it changes the colors every chart uses; the others
   follow at once, onColors). When that chart closes, the next one's takes its place. */
let colorsOwner = null;
function placeColors() {
  if (colorsOwner && views.get(colorsOwner.panel.id) === colorsOwner && colorsOwner.pane.colors.isConnected) return;
  colorsOwner = chartViews()[0] || null;
  if (colorsOwner) $('wsColors').appendChild(colorsOwner.pane.colors);
}

/* ---------------- layouts: the select, New layout..., Rename, Delete */
function names() { return Object.keys(W.readStore(store).layouts); }
function syncSelect() {
  const sel = $('wsLayout'), list = names();
  if (!list.includes(layout)) list.push(layout);
  sel.innerHTML = list.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('') +
    '<option disabled>──────</option><option value="\u0001new">New layout...</option><option value="\u0001rename">Rename</option><option value="\u0001delete">Delete</option>';
  sel.value = layout;
}
$('wsLayout').addEventListener('change', e => {
  const v = e.target.value;
  e.target.value = layout;
  // 1.16.0 (Anthony): a new layout starts with no panels (Add panel fills it); Reset still gives the default one
  if (v === '\u0001new') askName('New layout', '', name => {
    if (names().includes(name)) return 'A layout with that name exists';
    if (!W.saveLayout(store, name, { panels: [] })) return 'Could not save it in this browser';
    openLayout(name); return '';
  });
  else if (v === '\u0001rename') askName('Rename "' + layout + '"', layout, name => {
    if (name === layout) return '';
    if (names().includes(name)) return 'A layout with that name exists';
    save();
    if (!W.renameLayout(store, layout, name)) return 'Could not rename it';
    layout = name; setUrl(); syncSelect(); return '';
  });
  else if (v === '\u0001delete') confirmBox('Delete the layout "' + layout + '"? This window then opens ' + (names().filter(n => n !== layout)[0] || W.DEFAULT_NAME) + '.', 'Delete', () => {
    W.deleteLayout(store, layout);
    openLayout(names()[0] || W.DEFAULT_NAME);
  });
  else if (v && v !== layout) { save(); openLayout(v); }
});
/* ---------------- the laptop preset (1.16.0, Anthony): this browser shows two layout tabs, Main and Second, in the top bar,
   with tight margins (2 px between panels); both start blank and Anthony arranges them. Kept in this browser
   (live-ws-laptop-v1); the layout list still works. */
const laptopOn = () => { try { return JSON.parse(store.getItem(W.KEYS.laptop)) === true; } catch (e) { return false; } };
const gridGap = () => (laptopOn() ? W.GAP_TIGHT : W.GAP);
function syncLaptop() {
  const on = laptopOn(), tabs = $('wsTabs');
  document.body.classList.toggle('ws-tight', on);
  tabs.hidden = !on;
  if (on) {
    const html = W.LAPTOP_TABS.map(n => `<button type="button" role="tab" class="ws-tab" data-tab="${esc(n)}" aria-selected="${n === layout}">${esc(n)}</button>`).join('');
    if (tabs.dataset.html !== html) { tabs.dataset.html = html; tabs.innerHTML = html; }
  }
  $('wsLaptop').textContent = on ? 'Laptop tabs: on (turn off)' : 'Laptop: two blank tabs, Main and Second';
}
$('wsTabs').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]');
  if (b && botDesk && botDesk.shown()) botDesk.showTab(false);   // 1.16.0: from the Bot tab back to a layout
  if (!b || b.dataset.tab === layout) return;
  save(); openLayout(b.dataset.tab);
});
$('wsLaptop').addEventListener('click', () => {
  closePops();
  if (laptopOn()) { try { store.setItem(W.KEYS.laptop, 'false'); } catch (e) { /* blocked */ } syncLaptop(); return; }
  const used = W.LAPTOP_TABS.filter(n => { const l = W.readStore(store).layouts[n]; return l && l.panels.length; });
  confirmBox('Make this browser a laptop: two layout tabs, ' + W.LAPTOP_TABS.join(' and ') + ', both blank, with tight margins. ' +
    (used.length ? used.join(' and ') + ' lose' + (used.length > 1 ? '' : 's') + ' ' + (used.length > 1 ? 'their' : 'its') + ' panels in this browser. ' : '') + 'Arrange them with Add panel.', 'Make the tabs', () => {
    for (const n of W.LAPTOP_TABS) W.saveLayout(store, n, { panels: [] });
    try { store.setItem(W.KEYS.laptop, 'true'); } catch (e) { /* blocked */ }
    openLayout(W.LAPTOP_TABS[0]);
  });
});

function setUrl() {
  const u = new URL(location.href);
  u.searchParams.set('layout', layout);
  history.replaceState(null, '', u.pathname + '?' + u.searchParams.toString() + u.hash);
  syncTitle(); syncLaptop();
}

/* A small dialog for a name, and one to confirm. */
function askName(title, value, done) {
  const d = $('wsDialog');
  d.innerHTML = `<form class="ws-dlg" method="dialog"><h2>${esc(title)}</h2><label for="wsName">Layout name</label>` +
    `<input id="wsName" type="text" maxlength="${W.NAME_MAX}" autocomplete="off" spellcheck="false" value="${esc(value)}"><p class="ws-err" id="wsNameErr" role="alert"></p>` +
    '<div class="ws-dlg-btns"><button type="button" class="ws-btn" data-act="cancel">Cancel</button><button type="submit" class="ws-btn primary">Save</button></div></form>';
  showDialog(d, () => {
    const name = W.layoutName($('wsName').value);
    const err = name ? done(name) : 'Type a name (letters, numbers, spaces)';
    if (err) { $('wsNameErr').textContent = err; return false; }
    return true;
  });
  const i = $('wsName'); i.focus(); i.select();
}
/* The NO STOP question (1.13.0; F2 review): a strip under the top bar in the page's flow, never modal, so the ticket's
   Close, the top bar's Flatten all and the hotkeys work while it is open (they close it: dropNoStop, its order not
   sent). Cancel has the focus, so Enter never sends an order with no stop; Escape is Cancel. One question at a time:
   a newer one replaces it (the older order is not sent). */
/* it sits over the top bar from the left up to KEYS, so KEYS, Flatten all and the right side stay usable */
/* 1.14.0 (coordinator, layout only): from just after the connection status (which stays in view) up to KEYS */
function placeNoStop() {
  const top = document.querySelector('.ws-top').getBoundingClientRect(), k = $('wsKeys').getBoundingClientRect(), c = $('wsConn').getBoundingClientRect();
  $('wsNoStop').style.setProperty('--ns-right', Math.max(8, Math.round(top.right - k.left + 8)) + 'px');
  $('wsNoStop').style.setProperty('--ns-left', Math.max(8, Math.round(c.right - top.left + 12)) + 'px');
  /* one line, never cut (review D2): the whole text when it fits, else a shorter one, then the shorter title too; the
     whole text stays in the tooltip, Cancel and Send always in view */
  const full = $('wsNoStop').dataset.text || '', t = $('wsNoStopText'), b = $('wsNoStopTitle');
  const m = /^The (\S+) order has no stop/.exec(full);
  const first = full.split('. ')[0].replace(/\.?$/, '.');
  const tries = [[full, 'No stop: send anyway?'], [first, 'No stop: send anyway?'], [m ? m[0] + '.' : first, 'No stop: send anyway?'], [m ? m[1] + ': no stop.' : 'No stop.', 'No stop: send anyway?'], [m ? m[1] + ': no stop.' : '', 'No stop: send?'], ['', 'No stop: send?']];
  for (const [txt, ttl] of tries) { t.textContent = txt; t.hidden = !txt; b.textContent = ttl; if (t.scrollWidth <= t.clientWidth + 1 && b.scrollWidth <= b.clientWidth + 1 && $('wsNoStop').scrollWidth <= $('wsNoStop').clientWidth + 1) break; }
}
window.addEventListener('resize', () => { if (noStopQ) placeNoStop(); });
function askNoStop(text, onSend, onCancel, bound) {
  noStopQ = Object.assign({ onSend, onCancel }, bound || {});
  $('wsNoStopText').textContent = text; $('wsNoStop').dataset.text = text; $('wsNoStop').title = 'No stop: send anyway? ' + text;
  $('wsNoStop').hidden = false;
  placeNoStop();
  $('wsNoStopCancel').focus();
}
/* A Close or Flatten (r) or Flatten all (null) in any window: every window drops its question for it, and the ticket's
   window refuses an answer given before it (F2 re-review). Flatten itself never waits on this. */
const flatChan = TL.browserChannel('chartbridge-noflat-v1');
function flattenedHere(r) {
  const at = Date.now();
  noteFlat(r, at);
  try { if (flatChan) flatChan.post({ t: 'flat', root: r || null, at }); } catch (e) { /* closed */ }
}
if (flatChan) flatChan.onmessage = m => {
  if (!m || m.t !== 'flat' || !isFinite(m.at)) return;
  noteFlat(m.root || null, +m.at);
  if (noStopQ && (!m.root || !noStopQ.root || m.root === noStopQ.root)) dropNoStop();
};
function closeNoStopQ(how) {
  const q = noStopQ; noStopQ = null;
  if (document.activeElement && $('wsNoStop').contains(document.activeElement)) document.activeElement.blur();
  $('wsNoStop').hidden = true;
  if (q && how === 'send') q.onSend(); else if (q && how === 'cancel' && q.onCancel) q.onCancel();
}
function dropNoStop() { if (noStopQ || !$('wsNoStop').hidden) closeNoStopQ('drop'); }
$('wsNoStopSend').addEventListener('click', () => closeNoStopQ('send'));
$('wsNoStopCancel').addEventListener('click', () => closeNoStopQ('cancel'));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('wsNoStop').hidden) { e.preventDefault(); closeNoStopQ('cancel'); } });
function confirmBox(text, label, done, cancel) {
  const d = $('wsDialog');
  d.innerHTML = `<form class="ws-dlg" method="dialog"><p>${esc(text)}</p><div class="ws-dlg-btns"><button type="button" class="ws-btn" data-act="cancel">Cancel</button>` +
    `<button type="submit" class="ws-btn primary">${esc(label)}</button></div></form>`;
  showDialog(d, () => { done(); return true; }, cancel);
  d.querySelector('[type="submit"]').focus();
}
function showDialog(d, onOk, onCancel) {
  closePops();
  const form = d.querySelector('form');
  let ok = false;
  form.addEventListener('submit', e => { e.preventDefault(); if (onOk()) { ok = true; d.close(); } });
  form.querySelector('[data-act="cancel"]').addEventListener('click', () => d.close());
  d.addEventListener('close', () => { if (!ok && onCancel) onCancel(); }, { once: true });
  if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
}

/* ---------------- open a layout (from the URL, the select, New, Delete, Reset) */
function teardown() {
  closePops();
  if (core.TR.armed) core.setArmed(false);                 // the ticket is built again: Armed off
  for (const v of views.values()) { v.destroy(); if (sizes) sizes.unobserve(v.el); v.el.remove(); }
  views.clear(); panels = []; colorsOwner = null; TK.el = null; TK.bar = null; TK.view = null;
  maxId = null; grid.classList.remove('ws-maxed'); dbChart = null;
}
function openLayout(name) {
  teardown();
  layout = W.layoutName(name) || W.DEFAULT_NAME;
  const s = W.readStore(store);
  if (!Object.prototype.hasOwnProperty.call(s.layouts, layout)) W.saveLayout(store, layout, seedMainIndicators(W.defaultLayout()));
  const got = W.readStore(store).layouts[layout];
  panels = (got || W.cleanLayout(W.defaultLayout())).panels;
  for (const p of panels) addView(p);
  setUrl(); syncSelect(); syncConn(); placeColors(); syncAddMenu();
  if (holds() && !panels.some(p => p.type === 'ticket')) releaseTicket();   // a layout without the ticket lets it go
  renderOrders();
  if (botDesk) { botDesk.layoutChanged(layout); botDesk.chartsChanged(); }   // 1.16.0: the strip on Main only; ghost marks
}

/* Another window or the single chart page changed something this page uses. Its open layouts stay its own. */
window.addEventListener('storage', e => {
  const k = e.key === null ? null : e.key.slice(PREFIX.length);
  if (k === null) return;
  if (k === W.KEYS.store) syncSelect();
  else if (k === W.KEYS.floors) { readFloorsNow(); refloorTapes(); }
  else if (k === W.KEYS.tapeColors) { tapeColors = W.readTapeColors(store); applyTapeColors(); if (pop && pop.el === $('wsGear')) renderTapeColors(); }
  else if (k === LP.KEYS.settings) { for (const v of chartViews()) v.pane.refreshSettings(); if (pop && pop.el === $('wsSettings')) renderGeneral(); }
  else if (k === LP.KEYS.colors || k === LP.KEYS.indicatorColors) { for (const v of chartViews()) v.pane.refreshColors(); }
  else if (k === HKKEY || k === W.KEYS.viewKeys) { readHotkeys(); if (pop && pop.el === $('wsSettings')) renderHotkeys(); }
  else if (k === W.KEYS.laptop) syncLaptop();
  else if (k === LP.KEYS.bracketPresets && TK.bar) { core.readPresets(); TK.bar.render(); }
  else if (k === TICKET_KEY && !holds()) { const r = readTicket().root; if (W.ROOTS.includes(r)) TK.root = r; renderOrders(); }
  else if (k === 'live-account-v1' && !holds() && !holder()) { noTicketAccount(); renderOrders(); }
});
window.addEventListener('pagehide', () => { if (layout) save(); });

/* for tests and the console (read only) */
window.workspace = { get layout() { return layout; }, panels: () => panels.map(p => Object.assign({}, p)),
  views: () => [...views.values()].map(v => ({ id: v.panel.id, type: v.panel.type, state: v.state, count: v.tape ? v.tape.count() : null })),
  feed: () => hub.stats(),
  /* 1.12.0: the ticket as this window knows it, and a chart's engine (read it; orders still go through the checks) */
  ticket: () => ({ held: holds(), holder: holder(), root: ticketRoot(), account: ticketAccount(), armed: ticketArmed(), enabled: core.TR.enabled, wid: link ? link.wid : '' }),
  chart: id => { const v = views.get(id); return v && v.pane ? v.pane.chart : null; },
  /* 1.16.0: the Bot tab (read it; its actions go through ChartBridge's checks) */
  bot: () => (botDesk ? botDesk.state() : null),
  /* the Bot tab's entrance played again (test/perf-bot.mjs: the motion kit running while the live chart draws) */
  botReplay: () => !!(botDesk && botDesk.replay()) };

/* 1.16.0: the Bot tab, the bot strip and the bot's pop-ups (live/bot.js), on a connection of their own; everything bot shows
   only when ChartBridge's bot switch is on. The Bot tab hides the grid while it is open (?tab=bot keeps it on a reload). */
let botDesk = null;
function startBot() {
  if (!window.BotDesk) return;
  botDesk = window.BotDesk.create({ wsUrl, headers: () => (PIN ? PIN.headers() : {}), feed: hub, storage: store, storagePrefix: PREFIX,
    els: { tab: $('wsBotTab'), view: $('btView'), strip: $('btStrip') }, tradingKeys: () => HK,
    charts: () => chartViews().map(v => ({ id: v.panel.id, root: v.panel.root, chart: v.pane.chart })),
    onTab: on => {
      document.body.classList.toggle('bt-on', on);
      if (on) { closePops(); restoreMax(); }
      const u = new URL(location.href);
      if (on) u.searchParams.set('tab', 'bot'); else u.searchParams.delete('tab');
      history.replaceState(null, '', u.pathname + '?' + u.searchParams.toString() + u.hash);
    } });
}
const start = () => {
  startBot();
  openLayout(new URLSearchParams(location.search).get('layout') || W.DEFAULT_NAME); tconnect(); autoTake();
  if (botDesk && new URLSearchParams(location.search).get('tab') === 'bot') botDesk.showTab(true);
};
/* A window that opens (or reloads) with the ticket in its layout takes it when no other window has it (Anthony
   2026-10-01), Armed off. The same `ifAvailable` lock as any take: two windows opening at once give one holder, and a
   window that finds another holding it never asks, it shows "Ticket is in the other window". */
function autoTake() {
  if (!link || !locks || holds() || !panels.some(p => p.type === 'ticket')) return;
  link.take().then(r => { if (r === 'held') { TK.published = ''; linkChanged(); } });
}
if (PIN) PIN.gate().then(start); else start();
});
