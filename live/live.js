/*
 * Live chart page: connects to ChartBridge (NinjaTrader 8 add-on) and drives chart-engine.
 * Protocol: nt8/PROTOCOL.md. With ChartBridge 0.2 (protocol v1) the page is read only. With protocol v2 it
 * can trade, but only after ChartBridge enables it (trading = true in config.txt, this page signed in with
 * the session token) and only while the Armed switch is on. Armed is off after every page load.
 */
(() => {
'use strict';
const CE = window.ChartEngine, U = CE.util, BarBuilder = window.BarBuilder.BarBuilder, OT = window.OrderTicket;
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

window.liveChart = chart;            // for tests and the console; order actions still go through the checks below

/* ---------------- per-instrument data */
const D = { root: null, name: null, tick: 0.25, ready: false, hist: [], ticks: [], m1: null, cur: null, day: null, tickHours: 0 };
/* Seconds and range bars are built from ticks; minute and hour bars only need 1-minute history (fast load). */
const needsTicks = () => TF[S.tf].mode === 'range' || TF[S.tf].sec < 60;
let instruments = {};
const fills = new Map();            // id -> fill, all instruments
let fillAccount = store.get('live-fill-account-v1', '');   // '' = all accounts
const accountsSeen = new Set();
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
  renderTrading();
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
  // With ticks: 1m history up to the start of the current minute, and the forming minute rebuilt from
  // ticks. Without ticks: keep NinjaTrader's forming minute and let live ticks continue it.
  const cutoff = D.tickHours > 0 ? Math.floor(etNow() / 60) * 60 : Infinity;
  const seen = new Map();
  for (const b of D.hist) if (b.t < cutoff) seen.set(b.t, b);
  const hist = [...seen.values()].sort((a, b) => a.t - b.t);
  D.m1 = new BarBuilder({ mode: 'time', seconds: 60, tick: D.tick, sessionStart: SESSION });
  D.m1.seed(hist);
  if (D.tickHours > 0) {
    const lastHist = hist.length ? hist[hist.length - 1].t + 60 : -Infinity;
    for (const k of D.ticks) if (k[0] >= Math.max(cutoff, lastHist)) D.m1.add(k[0], k[1], k[2]);
  }
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
  if (f.account && !accountsSeen.has(f.account)) { accountsSeen.add(f.account); syncAccounts(); }
}
/* Account dropdown: All accounts, or one account (Anthony, 2026-09-29). Accounts with fills come first. */
function syncAccounts(listed) {
  if (listed) for (const a of listed) accountsSeen.add(a);
  const sel = $('fillAcct');
  const withFills = new Set([...fills.values()].map(f => f.account));
  const names = [...accountsSeen].sort((a, b) => (withFills.has(b) - withFills.has(a)) || a.localeCompare(b));
  if (fillAccount && !accountsSeen.has(fillAccount)) names.unshift(fillAccount);   // keep a saved choice even before it reconnects
  sel.replaceChildren(new Option('All accounts', ''), ...names.map(n => new Option(withFills.has(n) ? n : n + ' (no fills yet)', n)));
  sel.value = fillAccount;
}
function applyMarkers() {
  const list = S.layers.fills ? [...fills.values()].filter(f => f.root === D.root && (!fillAccount || f.account === fillAccount)) : [];
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
  ws.onclose = () => { ws = null; D.ready = false; setConn('offline'); tradingLost('Not connected to ChartBridge.'); scheduleReconnect(); };
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
  D.tickHours = needsTicks() ? 8 : 0;
  send({ type: 'subscribe', root, days: 5, tickHours: D.tickHours });
}

function handle(m) {
  switch (m.type) {
    case 'hello':
      instruments = {};
      for (const i of m.instruments || []) instruments[i.root] = i;
      $('lgSrc').textContent = 'NinjaTrader via ChartBridge ' + (m.version || '');
      syncAccounts(m.accounts || []);
      subscribe(S.root);
      if (m.trading) { applyTrading(m.trading); signIn(); }   // protocol v2; ChartBridge 0.2 has no trading field
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
    case 'execs': for (const f of m.list || []) addFill(f); syncAccounts(); applyMarkers(); break;
    case 'exec': addFill(m); applyMarkers(); break;
    case 'status': if (m.level === 'error') alertLoud(m.text); else setStatus(m.text, m.level); break;
    case 'trading': applyTrading(m); if (!TR.signInStarted) signIn(); break;
    case 'orders': TR.orders.clear(); for (const o of m.list || []) if (served(o.root)) TR.orders.set(o.id, o); renderTrading(); break;
    case 'order': onOrder(m); break;
    case 'position': TR.positions.set(m.account + '|' + m.root, { qty: +m.qty || 0, avgPrice: +m.avgPrice || 0 }); renderTrading(); break;
    case 'reject': flash('Refused by ChartBridge: ' + m.reason, 'error'); renderTrading(); break;
  }
}

/* ---------------- trading (protocol v2) */
const TR = {
  v2: false, enabled: false, reason: '', accounts: [], maxQty: {}, signInStarted: false,
  armed: false,                        // never saved: Armed is off after every page load
  account: '', side: 'buy',
  orders: new Map(),                   // id -> latest order message (working ones; finished ones are dropped)
  positions: new Map(),                // 'account|root' -> { qty, avgPrice }
};
const brackets = {};
{ const b = store.get('live-bracket-v1', {}); for (const r of ROOTS) brackets[r] = OT.cleanBracket(b && b[r]); }
const sameAction = OT.repeatGuard(400);
let cidSeq = 0;
const newCid = () => 'p' + Date.now().toString(36) + '-' + (++cidSeq);

const served = r => !Object.keys(instruments).length || !!instruments[r];
/* Clickjacking guard: never trade from inside another page's frame (ChartBridge also sends X-Frame-Options DENY). */
const FRAMED = (() => { try { return window.top !== window.self; } catch (e) { return true; } })();
const FRAMED_REASON = 'This chart is inside another page (a frame), so it cannot trade. Open it directly from ChartBridge (http://localhost:8765/).';

/* Sign in: read the session token from GET /session (same origin as this page) and send auth. */
function signIn() {
  TR.signInStarted = true;
  if (FRAMED) { applyTrading({ enabled: false, reason: FRAMED_REASON }); return; }
  const sock = ws;
  fetch('/session', { cache: 'no-store' })
    .then(r => r.ok ? r.text() : Promise.reject(new Error('GET /session answered ' + r.status)))
    .then(body => {
      let token = null;
      try { const j = JSON.parse(body); token = typeof j === 'string' ? j : j && j.token; } catch (e) { token = body.trim(); }
      if (!token) throw new Error('no token in GET /session');
      if (sock === ws) send({ type: 'auth', token });
    })
    .catch(e => {
      if (sock !== ws) return;
      applyTrading({ enabled: false, reason: 'Could not sign in to ChartBridge (' + e.message + '). Open the chart from ChartBridge itself to trade.' });
    });
}
function applyTrading(t) {
  TR.v2 = true;
  TR.enabled = !!t.enabled && !FRAMED;
  TR.reason = FRAMED ? FRAMED_REASON : t.enabled ? '' : (t.reason || 'Trading is not enabled in ChartBridge.');
  TR.accounts = Array.isArray(t.accounts) ? t.accounts.slice() : [];
  TR.maxQty = t.maxQty || {};
  TR.account = OT.defaultAccount(TR.accounts, TR.account);
  if (!TR.enabled) setArmed(false);
  syncTradeAccounts();
  renderTrading();
}
function tradingLost(reason) {
  TR.signInStarted = false;
  if (!TR.v2) return;
  TR.enabled = false; TR.reason = reason; TR.orders.clear(); TR.positions.clear();
  setArmed(false); renderTrading();
}
function onOrder(o) {
  if (!served(o.root)) return;
  const prev = TR.orders.get(o.id) || null;
  const ev = OT.orderEvent(o, prev, p => U.fmtPrice(p, precisionOf()));
  if (OT.isWorking(o)) TR.orders.set(o.id, o); else TR.orders.delete(o.id);
  if (ev) flash(ev.text, ev.level === 'error' ? 'error' : '');
  renderTrading();
}

const lastPrice = () => (D.m1 && D.m1.last ? D.m1.last.c : null);
const capNow = () => OT.maxQtyFor(TR, D.root);
const qtyNow = () => Number($('oQty').value === '' ? NaN : +$('oQty').value);

/* Everything that sends an order action goes through here: trading enabled, Armed on, connected, data loaded. */
function ready() {
  if (FRAMED) { flash(FRAMED_REASON, 'error'); return false; }
  if (!TR.enabled) { flash(TR.reason || 'Trading is not enabled.', 'error'); return false; }
  if (!TR.armed) { flash('Armed is off: nothing was sent. Turn Armed on to trade.', 'warn'); return false; }
  if (!ws || ws.readyState !== 1) { flash('Not connected to ChartBridge: nothing was sent.', 'error'); return false; }
  if (!D.ready || !TR.account) { flash('Still loading: nothing was sent.', 'warn'); return false; }
  return true;
}
function sendOrder(side, kind, price) {
  if (!ready()) return;
  const qty = qtyNow(), bad = OT.checkQty(qty, capNow(), D.root);
  if (bad) { flash('Not sent: ' + bad, 'error'); return; }
  if (!sameAction.call(null, [side, kind, price, qty].join('|'), performance.now())) { flash('Ignored a repeat click within 0.4 s.', 'warn'); return; }
  const msg = { type: 'order', cid: newCid(), account: TR.account, root: D.root, side, kind, qty };
  if (kind !== 'market') msg.price = price;
  const b = brackets[D.root], pos = TR.positions.get(TR.account + '|' + D.root);
  const reduces = !OT.bracketAllowed(side, pos && pos.qty);          // ChartBridge refuses a bracket on a reducing order
  if ((b.stop > 0 || b.target > 0) && !reduces) msg.bracket = { stop: b.stop, target: b.target };   // JSON numbers, 0 = none
  send(msg);
  flash('Sent ' + side.toUpperCase() + ' ' + (kind === 'market' ? 'MKT' : kind === 'limit' ? 'LMT' : 'STP') + ' ' + qty + ' ' + D.root +
    (kind === 'market' ? '' : ' @ ' + U.fmtPrice(price, precisionOf())) + (msg.bracket ? ' with bracket ' + b.stop + ' / ' + b.target + ' ticks' : reduces && (b.stop > 0 || b.target > 0) ? ' (no bracket: it reduces the position)' : '') + ' · ' + TR.account, '');
}
function workingHere() { return [...TR.orders.values()].filter(o => o.account === TR.account && o.root === D.root && OT.isWorking(o)); }

/* Cancel all: one cancel per order (a bracket leg takes its pair), at most 8 a second (ChartBridge allows 10). */
function cancelAll() {
  if (!ready()) return;
  const ids = OT.cancelAllIds([...TR.orders.values()], TR.account, D.root);
  if (!ids.length) { flash('No working orders on ' + TR.account + ' ' + D.root + '.', ''); return; }
  ids.forEach((id, i) => setTimeout(() => { if (TR.armed) send({ type: 'cancel', id }); }, Math.floor(i / 8) * 1100));
  flash('Cancelling ' + ids.length + ' order' + (ids.length > 1 ? 's' : '') + ' on ' + TR.account + ' ' + D.root, '');
}

function setArmed(on) {
  const v = !!on && TR.enabled;
  TR.armed = v;
  const btn = $('armBtn');
  btn.setAttribute('aria-checked', String(v));
  $('armText').textContent = v ? 'ARMED: one click trades' : 'Armed off';
  $('obar').classList.toggle('armed', v);
  document.body.classList.toggle('is-armed', v);
  $('armPill').hidden = !v;
  document.title = v ? 'ARMED · Live Chart' : 'Live Chart';
  chart.setOrderEditing(v);
  renderTrading();
}
function syncTradeAccounts() {
  const sel = $('oAcct');
  sel.replaceChildren(...TR.accounts.map(a => new Option(a, a)));
  sel.value = TR.account;
}
/* Order bar, order lines, position line; also run on every instrument switch and order message. */
function renderTrading() {
  if (!TR.v2) return;
  const bar = $('obar'); bar.hidden = false;
  const on = TR.enabled, root = D.root || S.root, cap = OT.maxQtyFor(TR, root);
  for (const el of bar.querySelectorAll('button, input, select')) el.disabled = !on;
  const q = $('oQty'); q.max = String(cap);
  if (!q.value) q.value = '1';
  for (const id of ['buyMkt', 'sellMkt', 'flattenBtn', 'cancelAllBtn']) $(id).classList.toggle('is-off', !TR.armed);   // dimmed while disarmed; a click says why
  $('oOff').textContent = on ? '' : 'Trading off: ' + TR.reason;
  $('oOff').hidden = on;
  for (const b of $('sideSeg').children) b.setAttribute('aria-pressed', String(b.dataset.v === TR.side));
  const br = brackets[root] || { stop: 0, target: 0 };
  if (document.activeElement !== $('bStop')) $('bStop').value = br.stop;
  if (document.activeElement !== $('bTarget')) $('bTarget').value = br.target;
  $('bStop').setAttribute('aria-label', 'Bracket stop for ' + root + ' in ticks, 0 for none');
  $('bTarget').setAttribute('aria-label', 'Bracket target for ' + root + ' in ticks, 0 for none');
  $('statusRo').textContent = on ? 'Trading through ChartBridge. Live CME data is for this screen only.' : 'Read only. Orders are placed in NinjaTrader. Live CME data is for this screen only.';
  chart.setOrders(on ? workingHere() : []);
  const pos = on ? TR.positions.get(TR.account + '|' + root) : null;
  const inst = instruments[root] || {};
  chart.setPosition(pos && pos.qty ? pos : null, { pointValue: inst.pointValue || 0 });
  renderPositionInfo();
}
/* Position and other accounts in the bar (P&L refreshes with the status line). */
function renderPositionInfo() {
  const el = $('oPos'), other = $('oOther');
  if (!TR.v2 || !TR.enabled) { el.textContent = ''; other.textContent = ''; return; }
  const root = D.root, pos = TR.positions.get(TR.account + '|' + root), dp = precisionOf();
  if (pos && pos.qty) {
    const pnl = U.openPnl(pos.qty, pos.avgPrice, lastPrice(), (instruments[root] || {}).pointValue || 0);
    const cls = pnl.points > 0 ? 'profit' : pnl.points < 0 ? 'loss' : '';
    el.innerHTML = '';
    const side = document.createElement('span'); side.className = pos.qty > 0 ? 'long' : 'short'; side.textContent = (pos.qty > 0 ? 'LONG ' : 'SHORT ') + Math.abs(pos.qty);
    const res = document.createElement('span'); res.className = cls; res.textContent = U.fmtSigned(pnl.points, dp) + ' pt' + (pnl.dollars !== null ? ' ' + U.fmtMoney(pnl.dollars) : '');
    el.append(side, ' @ ' + U.fmtPrice(pos.avgPrice, dp) + ' ', res);
  } else el.textContent = 'Flat';
  let n = 0, p = 0;
  for (const o of TR.orders.values()) if (o.root === root && o.account !== TR.account && OT.isWorking(o)) n++;
  for (const [k, v] of TR.positions) if (v.qty && k.endsWith('|' + root) && !k.startsWith(TR.account + '|')) p++;
  other.textContent = n || p ? 'Other accounts on ' + root + ': ' + [n ? n + ' order' + (n > 1 ? 's' : '') : '', p ? p + ' position' + (p > 1 ? 's' : '') : ''].filter(Boolean).join(', ') : '';
}

/* ---------------- UI */
function setConn(state) {
  const pill = $('connPill');
  const map = { connecting: ['CONNECTING', ''], loading: ['LOADING', ''], live: ['LIVE', 'live'], offline: ['OFFLINE', 'bad'] };
  const [text, cls] = map[state] || map.connecting;
  pill.textContent = text; pill.className = 'pill' + (cls ? ' ' + cls : '');
}
function setStatus(text, level) { clearTimeout(flashTimer); const el = $('statusMsg'); el.textContent = text || ''; el.className = 'msg' + (level ? ' ' + level : ''); }
/* Error-level status from ChartBridge (for example a bracket leg rejected: the position may have no stop) stays
   on screen until dismissed. The newest three are kept. */
const alerts = [];
function alertLoud(text) {
  alerts.push(new Date().toLocaleTimeString() + '  ' + text); while (alerts.length > 3) alerts.shift();
  $('alertText').textContent = alerts.join('\n'); $('alertBar').hidden = false;
}
$('alertClose').addEventListener('click', () => { alerts.length = 0; $('alertBar').hidden = true; });
/* Order messages show for a while, then clear (errors stay longer). */
let flashTimer = 0;
function flash(text, level) { setStatus(text, level); const t = text; flashTimer = setTimeout(() => { if ($('statusMsg').textContent === t) setStatus('', ''); }, level === 'error' ? 12000 : 6000); }
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
  S.root = b.dataset.v; saveSettings(); syncButtons();
  if (TR.armed) { setArmed(false); flash('Armed turned off: the instrument changed.', 'warn'); }
  subscribe(S.root);
});
$('tfSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.dataset.v === S.tf) return;
  S.tf = b.dataset.v; saveSettings(); syncButtons();
  if (needsTicks() && D.tickHours === 0) subscribe(S.root);      // first tick-based view: fetch the session's ticks
  else rebuild();
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
$('fillAcct').addEventListener('change', e => {
  fillAccount = e.target.value; store.set('live-fill-account-v1', fillAccount); applyMarkers();
});
$('toolTrend').addEventListener('click', () => chart.setTool(chart.getTool() === 'trend' ? null : 'trend'));
$('toolHline').addEventListener('click', () => chart.setTool(chart.getTool() === 'hline' ? null : 'hline'));
$('clearDraw').addEventListener('click', () => chart.clearDrawings());
$('resetBtn').addEventListener('click', () => chart.reset());
syncButtons();

/* order bar */
$('armBtn').addEventListener('click', () => {
  if (FRAMED) { flash(FRAMED_REASON, 'error'); return; }
  if (!TR.enabled) { flash(TR.reason || 'Trading is not enabled.', 'error'); return; }
  setArmed(!TR.armed);
  flash(TR.armed ? 'Armed: one click places an order on ' + TR.account + ', with no confirmation.' : 'Armed off.', TR.armed ? 'warn' : '');
});
$('oAcct').addEventListener('change', e => {
  TR.account = e.target.value;
  if (TR.armed) { setArmed(false); flash('Armed turned off: the account changed.', 'warn'); }
  renderTrading();
});
$('oQty').addEventListener('change', () => {
  const q = $('oQty'), v = Math.round(+q.value);
  if (isFinite(v) && v >= 1) q.value = String(v);
});
$('buyMkt').addEventListener('click', () => sendOrder('buy', 'market', null));
$('sellMkt').addEventListener('click', () => sendOrder('sell', 'market', null));
$('sideSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; TR.side = b.dataset.v; renderTrading(); chart.setOrderPreview(previewAt); });
for (const [id, k] of [['bStop', 'stop'], ['bTarget', 'target']]) {
  $(id).addEventListener('change', e => {
    brackets[D.root] = OT.cleanBracket(Object.assign({}, brackets[D.root], { [k]: e.target.value }));
    e.target.value = brackets[D.root][k];
    store.set('live-bracket-v1', brackets);
  });
}
$('flattenBtn').addEventListener('click', () => {
  if (!ready()) return;
  if (!sameAction('flatten', performance.now())) return;
  send({ type: 'flatten', account: TR.account, root: D.root });
  flash('Flatten sent for ' + TR.account + ' ' + D.root + ': cancel its orders, close the position at market.', '');
});
$('cancelAllBtn').addEventListener('click', cancelAll);

/* chart: drag an order label to move it, x to cancel, Shift+click to place (all only while Armed) */
const previewAt = price => {
  const qty = qtyNow();
  return { side: TR.side, kind: OT.placeKind(TR.side, price, lastPrice()), qty: isFinite(qty) ? qty : 0, note: 'click to place' };
};
chart.setOrderPreview(previewAt);
chart.on('orderPlace', e => sendOrder(TR.side, OT.placeKind(TR.side, e.price, lastPrice()), e.price));
chart.on('orderMove', e => {
  if (!ready()) { renderTrading(); return; }
  send({ type: 'change', id: e.id, price: e.price });
  flash('Moving order ' + e.id + ' to ' + U.fmtPrice(e.price, precisionOf()), '');
});
chart.on('orderCancel', e => {
  if (!ready()) return;
  send({ type: 'cancel', id: e.id });
  flash('Cancelling order ' + e.id, '');
});

/* ---------------- status line */
setInterval(() => {
  const f = median(delays.feed), l = median(delays.local);
  $('dFeed').textContent = f === null ? '-' : Math.round(f) + ' ms' + (f < 0 ? ' (PC clock ahead)' : '');
  $('dLocal').textContent = l === null ? '-' : (l < 1 ? '<1' : Math.round(l)) + ' ms';
  const s = chart.stats();
  $('fps').textContent = s.idle ? 'idle' : s.fps + ' fps · ' + s.drawMs.toFixed(1) + ' ms/frame';
  $('ticksSeen').textContent = ticksSeen.toLocaleString() + ' live ticks';
  renderPositionInfo();
}, 500);

if (document.fonts && document.fonts.load) {
  Promise.all([document.fonts.load('500 11px "IBM Plex Mono"'), document.fonts.load('600 10px "IBM Plex Sans Condensed"')]).then(() => chart.setLayers({}), () => {});
}
connect();
})();
