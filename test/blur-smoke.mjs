// Blur smoke (chart 1.37.0, Anthony 2026-10-22: "one grid panel's chart soft when zoomed out, sharp when zoomed in"): a chart
// placed at a fractional CSS position and size, at device pixel ratios 1, 1.25, 1.5 and 2, thin candles (zoomed out) and wide
// ones (zoomed in). The screenshot of the page (what the browser shows, in device pixels) is compared with the canvas's own
// pixels (what the engine drew): when the browser shows the canvas one to one, almost every pixel matches at one whole-pixel
// offset; when it resamples the canvas (scaled or moved by a fraction of a pixel), edges go soft and few pixels match.
// Also a control at a whole-pixel position and size. Sample data only (a random walk made here).
//   npm run smoke:blur        (BLUR_SHOTS=dir also saves crops; BLUR_EXPECT=fail inverts the verdict for the before run)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const SHOTS = process.env.BLUR_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const errors = [];
let checks = 0;
const check = (ok, m) => { checks++; if (!ok) { errors.push(m); console.error('  FAIL ' + m); } else console.log('  ok   ' + m); };
const SHARP = 0.97;   // the share of pixels that must match the canvas's own, one to one

const places = [
  { name: 'whole', left: 40, top: 30, width: 720, height: 400 },
  { name: 'fraction', left: 40.37, top: 30.61, width: 719.45, height: 400.3 },
  { name: 'grid', left: 33.333, top: 47.5, width: 640.667, height: 380.25 },   // a 12-column grid's third, as the workspace makes them
  { name: 'moved', left: 40.37, top: 30.61, width: 719.45, height: 400.3, move: 0.41 },   // then moved by a fraction with no resize (a dragged panel)
];
const results = [];
/* A real device scale factor for each ratio (as a monitor at 125% or 150% gives it), never the page emulation's: emulation
   snaps a canvas to whole CSS px, which no real screen does, so it would show soft edges no screen shows. */
for (const dpr of [1, 1.25, 1.5, 2]) {
  const browser = await chromium.launch(Object.assign({ args: ['--force-device-scale-factor=' + dpr, '--window-size=900,520'] }, process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}));
  const page = await browser.newPage({ viewport: null });
  if (await page.evaluate(() => devicePixelRatio) !== dpr) errors.push('dpr ' + dpr + ': the browser gave ' + await page.evaluate(() => devicePixelRatio));
  page.on('pageerror', e => errors.push('dpr ' + dpr + ': ' + e.message));
  await page.setContent('<!doctype html><html><head><style>html,body{margin:0;height:100%;background:#080B10}#c{position:absolute}</style></head><body><div id="c"></div></body></html>');
  await page.addScriptTag({ path: path.join(root, 'src', 'chart-engine.js') });
  for (const pl of places) {
    for (const zoom of [{ name: 'thin', spacing: 2.6 }, { name: 'wide', spacing: 14 }]) {
      const r = await page.evaluate(async ({ pl, zoom }) => {
        const host = document.getElementById('c');
        if (window.__ch) { window.__ch.destroy(); host.innerHTML = ''; }
        Object.assign(host.style, { left: pl.left + 'px', top: pl.top + 'px', width: pl.width + 'px', height: pl.height + 'px' });
        let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        const bars = []; let p = 20000;
        for (let i = 0; i < 900; i++) { const o = p, c = o + (rnd() - 0.5) * 12, h = Math.max(o, c) + rnd() * 5, l = Math.min(o, c) - rnd() * 5; bars.push({ t: 1760000000 + i * 60, o, h, l, c, v: 100 }); p = c; }
        const ch = window.__ch = ChartEngine.create(host, { barSpacing: zoom.spacing, minSpacing: 0.6, liveButton: false, lockButton: false, motion: { zoom: 0, fit: 0, candle: 0, follow: 0, friction: 0 },
          layers: { volume: false, vwap: false, levels: false, trades: false, ib: false }, clock: () => 1760000000 + 900 * 60 });
        ch.setBars(bars);
        await new Promise(res => setTimeout(res, 400));
        if (pl.move) { host.style.left = (pl.left + pl.move) + 'px'; await new Promise(res => setTimeout(res, 800)); }
        const cv = host.querySelector('canvas'), rect = cv.getBoundingClientRect();
        return { cw: cv.width, ch: cv.height, x: rect.left, y: rect.top, w: rect.width, h: rect.height, dpr: devicePixelRatio };
      }, { pl, zoom });
      const png = await page.screenshot({ type: 'png' });
      const m = await page.evaluate(async b64 => {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
        const sc = document.createElement('canvas'); sc.width = img.naturalWidth; sc.height = img.naturalHeight;
        const sx = sc.getContext('2d'); sx.drawImage(img, 0, 0);
        const cv = document.querySelector('#c canvas'), cx = cv.getContext('2d');
        const own = cx.getImageData(0, 0, cv.width, cv.height).data, shot = sx.getImageData(0, 0, sc.width, sc.height).data;
        const rect = cv.getBoundingClientRect(), d = devicePixelRatio;
        /* the plot's middle (no axis text), every 2nd pixel: the share within 6 of the canvas's own at the best whole-pixel offset */
        const x0 = Math.round(cv.width * 0.15), x1 = Math.round(cv.width * 0.75), y0 = Math.round(cv.height * 0.15), y1 = Math.round(cv.height * 0.8);
        const bx = Math.round(rect.left * d), by = Math.round(rect.top * d);
        let best = { share: -1, dx: 0, dy: 0 };
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          let n = 0, ok = 0;
          for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
            const sxp = x + bx + dx, syp = y + by + dy;
            if (sxp < 0 || syp < 0 || sxp >= sc.width || syp >= sc.height) continue;
            const a = (y * cv.width + x) * 4, s = (syp * sc.width + sxp) * 4;
            n++;
            if (Math.abs(own[a] - shot[s]) <= 6 && Math.abs(own[a + 1] - shot[s + 1]) <= 6 && Math.abs(own[a + 2] - shot[s + 2]) <= 6) ok++;
          }
          const share = n ? ok / n : 0;
          if (share > best.share) best = { share, dx, dy };
        }
        /* edge sharpness: across each candle body's left edge, the share of the step taken in one device pixel (1 sharp) */
        return { share: best.share, dx: best.dx, dy: best.dy, bx, by, fx: rect.left * d - Math.round(rect.left * d), fw: rect.width * d - cv.width };
      }, png.toString('base64'));
      const label = `dpr ${dpr} ${pl.name} ${zoom.name}`;
      results.push(Object.assign({ dpr, place: pl.name, zoom: zoom.name }, r, m));
      console.log(`  ${label}: canvas ${r.cw}x${r.ch} for ${r.w.toFixed(3)}x${r.h.toFixed(3)} css at ${r.x.toFixed(3)},${r.y.toFixed(3)}; match ${(m.share * 100).toFixed(1)}% at offset ${m.dx},${m.dy}; css x in device px off by ${m.fx.toFixed(3)}, width by ${m.fw.toFixed(3)}`);
      if (SHOTS) {
        const cx = Math.max(0, Math.round((r.x + r.w * 0.45))), cy = Math.max(0, Math.round(r.y + r.h * 0.35));
        await page.screenshot({ path: path.join(SHOTS, `blur-dpr${String(dpr).replace('.', '_')}-${pl.name}-${zoom.name}.png`), clip: { x: cx, y: cy, width: 90, height: 70 } });
      }
    }
  }
  await page.close();
  await browser.close();
}
fs.writeFileSync(path.join(out, 'blur-results.json'), JSON.stringify(results, null, 1));
const want = process.env.BLUR_EXPECT === 'fail' ? 'fail' : 'pass';
for (const r of results) {
  const sharp = r.share >= SHARP;
  if (want === 'pass') check(sharp, `dpr ${r.dpr} ${r.place} ${r.zoom}: shown one to one (${(r.share * 100).toFixed(1)}% of pixels match the canvas)`);
}
if (want === 'fail') {
  const soft = results.filter(r => r.share < SHARP);
  check(soft.length > 0, `the current code shows some placements soft (${soft.map(r => 'dpr ' + r.dpr + ' ' + r.place + ' ' + r.zoom + ' ' + (r.share * 100).toFixed(1) + '%').join('; ') || 'none'})`);
}
if (errors.length) { console.error(`blur smoke: ${errors.length} of ${checks} checks FAILED`); process.exit(1); }
console.log(`blur smoke: ${checks} checks, all ok`);
