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
 *   live-tape-floors-v1   { <root>: { rth, eth } } the large-print floors (Time and Sales), only those set by hand
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
const TFS = ['s15', 's30', 'm1', 'm5', 'm15', 'h1', 'range'];
const RANGE_MIN = 1, RANGE_MAX = 400;
const KEYS = { store: 'live-workspace-v1', floors: 'live-tape-floors-v1' };
const DEFAULT_NAME = 'Main';
/* Large prints on the tape: RTH 09:30 to 16:15 ET, overnight the rest (Anthony, 2026-10-01). */
const RTH_START = 9 * 3600 + 30 * 60, RTH_END = 16 * 3600 + 15 * 60;
const DEFAULT_FLOORS = { NQ: { rth: 50, eth: 25 }, ES: { rth: 100, eth: 50 }, MNQ: { rth: 100, eth: 50 }, MES: { rth: 100, eth: 50 } };
const FLOOR_MAX = 100000;
const TF_LABEL = { s15: '15 sec', s30: '30 sec', m1: '1 min', m5: '5 min', m15: '15 min', h1: '1 hour', range: 'Range' };

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

const TYPES = ['chart', 'tape', 'ticket'];
/** One panel, or null when its shape is bad. Position and size are whole cells; re-flow puts them inside the grid. */
function cleanPanel(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (!TYPES.includes(p.type)) return null;
  if (typeof p.id !== 'string' || !ID_RX.test(p.id)) return null;
  if (p.type !== 'ticket' && !ROOTS.includes(p.root)) return null;
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

/* ---------------- layouts */
let idSeq = 0;
/** A new panel id (also the chart's paneId): stable once saved. */
function newId() { return 'p' + Date.now().toString(36) + (++idSeq).toString(36) + Math.random().toString(36).slice(2, 6); }
/**
 * The default layout (Anthony, 2026-10-01: the mockup's, with the order ticket in place of the execution chart): MNQ
 * Range 40 top left (cols 1 to 7, rows 1 to 4), MNQ under it (cols 1 to 7, rows 5 to 6; 1 hour bars until ChartBridge
 * 0.3.7 brings daily bars), NQ 5 min and ES 1 min stacked in the middle (cols 8 to 10), the order ticket top right
 * (cols 11 to 12, rows 1 to 2) and Time and Sales under it (cols 11 to 12, rows 3 to 6). The first chart starts with the
 * single chart page's indicators (the page's main pane defaults); every other new chart with none.
 */
function defaultLayout(makeId = newId) {
  return { panels: [
    { id: makeId(), type: 'chart', root: 'MNQ', tf: 'range', range: 40, x: 0, y: 0, w: 7, h: 4 },
    { id: makeId(), type: 'chart', root: 'MNQ', tf: 'h1', x: 0, y: 4, w: 7, h: 2 },
    { id: makeId(), type: 'chart', root: 'NQ', tf: 'm5', x: 7, y: 0, w: 3, h: 3 },
    { id: makeId(), type: 'chart', root: 'ES', tf: 'm1', x: 7, y: 3, w: 3, h: 3 },
    { id: makeId(), type: 'ticket', x: 10, y: 0, w: 2, h: 2 },
    { id: makeId(), type: 'tape', root: 'MNQ', x: 10, y: 2, w: 2, h: 4 },
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
  layoutName, parseRange, cleanPanel, cleanLayout, cleanStore, overlaps, fits, largestFree, findSpot, reflow, metrics, snapMove, snapResize,
  isRth, cleanFloors, floorAt, fmtClock, fmtPrice, decimalsOf, tfLabel, newId, defaultLayout,
  readStore, saveLayout, deleteLayout, renameLayout, readFloors, setFloor };
});




/* ======================================================================== the page (browser only) */
if (typeof document !== 'undefined' && typeof window !== 'undefined' && window.ChartLive && window.ChartFeed) (() => {
'use strict';
const W = window.WorkspaceCore, LP = window.LivePrefs, OT = window.OrderTicket, PIN = window.ChartBridgePin || null;
const PREFIX = '';                                 // the single chart page's prefix (none): its settings are this page's
const TAPE_MAX = 500, TAPE_ROW = 18;
const TF_SHORT = { s15: '15s', s30: '30s', m1: '1m', m5: '5m', m15: '15m', h1: '1h', range: 'Range' };
const H1_NOTE = 'The longest bars ChartBridge sends today. Daily bars come with ChartBridge 0.3.7.';

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
let floors = W.readFloors(store);

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
}
let noteTimer = 0;
function note(text, warn) {
  const el = $('wsNote');
  el.textContent = text; el.className = 'ws-note' + (warn ? ' warn' : ''); el.hidden = !text;
  clearTimeout(noteTimer);
  if (text) noteTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

/* One status line for the window (the charts' own are not shown here): the worst feed and local delay over the
   instruments (each one's in the tooltip) and the charts' frame rate, every second. */
function fmtDelay(v) { return v === null || v === undefined ? '-' : (v < 1 && v >= 0 ? '<1' : Math.round(v)) + ' ms' + (v < 0 ? ' (PC clock behind)' : ''); }
function syncStats() {
  const per = new Map();
  let fps = 0, busy = false;
  for (const v of chartViews()) {
    const s = v.pane.stats();
    if (s.chart && !s.chart.idle) { busy = true; fps = Math.max(fps, s.chart.fps || 0); }
    if (!s.root) continue;
    const r = per.get(s.root) || { feed: null, local: null };
    if (s.feed !== null && (r.feed === null || s.feed > r.feed)) r.feed = s.feed;
    if (s.local !== null && (r.local === null || s.local > r.local)) r.local = s.local;
    per.set(s.root, r);
  }
  let feed = null, local = null, worst = '';
  for (const [root, r] of per) {
    if (r.feed !== null && (feed === null || r.feed > feed)) { feed = r.feed; worst = root; }
    if (r.local !== null && (local === null || r.local > local)) local = r.local;
  }
  $('wsFeed').textContent = fmtDelay(feed) + (feed !== null && per.size > 1 ? ' ' + worst : '');
  $('wsLocal').textContent = fmtDelay(local);
  $('wsFps').textContent = !chartViews().length ? '-' : busy ? Math.round(fps) + ' fps' : 'idle';
  $('wsStat').title = 'Feed delay (ChartBridge to here) and local delay per instrument, the worst shown:\n' +
    ([...per].map(([root, r]) => root + ': feed ' + fmtDelay(r.feed) + ', local ' + fmtDelay(r.local)).join('\n') || 'no data yet');
}
setInterval(syncStats, 1000);

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

/* The slim header (Anthony, 2026-10-01): the handle, instrument and bars (a click changes them), the chart's own
   Indicators button, a small menu with the drawing tools and Reset view, and the x. */
function headChart(v) {
  const p = v.panel;
  v.nameEl.textContent = v.contract && v.contract.split(' ')[0] === p.root ? v.contract : p.root;
  v.tfEl.textContent = W.tfLabel(p.tf, p.tf === 'range' ? p.range : 0);
  v.viewBtn.title = 'Instrument and bars' + (p.tf === 'h1' ? '. ' + H1_NOTE : '');
  v.viewBtn.setAttribute('aria-label', 'Instrument and bars: ' + p.root + ', ' + W.tfLabel(p.tf, p.tf === 'range' ? p.range : 0));
}

function addView(p) {
  const el = document.createElement('section');
  el.className = 'ws-panel ' + p.type;
  el.dataset.id = p.id; el.dataset.type = p.type;
  const close = '<button type="button" class="ws-x" data-act="close" aria-label="Close panel" title="Close panel">✕</button>';
  let mid = '';
  if (p.type === 'chart') {
    mid = '<button type="button" class="ws-view" data-act="view" aria-haspopup="dialog" aria-expanded="false"><span class="ws-name"></span><span class="ws-tf"></span><span class="ws-caret" aria-hidden="true"></span></button>' +
      '<span class="chart-live ws-lv ws-ind"></span>' +
      '<button type="button" class="ws-ic ws-more" data-act="more" aria-haspopup="menu" aria-expanded="false" aria-label="Drawing tools and Reset view" title="Drawing tools, Reset view">⋯</button>';
  } else if (p.type === 'tape') {
    mid = '<span class="ws-name">Time and Sales</span><select class="ws-sel" data-act="root" aria-label="Time and Sales instrument">' +
      W.ROOTS.map(r => `<option value="${r}">${r}</option>`).join('') + '</select><span class="ws-fill"></span>' +
      '<button type="button" class="ws-ic" data-act="gear" aria-label="Large prints" title="Large prints" aria-expanded="false">⚙</button>';
  } else mid = '<span class="ws-name">Order ticket</span><span class="ws-fill"></span>';
  el.innerHTML = `<header class="ws-head"><span class="ws-grip" aria-hidden="true">⋮⋮</span>${mid}${close}</header>` +
    '<div class="ws-body"></div><div class="ws-size" aria-hidden="true" title="Resize"></div>';
  place(el, p);
  grid.appendChild(el);
  if (sizes) sizes.observe(el);
  const v = { panel: p, el, head: el.querySelector('.ws-head'), body: el.querySelector('.ws-body'), state: null, destroy: () => {} };
  views.set(p.id, v);
  if (p.type === 'chart') mountChart(v);
  else if (p.type === 'tape') mountTape(v);
  else v.body.innerHTML = '<div class="tk-hold" role="note"><b>Order ticket: next build</b><span>Every chart here is read only until then. Trade from the single chart page (/single.html).</span></div>';
  // the handle is the whole header, except its buttons and the chart's Indicators menu
  v.head.addEventListener('pointerdown', e => { if (!e.target.closest('button, select, input, .ws-lv')) startDrag(e, v, 'move'); });
  el.querySelector('.ws-size').addEventListener('pointerdown', e => startDrag(e, v, 'size'));
  v.head.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b || !v.head.contains(b) || b.closest('.ws-lv')) return;
    if (b.dataset.act === 'close') closePanel(p.id);
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
    feed: hub, paneId: p.id, storagePrefix: PREFIX, toolbar: false, compact: true,
    view: { root: p.root, tf: p.tf, range: p.tf === 'range' ? p.range : undefined },
    onView: nv => viewChanged(v, nv),
    onColors: () => { for (const o of chartViews()) if (o !== v) o.pane.refreshColors(); },
    onStatus: s => {
      v.state = s.state; syncConn();
      if (s.state === 'live' && v.pane) { const n = v.pane.element.querySelector('[id$="lgName"]'); v.contract = n ? n.textContent : ''; headChart(v); }
    },
  });
  v.pane = pane;
  v.head.querySelector('.ws-ind').append(pane.indicators, pane.chips);   // the chart's own Indicators button and menu, its chips
  const indBtn = pane.indicators.querySelector('.ind-btn');
  const mo = typeof MutationObserver === 'function' && indBtn ? new MutationObserver(() => raise(v.el, indBtn.getAttribute('aria-expanded') === 'true')) : null;
  if (mo) mo.observe(indBtn, { attributes: true, attributeFilter: ['aria-expanded'] });
  v.destroy = () => { if (mo) mo.disconnect(); pane.destroy(); pane.indicators.remove(); pane.chips.remove(); };
}
function viewChanged(v, nv) {
  const p = v.panel;
  if (nv.root !== p.root) v.contract = '';
  p.root = nv.root; p.tf = nv.tf;
  if (nv.tf === 'range') p.range = nv.range; else delete p.range;
  headChart(v); save();
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
  v.destroy(); if (sizes) sizes.unobserve(v.el); v.el.remove(); views.delete(id);
  panels = panels.filter(p => p.id !== id);
  save(); syncConn(); placeColors(); syncAddMenu();
}

function addPanel(type) {
  closePops();
  if (panels.length >= W.MAX_PANELS) { note('At most ' + W.MAX_PANELS + ' panels: close one first', true); return; }
  if (type === 'ticket' && panels.some(q => q.type === 'ticket')) { note('This layout has its order ticket already', true); return; }
  const r = W.largestFree(panels);
  if (!r) { note('No free space: close or shrink a panel', true); return; }
  const base = type === 'tape' ? { type: 'tape', root: 'MNQ' } : type === 'ticket' ? { type: 'ticket' } : { type: 'chart', root: 'MNQ', tf: 'm1' };
  const p = Object.assign({ id: W.newId() }, base, r);
  panels.push(p);
  addView(p);
  save(); syncConn(); placeColors(); syncAddMenu();
}

/* ---------------- drag and resize: the ghost shows the snapped cells; a place that overlaps is refused */
let dragging = null;
function startDrag(e, v, mode) {
  if (e.button !== 0 || dragging) return;
  e.preventDefault();
  closePops();
  const p = v.panel, m = W.metrics(grid.clientWidth, grid.clientHeight), sx = e.clientX, sy = e.clientY;
  const target = e.currentTarget;
  try { target.setPointerCapture(e.pointerId); } catch (err) { /* fine without */ }
  let r = { x: p.x, y: p.y, w: p.w, h: p.h }, ok = true;
  dragging = { v, mode };
  place(ghost, r); ghost.hidden = false; ghost.className = 'ws-ghost';
  v.el.classList.add(mode === 'move' ? 'dragging' : 'sizing');
  document.body.classList.add('ws-busy');
  const move = ev => {
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    r = mode === 'move' ? W.snapMove(p, dx, dy, m) : W.snapResize(p, dx, dy, m);
    ok = W.fits(r, panels, p.id);
    place(ghost, r);
    ghost.className = 'ws-ghost' + (ok ? '' : ' blocked');
    if (mode === 'move') v.el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
  };
  const end = ev => {
    target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', end); target.removeEventListener('pointercancel', end);
    v.el.style.transform = ''; v.el.classList.remove('dragging', 'sizing'); document.body.classList.remove('ws-busy');
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
  const T = new Float64Array(TAPE_MAX), P = new Float64Array(TAPE_MAX), V = new Float64Array(TAPE_MAX), S = new Int8Array(TAPE_MAX), B = new Uint8Array(TAPE_MAX);
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
    const cls = 'tp-row' + (S[j] > 0 ? ' buy' : S[j] < 0 ? ' sell' : '') + (B[j] ? ' big' : '');
    if (row.cls !== cls) { row.el.className = cls; row.cls = cls; }
    row.t.textContent = W.fmtClock(T[j]); row.p.textContent = W.fmtPrice(P[j], dec); row.v.textContent = String(V[j]);
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
    B[head] = v2 >= W.floorAt(root, t, floors) ? 1 : 0;
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
  function later() { if (destroyed) return; tries++; reconnect = setTimeout(connect, Math.min(5000, 500 * tries)); }

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
  v.tape = { get root() { return root; }, count: () => count, refloor: () => { for (let i = 0; i < count; i++) { const j = (head - i + TAPE_MAX) % TAPE_MAX; B[j] = V[j] >= W.floorAt(root, T[j], floors) ? 1 : 0; } full = true; schedule(); } };
  v.destroy = () => {
    destroyed = true; clearTimeout(reconnect); if (raf) cancelAnimationFrame(raf); raf = 0;
    if (ro) ro.disconnect();
    if (ws) { const s = ws; ws = null; s.onopen = s.onmessage = s.onclose = null; try { s.close(); } catch (e) { /* closed */ } }
  };
}
function refloorTapes() { for (const v of views.values()) if (v.tape) v.tape.refloor(); }

/* ---------------- popovers (Add panel, Settings, a chart's instrument and bars or its menu, a tape's gear): one open at a
   time; an outside click or Esc closes */
let pop = null;
function openPop(el, anchor, onClose, align) {
  closePops();
  el.hidden = false;
  if (anchor) {
    anchor.setAttribute('aria-expanded', 'true'); raise(anchor, true);
    const a = anchor.getBoundingClientRect(), w = el.offsetWidth;
    el.style.top = Math.round(a.bottom + 6) + 'px';
    const x = align === 'left' ? a.left : a.right - w;
    el.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, x))) + 'px';
    el.style.maxHeight = Math.max(160, Math.floor(window.innerHeight - a.bottom - 14)) + 'px';
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
      '<div class="vw-row" role="group" aria-label="Bars">' + W.TFS.map(t => `<button type="button" data-tf="${t}" aria-pressed="${t === p.tf}"${t === 'h1' ? ' title="' + esc(H1_NOTE) + '"' : ''}>${TF_SHORT[t]}</button>`).join('') + '</div>' +
      (p.tf === 'range' ? `<label class="vw-range"><span>Range size</span><input type="number" min="1" max="400" step="1" inputmode="numeric" data-f="range" value="${p.range || ''}" aria-label="Range bar size for ${p.root} in ticks"><span>ticks</span></label>` : '') +
      (p.tf === 'h1' ? `<p class="ws-help">${esc(H1_NOTE)}</p>` : '');
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

/* A chart's small menu: the drawing tools (they act on the next clicks on that chart), Clear and Reset view. */
function openMore(v, anchor) {
  toggle($('wsMore'), anchor, () => {
    const el = $('wsMore'), t = v.pane.chart.getTool();
    el.dataset.id = v.panel.id;
    for (const b of el.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(t === b.dataset.tool));
    openPop(el, anchor);
  });
}
$('wsMore').addEventListener('click', e => {
  const b = e.target.closest('button'), v = views.get($('wsMore').dataset.id);
  if (!b || !v || !v.pane) return;
  const c = v.pane.chart;
  if (b.dataset.tool) c.setTool(c.getTool() === b.dataset.tool ? null : b.dataset.tool);
  else if (b.dataset.do === 'clear') c.clearDrawings();
  else if (b.dataset.do === 'reset') c.reset();
  closePops();
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
  if (W.setFloor(store, i.dataset.root, i.dataset.w, i.value)) { floors = W.readFloors(store); refloorTapes(); i.classList.remove('bad'); }
  else i.classList.add('bad');
}
function onFloorBlur(e) { const i = e.target.closest('input[data-w]'); if (i) { i.value = floors[i.dataset.root][i.dataset.w]; i.classList.remove('bad'); } }
for (const el of [$('wsSettings'), $('wsGear')]) { el.addEventListener('input', onFloorInput); el.addEventListener('focusout', onFloorBlur); }

function openTapeGear(v, anchor) {
  toggle($('wsGear'), anchor, () => { $('wsGearBody').innerHTML = floorRow(v.tape.root); openPop($('wsGear'), anchor); });
}

/* ---------------- Settings: everything general (Anthony): Glide and Range style for every chart (and the single chart
   page), the trading hotkeys (the 1.11.0 Settings), the large-print floors, ChartBridge's PIN, the layout. */
function renderGeneral() {
  const s = prefs.settings();
  for (const b of $('wsGlide').children) b.setAttribute('aria-pressed', String(b.dataset.v === s.glide));
  $('wsRangeMode').value = s.rangeMode;
}
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
const readHotkeys = () => OT.cleanHotkeys(prefs.raw.get(HKKEY));
$('wsHotkeys').innerHTML = `<div class="hk-list" role="group" aria-labelledby="wsHkCap">${OT.HOTKEY_ACTIONS.map(a => `
  <div class="hk-row" data-hk="${a.id}">
    <label class="hk-name" for="wsHk-${a.id}">${esc(a.name)}</label>
    <input class="hk-in" id="wsHk-${a.id}" data-hk="${a.id}" type="text" readonly autocomplete="off" spellcheck="false" placeholder="None" aria-describedby="wsHkNote-${a.id}">
    <button type="button" class="btn hk-clear" data-hk-clear="${a.id}" aria-label="Clear the ${esc(a.name)} hotkey">Clear</button>
    <span class="hk-note" id="wsHkNote-${a.id}" role="status"></span>
  </div>`).join('')}</div>`;
const hkNote = (id, text, level) => { const el = $('wsHkNote-' + id); el.textContent = text; el.className = 'hk-note' + (level ? ' ' + level : ''); };
function renderHotkeys() { const HK = readHotkeys(); for (const a of OT.HOTKEY_ACTIONS) $('wsHk-' + a.id).value = HK[a.id]; }
function saveHotkey(id, combo) {
  const next = Object.assign({}, readHotkeys());
  if (combo) {
    const other = OT.HOTKEY_ACTIONS.find(a => a.id !== id && next[a.id] === combo);
    if (other) { renderHotkeys(); hkNote(id, combo + ' is already ' + other.name + '. Clear it there first.', 'warn'); return; }
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
  $('wsVersion').textContent = 'Chart ' + (window.ChartEngine ? window.ChartEngine.VERSION : '') + ' · Layouts and settings are kept in this browser.';
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
  if (v === '\u0001new') askName('New layout', '', name => {
    if (names().includes(name)) return 'A layout with that name exists';
    if (!W.saveLayout(store, name, seedMainIndicators(W.defaultLayout()))) return 'Could not save it in this browser';
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
function setUrl() {
  const u = new URL(location.href);
  u.searchParams.set('layout', layout);
  history.replaceState(null, '', u.pathname + '?' + u.searchParams.toString() + u.hash);
  document.title = layout + ' · Workspace';
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
function confirmBox(text, label, done) {
  const d = $('wsDialog');
  d.innerHTML = `<form class="ws-dlg" method="dialog"><p>${esc(text)}</p><div class="ws-dlg-btns"><button type="button" class="ws-btn" data-act="cancel">Cancel</button>` +
    `<button type="submit" class="ws-btn primary">${esc(label)}</button></div></form>`;
  showDialog(d, () => { done(); return true; });
  d.querySelector('[type="submit"]').focus();
}
function showDialog(d, onOk) {
  closePops();
  const form = d.querySelector('form');
  form.addEventListener('submit', e => { e.preventDefault(); if (onOk()) d.close(); });
  form.querySelector('[data-act="cancel"]').addEventListener('click', () => d.close());
  if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
}

/* ---------------- open a layout (from the URL, the select, New, Delete, Reset) */
function teardown() { closePops(); for (const v of views.values()) { v.destroy(); if (sizes) sizes.unobserve(v.el); v.el.remove(); } views.clear(); panels = []; colorsOwner = null; }
function openLayout(name) {
  teardown();
  layout = W.layoutName(name) || W.DEFAULT_NAME;
  const s = W.readStore(store);
  if (!Object.prototype.hasOwnProperty.call(s.layouts, layout)) W.saveLayout(store, layout, seedMainIndicators(W.defaultLayout()));
  const got = W.readStore(store).layouts[layout];
  panels = (got || W.cleanLayout(W.defaultLayout())).panels;
  for (const p of panels) addView(p);
  setUrl(); syncSelect(); syncConn(); placeColors(); syncAddMenu();
}

/* Another window or the single chart page changed something this page uses. Its open layouts stay its own. */
window.addEventListener('storage', e => {
  const k = e.key === null ? null : e.key.slice(PREFIX.length);
  if (k === null) return;
  if (k === W.KEYS.store) syncSelect();
  else if (k === W.KEYS.floors) { floors = W.readFloors(store); refloorTapes(); }
  else if (k === LP.KEYS.settings) { for (const v of chartViews()) v.pane.refreshSettings(); if (pop && pop.el === $('wsSettings')) renderGeneral(); }
  else if (k === LP.KEYS.colors || k === LP.KEYS.indicatorColors) { for (const v of chartViews()) v.pane.refreshColors(); }
  else if (k === HKKEY && pop && pop.el === $('wsSettings')) renderHotkeys();
});
window.addEventListener('pagehide', () => { if (layout) save(); });

/* for tests and the console (read only) */
window.workspace = { get layout() { return layout; }, panels: () => panels.map(p => Object.assign({}, p)),
  views: () => [...views.values()].map(v => ({ id: v.panel.id, type: v.panel.type, state: v.state, count: v.tape ? v.tape.count() : null })),
  feed: () => hub.stats() };

const start = () => openLayout(new URLSearchParams(location.search).get('layout') || W.DEFAULT_NAME);
if (PIN) PIN.gate().then(start); else start();
})();
