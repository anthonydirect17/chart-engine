/*
 * Live chart page: connects to ChartBridge (NinjaTrader 8 add-on) and drives chart-engine.
 * Protocol: nt8/PROTOCOL.md. Read only: nothing here can place or change an order.
 */
(() => {
'use strict';
const CE = window.ChartEngine, U = CE.util, BarBuilder = window.BarBuilder.BarBuilder;
const $ = id => document.getElementById(id);
const SESSION = 18 * 3600;
const ROOTS = ['MNQ', 'NQ', 'MES', 'ES'];
const TF = {
  s15: { mode: 'time', sec: 15, label: '15s' }, s30: { mode: 'time', sec: 30, label: '30s' },
  m1: { mode: 'time', sec: 60, label: '1m' }, m5: { mode: 'time', sec: 300, label: '5m' },
  m15: { mode: 'time', sec: 900, label: '15m' }, h1: { mode: 'time', sec: 3600, label: '1h' },
  range: { mode: 'range', sec: 30, label: 'Range' },
};
const DEFAULT_RANGE = { MNQ: 20, NQ: 20, MES: 8, ES: 8 };      // ticks; change per instrument in the toolbar
const GLIDE = { smooth: { candle: 55, fit: 120, follow: 110 }, fast: { candle: 20, fit: 60, follow: 60 }, off: { candle: 0, fit: 0, follow: 0 } };

const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v === null || v === undefined ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
};
const S = { root: 'MNQ', tf: 'm1', glide: 'smooth', layers: { volume: true, vwap: true, levels: true, fills: true } };
{
  const s = store.get('live-settings-v1', null);
  if (s) {
    if (ROOTS.includes(s.root)) S.root = s.root;
    if (TF[s.tf]) S.tf = s.tf;
    if (GLIDE[s.glide]) S.glide = s.glide;
    if (s.layers) for (const k in S.layers) if (typeof s.layers[k] === 'boolean') S.layers[k] = s.layers[k];
  }
}
const ranges = Object.assign({}, DEFAULT_RANGE, store.get('live-range-v1', {}));
const saveSettings = () => store.set('live-settings-v1', S);

/* exchange clock: New York wall time as bar-time seconds; the offset is refreshed every minute */
let etOffset = U.zoneSeconds(Date.now() / 1000) - Date.now() / 1000;
setInterval(() => { etOffset = U.zoneSeconds(Date.now() / 1000) - Date.now() / 1000; }, 60000);
const etNow = () => Date.now() / 1000 + etOffset;
const nowMs = () => (performance.timeOrigin || Date.now() - performance.now()) + performance.now();

const chart = CE.create($('chart'), {
  barSeconds: 60, precision: 2, tick: 0.25,
  session: { start: SESSION, rthStart: 34200, rthEnd: 57600 },
  layers: { volume: S.layers.volume, vwap: S.layers.vwap, levels: S.layers.levels, trades: false },
  motion: GLIDE[S.glide], clock: etNow,
});

/* ---------------- per-instrument data */
const D = { root: null, name: null, tick: 0.25, ready: false, hist: [], ticks: [], m1: null, cur: null, day: null };
let instruments = {};
const fills = new Map();            // id -> fill, all instruments
let ticksSeen = 0;
const delays = { feed: [], local: [] };

function resetData(root) {
  D.root = root; D.name = root; D.ready = false; D.hist = []; D.ticks = []; D.m1 = null; D.cur = null; D.day = null;
  const inst = instruments[root];
  if (inst) { D.name = inst.name; D.tick = inst.tick || 0.25; }
  chart.setPriceFormat({ precision: precisionOf(), tick: D.tick });
  chart.setBars([], { barSeconds: TF[S.tf].sec });
  chart.setLevels([]);
  chart.setDrawings(store.get('live-drawings-v1-' + root, []));
  applyMarkers();
  legendKey = '';
}

function tfSeconds() { return TF[S.tf].sec; }

/* Build the chart's bars for the current timeframe from 1m history + ticks. */
function rebuild() {
  if (!D.ready) return;
  const tf = TF[S.tf];
  chart.setBarSeconds(tf.sec);
  if (tf.mode === 'time' && tf.sec >= 60) {
    D.cur = null;
    const bars = tf.sec === 60 ? D.m1.bars : U.aggregate(D.m1.bars, tf.sec);
    chart.setBars(bars, { barSeconds: tf.sec });
    chart.setCountdown(null);
  } else {
    D.cur = tf.mode === 'range'
      ? new BarBuilder({ mode: 'range', rangeTicks: ranges[D.root] || DEFAULT_RANGE[D.root] || 20, tick: D.tick, sessionStart: SESSION })
      : new BarBuilder({ mode: 'time', seconds: tf.sec, tick: D.tick, sessionStart: SESSION });
    for (const k of D.ticks) D.cur.add(k[0], k[1], k[2]);
    chart.setBars(D.cur.bars, { barSeconds: tf.sec });
    if (tf.mode === 'range') chart.setCountdown(() => { const r = D.cur && D.cur.rangeLeft(); return r ? '▲' + r.up + ' ▼' + r.down : ''; });
    else chart.setCountdown(null);
    if (!D.ticks.length) setStatus('No tick history came back from NinjaTrader, so ' + tf.label + ' bars start with the next live tick.', 'warn');
  }
  updateLevels();
  applyMarkers();
  legendKey = '';
}

function updateLevels() {
  if (!D.m1 || !D.m1.bars.length) return;
  const lv = U.sessionLevels(D.m1.bars, { asOf: etNow(), sessionStart: SESSION, tick: D.tick });
  chart.setLevels(U.levelLines(lv));
  D.day = U.tradeDay(etNow(), SESSION);
}

function onReady() {
  // 1m history up to the start of the current minute; the forming minute is rebuilt from ticks
  const cutoff = Math.floor(etNow() / 60) * 60;
  const seen = new Map();
  for (const b of D.hist) if (b.t < cutoff) seen.set(b.t, b);
  const hist = [...seen.values()].sort((a, b) => a.t - b.t);
  D.m1 = new BarBuilder({ mode: 'time', seconds: 60, tick: D.tick, sessionStart: SESSION });
  D.m1.seed(hist);
  const lastHist = hist.length ? hist[hist.length - 1].t + 60 : -Infinity;
  for (const k of D.ticks) if (k[0] >= Math.max(cutoff, lastHist)) D.m1.add(k[0], k[1], k[2]);
  D.ready = true;
  rebuild();
  setConn('live');
  $('notice').hidden = true;
}

function onTick(m) {
  if (m.root !== D.root || !D.ready) return;
  const t = m.t, p = m.p, v = m.v || 0;
  D.ticks.push([t, p, v]);
  if (D.ticks.length > 2500000) D.ticks.splice(0, 500000);
  ticksSeen++;
  const r1 = D.m1.add(t, p, v);
  const tf = TF[S.tf];
  if (tf.mode === 'time' && tf.sec >= 60) chart.update(tf.sec === 60 ? r1.bar : U.foldLast(D.m1.bars, tf.sec));
  else if (D.cur) chart.update(D.cur.add(t, p, v).bar);
  const now = nowMs();
  pushDelay(delays.feed, m.rx - m.u);
  pushDelay(delays.local, now - m.rx);
  if (r1.isNew && U.tradeDay(t, SESSION) !== D.day) updateLevels();
}

function pushDelay(arr, v) { if (isFinite(v)) { arr.push(v); if (arr.length > 300) arr.shift(); } }
function median(arr) { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

/* ---------------- fills */
function addFill(f) {
  if (!f || !f.id) return;
  fills.set(f.account + '|' + f.id, { t: f.t, price: f.p, side: f.side, qty: f.qty, root: f.root, name: f.name, account: f.account });
}
function applyMarkers() {
  const list = S.layers.fills ? [...fills.values()].filter(f => f.root === D.root) : [];
  chart.setMarkers(list);
  const lastFill = list.sort((a, b) => a.t - b.t)[list.length - 1];
  const el = $('lgFill');
  if (lastFill) {
    el.className = lastFill.side === 'buy' ? 'buy' : 'sell';
    el.textContent = 'Last fill ' + lastFill.side.toUpperCase() + ' ' + lastFill.qty + ' @ ' + U.fmtPrice(lastFill.price, precisionOf()) + ' ' + U.fmtHM(lastFill.t) + (lastFill.account ? ' · ' + lastFill.account : '');
  } else { el.textContent = ''; }
}
/* decimals needed to show every tick exactly: 0.25 -> 2, 0.1 -> 1, 1 -> 0 */
function decimalsOf(tick) {
  const s = String(tick);
  if (s.includes('e-')) return +s.split('e-')[1];
  return (s.split('.')[1] || '').length;
}
const precisionOf = () => Math.min(8, decimalsOf(D.tick));

/* ---------------- connection */
let ws = null, wsTries = 0, everConnected = false;
const wsUrl = (() => {
  const onBridge = location.protocol.startsWith('http') && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(location.host);
  return onBridge ? 'ws://' + location.host + '/ws' : 'ws://localhost:8765/ws';
})();

function connect() {
  setConn('connecting');
  try { ws = new WebSocket(wsUrl); } catch (e) { scheduleReconnect(); return; }
  ws.onopen = () => { wsTries = 0; everConnected = true; setStatus('', ''); };
  ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } handle(m); };
  ws.onclose = () => { ws = null; D.ready = false; setConn('offline'); scheduleReconnect(); };
  ws.onerror = () => { /* onclose follows */ };
}
function scheduleReconnect() {
  wsTries++;
  const wait = Math.min(5000, 500 * wsTries);
  if (!everConnected || wsTries > 2) showNotice(everConnected ? 'Lost ChartBridge' : 'Waiting for ChartBridge',
    'Trying ' + wsUrl + ' again. Check that NinjaTrader is running and ChartBridge compiled (messages appear in New > NinjaScript Output).');
  setTimeout(connect, wait);
}
function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function subscribe(root) {
  resetData(root);
  setConn('loading');
  send({ type: 'subscribe', root, days: 5, tickHours: 8 });
}

function handle(m) {
  switch (m.type) {
    case 'hello':
      instruments = {};
      for (const i of m.instruments || []) instruments[i.root] = i;
      $('lgSrc').textContent = 'NinjaTrader via ChartBridge ' + (m.version || '');
      subscribe(S.root);
      break;
    case 'history':
      if (m.root !== D.root) return;
      if (m.name) { D.name = m.name; $('lgName').textContent = m.name; }
      for (const b of m.bars) D.hist.push({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] });
      setStatus('Loading ' + D.root + ' history: ' + D.hist.length.toLocaleString() + ' minutes', '');
      break;
    case 'ticks':
      if (m.root !== D.root) return;
      for (const k of m.ticks) D.ticks.push(k);
      setStatus('Loading ' + D.root + ' ticks: ' + D.ticks.length.toLocaleString(), '');
      break;
    case 'ready':
      if (m.root !== D.root) return;
      setStatus('', '');
      onReady();
      break;
    case 'tick': onTick(m); break;
    case 'execs': for (const f of m.list || []) addFill(f); applyMarkers(); break;
    case 'exec': addFill(m); applyMarkers(); break;
    case 'status': setStatus(m.text, m.level); break;
  }
}

/* ---------------- UI */
function setConn(state) {
  const pill = $('connPill');
  const map = { connecting: ['CONNECTING', ''], loading: ['LOADING', ''], live: ['LIVE', 'live'], offline: ['OFFLINE', 'bad'] };
  const [text, cls] = map[state] || map.connecting;
  pill.textContent = text; pill.className = 'pill' + (cls ? ' ' + cls : '');
}
function setStatus(text, level) { const el = $('statusMsg'); el.textContent = text || ''; el.className = 'msg' + (level ? ' ' + level : ''); }
function showNotice(title, text) { $('noticeTitle').textContent = title; $('noticeText').textContent = text; $('notice').hidden = false; }

let legendKey = '';
chart.on('legend', e => {
  const { bar: b, prev, forming } = e;
  const key = [b.t, b.o, b.h, b.l, b.c, b.v, forming, S.tf, S.layers.vwap].join('|');
  if (key === legendKey) return;
  legendKey = key;
  const dp = precisionOf(), fmt = p => U.fmtPrice(p, dp);
  const chg = prev ? b.c - prev.c : 0, pct = prev ? chg / prev.c * 100 : 0;
  $('lgTf').textContent = S.tf === 'range' ? 'Range ' + (ranges[D.root] || '') + 't' : TF[S.tf].label;
  $('lgTime').textContent = U.fmtFull(b.t) + (forming ? ' · forming' : '');
  $('lgO').textContent = fmt(b.o); $('lgH').textContent = fmt(b.h); $('lgL').textContent = fmt(b.l); $('lgC').textContent = fmt(b.c);
  const chgEl = $('lgChg');
  chgEl.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(dp) + ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)';
  chgEl.className = chg > 0 ? 'up' : chg < 0 ? 'down' : 'dim';
  $('lgV').textContent = U.fmtVolume(b.v);
  $('lgVwWrap').hidden = !S.layers.vwap;
  $('lgVw').textContent = b.vw !== undefined ? fmt(U.roundTo(b.vw, D.tick)) : '-';
});
chart.on('drawings', list => store.set('live-drawings-v1-' + D.root, list));
chart.on('tool', t => { $('toolTrend').setAttribute('aria-pressed', String(t === 'trend')); $('toolHline').setAttribute('aria-pressed', String(t === 'hline')); });

CE.mountThemePanel(chart, $('colorsHost'), {
  storageKey: 'live-colors-v1',
  onChange: () => {
    const T = chart.colors(), st = document.documentElement.style;
    st.setProperty('--vwap-sw', T.vwapText); st.setProperty('--up-text', T.upText); st.setProperty('--down-text', T.downText);
    legendKey = '';
  },
});

function syncButtons() {
  for (const b of $('symSeg').children) b.setAttribute('aria-pressed', String(b.dataset.v === S.root));
  for (const b of $('tfSeg').children) b.setAttribute('aria-pressed', String(b.dataset.v === S.tf));
  for (const b of $('glideSeg').children) b.setAttribute('aria-pressed', String(b.dataset.v === S.glide));
  for (const b of $('layerChips').children) b.setAttribute('aria-pressed', String(!!S.layers[b.dataset.layer]));
  $('rangeBox').hidden = S.tf !== 'range';
  $('rangeTicks').value = ranges[S.root] || DEFAULT_RANGE[S.root] || 20;
  $('rangeTicks').setAttribute('aria-label', 'Range bar size for ' + S.root + ' in ticks');
}
$('symSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.dataset.v === S.root) return;
  S.root = b.dataset.v; saveSettings(); syncButtons(); subscribe(S.root);
});
$('tfSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.dataset.v === S.tf) return;
  S.tf = b.dataset.v; saveSettings(); syncButtons(); rebuild();
});
$('rangeTicks').addEventListener('change', e => {
  const n = Math.max(1, Math.min(400, Math.round(+e.target.value || 0)));
  ranges[S.root] = n; store.set('live-range-v1', ranges); syncButtons(); if (S.tf === 'range') rebuild();
});
$('glideSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  S.glide = b.dataset.v; chart.setMotion(GLIDE[S.glide]); saveSettings(); syncButtons();
});
$('layerChips').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const k = b.dataset.layer; S.layers[k] = !S.layers[k];
  if (k === 'fills') applyMarkers(); else chart.setLayers({ [k]: S.layers[k] });
  legendKey = ''; saveSettings(); syncButtons();
});
$('toolTrend').addEventListener('click', () => chart.setTool(chart.getTool() === 'trend' ? null : 'trend'));
$('toolHline').addEventListener('click', () => chart.setTool(chart.getTool() === 'hline' ? null : 'hline'));
$('clearDraw').addEventListener('click', () => chart.clearDrawings());
$('resetBtn').addEventListener('click', () => chart.reset());
syncButtons();

/* ---------------- status line */
setInterval(() => {
  const f = median(delays.feed), l = median(delays.local);
  $('dFeed').textContent = f === null ? '-' : Math.round(f) + ' ms' + (f < 0 ? ' (PC clock ahead)' : '');
  $('dLocal').textContent = l === null ? '-' : (l < 1 ? '<1' : Math.round(l)) + ' ms';
  const s = chart.stats();
  $('fps').textContent = s.idle ? 'idle' : s.fps + ' fps · ' + s.drawMs.toFixed(1) + ' ms/frame';
  $('ticksSeen').textContent = ticksSeen.toLocaleString() + ' live ticks';
}, 500);

if (document.fonts && document.fonts.load) {
  Promise.all([document.fonts.load('500 11px "IBM Plex Mono"'), document.fonts.load('600 10px "IBM Plex Sans Condensed"')]).then(() => chart.setLayers({}), () => {});
}
connect();
})();
