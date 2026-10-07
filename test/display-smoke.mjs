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
//   - the versions in the LIVE badge's tooltip and in Settings;
//   - batch 2 (2026-10-02): the Levels gear's toggles (the IB in it, PD POC), the profile's developing lines and colors,
//     the VWAP's hours, every chip pinned at three sizes on both pages, the short header on small panels, no numbers on
//     the bubbles, and the header text toggle on both pages.
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
  // the ATR period in Settings (Anthony, review D2): 20, as typed; saved; back to 14
  await page.click('#setBtn'); await page.fill('#atrIn', '20'); await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(/^ATR\(20\) /.test(await page.textContent('#lgAtr')) && (await C(() => JSON.parse(localStorage.getItem('live-settings-v2')).atr)) === 20, 'Settings: ATR period 20, at once and saved: "' + await page.textContent('#lgAtr') + '"');
  await page.click('#setBtn'); await page.fill('#atrIn', '1'); await page.keyboard.press('Enter');
  check(await page.inputValue('#atrIn') === '20', 'a period out of range is not taken (the box shows the one in use)');
  await page.fill('#atrIn', '14'); await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
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
  // G (batch 2): the text the chart draws is recorded, to show no numbers are drawn on the bubbles
  await ctx.addInitScript(() => {
    const f = CanvasRenderingContext2D.prototype.fillText;
    window.__texts = [];
    CanvasRenderingContext2D.prototype.fillText = function (s, x, y) {
      if (window.__texts.length < 50000) { const m = this.getTransform(); window.__texts.push({ s: String(s), x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f, c: this.canvas }); }
      return f.apply(this, arguments);
    };
  });
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
  const onBub = await C(() => { const cv = document.querySelector('#chart canvas'), dpr = window.devicePixelRatio || 1; window.__texts.length = 0;
    return new Promise(res => setTimeout(() => { const bs = window.liveChart.bubbles();
      const hits = window.__texts.filter(t => t.c === cv && /\d/.test(t.s) && bs.some(q => Math.hypot(t.x / dpr - q.x, t.y / dpr - q.y) <= q.r + 2));
      res({ n: bs.length, texts: window.__texts.filter(t => t.c === cv).length, hits: hits.map(t => t.s) }); }, 600)); });
  check(onBub.n > 0 && onBub.texts > 0 && onBub.hits.length === 0, 'G: no numbers drawn on the ' + onBub.n + ' bubbles (' + onBub.texts + ' texts drawn, ' + JSON.stringify(onBub.hits.slice(0, 5)) + ' on a bubble)');
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
  await wp.fill('#wsAtr', '21'); await wp.keyboard.press('Enter'); await wp.waitForTimeout(1300);
  // 1.15.0: the workspace's ATR is in each chart's corner readout (smoke:h1), no longer in the header text
  const wAtr = await W(ids => ids.map(id => (window.workspace.chart(id).corner() || {}).text || ''), charts);
  check(wAtr.length > 0 && wAtr.every(t => /ATR\(21\) /.test(t) || /ATR [\d,.]+$/.test(t)), 'workspace Settings: ATR period 21 on every chart\'s corner readout: ' + JSON.stringify(wAtr));
  await wp.fill('#wsAtr', '14'); await wp.keyboard.press('Enter');
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
  // Anthony from WORK (50.png): the high ran under the legend on the smaller panels. 1.16.0: no legend on a workspace
  // chart; the high stays inside the plot on every chart
  await wp.setViewportSize({ width: 1920, height: 1080 }); await wp.waitForTimeout(800);
  const clear = await W(() => window.workspace.panels().filter(p => p.type === 'chart').map(p => {
    const c = window.workspace.chart(p.id), el = document.querySelector(`.ws-panel[data-id="${p.id}"]`), box = el.querySelector('.chart-box').getBoundingClientRect();
    const w = box.width - 78, bs = c.bars(); let hi = -Infinity;
    for (let i = 0; i < bs.length; i++) { const x = c.barToX(i); if (x >= 0 && x <= w && bs[i].h > hi) hi = bs[i].h; }
    return { tf: p.tf, legend: !!el.querySelector('.legend'), fitTop: c.getFitTop(), highY: Math.round(c.priceToY(hi)) };
  }));
  check(clear.every(x => !x.legend && x.fitTop === 0 && x.highY >= 0), 'workspace: no legend, and on every chart the high sits inside the plot: ' + JSON.stringify(clear));
  for (const [w, h] of [[1366, 768], [1920, 1080], [2560, 1440]]) {
    await wp.setViewportSize({ width: w, height: h }); await wp.waitForTimeout(800);
    await shot(wp, `display-ws-${w}.png`);
    if (w === 1366) {
      await wp.click('#wsColors .ce-theme-btn'); await wp.waitForTimeout(200);
      await shot(wp, 'display-colors-crop.png', await wp.locator('#wsColors .ce-theme-panel').boundingBox());
      await wp.keyboard.press('Escape'); await wp.mouse.click(w - 4, h - 4);
    }
  }

  /* ================================================================ batch 2 (Anthony, 2026-10-02): A to G and the header toggle */
  console.log('batch 2: levels, the profile, VWAP hours, chips, short header, header text');
  await page.bringToFront();                            // the workspace tab opened last: this one drawn again (rAF and resize)
  await page.setViewportSize({ width: 1920, height: 1080 }); await page.waitForTimeout(500);
  const gear = async (p, scope, id) => {
    if (await p.isHidden(scope + ' .ind-panel')) await p.click(scope + ' .ind-btn');
    if (!(await p.$(`${scope} .ind-set[data-id="${id}"]`))) await p.click(`${scope} .ind-body [data-act="gear"][data-id="${id}"]`);
  };
  const addInd = async (p, scope, q) => {
    if (await p.isHidden(scope + ' .ind-panel')) await p.click(scope + ' .ind-btn');
    await p.fill(scope + ' .ind-panel input[data-f="q"]', q); await p.press(scope + ' .ind-panel input[data-f="q"]', 'Enter');
    await p.fill(scope + ' .ind-panel input[data-f="q"]', '');
  };
  const spRoot = 'body';
  // B: Levels, each line its own toggle; the IB in it; the prior day's POC drawn and named PD POC
  await gear(page, spRoot, 'levels');
  const togs = await page.$$eval(spRoot + ' .ind-set[data-id="levels"] .ind-tog', bs => bs.map(b => b.textContent + (b.getAttribute('aria-pressed') === 'true' ? '+' : '-')));
  check(togs.join(' ') === 'PDH+ PDL+ Prior close+ ONH+ ONL+ PD VAH+ PD VAL+ PD POC+ IBH+ IBL+', 'B: Levels gear, each line its own toggle, on by default: ' + togs.join(' '));
  const lvNames = () => C(() => window.liveChart.getLevels().map(l => l.name));
  let names = await lvNames();
  check(names.includes('PD VAH') && names.includes('PD VAL') && !names.includes('VAH') && !names.includes('VAL'), 'B: the prior day\'s value area named PD VAH and PD VAL: ' + names.join(', '));
  check(names.includes('PD POC') && (await C(() => window.liveChart.getLevels().find(l => l.name === 'PD POC').dash.join('/'))) === '8/3/2/3', 'B: PD POC drawn, dash-dot');
  await shot(page, 'display-b2-levels-gear.png');
  await page.click(spRoot + ' [data-f="tog:levels:poc"]');
  names = await lvNames();
  check(!names.includes('PD POC') && names.includes('PDH'), 'B: PD POC off alone, the others kept');
  await page.click(spRoot + ' [data-f="tog:levels:poc"]');
  check((await lvNames()).includes('PD POC'), 'B: and back on');
  // C and A: the volume profile, its developing lines (on by default) and its three colors
  await addInd(page, spRoot, 'profile');
  await gear(page, spRoot, 'vp');
  const vpt = await page.$$eval(spRoot + ' .ind-set[data-id="vp"] .ind-tog', bs => bs.map(b => b.textContent + (b.getAttribute('aria-pressed') === 'true' ? '+' : '-')));
  check(vpt.join(' ') === 'dPOC+ dVAH+ dVAL+', 'C: the profile gear: dPOC, dVAH, dVAL toggles, on: ' + vpt.join(' '));
  check(JSON.stringify(await C(() => window.liveChart.getProfileLines())) === '{"poc":true,"vah":true,"val":true}', 'C: the chart draws all three');
  check((await page.$$(spRoot + ' .ind-set[data-id="vp"] .ind-color')).length === 3, 'A: the profile gear has rows, value area rows and POC colors');
  await shot(page, 'display-b2-vp-gear.png');
  await page.click(spRoot + ' [data-f="tog:vp:dvah"]');
  check(JSON.stringify(await C(() => window.liveChart.getProfileLines())) === '{"poc":true,"vah":false,"val":true}', 'C: dVAH off alone');
  await page.click(spRoot + ' [data-f="tog:vp:dvah"]');
  const vpCols = await C(() => { const t = window.liveChart.colors(); return [t.vpRow, t.vpValue]; });
  check(vpCols[0] === CE.DEFAULT_THEME.vpRow && vpCols[1] === CE.DEFAULT_THEME.vpValue, 'A: the brighter profile defaults in use: ' + vpCols.join(' '));
  // E: VWAP hours: full session by default, RTH only from the gear; the legend reads the anchored value
  await gear(page, spRoot, 'vwap');
  check(await page.getAttribute(spRoot + ' [data-f="opt:vwap:session:full"]', 'aria-pressed') === 'true', 'E: VWAP full session by default');
  await page.click(spRoot + ' [data-f="opt:vwap:session:rth"]');
  await page.keyboard.press('Escape');
  await page.click('#tfSeg [data-v="m1"]'); await page.waitForTimeout(600);
  const cbx = await page.locator('#chart canvas').boundingBox();
  await page.mouse.move(cbx.x + cbx.width * 0.45, cbx.y + cbx.height * 0.5); await page.waitForTimeout(200);
  await C(() => { window.__lgE = null; window.liveChart.on('legend', e => { if (e && e.hovering) window.__lgE = e.index; }); });
  // pan back (drags) until the bar under the mouse is inside RTH, so the RTH value is a number, not "-"
  const hovered = async () => {
    for (const f of [0.3, 0.32, 0.34]) { await page.mouse.move(cbx.x + cbx.width * f, cbx.y + cbx.height * 0.5); await page.waitForTimeout(100); }
    await page.waitForTimeout(150);
    return C(() => { const c = window.liveChart, U = window.ChartEngine.util, bs = c.bars(), i = window.__lgE, b = bs[i];
      if (!b) return { i, n: bs.length, tod: -1, want: null, text: 'no hover' };
      const s = U.rthVwap(bs, { sessionStart: 18 * 3600 }), want = U.vwapAt(s, b.t + 60);
      return { i, n: bs.length, tod: U.tod(b.t), want, full: b.vw, text: document.getElementById('lgVw').textContent }; });
  };
  let vw = await hovered();
  for (let k = 0; k < 24 && !(vw.tod >= 34200 + 900 && vw.tod < 57600 - 60); k++) {
    await page.mouse.move(cbx.x + cbx.width * 0.1, cbx.y + cbx.height * 0.6); await page.mouse.down();
    await page.mouse.move(cbx.x + cbx.width * 0.9, cbx.y + cbx.height * 0.6, { steps: 6 }); await page.mouse.up();
    await page.waitForTimeout(150);
    vw = await hovered();
  }
  const fmtWant = vw.want === null ? '-' : CE.util.fmtPrice(CE.util.roundTo(vw.want, 0.25), 2);
  check(vw.text === fmtWant, `E: RTH only: the legend shows the VWAP from 09:30 ET (${vw.text}, expected ${fmtWant} at ${Math.floor(vw.tod / 3600)}:${String(Math.floor(vw.tod / 60) % 60).padStart(2, '0')} ET)`);
  check(vw.want !== null && Math.abs(vw.want - vw.full) > 0.01, 'E: an RTH bar found in the history, its RTH-only VWAP apart from the full session\'s (' + (vw.full === undefined ? '-' : vw.full.toFixed(2)) + ')');
  await shot(page, 'display-b2-vwap-rth.png');
  await page.focus('#chart'); await page.keyboard.press('End'); await page.waitForTimeout(400);
  await gear(page, spRoot, 'vwap'); await page.click(spRoot + ' [data-f="opt:vwap:session:full"]'); await page.keyboard.press('Escape');
  check((await C(() => JSON.parse(localStorage.getItem('live-indicator-options-v1')).main.vwap.session)) === 'full', 'E: saved per chart');
  // the header text toggle (single page): off hides it even on hover, the scale takes the room back, eased
  const highY = () => C(() => { const c = window.liveChart, box = document.getElementById('chart').getBoundingClientRect(), w = box.width - 78, bs = c.bars(); let hi = -Infinity;
    for (let i = 0; i < bs.length; i++) { const x = c.barToX(i); if (x >= 0 && x <= w && bs[i].h > hi) hi = bs[i].h; } return c.priceToY(hi); });
  await page.mouse.move(cbx.x + 40, cbx.y + cbx.height + 40); await page.waitForTimeout(400);
  const topOn = await C(() => window.liveChart.getFitTop());
  check(topOn > 20, 'header on: the scale keeps ' + topOn + ' px free at the top');
  const yOn = await highY();
  const easing = C(() => new Promise(res => { const ys = [], c = window.liveChart; let n = 0;
    const box = document.getElementById('chart').getBoundingClientRect(), w = box.width - 78;
    const step = () => { const bs = c.bars(); let hi = -Infinity; for (let i = 0; i < bs.length; i++) { const x = c.barToX(i); if (x >= 0 && x <= w && bs[i].h > hi) hi = bs[i].h; }
      ys.push(Math.round(c.priceToY(hi) * 10) / 10); if (++n < 24) requestAnimationFrame(step); else res(ys); };
    requestAnimationFrame(step); }));
  await page.click('#lgTog');
  const ys = await easing;
  check(await C(() => document.querySelector('.chart-live').classList.contains('lg-off') && getComputedStyle(document.getElementById('legend')).display === 'none'), 'header text off: no header text');
  check((await C(() => window.liveChart.getFitTop())) === 0 && (await highY()) < yOn - 10, 'header text off: the scale takes the room back (' + Math.round(yOn) + ' px to ' + Math.round(await highY()) + ' px)');
  check(new Set(ys).size >= 3, 'the room shrinks eased, never a snap: ' + [...new Set(ys)].length + ' steps');
  await page.mouse.move(cbx.x + cbx.width * 0.4, cbx.y + cbx.height * 0.5); await page.waitForTimeout(200);
  check(await C(() => getComputedStyle(document.getElementById('legend')).display === 'none' && document.getElementById('lgBub').offsetParent === null), 'header text off: none on hover either');
  check((await C(() => JSON.parse(localStorage.getItem('live-legend-v1') || '{}').main)) === false && (await page.getAttribute('#lgTog', 'aria-pressed')) === 'false', 'saved for this chart');
  await shot(page, 'display-b2-header-off-single.png');
  await page.click('#lgTog'); await page.waitForTimeout(400);
  check(await C(() => !document.querySelector('.chart-live').classList.contains('lg-off') && window.liveChart.getFitTop() > 20), 'header text back on');
  check(await C(() => !document.querySelector('.chart-live').classList.contains('short')), 'F: /single.html keeps its full header');
  // D: every chip pinned (7 today, room for 10): one line at every size, the rest behind +N
  await addInd(page, spRoot, 'bubbles');
  if (await page.isHidden(spRoot + ' .ind-panel')) await page.click(spRoot + ' .ind-btn');
  for (const id of ['delta', 'levels', 'vp', 'bubbles']) { const b = await page.$(`${spRoot} .ind-body [data-act="pin"][data-id="${id}"]`); if (b && (await b.getAttribute('aria-pressed')) === 'false') await b.click(); }
  await page.keyboard.press('Escape');
  const chipState = (p, scope) => p.evaluate(sc => { const s = document.querySelector(sc + ' .ind-chips'), more = s.querySelector('.ind-chip-more');
    return { shown: s.querySelectorAll(':scope > .ind-chip[data-id]').length, listed: s.querySelectorAll('.ind-chip-list .ind-chip').length, more: more && !more.hidden ? more.textContent : '',
      fits: s.scrollWidth <= s.clientWidth + 1 }; }, scope);
  for (const [w, h] of [[1366, 768], [1920, 1080], [2560, 1440]]) {
    await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(600);
    const st = await chipState(page, spRoot);
    const one = await C(() => { const rs = [...document.querySelector('header.bar').children].filter(c => c.getClientRects().length).map(c => c.getBoundingClientRect()); return Math.max(...rs.map(r => r.top)) < Math.min(...rs.map(r => r.bottom)); });
    check(st.shown + st.listed === 7 && st.fits && one && (st.listed === 0 ? st.more === '' : st.more === '+' + st.listed), `D: single ${w}x${h}: ${st.shown} chips shown${st.listed ? ', ' + st.more : ''}, one toolbar line`);
    await shot(page, `display-b2-chips-single-${w}.png`);
  }
  await page.setViewportSize({ width: 1920, height: 1080 });

  // the workspace: chips at three sizes; 1.16.0: no text on any chart (no legend, short or not, no header text toggle)
  await wp.bringToFront();
  const wch = (await W(() => window.workspace.panels().filter(p => p.type === 'chart').map(p => p.id)))[0];
  const WS = `.ws-panel[data-id="${wch}"]`;
  await wp.setViewportSize({ width: 1920, height: 1080 }); await wp.waitForTimeout(600);
  for (const q of ['volume bars', 'vwap', 'levels', 'profile', 'bubbles', 'fills']) await addInd(wp, WS, q);
  for (const id of ['volume', 'vwap', 'levels', 'vp', 'delta', 'bubbles', 'fills']) { const b = await wp.$(`${WS} .ind-body [data-act="pin"][data-id="${id}"]`); if (b && (await b.getAttribute('aria-pressed')) === 'false') await b.click(); }
  await wp.keyboard.press('Escape');
  for (const [w, h] of [[1366, 768], [1920, 1080], [2560, 1440]]) {
    await wp.setViewportSize({ width: w, height: h }); await wp.waitForTimeout(900);
    const st = await chipState(wp, WS);
    const hd = await W(sc => { const h = document.querySelector(sc + ' .ws-head'); return h.scrollWidth <= h.clientWidth + 1 && h.offsetHeight === 28; }, WS);
    check(st.shown + st.listed === 7 && hd && (st.listed === 0 ? st.more === '' : st.more === '+' + st.listed), `D: workspace ${w}x${h}: ${st.shown} chips shown${st.listed ? ', ' + st.more : ''}, the header one line`);
    await shot(wp, `display-b2-ws-${w}.png`);
    if (w === 1366) {
      // 1.16.0: the crosshair over a small chart brings no text onto it: the corner readout only
      const sp = await W(() => window.workspace.panels().filter(p => p.type === 'chart').map(p => p.id).pop());
      const box = await wp.locator(`.ws-panel[data-id="${sp}"] .chart-box`).boundingBox();
      await wp.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.55); await wp.waitForTimeout(250);
      const hov = await W(id => { const pn = document.querySelector(`.ws-panel[data-id="${id}"]`); return { legend: pn.querySelectorAll('.legend').length, text: pn.querySelector('.stage').innerText.trim() }; }, sp);
      check(hov.legend === 0 && hov.text === '', 'F: the crosshair over a chart brings no text onto it (' + JSON.stringify(hov) + ')');
      await wp.mouse.move(4, h - 4); await wp.waitForTimeout(250);
    }
  }
  // 1.16.0 (Anthony): no header text toggle in any panel header, and live-legend-v1 is never read on the workspace
  await wp.setViewportSize({ width: 1920, height: 1080 }); await wp.waitForTimeout(600);
  await W(() => localStorage.setItem('live-legend-v1', JSON.stringify({ x: false })));
  check(await W(() => !document.querySelector('.ws-head .lg-tog') && [...document.querySelectorAll('.ws-panel[data-type="chart"] .chart-live.compact')].every(r => !r.classList.contains('lg-off'))), 'workspace: no header text toggle in any panel header');
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
