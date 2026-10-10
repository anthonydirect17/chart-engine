// Chart signals smoke (G1c): absorption bars, large-order bubbles and the delta pane's divergence arrows, on a mounted
// chart with its own toolbar (test/chart-host.html; the single chart page, /single.html, until chart 1.21.0) and in the
// workspace (/), against the fake bridge replaying a scripted tape (--scene=signals,
// test/signals-scene.mjs: SAMPLE trades with sides, made up, never market data) on MNQ Range 40 in regular hours.
//   npm run smoke:signals        (CHROMIUM_PATH=/path/to/chrome for a preinstalled browser; SHOTS=dir for the screenshots)
// Checks: the three switched on from the menus (Absorption bars in the Signals group with no chip and no pin, the bubbles
// in Volume with a chip, Show divergences in the delta pane's gear); after the replay one bull and one bear bar painted, a
// divergence arrow seen hollow and then solid at the same bar, bubbles of several sizes from the floor; the painted bodies,
// a bubble's ring and the arrow on the canvas in the toned colors (never pure #00FFFF or #FFFF00); a setting typed in the
// absorption gear saved for MNQ Range 40 and applied; the light ground; the workspace's Range 40 panel with the chip BB
// and no absorption chip. Screenshots at 1920x1080 and 2560x1440, close crops of the painted bars, bubbles and the arrow.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';
import { C, hostUrl, waitLive } from './chart-host.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CE = require('../src/chart-engine.js'), U = CE.util;
const SHOTS = path.resolve(process.env.SHOTS || path.join(root, 'test', 'out'));
fs.mkdirSync(SHOTS, { recursive: true });
let port = +(process.env.SIGNALS_SMOKE_PORT || 8885);
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
const OFFSET = offsetTo(10, 2);                       // the page and the bridge at 10:02 ET: regular hours, floor 100 on MNQ
const bridges = [];
async function startBridge(extra, pinOff) {        // pinOff: for a mounted chart, which never has ChartBridge's PIN
  const p = port++;
  const b = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(p), '--test-controls', pinOff ? '--pin-off' : '--test-pin=' + TEST_PIN, '--live-first',
    '--version=0.3.7', '--scene=signals', '--clock-offset=' + OFFSET].concat(extra || []), { stdio: ['ignore', 'pipe', 'inherit'] });
  bridges.push(b);
  await new Promise((res, rej) => { b.stdout.once('data', res); b.once('exit', c => rej(new Error('bridge exited ' + c))); });
  return p;
}
const scene = async p => (await fetch(`http://127.0.0.1:${p}/test/scene`, { method: 'POST' })).json();
/* The page's clock at the bridge's exchange time (Date.now and the performance clock), fonts left out, settings seeded. */
const clockInit = `(() => { const off = ${OFFSET * 1000}, R = Date, realNow = R.now;
  class D extends R { constructor(...a) { if (a.length) super(...a); else super(realNow() + off); } static now() { return realNow() + off; } }
  window.Date = D;
  try { const o = performance.timeOrigin; Object.defineProperty(performance, 'timeOrigin', { value: o + off }); } catch (e) {} })()`;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
async function context(w, h, seed) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(clockInit);
  if (seed) await ctx.addInitScript(seed);
  return ctx;
}
async function shot(page, name, clip) { await page.screenshot(Object.assign({ path: path.join(SHOTS, name) }, clip ? { clip } : {})); console.log('  shot ' + name); }
/* Every divergence step in the page notes each arrow as hollow or solid (exactly, at each bar close, whatever the polling). */
const watchArrows = page => page.evaluate(() => {
  const P = window.ChartEngine.DeltaDivergence.prototype, step = P._step, seen = window.__arrowSeen = {};
  P._step = function (...a) { const r = step.apply(this, a); for (const x of this.arrows) { const k = x.t + '|' + x.dir; (seen[k] = seen[k] || {})[x.solid ? 'solid' : 'hollow'] = true; } return r; };
});
/* Wait for the scene; `onHollow` once a hollow arrow shows. */
async function playScene(p, page, getSig, onHollow, onForming) {
  for (let i = 0; i < 300; i++) {
    const st = await scene(p);
    const arrows = await page.evaluate(getSig);
    if (onHollow && (arrows || []).some(a => !a.solid)) { await onHollow(arrows.find(a => !a.solid)); onHollow = null; }
    if (onForming && await page.evaluate(() => { const c = window.liveChart, a = c && c.getSignals().absorption; return !!a && a.forming(c.bars()) !== 0; })) { await onForming(); onForming = null; }
    if (st.done && i > 2) break;
    await sleep(400);
  }
  await sleep(1200);
  return new Map(Object.entries(await page.evaluate(() => window.__arrowSeen)));
}
/* The canvas pixel at CSS (x, y) of the chart in `sel` (or the page's chart), as #RRGGBB. */
const pixel = (page, x, y, sel) => page.evaluate(([x, y, sel]) => {
  const cv = (sel ? document.querySelector(sel) : document).querySelector('.ce-canvas'), d = cv.getContext('2d').getImageData(Math.round(x * devicePixelRatio), Math.round(y * devicePixelRatio), 1, 1).data;
  return '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}, [x, y, sel || null]);
const dist = (a, b) => { const x = U.parseColor(a), y = U.parseColor(b); return Math.hypot(x.r - y.r, x.g - y.g, x.b - y.b); };

try {
  /* ---------------------------------------------------------------- a mounted chart with its own toolbar */
  console.log('a mounted chart: MNQ Range 40, the three switched on from the menus');
  const P1 = await startBridge(['--scene-delay=7000'], true);
  const seed1 = () => { try { if (!localStorage.getItem('g1c-seeded')) { localStorage.setItem('g1c-seeded', '1');
    localStorage.setItem('live-settings-v2', JSON.stringify({ root: 'MNQ', tf: 'range', glide: 'smooth', rangeMode: 'nt' }));
    localStorage.setItem('live-range-v2', JSON.stringify({ MNQ: 40 })); } } catch (e) {} };
  const ctx1 = await context(1920, 1080, seed1);
  const page = await ctx1.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));
  await page.goto(hostUrl(P1));
  await waitLive(page, 30000);
  // the menu: Signals group, Absorption bars (no pin), Volume group, bubbles (a chip), the delta gear's Show divergences
  await page.click(C('indBtn'));
  await page.click('[data-f="cat:signals"]');
  check(await page.$('[data-f="add:absorption"]') !== null, 'Absorption bars is in the Signals group');
  await page.click('[data-f="add:absorption"]');
  check(await page.$('[data-f="pin:absorption"]') === null, 'Absorption bars on the chart has no pin');
  check(await page.$(C('indChips') + ' [data-id="absorption"]') === null, 'and no chip on the strip');
  await page.click('[data-f="cat:volume"]');
  await page.click('[data-f="add:bubbles"]');
  check(await page.$(C('indChips') + ' [data-id="bubbles"]') !== null, 'Large-order bubbles added with a chip (Volume group)');
  await page.click('[data-f="gear:delta"]');
  await page.click('[data-f="opt:delta:div:on"]');
  check(await page.$('[data-f="sig:div:SwingLookback"]') !== null, 'Show divergences on: SwingLookback, MinBarsBetweenSwings and MinDivergencePct in the delta gear');
  const counted = await page.evaluate(() => JSON.parse(localStorage.getItem('live-indicators-v2')).main.ind);
  check(counted.absorption.on && !counted.absorption.pin && counted.bubbles.on && counted.bubbles.pin, 'saved: absorption on without a pin, bubbles on and pinned');
  await page.keyboard.press('Escape');
  check(await page.evaluate(() => { const L = window.liveChart.getLayers(); return L.absorption && L.bubbles && L.divergence; }), 'the chart draws all three');
  await shot(page, 'signals-chart-menu-done-1920.png');

  console.log('the scripted tape plays (sample data)');
  let formingSeen = 0;
  const sigArrows = () => { const d = window.liveChart.getSignals().divergence; return d ? d.arrows.map(a => ({ t: a.t, dir: a.dir, solid: a.solid })) : []; };
  await watchArrows(page);
  const seen = await playScene(P1, page, sigArrows, async a => {
    await shot(page, 'signals-chart-hollow-1920.png');
    const g = await page.evaluate(t => { const c = window.liveChart, i = c.bars().findIndex(b => b.t === t), r = document.getElementById('chart-live-1-chart').getBoundingClientRect(), dp = c.deltaPane();
      return { x: r.x + c.barToX(i), y: r.y + dp.top, h: dp.height }; }, a.t);
    await shot(page, 'signals-crop-hollow-arrow.png', { x: Math.max(0, g.x - 300), y: g.y - 4, width: 420, height: g.h + 8 });
  }, async () => {                                          // the outline of a forming bar, when the polling catches one
    const g = await page.evaluate(() => { const c = window.liveChart, b = c.bars(), i = b.length - 1, r = document.getElementById('chart-live-1-chart').getBoundingClientRect();
      return { x: r.x + c.barToX(i), y: r.y + c.priceToY(b[i].c), f: c.getSignals().absorption.forming(b) }; });
    formingSeen = g.f;
    await shot(page, 'signals-crop-forming.png', { x: Math.max(0, g.x - 260), y: Math.max(0, g.y - 160), width: 320, height: 320 });
  });
  console.log('  note ' + (formingSeen ? 'a forming bar\'s outline was caught (' + (formingSeen > 0 ? 'cyan' : 'yellow') + ')' : 'no forming outline caught by the polling (the unit tests cover it)'));
  const st = await page.evaluate(() => { const c = window.liveChart, s = c.getSignals(), b = c.bars();
    return { painted: s.absorption.painted.map(p => ({ t: p.t, dir: p.dir, i: b.findIndex(x => x.t === p.t) })), bubbles: s.bubbles.list.map(x => ({ t: x.t, p: x.p, v: x.v, f: x.f, side: x.side })),
      arrows: s.divergence.arrows.map(a => ({ t: a.t, dir: a.dir, solid: a.solid, i: b.findIndex(x => x.t === a.t) })), n: b.length, T: c.colors() }; });
  check(st.painted.some(p => p.dir > 0) && st.painted.some(p => p.dir < 0), 'one bullish and one bearish absorption bar painted: ' + JSON.stringify(st.painted.map(p => p.dir)));
  const hs = [...seen.entries()].filter(([, s]) => s.hollow && s.solid);
  check(hs.length >= 1 && hs.some(([k]) => k.endsWith('|-1')), 'a divergence arrow seen hollow, then solid at the same swing bar' + (hs.length ? '' : ': ' + JSON.stringify([...seen.entries()])));
  check(st.arrows.some(a => a.solid && a.dir < 0), 'the bearish arrow is solid at the end');
  const sizes = st.bubbles.map(b => b.v);
  check(st.bubbles.length >= 6 && st.bubbles.every(b => b.v >= b.f && b.f === 100), st.bubbles.length + ' bubbles, each at least the RTH floor of 100');
  check(Math.max(...sizes) / Math.min(...sizes) >= 4 && st.bubbles.some(b => b.side > 0) && st.bubbles.some(b => b.side < 0), 'of several sizes (' + Math.min(...sizes) + ' to ' + Math.max(...sizes) + '), buys and sells');
  await shot(page, 'signals-chart-1920.png');

  console.log('the toned colors on the canvas');
  check(st.T.sigBull === '#38DCE8' && st.T.sigBear === '#F3D84A', 'the theme\'s signal colors are the toned tokens');
  // zoom in so the bodies are wide, then read the canvas
  const cb = await page.evaluate(() => { const r = document.getElementById('chart-live-1-chart').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.move(cb.x + cb.w - 220, cb.y + 260);
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -240); await sleep(120); }
  await page.mouse.move(cb.x + cb.w + 30, cb.y + 40);
  await sleep(900);
  const geo = await page.evaluate(() => { const c = window.liveChart, s = c.getSignals(), b = c.bars(), r = document.getElementById('chart-live-1-chart').getBoundingClientRect();
    const at = t => b.findIndex(x => x.t === t);
    return { left: r.x, top: r.y, painted: s.absorption.painted.map(p => { const i = at(p.t), x = b[i]; return { dir: p.dir, x: c.barToX(i), y: c.priceToY((x.o + x.c) / 2), h: Math.abs(c.priceToY(x.o) - c.priceToY(x.c)) }; }),
      arrows: s.divergence.arrows.filter(a => a.solid).map(a => { const i = at(a.t), d = c.getDelta().at(a.t); return { dir: a.dir, x: c.barToX(i), y: a.dir < 0 ? c.deltaToY(d.h) - 4 - 6 : c.deltaToY(d.l) + 4 + 6 }; }),
      bubbles: s.bubbles.list.map(x => { const i = c.bars().findIndex((q, k, a) => q.t <= x.t && (k === a.length - 1 || a[k + 1].t > x.t)); return { x: c.barToX(i), y: c.priceToY(x.p), v: x.v, side: x.side }; }) }; });
  for (const p of geo.painted) {
    if (p.h < 4) { const px = await pixel(page, p.x, p.y); check(dist(px, p.dir > 0 ? '#38DCE8' : '#F3D84A') < 30, (p.dir > 0 ? 'bullish' : 'bearish') + ' bar (thin body) in its color: ' + px); continue; }
    const px = await pixel(page, p.x, p.y);
    const want = p.dir > 0 ? '#38DCE8' : '#F3D84A', pure = p.dir > 0 ? '#00FFFF' : '#FFFF00';
    check(dist(px, want) < 12 && dist(px, pure) > 60, (p.dir > 0 ? 'cyan' : 'yellow') + ' body on the canvas ' + px + ' (token ' + want + ', not ' + pure + ')');
  }
  const inPane = geo.arrows.filter(a => a.x > 10 && a.x < cb.w - 90);
  for (const a of inPane.slice(0, 1)) { const px = await pixel(page, a.x, a.y); check(dist(px, a.dir < 0 ? '#F3D84A' : '#38DCE8') < 40, 'the solid arrow in the delta pane in the signal color: ' + px); }
  check(inPane.length >= 1, 'the arrow is in view');
  const big = geo.bubbles.filter(b => b.x > 60 && b.x < cb.w - 100 && b.y > 60 && b.y < cb.h * 0.6).sort((a, b) => b.v - a.v)[0];
  if (big) {
    // from the centre outward along the row above it (clear of a wick): the ring in the side color, the ground outside it
    const col = big.side > 0 ? st.T.upText : st.T.downText, row = [];
    for (let dx = 0; dx <= 44; dx++) row.push(await pixel(page, big.x - dx, big.y - 3));
    const k = row.findIndex((c, i) => i > 3 && dist(c, col) < 60);
    check(k > 3 && k < 44, 'the largest bubble in view (' + big.v + ') has a crisp ring in its side color ' + (k > 0 ? row[k] : '-') + ' ~ ' + col + ', ' + k + ' px out');
    // the outermost ring pixel, then the ground's hairline just outside it (darker than the ring, on a candle or the ground)
    let o = k; while (o + 1 < row.length && dist(row[o + 1], col) < 60) o++;
    const out = row.slice(o + 1, o + 4), dark = out.find(c => U.luminance(c) < U.luminance(row[o]) * 0.6);
    check(k > 0 && !!dark, 'with a dark hairline just outside the ring: ' + out.join(' '));
  } else fail('no bubble in view to read');
  // close crops: the painted bars and bubbles, the arrow in the pane
  const pb = geo.painted.map(p => p.x), xs = [Math.min(...pb) - 150, Math.max(...pb) + 230];
  await shot(page, 'signals-crop-bars-bubbles.png', { x: Math.max(0, cb.x + xs[0]), y: cb.y + 20, width: Math.min(1100, xs[1] - xs[0]), height: Math.round(cb.h * 0.62) });
  const dp = await page.evaluate(() => window.liveChart.deltaPane());
  if (inPane[0]) await shot(page, 'signals-crop-delta-arrow.png', { x: Math.max(0, cb.x + inPane[0].x - 380), y: cb.y + dp.top - 4, width: 760, height: dp.height + 8 });
  await shot(page, 'signals-chart-zoom-1920.png');

  console.log('the absorption gear: a setting saved for MNQ Range 40 and applied');
  await page.click(C('indBtn'));
  await page.click('[data-f="gear:absorption"]');
  check(/MNQ, Range 40/.test(await page.textContent(C('indPanel'))), 'the gear says which instrument and bars its settings are for');
  await shot(page, 'signals-gear-absorption-1920.png');
  await page.fill('[data-f="sig:abs:VolumeMultiplier"]', '2.5');
  await sleep(300);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('live-signals-v1')));
  check(saved.abs.MNQ['range:40'].VolumeMultiplier === 2.5, 'VolumeMultiplier 2.5 saved for MNQ range:40');
  await page.waitForFunction(() => window.liveChart.getSignals().absorption.s.VolumeMultiplier === 2.5, null, { timeout: 5000 }).catch(() => {});
  check(await page.evaluate(() => window.liveChart.getSignals().absorption.s.VolumeMultiplier) === 2.5, 'the absorption bars were worked out again with it');
  await page.fill('[data-f="sig:abs:VolumeMultiplier"]', '11');
  check(await page.getAttribute('[data-f="sig:abs:VolumeMultiplier"]', 'aria-invalid') === 'true', '11 is outside the file\'s range (1 to 10): marked, not saved');
  await page.fill('[data-f="sig:abs:VolumeMultiplier"]', '1.8');
  await sleep(400);
  await page.waitForFunction(() => !window.liveChart.getSignals().absorption || window.liveChart.getSignals().absorption.s.VolumeMultiplier === 1.8, null, { timeout: 5000 }).catch(() => {});
  await sleep(600);
  const again = await page.evaluate(() => window.liveChart.getSignals().absorption.painted.map(p => p.t + '|' + p.dir).join(','));
  check(again === st.painted.map(p => p.t + '|' + p.dir).join(','), 'back to 1.8: the replay (range bars by the store\'s order) paints exactly the bars live trading painted: ' + again);
  await page.keyboard.press('Escape');
  await page.mouse.dblclick(cb.x + 300, cb.y + 200);      // reset the view
  await sleep(900);

  console.log('2560x1440 and the light ground');
  await page.setViewportSize({ width: 2560, height: 1440 });
  await sleep(1200);
  await shot(page, 'signals-chart-2560.png');
  await page.setViewportSize({ width: 1920, height: 1080 });
  await sleep(600);
  await page.click('.ce-theme-btn');
  await page.click('.ce-ground[data-bg="light"]');
  await page.keyboard.press('Escape');
  await page.mouse.move(cb.x + cb.w + 30, cb.y + 40);
  await sleep(900);
  const LT = await page.evaluate(() => window.liveChart.colors());
  check(LT.ground === 'light' && U_contrastOk(LT), 'on the light ground the signal colors move until they read: ' + LT.sigBull + ', ' + LT.sigBear);
  await shot(page, 'signals-chart-light-1920.png');
  await page.click('.ce-theme-btn');
  await page.click('.ce-ground[data-bg="dark"]');
  await page.keyboard.press('Escape');
  await ctx1.close();

  /* ---------------------------------------------------------------- the workspace */
  console.log('workspace: the MNQ Range 40 panel with all three on');
  const P2 = await startBridge(['--scene-delay=9000']);
  const ctx2 = await context(1920, 1080);
  const ws = await ctx2.newPage();
  ws.on('pageerror', e => fail('workspace page error: ' + e.message));
  const openWs = async () => {
    await ws.goto(`http://localhost:${P2}/`);
    await ws.waitForSelector('.cb-pin-key', { timeout: 15000 });
    await enterPin(ws, TEST_PIN);
    await ws.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 });
  };
  await openWs();
  const first = await ws.evaluate(() => window.workspace.panels().find(p => p.type === 'chart' && p.tf === 'range'));
  check(first && first.root === 'MNQ' && first.range === 40, 'the default layout\'s first chart is MNQ Range 40');
  await ws.evaluate(id => {
    const all = JSON.parse(localStorage.getItem('live-indicators-v2') || '{}'), p = all[id] || { ind: {} };
    p.ind = Object.assign(p.ind || {}, { absorption: { on: true, shown: true, pin: false }, bubbles: { on: true, shown: true, pin: true }, delta: { on: true, shown: true, pin: false } });
    all[id] = p; localStorage.setItem('live-indicators-v2', JSON.stringify(all));
    const o = JSON.parse(localStorage.getItem('live-indicator-options-v1') || '{}'); o[id] = { delta: { show: 'cum', div: 'on' } };
    localStorage.setItem('live-indicator-options-v1', JSON.stringify(o));
  }, first.id);
  await openWs();                                          // reloaded before the scene starts: it counts from this opening
  const head = `.ws-panel[data-id="${first.id}"]`;
  check(await ws.$(`${head} .ind-chip[data-id="bubbles"]`) !== null && /BB/.test(await ws.textContent(`${head} .ind-chip[data-id="bubbles"]`)), 'the slim header has the bubbles\' 2-letter chip BB');
  check(await ws.$(`${head} .ind-chip[data-id="absorption"]`) === null, 'and no chip for the absorption bars');
  await watchArrows(ws);
  const seen2 = await playScene(P2, ws, () => [], null);
  const w = await ws.evaluate(id => { const s = window.workspace.chart(id).getSignals(); return { painted: s.absorption.painted.map(p => p.dir), bubbles: s.bubbles.list.length, arrows: s.divergence.arrows.map(a => a.solid) }; }, first.id);
  check(w.painted.includes(1) && w.painted.includes(-1), 'workspace panel: a bull and a bear bar painted');
  check(w.bubbles >= 6 && w.arrows.includes(true), 'workspace panel: bubbles and a solid divergence arrow');
  check([...seen2.values()].some(v => v.hollow && v.solid), 'workspace panel: the arrow went from hollow to solid');
  await ws.mouse.move(5, 300);
  await shot(ws, 'signals-workspace-1920.png');
  const pr = await ws.evaluate(sel => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }, head);
  await shot(ws, 'signals-workspace-panel-1920.png', pr);
  await ws.mouse.move(pr.x + pr.width - 160, pr.y + 220);
  for (let i = 0; i < 3; i++) { await ws.mouse.wheel(0, -200); await sleep(120); }
  await ws.mouse.move(5, 300);
  await sleep(900);
  await shot(ws, 'signals-workspace-zoom-1920.png');
  await ws.setViewportSize({ width: 2560, height: 1440 });
  await sleep(1500);
  await shot(ws, 'signals-workspace-2560.png');
  await ctx2.close();
} catch (e) {
  fail('threw: ' + (e && e.stack || e));
} finally {
  await browser.close();
  for (const b of bridges) b.kill();
}
function U_contrastOk(T) { return U.contrast(T.sigBull, T.bg) >= CE.FLOOR.candle - 0.01 && U.contrast(T.sigBear, T.bg) >= CE.FLOOR.candle - 0.01 && U.contrast(T.sigBullLine, T.bg) >= CE.FLOOR.line - 0.01; }
console.log(errors.length ? `\n${errors.length} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(errors.length ? 1 : 0);
