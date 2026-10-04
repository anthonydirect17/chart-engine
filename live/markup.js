/*
 * Markup Studio page (live/markup.html, served by tools/markup_studio.py). Read only: no order path exists here.
 *
 * Loaded first, before the chart files:
 *  1. The page's clock follows the REPLAY clock. live.js reads Date.now() for "now" (the session, VWAP day, range-bar tick
 *     hours, the bar countdown), so Date.now() is set to the server's replay clock (advancing at the play speed, still
 *     while paused). Only this page does this; the chart files are unchanged.
 *  2. Blind mode never shows a date: every text the charts draw on their canvases and every text or tooltip in the page
 *     goes through scrub(), which keeps the time of day and drops dates, weekdays and month names.
 * Then the app: two charts mounted read only with ChartLive.mount (live/EMBED.md), Range 40 and 1 minute, on the instrument
 * the server's hello announces (--symbol: NQ or ES; the header says which); the grade panel; marks drawn on an overlay
 * above each chart. The Bot tab draws what /api/bot/view returns (the server cuts it at the clock) on the same overlays:
 * orders, fills, the open trade's stop and target, exits. The Trades tab grades the bot's own trades, keyboard first: each
 * opens frozen at the moment the bot placed its entry order (/api/trades/view is the bot's view at that cut), T, A or P
 * saves at once, the result and the date come only from /api/trades/result after the save. The Trades tab draws only the
 * trade being graded (the server sends no other). After a PASS, M marks his own trade instead (before any outcome shows).
 * Once the grade is complete his own trade (an ADJUST's, or the one instead of a PASS) is drawn in the --ms-yours accent,
 * labelled YOU, from /api/trades/view's yours_orders and yours_trade (the bot's simulate(), cut at the clock).
 */
(function () {
  'use strict';
  /* ---------------------------------------------------------------- 1. the replay clock */
  const realNow = Date.now.bind(Date);
  const CLK = { base: realNow(), at: performance.now(), speed: 1 };
  Date.now = function () { return Math.floor(CLK.base + (performance.now() - CLK.at) * CLK.speed); };
  function setClock(ms, speed) { CLK.base = ms; CLK.at = performance.now(); CLK.speed = speed; }

  /* ---------------------------------------------------------------- 2. no dates in blind mode */
  let BLIND = true;
  const MONTHS = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
  const DAYS = 'Sun(?:day)?|Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:s(?:day)?)?)?|Fri(?:day)?|Sat(?:urday)?';
  const RE_ISO = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
  // a number right after a day or month name is part of the date unless it is the hour of a time (followed by ':')
  const RE_DAYDATE = new RegExp('\\b(?:' + DAYS + ')\\b\\.?,?\\s*(?:\\d{1,2}\\b(?!:))?', 'g');
  const RE_MONTH = new RegExp('\\b(?:' + MONTHS + ')\\b\\.?\\s*(?:\\d{1,4}\\b(?!:))?,?\\s*(?:\\d{4}\\b(?!:))?', 'g');
  function scrub(s) {
    if (!BLIND || typeof s !== 'string' || !s) return s;
    const out = s.replace(RE_ISO, '').replace(RE_MONTH, '').replace(RE_DAYDATE, '');
    return out === s ? s : out.replace(/\s{2,}/g, ' ').replace(/^\s+/, '');
  }
  const C2D = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
  if (C2D) for (const k of ['fillText', 'strokeText', 'measureText']) {
    const orig = C2D[k];
    C2D[k] = function (text) { const a = Array.prototype.slice.call(arguments); a[0] = scrub(String(text)); return orig.apply(this, a); };
  }
  function scrubNode(n) {
    if (!BLIND || !n) return;
    // the Free and Bot sections and the date (never shown with a blind candidate open): the node or any ancestor, since a
    // day picker's options are added as nodes of their own
    const el = n.nodeType === 1 ? n : n.parentElement;
    if (el && el.closest('[data-dates]')) return;
    if (n.nodeType === 3) { const v = scrub(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; return; }
    if (n.nodeType !== 1 || n.tagName === 'SCRIPT' || n.tagName === 'STYLE') return;
    for (const a of ['title', 'aria-label', 'placeholder']) { const v = n.getAttribute(a); if (v) { const w = scrub(v); if (w !== v) n.setAttribute(a, w); } }
    if (n.tagName === 'INPUT' && n.type !== 'radio' && n.value) { const w = scrub(n.value); if (w !== n.value) n.value = w; }
    for (let c = n.firstChild; c; c = c.nextSibling) scrubNode(c);
  }
  const observer = new MutationObserver(list => {
    if (!BLIND) return;
    for (const m of list) {
      if (m.type === 'characterData') scrubNode(m.target);
      else if (m.type === 'attributes') scrubNode(m.target);
      else for (const n of m.addedNodes) scrubNode(n);
    }
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'aria-label', 'placeholder'] });

  /* ---------------------------------------------------------------- 3. the app */
  const $ = id => document.getElementById(id);
  const ROLES = ['Level', 'Failed candle', 'Reclaim candle', 'Entry', 'Stop', 'Target'];
  const SPANS = ["Volume I'm reading", 'Approach'];
  const COLORS = { Level: '#B69CFF', 'Failed candle': '#FFC266', 'Reclaim candle': '#7FD7FF', Entry: '#E6EDF5', Stop: '#FF5C7A', Target: '#3DDC97' };
  // his own trade in the Trades tab once the grade is complete: the one accent (markup.css --ms-yours), on marks and drawings
  const YOU = (getComputedStyle(document.documentElement).getPropertyValue('--ms-yours') || '').trim() || '#FF9500';
  const YOU_INK = (getComputedStyle(document.documentElement).getPropertyValue('--ms-yours-deep') || '').trim() || '#3A2200';
  const OWN_ROLES = ['Entry', 'Stop', 'Target'];
  const A = { inst: null, state: null, panes: {}, overlays: {}, tool: null, spanDraft: null, marks: [], spans: [], chips: [], chipOn: new Set(),
    lastMount: '', machineTimer: 0, saved: false, uiMode: 'blind', bot: null, botInfo: null, botAt: 0, botBusy: false, runallWas: false,
    botDrawn: { orders: 0, fills: 0, exits: 0 }, tview: null, tvAt: 0, tvBusy: false, tBusy: false, tres: null, tConf: null, tSeenArm: false,
    tinfo: null, tMine: false };
  window.__markup = A;

  async function api(path, body) {
    const r = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }
  const say = (id, text, err) => { const el = $(id); el.textContent = text || ''; el.classList.toggle('err', !!err); };
  const fmtP = p => (p === null || p === undefined || !isFinite(p)) ? '' : (+p).toFixed(2);
  const fmtC = p => (p === null || p === undefined || !isFinite(p)) ? '' : (+p).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const signed = p => (p > 0 ? '+' : '') + (+p).toFixed(2);
  const todOf = t => { const s = ((Math.floor(t) % 86400) + 86400) % 86400; return [s / 3600 | 0, s / 60 % 60 | 0, s % 60].map(x => String(x).padStart(2, '0')).join(':'); };

  /* ---------------- the instrument: the one the server's hello announces (root, name, tick), read once before the charts */
  function readHello() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://' + location.host + '/ws');
      ws.onmessage = e => {
        let m = null;
        try { m = JSON.parse(e.data); } catch (err) { /* not JSON */ }
        if (!m || m.type !== 'hello') return;
        ws.close();
        const i = (m.instruments || [])[0];
        if (i && i.root) resolve(i); else reject(new Error('the hello names no instrument'));
      };
      ws.onerror = () => reject(new Error('Studio not reachable'));
    });
  }
  const instReady = (async () => {
    for (;;) {
      try {
        A.inst = await readHello();
        return A.inst;
      } catch (e) { await new Promise(r => setTimeout(r, 1000)); }
    }
  })();
  const tickSize = () => (A.inst && +A.inst.tick > 0 ? +A.inst.tick : 0.25);

  /* ---------------- the charts */
  function unmount() {
    for (const k of Object.keys(A.panes)) { try { A.panes[k].destroy(); } catch (e) { /* gone */ } }
    A.panes = {}; A.overlays = {};
  }
  function mount() {
    if (!A.inst) { instReady.then(mount); return; }               // the charts need the instrument's root first
    unmount();
    const wsUrl = () => 'ws://' + location.host + '/ws';
    // each chart has its own connection: a shared feed (live/feed.js) gives a 1 minute chart no tick backfill, so its delta
    // would count only from the load; the server encodes the load once and sends the same bytes to both
    const opts = (prefix, tf) => ({ wsUrl, paneId: 'main', storagePrefix: prefix, view: { root: A.inst.root, tf, range: 40 }, compact: true, toolbar: false });
    A.panes.range = ChartLive.mount($('paneRange'), opts('markup-range:', 'range'));
    A.panes.m1 = ChartLive.mount($('pane1m'), opts('markup-1m:', 'm1'));
    for (const [k, slot] of [['range', 'toolsRange'], ['m1', 'tools1m']]) {
      const box = $(slot); box.textContent = '';
      const p = A.panes[k];
      for (const el of [p.indicators, p.chips]) if (el) box.appendChild(el);
      A.overlays[k] = overlay(k);
    }
  }
  function overlay(key) {
    const pane = A.panes[key], host = pane.element.querySelector('.ce-host') || pane.element;
    const cv = document.createElement('canvas');
    cv.className = 'ms-overlay';
    host.appendChild(cv);
    const ov = { key, cv, host, pane };
    cv.addEventListener('mousedown', e => onPress(ov, e));
    cv.addEventListener('mousemove', e => { if (A.spanDraft && A.spanDraft.key === key) { A.spanDraft.t1 = timeAt(ov, e).t; } });
    cv.addEventListener('mouseup', e => onRelease(ov, e));
    cv.addEventListener('contextmenu', e => e.preventDefault());
    return ov;
  }
  function barIndexAt(chart, t) {
    const bars = chart.bars();
    let lo = 0, hi = bars.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].t <= t) { k = m; lo = m + 1; } else hi = m - 1; }
    return k;
  }
  function timeAt(ov, e) {
    const r = ov.cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, ch = ov.pane.chart, bars = ch.bars();
    let lo = 0, hi = bars.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ch.barToX(m) < x) lo = m + 1; else hi = m; }
    let i = lo;
    if (i > 0 && Math.abs(ch.barToX(i - 1) - x) < Math.abs(ch.barToX(i) - x)) i--;
    const price = Math.round(ch.yToPrice(y) / tickSize()) * tickSize();
    return { t: bars.length ? bars[Math.max(0, i)].t : null, price };
  }
  function onPress(ov, e) {
    if (!A.tool || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const at = timeAt(ov, e);
    if (at.t === null) return;
    if (A.tool.span) { A.spanDraft = { key: ov.key, role: A.tool.role, t0: at.t, t1: at.t }; return; }
    A.marks = A.marks.filter(m => m.role !== A.tool.role).concat({ role: A.tool.role, chart: ov.key === 'm1' ? '1m' : 'range', t: at.t, price: at.price });
    setTool(null); renderMarks();
  }
  function onRelease(ov, e) {
    const d = A.spanDraft;
    if (!d) return;
    e.preventDefault();
    d.t1 = timeAt(ov, e).t;
    A.spanDraft = null;
    if (d.t1 !== d.t0) A.spans = A.spans.filter(s => s.role !== d.role).concat({ role: d.role, chart: d.key === 'm1' ? '1m' : 'range', t0: Math.min(d.t0, d.t1), t1: Math.max(d.t0, d.t1) });
    setTool(null); renderMarks();
  }
  function draw() {
    let drawn = null;
    for (const ov of Object.values(A.overlays)) {
      const w = ov.host.clientWidth, h = ov.host.clientHeight, dpr = window.devicePixelRatio || 1;
      if (ov.cv.width !== Math.round(w * dpr) || ov.cv.height !== Math.round(h * dpr)) { ov.cv.width = Math.round(w * dpr); ov.cv.height = Math.round(h * dpr); }
      const g = ov.cv.getContext('2d'), ch = ov.pane.chart;
      if (!drawn) drawn = { orders: 0, fills: 0, exits: 0, entries: [], legs: [], fillPx: [], exitText: [], yours: 0, you: [] };
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
      if (!ch || !ch.bars().length) continue;
      const plotW = w - 64;
      g.font = '500 11px "IBM Plex Mono", monospace'; g.textBaseline = 'middle';
      const lv = A.state && A.state.level;
      if (lv && isFinite(lv.price)) {
        const y = ch.priceToY(lv.price);
        g.strokeStyle = '#B69CFF'; g.setLineDash([6, 4]); g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(0, y); g.lineTo(plotW, y); g.stroke(); g.setLineDash([]);
        const label = (lv.type || 'Level') + ' ' + fmtP(lv.price), tw = g.measureText(label).width + 10;
        g.fillStyle = '#2A1F4D'; g.fillRect(6, y - 9, tw, 18); g.fillStyle = '#D8CCFF'; g.fillText(label, 11, y);
      }
      const spans = A.spans.concat(A.spanDraft && A.spanDraft.key === ov.key ? [{ role: A.spanDraft.role, t0: Math.min(A.spanDraft.t0, A.spanDraft.t1), t1: Math.max(A.spanDraft.t0, A.spanDraft.t1) }] : []);
      for (const s of spans) {
        const i0 = barIndexAt(ch, s.t0), i1 = barIndexAt(ch, s.t1);
        if (i1 < 0) continue;
        const x0 = ch.barToX(Math.max(0, i0)), x1 = ch.barToX(i1);
        g.fillStyle = s.role === 'Approach' ? 'rgba(127,215,255,0.10)' : 'rgba(255,194,102,0.10)';
        g.fillRect(Math.min(x0, x1) - 3, 0, Math.abs(x1 - x0) + 6, h - 24);
        g.fillStyle = s.role === 'Approach' ? '#7FD7FF' : '#FFC266'; g.fillText(s.role, Math.min(x0, x1), 12);
      }
      const own = A.uiMode === 'trades' && tStage(A.state) === 3;          // his trade's marks take the accent once saved
      for (const m of A.marks) {
        const i = barIndexAt(ch, m.t);
        if (i < 0) continue;
        const x = ch.barToX(i), y = ch.priceToY(m.price), c = own && OWN_ROLES.includes(m.role) ? YOU : COLORS[m.role] || '#fff';
        g.fillStyle = c; g.strokeStyle = '#06080C'; g.lineWidth = 1;
        g.beginPath(); g.arc(x, y, 4.5, 0, Math.PI * 2); g.fill(); g.stroke();
        g.fillText(m.role, x + 8, y);
      }
      if (A.uiMode === 'bot' && A.bot && A.state && A.state.mode === 'bot') drawBot(g, ch, A.bot, drawn);
      else if (A.uiMode === 'trades' && A.tview && A.state && A.state.mode === 'trades') { drawBot(g, ch, A.tview, drawn); drawYours(g, ch, A.tview, drawn); }
    }
    A.botDrawn = drawn;
    requestAnimationFrame(draw);
  }
  /* the bot's view at the clock (already cut by the server): orders, fills, stop and target, exits */
  const TYPES = { stop: 'STP', stoplimit: 'STP LMT', limit: 'LMT', market: 'MKT' };
  const ROLE_COLOR = { entry: '#E6EDF5', stop: '#FF5C7A', target: '#3DDC97' };
  function xAt(ch, ms) { const i = barIndexAt(ch, ms / 1000); return i < 0 ? null : ch.barToX(i); }
  function drawBot(g, ch, v, drawn) {
    const nowX = ch.barToX(ch.bars().length - 1);
    for (const o of v.orders || []) {
      const x0 = xAt(ch, o.t_from), x1 = xAt(ch, o.t_to);
      if (x0 === null || x1 === null) continue;
      const y = ch.priceToY(o.price), c = ROLE_COLOR[o.role] || '#9AA8B8';
      g.strokeStyle = c; g.lineWidth = 1.5; g.setLineDash(o.role === 'entry' ? [5, 3] : []);
      g.beginPath(); g.moveTo(x0, y); g.lineTo(Math.max(x1, x0 + 8), y); g.stroke(); g.setLineDash([]);
      if (o.role === 'entry') {
        const label = (o.side === 'sell' ? 'SELL ' : 'BUY ') + (TYPES[o.type] || o.type) + ' ' + fmtC(o.price);
        g.fillStyle = c; g.fillText(label, x0, y - 9); drawn.entries.push(label);
      } else {
        // the Trades tab names its legs: '<exit id> target' (the exit the result lists) or 'bot primary target'
        if (o.label) { g.fillStyle = c; g.fillText(o.label + ' ' + fmtC(o.price), x0, y - 9); }
        drawn.legs.push({ role: o.role, price: o.price, label: o.label || '' });
      }
      drawn.orders++;
    }
    const base = (v.exit_ids || [])[0];
    for (const t of v.trades || []) {
      const x0 = xAt(ch, t.entry_t);
      if (x0 === null) continue;
      const ex = t.exits && t.exits[base], x1 = ex ? xAt(ch, ex.exit_t) : nowX;
      for (const [p, c, role] of [[t.stop, '#FF5C7A', 'stop'], [t.target, '#3DDC97', 'target']]) {
        if (p === null || p === undefined) continue;
        const y = ch.priceToY(p);
        g.strokeStyle = c; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x0, y); g.lineTo(Math.max(x1, x0 + 8), y); g.stroke();
        const lab = role === 'target' ? t.target_label : '';
        if (lab) { g.fillStyle = c; g.fillText(lab + ' ' + fmtC(p), x0 + 9, y - 9); }
        drawn.legs.push({ role, price: p, label: lab || '', trade: true });
      }
      const y = ch.priceToY(t.entry), up = t.dir !== 'short';
      g.fillStyle = up ? '#3DDC97' : '#FF5C7A';
      g.beginPath(); g.moveTo(x0, y + (up ? -6 : 6)); g.lineTo(x0 - 6, y + (up ? 5 : -5)); g.lineTo(x0 + 6, y + (up ? 5 : -5)); g.closePath(); g.fill();
      g.fillStyle = '#E6EDF5'; g.fillText(fmtC(t.entry), x0 + 9, y + (up ? 10 : -10));
      drawn.fills++; drawn.fillPx.push(fmtC(t.entry));
      if (ex && x1 !== null) {
        const ye = ch.priceToY(ex.exit);
        g.fillStyle = ex.points > 0 ? '#3DDC97' : '#FF5C7A'; g.strokeStyle = '#06080C';
        g.beginPath(); g.arc(x1, ye, 5, 0, Math.PI * 2); g.fill(); g.stroke();
        g.fillText(ex.reason + ' ' + signed(ex.points), x1 + 9, ye);
        drawn.exits++; drawn.exitText.push(ex.reason + ' ' + signed(ex.points));
      }
    }
  }
  /* his own trade (only once the grade is complete; already cut at the clock by the server), all in the YOU accent: the
     entry order from placement to fill or cancel (dashed), the stop and target from the fill to the exit, the fill and the
     exit markers, each labelled YOU */
  const OWN_TYPES = { stop: 'STP', stoplimit: 'STP LMT', limit: 'LMT', market: 'MKT', 'stop-limit': 'STP LMT', 'stop-market': 'STP' };
  function youTag(g, text, x, y, drawn) {
    const w = g.measureText(text).width + 8;
    g.fillStyle = YOU_INK; g.fillRect(x - 2, y - 8, w, 16);
    g.fillStyle = YOU; g.fillText(text, x + 2, y);
    drawn.you.push(text);
  }
  function drawYours(g, ch, v, drawn) {
    const orders = v.yours_orders || [], t = v.yours_trade;
    if (!orders.length && !t) return;
    const nowX = ch.barToX(ch.bars().length - 1);
    for (const o of orders) {
      const x0 = xAt(ch, o.t_from), x1 = o.open ? nowX : xAt(ch, o.t_to);
      if (x0 === null || x1 === null || o.price === null || o.price === undefined) continue;
      const y = ch.priceToY(o.price);
      g.strokeStyle = YOU; g.lineWidth = 2; g.setLineDash(o.role === 'entry' ? [5, 3] : []);
      g.beginPath(); g.moveTo(x0, y); g.lineTo(Math.max(x1, x0 + 8), y); g.stroke(); g.setLineDash([]);
      const what = o.role === 'entry' ? (o.side === 'sell' ? 'SELL ' : 'BUY ') + (OWN_TYPES[o.type] || o.type) : o.role === 'stop' ? 'STOP' : o.role === 'target' ? 'TARGET' : 'FLAT';
      youTag(g, 'YOU ' + what + ' ' + fmtC(o.price), x0, y - 10, drawn);
      drawn.yours++;
    }
    if (!t) return;
    const x0 = xAt(ch, t.entry_t);
    if (x0 === null) return;
    const y = ch.priceToY(t.entry), up = t.dir !== 'short';
    g.fillStyle = YOU; g.strokeStyle = '#06080C'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x0, y + (up ? -7 : 7)); g.lineTo(x0 - 7, y + (up ? 6 : -6)); g.lineTo(x0 + 7, y + (up ? 6 : -6)); g.closePath(); g.fill(); g.stroke();
    youTag(g, 'YOU ' + fmtC(t.entry), x0 + 10, y + (up ? 12 : -12), drawn);
    drawn.yours++;
    const ex = t.exits && t.exits.yours, x1 = ex ? xAt(ch, ex.exit_t) : null;
    if (ex && x1 !== null) {
      const ye = ch.priceToY(ex.exit);
      g.fillStyle = YOU; g.strokeStyle = '#06080C';
      g.beginPath(); g.rect(x1 - 5, ye - 5, 10, 10); g.fill(); g.stroke();
      youTag(g, 'YOU ' + ex.reason + ' ' + signed(ex.points), x1 + 10, ye, drawn);
      drawn.yours++;
    }
  }

  /* ---------------- marks UI */
  function setTool(t) {
    A.tool = t; A.spanDraft = null;
    for (const b of document.querySelectorAll('[data-role]')) b.classList.toggle('on', !!t && b.dataset.role === t.role);
    for (const ov of Object.values(A.overlays)) ov.cv.classList.toggle('armed', !!t);
  }
  function buildTools() {
    for (const r of ROLES) $('markTools').appendChild(toolBtn(r, false));
    for (const r of SPANS) $('spanTools').appendChild(toolBtn(r, true));
  }
  function toolBtn(role, span) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ms-btn'; b.dataset.role = role; b.textContent = span ? 'Span: ' + role : role;
    b.addEventListener('click', () => setTool(A.tool && A.tool.role === role ? null : { role, span }));
    return b;
  }
  function renderMarks() {
    for (const id of ['markList', 'tMarkList']) renderMarkList($(id));
    sideNote();
  }
  // ADJUST: marks on the other side of the bot's trade are saved too (opposite_side), with this note before the save
  function sideNote() {
    const s = A.state, t = s && s.trade, e = A.marks.find(m => m.role === 'Entry'), st = A.marks.find(m => m.role === 'Stop');
    let text = '';
    if (tStage(s) === 2 && t && e && st && e.price !== st.price) {
      const mine = st.price < e.price ? 'long' : 'short';
      if (mine !== t.dir) text = 'Your trade is ' + mine + ', the bot\'s is ' + t.dir + ': this counts as a PASS for the bot\'s trade. Saving records your trade.';
    }
    const el = $('tSideNote'); if (el.textContent !== text) el.textContent = text;
    el.hidden = !text;
  }
  function renderMarkList(ul) {
    ul.textContent = '';
    const items = A.marks.map(m => ({ text: m.role + ' ' + m.chart + ' ' + todOf(m.t) + ' ' + fmtP(m.price), drop: () => { A.marks = A.marks.filter(x => x !== m); } }))
      .concat(A.spans.map(s => ({ text: s.role + ' ' + Math.round(s.t1 - s.t0) + ' s', drop: () => { A.spans = A.spans.filter(x => x !== s); } })));
    for (const it of items) {
      const li = document.createElement('li'), sp = document.createElement('span'), x = document.createElement('button');
      sp.textContent = it.text; x.type = 'button'; x.textContent = 'x'; x.title = 'Remove';
      x.addEventListener('click', () => { it.drop(); renderMarks(); });
      li.append(sp, x); ul.appendChild(li);
    }
  }
  function renderChips() {
    for (const id of ['chips', 'tChips']) renderChipBox($(id));
  }
  function renderChipBox(box) {
    box.textContent = '';
    for (const c of A.chips) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ms-chip' + (A.chipOn.has(c) ? ' on' : ''); b.textContent = c;
      b.addEventListener('click', () => { if (A.chipOn.has(c)) A.chipOn.delete(c); else A.chipOn.add(c); renderChips(); });
      box.appendChild(b);
    }
  }
  function resetForm() {
    $('gradeForm').reset(); A.chipOn.clear(); A.marks = []; A.spans = []; A.saved = false;
    $('tReason').value = ''; A.tConf = null; A.tSeenArm = false; A.tres = null; A.tview = null; A.tMine = false;
    const st = document.querySelector('input[name=tEntryType][value="stop-limit"]'); if (st) st.checked = true;
    clearResult();
    renderChips(); renderMarks(); setTool(null); say('saveMsg', ''); say('tErr', '');
    $('secDraft').hidden = true; $('secMachine').hidden = A.uiMode !== 'free';
  }

  /* ---------------- state and modes */
  function showState(s) {
    A.state = s;
    const free = s.mode === 'free' || s.mode === 'bot';
    setClock(s.clock_utc_ms || realNow(), s.playing ? s.speed : 0);
    $('msClock').textContent = s.clock_tod || '--:--:--';
    $('msDate').textContent = (free || s.mode === 'trades') && s.date ? s.date : '';
    $('msPlay').textContent = s.playing ? s.speed + 'x' : '';
    const sc = s.scan || {};
    const warn = (s.warnings || []).join('; ');
    $('msStatus').textContent = (sc.error ? 'Scan failed: ' + sc.error : !sc.done ? 'scanning: ' + (sc.days || 0) + ' of ' + (sc.total || '?') + ' days' :
      'Excluded ' + (s.queue ? s.queue.excluded_seen : 0) + ' already-seen') + (warn ? '  |  ' + warn : '');
    $('msStatus').classList.toggle('warn', !!warn);
    $('btnNext').disabled = !(s.queue && s.queue.remaining > 0);
    // blind dates stay hidden while the server holds a blind candidate, whatever tab is showing
    BLIND = A.uiMode === 'blind' || s.mode === 'blind' || !!s.trade_open || (A.uiMode === 'trades' && !s.date);
    const shut = !!(s.blind_open || s.trade_open);
    for (const id of ['tabFree', 'tabBot']) { $(id).disabled = shut; $(id).title = shut ? 'Save the grade first' : ''; }
    $('tabTrades').disabled = !!s.blind_open; $('tabBlind').disabled = !!s.trade_open;
    if (s.blind_open && A.uiMode !== 'blind') setMode('blind');
    if (s.trade_open && A.uiMode !== 'trades') setMode('trades');
    if (s.queue) $('queueInfo').textContent = 'remaining ' + s.queue.remaining + ', graded ' + s.queue.graded + ', excluded ' + s.queue.excluded_seen + ' already-seen, ' + (s.queue.bot_days || 0) + ' on bot days';
    const blindLive = s.mode === 'blind' && s.loaded && !s.graded;
    $('candInfo').textContent = s.mode === 'blind' && s.candidate && s.level ? '#' + s.candidate.n + '  Level ' + s.level.type + ' ' + fmtP(s.level.price) : 'No candidate open';
    const tst = tStage(s);
    $('stepCount').textContent = (s.mode === 'blind' && s.loaded) || tst === 2 || tst === 4 ? 'steps after cut: ' + s.steps : '';
    $('btnStep').disabled = !s.loaded || tst === 1;
    $('playRow').hidden = $('jumpRow').hidden = !free;
    $('revealRow').hidden = !((s.mode === 'blind' && s.graded) || tst === 3);
    $('btnSave').disabled = !s.loaded || (s.mode === 'blind' && s.graded);
    if (blindLive) $('secMachine').hidden = true;
    const ra = (s.bot && s.bot.runall) || {};
    if (ra.running) { A.runallWas = true; $('runAllMsg').textContent = 'running: day ' + Math.min(ra.k + 1, ra.n) + ' of ' + ra.n; }
    else if (A.runallWas) { A.runallWas = false; api('/api/bot/runall').then(showSummary).catch(e => say('botExportMsg', e.message, true)); }
    $('btnRunAll').disabled = !!ra.running || !(s.bot && s.bot.ready);
    const bd = s.bot_day;
    if (A.uiMode === 'bot') $('botProg').textContent = !bd ? '' : bd.status === 'running' ? 'the bot is running on this day: ' + Math.round(100 * bd.progress) + '%' :
      bd.status === 'error' ? 'the bot failed on this day: ' + bd.error : '';
    if (A.uiMode === 'bot' && s.mode === 'bot' && s.loaded) botTick();
    if (A.uiMode === 'trades') showTrades(s, tst);
  }
  async function refresh() {
    try { showState(await api('/api/state')); } catch (e) { $('msStatus').textContent = 'Studio not reachable: ' + e.message; }
  }

  /* ---------------- the Bot tab */
  async function botTick(force) {
    if (A.botBusy || (!force && performance.now() - A.botAt < 400)) return;
    A.botBusy = true; A.botAt = performance.now();
    try { A.bot = await api('/api/bot/view'); renderBot(A.bot); } catch (e) { say('botErr', e.message, true); } finally { A.botBusy = false; }
  }
  function cell(tr, text, cls) { const td = tr.insertCell(); td.textContent = text; if (cls) td.className = cls; return td; }
  function head(t, cols) { const tr = t.createTHead().insertRow(); for (const c of cols) { const th = document.createElement('th'); th.textContent = c; tr.appendChild(th); } }
  function renderBot(v) {
    $('secBotOut').hidden = false;
    $('botHead').textContent = v.name + '  |  ' + v.variant_label;
    const ul = $('botEvents'); ul.textContent = '';
    for (const e of (v.events || []).slice().reverse()) {
      const li = document.createElement('li'), b = document.createElement('b');
      b.textContent = todOf(e.t / 1000); li.append(b, document.createTextNode(e.text || e.kind)); ul.appendChild(li);
    }
    const base = (v.exit_ids || [])[0], t = $('botTrades'); t.textContent = '';
    head(t, ['Entry', 'Dir', 'Level', 'Price', 'Stop', 'Target', 'Result']);
    const tb = t.createTBody();
    for (const x of v.trades || []) {
      const tr = tb.insertRow(), ex = x.exits && x.exits[base];
      cell(tr, todOf(x.entry_t / 1000)); cell(tr, x.dir); cell(tr, (x.level_type || '') + ' ' + fmtP(x.level_price));
      cell(tr, fmtP(x.entry)); cell(tr, fmtP(x.stop)); cell(tr, fmtP(x.target));
      cell(tr, ex ? ex.reason + ' ' + signed(ex.points) : 'open', ex ? (ex.points > 0 ? 'win' : 'loss') : '');
    }
    const n = $('botNet'); n.textContent = '';
    for (const k of v.exit_ids || []) {
      const r = (v.net || {})[k] || { trades: 0, points: 0, usd: 0, usd_micro: 0 }, tr = n.insertRow();
      cell(tr, k); cell(tr, signed(r.points) + ' pts  $' + r.usd.toFixed(2) + ' ' + v.contract + '  $' + r.usd_micro.toFixed(2) + ' ' + v.micro + '  (' + r.trades + ' trades)');
    }
  }
  function clearBot() {
    A.bot = null; $('botDay').textContent = ''; $('secBotOut').hidden = true; $('botSummary').hidden = true;
    for (const id of ['botEvents', 'botTrades', 'botNet']) $(id).textContent = '';
    for (const id of ['botHead', 'botProg', 'botErr', 'runAllMsg', 'botExportMsg']) $(id).textContent = '';
  }
  async function loadBotDays() {
    const info = A.botInfo;
    const ok = !!(info && info.ok);
    $('botMsg').textContent = !info ? '' : ok ? '' : (info.error ? 'Bot not loaded: ' + info.error : info.usage);
    for (const id of ['botDay', 'botVariant', 'btnBotLoad']) $(id).disabled = !ok;
    if (!ok) return;
    try {
      const { days } = await api('/api/bot/days');
      const sel = $('botDay'), cur = sel.value; sel.textContent = '';
      for (const d of days.slice().reverse()) { const o = document.createElement('option'); o.value = o.textContent = d; sel.appendChild(o); }
      if (cur) sel.value = cur;
      if (A.state && A.state.mode === 'bot') $('secBotOut').hidden = false;
    } catch (e) { say('botErr', e.message, true); }
  }
  // the dollar columns name the server's contracts ('usd' 1 full contract, 'usd_micro' 1 micro: NQ and MNQ, or ES and MES)
  const sumCols = (c, m) => [['trades', 'Trades'], ['wins', 'Wins'], ['losses', 'Losses'], ['win_pct', 'Win %'], ['avg_r', 'Avg R'], ['net_points', 'Net pts'],
    ['net_usd', 'Net $ ' + c], ['net_usd_per_trade', '$ ' + c + ' / trade'], ['net_usd_micro', 'Net $ ' + m], ['net_usd_micro_per_trade', '$ ' + m + ' / trade'],
    ['pf', 'PF (' + c + ')'], ['max_dd_usd', 'Max DD $ ' + c], ['max_dd_usd_micro', 'Max DD $ ' + m]];
  function sumTable(t, rows, labels, withGroup, SUM_COLS) {
    t.textContent = '';
    head(t, ['Variant', 'Exit'].concat(withGroup ? ['Group'] : [], SUM_COLS.map(c => c[1])));
    const tb = t.createTBody();
    for (const r of rows) {
      const tr = tb.insertRow();
      cell(tr, labels[r.variant] || r.variant).title = r.variant; cell(tr, r.exit_id);
      if (withGroup) cell(tr, r.group);
      for (const [k] of SUM_COLS) {
        const td = tr.insertCell(), v = r[k];
        td.textContent = v === null || v === undefined ? (k === 'pf' && r.trades ? 'no losses' : 'n/a') : ['trades', 'wins', 'losses'].includes(k) ? String(v) : (+v).toFixed(2);
        if (k !== 'trades') { const sp = document.createElement('span'); sp.className = 'n'; sp.textContent = '(' + r.trades + ')'; td.appendChild(sp); }
      }
    }
  }
  function showSummary(r) {
    if (r.error) { $('runAllMsg').textContent = 'Run all failed: ' + r.error; return; }
    if (!r.rows) return;
    const labels = Object.fromEntries((r.variants || []).map(v => [v.id, v.id + ' ' + v.label]));
    const cols = sumCols(r.contract, r.micro);
    sumTable($('botSumMain'), r.rows.filter(x => x.group === 'all'), labels, false, cols);
    sumTable($('botSumBy'), r.rows.filter(x => x.group !== 'all'), labels, true, cols);
    $('botSumNote').textContent = r.n + ' bot days' + (r.failed && r.failed.length ? ', ' + r.failed.length + ' failed (see the window)' : '') +
      '; costs per round trip: ' + r.contract + ' $' + (+r.rt).toFixed(2) + ', ' + r.micro + ' $' + (+r.micro_rt).toFixed(2) + '; (n) = trades';
    $('runAllMsg').textContent = 'done: ' + r.n + ' bot days';
    if (A.uiMode === 'bot') $('botSummary').hidden = false;
  }
  async function act(path, body, opts) {
    try {
      const s = await api(path, body || {});
      showState(s);
      if (opts && opts.remount) { if (opts.reset) resetForm(); mount(); }
      return s;
    } catch (e) { say(A.uiMode === 'bot' ? 'botErr' : A.uiMode === 'trades' ? 'tErr' : 'saveMsg', e.message, true); return null; }
  }
  function setMode(m) {
    if (m !== 'blind' && A.state && A.state.blind_open) { say('saveMsg', 'Save the grade first, then use ' + (m === 'bot' ? 'the Bot tab.' : m === 'trades' ? 'the Trades tab.' : 'Free mode.'), true); return; }
    if (m !== 'trades' && A.state && A.state.trade_open) { say('tErr', 'Grade the open trade first.', true); return; }
    A.uiMode = m;
    const ui = m === 'blind', bot = m === 'bot', tr = m === 'trades';
    // the scrub stays on while a blind candidate is loaded, and in the Trades tab until the trade's grade is saved
    BLIND = ui || !A.state || A.state.mode === 'blind' || !!A.state.trade_open || (tr && !A.state.date);
    for (const [id, k] of [['tabBlind', 'blind'], ['tabFree', 'free'], ['tabBot', 'bot'], ['tabTrades', 'trades']]) { $(id).classList.toggle('on', m === k); $(id).setAttribute('aria-selected', String(m === k)); }
    $('secBlind').hidden = !ui; $('secFree').hidden = m !== 'free'; $('secBot').hidden = !bot;
    $('secKeys').hidden = $('secTrades').hidden = !tr;
    if (!tr) $('secTGrade').hidden = $('secTAdjust').hidden = $('secTResult').hidden = true;
    $('secMachine').hidden = m !== 'free';
    $('gradeForm').hidden = bot || tr; $('secAgree').hidden = bot || tr;
    if (bot || tr) $('secDraft').hidden = true;
    if (!bot) { $('secBotOut').hidden = true; $('botSummary').hidden = true; }
    $('msPanel').classList.toggle('bot', bot);
    $('msPanel').classList.toggle('trades', tr);
    if (BLIND) scrubNode(document.body);
    if (ui) { if (A.state && A.state.mode !== 'blind') { unmount(); resetForm(); } clearBot(); }
    else if (tr) { if (A.state && A.state.mode !== 'trades') { unmount(); resetForm(); } clearBot(); loadTrades(); }
    else if (bot) loadBotDays();
    else loadDays();
  }

  /* ---------------- the Trades tab: keyboard first; the date and the result only after the save */
  const tStage = s => !s || s.mode !== 'trades' || !s.loaded || !s.trade ? 0 : s.trade.complete ? 3 : s.trade.stage;
  // stage 4: a PASS is saved; M marks his own trade instead (then the keys of 2), N, Enter or Esc go on without one
  const KEYS_ON = { 0: ['N', 'ESC'], 1: ['T', 'A', 'P', 'C', 'X', 'ESC'], 2: ['E', 'S', 'G', 'Y', 'R', 'N', 'ESC'], 3: ['N', 'SP', 'ESC'],
    4: ['M', 'R', 'N', 'ESC'] };
  const ownTools = st => st === 2 || (st === 4 && A.tMine);
  function showTrades(s, st) {
    const c = s.trades && s.trades.counts;
    $('tProgress').textContent = c ? 'Graded ' + c.graded + ' of ' + c.target + ' (' + c.adjusted + ' adjusted, ' + c.skipped_days + ' days skipped); ' +
      c.remaining + ' left in the queue' + (c.refused ? ', ' + c.refused + ' passed over' : '') : '';
    const t = st ? s.trade : null;
    if (st !== 4) A.tMine = false;
    $('secTGrade').hidden = st !== 1; $('secTAdjust').hidden = !ownTools(st); $('secTResult').hidden = st !== 3 || !A.tres;
    $('secTPass').hidden = !(st === 4 && !A.tMine);
    $('tOwnHead').textContent = st === 4 ? 'Your trade instead' : 'Your trade';
    for (const b of document.querySelectorAll('#tLabelSeg button')) { b.disabled = st !== 1; b.classList.toggle('on', !!t && t.label === b.dataset.label); }
    for (const b of document.querySelectorAll('#tConfSeg button')) b.classList.toggle('on', String(A.tConf) === b.dataset.conf);
    $('btnTNext').disabled = !(st === 0 || st === 3) || !(c && c.remaining > 0);
    $('btnTSeen').disabled = st !== 1;
    $('tInfo').textContent = t ? '#' + t.n + '  ' + (t.level_type || 'level') + ' ' + fmtP(t.level_price) + '  ' + t.dir + '  bot: ' +
      (t.entry_order.side === 'sell' ? 'SELL ' : 'BUY ') + (TYPES[t.entry_order.type] || t.entry_order.type) + ' ' + fmtC(t.entry_order.price) +
      (t.entry_order.limit !== null && t.entry_order.limit !== undefined ? ' limit ' + fmtC(t.entry_order.limit) : '') : 'No trade open';
    $('tOpen').textContent = t ? 'opened in ' + t.open_ms + ' ms' + (t.prefetched ? ' (prefetched)' : '') : '';
    const on = new Set(ownTools(st) ? KEYS_ON[2] : KEYS_ON[st] || []);
    if (st === 0 && !(c && c.remaining > 0)) on.delete('N');
    for (const li of document.querySelectorAll('#tKeys li')) li.classList.toggle('off', !on.has(li.dataset.k));
    $('tKeyN').textContent = ownTools(st) ? 'save my trade' : st === 4 ? 'no trade, result' : 'next trade';
    sideNote();
    if (st === 3 && !A.tBusy && (!A.tres || A.tres.qid !== t.qid)) fetchResult(t.qid);
    if (st) tTick();
  }
  async function tTick(force) {
    if (A.tvBusy || (!force && performance.now() - A.tvAt < 400)) return;
    A.tvBusy = true; A.tvAt = performance.now();
    try { A.tview = await api('/api/trades/view'); } catch (e) { /* no trade open */ } finally { A.tvBusy = false; }
  }
  function clearResult() {
    A.tres = null;
    for (const id of ['tResHead', 'tResult', 'tOpinion', 'tYours']) $(id).textContent = '';
    $('tYours').hidden = true;
    $('tOpinionBox').hidden = true; $('secTResult').hidden = true;
  }
  // the result of the trade `qid` only: one that comes back after Next opened another trade is dropped, so no earlier
  // trade's date or result stays in the page while the next one is open
  async function fetchResult(qid) {
    if (A.tresBusy) return;
    A.tresBusy = true;
    try {
      const r = await api('/api/trades/result');
      const t = A.state && A.state.trade;
      if (r.qid === qid && !A.tBusy && t && t.qid === qid) showResult(r);
    } catch (e) { /* refused (409) once another trade is open: the next poll asks again if still due */ } finally { A.tresBusy = false; }
  }
  function showResult(r) {
    A.tres = r;
    $('tResHead').textContent = r.label + (r.yours && r.yours.kind === 'instead' ? ' saved, your trade instead.  ' : ' saved.  ') + r.date + '  trade ' + r.trade_id + '  ' + r.dir + ' ' + fmtC(r.entry) + ' at ' + r.entry_tod;
    const t = $('tResult'); t.textContent = '';
    head(t, ['Exit', 'Result', 'Points', 'R', 'At']);
    const tb = t.createTBody();
    for (const x of r.exits || []) {
      const tr = tb.insertRow();
      cell(tr, x.id); cell(tr, x.reason); cell(tr, signed(x.points), x.points > 0 ? 'win' : 'loss'); cell(tr, x.r === null || x.r === undefined ? '' : signed(x.r)); cell(tr, x.exit_tod);
    }
    showYours(r.yours);
    $('tOpinionBox').hidden = !r.notes;
    const o = r.second_opinion;
    $('tOpinion').textContent = !r.notes ? '' : o ? o.note + (o.score === null || o.score === undefined ? '' : '  (score ' + o.score + ')') : 'no second opinion for this trade';
    $('secTResult').hidden = false;
  }
  // his own trade in the reveal: a row under the bot's (YOU) and a line with the entry, the fill and the exit, in the accent
  function showYours(y) {
    const box = $('tYours');
    box.textContent = ''; box.hidden = !y;
    if (!y) return;
    const sp = y.spec || {};
    let text;
    if (y.error) text = 'Your trade: ' + y.error;
    else {
      text = 'Your trade' + (y.kind === 'instead' ? ' instead' : '') + ': ' + sp.dir + ' ' + (OWN_TYPES[sp.entry_type] || sp.entry_type) + ' ' + fmtC(sp.entry) +
        ', stop ' + fmtC(sp.stop) + ', target ' + (y.target === null || y.target === undefined ? '2R from the fill' : fmtC(y.target) + (y.target_kind === '2R' ? ' (2R)' : '')) + '. ';
      text += y.filled ? 'Filled ' + todOf(y.entry_t / 1000) + ' at ' + fmtC(y.entry) + '; ' +
        (y.exit_t === null || y.exit_t === undefined ? 'still open (' + y.reason + ')' : y.reason + ' ' + todOf(y.exit_t / 1000) + ' at ' + fmtC(y.exit) + ', ' + signed(y.points) + ' pts, ' + (y.r === null || y.r === undefined ? 'n/a' : signed(y.r)) + ' R') :
        'Not filled (' + y.reason + ').';
      const tb = $('tResult').tBodies[0] || $('tResult').createTBody(), tr = tb.insertRow();
      tr.className = 'you';
      cell(tr, 'YOU'); cell(tr, y.filled ? y.reason : 'no fill'); cell(tr, y.points === null || y.points === undefined ? '' : signed(y.points));
      cell(tr, y.r === null || y.r === undefined ? '' : signed(y.r)); cell(tr, y.exit_t === null || y.exit_t === undefined ? '' : todOf(y.exit_t / 1000));
    }
    box.textContent = text;
  }
  async function loadTrades() {
    try {
      const info = A.tinfo = await api('/api/trades/info');
      $('tMsg').textContent = info.ok ? info.bot + ', variant ' + info.variant : info.error ? 'Trades tab not available: ' + info.error : info.usage;
      const s = A.state;
      if (info.ok && !(s && s.mode === 'trades' && s.loaded) && info.counts && info.counts.remaining > 0) tNext();
    } catch (e) { say('tErr', e.message, true); }
  }
  async function tNext() {
    if (A.tBusy) return;
    A.tBusy = true; clearResult(); A.tview = null; disarmSeen();
    try {
      const s = await act('/api/trades/next', {}, { remount: true, reset: true });
      if (s) { tTick(true); if (s.passed_over && s.passed_over.length) say('tErr', s.passed_over.length + ' trade(s) passed over: ' + s.passed_over.join('; '), true); }
    } finally { A.tBusy = false; }
  }
  async function tSave1(label) {
    if (A.tBusy) return;
    A.tBusy = true;
    try {
      const r = await api('/api/trades/save1', { label, chips: [...A.chipOn], reason: $('tReason').value, confidence: A.tConf });
      say('tErr', '');
      await refresh();
      if (r.complete && A.state.trade) fetchResult(A.state.trade.qid);
    } catch (e) { say('tErr', e.message, true); } finally { A.tBusy = false; }
  }
  async function tSave2() {
    if (A.tBusy) return;
    const mine = tStage(A.state) === 4;
    const marks = A.marks.filter(m => ['Entry', 'Stop', 'Target'].includes(m.role));
    if (!marks.some(m => m.role === 'Entry') || !marks.some(m => m.role === 'Stop')) { say('tErr', 'Mark your Entry (E) and Stop (S) first.', true); return; }
    A.tBusy = true;
    try {
      const type = (document.querySelector('input[name=tEntryType]:checked') || {}).value;
      await api(mine ? '/api/trades/save_mine' : '/api/trades/save2', { entry_type: type, marks });
      say('tErr', ''); setTool(null);
      await refresh();
      if (A.state.trade) fetchResult(A.state.trade.qid);
    } catch (e) { say('tErr', e.message, true); } finally { A.tBusy = false; }
  }
  // after a PASS, no trade of his own (N, Enter or Esc): recorded, then the result shows
  async function tSkipMine() {
    if (A.tBusy) return;
    A.tBusy = true;
    try {
      await api('/api/trades/skip_mine', {});
      A.marks = A.marks.filter(m => !OWN_ROLES.includes(m.role)); A.tMine = false; setTool(null); renderMarks(); say('tErr', '');
      await refresh();
      if (A.state.trade) fetchResult(A.state.trade.qid);
    } catch (e) { say('tErr', e.message, true); } finally { A.tBusy = false; }
  }
  function disarmSeen() { A.tSeenArm = false; $('btnTSeen').firstChild.textContent = 'Seen this day before '; }
  async function tSeen() {
    if (!A.tSeenArm) {
      A.tSeenArm = true; $('btnTSeen').firstChild.textContent = 'Confirm: seen this day ';
      say('tErr', 'Press X again to skip every trade of this day (Esc cancels).', true); return;
    }
    disarmSeen();
    if (A.tBusy) return;
    try { showState(await api('/api/trades/skip_day', {})); unmount(); resetForm(); } catch (e) { say('tErr', e.message, true); return; }
    tNext();
  }
  function tradeKey(e) {
    const st = tStage(A.state), K = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    const done = () => e.preventDefault();
    if (K !== 'X' && A.tSeenArm) { disarmSeen(); say('tErr', ''); }
    if (st === 1) {
      if (K === 'T') { done(); tSave1('TAKE'); } else if (K === 'A') { done(); tSave1('ADJUST'); } else if (K === 'P') { done(); tSave1('PASS'); }
      else if (K >= '1' && K <= '3') { done(); A.tConf = A.tConf === +K ? null : +K; showState(A.state); }
      else if (K === 'X') { done(); tSeen(); }
    } else if (st === 4 && !A.tMine) {
      if (K === 'M') { done(); A.tMine = true; showState(A.state); }
      else if (K === 'ArrowRight') { done(); act('/api/step'); }
      else if (K === 'Enter' || K === 'N') { done(); tSkipMine(); }
    } else if (st === 2 || st === 4) {
      const role = { E: 'Entry', S: 'Stop', G: 'Target' }[K];
      if (role) { done(); setTool(A.tool && A.tool.role === role ? null : { role, span: false }); }
      else if (K >= '1' && K <= '4') { done(); const el = document.querySelector('input[name=tEntryType][value="' + ['stop-limit', 'stop-market', 'limit', 'market'][+K - 1] + '"]'); if (el) el.checked = true; }
      else if (K === 'ArrowRight') { done(); act('/api/step'); }
      else if (K === 'Enter' || K === 'N') { done(); tSave2(); }
    } else if (K === 'Enter' || K === 'N') { done(); if (st === 0 || st === 3) tNext(); }
    else if (K === ' ' && st === 3) { done(); act('/api/reveal'); }
  }
  async function loadDays() {
    try {
      const { days } = await api('/api/days');
      const sel = $('freeDay'), cur = sel.value; sel.textContent = '';
      for (const d of days.slice().reverse()) { const o = document.createElement('option'); o.value = o.textContent = d; sel.appendChild(o); }
      if (cur) sel.value = cur;
    } catch (e) { say('saveMsg', e.message, true); }
  }
  async function machine() {
    if (A.uiMode !== 'free' || !A.state || !A.state.loaded) return;
    const lm = A.marks.find(m => m.role === 'Level');
    const q = lm ? '?level=' + lm.price : '';
    try { showMachine(await api('/api/machine' + q)); } catch (e) { /* shown on the next try */ }
  }
  const MR_ROWS = [['clock_tod', 'Clock'], ['sweep', 'Sweep'], ['cross_tod', 'First cross'], ['volume_basis', 'Volume basis'],
    ['into_level_windows', 'Into level, 5 one-minute windows (oldest first)'], ['into_level_slope_per_min', 'Slope (contracts per min; below 0 drying up)'],
    ['probe_into_rate_per_min', 'Probe, into level per min'], ['pre2_into_rate_per_min', '2 min before cross, per min'], ['probe_vs_pre2', 'Probe vs 2 min before'],
    ['depth_points', 'Depth beyond level (points)'], ['atr14_5m', 'ATR 14, 5 min (Wilder)'], ['depth_atr', 'Depth in ATR'], ['probe_seconds', 'Probe time (s)'],
    ['approach_2m_points', 'Approach, 2 min (points)'], ['approach_5m_points', 'Approach, 5 min (points)'], ['approach_points_per_min_2m', 'Points per min, last 2 min'],
    ['efficiency_5m', 'Efficiency ratio, 5 min'], ['reclaim', 'Reclaim'], ['confirmation', 'Confirmation (next candle breaks the failed candle)'],
    ['entry_a', 'Entry A (reclaim close)'], ['entry_b', 'Entry B (confirmation break)'], ['earlier_touches_today', 'Earlier touches today']];
  function showMachine(mr) {
    const t = $('machineOut'); t.textContent = '';
    $('secMachine').hidden = false;
    $('machineNote').textContent = mr && mr.ok ? '(ticks up to the clock only)' : '';
    if (!mr || !mr.ok) { const tr = t.insertRow(); tr.insertCell().textContent = (mr && mr.why) || 'no read'; return; }
    for (const [k, label] of MR_ROWS) {
      const v = mr[k], tr = t.insertRow();
      tr.insertCell().textContent = label;
      tr.insertCell().textContent = v === null || v === undefined ? 'n/a' : Array.isArray(v) ? v.join(' ') : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v);
    }
  }
  function showDraft(d, agrees) {
    $('secDraft').hidden = false;
    const el = $('draftOut'); el.textContent = '';
    const v = document.createElement('div'); v.className = 'verdict' + (d.verdict === 'TAKE' ? ' take' : ''); v.textContent = d.verdict + (agrees === undefined ? '' : agrees ? '  (agrees with you)' : '  (differs from you)');
    el.appendChild(v);
    for (const w of d.why || []) { const p = document.createElement('div'); p.className = 'ms-line dim'; p.textContent = w; el.appendChild(p); }
    if (d.entry_a !== null && d.entry_a !== undefined) { const p = document.createElement('div'); p.className = 'ms-line'; p.textContent = 'Entry A ' + fmtP(d.entry_a) + ', entry B ' + fmtP(d.entry_b); el.appendChild(p); }
  }
  function showAgreement(a) {
    $('agreeOut').textContent = a.total ? a.agree + ' of ' + a.total + ' agree (' + Math.round(100 * a.agree / a.total) + '%)' : 'none yet';
    const ul = $('disList'); ul.textContent = '';
    for (const d of a.disagreements.slice(-20).reverse()) {
      const li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button'; b.textContent = (d.date ? d.date + ' ' : '') + (d.tod || '') + '  You ' + d.setup + ', draft ' + d.verdict + ' (open in free mode)';
      b.addEventListener('click', async () => {
        if (A.state && A.state.blind_open) { say('saveMsg', 'Save the grade first, then use Free mode.', true); return; }
        const st = await act('/api/free/open', { ref: d.ref }, { remount: true, reset: true });
        if (st) { setMode('free'); machine(); }
      });
      li.appendChild(b); ul.appendChild(li);
    }
  }

  async function save(e) {
    e.preventDefault();
    const f = $('gradeForm'), setup = (f.querySelector('input[name=setup]:checked') || {}).value, dir = (f.querySelector('input[name=direction]:checked') || {}).value;
    const body = { setup, direction: dir || null, reason: $('reason').value, chips: [...A.chipOn], marks: A.marks, spans: A.spans };
    try {
      const r = await api('/markup/save', body);
      A.saved = true;
      say('saveMsg', 'Saved ' + r.file);
      showDraft(r.draft, r.agrees_with_draft);
      showMachine(r.machine_read);
      showAgreement(r.agreement);
      await refresh();
    } catch (err) { say('saveMsg', err.message, true); }
  }

  function onKey(e) {
    if (e.key === 'Escape' && (A.tool || A.spanDraft)) { setTool(null); e.preventDefault(); return; }
    if (e.key === 'Escape' && A.uiMode === 'trades') {
      if (document.activeElement === $('tReason')) $('tReason').blur();
      if (A.tSeenArm) { disarmSeen(); say('tErr', ''); }
      else if (tStage(A.state) === 4) { e.preventDefault(); tSkipMine(); }       // Esc after a PASS: no trade of his own
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    const t = e.target, tag = t && t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && t.type !== 'radio') || (t && t.isContentEditable)) return;
    if (A.uiMode === 'trades') { tradeKey(e); return; }
    const pick = (name, v) => { const el = document.querySelector('input[name=' + name + '][value=' + v + ']'); if (el) { el.checked = true; e.preventDefault(); } };
    if (e.key >= '1' && e.key <= '4') pick('setup', ['SWEEP', 'RETEST', 'NONE', 'WAIT'][+e.key - 1]);
    else if (e.key === 'l' || e.key === 'L') pick('direction', 'LONG');
    else if (e.key === 's' || e.key === 'S') pick('direction', 'SHORT');
  }

  function init() {
    buildTools();
    instReady.then(i => { $('msInst').textContent = i.name || i.root + ' replay'; });
    $('tabBlind').addEventListener('click', () => setMode('blind'));
    $('tabFree').addEventListener('click', () => setMode('free'));
    $('tabBot').addEventListener('click', () => setMode('bot'));
    $('tabTrades').addEventListener('click', () => setMode('trades'));
    $('btnTNext').addEventListener('click', () => tNext());
    $('btnTSeen').addEventListener('click', () => tSeen());
    $('btnTSave2').addEventListener('click', () => tSave2());
    for (const b of document.querySelectorAll('#tLabelSeg button')) b.addEventListener('click', () => tSave1(b.dataset.label));
    for (const b of document.querySelectorAll('#tConfSeg button')) b.addEventListener('click', () => { A.tConf = A.tConf === +b.dataset.conf ? null : +b.dataset.conf; showState(A.state); });
    for (const [r, k] of [['Entry', 'E'], ['Stop', 'S'], ['Target', 'G']]) {
      const b = document.createElement('button'), kb = document.createElement('kbd');
      b.type = 'button'; b.className = 'ms-btn'; b.dataset.role = r; kb.textContent = k; b.append(r + ' ', kb);
      b.addEventListener('click', () => setTool(A.tool && A.tool.role === r ? null : { role: r, span: false }));
      $('tMarkTools').appendChild(b);
    }
    $('btnBotLoad').addEventListener('click', async () => {
      say('botErr', ''); A.bot = null; $('botSummary').hidden = true;
      if (await act('/api/bot/load', { date: $('botDay').value, variant: $('botVariant').value }, { remount: true, reset: true })) botTick(true);
    });
    $('btnRunAll').addEventListener('click', async () => {
      try { await api('/api/bot/runall', {}); A.runallWas = true; $('runAllMsg').textContent = 'starting'; } catch (e) { say('botExportMsg', e.message, true); }
    });
    $('btnBotExport').addEventListener('click', async () => {
      try { const r = await api('/api/bot/export', {}); say('botExportMsg', 'Files (' + r.files.join(', ') + ') in ' + r.folder); } catch (e) { say('botExportMsg', e.message, true); }
    });
    $('btnSumClose').addEventListener('click', () => { $('botSummary').hidden = true; });
    api('/api/bot/info').then(info => {
      A.botInfo = info;
      const sel = $('botVariant'); sel.textContent = '';
      for (const v of info.variants || []) { const o = document.createElement('option'); o.value = v.id; o.textContent = v.label; sel.appendChild(o); }
      if (A.uiMode === 'bot') loadBotDays();
    }).catch(() => {});
    $('btnNext').addEventListener('click', async () => {
      if (await act('/api/blind/next', {}, { remount: true, reset: true })) api('/api/agreement').then(showAgreement).catch(() => {});
    });
    $('btnLoad').addEventListener('click', async () => { await act('/api/free/load', { date: $('freeDay').value, time: $('freeTime').value }, { remount: true, reset: true }); machine(); });
    $('btnStep').addEventListener('click', () => act('/api/step'));
    for (const b of document.querySelectorAll('[data-speed]')) b.addEventListener('click', () => act('/api/play', { speed: +b.dataset.speed }));
    $('btnPause').addEventListener('click', () => act('/api/pause'));
    $('btnPause2').addEventListener('click', () => act('/api/pause'));
    $('btnJump').addEventListener('click', () => act('/api/jump', { time: $('jumpTime').value }, { remount: true }));
    $('btnReveal').addEventListener('click', () => act('/api/reveal'));
    $('btnJump30').addEventListener('click', () => act('/api/jump', { minutes: 30 }, { remount: true }));
    $('gradeForm').addEventListener('submit', save);
    $('chipAdd').addEventListener('click', async () => {
      try { A.chips = (await api('/api/chips', { text: $('chipNew').value })).chips; A.chipOn.add($('chipNew').value.trim()); $('chipNew').value = ''; renderChips(); } catch (e) { say('saveMsg', e.message, true); }
    });
    $('btnExport').addEventListener('click', async () => { try { const r = await api('/api/export', {}); say('exportMsg', r.rows + ' rows to ' + r.file); } catch (e) { say('exportMsg', e.message, true); } });
    document.addEventListener('keydown', onKey);
    api('/api/chips').then(r => { A.chips = r.chips; renderChips(); }).catch(() => {});
    api('/api/agreement').then(showAgreement).catch(() => {});
    A.agreeTimer = setInterval(() => { if (A.state && A.state.mode === 'free') api('/api/agreement').then(showAgreement).catch(() => {}); }, 15000);
    setInterval(refresh, 250);
    A.machineTimer = setInterval(machine, 2000);
    refresh().then(() => {
      const st = A.state;
      if (st && st.loaded && (st.mode === 'free' || st.mode === 'bot' || st.mode === 'trades')) { setMode(st.mode); mount(); } else if (st && st.loaded && st.mode === 'blind') mount();
      else if (st && st.trades && st.trades.ready && !st.blind_open) setMode('trades');      // started for the Trades tab: straight to the next trade
    });
    requestAnimationFrame(draw);
  }
  document.addEventListener('DOMContentLoaded', init);
})();
