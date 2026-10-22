// Lines and labels smoke (chart 1.37.0, Anthony 2026-10-22: "our price / trade lines can be a bit thinner ... I still find the
// chips and the lines obstructing price, especially when price is moving and im trying to click and trail a stop"): one chart
// with a long position, its stop and target and a working entry, in Chromium at 2x:
//   - the order and position lines draw at about 60% strength (each pixel's share of the way from the ground to the line's
//     color), the position line 1 px (2 device rows at 2x; it was 1.5 px, 3 rows), and full strength with the mouse on a line;
//   - an order label with candles behind it draws at about 55%, full with the mouse near it; a label over empty room is full;
//   - the hit areas are the same boxes whatever the strength, and dragging the stop still moves it (orderMove at the price).
// Screenshots (LINES_SHOTS=dir): far, near the stop, and close crops. LINES_SHOTS_ONLY=1 takes the screenshots and checks
// nothing (the run on the code before 1.37.0, for Anthony's before and after). Sample data only (a random walk made here).
//   npm run smoke:lines
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const SHOTS = process.env.LINES_SHOTS || '', ONLY = process.env.LINES_SHOTS_ONLY === '1';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const errors = [];
let checks = 0;
const check = (ok, m) => { if (ONLY) { console.log('  (info) ' + m); return; } checks++; if (!ok) { errors.push(m); console.error('  FAIL ' + m); } else console.log('  ok   ' + m); };
async function shot(page, name, clip) {
  const file = path.join(out, name);
  await page.screenshot(clip ? { path: file, clip } : { path: file });
  if (SHOTS) fs.copyFileSync(file, path.join(SHOTS, name));
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1000, height: 560 }, deviceScaleFactor: 2 });
page.on('pageerror', e => errors.push(e.message));
await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
await page.setContent('<!doctype html><html><head><link rel="stylesheet" href="file://' + path.join(root, 'live', 'fonts', 'plex.css') + '"><style>html,body{margin:0;height:100%;background:#080B10}#c{position:absolute;left:0;top:0;width:1000px;height:560px}</style></head><body><div id="c"></div></body></html>');
await page.addScriptTag({ path: path.join(root, 'src', 'chart-engine.js') });
const setup = await page.evaluate(async () => {
  const host = document.getElementById('c');
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const bars = []; let p = 20000;
  for (let i = 0; i < 400; i++) { const o = p, c = o + (rnd() - 0.5) * 6, h = Math.max(o, c) + rnd() * 3, l = Math.min(o, c) - rnd() * 3; bars.push({ t: 1760000000 + i * 60, o, h, l, c, v: 100 }); p = c; }
  const ch = window.__ch = ChartEngine.create(host, { barSpacing: 7, liveButton: false, lockButton: false, room: 400, pointValue: 2, motion: { zoom: 0, fit: 0, candle: 0, follow: 0, friction: 0 },
    layers: { volume: false, vwap: false, levels: false, trades: false, ib: false }, clock: () => 1760000000 + 400 * 60 });
  ch.setBars(bars);
  const last = bars[bars.length - 1].c, lo = Math.min(...bars.slice(-60).map(b => b.l)), hi = Math.max(...bars.slice(-60).map(b => b.h));
  const q = v => Math.round(v * 4) / 4;
  const avg = q(lo + (last - lo) * 0.55), stop = q(lo + (last - lo) * 0.2), target = q(last + (hi - last) * 0.6), entry = q(lo + (last - lo) * 0.85);
  window.__moves = []; ch.on('orderMove', e => window.__moves.push(e));
  ch.setPosition({ qty: 2, avgPrice: avg, pointValue: 2 });
  ch.setOrders([{ id: 's1', side: 'sell', kind: 'stop', price: stop, qty: 2, role: 'stop' }, { id: 't1', side: 'sell', kind: 'limit', price: target, qty: 2, role: 'target' },
    { id: 'e1', side: 'buy', kind: 'limit', price: entry, qty: 1 }]);
  ch.setOrderEditing(true);
  await new Promise(r => setTimeout(r, 300));
  return { avg, stop, target, entry, last };
});
console.log('  setup: ' + JSON.stringify(setup));
/* each pixel's strength: its share of the way from the ground (the chart's background) to the line's color, at the most saturated
   channel, read from the canvas itself (device pixels) at an x with no candle and no label */
const strength = (price, xCss) => page.evaluate(([price, xCss]) => {
  const ch = window.__ch, cv = document.querySelector('#c canvas'), x = cv.getContext('2d'), d = devicePixelRatio;
  const y = ch.priceToY(price), col = [], span = Math.round(100 * d);
  for (let dy = -3; dy <= 3; dy++) {   // each device row: its pixel farthest from the ground over 100 px (a dashed line's dashes)
    const px = x.getImageData(Math.round(xCss * d), Math.round(y * d) + dy, span, 1).data;
    let best = [px[0], px[1], px[2]], bs = -1;
    for (let i = 0; i < px.length; i += 4) { const v = px[i] + px[i + 1] + px[i + 2]; if (v > bs) { bs = v; best = [px[i], px[i + 1], px[i + 2]]; } }
    col.push(best);
  }
  return { y, col };
}, [price, xCss]);
const geom = await page.evaluate(() => { const ch = window.__ch, n = ch.bars().length - 1; return { lastX: ch.barToX(n), gap: ch.room().gap }; });
const bg = await page.evaluate(() => { const cv = document.querySelector('#c canvas'), px = cv.getContext('2d').getImageData(10, 10, 1, 1).data; return [px[0], px[1], px[2]]; });
const xFree = Math.round(geom.lastX + 20);   // right of the last candle, left of the labels (400 px of room)
const lineInfo = async price => {
  const s = await strength(price, xFree);
  const rows = s.col.map(c => Math.max(...c.map((v, k) => Math.abs(v - bg[k]))));
  const peak = Math.max(...rows), lit = rows.filter(v => v > 12).length;
  return { peak, lit, rows };
};
await page.mouse.move(20, 20);
await page.waitForTimeout(200);
const far = { stop: await lineInfo(setup.stop), entry: await lineInfo(setup.entry), pos: await lineInfo(setup.avg) };
console.log('  far: ' + JSON.stringify({ stop: [far.stop.peak, far.stop.lit], entry: [far.entry.peak, far.entry.lit], pos: [far.pos.peak, far.pos.lit] }));
await shot(page, 'lines-far.png');
/* the mouse on the stop line (left of its label, right of the candles): full strength there only */
const yStop = (await strength(setup.stop, xFree)).y;
await page.mouse.move(xFree + 150, yStop + 1);
await page.waitForTimeout(200);
const onStop = { stop: await lineInfo(setup.stop), entry: await lineInfo(setup.entry) };
console.log('  on the stop line: ' + JSON.stringify({ stop: [onStop.stop.peak, onStop.stop.lit], entry: [onStop.entry.peak, onStop.entry.lit] }));
await shot(page, 'lines-hover-stop.png');
check(onStop.stop.peak > far.stop.peak * 1.35, 'the stop line at full strength with the mouse on it (' + far.stop.peak + ' far, ' + onStop.stop.peak + ' on it)');
check(Math.abs(onStop.entry.peak - far.entry.peak) <= 2, 'the other lines stay light meanwhile (entry ' + far.entry.peak + ', ' + onStop.entry.peak + ')');
const ratio = far.stop.peak / onStop.stop.peak;
check(ratio > 0.5 && ratio < 0.72, 'an order line at about 60% strength away from the mouse (' + (ratio * 100).toFixed(0) + '% of its full)');
const exitCol = await page.evaluate(() => { const p = ChartEngine.util.parseColor(ChartEngine.util.buildTheme({}).exit); return [p.r, p.g, p.b]; });
const posRatio = far.pos.peak / Math.max(...exitCol.map((v, k) => Math.abs(v - bg[k])));
check(posRatio > 0.5 && posRatio < 0.7, 'the position line at about 60% strength (' + (posRatio * 100).toFixed(0) + '%)');
check(far.pos.lit === 2, 'the position line 1 px: 2 device rows at 2x (' + far.pos.lit + ' rows; 1.5 px drew 3)');
/* the mouse on the position line: full, and 1.5 px as before */
const yPos = (await strength(setup.avg, xFree)).y;
await page.mouse.move(xFree + 150, yPos);
await page.waitForTimeout(200);
const onPos = await lineInfo(setup.avg);
check(onPos.peak > far.pos.peak * 1.35 && onPos.lit === 3, 'the position line at full strength and 1.5 px with the mouse on it (' + onPos.peak + ', ' + onPos.lit + ' rows)');
await page.mouse.move(20, 20);
await page.waitForTimeout(200);

/* labels: the stop's label sits over candles (room 40): see-through away from the mouse, full near it (the mouse above it, off its
   line, so neither the crosshair nor the line's own strength is in its box); the hit boxes the same */
await page.evaluate(() => window.__ch.setRoom(40));
await page.waitForTimeout(300);
const handles = async () => page.evaluate(() => window.__ch.orderHandles());
const h0 = await handles();
/* the label with candles behind it (a candle's high to low crosses its box) */
const overId = await page.evaluate(hs => { const ch = window.__ch, bs = ch.bars();
  for (const h of hs) { const b = h.box; for (let i = 0; i < bs.length; i++) { const x = ch.barToX(i); if (x < b.x - 3 || x > b.x + b.w + 3) continue; if (ch.priceToY(bs[i].h) <= b.y + b.h && ch.priceToY(bs[i].l) >= b.y) return h.id; } }
  return null; }, h0);
check(!!overId, 'a label with candles behind it at 40 px of room: ' + overId);
const sBox = h0.find(h => h.id === (overId || 's1')).box;
const labelPixels = () => page.evaluate(b => {
  const cv = document.querySelector('#c canvas'), x = cv.getContext('2d'), d = devicePixelRatio;
  const img = x.getImageData(Math.round(b.x * d), Math.round(b.y * d), Math.round(b.w * d), Math.round(b.h * d)).data;
  let s = 0; for (let i = 0; i < img.length; i += 4) s += img[i] + img[i + 1] + img[i + 2];
  return s / (img.length / 4);
}, sBox);
const farL = await labelPixels();
await shot(page, 'labels-far.png', { x: Math.max(0, sBox.x - 160), y: Math.max(0, sBox.y - 60), width: 360, height: 140 });
await page.mouse.move(sBox.x - 10, sBox.y - 16);
await page.waitForTimeout(200);
const nearL = await labelPixels();
const h1 = await handles();
await shot(page, 'labels-near.png', { x: Math.max(0, sBox.x - 160), y: Math.max(0, sBox.y - 60), width: 360, height: 140 });
check(nearL - farL > 3, 'the label over candles draws lighter away from the mouse and full near it (mean ' + farL.toFixed(1) + ' far, ' + nearL.toFixed(1) + ' near)');
check(JSON.stringify(h0) === JSON.stringify(h1), 'the labels\' hit areas are the same boxes whatever their strength');
/* a drag of the stop label still moves it, to the price under the mouse */
const stopBox = h0.find(h => h.id === 's1').box;
await page.mouse.move(stopBox.x + 12, stopBox.y + stopBox.h / 2);
await page.mouse.down();
await page.mouse.move(stopBox.x + 12, stopBox.y + stopBox.h / 2 - 20, { steps: 5 });
await page.waitForTimeout(150);
await shot(page, 'lines-drag-stop.png');
await page.mouse.up();
await page.waitForTimeout(150);
const moves = await page.evaluate(() => window.__moves);
check(moves.length === 1 && moves[0].id === 's1' && moves[0].price > setup.stop, 'dragging the stop label up still moves it: ' + JSON.stringify(moves));
/* a label over empty room is never see-through: room 400 puts the labels right of the candles */
await page.evaluate(() => { window.__ch.setOrders(window.__ch.getOrders()); window.__ch.setRoom(400); });
await page.mouse.move(20, 20);
await page.waitForTimeout(300);
const eBox = (await handles()).find(h => h.id === 's1').box;
const lp2 = () => page.evaluate(b => { const cv = document.querySelector('#c canvas'), x = cv.getContext('2d'), d = devicePixelRatio; const img = x.getImageData(Math.round(b.x * d), Math.round(b.y * d), Math.round(b.w * d), Math.round(b.h * d)).data; let s = 0; for (let i = 0; i < img.length; i += 4) s += img[i] + img[i + 1] + img[i + 2]; return s / (img.length / 4); }, eBox);
const emptyFar = await lp2();
await page.mouse.move(eBox.x - 10, eBox.y - 16); await page.waitForTimeout(200);
const emptyNear = await lp2();
check(Math.abs(emptyFar - emptyNear) <= 0.5, 'a label over empty room is full either way (mean ' + emptyFar.toFixed(1) + ', ' + emptyNear.toFixed(1) + ')');
await shot(page, 'lines-room-400.png');
await browser.close();
if (ONLY) { console.log('lines smoke: screenshots only'); process.exit(errors.length ? 1 : 0); }
if (errors.length) { console.error(`lines smoke: ${errors.length} of ${checks} checks FAILED\n` + errors.join('\n')); process.exit(1); }
console.log(`lines smoke: ${checks} checks, all ok`);
