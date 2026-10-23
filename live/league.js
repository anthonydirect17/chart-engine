/*
 * The league (chart 1.35.0, Anthony 2026-10-21, Bot-Lab notes/DECISIONS_bot_division.md "SHADOW LEAGUE: WHERE IT RUNS AND HOW IT
 * SHOWS", and his ruling of the same day: keep the Agent tab as it is and add the league as a second top-level tab): the top
 * bar's League tab, beside the Agent tab, and the league's trades, faint, on any chart (a switch in each chart's ⋯ menu, off by
 * default).
 *
 * The shadow league runs on the WORK PC as its own process: three seats identical but for the judge model, H (Haiku, amber),
 * S (Sonnet, cyan), O (Opus, violet), each trading on paper. Nothing here sends an order and nothing here can: the page only
 * reads The Desk's GET /api/chart-league (TheDesk docs/API.md "Shadow league"), which serves the league's own files read only:
 * status.json, the day's paper trades (closed and open), its decisions, and the standings. "SHADOW: no orders" is on the view.
 *
 * The League button shows once The Desk answers GET /api/chart-league (a Desk of this release, reachable from this PC); with no such
 * Desk it stays hidden and the top bar keeps its room.
 *
 * The view: one chart, NQ 1 min (1.38.1, Anthony 2026-10-23: his only MNQ chart is a 40-range execution chart and every other
 * chart, a 1 min among them, is NQ; so the League chart is NQ 1 min with {days: 5, tickHours: 0}, the load his NQ 1 min chart
 * already holds, and opens at once with no NinjaTrader request of its own). The league trades MNQ: its marks are drawn at their
 * MNQ prices on the NQ candles (the same index, no conversion), and the chart's label says so. Each seat's paper trades as hollow markers
 * carrying its letter in its colour (a circle at the fill, a diamond at the exit) and faint stop and target lines from the fill
 * to the exit (or to now while open); the legend strip; each seat's day (its position, its virtual 50K Flex account, its
 * decisions, a flag for Anthony); the week and month table with agreement and decision time; the decision log; the API spend
 * against the caps. The chart's look is the chart's own: the marks are an overlay canvas over it, drawn after each frame the
 * chart draws (its `drawn` event), never part of the engine.
 *
 * Times: the league's are New York wall-clock milliseconds stored as if UTC, the chart's own convention times 1000.
 *
 * Two parts, as workspace.js: LeagueCore (pure: Node tests, test/league.test.js) and, in a browser, LeagueOverlay (the marks
 * over a chart) and LeagueView (the tab).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LeagueCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const SHADOW = 'SHADOW: no orders';
/* Anthony's letters and colours (amber, cyan, violet); the colours appear only in the league's own marks and legend */
const SEATS = [
  { id: 'H', family: 'Haiku', color: '#FFC266' },
  { id: 'S', family: 'Sonnet', color: '#5DE0F0' },
  { id: 'O', family: 'Opus', color: '#B69CFF' },
];
const SEAT = Object.fromEntries(SEATS.map(s => [s.id, s]));
const ROOTS = ['MNQ', 'NQ'];               // the league trades MNQ; NQ is one instrument with it (its prices are the same)
const GHOST_KEY = 'live-league-ghost-v1';   // the charts whose ⋯ switch shows the league's trades, faint: { panelId: true }
const isNum = v => typeof v === 'number' && isFinite(v);
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n || 200) : '');

/** One paper trade as the page uses it, or null. */
function cleanTrade(t, open) {
  if (!t || typeof t !== 'object' || !SEAT[t.seat] || (t.side !== 'long' && t.side !== 'short')) return null;
  if (!isNum(t.fill_t) || !isNum(t.fill_px)) return null;
  return { id: str(t.id, 64), seat: t.seat, side: t.side, contracts: isNum(t.contracts) ? t.contracts : null, fillT: t.fill_t, fillPx: t.fill_px,
    stopPx: isNum(t.stop_px) ? t.stop_px : null, targetPx: isNum(t.target_px) ? t.target_px : null,
    /* the trade's ORIGINAL risk (1.36.0 review: the Agents strip's open R): the league's risk_dollars and the stop distance at
       the fill; stop_px moves with break-even and the trail, so it is never the risk */
    riskDollars: isNum(t.risk_dollars) && t.risk_dollars > 0 ? t.risk_dollars : null, stopPoints: isNum(t.stop_points) && t.stop_points > 0 ? t.stop_points : null,
    exitT: !open && isNum(t.exit_t) ? t.exit_t : null, exitPx: !open && isNum(t.exit_px) ? t.exit_px : null, exitReason: str(t.exit_reason, 80),
    r: isNum(t.r) ? t.r : null, open: !!open, relation: ['own', 'with', 'against'].includes(t.relation) ? t.relation : null, crashCut: t.crash_cut === true,
    reference: str(t.reference, 40) };
}

/**
 * The Desk's GET /api/chart-league as the view uses it: { date, problem, status, day, league, trades, open, decisions }. Never
 * throws. `problem` is what to say when there is nothing (no folder set, no session yet), else ''.
 */
function cleanDay(j) {
  const out = { date: '', problem: '', status: null, day: null, league: null, trades: [], open: [], decisions: [] };
  if (!j || typeof j !== 'object') { out.problem = 'The Desk sent nothing the page can read.'; return out; }
  out.date = typeof j.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(j.date) ? j.date : '';
  const f = j.folder && typeof j.folder === 'object' ? j.folder : {};
  if (f.set === false) out.problem = 'The league\'s folder is not set on The Desk (Lab, Shadow league, on WORK).';
  else if (typeof f.problem === 'string' && f.problem) out.problem = f.problem.slice(0, 200);
  out.status = j.status && typeof j.status === 'object' ? j.status : null;
  out.day = j.day && typeof j.day === 'object' ? { closed: j.day.closed === true, note: str(j.day.note, 300) } : null;
  out.league = j.league && typeof j.league === 'object' ? j.league : null;
  out.trades = (Array.isArray(j.trades) ? j.trades : []).map(t => cleanTrade(t, false)).filter(Boolean);
  out.open = (Array.isArray(j.open) ? j.open : []).map(t => cleanTrade(t, true)).filter(Boolean);
  out.decisions = (Array.isArray(j.decisions) ? j.decisions : []).filter(d => d && SEAT[d.seat]).slice(-500);
  return out;
}

/**
 * What the overlay draws for a chart of `root`, from a cleaned day: [{ seat, color, letter, kind: 'entry' | 'exit', t (chart
 * seconds), price, side }] and lines [{ seat, color, kind: 'stop' | 'target', t0, t1 (null: to the right edge), price }].
 * Nothing for a root the league does not trade.
 */
function marksFor(day, root) {
  const out = { marks: [], lines: [] };
  if (!day || !ROOTS.includes(root)) return out;
  for (const t of day.trades.concat(day.open)) {
    const c = SEAT[t.seat].color, t0 = t.fillT / 1000, t1 = t.exitT === null ? null : t.exitT / 1000;
    out.marks.push({ seat: t.seat, color: c, letter: t.seat, kind: 'entry', t: t0, price: t.fillPx, side: t.side });
    if (t.exitT !== null && t.exitPx !== null) out.marks.push({ seat: t.seat, color: c, letter: t.seat, kind: 'exit', t: t1, price: t.exitPx, side: t.side });
    if (t.stopPx !== null) out.lines.push({ seat: t.seat, color: c, kind: 'stop', t0, t1, price: t.stopPx });
    if (t.targetPx !== null) out.lines.push({ seat: t.seat, color: c, kind: 'target', t0, t1, price: t.targetPx });
  }
  return out;
}

/** The index of the bar holding chart time t (seconds): the last bar starting at or before t, or -1. Bars are oldest first. */
function barIndex(bars, t) {
  let lo = 0, hi = (bars ? bars.length : 0) - 1, hit = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (bars[mid].t <= t) { hit = mid; lo = mid + 1; } else hi = mid - 1; }
  return hit;
}

const money = v => (isNum(v) ? (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');
const signedR = v => (isNum(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) + ' R' : '');

/** A decision log row: { time, seat, text, kind ('enter' | 'rest' | 'cancel' | 'pass' | 'refused' | 'failed'), latency }. Newest first.
    1.36.0: a "rest" answer (a resting entry, PREREG Amendment 6) is shown as a resting order, never as an entry; "cancel" as
    the cancel of one. The Desk passes no good-until time with a decision: "good until not reported". */
function decisionRows(decisions, most) {
  const out = [];
  for (const d of (decisions || []).slice().reverse()) {
    if (out.length >= (most || 60)) break;
    const a = d.answer && typeof d.answer === 'object' ? d.answer : {};
    let kind, text;
    if (!d.call_ok) { kind = 'failed'; text = 'no answer (the call failed)'; }
    else if (d.refused) { kind = 'refused'; text = 'refused: ' + str(d.refused, 160); }
    else if (a.action === 'pass') { kind = 'pass'; text = 'passed' + (a.reasoning ? ': ' + str(a.reasoning, 200) : ''); }
    else if (a.action === 'cancel') { kind = 'cancel'; text = 'cancelled its resting order' + (a.reasoning ? ': ' + str(a.reasoning, 200) : ''); }
    else if (a.action === 'rest') { kind = 'rest'; text = 'rest ' + (a.side === 'short' ? 'short' : 'long') + (a.reference ? ' at ' + str(a.reference, 30) : '') +
      (isNum(a.stop_points) ? ', stop ' + a.stop_points + ' pt' : '') + (isNum(a.target_points) ? ', target ' + a.target_points + ' pt' : ', no target') + ', good until not reported' + (a.reasoning ? ': ' + str(a.reasoning, 200) : ''); }
    else { kind = 'enter'; text = (a.side === 'short' ? 'short' : 'long') + (isNum(d.contracts) ? ' ' + d.contracts + ' MNQ' : '') + (isNum(a.stop_points) ? ', stop ' + a.stop_points + ' pt' : '') +
      (isNum(a.target_points) ? ', target ' + a.target_points + ' pt' : ', no target') + (a.reference ? ' at ' + str(a.reference, 30) : '') + (a.reasoning ? ': ' + str(a.reasoning, 200) : ''); }
    if (d.relation === 'with') text += ' (with you)'; else if (d.relation === 'against') text += ' (against you)';
    out.push({ time: str(d.time, 8).slice(0, 5), seat: d.seat, kind, text, latency: isNum(d.latency_s) ? d.latency_s : null, trigger: str(d.trigger, 60) });
  }
  return out;
}

/** Each seat's day from status.json and the day's trades: { seat, family, color, line, account, flag, stopped, todayR, n }. */
function seatDays(day) {
  const st = day && day.status && day.status.seats && typeof day.status.seats === 'object' ? day.status.seats : {};
  return SEATS.map(s => {
    const x = st[s.id] && typeof st[s.id] === 'object' ? st[s.id] : null;
    const mine = (day ? day.trades : []).filter(t => t.seat === s.id && t.r !== null && !t.crashCut);
    const todayR = mine.length ? mine.reduce((a, t) => a + t.r, 0) : null;
    const pos = x && x.position && typeof x.position === 'object' ? x.position : null;
    const fx = x && x.flex && typeof x.flex === 'object' ? x.flex : null;
    const line = !x ? 'not reported' : pos ? (pos.side === 'short' ? 'SHORT ' : 'LONG ') + (isNum(pos.contracts) ? pos.contracts + ' MNQ' : '') + (isNum(pos.fill_px) ? ' from ' + pos.fill_px : '')
      : x.api_stopped ? 'API stopped: ' + str(x.api_stopped, 120) : x.stopped ? 'stopped: ' + str(x.stopped, 120) : 'flat';
    return { seat: s.id, family: s.family, color: s.color, line, flag: x && typeof x.flag === 'string' ? x.flag.slice(0, 200) : '',
      account: fx ? str(String(fx.phase || ''), 10) + (isNum(fx.balance) ? ' · ' + money(fx.balance) : '') + (isNum(fx.today_pnl) ? ' · today ' + money(fx.today_pnl) : '') : '',
      decisions: x && isNum(x.decisions) ? x.decisions : null, entries: x && isNum(x.entries) ? x.entries : null, todayR, n: mine.length };
  });
}

/** The standings table's rows (week, month, agreement, decision time) from the league's standings; "not enough data yet" under its 20. */
function standingRows(league) {
  const seats = league && league.seats && typeof league.seats === 'object' ? league.seats : {};
  const enough = league && isNum(league.enough_n) ? league.enough_n : 20;
  const cell = d => (!d || !isNum(d.n) || !d.n ? 'n 0' : !d.enough || !isNum(d.mean_r) ? 'not enough data yet (n ' + d.n + ' of ' + enough + ')' : signedR(d.mean_r) + ' (n ' + d.n + ')');
  return SEATS.map(s => {
    const x = seats[s.id] || {};
    const r = x.rolling || {};
    const m = x.mentor || {};
    const lat = x.latency || {};
    return { seat: s.id, family: s.family, color: s.color, week: cell(r.week), month: cell(r.month), all: cell(x.score),
      agreement: isNum(m.agreement) ? Math.round(m.agreement * 100) + '%' : 'none yet',
      latency: isNum(lat.median_s) ? lat.median_s + ' s median (n ' + (lat.n || 0) + ')' : 'no call yet',
      fence: x.fences && isNum(x.fences.cleared) ? 'cleared fence ' + x.fences.cleared + ' (a signal)' : '' };
  });
}

/** The spend against the caps, in words: { day, month, stopped }. */
function spendText(spend) {
  if (!spend || typeof spend !== 'object') return { day: 'not reported', month: 'not reported', stopped: '' };
  const cap = (v, c) => money(v) + ' of ' + money(isNum(c) ? c : 0);
  return { day: cap(spend.day_spent, spend.day_cap), month: cap(spend.month_spent, spend.month_cap), stopped: spend.stopped ? 'API stopped: ' + str(spend.stopped, 200) : '' };
}

/** The charts whose switch is on, from this browser's copy (never throws). */
function cleanGhosts(raw) {
  let v = raw;
  if (typeof raw === 'string') { try { v = JSON.parse(raw); } catch (e) { v = null; } }
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const k of Object.keys(v)) if (v[k] === true && k.length <= 64) out[k] = true;
  return out;
}

return { SHADOW, SEATS, SEAT, ROOTS, GHOST_KEY, cleanDay, cleanTrade, marksFor, barIndex, decisionRows, seatDays, standingRows, spendText, cleanGhosts };
});

/* ======================================================================== the overlay and the view (browser only) */
if (typeof window !== 'undefined' && typeof document !== 'undefined') (function () {
'use strict';
const C = window.LeagueCore;
const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const AXIS_W = 78;                          // the chart's own price axis width (chart-engine's default axisWidth)

/**
 * The league's marks over one chart (a ChartLive pane: { chart, ... } in `host`, the element that holds the chart's canvas).
 * get() returns the cleaned day, or null; root() the chart's instrument. faint: the ⋯ switch's look (fainter, smaller).
 * Returns { redraw, destroy }. Drawn after each frame the chart draws; nothing is drawn on the chart's own canvas.
 */
function attach(pane, host, get, root, faint) {
  const chart = pane && pane.chart;
  const base = host && host.querySelector('.ce-canvas');
  if (!chart || !base) return { redraw() {}, destroy() {} };
  const cv = document.createElement('canvas');
  cv.className = 'lg-overlay';
  cv.setAttribute('aria-hidden', 'true');
  cv.style.cssText = 'position:absolute;pointer-events:none;z-index:2;';
  base.parentElement.appendChild(cv);
  const ctx = cv.getContext('2d');
  function draw() {
    const dpr = window.devicePixelRatio || 1, w = base.clientWidth, h = base.clientHeight;
    if (cv.style.left !== base.offsetLeft + 'px') { cv.style.left = base.offsetLeft + 'px'; cv.style.top = base.offsetTop + 'px'; }
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.width = w + 'px'; cv.style.height = h + 'px'; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const day = get();
    if (!day) return;
    const m = C.marksFor(day, root());
    if (!m.marks.length && !m.lines.length) return;
    const bars = chart.bars();
    if (!bars || !bars.length) return;
    const plotW = w - AXIS_W, ps = chart.priceScale(), plotH = ps && isFinite(ps.plotHeight) ? ps.plotHeight : h;
    const xAt = t => { const i = C.barIndex(bars, t); return i < 0 ? null : chart.barToX(i); };
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, plotW, plotH); ctx.clip();
    ctx.globalAlpha = faint ? 0.3 : 0.5;
    ctx.lineWidth = 1;
    for (const l of m.lines) {
      const x0 = xAt(l.t0), x1 = l.t1 === null ? plotW : xAt(l.t1), y = chart.priceToY(l.price);
      if (x0 === null || x1 === null || !isFinite(y)) continue;
      ctx.strokeStyle = l.color;
      ctx.setLineDash(l.kind === 'stop' ? [4, 3] : [1, 3]);
      ctx.beginPath(); ctx.moveTo(Math.round(x0) + 0.5, Math.round(y) + 0.5); ctx.lineTo(Math.round(x1) + 0.5, Math.round(y) + 0.5); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = faint ? 0.55 : 1;
    const r = faint ? 6 : 8;
    ctx.font = '600 ' + (faint ? 8 : 10) + 'px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const k of m.marks) {
      const x = xAt(k.t), y = chart.priceToY(k.price);
      if (x === null || !isFinite(y)) continue;
      ctx.strokeStyle = k.color; ctx.fillStyle = k.color; ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (k.kind === 'entry') ctx.arc(x, y, r, 0, Math.PI * 2);
      else { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); }
      ctx.stroke();                                           // hollow: the candle under it stays in sight
      ctx.fillText(k.letter, x, y + 0.5);
    }
    ctx.restore();
  }
  const off = chart.on('drawn', draw);
  draw();
  return { redraw: () => { chart.redraw(); draw(); }, destroy: () => { try { off(); } catch (e) { /* gone */ } cv.remove(); } };
}

/**
 * The League tab. o: { view (its section), tab (the top bar's button), feed (the window's ChartFeed), storagePrefix, deskBase()
 * (a promise of The Desk's address), fetch, onTab(on) }. Returns { showTab, shown, state, day, destroy }.
 */
function create(o) {
  const view = o.view, tabBtn = o.tab;
  const S = { shown: false, day: null, raw: null, problem: 'Not read yet.', reach: '', at: 0, timer: 0, chart: null, overlay: null, root: 'NQ', busy: false };   // 1.38.1: NQ 1 min (Anthony 2026-10-23), the league trades MNQ
  const q = s => view.querySelector(s);
  view.innerHTML =
    '<div class="lg-wrap">' +
      '<header class="lg-head">' +
        '<span class="lg-title">Shadow league</span><span class="lg-shadow">' + esc(C.SHADOW) + '</span>' +
        '<span class="lg-legend" aria-label="The seats">' + C.SEATS.map(s => '<span class="lg-key" style="--seat:' + s.color + '"><i aria-hidden="true">' + s.id + '</i>' + s.family + '</span>').join('') + '</span>' +
        '<span class="lg-fill"></span><span class="lg-when" data-k="when" role="status"></span>' +
      '</header>' +
      '<p class="lg-problem" data-k="problem" role="status" hidden></p>' +
      '<div class="lg-main">' +
        '<section class="lg-chartbox" aria-label="The league\'s chart"><div class="lg-charthead"><span class="lg-cname" data-k="cname" title="The seats trade MNQ: their marks are at their MNQ prices on the NQ candles (the same index)">NQ 1 min (league trades MNQ)</span><span class="lg-fill"></span><span class="lg-cnote">Hollow marks: paper trades only. Circle the fill, diamond the exit, dashed the stop, dotted the target.</span></div>' +
          '<div class="lg-chart" data-k="chart"></div></section>' +
        '<aside class="lg-side" aria-label="The seats today">' +
          '<div class="lg-seats" data-k="seats"></div>' +
          '<div class="lg-spend" data-k="spend"></div>' +
          '<table class="lg-table" aria-label="Week and month"><thead><tr><th>Seat</th><th>Week</th><th>Month</th><th>With you</th><th>Decision time</th></tr></thead><tbody data-k="table"></tbody></table>' +
          '<div class="lg-loghead">Decision log</div><ol class="lg-log" data-k="log"></ol>' +
        '</aside>' +
      '</div>' +
    '</div>';

  function poll() {
    clearTimeout(S.timer);
    if (S.busy) return;
    S.busy = true;
    Promise.resolve().then(() => o.deskBase()).then(url => o.fetch(url + '/api/chart-league', { cache: 'no-store', mode: 'cors', credentials: 'omit' }))
      .then(r => (r.ok ? r.json() : r.json().then(j => Promise.reject(new Error('The Desk answered ' + r.status + (j && j.detail ? ': ' + j.detail : ''))), () => Promise.reject(new Error('The Desk answered ' + r.status)))))
      .then(j => { S.raw = j; S.day = C.cleanDay(j); S.problem = S.day.problem; S.reach = 'ok'; S.at = Date.now(); },
        e => { S.reach = 'down'; S.problem = (e && /answered 404/.test(e.message) ? 'The Desk has no league view yet (it needs The Desk of this release).' : 'The Desk is not reachable: ' + (e && e.message ? e.message : 'no answer')) + (S.day ? ' Showing what it last sent.' : ''); })
      .then(() => { S.busy = false; render(); if (S.overlay) S.overlay.redraw(); if (S.shown) S.timer = setTimeout(poll, 15000); });
  }
  function mountChart() {
    if (S.chart || !window.ChartLive || !o.feed) return;
    S.chart = window.ChartLive.mount(q('[data-k="chart"]'), { feed: o.feed, paneId: 'league', storagePrefix: o.storagePrefix || '', toolbar: false, compact: true,
      view: { root: S.root, tf: 'm1' } });
    S.overlay = attach(S.chart, q('[data-k="chart"]'), () => S.day, () => S.root, false);
  }
  function unmountChart() {
    if (S.overlay) { S.overlay.destroy(); S.overlay = null; }
    if (S.chart) { try { S.chart.destroy(); if (S.chart.indicators) S.chart.indicators.remove(); if (S.chart.chips) S.chart.chips.remove(); if (S.chart.badge) S.chart.badge.remove(); } catch (e) { /* gone */ } S.chart = null; }
  }
  const setHtml = (el, html) => { if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; } };
  function render() {
    const d = S.day;
    const p = q('[data-k="problem"]');
    p.hidden = !S.problem; p.textContent = S.problem || '';
    const st = d && d.status;
    q('[data-k="when"]').textContent = d && d.date ? d.date + (st && st.now ? ' · ' + st.now + ' ET' : '') + (st && st.feed ? ' · feed ' + st.feed : '') + (d.day && d.day.closed ? ' · day closed, recording to 17:00' : '') : '';
    q('[data-k="when"]').title = d && d.day && d.day.note ? d.day.note : '';
    setHtml(q('[data-k="seats"]'), C.seatDays(d).map(s => '<div class="lg-seat" style="--seat:' + s.color + '" data-seat="' + s.seat + '"><i class="lg-letter" aria-hidden="true">' + s.seat + '</i>' +
      '<div class="lg-sbody"><div class="lg-sname">' + esc(s.family) + ' <span class="lg-mut">' + esc(s.line) + '</span></div>' +
      '<div class="lg-mut mono">' + (s.account ? esc(s.account) + ' · ' : '') + (s.n ? 'today ' + esc((s.todayR >= 0 ? '+' : '') + s.todayR.toFixed(2)) + ' R (n ' + s.n + ')' : 'no closed trade today') +
      (s.decisions !== null ? ' · ' + s.decisions + ' looks' : '') + '</div>' + (s.flag ? '<div class="lg-flag">Flag for you: ' + esc(s.flag) + '</div>' : '') + '</div></div>').join(''));
    const sp = C.spendText((st && st.spend) || (d && d.league && d.league.spend));
    setHtml(q('[data-k="spend"]'), '<span class="lg-mut">API spend</span> <span class="mono">' + esc(sp.day) + ' today · ' + esc(sp.month) + ' this month</span>' + (sp.stopped ? '<div class="lg-warn">' + esc(sp.stopped) + '</div>' : ''));
    setHtml(q('[data-k="table"]'), C.standingRows(d && d.league).map(r => '<tr><td><i class="lg-letter sm" style="--seat:' + r.color + '">' + r.seat + '</i></td><td>' + esc(r.week) + '</td><td>' + esc(r.month) + '</td><td>' + esc(r.agreement) + '</td><td>' + esc(r.latency) + '</td></tr>').join(''));
    const rows = C.decisionRows(d && d.decisions, 80);
    setHtml(q('[data-k="log"]'), rows.length ? rows.map(r => '<li class="lg-row k-' + r.kind + '"><span class="mono">' + esc(r.time) + '</span><i class="lg-letter sm" style="--seat:' + C.SEAT[r.seat].color + '">' + r.seat + '</i><span class="lg-text" title="' + esc(r.text + (r.trigger ? ' (look: ' + r.trigger + ')' : '') + (r.latency !== null ? ', ' + r.latency + ' s' : '')) + '">' + esc(r.text) + '</span>' + (r.latency !== null ? '<span class="lg-mut mono">' + esc(r.latency) + ' s</span>' : '') + '</li>').join('') : '<li class="lg-mut">No decision yet today.</li>');
  }
  function showTab(on) {
    on = !!on;
    if (on === S.shown) return;
    S.shown = on;
    if (tabBtn) { tabBtn.setAttribute('aria-pressed', String(on)); if (on) tabBtn.hidden = false; }
    if (typeof o.onTab === 'function') o.onTab(on);
    if (on) { mountChart(); poll(); } else { clearTimeout(S.timer); unmountChart(); }
    render();
  }
  /* the tab is offered once The Desk answers GET /api/chart-league (a Desk of this release, reachable from this PC), asked at the
     start and every 5 minutes; with no such Desk the top bar keeps its room (the trading controls never give way to it) */
  S.offered = false;
  function probe() {
    Promise.resolve().then(() => o.deskBase()).then(url => o.fetch(url + '/api/chart-league', { cache: 'no-store', mode: 'cors', credentials: 'omit' }))
      .then(r => r.ok, () => false).then(ok => { S.offered = ok; if (tabBtn) tabBtn.hidden = !(ok || S.shown); if (typeof o.onOffered === 'function') o.onOffered(ok); });
  }
  if (tabBtn) { tabBtn.hidden = true; tabBtn.addEventListener('click', e => { tabBtn.blur(); showTab(!S.shown); }); }
  probe();
  const probeTimer = setInterval(probe, 300000);
  render();
  return {
    showTab, shown: () => S.shown, poll, offered: () => S.offered,
    /* read only, for the tests and the console */
    state: () => ({ shown: S.shown, problem: S.problem, reach: S.reach, date: S.day ? S.day.date : '', trades: S.day ? S.day.trades.length : 0, open: S.day ? S.day.open.length : 0,
      decisions: S.day ? S.day.decisions.length : 0, chart: !!S.chart, marks: S.day ? C.marksFor(S.day, S.root).marks.length : 0 }),
    day: () => S.day,
    destroy() { clearTimeout(S.timer); clearInterval(probeTimer); unmountChart(); },
  };
}

window.LeagueOverlay = { attach };
window.LeagueView = { create };
})();
