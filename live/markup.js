/*
 * Markup Studio page (live/markup.html, served by tools/markup_studio.py). Read only: no order path exists here.
 *
 * Loaded first, before the chart files:
 *  1. The page's clock follows the REPLAY clock. live.js reads Date.now() for "now" (the session, VWAP day, range-bar tick
 *     hours, the bar countdown), so Date.now() is set to the server's replay clock (advancing at the play speed, still
 *     while paused). Only this page does this; the chart files are unchanged.
 *  2. Blind mode never shows a date: every text the charts draw on their canvases and every text or tooltip in the page
 *     goes through scrub(), which keeps the time of day and drops dates, weekdays and month names.
 * Then the app: two charts mounted read only with ChartLive.mount (live/EMBED.md), Range 40 and 1 minute, NQ; the grade
 * panel; marks drawn on an overlay above each chart.
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
  const TICK = 0.25;
  const A = { state: null, panes: {}, overlays: {}, tool: null, spanDraft: null, marks: [], spans: [], chips: [], chipOn: new Set(),
    lastMount: '', machineTimer: 0, saved: false, uiMode: 'blind' };
  window.__markup = A;

  async function api(path, body) {
    const r = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }
  const say = (id, text, err) => { const el = $(id); el.textContent = text || ''; el.classList.toggle('err', !!err); };
  const fmtP = p => (p === null || p === undefined || !isFinite(p)) ? '' : (+p).toFixed(2);
  const todOf = t => { const s = ((Math.floor(t) % 86400) + 86400) % 86400; return [s / 3600 | 0, s / 60 % 60 | 0, s % 60].map(x => String(x).padStart(2, '0')).join(':'); };

  /* ---------------- the charts */
  function unmount() {
    for (const k of Object.keys(A.panes)) { try { A.panes[k].destroy(); } catch (e) { /* gone */ } }
    A.panes = {}; A.overlays = {};
  }
  function mount() {
    unmount();
    const wsUrl = () => 'ws://' + location.host + '/ws';
    const opts = (prefix, tf) => ({ wsUrl, paneId: 'main', storagePrefix: prefix, view: { root: 'NQ', tf, range: 40 }, compact: true, toolbar: false });
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
    const price = Math.round(ch.yToPrice(y) / TICK) * TICK;
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
    for (const ov of Object.values(A.overlays)) {
      const w = ov.host.clientWidth, h = ov.host.clientHeight, dpr = window.devicePixelRatio || 1;
      if (ov.cv.width !== Math.round(w * dpr) || ov.cv.height !== Math.round(h * dpr)) { ov.cv.width = Math.round(w * dpr); ov.cv.height = Math.round(h * dpr); }
      const g = ov.cv.getContext('2d'), ch = ov.pane.chart;
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
      for (const m of A.marks) {
        const i = barIndexAt(ch, m.t);
        if (i < 0) continue;
        const x = ch.barToX(i), y = ch.priceToY(m.price), c = COLORS[m.role] || '#fff';
        g.fillStyle = c; g.strokeStyle = '#06080C'; g.lineWidth = 1;
        g.beginPath(); g.arc(x, y, 4.5, 0, Math.PI * 2); g.fill(); g.stroke();
        g.fillText(m.role, x + 8, y);
      }
    }
    requestAnimationFrame(draw);
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
    const ul = $('markList'); ul.textContent = '';
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
    const box = $('chips'); box.textContent = '';
    for (const c of A.chips) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ms-chip' + (A.chipOn.has(c) ? ' on' : ''); b.textContent = c;
      b.addEventListener('click', () => { if (A.chipOn.has(c)) A.chipOn.delete(c); else A.chipOn.add(c); renderChips(); });
      box.appendChild(b);
    }
  }
  function resetForm() {
    $('gradeForm').reset(); A.chipOn.clear(); A.marks = []; A.spans = []; A.saved = false;
    renderChips(); renderMarks(); setTool(null); say('saveMsg', '');
    $('secDraft').hidden = true; $('secMachine').hidden = A.uiMode === 'blind';
  }

  /* ---------------- state and modes */
  function showState(s) {
    A.state = s;
    const free = s.mode === 'free';
    setClock(s.clock_utc_ms || realNow(), s.playing ? s.speed : 0);
    $('msClock').textContent = s.clock_tod || '--:--:--';
    $('msDate').textContent = free && s.date ? s.date : '';
    $('msPlay').textContent = s.playing ? s.speed + 'x' : '';
    const sc = s.scan || {};
    $('msStatus').textContent = sc.error ? 'Scan failed: ' + sc.error : !sc.done ? 'Finding candidates: ' + (sc.days || 0) + ' of ' + (sc.total || '?') + ' days' :
      'Excluded ' + (s.queue ? s.queue.excluded_seen : 0) + ' already-seen';
    $('btnNext').disabled = !sc.done;
    if (s.queue) $('queueInfo').textContent = 'remaining ' + s.queue.remaining + ', graded ' + s.queue.graded + ', excluded ' + s.queue.excluded_seen + ' already-seen';
    const blindLive = s.mode === 'blind' && s.loaded && !s.graded;
    $('candInfo').textContent = s.mode === 'blind' && s.candidate && s.level ? '#' + s.candidate.n + '  Level ' + s.level.type + ' ' + fmtP(s.level.price) : 'No candidate open';
    $('stepCount').textContent = s.mode === 'blind' && s.loaded ? 'steps after cut: ' + s.steps : '';
    $('btnStep').disabled = !s.loaded;
    $('playRow').hidden = $('jumpRow').hidden = !free;
    $('revealRow').hidden = !(s.mode === 'blind' && s.graded);
    $('btnSave').disabled = !s.loaded || (s.mode === 'blind' && s.graded);
    if (blindLive) $('secMachine').hidden = true;
  }
  async function refresh() {
    try { showState(await api('/api/state')); } catch (e) { $('msStatus').textContent = 'Studio not reachable: ' + e.message; }
  }
  async function act(path, body, opts) {
    try {
      const s = await api(path, body || {});
      showState(s);
      if (opts && opts.remount) { if (opts.reset) resetForm(); mount(); }
      return s;
    } catch (e) { say('saveMsg', e.message, true); return null; }
  }
  function setMode(m) {
    A.uiMode = m;
    BLIND = m === 'blind';
    $('tabBlind').classList.toggle('on', BLIND); $('tabFree').classList.toggle('on', !BLIND);
    $('tabBlind').setAttribute('aria-selected', String(BLIND)); $('tabFree').setAttribute('aria-selected', String(!BLIND));
    $('secBlind').hidden = !BLIND; $('secFree').hidden = BLIND;
    $('secMachine').hidden = BLIND;
    if (BLIND) { scrubNode(document.body); if (A.state && A.state.mode === 'free') { unmount(); resetForm(); } }
    else loadDays();
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
      b.type = 'button'; b.textContent = 'You ' + d.setup + ', draft ' + d.verdict + ' (open in free mode)';
      b.addEventListener('click', async () => { setMode('free'); await act('/api/free/open', { id: d.id }, { remount: true, reset: true }); machine(); });
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
      say('saveMsg', 'Saved ' + r.file.split(/[\\/]/).pop());
      showDraft(r.draft, r.agrees_with_draft);
      showMachine(r.machine_read);
      showAgreement(r.agreement);
      await refresh();
    } catch (err) { say('saveMsg', err.message, true); }
  }

  function onKey(e) {
    if (e.key === 'Escape' && (A.tool || A.spanDraft)) { setTool(null); e.preventDefault(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    const t = e.target, tag = t && t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && t.type !== 'radio') || (t && t.isContentEditable)) return;
    const pick = (name, v) => { const el = document.querySelector('input[name=' + name + '][value=' + v + ']'); if (el) { el.checked = true; e.preventDefault(); } };
    if (e.key >= '1' && e.key <= '4') pick('setup', ['SWEEP', 'RETEST', 'NONE', 'WAIT'][+e.key - 1]);
    else if (e.key === 'l' || e.key === 'L') pick('direction', 'LONG');
    else if (e.key === 's' || e.key === 'S') pick('direction', 'SHORT');
  }

  function init() {
    buildTools();
    $('tabBlind').addEventListener('click', () => setMode('blind'));
    $('tabFree').addEventListener('click', () => setMode('free'));
    $('btnNext').addEventListener('click', () => act('/api/blind/next', {}, { remount: true, reset: true }));
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
    setInterval(refresh, 250);
    A.machineTimer = setInterval(machine, 2000);
    refresh().then(() => { if (A.state && A.state.loaded && A.state.mode === 'free') { setMode('free'); mount(); } else if (A.state && A.state.loaded && A.state.mode === 'blind') mount(); });
    requestAnimationFrame(draw);
  }
  document.addEventListener('DOMContentLoaded', init);
})();
