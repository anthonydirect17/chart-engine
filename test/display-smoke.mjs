// The display round (chart 1.14.0, Anthony's list of 2026-10-01) against the fake bridge (ChartBridge 0.3.8's protocol,
// sample data; nothing reaches a broker), in Chromium:
//   - grid lines off by default on both pages, on and off again from Settings (shared by every chart);
//   - the room right of price: 80 px by default, kept at any zoom and by Jump to live, changed in Settings;
//   - zoom to brackets: a working order far from price comes on screen, eased (never a snap); a planned stop and target too;
//   - the VWAP no longer sizes the chart: off the scale it draws an edge marker;
//   - the readouts: the bar countdown (Range: ticks left), ATR(14), the change from the prior settlement (blank with none);
//   - Time and Sales by category with ChartBridge 0.3.8's q (each its own color, editable in the gear, big trades brighter
//     and bold, a tape that joins later colored the same), and by side with an older ChartBridge (no q);
//   - panels resized from an edge and a corner, an overlap refused;
//   - the single chart page's layout: one toolbar line, 2-letter chips, the small menu, Settings with the general controls,
//     Colors in the toolbar, Armed: the chart's outline purple with the glow, the order bar deep red;
//   - the versions in the LIVE badge's tooltip and in Settings.
// Screenshots in test/out/ at 1366x768, 1920x1080 and 2560x1440 of both pages, and close crops of the tape and the Colors
// panel.
//   npm run smoke:display        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const require = createRequire(import.meta.url);
const CE = require('../src/chart-engine.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const SHOTS = process.env.SHOTS_DIR || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const PORT = +(process.env.DISPLAY_SMOKE_PORT || 8895);
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

/* Time and Sales category (ChartBridge 0.3.8's q) on every live trade: the fake's own when it sends one, else made up from
   the side and size (sample data, so the smoke does not depend on the fake's version); or, with window.__noQ, none at all
   (ChartBridge before 0.3.8). */
const tapeQ = () => {
  const d = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
  Object.defineProperty(WebSocket.prototype, 'onmessage', { configurable: true, get() { return d.get.call(this); }, set(fn) {
    d.set.call(this, fn && function (ev) {
      if (typeof ev.data !== 'string' || ev.data.indexOf('"tick"') < 0) return fn.call(this, ev);
      let m; try { m = JSON.parse(ev.data); } catch (e) { return fn.call(this, ev); }
      if (!m || m.type !== 'tick') return fn.call(this, ev);
      if (window.__noQ) delete m.q;
      else if (m.q === undefined) m.q = m.s === 1 ? (m.v >= 4 ? 2 : 1) : m.s === -1 ? (m.v >= 4 ? -2 : -1) : 0;
      return fn.call(this, new MessageEvent('message', { data: JSON.stringify(m) }));
    });
  } });
};

async function openPage(ctx, url) {
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('connPill') || document.getElementById('wsConn') || document.querySelector('.cb-pin-key'), null, { timeout: 15000 });
  if (await page.$('.cb-pin-key')) await enterPin(page, TEST_PIN);
  return page;
}
const singleLive = p => p.waitForFunction(() => /LIVE/.test((document.getElementById('connPill') || {}).textContent || '') && window.liveChart && window.liveChart.lastBar(), null, { timeout: 30000 });
const wsLive = p => p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 });

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  await startBridge(PORT, ['--trading', '--trade-accounts=Sim101', '--max-qty=MNQ:9', '--test-controls', '--version=0.3.8', '--data-037', '--live-rate=60', '--test-pin=' + TEST_PIN]);
  const L = Math.round((await control(PORT, 'hold', { root: 'MNQ' })).last);
  await control(PORT, 'price', { root: 'MNQ', p: L });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(tapeQ);

  /* ================================================================ /single.html */
  console.log('/single.html');
  const page = await openPage(ctx, `http://localhost:${PORT}/live/single.html`);
  await singleLive(page);
  await page.waitForTimeout(1200);
  const C = (fn, a) => page.evaluate(fn, a);

  // grid lines: off by default, one click in Settings, saved for every chart
  check(await C(() => window.liveChart.getGrid() === false), 'grid lines are off by default');
  await page.click('#setBtn');
  const setRows = await C(() => [...document.querySelectorAll('#setPanel .set-row .set-name')].map(e => e.textContent));
  check(['Glide', 'Range style', 'Grid lines', 'Room right'].every(t => setRows.includes(t)), 'Settings holds Glide, Range style, Grid lines and Room right: ' + setRows.join(', '));
  await page.click('#gridSeg [data-v="on"]');
  check(await C(() => window.liveChart.getGrid() === true && JSON.parse(localStorage.getItem('live-settings-v2')).grid === 'on'), 'Grid lines On: drawn and saved');
  await page.click('#gridSeg [data-v="off"]');
  check(await C(() => window.liveChart.getGrid() === false), 'Grid lines Off again');

  // room right of price: 80 px by default, at any zoom, and Jump to live keeps it
  const roomPx = () => C(() => Math.round(window.liveChart.room().gap));
  check(await C(() => window.liveChart.room().px === 80), 'room right: 80 px by default');
  const r0 = await roomPx();
  check(Math.abs(r0 - 80) <= 1, 'the last bar sits 80 px left of the price axis (' + r0 + ' px)');
  const box = await page.locator('#chart canvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(60); }
  await page.waitForTimeout(500);
  const r1 = await roomPx();
  check(Math.abs(r1 - 80) <= 1, 'zoomed out, still 80 px (' + r1 + ' px; before 1.14.0 a fixed 8 bars shrank to a few px)');
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5); await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(400);
  await page.keyboard.press('End'); await page.waitForTimeout(900);
  const r2 = await roomPx();
  check(Math.abs(r2 - 80) <= 1, 'End back to live keeps it (' + r2 + ' px)');
  await page.click('#setBtn'); await page.click('#roomSeg [data-v="160"]');
  await page.waitForTimeout(300);
  await page.waitForTimeout(400);
  const r3 = await roomPx();
  check(Math.abs(r3 - 160) <= 1 && await C(() => JSON.parse(localStorage.getItem('live-settings-v2')).room === 160), 'Room right 160 px: at once, saved (' + r3 + ' px)');
  await page.click('#roomSeg [data-v="80"]');
  await page.keyboard.press('Escape');
  await C(() => window.liveChart.reset());
  await page.waitForTimeout(600);

  // zoom to brackets: a working limit far below the price comes on screen, eased in with the axis re-fit
  const far = L - 150;
  check(await C(p => window.liveChart.priceScale().lo > p, far), 'a price 150 points down is off the scale to begin with');
  await control(PORT, 'elsewhere', { account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'limit', qty: 1, p: far });
  await until(() => C(p => window.liveChart.getOrders().some(o => o.price === p), far), 'the far order on the chart');
  const tr = await C(async p => {
    const c = window.liveChart, s = [];
    for (let k = 0; k < 40; k++) { s.push(c.priceScale().lo); await new Promise(r => requestAnimationFrame(r)); }
    return { s, target: c.priceScale().target, y: c.priceToY(p), h: c.priceScale().plotHeight };
  }, far);
  check(tr.target.lo < far && tr.y > 0 && tr.y < tr.h, 'zoom to brackets: the order is on screen (y ' + Math.round(tr.y) + ' of ' + Math.round(tr.h) + ')');
  const steps = tr.s.filter((v, i) => i && v !== tr.s[i - 1]).length, mids = tr.s.filter(v => v < tr.s[0] - 0.01 && v > tr.target.lo + 0.01).length;
  check(steps >= 3 && mids >= 2, 'eased with the 120 ms re-fit, never a snap (' + steps + ' steps, ' + mids + ' frames in between)');
  await shot(page, 'display-1920-zoom-to-brackets.png');
  await page.click('#armBtn'); await page.click('#cancelAllBtn');
  await until(() => C(() => window.liveChart.getOrders().length === 0), 'the far order cancelled');
  await page.click('#armBtn');

  // the engine itself, on its own bars: a planned stop and target in the fit, the VWAP out of it with its edge marker
  const eng = await C(() => {
    const div = document.createElement('div'); div.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:400px;visibility:hidden'; document.body.appendChild(div);
    const c = window.ChartEngine.create(div, { tick: 0.25, layers: { volume: false } });
    const bars = []; for (let i = 0; i < 60; i++) bars.push({ t: 36000 + i * 60, o: 100, h: 101, l: 99, c: 100.5, v: 10, vw: 140 });
    c.setBars(bars, { barSeconds: 60 });
    return new Promise(res => setTimeout(() => {
      const a = c.priceScale().target;
      c.setOrders([{ id: 'e', side: 'buy', kind: 'limit', price: 98, qty: 1 }, { id: 'e:stop', side: 'sell', kind: 'stop', price: 88, qty: 1, plan: { parent: 'e', offset: -40, role: 'stop' } },
        { id: 'e:target', side: 'sell', kind: 'limit', price: 113, qty: 1, plan: { parent: 'e', offset: 60, role: 'target' } }]);
      setTimeout(() => { const b = c.priceScale().target, m = c.vwapMarker(); c.destroy(); div.remove(); res({ a, b, m }); }, 200);
    }, 300));
  });
  check(eng.a.hi < 110 && eng.a.lo > 90, 'a VWAP 40 points above the candles does not size the chart (scale ' + eng.a.lo.toFixed(2) + ' to ' + eng.a.hi.toFixed(2) + ')');
  check(eng.b.lo < 88 && eng.b.hi > 113, 'planned stop (-40t) and target (+60t) lines are in the fit (' + eng.b.lo.toFixed(2) + ' to ' + eng.b.hi.toFixed(2) + ')');
  check(!!eng.m && eng.m.up === true && eng.m.price === 140, 'the off-scale VWAP gets an edge marker at the top: ' + JSON.stringify(eng.m));

  // readouts: the bar countdown, the ATR, the change from the prior settlement (ChartBridge 0.3.7+)
  await page.waitForTimeout(1200);
  const ro = await C(() => ({ bar: document.getElementById('lgBar').textContent, atr: document.getElementById('lgAtr').textContent, set: document.getElementById('lgSet').textContent, setHidden: document.getElementById('lgSet').hidden }));
  check(/^Bar \d+:\d\d$/.test(ro.bar), 'the bar countdown on 1 minute bars: "' + ro.bar + '"');
  check(/^ATR\(14\) [\d,]+\.\d\d$/.test(ro.atr), 'ATR(14) of the closed bars: "' + ro.atr + '"');
  const hello = await control(PORT, 'state', { root: 'MNQ' }).catch(() => null);
  const expect = await C(() => { const b = window.liveChart.lastBar(); return b ? b.c : null; });
  check(/^[+-]\d+\.\d\d% vs settle$/.test(ro.set) && !ro.setHidden, 'the change from the prior settlement: "' + ro.set + '" (last ' + expect + ')');
  await control(PORT, 'settlement', { root: 'MNQ', p: String(L - 100), date: '2026-10-01' });
  await page.waitForTimeout(1300);
  const pct = await C(() => document.getElementById('lgSet').textContent);
  const lastNow = await C(() => window.liveChart.lastBar().c);
  const want = ((lastNow - (L - 100)) / (L - 100) * 100);
  check(pct === (want >= 0 ? '+' : '') + want.toFixed(2) + '% vs settle', 'a new settlement from ChartBridge: "' + pct + '" (' + want.toFixed(4) + ')');
  await control(PORT, 'settlement', { root: 'MNQ', p: 'null' });
  await page.waitForTimeout(1300);
  check(await C(() => document.getElementById('lgSet').hidden && document.getElementById('lgSet').textContent === ''), 'no settlement: blank, never estimated');
  await page.click('#tfSeg [data-v="range"]');
  await until(() => C(() => /^Bar ▲\d+ ▼\d+t$/.test(document.getElementById('lgBar').textContent)), 'Range bars: ticks left up and down', 15000);
  check(true, 'Range bars: "' + await C(() => document.getElementById('lgBar').textContent) + '"');
  await page.click('#tfSeg [data-v="m1"]');
  void hello;

  // versions: the LIVE pill's tooltip and Settings
  const ver = await C(() => ({ pill: document.getElementById('connPill').title, set: document.getElementById('setVer').textContent }));
  check(ver.pill === 'chart ' + CE.VERSION + ' · ChartBridge ' + (await C(() => /ChartBridge (\S+)/.exec(document.getElementById('lgSrc').textContent)[1])) && ver.set === ver.pill, 'versions: "' + ver.pill + '" (LIVE pill tooltip and Settings)');

  // the layout: one toolbar line, 2-letter chips, the small menu, Colors in the toolbar
  const lay = await C(() => {
    const rs = [...document.querySelector('header.bar').children].filter(c => c.getClientRects().length).map(c => c.getBoundingClientRect());
    return { one: Math.max(...rs.map(r => r.top)) < Math.min(...rs.map(r => r.bottom)), chips: [...document.querySelectorAll('#indChips .ind-chip')].map(c => c.textContent),
      colors: !!document.querySelector('header.bar .ce-theme-btn'), glideInBar: !!document.querySelector('header.bar > .group #glideSeg'), menu: [...document.querySelectorAll('#moreMenu button')].map(b => b.textContent) };
  });
  check(lay.one, 'one toolbar line at 1920');
  check(lay.chips.length && lay.chips.every(t => /^[A-Z]{2}$/.test(t)), '2-letter chips: ' + lay.chips.join(' '));
  check(lay.colors && !lay.glideInBar, 'Colors in the toolbar; Glide moved to Settings');
  check(lay.menu.join('|') === 'Trend line|Price line|Clear drawings|Reset view', 'the small menu: ' + lay.menu.join(', '));
  await page.click('#moreBtn'); await page.click('#toolTrend');
  check(await C(() => window.liveChart.getTool() === 'trend' && document.getElementById('moreMenu').hidden), 'Trend line from the menu: the tool is on, the menu closed');
  await C(() => window.liveChart.setTool(null));

  // Armed: the chart outlined in purple with the glow, the order bar deep red
  await page.click('#armBtn');
  await page.waitForTimeout(200);
  const arm = await C(() => { const st = getComputedStyle(document.querySelector('.stage')), ob = getComputedStyle(document.getElementById('obar'));
    return { border: st.borderTopColor, glow: st.boxShadow, obar: ob.borderTopColor }; });
  check(arm.border === 'rgb(123, 92, 255)' && /rgb\(123, 92, 255\)/.test(arm.glow) && arm.obar === 'rgb(224, 68, 94)', 'Armed: the chart purple with the glow, the order bar deep red: ' + JSON.stringify(arm));
  await page.click('#armBtn');

  // Anthony from WORK: the bubble's size shows the order size (area by size / floor), no numbers on the chart, the size
  // in the legend on hover
  await C(() => { localStorage.setItem('live-tape-floors-v1', JSON.stringify({ NQ: { rth: 2, eth: 2 } })); });
  await page.reload(); await page.waitForFunction(() => document.getElementById('connPill') || document.querySelector('.cb-pin-key'));
  if (await page.$('.cb-pin-key')) await enterPin(page, TEST_PIN);
  await singleLive(page);
  await page.click('#symSeg [data-v="NQ"]'); await singleLive(page);
  await page.click('#indBtn'); await page.fill('#indQ', 'bubbles'); await page.press('#indQ', 'Enter'); await page.keyboard.press('Escape');
  await until(() => C(() => window.liveChart.bubbles().length >= 4), 'bubbles on the NQ chart', 20000);
  const bub = await C(() => ({ list: window.liveChart.bubbles(), zoom: Math.min(1.6, Math.max(1, Math.sqrt(window.liveChart.stats ? 1 : 1))) }));
  const radiusOk = bub.list.every(q => Math.abs(q.r - CE.util.bubbleRadius(q.v, 2)) < 0.01 || q.r > CE.util.bubbleRadius(q.v, 2));
  const sizes = bub.list.map(q => q.v + ':' + q.r.toFixed(1));
  check(radiusOk && bub.list.some(q => q.v >= 4) && bub.list.every(q => q.v < 4 || q.r >= CE.util.bubbleRadius(4, 2) - 0.01), 'bubble radius by size / floor (4.8 px x sqrt): ' + sizes.slice(0, 8).join(' '));
  const pick = bub.list.reduce((a, q) => (q.r > a.r ? q : a), bub.list[0]);
  const cb = await page.locator('#chart canvas').boundingBox();
  await page.mouse.move(cb.x + pick.x, cb.y + pick.y);
  await page.waitForTimeout(150);
  const lgb = await C(() => ({ text: document.getElementById('lgBub').textContent, hidden: document.getElementById('lgBub').hidden, hov: window.liveChart.bubbleHover() }));
  check(!lgb.hidden && /^Bubble (Buy|Sell) [\d,.K]+ @ [\d,]+\.\d\d \d\d:\d\d:\d\d\.\d$/.test(lgb.text) && lgb.hov, 'hover: the bubble in the legend\'s top line: "' + lgb.text + '"');
  await shot(page, 'display-bubble-hover.png');
  await page.mouse.move(cb.x + 40, cb.y + cb.height - 60);
  await page.waitForTimeout(150);
  check(await C(() => document.getElementById('lgBub').hidden), 'away from it: gone');
  await C(() => localStorage.removeItem('live-tape-floors-v1'));
  await page.click('#symSeg [data-v="MNQ"]'); await singleLive(page);

  // the high never under the legend: the scale keeps the legend's height free at its top
  const top = await C(() => { const c = window.liveChart, lg = document.getElementById('legend'), box = document.getElementById('chart').getBoundingClientRect();
    const r = lg.getBoundingClientRect(), w = box.width - 78; let hi = -Infinity; const bs = c.bars();
    for (let i = 0; i < bs.length; i++) { const x = c.barToX(i); if (x >= 0 && x <= w && bs[i].h > hi) hi = bs[i].h; }
    return { legendBottom: r.bottom - box.top, highY: c.priceToY(hi) }; });
  check(top.highY >= top.legendBottom, 'single: the highest candle in view sits below the legend (' + Math.round(top.highY) + ' px, the legend ends at ' + Math.round(top.legendBottom) + ')');

  for (const [w, h] of [[1366, 768], [1920, 1080], [2560, 1440]]) {
    await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(700);
    const one = await C(() => { const rs = [...document.querySelector('header.bar').children].filter(c => c.getClientRects().length).map(c => c.getBoundingClientRect()); return Math.max(...rs.map(r => r.top)) < Math.min(...rs.map(r => r.bottom)); });
    check(one, `one toolbar line at ${w}x${h}`);
    await shot(page, `display-single-${w}.png`);
  }
  await page.setViewportSize({ width: 1920, height: 1080 });

  /* ================================================================ the workspace */
  console.log('workspace');
  const wp = await openPage(ctx, `http://localhost:${PORT}/live/?layout=Display`);
  await wsLive(wp);
  await wp.waitForTimeout(1500);
  const W = (fn, a) => wp.evaluate(fn, a);
  const charts = await W(() => window.workspace.panels().filter(p => p.type === 'chart').map(p => p.id));
  check((await W(ids => ids.map(id => window.workspace.chart(id).getGrid()), charts)).every(g => g === false), 'workspace: grid lines off on every chart');
  await wp.click('#wsSet');
  await wp.click('#wsGridLines [data-v="on"]');
  check((await W(ids => ids.map(id => window.workspace.chart(id).getGrid()), charts)).every(g => g === true), 'Settings: Grid lines On reaches every chart');
  await wp.click('#wsGridLines [data-v="off"]');
  const wver = await W(() => ({ badge: document.getElementById('wsConn').title, set: document.getElementById('wsVersion').textContent }));
  check(/^chart \d+\.\d+\.\d+ · ChartBridge \S+$/.test(wver.badge) && wver.badge.startsWith('chart ' + CE.VERSION + ' · ') && wver.set.startsWith(wver.badge), 'workspace versions: the LIVE badge\'s tooltip and Settings: "' + wver.badge + '"');
  await wp.keyboard.press('Escape');

  // Time and Sales: categories with q
  const tape = await W(() => window.workspace.panels().find(p => p.type === 'tape').id);
  await wp.selectOption(`.ws-panel[data-id="${tape}"] [data-act="root"]`, 'NQ');   // MNQ's price is held for the order checks: NQ trades
  const rowsOf = id => W(i => [...document.querySelectorAll(`.ws-panel[data-id="${i}"] .tp-row:not([hidden])`)].map(r => ({ c: r.className, p: getComputedStyle(r.querySelector('.tp-p')).color, w: getComputedStyle(r).fontWeight })), id);
  await until(async () => (await rowsOf(tape)).length > 10, 'tape rows');
  const cols = await W(() => { const s = getComputedStyle(document.documentElement); return ['above', 'ask', 'mid', 'bid', 'below'].map(k => s.getPropertyValue('--tape-' + k).trim()); });
  const rgb = h => { const n = parseInt(h.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };
  const qrows = (await rowsOf(tape)).filter(r => !/\bbig\b/.test(r.c));
  const byCat = {};
  for (const r of qrows) { const k = (r.c.match(/\bq(m?\d)\b/) || [])[1]; if (k) byCat[k] = r.p; }
  check(Object.keys(byCat).length >= 3 && qrows.every(r => /\bq(m?\d)\b/.test(r.c)), 'with q every row has its category (' + Object.keys(byCat).join(' ') + ')');
  const map = { 2: 0, 1: 1, 0: 2, m1: 3, m2: 4 };
  check(Object.entries(byCat).every(([k, c]) => c === rgb(cols[map[k]])), 'each category in its own color: ' + JSON.stringify(byCat));
  // the gear: a color changed reaches every tape at once, Default colors puts them back
  await wp.click(`.ws-panel[data-id="${tape}"] [data-act="gear"]`);
  check(await W(() => document.querySelectorAll('#wsTapeColors .tc-row').length === 5), 'the tape\'s gear lists the five colors');
  await wp.fill('#wsTapeColors [data-tchex="ask"]', '#00C2FF');
  await wp.waitForTimeout(200);
  check(await W(() => getComputedStyle(document.documentElement).getPropertyValue('--tape-ask').trim() === '#00C2FF' && JSON.parse(localStorage.getItem('live-tape-colors-v1')).ask === '#00C2FF'), 'At the ask set to #00C2FF: applied and saved');
  await shot(wp, 'display-tape-gear.png', await wp.locator('#wsGear').boundingBox());
  await wp.click('#wsTapeDefault');
  check(await W(() => getComputedStyle(document.documentElement).getPropertyValue('--tape-ask').trim() === '#3DDC97'), 'Default colors');
  await wp.keyboard.press('Escape');
  // big trades: the floor at 1 makes every new trade big: bold, brighter
  await W(() => localStorage.setItem('live-tape-floors-v1', JSON.stringify({ NQ: { rth: 4, eth: 4 } })));
  await wp.evaluate(() => window.dispatchEvent(new CustomEvent('chartlive-floors', { detail: { prefix: '' } })));
  await wp.waitForTimeout(1500);
  const big = (await rowsOf(tape)).filter(r => /\bbig\b/.test(r.c));
  check(big.length > 0 && big.every(r => +r.w >= 700), 'big trades (size 4 and more now): bold (' + big.length + ' rows)');
  const tb = await wp.locator(`.ws-panel[data-id="${tape}"]`).boundingBox();
  await shot(wp, 'display-tape-crop.png', { x: tb.x, y: tb.y, width: tb.width, height: Math.min(tb.height, 420) });
  await W(() => localStorage.removeItem('live-tape-floors-v1'));
  await wp.evaluate(() => window.dispatchEvent(new CustomEvent('chartlive-floors', { detail: { prefix: '' } })));
  // a tape that joins later starts with the trades so far, colored the same (q carried by the feed)
  await wp.click(`.ws-panel[data-id="${charts[3]}"] [data-act="close"]`);
  await wp.click('#wsAdd'); await wp.click('#wsAddMenu [data-add="tape"]');
  const tape2 = await W(t => window.workspace.panels().filter(p => p.type === 'tape').map(p => p.id).find(id => id !== t), tape);
  await wp.selectOption(`.ws-panel[data-id="${tape2}"] [data-act="root"]`, 'NQ');
  await until(async () => (await rowsOf(tape2)).length > 5, 'the new tape has rows');
  const rows2 = await rowsOf(tape2);
  check(rows2.every(r => /\bq(m?\d)\b/.test(r.c)), 'a tape added later colors the trades it starts with by category too (' + rows2.length + ' rows)');

  // panels resize from an edge and a corner; an overlap is refused
  const big1 = charts[1];
  const pOf = id => W(i => window.workspace.panels().find(p => p.id === i), id);
  const before = await pOf(big1);
  const edge = async (id, e, dx, dy) => {
    const b = await wp.locator(`.ws-panel[data-id="${id}"] .ws-edge-${e}`).boundingBox();
    await wp.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await wp.mouse.down();
    await wp.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 6 }); await wp.mouse.up(); await wp.waitForTimeout(150);
  };
  const cell = await W(() => { const g = document.getElementById('wsGrid'); return { cw: (g.clientWidth - 12 - 66) / 12 + 6, ch: (g.clientHeight - 12 - 30) / 6 + 6 }; });
  const cur = await wp.evaluate(id => getComputedStyle(document.querySelector(`.ws-panel[data-id="${id}"] .ws-edge-w`)).cursor, big1);
  check(cur === 'ew-resize', 'the left edge shows the resize cursor (' + cur + ')');
  await edge(big1, 'w', cell.cw, 0);
  const a1 = await pOf(big1);
  check(a1.x === before.x + 1 && a1.w === before.w - 1 && a1.y === before.y && a1.h === before.h, 'left edge in by one cell: ' + JSON.stringify([before.x, before.w]) + ' to ' + JSON.stringify([a1.x, a1.w]));
  await edge(big1, 'w', -cell.cw, 0);
  const a2 = await pOf(big1);
  check(a2.x === before.x && a2.w === before.w, 'and out again');
  await edge(big1, 'n', 0, -cell.ch);
  const a3 = await pOf(big1);
  check(a3.y === before.y && a3.h === before.h && /overlaps another panel/.test(await W(() => document.getElementById('wsNote').textContent)), 'the top edge up over the chart above: refused, said so');
  await edge(big1, 'nw', cell.cw, cell.ch * 0.6);
  const a4 = await pOf(big1);
  check(a4.x === before.x + 1 && a4.y === before.y + 1 && a4.w === before.w - 1 && a4.h === before.h - 1, 'the top left corner: both edges at once ' + JSON.stringify(a4));
  await edge(big1, 'nw', -cell.cw, -cell.ch * 0.6);
  // Anthony from WORK (50.png): the high ran under the legend on the smaller panels; every chart keeps it clear
  await wp.setViewportSize({ width: 1920, height: 1080 }); await wp.waitForTimeout(800);
  const clear = await W(() => window.workspace.panels().filter(p => p.type === 'chart').map(p => {
    const c = window.workspace.chart(p.id), el = document.querySelector(`.ws-panel[data-id="${p.id}"]`), lg = el.querySelector('.legend'), box = el.querySelector('.chart-box').getBoundingClientRect();
    const w = box.width - 78, bs = c.bars(); let hi = -Infinity;
    for (let i = 0; i < bs.length; i++) { const x = c.barToX(i); if (x >= 0 && x <= w && bs[i].h > hi) hi = bs[i].h; }
    return { tf: p.tf, legendBottom: Math.round(lg.getBoundingClientRect().bottom - box.top), highY: Math.round(c.priceToY(hi)) };
  }));
  check(clear.every(x => x.highY >= x.legendBottom), 'workspace: on every chart the high sits below the legend: ' + JSON.stringify(clear));
  for (const [w, h] of [[1366, 768], [1920, 1080], [2560, 1440]]) {
    await wp.setViewportSize({ width: w, height: h }); await wp.waitForTimeout(800);
    await shot(wp, `display-ws-${w}.png`);
    if (w === 1366) {
      await wp.click('#wsColors .ce-theme-btn'); await wp.waitForTimeout(200);
      await shot(wp, 'display-colors-crop.png', await wp.locator('#wsColors .ce-theme-panel').boundingBox());
      await wp.keyboard.press('Escape'); await wp.mouse.click(w - 4, h - 4);
    }
  }
  await ctx.close();

  /* ================================================================ an older ChartBridge: no q, no settlement */
  console.log('ChartBridge before 0.3.8 (no q) and before 0.3.7 (no settlement)');
  await startBridge(PORT + 1, ['--test-controls', '--version=0.3.6', '--live-rate=60', '--test-pin=' + TEST_PIN]);
  const ctx2 = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await ctx2.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx2.addInitScript(() => { window.__noQ = true; });
  await ctx2.addInitScript(tapeQ);
  const op = await openPage(ctx2, `http://localhost:${PORT + 1}/live/`);
  await wsLive(op);
  const otape = await op.evaluate(() => window.workspace.panels().find(p => p.type === 'tape').id);
  await until(async () => (await op.evaluate(i => document.querySelectorAll(`.ws-panel[data-id="${i}"] .tp-row:not([hidden])`).length, otape)) > 10, 'the older bridge\'s tape rows');
  const orows = await op.evaluate(i => [...document.querySelectorAll(`.ws-panel[data-id="${i}"] .tp-row:not([hidden])`)].map(r => ({ c: r.className, p: getComputedStyle(r.querySelector('.tp-p')).color })), otape);
  check(orows.every(r => !/\bq(m?\d)\b/.test(r.c)) && orows.some(r => /\bbuy\b/.test(r.c)) && orows.some(r => /\bsell\b/.test(r.c)), 'no q: the tape colors by side as before');
  check(orows.filter(r => /\bbuy\b/.test(r.c)).every(r => r.p === 'rgb(61, 220, 151)') && orows.filter(r => /\bsell\b/.test(r.c)).every(r => r.p === 'rgb(255, 92, 122)'), 'buys green, sells red');
  const sp = await openPage(ctx2, `http://localhost:${PORT + 1}/live/single.html`);
  await singleLive(sp);
  await sp.waitForTimeout(1500);
  check(await sp.evaluate(() => document.getElementById('lgSet').hidden), 'no settlement from ChartBridge 0.3.6: the change from it is blank');
  await ctx2.close();
} finally {
  await browser.close();
  for (const b of bridges) b.kill();
}
console.log(`\n${checks - errors.length}/${checks} checks passed`);
if (errors.length) { console.error(errors.length + ' failed'); process.exit(1); }
