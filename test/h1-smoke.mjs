// Chart 1.15.0 (H1) in the workspace, against the fake bridge (ChartBridge 0.3.8's protocol with 0.3.7's data side, sample
// data; nothing reaches a broker), in Chromium:
//   - 4h, 1D and 1W: NinjaTrader's own bars asked with htf and kept up by htfBar and the trades (their times as PROTOCOL
//     says); a refused request says why and is asked again 60 s later; with ChartBridge 0.3.6 the choices show and say
//     they need 0.3.7; the intraday indicators on them (VWAP and levels on 4h, a note on 1D);
//   - the deeper hour history: a 1 hour chart asks for 30 days (15 minute 10), the feed's one subscribe the most any panel
//     needs, and the load timed against 5 days;
//   - the drawing ring: a middle-click on a chart's plot, its four tools on THAT chart, a Zone drawn, Escape and a click
//     outside, the focus back on the page, the browser's middle-button default kept off, and a Shift+click while a tool is
//     armed still places the order (no drawing);
//   - the corner readout on every chart, on a small panel and with the header text off; no countdown, ATR or % change
//     left in the header;
//   - compact order labels: the full label's hit areas, the full one on hover;
//   - the Account panel: Close works disarmed, x needs Armed, a window without the ticket follows the forward rules, the
//     Fills tab's round trips; the Quote board against the fake's prices and settlement, blank without one;
//   - the disarmed note, also after a reconnect;
// with screenshots at 1366x768, 1920x1080 and 2560x1440 of two-monitor-style layouts and close crops of the labels, the
// Account panel, the Quote board, the corner readout and the ring in test/out/.
//   npm run smoke:h1        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser; H1_SMOKE_PORT)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const SHOTS = process.env.SHOTS_DIR || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const PORT = +(process.env.H1_SMOKE_PORT || 8897), OLD_PORT = PORT + 1;
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms) {
  const end = Date.now() + (ms || 10000);
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); }
}
async function shot(page, name, clip) {
  const file = path.join(out, name);
  await page.screenshot(clip ? { path: file, clip } : { path: file });
  if (SHOTS) fs.copyFileSync(file, path.join(SHOTS, name));
}
const bridges = [];
async function startBridge(port, flags) {
  const child = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(port)].concat(flags), { stdio: ['ignore', 'pipe', 'inherit'] });
  bridges.push(child);
  await new Promise(r => child.stdout.once('data', r));
}
const control = async (port, what, q) => (await fetch(`http://127.0.0.1:${port}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
const received = async port => (await fetch(`http://127.0.0.1:${port}/test/received`, { method: 'POST' })).json();
const state = (r) => control(PORT, 'state', { root: r || 'MNQ' });

/* Two windows of Anthony's two-monitor setup (images/67.webp): Main (the big MNQ chart, a 4 hour, NQ and ES, the ticket
   with the Account panel and the Quote board under it) and Second (two charts, the tape, a daily chart). */
const MAIN = [
  { id: 'm1', type: 'chart', root: 'MNQ', tf: 'm5', x: 0, y: 0, w: 5, h: 6 },
  { id: 'm2', type: 'chart', root: 'MNQ', tf: 'h4', x: 5, y: 0, w: 5, h: 3 },
  { id: 'm3', type: 'chart', root: 'NQ', tf: 'm1', x: 5, y: 3, w: 3, h: 3 },
  { id: 'm4', type: 'chart', root: 'ES', tf: 'm15', x: 8, y: 3, w: 2, h: 3 },
  { id: 'tk', type: 'ticket', x: 10, y: 0, w: 2, h: 3 },
  { id: 'ac', type: 'account', x: 10, y: 3, w: 2, h: 2 },
  { id: 'qb', type: 'quotes', x: 10, y: 5, w: 2, h: 1 },
];
const SECOND = [
  { id: 's1', type: 'chart', root: 'NQ', tf: 'range', range: 40, x: 0, y: 0, w: 5, h: 6 },
  { id: 's2', type: 'tape', root: 'MNQ', x: 5, y: 0, w: 2, h: 6 },
  { id: 's3', type: 'chart', root: 'MNQ', tf: 'h1', x: 7, y: 0, w: 3, h: 3 },
  { id: 's4', type: 'chart', root: 'NQ', tf: 'd1', x: 7, y: 3, w: 3, h: 3 },
  { id: 's5', type: 'account', x: 10, y: 0, w: 2, h: 3 },
  { id: 's6', type: 'quotes', x: 10, y: 3, w: 2, h: 3 },
];
function seed([layouts]) {
  try {
    if (!localStorage.getItem('live-workspace-v1')) localStorage.setItem('live-workspace-v1', JSON.stringify({ v: 1, layouts }));
    // the first order with no stop asks "No stop: send anyway?" (1.13.0): answered Send here (smoke:nostop checks it)
    setInterval(() => { const b = document.querySelector('.nostop-ask:not([hidden]) .nostop-send'); if (b) b.click(); }, 30);
    // the middle button's default (Windows auto-scroll) kept off: what the page did with each press
    window.__middle = [];
    for (const t of ['pointerdown', 'mousedown']) window.addEventListener(t, e => { if (e.button === 1) setTimeout(() => window.__middle.push({ type: t, prevented: e.defaultPrevented }), 0); }, true);
    window.__notes = [];
    const iv = setInterval(() => { const el = document.getElementById('wsNote'); if (!el) return; clearInterval(iv); new MutationObserver(() => window.__notes.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true }); }, 20);
  } catch (e) { /* blocked */ }
}
async function openWs(ctx, port, layout) {
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));
  await page.goto(`http://localhost:${port}/live/?layout=${layout}`);
  await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
  await enterPin(page, TEST_PIN);
  await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 40000 });
  return page;
}
const C = (page, id) => ({
  bars: () => page.evaluate(i => window.workspace.chart(i).bars().map(b => ({ t: b.t, c: b.c, h: b.h, l: b.l })), id),
  last: () => page.evaluate(i => window.workspace.chart(i).lastBar(), id),
  corner: () => page.evaluate(i => window.workspace.chart(i).corner(), id),
  layers: () => page.evaluate(i => window.workspace.chart(i).getLayers(), id),
  tool: () => page.evaluate(i => window.workspace.chart(i).getTool(), id),
  drawings: () => page.evaluate(i => window.workspace.chart(i).getDrawings(), id),
  note: () => page.evaluate(i => { const el = document.querySelector(`.ws-panel[data-id="${i}"] [id$="statusMsg"]`); const r = document.querySelector(`.ws-panel[data-id="${i}"] [id$="rangeNote"]`); return { msg: el ? el.textContent : '', range: r && !r.hidden ? r.textContent : '' }; }, id),
  notice: () => page.evaluate(i => { const n = document.querySelector(`.ws-panel[data-id="${i}"] .notice`); return n && !n.hidden ? n.textContent.replace(/\s+/g, ' ').trim() : ''; }, id),
  canvas: () => page.locator(`.ws-panel[data-id="${id}"] canvas`).first(),
  priceToY: p => page.evaluate(([i, pr]) => window.workspace.chart(i).priceToY(pr), [id, p]),
  handles: () => page.evaluate(i => window.workspace.chart(i).orderHandles(), id),
});
const setTf = async (page, id, tf) => {
  await page.click(`.ws-panel[data-id="${id}"] .ws-view`);
  await page.click(`#wsView [data-tf="${tf}"]`);
  await page.keyboard.press('Escape');
};
const et = t => { const d = new Date(t * 1000); return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds(); };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  await startBridge(PORT, ['--trading', '--trade-accounts=Sim101', '--max-qty=MNQ:9,NQ:4,ES:4,MES:4', '--test-controls', '--version=0.3.8', '--data-037', '--deep-history', '--live-rate=30', '--test-pin=' + TEST_PIN]);
  const L = Math.round((await control(PORT, 'hold', { root: 'MNQ' })).last);
  await control(PORT, 'price', { root: 'MNQ', p: L });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(seed, [{ Main: { panels: MAIN }, Second: { panels: SECOND } }]);
  const page = await openWs(ctx, PORT, 'Main');
  await page.waitForTimeout(2500);

  /* ================================================================ 4h, 1D, 1W with ChartBridge 0.3.7+ */
  console.log('4h, 1D and 1W (ChartBridge 0.3.8)');
  const m2 = C(page, 'm2');
  const b4 = await until(async () => { const b = await m2.bars(); return b.length > 5 ? b : null; }, 'the 4h bars', 15000);
  const r0 = await received(PORT);
  check((r0.types.htf || 0) >= 1, 'the 4h chart asked ChartBridge with htf (' + (r0.types.htf || 0) + ')');
  if (b4) {
    check(b4.every(b => [18, 22, 2, 6, 10, 14].includes(et(b.t) / 3600)), '4h bars start at 18, 22, 02, 06, 10 and 14 ET (' + b4.length + ' bars)');
    await control(PORT, 'price', { root: 'MNQ', p: L + 2 });
    const live = await until(async () => { const x = await m2.last(); return x && x.c === L + 2 ? x : null; }, 'the forming 4h bar takes the trade', 5000);
    check(!!live, 'the forming 4h bar follows the live trades (close ' + (live && live.c) + ')');
    await control(PORT, 'price', { root: 'MNQ', p: L });
  }
  const cn = await m2.corner();
  check(!!cn && /^Bar \d+:\d\d(:\d\d)? · ATR\(14\) [\d,.]+$/.test(cn.text), '4h corner readout: "' + (cn && cn.text) + '"');
  check((await m2.layers()).delta === false, '4h: no delta pane (intraday bars only)');
  // 1D: the trading day at 00:00, the intraday indicators noted
  await page.evaluate(() => window.LivePrefs.create(localStorage).updatePane('m2', () => window.LivePrefs.defaultPane('main')));
  await setTf(page, 'm2', 'd1');
  const bD = await until(async () => { const b = await m2.bars(); return b.length > 2 && b.every(x => et(x.t) === 0) ? b : null; }, 'the 1D bars', 15000);
  check(!!bD, '1D bars: each its trading day at 00:00 (' + (bD ? bD.length : 0) + ')');
  await page.reload();
  await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
  await enterPin(page, TEST_PIN);
  await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 40000 });
  await until(async () => (await m2.bars()).length > 2, '1D bars after the reload', 15000);
  const lay = await m2.layers();
  check(lay.vwap === false && lay.levels === false && lay.vp === false && lay.delta === false, '1D: VWAP, levels, profile and delta not drawn ' + JSON.stringify({ vwap: lay.vwap, levels: lay.levels, vp: lay.vp, delta: lay.delta }));
  const nD = await until(async () => { const n = await m2.note(); return /intraday: not drawn on 1D bars/.test(n.range) ? n : null; }, 'the 1D note', 5000);
  check(!!nD, '1D: the note says why: "' + (nD && nD.range) + '"');
  await setTf(page, 'm2', 'h4');
  await until(async () => (await m2.bars()).length > 5, 'the 4h bars again', 15000);
  const lay4 = await m2.layers();
  check(lay4.vwap === true && lay4.levels === true, '4h: VWAP and levels drawn (from the 1-minute bars)');
  const vw4 = await page.evaluate(() => { const el = document.querySelector('.ws-panel[data-id="m2"] [id$="lgVw"]'); return el ? el.textContent : ''; });
  check(/^[\d,]+\.\d\d$/.test(vw4), '4h: the VWAP value in the legend from the 1-minute bars (' + vw4 + ')');
  // a refused request: why, and asked again 60 s later
  await control(PORT, 'htf', { fail: 'NinjaTrader did not answer within 15 s; it can be asked again in 60 s (from 2026-10-02 10:15:02.123 ET)' });
  const t1W = Date.now();
  await setTf(page, 'm2', 'w1');
  const nW = await until(async () => { const n = await m2.note(); return /^1W bars: NinjaTrader did not answer within 15 s/.test(n.range) ? n : null; }, 'the refusal note', 8000);
  check(!!nW && (await m2.bars()).length === 0, '1W refused: no bars and the reason "' + (nW && nW.range) + '"');
  await control(PORT, 'htf', { fail: '' });
  const bW = await until(async () => { const b = await m2.bars(); return b.length ? b : null; }, '1W asked again after 60 s', 75000);
  const dt = (Date.now() - t1W) / 1000;
  check(!!bW && dt >= 59, '1W asked again ' + dt.toFixed(0) + ' s after the refusal, then shown (' + (bW ? bW.length : 0) + ' bars, each a Monday: ' + (bW ? bW.every(x => new Date(x.t * 1000).getUTCDay() === 1) : '-') + ')');
  await setTf(page, 'm2', 'h4');

  /* ================================================================ the deeper 1 hour history */
  console.log('1 hour charts load 30 days');
  const m1 = C(page, 'm1');
  const before = (await received(PORT)).subscribes || [];
  const tLoad = async (tf, more) => {
    const n0 = ((await received(PORT)).subscribes || []).length, t0 = Date.now();
    await setTf(page, 'm1', tf);
    if (more) await until(async () => ((await received(PORT)).subscribes || []).length > n0 || null, 'a new subscribe for ' + tf, 5000);
    else await page.waitForTimeout(800);
    await page.waitForFunction(() => window.workspace.views().every(v => v.state !== 'loading'), null, { timeout: 20000 });
    await until(async () => (await m1.bars()).length > 0, tf + ' bars', 10000);
    return { ms: Date.now() - t0, subs: ((await received(PORT)).subscribes || []).slice(n0) };
  };
  const h1 = await tLoad('h1', true);
  const s30 = h1.subs.filter(s => s.root === 'MNQ');
  check(s30.length >= 1 && s30.every(s => s.days === 30), 'switching to 1 hour: one MNQ subscribe with days 30 (' + JSON.stringify(s30.map(s => s.days)) + ')');
  const hb = await m1.bars();
  const span = hb.length ? (hb[hb.length - 1].t - hb[0].t) / 86400 : 0;
  check(span > 25, 'the 1 hour chart holds ' + span.toFixed(1) + ' days (' + hb.length + ' bars)');
  check((await m2.bars()).length > 5, 'the 4 hour chart on the same instrument kept its bars');
  const m15 = await tLoad('m15', false);
  check(m15.subs.length === 0 || m15.subs.every(s => s.days >= 10), '15 minute: covered by the 30 days already loaded (no smaller load)');
  await setTf(page, 'm1', 'm5');
  // the load's time at 30 days against 5 (sample data): a fresh window each
  const timeLoad = async tf => {
    await page.evaluate(t => { const s = JSON.parse(localStorage.getItem('live-workspace-v1')); s.layouts['Time' + t] = { panels: [{ id: 'tt' + t, type: 'chart', root: 'MES', tf: t, x: 0, y: 0, w: 12, h: 6 }] }; localStorage.setItem('live-workspace-v1', JSON.stringify(s)); }, tf);
    const p2 = await ctx.newPage();
    p2.on('pageerror', e => fail('page error: ' + e.message));
    await p2.goto(`http://localhost:${PORT}/live/?layout=Time${tf}`);
    await p2.waitForSelector('.cb-pin-key', { timeout: 15000 });
    await enterPin(p2, TEST_PIN);
    const t0 = Date.now();
    await p2.waitForFunction(id => { const c = window.workspace && window.workspace.chart(id); return c && c.bars().length > 0 && window.workspace.views().every(v => v.state === 'live'); }, 'tt' + tf, { timeout: 30000, polling: 20 });
    const ms = Date.now() - t0, n = await p2.evaluate(id => window.workspace.chart(id).bars().length, 'tt' + tf);
    await p2.close();
    return { ms, n };
  };
  const lt5 = await timeLoad('m5'), lt30 = await timeLoad('h1');
  console.log(`  load (reload to live, sample data): 5 min chart, 5 days: ${lt5.ms} ms (${lt5.n} bars); 1 hour chart, 30 days: ${lt30.ms} ms (${lt30.n} bars)`);
  check(lt30.ms < 15000, '30 days load in ' + lt30.ms + ' ms (5 days: ' + lt5.ms + ' ms)');
  void before;

  /* ================================================================ the corner readout */
  console.log('the corner readout');
  for (const id of ['m1', 'm2', 'm3', 'm4']) {
    const c = await C(page, id).corner();
    check(!!c && /^Bar /.test(c.text) && /ATR\(14\)/.test(c.text), id + ': "' + (c && c.text) + '"');
  }
  const head = await page.evaluate(() => [...document.querySelectorAll('.ws-panel .legend')].map(l => l.innerText).join(' | '));
  check(!/vs settle/.test(head) && !/\bBar \d/.test(head) && !/ATR\(/.test(head), 'no countdown, ATR or % change left in the headers');
  check(await page.evaluate(() => document.querySelector('.ws-panel[data-id="m3"] .ws-body > .chart-live').classList.contains('short')), 'm3 is a small panel (short header)');
  await page.click('.ws-panel[data-id="m3"] .lg-tog');
  await page.waitForTimeout(1300);
  const c3 = await C(page, 'm3').corner();
  check(!!c3, 'with the header text off, the corner readout stays (' + (c3 && c3.text) + ')');
  await shot(page, 'h1-corner-small-1920.png', await page.locator('.ws-panel[data-id="m3"]').boundingBox());
  await page.click('.ws-panel[data-id="m3"] .lg-tog');

  /* ================================================================ the Quote board */
  console.log('the Quote board');
  const nqSet = 30760.5;
  await control(PORT, 'settlement', { root: 'NQ', p: nqSet, date: '2026-10-01' });   // a known prior settlement (sample data)
  await control(PORT, 'price', { root: 'NQ', p: 31053.75 });
  await control(PORT, 'hold', { root: 'NQ' });
  const qRow = await until(async () => { const r = await page.evaluate(() => { const row = document.querySelector('.ws-panel.quotes [data-root="NQ"]'); return row ? [...row.querySelectorAll('[data-q]')].reduce((o, e) => (o[e.dataset.q] = e.textContent, o), {}) : null; }); return r && r.last === '31,053.75' ? r : null; }, 'the NQ quote', 8000);
  const qRoots = await page.evaluate(() => [...document.querySelectorAll('.ws-panel.quotes')].map(b => [...b.querySelectorAll('[data-root]')].map(r => r.dataset.root).join(',')));
  check(qRoots.length > 0 && qRoots.every(x => x === 'NQ,ES'), '1.16.0: every Quote board has rows for NQ and ES only (' + JSON.stringify(qRoots) + ')');
  if (qRow) {
    const chg = 31053.75 - nqSet, pct = chg / nqSet * 100;
    const fmt = (v, d) => (v > 0 ? '+' : v < 0 ? '-' : '') + Math.abs(v).toFixed(d).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    check(qRow.chg === fmt(chg, 2) && qRow.pct === fmt(pct, 2) + '%', 'NQ: last 31,053.75, change ' + qRow.chg + ' and ' + qRow.pct + ' from the prior settlement ' + nqSet);
    const n = s => +s.replace(/,/g, '');
    check(n(qRow.high) >= 31053.75 && n(qRow.low) <= 31053.75, 'NQ: the session high ' + qRow.high + ' and low ' + qRow.low + ' hold the last');
  }

  /* ================================================================ orders on MNQ: the ticket armed, a bracket */
  console.log('orders: compact labels, the ring and Shift+click, the Account panel');
  const tk = id => page.locator(`.ws-panel[data-type="ticket"] [data-tk-id="${id}"]`);
  await tk('bStop').fill('8'); await tk('bStop').press('Enter');
  await tk('bTarget').fill('16'); await tk('bTarget').press('Enter');
  await tk('armBtn').click();
  await tk('buyMkt').click();
  await until(async () => { const s = await state(); return s.positions['Sim101|MNQ'] && s.positions['Sim101|MNQ'].qty === 1 && s.orders.length === 2 ? s : null; }, 'long 1 with its stop and target', 8000);
  await page.evaluate(() => window.workspace.chart('m1').goLive());
  await page.waitForTimeout(800);
  // compact labels: the full label's hit areas; the full label on hover
  const hs = await until(async () => { const h = await m1.handles(); return h.length === 2 ? h : null; }, 'the two legs on m1', 5000);
  const cb = await m1.canvas().boundingBox();
  if (hs) {
    check(hs.every(h => h.box.h === 18 && h.xbox && h.xbox.w === 18), 'the legs keep the full label\'s hit area (18 px) and the x (18 px)');
    await shot(page, 'h1-labels-compact-1920.png', { x: cb.x + cb.width - 330, y: cb.y + Math.max(0, Math.min(...hs.map(h => h.box.y)) - 60), width: 330, height: 260 });
    const h = hs[0];
    await page.mouse.move(cb.x + h.box.x + h.box.w - 6, cb.y + h.box.y + 9);
    await page.waitForTimeout(200);
    check(await page.evaluate(() => window.workspace.chart('m1').labelHover()) === h.id, 'the mouse over a label: it shows in full (' + h.id + ')');
    await shot(page, 'h1-labels-hover-1920.png', { x: cb.x + cb.width - 330, y: cb.y + Math.max(0, Math.min(...hs.map(x => x.box.y)) - 60), width: 330, height: 260 });
    await page.mouse.move(cb.x + 40, cb.y + 40);
  }

  // the ring: a middle-click on m1's plot
  const ring = async (x, y) => { await page.mouse.move(x, y); await page.mouse.down({ button: 'middle' }); await page.mouse.up({ button: 'middle' }); await page.waitForTimeout(150); };
  await page.evaluate(() => { window.__middle.length = 0; });
  const rx = cb.x + cb.width * 0.4, ry = cb.y + cb.height * 0.4;
  await ring(rx, ry);
  const rr = await page.evaluate(() => { const r = document.getElementById('wsRing'); if (r.hidden) return null; const b = r.getBoundingClientRect(); return { cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; });
  check(!!rr && Math.abs(rr.cx - rx) < 2 && Math.abs(rr.cy - ry) < 2, 'a middle-click opens the ring centred on the pointer');
  const mid = await page.evaluate(() => window.__middle);
  check(mid.length >= 1 && mid.every(m => m.prevented), 'the middle press kept from the browser (no auto-scroll): ' + JSON.stringify(mid));
  await shot(page, 'h1-ring-1920.png', { x: rx - 90, y: ry - 90, width: 180, height: 180 });
  const order0 = (await received(PORT)).types.order || 0;
  await page.click('#wsRing [data-ring="hline"]');
  check(await m1.tool() === 'hline' && await C(page, 'm3').tool() === null, 'Price line armed on THAT chart only');
  check(await page.evaluate(() => document.activeElement === document.body), 'the focus back on the page (the hotkeys work at once)');
  check(await page.evaluate(() => document.getElementById('wsKeys').classList.contains('on')), 'KEYS ON');
  // a Shift+click with the tool armed: the order goes, no drawing
  const yBelow = await m1.priceToY(L - 10);
  await page.keyboard.down('Shift'); await page.mouse.click(cb.x + cb.width * 0.45, cb.y + yBelow); await page.keyboard.up('Shift');
  await until(async () => ((await received(PORT)).types.order || 0) > order0, 'the Shift+click order', 5000);
  check(((await received(PORT)).types.order || 0) === order0 + 1, 'a Shift+click with Price line armed places the order (one order sent)');
  check((await m1.drawings()).length === 0 && await m1.tool() === 'hline', 'and draws nothing; the tool stays armed for a plain click');
  await page.mouse.click(cb.x + cb.width * 0.45, cb.y + cb.height * 0.3);
  const d1 = await m1.drawings();
  check(d1.length === 1 && d1[0].type === 'hline' && await m1.tool() === null, 'a plain click draws the price line, then the tool is off');
  // the Zone, click-click
  await ring(rx, ry);
  await page.click('#wsRing [data-ring="zone"]');
  check(await m1.tool() === 'zone', 'Zone armed');
  await page.mouse.click(cb.x + cb.width * 0.25, cb.y + cb.height * 0.25);
  await page.mouse.click(cb.x + cb.width * 0.55, cb.y + cb.height * 0.45);
  const dz = await m1.drawings();
  check(dz.length === 2 && dz[1].type === 'zone', 'a Zone drawn with two clicks and saved with the chart\'s drawings');
  await page.waitForTimeout(200);
  await shot(page, 'h1-zone-1920.png', cb);
  // Escape: the ring, an armed tool
  await ring(rx, ry);
  await page.keyboard.press('Escape');
  check(await page.evaluate(() => document.getElementById('wsRing').hidden), 'Escape closes the ring');
  await ring(rx, ry);
  await page.click('#wsRing [data-ring="trend"]');
  await page.keyboard.press('Escape');
  check(await m1.tool() === null, 'Escape takes back an armed tool');
  await ring(rx, ry);
  await page.mouse.click(cb.x + 30, cb.y + 30);
  check(await page.evaluate(() => document.getElementById('wsRing').hidden), 'a click outside closes the ring');
  // near the right edge: the ring stays inside the plot
  await ring(cb.x + cb.width - 90, cb.y + cb.height - 40);
  const edge = await page.evaluate(() => { const b = document.getElementById('wsRing').getBoundingClientRect(); return { r: b.right, b: b.bottom }; });
  check(edge.r <= cb.x + cb.width - 78 + 1 && edge.b <= cb.y + cb.height, 'near the price axis the ring moves in, inside the plot');
  await page.click('#wsRing [data-ring="clear"]');
  check((await m1.drawings()).length === 0, 'Clear this chart');
  check(!(await page.locator('#wsMore [data-tool]').count()), 'the drawing tools left the small menu (Reset view stays)');

  // the Account panel
  const s1 = await state();
  const limit = s1.orders.find(o => o.kind === 'limit' && o.role === 'entry' || (o.kind === 'limit' && !o.role)) || s1.orders.find(o => o.price === L - 10);
  check(!!limit, 'a working buy limit from the Shift+click');
  await page.click('.ws-panel.account .ac-tab[data-tab="ord"]');
  const rows = await page.locator('.ws-panel.account [data-cancel]').count();
  check(rows >= 3, 'Orders: the stop, the target and the limit (' + rows + ' rows)');
  await shot(page, 'h1-account-orders-1920.png', await page.locator('.ws-panel.account').boundingBox());
  await tk('armBtn').click();                                   // Armed off
  const c0 = ((await received(PORT)).orderActions || []).filter(a => a.type === 'cancel').length;
  await page.click(`.ws-panel.account [data-cancel="${limit.id}"]`);
  await page.waitForTimeout(500);
  check(((await received(PORT)).orderActions || []).filter(a => a.type === 'cancel').length === c0, 'x with Armed off: nothing sent');
  const tnote = await page.evaluate(() => (document.querySelector('[data-tk-id="note"]') || {}).textContent || '');
  check(/Armed is off/.test(tnote), 'and the ticket says why: "' + tnote + '"');
  await tk('armBtn').click();                                   // Armed on
  await page.click(`.ws-panel.account [data-cancel="${limit.id}"]`);
  await until(async () => !(await state()).orders.some(o => o.id === limit.id), 'the limit cancelled', 5000);
  check(!(await state()).orders.some(o => o.id === limit.id), 'x while Armed: the limit cancelled (the chart\'s x path)');

  // the disarmed note on the chart
  await tk('armBtn').click();                                   // Armed off
  await page.waitForTimeout(300);
  const h2 = (await m1.handles())[0];
  if (h2) {
    await page.mouse.move(cb.x + h2.box.x + 6, cb.y + h2.box.y + 9); await page.mouse.down(); await page.mouse.move(cb.x + h2.box.x - 30, cb.y + h2.box.y + 40); await page.mouse.up();
    const n = await until(async () => { const x = await m1.note(); return /Armed is off: arm to move or cancel orders/.test(x.msg) ? x : null; }, 'the disarmed note', 3000);
    check(!!n, 'a press on a leg with Armed off: "' + (n && n.msg) + '"');
    check((await state()).orders.length === 2, 'and nothing moved');
  }
  // Close works with Armed off, in this window and in a window without the ticket
  const B = await openWs(ctx, PORT, 'Second');
  await B.waitForTimeout(1500);
  check(await B.evaluate(() => !window.workspace.ticket().held), 'the Second window has no ticket');
  await B.click('.ws-panel.account .ac-tab[data-tab="ord"]');
  const bx = (await state()).orders[0];
  const cb0 = ((await received(PORT)).orderActions || []).filter(a => a.type === 'cancel').length;
  await B.click(`.ws-panel.account [data-cancel="${bx.id}"]`);
  await B.waitForTimeout(800);
  const bnote = await B.evaluate(() => window.__notes.join(' | '));
  check(((await received(PORT)).orderActions || []).filter(a => a.type === 'cancel').length === cb0 && /Armed is off/.test(bnote), 'x in the other window, Armed off: forwarded, refused there, said here ("' + bnote.slice(-80) + '")');
  await B.click('.ws-panel.account .ac-tab[data-tab="pos"]');
  const f0 = ((await received(PORT)).orderActions || []).filter(a => a.type === 'flatten').length;
  await control(PORT, 'price', { root: 'MNQ', p: L + 3 });         // bought at L: closed 3 points up, +$6.00 on MNQ
  await page.waitForTimeout(300);
  await B.click('.ws-panel.account [data-close="MNQ"]');
  await until(async () => ((await received(PORT)).orderActions || []).filter(a => a.type === 'flatten').length > f0, 'the Close', 5000);
  check(((await received(PORT)).orderActions || []).filter(a => a.type === 'flatten' && a.root === 'MNQ').length === f0 + 1, 'Close in the window without the ticket, Armed off: one flatten of MNQ, from its own connection');
  await until(async () => { const s = await state(); return !s.orders.length && !(s.positions['Sim101|MNQ'] || {}).qty; }, 'flat', 8000);
  // Fills: the round trip
  await page.click('.ws-panel.account .ac-tab[data-tab="fil"]');
  await page.waitForTimeout(1200);
  const fills = await page.evaluate(() => [...document.querySelectorAll('.ws-panel.account .gr-fil .gr-row:not(.gr-h)')].map(r => r.innerText.replace(/\s+/g, ' ')));
  check(fills.length >= 2 && / \+\$6\.00$/.test(fills[0]), 'Fills: the closing fill carries the trade\'s P&L, +$6.00 (' + fills.slice(0, 2).join(' / ') + ')');
  await control(PORT, 'price', { root: 'MNQ', p: L });
  const sum = await page.evaluate(() => [...document.querySelectorAll('.ws-panel.account .ac-sum b')].map(b => b.textContent));
  check(/^[+-]?\$/.test(sum[1]) && +sum[3] >= 1, 'the summary: realized ' + sum[1] + ', day ' + sum[2] + ', trades ' + sum[3]);
  await B.close();
  // Armed went off with the connection (a working order to press on: a buy limit below the price)
  await tk('armBtn').click();
  await page.keyboard.down('Shift'); await page.mouse.click(cb.x + cb.width * 0.45, cb.y + await m1.priceToY(L - 12)); await page.keyboard.up('Shift');
  await until(async () => (await state()).orders.length === 1, 'a working limit', 5000);
  await page.waitForTimeout(500);
  await control(PORT, 'drop');
  await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live') && window.workspace.ticket().enabled, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  const h3 = (await m1.handles())[0];
  if (h3) {
    await page.mouse.move(cb.x + h3.box.x + 6, cb.y + h3.box.y + 9); await page.mouse.down(); await page.mouse.up();
    const n = await until(async () => { const x = await m1.note(); return /Armed went off: ChartBridge reconnected/.test(x.msg) ? x : null; }, 'the reconnect note', 3000);
    check(!!n, 'after a reconnect: "' + (n && n.msg) + '"');
  }

  if (await page.evaluate(() => window.workspace.ticket().armed)) await tk('armBtn').click();
  check(!(await page.evaluate(() => window.workspace.ticket().armed)), 'Armed off at the end');


  /* ================================================================ ChartBridge 0.3.6: no htf, no settlement */
  console.log('ChartBridge 0.3.6');
  await startBridge(OLD_PORT, ['--trading', '--trade-accounts=Sim101', '--test-controls', '--version=0.3.6', '--live-rate=20', '--test-pin=' + TEST_PIN]);
  const ctxOld = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await ctxOld.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctxOld.addInitScript(seed, [{ Main: { panels: MAIN } }]);
  const O = await openWs(ctxOld, OLD_PORT, 'Main');
  await O.waitForTimeout(2000);
  const on = await until(async () => { const n = await C(O, 'm2').notice(); return /4h bars need ChartBridge 0\.3\.7 or newer/.test(n) ? n : null; }, 'the 0.3.7 notice', 8000);
  check(!!on, 'a 4h chart with ChartBridge 0.3.6 says so: "' + on + '"');
  check(((await received(OLD_PORT)).types.htf || 0) === 0, 'and asks nothing');
  await O.click('.ws-panel[data-id="m1"] .ws-view');
  const old = await O.evaluate(() => ({ cls: [...document.querySelectorAll('#wsView [data-tf="h4"], #wsView [data-tf="d1"], #wsView [data-tf="w1"]')].map(b => b.className), need: (document.querySelector('#wsView .vw-need') || {}).textContent }));
  check(old.cls.length === 3 && old.cls.every(c => /vw-old/.test(c)) && /Needs ChartBridge 0\.3\.7 or newer/.test(old.need || ''), 'the 4h, 1D and 1W choices show and say they need 0.3.7');
  await O.keyboard.press('Escape');
  const oq = await O.evaluate(() => { const row = document.querySelector('.ws-panel.quotes [data-root="NQ"]'); return [...row.querySelectorAll('[data-q]')].reduce((o, e) => (o[e.dataset.q] = e.textContent, o), {}); });
  check(oq.last && oq.last !== '-' && oq.chg === '' && oq.pct === '', 'the Quote board without a settlement: the last, the change blank (' + JSON.stringify(oq) + ')');
  await shot(O, 'h1-old-bridge-1920.png');
  await ctxOld.close();

  /* ================================================================ screenshots: two-monitor-style layouts */
  console.log('screenshots');
  for (const [w, h] of [[1366, 768], [1920, 1080], [2560, 1440]]) {
    const c2 = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await c2.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await c2.addInitScript(seed, [{ Main: { panels: MAIN }, Second: { panels: SECOND } }]);
    for (const l of ['Main', 'Second']) {
      const p = await openWs(c2, PORT, l);
      await p.waitForTimeout(3000);
      await shot(p, `h1-${l.toLowerCase()}-${w}.png`);
      if (l === 'Main') {
        await shot(p, `h1-account-${w}.png`, await p.locator('.ws-panel.account').boundingBox());
        await shot(p, `h1-quotes-${w}.png`, await p.locator('.ws-panel.quotes').boundingBox());
        const cbx = await p.locator('.ws-panel[data-id="m1"] canvas').first().boundingBox(), cc = await p.evaluate(() => window.workspace.chart('m1').corner());
        if (cc) await shot(p, `h1-corner-${w}.png`, { x: cbx.x + cc.x - 40, y: cbx.y + cc.y - 30, width: Math.min(cc.w + 140, cbx.width - cc.x + 40), height: 70 });
        const cut = await p.evaluate(() => [...document.querySelectorAll('.ws-panel.account .gr-row > *, .ws-panel.account .gr .pr > *, .ws-panel.quotes .gr-row > *, .ws-panel.quotes .gr .pr > *, .ac-sum b')]
          .filter(e => e.getClientRects().length && e.scrollWidth > e.clientWidth + 1).map(e => e.textContent));
        check(!cut.length, `${w}x${h}: no figure cut in the Account panel or the Quote board` + (cut.length ? ': ' + cut.join(', ') : ''));
      }
      await p.close();
    }
    await c2.close();
  }
  await ctx.close();
} finally {
  await browser.close();
  for (const b of bridges) b.kill();
}
console.log(`\n${checks - errors.length}/${checks} checks passed`);
if (errors.length) { console.error(errors.length + ' failed'); process.exit(1); }
