// Fit stop and target smoke (Unreleased, Anthony 2026-11-02: "an option to have the chart zoom out to fit the stop and target
// like it is now, but an option to toggle that off as well, maybe near the lock on the bottom right"): one chart with a short
// position, its stop far above and its target far below the candles, and a working entry in view, in Chromium at 2x:
//   - on (the default): the price scale takes in the stop and the target, as since 1.14.0; the toggle sits beside the lock in
//     the corner under the price axis, the lock's size, its tooltip "Fit stop and target: on ...";
//   - a click turns it off: the scale fits the candles only, the stop shows as a marker at the plot's top right edge and the
//     target at its bottom right edge, each with its price, and the view does not move for them (a stop moved farther away
//     changes nothing but the marker's price);
//   - dragging the entry line in view still moves it (orderMove at the price under the pointer);
//   - a click turns it on again and the scale takes the lines in again.
// Screenshots in test/out/ (FIT_SHOTS=dir copies them): fit-on.png, fit-off.png, fit-corner-on.png, fit-corner-off.png,
// fit-off-markers-top.png, fit-off-markers-bottom.png. Sample data only (a random walk made here).
//   npm run smoke:fit
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const SHOTS = process.env.FIT_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const errors = [];
let checks = 0;
const check = (ok, m) => { checks++; if (!ok) { errors.push(m); console.error('  FAIL ' + m); } else console.log('  ok   ' + m); };
async function shot(page, name, clip) {
  const file = path.join(out, name);
  await page.screenshot(clip ? { path: file, clip } : { path: file });
  if (SHOTS) fs.copyFileSync(file, path.join(SHOTS, name));
}

const VW = 1000, VH = 560;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 2 });
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.setContent('<!doctype html><html><head><link rel="stylesheet" href="file://' + path.join(root, 'live', 'fonts', 'plex.css') + '"><style>html,body{margin:0;height:100%;background:#080B10}#c{position:absolute;left:0;top:0;width:' + VW + 'px;height:' + VH + 'px}</style></head><body><div id="c"></div></body></html>');
  await page.addScriptTag({ path: path.join(root, 'src', 'chart-engine.js') });
  const setup = await page.evaluate(async () => {
    const host = document.getElementById('c');
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const bars = []; let p = 20000;
    for (let i = 0; i < 400; i++) { const o = p, c = o + (rnd() - 0.5) * 6, h = Math.max(o, c) + rnd() * 3, l = Math.min(o, c) - rnd() * 3; bars.push({ t: 1760000000 + i * 60, o, h, l, c, v: 100 }); p = c; }
    const ch = window.__ch = ChartEngine.create(host, { barSpacing: 7, room: 200, pointValue: 2, motion: { zoom: 0, fit: 0, candle: 0, follow: 0, friction: 0 },
      layers: { volume: false, vwap: false, levels: false, trades: false, ib: false }, clock: () => 1760000000 + 400 * 60 });
    ch.setBars(bars);
    await new Promise(r => setTimeout(r, 200));
    const ps = ch.priceScale(), span = ps.hi - ps.lo, q = v => Math.round(v * 4) / 4, last = bars[bars.length - 1].c;
    const stop = q(ps.hi + span * 0.6), target = q(ps.lo - span * 0.6), avg = q(last + span * 0.05), entry = q(last - span * 0.15);
    window.__moves = []; ch.on('orderMove', e => window.__moves.push(e));
    window.__fits = []; ch.on('fitOrders', v => window.__fits.push(v));
    ch.setPosition({ qty: -1, avgPrice: avg, pointValue: 2 });
    ch.setOrders([{ id: 's1', side: 'buy', kind: 'stop', price: stop, qty: 1, role: 'stop' }, { id: 't1', side: 'buy', kind: 'limit', price: target, qty: 1, role: 'target' },
      { id: 'e1', side: 'sell', kind: 'limit', price: entry, qty: 1 }]);
    ch.setOrderEditing(true);
    await new Promise(r => setTimeout(r, 300));
    return { candles: { lo: ps.lo, hi: ps.hi }, stop, target, avg, entry };
  });
  console.log('  setup: ' + JSON.stringify(setup));
  const state = () => page.evaluate(() => {
    const ch = window.__ch, ps = ch.priceScale(), b = document.querySelector('#c').getBoundingClientRect();
    const box = el => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, right: b.right - r.right, bottom: b.bottom - r.bottom }; };
    const lock = document.querySelector('#c .ce-lock'), fit = document.querySelector('#c .ce-fit');
    return { lo: ps.lo, hi: ps.hi, plotH: ps.plotHeight, auto: ps.auto, fit: ch.fitOrders(), edges: ch.orderEdges(),
      lock: box(lock), btn: box(fit), title: fit.title, pressed: fit.getAttribute('aria-pressed'), data: fit.getAttribute('data-fit'),
      color: getComputedStyle(fit).color, bg: getComputedStyle(fit).backgroundColor, lockColor: getComputedStyle(lock).color, fits: window.__fits.slice() };
  });
  const corner = { x: VW - 78, y: VH - 26, width: 78, height: 26 };

  // on: today's behavior
  let s = await state();
  check(s.fit && s.lo <= setup.target && s.hi >= setup.stop, 'on by default: the scale takes in the stop and the target (' + s.lo.toFixed(2) + ' to ' + s.hi.toFixed(2) + ')');
  check(s.edges.length === 0, 'on: no edge markers');
  check(s.btn.w === s.lock.w && s.btn.h === s.lock.h && s.btn.y === s.lock.y && s.lock.x - (s.btn.x + s.btn.w) === 4, 'the toggle beside the lock, the same size and row, 4 px apart: ' + JSON.stringify({ btn: s.btn, lock: s.lock }));
  check(s.btn.x >= VW - 78 && s.lock.x + s.lock.w <= VW && s.btn.y >= VH - 26 && s.btn.y + s.btn.h <= VH, 'both in the corner under the price axis');
  check(s.pressed === 'true' && s.data === 'on' && /^Fit stop and target: on\b/.test(s.title) && s.color === s.lockColor, 'on: pressed, quiet grey like the unlocked padlock, tooltip "' + s.title + '"');
  await page.mouse.move(20, 20); await page.waitForTimeout(150);
  await shot(page, 'fit-on.png');
  await page.mouse.move(s.btn.x + 12, s.btn.y + 10); await page.waitForTimeout(150);
  await shot(page, 'fit-corner-on.png', corner);
  const hov = await page.evaluate(() => { const f = document.querySelector('#c .ce-fit'), l = document.querySelector('#c .ce-lock'); return { f: getComputedStyle(f).borderColor, l: getComputedStyle(l).borderColor }; });
  check(hov.f !== 'rgba(0, 0, 0, 0)', 'hover: a border, as the lock\'s (' + hov.f + ')');

  // off
  await page.click('#c .ce-fit'); await page.waitForTimeout(250);
  s = await state();
  check(!s.fit && s.fits.join() === 'false', 'a click turns it off and says so (on(\'fitOrders\'))');
  check(s.hi < setup.stop && s.lo > setup.target, 'off: the scale no longer takes in the stop or the target (' + s.lo.toFixed(2) + ' to ' + s.hi.toFixed(2) + ')');
  check(Math.abs(s.hi - setup.candles.hi) < 1e-6 && Math.abs(s.lo - setup.candles.lo) < 1e-6, 'off: the same scale as the candles alone');
  check(s.pressed === 'false' && s.data === 'off' && /^Fit stop and target: off\b/.test(s.title) && s.color === 'rgb(226, 198, 135)', 'off: the gold the locked padlock has, tooltip "' + s.title + '"');
  const top = s.edges.find(e => e.id === 's1'), bot = s.edges.find(e => e.id === 't1');
  const plotW = VW - 78;
  check(s.edges.length === 2 && top && bot, 'off: two edge markers (the entry in view has none): ' + JSON.stringify(s.edges));
  check(top && top.up && top.y === 4 && Math.abs(top.x + top.w - (plotW - 6)) < 1e-6 && top.price === setup.stop && top.text.startsWith('STP ') && top.text.endsWith(setup.stop.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/, ',')), 'the stop above: top right edge, its price');
  check(bot && !bot.up && bot.y + bot.h === s.plotH - 4 && Math.abs(bot.x + bot.w - (plotW - 6)) < 1e-6 && bot.price === setup.target && bot.text.startsWith('TGT '), 'the target below: bottom right edge, its price');
  // the marker's ink: the triangle in the line's own color (the buy side's)
  const ink = await page.evaluate(([x, y]) => { const cv = document.querySelector('#c canvas'), d = devicePixelRatio, px = cv.getContext('2d').getImageData(Math.round(x * d), Math.round(y * d), 1, 1).data; return [px[0], px[1], px[2]]; }, [top.x + 8, top.y + top.h / 2 + 1]);
  const long = await page.evaluate(() => window.__ch.colors().long);
  const hex = [1, 3, 5].map(k => parseInt(long.slice(k, k + 2), 16));
  check(ink.every((v, k) => Math.abs(v - hex[k]) < 40), 'the triangle in the stop line\'s color ' + long + ': ' + ink);
  await page.mouse.move(20, 20); await page.waitForTimeout(150);
  await shot(page, 'fit-off.png');
  await shot(page, 'fit-off-markers-top.png', { x: plotW - 220, y: 0, width: 220 + 78, height: 40 });
  await shot(page, 'fit-off-markers-bottom.png', { x: plotW - 220, y: VH - 26 - 40, width: 220 + 78, height: 66 });
  await page.mouse.move(s.btn.x + 12, s.btn.y + 10); await page.waitForTimeout(150);
  await shot(page, 'fit-corner-off.png', corner);
  await page.mouse.move(20, 20);

  // the view never moves for them
  const moved = await page.evaluate(async ([stop]) => {
    const ch = window.__ch, before = ch.priceScale();
    ch.setOrders(ch.getOrders().map(o => o.id === 's1' ? Object.assign({}, o, { price: stop + 40 }) : o));
    await new Promise(r => setTimeout(r, 200));
    const after = ch.priceScale();
    return { same: before.lo === after.lo && before.hi === after.hi, mark: ch.orderEdges().find(e => e.id === 's1') };
  }, [setup.stop]);
  check(moved.same && moved.mark && moved.mark.price === setup.stop + 40, 'a stop moved farther away: the view stays, the marker shows the new price');

  // dragging a line in view is unchanged
  const h = await page.evaluate(() => window.__ch.orderHandles().find(x => x.id === 'e1'));
  const y0 = h.box.y + h.box.h / 2, x0 = h.box.x + 10;
  await page.mouse.move(x0, y0); await page.mouse.down();
  await page.mouse.move(x0, y0 - 40, { steps: 6 }); await page.waitForTimeout(80);
  const want = await page.evaluate(y => Math.round(window.__ch.yToPrice(y) * 4) / 4, y0 - 40 - (h.box.y + h.box.h / 2 - h.y));
  await page.mouse.up(); await page.waitForTimeout(150);
  const mv = await page.evaluate(() => window.__moves.slice());
  check(mv.length === 1 && mv[0].id === 'e1' && Math.abs(mv[0].price - want) <= 0.25, 'off: dragging the entry in view still moves it: ' + JSON.stringify(mv) + ' (about ' + want + ')');

  // on again
  await page.evaluate(() => window.__ch.setOrders(window.__ch.getOrders()));
  await page.click('#c .ce-fit'); await page.mouse.move(20, 20); await page.waitForTimeout(250);
  s = await state();
  check(s.fit && s.fits.join() === 'false,true' && s.hi >= setup.stop + 40 && s.lo <= setup.target && s.edges.length === 0, 'a click turns it on again: both lines in view, no markers');
} finally {
  await browser.close();
}
console.log(`\n${checks - errors.length}/${checks} checks passed`);
if (errors.length) { console.error(errors.length + ' failed'); for (const e of errors) console.error('  ' + e); process.exit(1); }
