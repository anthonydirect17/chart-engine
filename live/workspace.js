/*
 * The trading workspace (live/workspace.html): independent panels on a 12 x 6 snap grid, one browser window per screen,
 * each window with its own saved layout opened from its URL (?layout=Main, ?layout=Second, any name).
 *
 * Panels: charts (each a read-only ChartLive.mount with its own paneId, instrument and timeframe) and Time and Sales
 * tapes (their own WebSocket to ChartBridge, live trades only). One chart per layout can be the execution chart; in this
 * build it is a read-only mount like the others (its order bar comes next).
 *
 * This file has two parts:
 *   WorkspaceCore  the pure parts (layout cleaning, snapping, overlap checks, the largest free rectangle, re-flow, the
 *                  large-print floor by time of day, formatting). No DOM; it also loads in Node for test/workspace.test.js.
 *   the page       runs only in a browser, after live.js (ChartLive) and pin.js (ChartBridgePin).
 *
 * Saved in this browser's localStorage, every key under the page's prefix 'workspace:' (so the workspace's charts keep
 * their own settings apart from the standalone page's):
 *   live-workspace-v1     { v: 1, layouts: { <name>: { panels: [{ id, type: 'chart' | 'tape', exec?: true, root, tf, range?,
 *                         x, y, w, h }] } } }  (x, y from 0; w, h in cells; tapes have no tf)
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

/** One panel, or null when its shape is bad. Position and size are whole cells; re-flow puts them inside the grid. */
function cleanPanel(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (p.type !== 'chart' && p.type !== 'tape') return null;
  if (typeof p.id !== 'string' || !ID_RX.test(p.id)) return null;
  if (!ROOTS.includes(p.root)) return null;
  const { x, y, w, h } = p;
  if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1 || x > 99 || y > 99 || w > 99 || h > 99) return null;
  const out = { id: p.id, type: p.type };
  if (p.type === 'chart') {
    if (!TFS.includes(p.tf)) return null;
    if (p.exec === true) out.exec = true;
    out.root = p.root; out.tf = p.tf;
    const r = parseRange(p.range);
    if (r !== null) out.range = r;
  } else out.root = p.root;
  return Object.assign(out, { x, y, w, h });
}

/** A layout as kept: { panels } with bad panels dropped, ids unique, at most 12 panels, at most one exec chart, every
    panel inside the grid and none overlapping (re-flow). Never throws. */
function cleanLayout(l) {
  const list = l && typeof l === 'object' && Array.isArray(l.panels) ? l.panels : [];
  const seen = new Set(), panels = [];
  let exec = false;
  for (const raw of list) {
    if (panels.length >= MAX_PANELS) break;
    const p = cleanPanel(raw);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    if (p.exec) { if (exec) delete p.exec; else exec = true; }
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
 * The default layout (the mockup Anthony signed off, 2026-10-01): the execution chart top left (cols 1 to 7, rows 1 to 4),
 * a long view under it (cols 1 to 7, rows 5 to 6; 1 hour bars until ChartBridge 0.3.7 brings daily bars), NQ 5 min and
 * ES 1 min stacked in the middle (cols 8 to 10), Time and Sales full height on the right (cols 11 to 12).
 */
function defaultLayout(makeId = newId) {
  return { panels: [
    { id: makeId(), type: 'chart', exec: true, root: 'MNQ', tf: 'range', range: 40, x: 0, y: 0, w: 7, h: 4 },
    { id: makeId(), type: 'chart', root: 'MNQ', tf: 'h1', x: 0, y: 4, w: 7, h: 2 },
    { id: makeId(), type: 'chart', root: 'NQ', tf: 'm5', x: 7, y: 0, w: 3, h: 3 },
    { id: makeId(), type: 'chart', root: 'ES', tf: 'm1', x: 7, y: 3, w: 3, h: 3 },
    { id: makeId(), type: 'tape', root: 'MNQ', x: 10, y: 0, w: 2, h: 6 },
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

return { COLS, ROWS, MIN_W, MIN_H, MAX_PANELS, MAX_LAYOUTS, NAME_MAX, ROOTS, TFS, KEYS, DEFAULT_NAME, DEFAULT_FLOORS, RTH_START, RTH_END,
  layoutName, parseRange, cleanPanel, cleanLayout, cleanStore, overlaps, fits, largestFree, findSpot, reflow, metrics, snapMove, snapResize,
  isRth, cleanFloors, floorAt, fmtClock, fmtPrice, decimalsOf, tfLabel, newId, defaultLayout,
  readStore, saveLayout, deleteLayout, renameLayout, readFloors, setFloor };
});


/* ======================================================================== the page (browser only) */
if (typeof document !== 'undefined' && typeof window !== 'undefined' && window.ChartLive) (() => {
'use strict';
const W = window.WorkspaceCore, LP = window.LivePrefs, PIN = window.ChartBridgePin || null;
const PREFIX = 'workspace:';                       // the page's prefix: every key it and its charts keep
const TAPE_MAX = 500, TAPE_ROW = 18;

/* ---------------- storage, wrapped (private windows and blocked site data throw) */
const LS = (() => { try { return window.localStorage; } catch (e) { return null; } })();
const store = {
  getItem: k => { try { return LS ? LS.getItem(PREFIX + k) : null; } catch (e) { return null; } },
  setItem: (k, v) => { try { if (LS) LS.setItem(PREFIX + k, v); } catch (e) { /* full or blocked */ } },
};
function patchJSON(k, fn) {
  let v = null;
  try { v = JSON.parse(store.getItem(k)); } catch (e) { v = null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) v = {};
  fn(v);
  store.setItem(k, JSON.stringify(v));
}

/* ---------------- ChartBridge: the page's own origin, unlocked with ChartBridge's PIN (0.3.2) like the standalone page */
const BASE_WS = (() => {
  const onBridge = location.protocol.startsWith('http') && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(location.host);
  return onBridge ? 'ws://' + location.host + '/ws' : 'ws://localhost:8765/ws';
})();
const wsUrl = () => (PIN ? PIN.wsUrl(BASE_WS) : BASE_WS);

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
  const states = [...views.values()].map(v => v.state);
  const el = $('wsConn');
  let text, cls;
  if (!states.length) { text = 'No panels'; cls = ''; }
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

/* ---------------- saving */
function save() { W.saveLayout(store, layout, { panels }); }

/* ---------------- panels */
function place(el, r) { el.style.gridColumn = (r.x + 1) + ' / span ' + r.w; el.style.gridRow = (r.y + 1) + ' / span ' + r.h; }

function headChart(v) {
  const p = v.panel;
  v.nameEl.textContent = v.contract && v.contract.split(' ')[0] === p.root ? v.contract : p.root;
  v.tfEl.textContent = W.tfLabel(p.tf, p.tf === 'range' ? p.range : 0);
  v.tfEl.title = p.tf === 'h1' ? 'The longest bars ChartBridge sends today. Daily bars come with ChartBridge 0.3.7.' : '';
}

function addView(p) {
  const el = document.createElement('section');
  el.className = 'ws-panel' + (p.exec ? ' exec' : '') + (p.type === 'tape' ? ' tape' : '');
  el.dataset.id = p.id; el.dataset.type = p.type;
  if (p.exec) el.dataset.exec = 'true';
  const close = p.exec ? '' : '<button type="button" class="ws-x" data-act="close" aria-label="Close panel" title="Close panel">✕</button>';
  const tag = p.exec ? '<span class="ws-tag exec">EXECUTION CHART</span>' : p.type === 'chart' ? '<span class="ws-tag">view only</span>' : '';
  const mid = p.type === 'chart'
    ? '<span class="ws-name"></span><span class="ws-tf"></span>'
    : '<span class="ws-name">Time and Sales</span><select class="ws-sel" data-act="root" aria-label="Time and Sales instrument">' +
      W.ROOTS.map(r => `<option value="${r}">${r}</option>`).join('') + '</select>';
  const gear = p.type === 'tape' ? '<button type="button" class="ws-ic" data-act="gear" aria-label="Large prints" title="Large prints" aria-expanded="false">⚙</button>' : '';
  el.innerHTML = `<header class="ws-head"><span class="ws-grip" aria-hidden="true">⋮⋮</span>${mid}<span class="ws-fill"></span>${tag}${gear}${close}</header>` +
    '<div class="ws-body"></div><div class="ws-size" aria-hidden="true" title="Resize"></div>';
  place(el, p);
  grid.appendChild(el);
  const v = { panel: p, el, head: el.querySelector('.ws-head'), body: el.querySelector('.ws-body'), state: 'connecting', destroy: () => {} };
  views.set(p.id, v);
  if (p.type === 'chart') mountChart(v); else mountTape(v);
  v.head.addEventListener('pointerdown', e => { if (!e.target.closest('button, select, input')) startDrag(e, v, 'move'); });
  el.querySelector('.ws-size').addEventListener('pointerdown', e => startDrag(e, v, 'size'));
  v.head.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'close') closePanel(p.id);
    else if (b.dataset.act === 'gear') openTapeGear(v, b);
  });
  return v;
}

/* A chart: ChartLive.mount reads the instrument, bars and range size from its prefix's settings when it mounts (live/EMBED.md),
   so the panel's own are written there just before. Changes made in the chart's toolbar are read back from it. */
function mountChart(v) {
  const p = v.panel;
  v.nameEl = v.head.querySelector('.ws-name'); v.tfEl = v.head.querySelector('.ws-tf');
  patchJSON('live-settings-v2', s => { s.root = p.root; s.tf = p.tf; });
  if (p.range) patchJSON('live-range-v2', r => { r[p.root] = p.range; });
  if (p.exec) seedExecIndicators(p.id);
  headChart(v);
  const pane = window.ChartLive.mount(v.body, {
    wsUrl, paneId: p.id, storagePrefix: PREFIX,
    onStatus: s => {
      v.state = s.state; syncConn();
      if (s.state === 'live') { const n = pane && pane.element.querySelector('[id$="lgName"]'); v.contract = n ? n.textContent : ''; headChart(v); }
    },
  });
  v.pane = pane;
  const sync = e => { if (e.target.closest && e.target.closest('header.bar')) syncChart(v); };
  pane.element.addEventListener('click', sync);
  pane.element.addEventListener('change', sync);
  v.destroy = () => pane.destroy();
}
function syncChart(v) {
  const p = v.panel, q = s => v.pane.element.querySelector(s);
  const r = q('[id$="symSeg"] [aria-pressed="true"]'), t = q('[id$="tfSeg"] [aria-pressed="true"]');
  const root = r && W.ROOTS.includes(r.dataset.v) ? r.dataset.v : p.root, tf = t && W.TFS.includes(t.dataset.v) ? t.dataset.v : p.tf;
  const box = q('[id$="rangeTicks"]'), range = tf === 'range' ? W.parseRange(box && box.value) : null;
  if (root === p.root && tf === p.tf && (tf !== 'range' || range === null || range === p.range)) return;
  if (root !== p.root) v.contract = '';
  p.root = root; p.tf = tf;
  if (tf === 'range' && range !== null) p.range = range; else if (tf !== 'range') delete p.range;
  headChart(v); save();
}
/* The execution chart starts with the trading page's indicators (the main pane's defaults) the first time it is made;
   any other new pane starts with none (Anthony's rule for new panes). */
function seedExecIndicators(id) {
  if (!LP || typeof LP.create !== 'function') return;
  try {
    const all = JSON.parse(store.getItem('live-indicators-v2'));
    if (all && typeof all === 'object' && Object.prototype.hasOwnProperty.call(all, id)) return;
    LP.create(store).updatePane(id, () => LP.defaultPane(LP.MAIN_PANE));
  } catch (e) { /* the pane keeps the new-pane default */ }
}

function closePanel(id) {
  const v = views.get(id); if (!v || v.panel.exec) return;
  closePops();
  v.destroy(); v.el.remove(); views.delete(id);
  panels = panels.filter(p => p.id !== id);
  save(); syncConn();
}

function addPanel(type) {
  closePops();
  if (panels.length >= W.MAX_PANELS) { note('At most ' + W.MAX_PANELS + ' panels: close one first', true); return; }
  const r = W.largestFree(panels);
  if (!r) { note('No free space: close or shrink a panel', true); return; }
  const p = type === 'tape' ? Object.assign({ id: W.newId(), type: 'tape', root: 'MNQ' }, r) : Object.assign({ id: W.newId(), type: 'chart', root: 'MNQ', tf: 'm1' }, r);
  panels.push(p);
  addView(p);
  save(); syncConn();
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

/* ---------------- Time and Sales: its own WebSocket, live trades from the panel's opening, newest on top. At most 500
   trades kept; only the rows that fit are in the page. Once per animation frame at most, the bottom rows are refilled
   with the new trades and moved to the top, so a frame touches only as many rows as trades came in (rewriting every
   row each frame cost the main thread about a quarter of its time at 300 trades a second, perf:workspace). */
function mountTape(v) {
  const p = v.panel;
  const sel = v.head.querySelector('[data-act="root"]');
  sel.value = p.root;
  v.body.innerHTML = '<div class="tp-cols"><span>Time</span><span>Price</span><span>Size</span></div><div class="tp-list" role="log" aria-label="Time and Sales trades" aria-live="off"></div>';
  const list = v.body.querySelector('.tp-list');
  const T = new Float64Array(TAPE_MAX), P = new Float64Array(TAPE_MAX), V = new Float64Array(TAPE_MAX), S = new Int8Array(TAPE_MAX), B = new Uint8Array(TAPE_MAX);
  let head = -1, count = 0, seq = 0, drawnSeq = 0, full = true, raf = 0, dec = 2, tick = 0.25;
  const rows = [];                                     // in page order, top first
  let ws = null, tries = 0, reconnect = 0, destroyed = false, root = p.root, ready = false;
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
  function subscribe() {
    ready = false; setState('loading');
    // days 1 and tickHours 0: the least history ChartBridge sends (it is not shown); live trades follow "ready"
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'subscribe', root, days: 1, tickHours: 0 }));
  }
  function connect() {
    reconnect = 0;
    if (destroyed) return;
    setState('connecting');
    let u;
    try { u = wsUrl(); } catch (e) { later(); return; }
    Promise.resolve(u).then(open, later);
  }
  function open(u) {
    if (destroyed) return;
    let sock;
    try { sock = new WebSocket(u); } catch (e) { later(); return; }
    ws = sock;
    sock.onopen = () => { if (sock === ws) tries = 0; };
    sock.onmessage = ev => {
      if (sock !== ws) return;
      const d = ev.data;
      // only "hello", "ready" and "tick" matter here; history bars are skipped unread
      if (typeof d !== 'string' || d.startsWith('{"type":"history"')) return;
      let m; try { m = JSON.parse(d); } catch (e) { return; }
      if (m.type === 'tick') { if (ready && m.root === root) push(m); }
      else if (m.type === 'hello') {
        const i = (m.instruments || []).find(x => x && x.root === root);
        if (i && +i.tick > 0) { tick = +i.tick; dec = W.decimalsOf(tick); }
        v.instruments = m.instruments || [];
        subscribe();
      } else if (m.type === 'ready' && m.root === root) { ready = true; setState('live'); }
    };
    sock.onclose = () => { if (sock !== ws) return; ws = null; ready = false; setState('offline'); later(); };
    sock.onerror = () => { /* onclose follows */ };
  }
  function later() { if (destroyed) return; tries++; reconnect = setTimeout(connect, Math.min(5000, 500 * tries)); }

  sel.addEventListener('change', () => {
    if (!W.ROOTS.includes(sel.value) || sel.value === root) return;
    root = p.root = sel.value;
    const i = (v.instruments || []).find(x => x && x.root === root);
    if (i && +i.tick > 0) { tick = +i.tick; dec = W.decimalsOf(tick); }
    clear(); subscribe(); save();
  });
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fitRows) : null;
  if (ro) ro.observe(list);
  fitRows();
  connect();
  v.tape = { get root() { return root; }, count: () => count, refloor: () => { for (let i = 0; i < count; i++) { const j = (head - i + TAPE_MAX) % TAPE_MAX; B[j] = V[j] >= W.floorAt(root, T[j], floors) ? 1 : 0; } full = true; schedule(); } };
  v.destroy = () => {
    destroyed = true; clearTimeout(reconnect); if (raf) cancelAnimationFrame(raf); raf = 0;
    if (ro) ro.disconnect();
    if (ws) { const s = ws; ws = null; try { s.close(); } catch (e) { /* closed */ } }
  };
}
function refloorTapes() { for (const v of views.values()) if (v.tape) v.tape.refloor(); }

/* ---------------- popovers (Add panel, Settings, a tape's gear): one open at a time; outside click or Esc closes */
let pop = null;
function openPop(el, anchor, onClose) {
  closePops();
  el.hidden = false;
  if (anchor) {
    anchor.setAttribute('aria-expanded', 'true');
    const a = anchor.getBoundingClientRect(), w = el.offsetWidth;
    el.style.top = Math.round(a.bottom + 6) + 'px';
    el.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, a.right - w))) + 'px';
  }
  pop = { el, anchor, onClose };
}
function closePops() {
  if (!pop) return;
  const { el, anchor, onClose } = pop; pop = null;
  el.hidden = true;
  if (anchor) anchor.setAttribute('aria-expanded', 'false');
  if (onClose) onClose();
}
document.addEventListener('pointerdown', e => { if (pop && !pop.el.contains(e.target) && !(pop.anchor && pop.anchor.contains(e.target))) closePops(); }, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && pop) { closePops(); } });

$('wsAdd').addEventListener('click', e => { if (pop && pop.anchor === e.currentTarget) closePops(); else openPop($('wsAddMenu'), e.currentTarget); });
$('wsAddMenu').addEventListener('click', e => { const b = e.target.closest('[data-add]'); if (b) addPanel(b.dataset.add); });

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
  if (pop && pop.anchor === anchor) { closePops(); return; }
  const r = v.tape.root;
  $('wsGearBody').innerHTML = floorRow(r);
  openPop($('wsGear'), anchor);
}

/* Settings: small sections, so later builds add their own. */
function renderSettings() {
  $('wsFloors').innerHTML = W.ROOTS.map(floorRow).join('');
  $('wsResetName').textContent = layout;
  $('wsVersion').textContent = 'Chart ' + (window.ChartEngine ? window.ChartEngine.VERSION : '') + ' · Workspace layouts are kept in this browser.';
}
$('wsSet').addEventListener('click', e => { if (pop && pop.anchor === e.currentTarget) { closePops(); return; } renderSettings(); openPop($('wsSettings'), e.currentTarget); });
$('wsReset').addEventListener('click', () => { closePops(); confirmBox('Reset "' + layout + '" to the default layout? Its panels close and the default ones open.', 'Reset', () => {
  W.saveLayout(store, layout, W.defaultLayout()); openLayout(layout);
}); });

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
    if (!W.saveLayout(store, name, W.defaultLayout())) return 'Could not save it in this browser';
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
function teardown() { closePops(); for (const v of views.values()) { v.destroy(); v.el.remove(); } views.clear(); panels = []; }
function openLayout(name) {
  teardown();
  layout = W.layoutName(name) || W.DEFAULT_NAME;
  const s = W.readStore(store);
  if (!Object.prototype.hasOwnProperty.call(s.layouts, layout)) W.saveLayout(store, layout, W.defaultLayout());
  const got = W.readStore(store).layouts[layout];
  panels = (got || W.cleanLayout(W.defaultLayout())).panels;
  for (const p of panels) addView(p);
  setUrl(); syncSelect(); syncConn();
}

/* Another window changed the layouts (names in the select) or the large-print floors. Its open layouts stay its own. */
window.addEventListener('storage', e => {
  if (e.key === PREFIX + W.KEYS.store) syncSelect();
  else if (e.key === PREFIX + W.KEYS.floors) { floors = W.readFloors(store); refloorTapes(); }
});
window.addEventListener('pagehide', () => { if (layout) save(); });

/* for tests and the console (read only) */
window.workspace = { get layout() { return layout; }, panels: () => panels.map(p => Object.assign({}, p)), views: () => [...views.values()].map(v => ({ id: v.panel.id, type: v.panel.type, state: v.state, count: v.tape ? v.tape.count() : null })) };

const start = () => openLayout(new URLSearchParams(location.search).get('layout') || W.DEFAULT_NAME);
if (PIN) PIN.gate().then(start); else start();
})();
