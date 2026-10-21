// The studies smoke (1.34.0, Anthony 2026-10-20: EMA and SMA lines, Bollinger Bands, the RSI in the lower pane): a mounted
// chart (test/chart-host.html) at 1366x768 against the fake bridge (SAMPLE data only, never market data) with EMA 9 and 21,
// SMA 20, 50 and 200, Bollinger 20 and 2, RSI 14 and the delta pane on. Checks: every study drawn on the bars it has, the
// RSI pane under the delta pane with no overlap and its value inside 0 to 100, the gears' options and colors (each fits
// with no scrolling; a length picked, the RSI levels picked, both after a reload), the RSI alone taking the whole lower
// pane, the white chart, and in the workspace at 1366x768 the four added from the menu with a chip each. Screenshots in
// test/out: studies-all.png, studies-rsi.png, studies-light.png, studies-ws.png and studies-gear.png (the EMA's gear).
//   npm run smoke:studies        (CHROMIUM_PATH=/path/to/chrome for a preinstalled browser)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { C, hostUrl, waitLive } from './chart-host.mjs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CE = require('../src/chart-engine.js'), U = CE.util;
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const PORT = +(process.env.STUDIES_SMOKE_PORT || 8931);
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };

const ON = { on: true, shown: true, pin: true };
const seed = (ids, colors) => `(() => { try {
  if (!localStorage.getItem('live-settings-v2')) localStorage.setItem('live-settings-v2', JSON.stringify({ root: 'NQ', tf: 'm1', glide: 'smooth', rangeMode: 'nt' }));
  if (!localStorage.getItem('live-indicators-v2')) localStorage.setItem('live-indicators-v2', JSON.stringify({ main: { ind: ${JSON.stringify(Object.fromEntries(['volume', 'vwap', 'levels', 'fills', 'vp', 'delta', 'bubbles', 'absorption', 'ema', 'sma', 'bands', 'rsi'].map(id => [id, ids.includes(id) ? ON : { on: false, shown: true, pin: false }])))}, recent: [], restore: null } }));
  ${colors ? `if (!localStorage.getItem('live-colors-v1')) localStorage.setItem('live-colors-v1', ${JSON.stringify(JSON.stringify(colors))});` : ''}
} catch (e) {} })();`;

/* In the page: everything under `sel` that scrolls, is cut or is off screen (as test/noscroll-smoke.mjs). */
function scan(sel) {
  const rootEl = document.querySelector(sel);
  if (!rootEl) return { missing: true, bad: [] };
  const bad = [], visible = el => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0; };
  for (const el of [rootEl, ...rootEl.querySelectorAll('*')]) {
    if (!visible(el) || el.tagName === 'OPTION' || el.tagName === 'svg' || el.closest('svg') || el.closest('.visually-hidden')) continue;   // screen readers' text: clipped on purpose
    const s = getComputedStyle(el);
    if (s.textOverflow === 'ellipsis') continue;
    const isBox = el.tagName === 'INPUT' || el.tagName === 'SELECT';
    if ((s.overflowX !== 'visible' || isBox) && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) bad.push(el.className + ' wide ' + el.scrollWidth + '>' + el.clientWidth);
    if (s.overflowY !== 'visible' && !isBox && el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0) bad.push(el.className + ' tall');
    if (['absolute', 'fixed'].includes(s.position)) {
      const q = el.getBoundingClientRect();
      if (q.width > 1 && (q.left < -0.5 || q.top < -0.5 || q.right > innerWidth + 0.5 || q.bottom > innerHeight + 0.5)) bad.push(el.className + ' off screen');
    }
  }
  const d = document.documentElement;
  if (d.scrollWidth > innerWidth + 1 || d.scrollHeight > innerHeight + 1) bad.push('the page scrolls');
  return { bad };
}
/* In the page: the chart's studies and panes as drawn now. */
const state = () => {
  const c = window.liveChart, n = c.bars().length - 1;
  return { layers: c.getLayers(), studies: c.getStudies(), rsi: c.rsiPane(), delta: c.deltaPane(), at: n >= 0 ? c.studiesAt(n) : null, n, colors: c.colors(), theme: c.getTheme() };
};

const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--version=0.3.8', '--data-037', '--live-rate=40', '--pin-off'], { stdio: ['ignore', 'pipe', 'inherit'] });
// the workspace asks for ChartBridge's PIN: its own bridge with the test PIN
const bridge2 = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT + 1), '--version=0.3.8', '--data-037', '--live-rate=40', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
await Promise.all([bridge, bridge2].map(b => new Promise(r => b.stdout.once('data', r))));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
async function open(init) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));
  await page.goto(hostUrl(PORT));
  await waitLive(page, 30000);
  await page.waitForFunction(() => window.liveChart && window.liveChart.bars().length > 300, null, { timeout: 30000 });
  await page.waitForTimeout(1200);
  return { ctx, page };
}
try {
  /* ---------------- everything on, with the delta pane */
  console.log('all four with the delta pane, 1366x768');
  let { ctx, page } = await open(seed(['volume', 'vwap', 'delta', 'ema', 'sma', 'bands', 'rsi']));
  let s = await page.evaluate(state);
  check(s.layers.ema && s.layers.sma && s.layers.bands && s.layers.rsi && s.layers.delta, 'the layers on: ' + JSON.stringify(s.layers));
  check(JSON.stringify(s.studies) === JSON.stringify({ ema: [9, 21, 0], sma: [20, 50, 200], bands: { len: 20, dev: 2, basis: true, fill: true }, rsi: { len: 14, lo: 30, hi: 70 } }), 'the defaults: EMA 9 and 21, SMA 20, 50 and 200, Bollinger 20 and 2, RSI 14 at 30 and 70');
  check(s.n > 200 && s.at && s.at.ema[0] !== null && s.at.ema[1] !== null && s.at.ema[2] === null && s.at.sma.every(v => v !== null) && s.at.bands && s.at.bands.up > s.at.bands.mid && s.at.bands.mid > s.at.bands.lo,
    'every line has a value at the newest bar (' + s.n + ' bars): EMA ' + (s.at && s.at.ema.map(v => v && v.toFixed(2))) + ', SMA ' + (s.at && s.at.sma.map(v => v && v.toFixed(2))));
  // the newest values are the ones a whole computation gives from the chart's bars (read in one go, live trades coming)
  const got = await page.evaluate(() => { const c = window.liveChart, b = c.bars(); return { closes: b.map(x => x.c), at: c.studiesAt(b.length - 1) }; });
  const cl = got.closes, same = (a, b) => Math.abs(a - b) < 1e-6;
  check(same(got.at.ema[0], U.emaSeries(cl, 9).pop()) && same(got.at.sma[2], U.smaSeries(cl, 200).pop()) && same(got.at.rsi, U.rsiSeries(cl, 14).pop()) && same(got.at.bands.up, U.bollinger(cl, 20, 2).pop().up),
    'the newest values (the forming bar\'s) equal a whole computation from the bars');
  check(s.rsi.on && s.delta.on && s.rsi.height > 40 && s.delta.height > 40, 'the RSI and the delta pane both shown (' + s.delta.height + ' and ' + s.rsi.height + ' px)');
  check(s.delta.top + s.delta.height + CE.PANE_GAP <= s.rsi.top, 'the RSI under the delta pane, no overlap: delta ' + s.delta.top + ' to ' + (s.delta.top + s.delta.height) + ', RSI ' + s.rsi.top + ' to ' + (s.rsi.top + s.rsi.height));
  check(Math.abs(s.rsi.height - s.delta.height) <= 1, 'the height split evenly');
  check(s.rsi.value >= 0 && s.rsi.value <= 100, 'the RSI inside 0 to 100: ' + (s.rsi.value === null ? null : s.rsi.value.toFixed(2)));
  const chartEl = await page.$('.ce-host'), box = await chartEl.boundingBox();
  // the pointer over the RSI: its value tag on the axis, the crosshair there
  await page.mouse.move(box.x + box.width * 0.6, box.y + s.rsi.top + s.rsi.height * 0.4);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, 'studies-all.png') });
  check(fs.existsSync(path.join(out, 'studies-all.png')), 'screenshot test/out/studies-all.png (the pointer over the RSI)');
  const div = await page.evaluate(() => document.querySelector('.ce-divider').getAttribute('aria-label'));
  check(/^Lower pane height/.test(div), 'the divider says "' + div + '"');
  await page.mouse.move(box.x + 10, box.y + 10);

  /* the gears: a length from its select, the RSI's levels (whether each gear fits with no scrolling: the workspace, below) */
  await page.click(C('indBtn'));
  for (const id of ['ema', 'sma', 'bands', 'rsi']) {
    await page.click(`${C('indPanel')} [data-act="gear"][data-id="${id}"]`);
    await page.waitForTimeout(80);
    if (id === 'ema') {
      const sels = await page.$$eval(`${C('indPanel')} select[data-id="ema"]`, l => l.map(x => x.value));
      check(JSON.stringify(sels) === '["9","21","off"]', 'the EMA lengths: three selects ' + JSON.stringify(sels));
      await page.selectOption(`${C('indPanel')} select[data-id="ema"][data-k="len3"]`, '200');
      await page.waitForTimeout(150);
      check((await page.evaluate(() => window.liveChart.getStudies().ema)).join() === '9,21,200', 'EMA line 3 set to 200 from its select');
    }
    if (id === 'rsi') {
      await page.click(`${C('indPanel')} [data-act="opt"][data-id="rsi"][data-k="levels"][data-v="20/80"]`);
      await page.waitForTimeout(150);
      const r2 = await page.evaluate(() => window.liveChart.rsiPane());
      check(r2.lo === 20 && r2.hi === 80, 'the RSI levels set to 20/80');
    }
    await page.click(`${C('indPanel')} [data-act="gear"][data-id="${id}"]`);
  }
  await page.keyboard.press('Escape');
  await page.reload(); await waitLive(page, 30000); await page.waitForTimeout(800);
  s = await page.evaluate(state);
  check(s.studies.ema.join() === '9,21,200' && s.studies.rsi.lo === 20 && s.studies.rsi.hi === 80, 'both kept after a reload');
  await ctx.close();

  /* ---------------- the RSI alone */
  console.log('the RSI alone');
  ({ ctx, page } = await open(seed(['volume', 'vwap', 'rsi'])));
  s = await page.evaluate(state);
  check(s.rsi.on && !s.delta.on && s.rsi.top === s.delta.plotHeight + CE.PANE_GAP && s.rsi.height > 80, 'the RSI takes the whole lower pane (' + s.rsi.height + ' px from y ' + s.rsi.top + ')');
  check(s.rsi.value >= 0 && s.rsi.value <= 100, 'its value inside 0 to 100: ' + (s.rsi.value === null ? null : s.rsi.value.toFixed(2)));
  await page.screenshot({ path: path.join(out, 'studies-rsi.png') });
  check(fs.existsSync(path.join(out, 'studies-rsi.png')), 'screenshot test/out/studies-rsi.png');
  await ctx.close();

  /* ---------------- the white chart */
  console.log('a white chart');
  ({ ctx, page } = await open(seed(['volume', 'vwap', 'delta', 'ema', 'sma', 'bands', 'rsi'], { bg: '#F5F7FA' })));
  s = await page.evaluate(state);
  check(s.theme.bg === '#F5F7FA' && s.colors.ground === 'light', 'the light ground');
  const low = ['ema1', 'ema2', 'sma1', 'sma2', 'sma3', 'bands', 'bandsBasis', 'rsi', 'rsiLevels'].filter(k => U.contrast(s.colors[k], s.colors.bg) < CE.FLOOR.line - 0.01);
  check(!low.length, 'every study line reads on it (3:1)' + (low.length ? ': not ' + low.join(', ') : ''));
  await page.screenshot({ path: path.join(out, 'studies-light.png') });
  check(fs.existsSync(path.join(out, 'studies-light.png')), 'screenshot test/out/studies-light.png');
  await ctx.close();

  /* ---------------- the workspace at 1366x768: added from the menu's groups, each gear fits with no scrolling */
  console.log('the workspace, 1366x768');
  ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  page = await ctx.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));
  await page.goto(`http://localhost:${PORT + 1}/live/`);
  await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
  await enterPin(page, TEST_PIN);
  await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 });
  await page.waitForTimeout(800);
  const pid = await page.evaluate(() => window.workspace.panels().find(p => p.type === 'chart').id), P = `.ws-panel[data-id="${pid}"] .ind-panel`;
  await page.click(`.ws-panel[data-id="${pid}"] .ind-btn`);
  // the chart's volume bars, levels and fills off first, so the menu fits the window whole (with nine on the chart and
  // the groups the menu is taller than a 768 px window, and its list scrolls: the one exception, live.js placeMenu)
  for (const id of ['volume', 'levels', 'fills']) if (await page.$(`${P} [data-f="x:${id}"]`)) await page.click(`${P} [data-f="x:${id}"]`);
  for (const [id, cat] of [['ema', 'price'], ['sma', 'price'], ['bands', 'price'], ['rsi', 'momentum']]) {
    if (!(await page.$(`${P} [data-f="add:${id}"]`))) await page.click(`${P} [data-act="cat"][data-id="${cat}"]`);
    await page.click(`${P} [data-f="add:${id}"]`);
  }
  check((await page.$$eval(`${P} [data-act="gear"]`, l => l.map(b => b.dataset.id))).filter(x => ['ema', 'sma', 'bands', 'rsi'].includes(x)).length === 4, 'the four added from the Price and Momentum groups');
  const chips = await page.$$eval(`.ws-panel[data-id="${pid}"] .ind-chip[data-id]`, l => l.map(b => b.dataset.id + ':' + b.textContent.trim()));
  check(['ema', 'sma', 'bands', 'rsi'].every(id => chips.some(c => c.startsWith(id + ':'))), 'a chip each in the chart\'s header: ' + chips.join(' '));
  for (const id of ['ema', 'sma', 'bands', 'rsi']) {
    await page.click(`${P} [data-act="gear"][data-id="${id}"]`);
    await page.waitForTimeout(100);
    const r = await page.evaluate(scan, P);
    /* 1.34.0 (the audit): the menu never goes under the top bar; when it is taller than the room below the bar its list scrolls
       inside (Anthony's instruction for the audit fix): that one scroll is allowed, nothing else */
    const bad = r.bad.filter(x => !/^div\.ind-body tall /.test(x) && !/ind-body tall/.test(x));
    const pos = await page.evaluate(sel => { const bar = document.querySelector('.ws-top').getBoundingClientRect().bottom, pn = document.querySelector(sel).getBoundingClientRect(); return pn.top >= bar && pn.bottom <= innerHeight; }, P);
    check(!r.missing && !bad.length && pos, 'the ' + id + ' gear fits below the top bar, only its list scrolling if need be' + (bad.length ? ': ' + bad.slice(0, 4).join('; ') : ''));
    if (id === 'ema') await page.screenshot({ path: path.join(out, 'studies-gear.png') });
    await page.click(`${P} [data-act="gear"][data-id="${id}"]`);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, 'studies-ws.png') });
  await ctx.close();
} finally {
  await browser.close();
  bridge.kill(); bridge2.kill();
}
console.log(`\nstudies smoke: ${checks - errors.length}/${checks} checks passed`);
if (errors.length) { console.error(errors.length + ' failed'); process.exit(1); }
