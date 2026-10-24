// Candles-same smoke (chart 1.37.0, Anthony 2026-10-22: "I really like our current candles ... I want to MAKE sure" the blur fix
// takes nothing away). The same SAMPLE chart (a seeded random walk made here, not market data) is drawn by the 1.36.0 engine
// (test/fixtures/chart-engine-1.36.0.js, the reference, unchanged) and by the current one, and their canvases must not differ in a
// single pixel:
//   (a) both at the same whole-pixel box (left 40, top 30, 720 x 400 css px);
//   (b) the current engine at a fractional box (it snaps its canvas to whole device pixels) against the reference placed at exactly
//       the box the current engine's canvas landed on (read from its getBoundingClientRect, never computed from the numbers set:
//       the browser lays out in 1/64 px, so a formula can land one device pixel off). The canvas sizes must match; the count of
//       pixels that differ is reported; and (b') the reference given exactly the current engine's plot width and height (its canvas's
//       device pixels over the ratio, what 1.37.0 lays out from) must differ in 0 pixels.
// At real device scale factors (--force-device-scale-factor, as the blur smoke), dpr 1, 1.25, 1.5 and 2, candle spacing 2.6, 6
// and 14. Every case's sizes and pixel counts go to test/out/candles-same.json.   npm run smoke:candles
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const REF = path.join(root, 'test', 'fixtures', 'chart-engine-1.36.0.js'), NOW = path.join(root, 'src', 'chart-engine.js');
const errors = [];
let checks = 0;
const check = (ok, m) => { checks++; if (!ok) { errors.push(m); console.error('  FAIL ' + m); } else console.log('  ok   ' + m); };

const WHOLE = { name: 'whole', left: 40, top: 30, width: 720, height: 400 };
const FRACTIONS = [
  { name: 'fraction', left: 40.37, top: 30.61, width: 719.45, height: 400.3 },
  { name: 'grid', left: 33.333, top: 47.5, width: 640.667, height: 380.25 },   // a 12-column grid's third, as the workspace makes them
];
const SPACINGS = [2.6, 6, 14];

/* draws the sample chart in host box `b` and answers every canvas's size, box and pixels (base64 RGBA) */
async function draw(page, b, spacing, size, theme) {
  return page.evaluate(async ({ b, spacing, size, theme }) => {
    const host = document.getElementById('c');
    if (window.__ch) { window.__ch.destroy(); host.innerHTML = ''; }
    /* size (the reference only, b'): the host measures exactly the current engine's plot size (its canvas's device px over the
       ratio), so the reference lays its candles out from the same width and height */
    if (size) host.getBoundingClientRect = function () { const r = Element.prototype.getBoundingClientRect.call(this); return { left: r.left, top: r.top, right: r.left + size.w, bottom: r.top + size.h, x: r.left, y: r.top, width: size.w, height: size.h }; };
    else delete host.getBoundingClientRect;
    Object.assign(host.style, { left: b.left + 'px', top: b.top + 'px', width: b.width + 'px', height: b.height + 'px' });
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;   // SAMPLE data: a seeded random walk
    const bars = []; let p = 20000;
    for (let i = 0; i < 900; i++) { const o = p, c = o + (rnd() - 0.5) * 12, h = Math.max(o, c) + rnd() * 5, l = Math.min(o, c) - rnd() * 5; bars.push({ t: 1760000000 + i * 60, o, h, l, c, v: 100 }); p = c; }
    const ch = window.__ch = ChartEngine.create(host, { barSpacing: spacing, minSpacing: 0.6, liveButton: false, lockButton: false, motion: { zoom: 0, fit: 0, candle: 0, follow: 0, friction: 0 },
      layers: { volume: false, vwap: false, levels: false, trades: false, ib: false }, clock: () => 1760000000 + 900 * 60,
      /* 1.39.0: drawn twice (GROUNDS below): on the Black preset, whose colors both engines build the same way, and on the
         default V2 ground, the reference given the V2 chart colors as set colors (it keeps colors set by hand) */
      theme });
    ch.setBars(bars);
    await new Promise(res => setTimeout(res, 600));
    return [...host.querySelectorAll('canvas')].map(cv => {
      const r = cv.getBoundingClientRect(), d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let s = ''; for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000));
      return { w: cv.width, h: cv.height, box: { left: r.left, top: r.top, width: r.width, height: r.height }, px: btoa(s) };
    });
  }, { b, spacing, size, theme });
}
/* the pixels that differ (any of R, G, B, A), or null when the sizes differ; where (the box around them, in device px) */
function differ(a, b, where) {
  if (a.w !== b.w || a.h !== b.h) return null;
  const x = Buffer.from(a.px, 'base64'), y = Buffer.from(b.px, 'base64');
  let n = 0;
  for (let i = 0; i < x.length; i += 4) if (x[i] !== y[i] || x[i + 1] !== y[i + 1] || x[i + 2] !== y[i + 2] || x[i + 3] !== y[i + 3]) {
    n++;
    if (where) { const px = (i / 4) % a.w, py = Math.floor(i / 4 / a.w); where.x0 = Math.min(where.x0, px); where.x1 = Math.max(where.x1, px); where.y0 = Math.min(where.y0, py); where.y1 = Math.max(where.y1, py); }
  }
  return n;
}
/* on a difference: both canvases as PNG in test/out, to look at */
async function keep(page, name) {
  const url = await page.evaluate(() => document.querySelector('#c canvas').toDataURL('image/png'));
  fs.writeFileSync(path.join(out, name), Buffer.from(url.split(',')[1], 'base64'));
}
const results = [];
/* 1.39.0 (house style V2; review of #70): the candles compared on two grounds. Black (#000000): both engines build its colors
   the same way. The default V2 ground (#050506): the current engine with its defaults, given bg #050506 as a host would; the
   1.36.0 reference with V2's chart colors set by hand (for it a custom ground; it keeps colors set by hand), so only the
   candles could differ. */
const CE = (await import('node:module')).createRequire(import.meta.url)(NOW);
const V2 = {}; for (const k of ['bg', 'rth', 'grid', 'axisLine', 'divider', 'cross', 'axisText', 'axisTextStrong', 'tagFill', 'tagBorder', 'tagText', 'exit', 'live']) V2[k] = CE.DEFAULT_THEME[k];
const GROUNDS = [{ name: 'black', now: { bg: '#000000' }, ref: { bg: '#000000' } }, { name: 'v2', now: { bg: '#050506' }, ref: V2 }];
for (const G of GROUNDS)
for (const dpr of [1, 1.25, 1.5, 2]) {
  const browser = await chromium.launch(Object.assign({ args: ['--force-device-scale-factor=' + dpr, '--window-size=900,520'] }, process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}));
  const pages = {};
  for (const [k, file] of [['ref', REF], ['now', NOW]]) {
    const page = pages[k] = await browser.newPage({ viewport: null });
    page.on('pageerror', e => errors.push(`dpr ${dpr} ${k}: ${e.message}`));
    await page.setContent('<!doctype html><html><head><style>html,body{margin:0;height:100%;background:#080B10}#c{position:absolute}</style></head><body><div id="c"></div></body></html>');
    await page.addScriptTag({ path: file });
  }
  const real = await pages.now.evaluate(() => devicePixelRatio);
  check(real === dpr, `dpr ${dpr}: the browser runs at a real device scale factor of ${real}`);
  const ver = await Promise.all(['ref', 'now'].map(k => pages[k].evaluate(() => ChartEngine.VERSION || '')));
  if (dpr === 1 && G === GROUNDS[0]) check(ver[0] === '1.36.0' && ver[1] !== '1.36.0', `the reference engine is 1.36.0, the current one ${ver[1]}`);
  for (const spacing of SPACINGS) {
    for (const pl of [WHOLE, ...FRACTIONS]) {
      const now = await draw(pages.now, pl, spacing, null, G.now);
      const box = pl === WHOLE ? pl : now[0].box;   // (b): the reference at exactly the box the current canvas landed on
      const ref = await draw(pages.ref, box, spacing, null, G.ref);
      const where = { x0: 1e9, x1: -1, y0: 1e9, y1: -1 };
      const counts = now.map((c, i) => ref[i] ? differ(ref[i], c, i === 0 ? where : null) : null);
      const r = { ground: G.name, dpr, spacing, place: pl.name, part: pl === WHOLE ? 'a' : 'b', canvases: [ref.length, now.length], sizes: now.map((c, i) => [ref[i] ? ref[i].w + 'x' + ref[i].h : '-', c.w + 'x' + c.h]),
        box, refBox: ref[0] && ref[0].box, nowBox: now[0].box, differ: counts, where: counts[0] ? where : null };
      const tag = `candles-same-${G.name}-dpr${String(dpr).replace('.', '_')}-${spacing}-${pl.name}`;
      if (counts.some(n => n)) { await keep(pages.ref, tag + '-ref.png'); await keep(pages.now, tag + '-now.png'); }
      const words = `${G.name} dpr ${dpr} spacing ${spacing} ${pl.name}: ${r.sizes.map(x => x.join(' vs ')).join(', ')}; pixels different: ${counts.map(n => n === null ? 'sizes differ' : n).join(', ')}`;
      if (pl === WHOLE) check(ref.length === now.length && counts.every(n => n === 0), '(a) ' + words);
      else {
        /* (b) as measured: the same canvas size is a must; the pixel count is reported (see b'). 1.36.0 lays its candles out from
           the box's width and height as the browser measures them (1/64 px layout units: 640.66669 at 1.5), 1.37.0 from its canvas's
           whole device pixels over the ratio (961 / 1.5 = 640.66667); a candle whose edge falls within that hair of a pixel's
           middle can land one device pixel over. (b'): the reference measuring exactly 1.37.0's width and height must give 0. */
        check(ref.length === now.length && counts.every(n => n !== null), '(b) ' + words + (counts[0] ? ` (in x ${where.x0} to ${where.x1}, y ${where.y0} to ${where.y1}; see b')` : ''));
        const exact = await draw(pages.ref, box, spacing, { w: now[0].w / dpr, h: now[0].h / dpr }, G.ref);
        const counts2 = now.map((c, i) => exact[i] ? differ(exact[i], c) : null);
        r.differExact = counts2;
        if (counts2.some(n => n)) await keep(pages.ref, tag + '-ref-exact.png');
        check(exact.length === now.length && counts2.every(n => n === 0), `(b') ${G.name} dpr ${dpr} spacing ${spacing} ${pl.name}, the reference measuring 1.37.0's plot size: pixels different: ${counts2.map(n => n === null ? 'sizes differ' : n).join(', ')}`);
      }
      results.push(r);
    }
  }
  await browser.close();
}
fs.writeFileSync(path.join(out, 'candles-same.json'), JSON.stringify(results, null, 1));
if (errors.length) { console.error(`candles-same smoke: ${errors.length} of ${checks} checks FAILED`); process.exit(1); }
console.log(`candles-same smoke: ${checks} checks, all ok (sample data)`);
