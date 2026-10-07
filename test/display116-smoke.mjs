// Chart 1.16.0, the display round (Anthony 2026-10-07), in the workspace against the fake bridge in regular hours (the page
// and the bridge at 10:02 ET; MNQ replays the scripted signals tape, test/signals-scene.mjs: SAMPLE trades, made up, never
// market data; then MNQ stops trading while NQ and ES go on):
//   - no text on any chart; the hovered bubble's size in the chart's corner readout, from the bubble event;
//   - the auto-fit keeps every bubble in view inside the plot;
//   - the Data Box: the newest bar of the chart it follows, the bar under the cursor on any chart, buys, sells, delta, the
//     largest print, the bubbles, the bar's open time and how long it lasted, and the tape timing;
//   - the stale feed: MNQ quiet for 10 s in RTH: a thin amber edge and "Feed stale N s" on its charts only, gone with the
//     next trade; ARMED in a chart's header badge while the ticket is armed on its instrument (nothing is sent);
//   - maximize and restore: the square in a panel's header, and the Maximize panel hotkey set in Settings (never a trading
//     key, never while a box has the focus);
//   - the laptop preset: two blank layout tabs, Main and Second, with tight margins.
//   npm run smoke:display116        (CHROMIUM_PATH=/path/to/chrome; DISPLAY116_SMOKE_PORT; SHOTS=dir)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CE = require('../src/chart-engine.js'), U = CE.util;
const SHOTS = path.resolve(process.env.SHOTS || path.join(root, 'test', 'out'));
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = +(process.env.DISPLAY116_SMOKE_PORT || 8903);
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const control = async (what, q) => (await fetch(`http://127.0.0.1:${PORT}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
async function until(fn, what, ms = 10000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) { fail('timed out: ' + what); return null; } await sleep(200); }
}

/* Seconds to add to the real clock to stand at hh:mm New York time on the most recent weekday with regular hours. */
function offsetTo(hh, mm) {
  const now = Date.now() / 1000, today = Math.floor(U.zoneSeconds(now) / 86400);
  for (let back = 0; back < 30; back++) {
    const bt = (today - back) * 86400 + hh * 3600 + mm * 60;
    if (!U.rthDay(bt)) continue;
    let unix = bt - (U.zoneSeconds(now) - now);
    unix = bt - (U.zoneSeconds(unix) - unix);
    if (unix > now) continue;
    return Math.round(unix - now);
  }
  throw new Error('no day found');
}
const OFFSET = offsetTo(10, 2);
const clockInit = `(() => { const off = ${OFFSET * 1000}, R = Date, realNow = R.now;
  class D extends R { constructor(...a) { if (a.length) super(...a); else super(realNow() + off); } static now() { return realNow() + off; } }
  window.Date = D;
  try { const o = performance.timeOrigin; Object.defineProperty(performance, 'timeOrigin', { value: o + off }); } catch (e) {} })()`;

const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--test-controls', '--test-pin=' + TEST_PIN, '--live-first',
  '--version=0.3.8', '--data-037', '--scene=signals', '--scene-delay=9000', '--clock-offset=' + OFFSET, '--trading', '--trade-accounts=Sim101', '--max-qty=MNQ:9'],
{ stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { bridge.stdout.once('data', res); bridge.once('exit', c => rej(new Error('bridge exited ' + c))); });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(clockInit);
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));
  const open = async (q = '') => {
    await page.goto(`http://localhost:${PORT}/live/${q}`);
    await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
    await enterPin(page, TEST_PIN);
    await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 });
  };
  await open();
  const P = () => page.evaluate(() => window.workspace.panels());
  let panels = await P();
  const mnq = panels.find(p => p.type === 'chart' && p.tf === 'range'), nq = panels.find(p => p.type === 'chart' && p.root === 'NQ');
  const mnqAll = panels.filter(p => p.type === 'chart' && p.root === 'MNQ').map(p => p.id);
  // the bubbles and the delta on the MNQ Range 40 chart, then a reload before the scene starts (it counts from the opening)
  await page.evaluate(id => {
    const all = JSON.parse(localStorage.getItem('live-indicators-v2') || '{}'), p = all[id] || { ind: {} };
    p.ind = Object.assign(p.ind || {}, { bubbles: { on: true, shown: true, pin: true }, delta: { on: true, shown: true, pin: false } });
    all[id] = p; localStorage.setItem('live-indicators-v2', JSON.stringify(all));
  }, mnq.id);
  await open();

  /* ---------------------------------------------------------------- no text on the charts; the Data Box added */
  console.log('the Data Box');
  check(await page.evaluate(() => !document.querySelector('.ws-panel .legend, .ws-panel .lg-tog') && [...document.querySelectorAll('.ws-panel[data-type="chart"] .stage')].every(s => s.innerText.trim() === '')),
    'no text inside any chart: no legend, no header text toggle');
  const tape = panels.find(p => p.type === 'tape');
  await page.click(`.ws-panel[data-id="${tape.id}"] [data-act="close"]`);
  await page.click('#wsAdd'); await page.click('#wsAddMenu [data-add="databox"]');
  panels = await P();
  const db = panels.find(p => p.type === 'databox');
  check(!!db && db.w >= 2, 'Add panel > Data Box: in the free cells (' + (db ? db.w + 'x' + db.h : 'none') + ')');
  const DB = `.ws-panel[data-id="${db.id}"]`;
  const box = () => page.evaluate(sel => { const el = document.querySelector(sel), o = {}; for (const c of el.querySelectorAll('[data-db]')) o[c.dataset.db] = c.hidden || (c.closest('[hidden]')) ? null : c.textContent; o.src = el.querySelector('.ws-db-src').textContent; return o; }, DB);
  // the scene: MNQ trades its scripted tape, then stops (the bridge holds it)
  await until(async () => (await control('scene')).done, 'the signals scene', 120000);
  await sleep(1500);
  const fmt = p => U.fmtPrice(p, 2);
  let b = await box();
  const lb = await page.evaluate(id => window.workspace.chart(id).lastBar(), mnq.id);
  check(/^MNQ Range 40$/.test(b.src) && /^Newest bar/.test(b.head), 'it follows the first chart, its newest bar, with the mouse on no chart: "' + b.src + '", "' + b.head + '"');
  check(b.o === fmt(lb.o) && b.h === fmt(lb.h) && b.l === fmt(lb.l) && b.c === fmt(lb.c) && b.v === U.fmtPrice(lb.v, 0), 'open, high, low, close and volume as the chart\'s newest bar: ' + [b.o, b.h, b.l, b.c, b.v].join(' '));
  check(b.rng === fmt(lb.h - lb.l) + ' (' + Math.round((lb.h - lb.l) / 0.25) + ' t)', 'the range in points and ticks: ' + b.rng);
  const num = s => +String(s).replace(/[^\d.-]/g, '');
  check(/^[\d,]+$/.test(b.buy) && /^[\d,]+$/.test(b.sell) && num(b.buy) + num(b.sell) <= lb.v && /^[+-]?[\d,]+$/.test(b.dlt) && num(b.dlt) === num(b.buy) - num(b.sell),
    'buy and sell volume and the delta from the delta pane: ' + [b.buy, b.sell, b.dlt].join(' / '));
  check(/^[\d,]+ contracts$/.test(b.big) && num(b.big) >= 1, 'the largest print in contracts: ' + b.big);
  check(/\d\d:\d\d:\d\d/.test(b.time) && /(s|\d:\d\d)( so far)?$/.test(b.dur), 'the bar\'s open time and how long it lasted: ' + b.time + ', ' + b.dur);

  /* ---------------------------------------------------------------- a bubble under the mouse: the corner and the Data Box */
  console.log('a bubble under the mouse');
  const geo = await page.evaluate(id => {
    const c = window.workspace.chart(id), s = c.getSignals(), list = s && s.bubbles ? s.bubbles.list : [], el = document.querySelector(`.ws-panel[data-id="${id}"] .chart-box`).getBoundingClientRect();
    const bs = c.bars(), w = el.width - 78, ps = c.priceScale();
    const idx = t => { let k = -1; for (let i = 0; i < bs.length; i++) if (bs[i].t <= t) k = i; return k; };
    return { box: { x: el.x, y: el.y, w: el.width, h: el.height }, plotH: ps.plotHeight, auto: ps.auto,
      bubbles: list.map(x => ({ v: x.v, f: x.f, side: x.side, p: x.p, x: c.barToX(idx(x.b !== undefined ? x.b : x.t)), y: c.priceToY(x.p) })).filter(x => x.x > 4 && x.x < w - 4 && x.y > -40 && x.y < ps.plotHeight + 40) };
  }, mnq.id);
  check(geo.bubbles.length > 0, 'bubbles in view on MNQ Range 40: ' + geo.bubbles.length);
  // the auto-fit: every bubble in view inside the plot (at least its radius at the default zoom below the top)
  const over = geo.bubbles.filter(x => x.y - U.bubbleRadius(x.v, x.f) < -0.5);
  check(geo.auto && over.length === 0, 'the auto-fit keeps every bubble in view inside the plot (top of the highest: ' + Math.round(Math.min(...geo.bubbles.map(x => x.y - U.bubbleRadius(x.v, x.f)))) + ' px)' + (over.length ? ': ' + JSON.stringify(over.slice(0, 3)) : ''));
  const big = geo.bubbles.slice().sort((a, c) => c.v - a.v)[0];
  await page.mouse.move(geo.box.x + big.x, geo.box.y + big.y);
  const cn = await until(async () => { const t = await page.evaluate(id => (window.workspace.chart(id).corner() || {}).text || '', mnq.id); return /^(Buy|Sell) [\d,.K]+ · /.test(t) ? t : null; }, 'the bubble in the corner', 4000);
  check(!!cn && cn.startsWith((big.side > 0 ? 'Buy ' : 'Sell ') + U.fmtVolume(Math.round(big.v))) && /ATR\(14\)/.test(cn), 'hover: the bubble\'s size in the corner readout, before the bar and the ATR: "' + cn + '"');
  b = await box();
  check(/^Under the cursor/.test(b.head) && b.hov && b.hov.startsWith((big.side > 0 ? 'Buy ' : 'Sell ') + U.fmtPrice(Math.round(big.v), 0) + ' @ '), 'the Data Box: the bar under the cursor, and the bubble: "' + b.hov + '"');
  check(b.bub && /^\d+(, largest |: )(Buy|Sell) [\d,]+$/.test(b.bub), 'the bubbles on that bar: "' + b.bub + '"');
  await page.screenshot({ path: path.join(SHOTS, 'display116-bubble-hover.png'), clip: { x: geo.box.x, y: geo.box.y, width: geo.box.w, height: geo.box.h } });
  await page.mouse.move(geo.box.x + 40, geo.box.y + geo.plotH * 0.9);
  const cn2 = await until(async () => { const t = await page.evaluate(id => (window.workspace.chart(id).corner() || {}).text || '', mnq.id); return /^Bar /.test(t) ? t : null; }, 'the corner without the bubble', 4000);
  check(!!cn2, 'off the bubble: the corner readout as before: "' + cn2 + '"');

  /* ---------------------------------------------------------------- the Data Box follows the chart under the mouse */
  const nqBox = await page.locator(`.ws-panel[data-id="${nq.id}"] .chart-box`).boundingBox();
  await page.mouse.move(nqBox.x + nqBox.width * 0.3, nqBox.y + nqBox.height * 0.5);
  await sleep(400);
  b = await box();
  check(/^NQ 5 min$/.test(b.src) && /^Under the cursor/.test(b.head) && !/forming/.test(b.head) && b.dur === '5:00', 'over NQ 5 min: that chart\'s bar under the cursor, 5 minutes long: ' + b.src + ', ' + b.head + ', ' + b.dur);
  await page.mouse.move(4, 1070);
  await sleep(1500);
  b = await box();
  check(/^NQ 5 min$/.test(b.src) && /^Newest bar · forming/.test(b.head) && / so far$/.test(b.dur), 'off the charts: the last chart hovered, its newest bar: ' + b.head + ', ' + b.dur);
  check(/^(<1|\d+) ms \(worst (<1|\d+) ms\)$/.test(b.tape), 'the tape timing, ChartBridge\'s receipt to the frame drawn: ' + b.tape);
  await page.screenshot({ path: path.join(SHOTS, 'display116-databox.png'), clip: await page.locator(DB).boundingBox() });

  /* ---------------------------------------------------------------- the stale feed */
  console.log('the stale feed (RTH: 10 s)');
  const stale = () => page.evaluate(ids => ids.map(id => { const pn = document.querySelector(`.ws-panel[data-id="${id}"]`), c = pn.querySelector('.ws-head [id$="-bConn"]');
    return { id, edge: pn.querySelector('.chart-live').classList.contains('is-stale'), text: c && !c.hidden ? c.textContent : '' }; }), panels.filter(p => p.type === 'chart').map(p => p.id));
  const st = await until(async () => { const s = await stale(); return s.filter(x => mnqAll.includes(x.id)).every(x => x.edge && /^Feed stale \d+ s$/.test(x.text)) ? s : null; }, 'MNQ stale', 20000);
  if (st) {
    check(st.filter(x => !mnqAll.includes(x.id)).every(x => !x.edge && !x.text), 'MNQ quiet: its charts say "' + st.find(x => mnqAll.includes(x.id)).text + '" with the amber edge; NQ and ES (trading) do not');
    const n = +/(\d+) s$/.exec(st.find(x => mnqAll.includes(x.id)).text)[1];
    check(n >= 10 && n <= 14, 'counted from the last trade, 10 s in RTH (' + n + ' s)');
    await page.screenshot({ path: path.join(SHOTS, 'display116-stale.png') });
    const L = Math.round((await control('state', { root: 'MNQ' })).last);
    await control('price', { root: 'MNQ', p: L + 1 });
    const back = await until(async () => { const s = await stale(); return s.every(x => !x.edge && !x.text) ? s : null; }, 'stale cleared', 2500);
    check(!!back, 'a trade: it clears at once, with no wait for the next second');
  }

  /* ---------------------------------------------------------------- ARMED in the header badge */
  console.log('ARMED in the badge');
  const tk = id => page.locator(`.ws-panel[data-type="ticket"] [data-tk-id="${id}"]`);
  await until(async () => page.evaluate(() => window.workspace.ticket().held && window.workspace.ticket().enabled), 'the ticket in this window, trading on', 10000);
  await tk('armBtn').click();
  const arm = await until(async () => { const a = await page.evaluate(ids => ids.map(id => { const x = document.querySelector(`.ws-panel[data-id="${id}"] .ws-head [id$="-bArmed"]`); return x && !x.hidden ? x.textContent : ''; }), panels.filter(p => p.type === 'chart').map(p => p.id)); return a.some(Boolean) ? a : null; }, 'ARMED', 4000);
  if (arm) check(panels.filter(p => p.type === 'chart').every((p, i) => p.root === 'MNQ' ? arm[i] === 'ARMED · Sim101' : arm[i] === ''), 'Armed on MNQ: "ARMED · Sim101" in the header of the MNQ charts only: ' + JSON.stringify(arm));
  await tk('armBtn').click();
  check(!!await until(async () => page.evaluate(() => [...document.querySelectorAll('.ws-head [id$="-bArmed"]')].every(x => x.hidden)), 'ARMED gone', 3000), 'Armed off: the badge goes');

  /* ---------------------------------------------------------------- maximize and restore */
  console.log('maximize and restore');
  const geom = () => page.evaluate(id => { const g = document.getElementById('wsGrid').getBoundingClientRect(), p = document.querySelector(`.ws-panel[data-id="${id}"]`).getBoundingClientRect();
    return { g: [g.left, g.top, g.width, g.height].map(Math.round), p: [p.left, p.top, p.width, p.height].map(Math.round), others: [...document.querySelectorAll('.ws-panel')].filter(x => x.dataset.id !== id).map(x => getComputedStyle(x).visibility),
      pressed: document.querySelector(`.ws-panel[data-id="${id}"] [data-act="max"]`).getAttribute('aria-pressed'), saved: window.workspace.panels().find(x => x.id === id) }; }, nq.id);
  const g0 = await geom();
  await page.click(`.ws-panel[data-id="${nq.id}"] [data-act="max"]`); await sleep(500);
  const g1 = await geom();
  check(g1.pressed === 'true' && Math.abs(g1.p[2] - (g1.g[2] - 12)) <= 2 && Math.abs(g1.p[3] - (g1.g[3] - 12)) <= 2 && g1.others.every(v => v === 'hidden'), 'the square: the panel fills the grid, the others wait hidden behind it: ' + JSON.stringify([g1.p, g1.g]));
  check(JSON.stringify(g1.saved) === JSON.stringify(g0.saved), 'not saved: the layout keeps its place');
  await page.screenshot({ path: path.join(SHOTS, 'display116-maximized.png') });
  await page.click(`.ws-panel[data-id="${nq.id}"] [data-act="max"]`); await sleep(500);
  const g2 = await geom();
  check(g2.pressed === 'false' && JSON.stringify(g2.p) === JSON.stringify(g0.p) && g2.others.every(v => v === 'visible'), 'and back: restored to its cells');
  // the hotkey: none by default; never a trading key; never while a box has the focus
  await page.click('#wsSet');
  check(await page.inputValue('#wsHk-maximize') === '', 'Settings > Hotkeys: Maximize panel, none by default');
  await page.click('#wsHk-buy'); await page.keyboard.press('Alt+B');
  await page.click('#wsHk-maximize'); await page.keyboard.press('Alt+B');
  check(await page.inputValue('#wsHk-maximize') === '' && /is already Buy MKT/.test(await page.textContent('#wsHkNote-maximize')), 'a trading key is refused: "' + await page.textContent('#wsHkNote-maximize') + '"');
  await page.keyboard.press('Alt+M');
  check(await page.inputValue('#wsHk-maximize') === 'Alt+M' && JSON.parse(await page.evaluate(() => localStorage.getItem('live-ws-keys-v1'))).maximize === 'Alt+M', 'Alt+M saved for Maximize panel (live-ws-keys-v1)');
  await page.click('#wsHk-sell'); await page.keyboard.press('Alt+M');
  check(await page.inputValue('#wsHk-sell') === '' && /is already Maximize panel/.test(await page.textContent('#wsHkNote-sell')), 'and no trading key can take it: "' + await page.textContent('#wsHkNote-sell') + '"');
  await page.click('#wsHk-buy'); await page.keyboard.press('Escape').catch(() => {});
  await page.click('[data-hk-clear="buy"]');
  await page.keyboard.press('Escape'); await page.click('#wsGrid', { position: { x: 3, y: 3 } }).catch(() => {});
  await page.mouse.move(nqBox.x + nqBox.width * 0.5, nqBox.y + nqBox.height * 0.5); await sleep(200);
  await page.keyboard.press('Alt+M'); await sleep(400);
  check((await geom()).pressed === 'true', 'Alt+M with the mouse over NQ: it fills the grid');
  await page.keyboard.press('Alt+M'); await sleep(400);
  check((await geom()).pressed === 'false', 'Alt+M again: restored');
  await tk('bStop').focus();
  await page.keyboard.press('Alt+M'); await sleep(400);
  check((await geom()).pressed === 'false' && /Hotkey ignored: a box has the focus/.test(await page.textContent('#wsNote')), 'with a box focused: nothing, and the note says why');
  await page.evaluate(() => document.activeElement.blur());

  /* ---------------------------------------------------------------- the laptop preset */
  console.log('the laptop preset');
  await page.click('#wsSet'); await page.click('#wsLaptop');
  await page.click('#wsDialog [type="submit"]');
  await page.waitForFunction(() => window.workspace.layout === 'Main');
  const lap = () => page.evaluate(() => ({ layout: window.workspace.layout, panels: window.workspace.panels().length, tabs: document.getElementById('wsTabs').hidden ? null : [...document.querySelectorAll('#wsTabs [data-tab]')].map(t => t.textContent + (t.getAttribute('aria-selected') === 'true' ? '*' : '')),
    tight: document.body.classList.contains('ws-tight'), gap: getComputedStyle(document.getElementById('wsGrid')).rowGap }));
  let l = await lap();
  check(l.panels === 0 && JSON.stringify(l.tabs) === '["Main*","Second"]' && l.tight && l.gap === '2px', 'two tabs, Main and Second, Main blank and open, tight margins: ' + JSON.stringify(l));
  await page.click('#wsTabs [data-tab="Second"]');
  await page.waitForFunction(() => window.workspace.layout === 'Second');
  l = await lap();
  check(l.panels === 0 && JSON.stringify(l.tabs) === '["Main","Second*"]', 'Second: blank too, its tab marked');
  await page.click('#wsAdd'); await page.click('#wsAddMenu [data-add="chart"]'); await sleep(800);
  const cell = await page.evaluate(() => { const p = document.querySelector('.ws-panel').getBoundingClientRect(), g = document.getElementById('wsGrid').getBoundingClientRect(); return { left: Math.round(p.left - g.left), top: Math.round(p.top - g.top) }; });
  check(cell.left === 2 && cell.top === 2, 'a panel added sits 2 px from the grid\'s edge: ' + JSON.stringify(cell));
  await page.screenshot({ path: path.join(SHOTS, 'display116-laptop.png') });
  await page.click('#wsSet'); await page.click('#wsLaptop');
  l = await lap();
  check(l.tabs === null && !l.tight && l.gap === '6px', 'turned off: no tabs, the usual margins');
} catch (e) {
  fail('threw: ' + (e && e.stack || e));
} finally {
  await browser.close();
  bridge.kill();
}
console.log(errors.length ? `\n${errors.length} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(errors.length ? 1 : 0);
