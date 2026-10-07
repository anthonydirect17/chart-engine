// Motion kit smoke test (live/motion.js, docs/MOTION.md) in Chromium: the kit on a plain host page (test/motion-host.html)
// as a plain script and as an ES module import, a scene's start and end states in a real page (the stamp keeps its own
// tilt), a click during a scene finishes it and still clicks, reduced motion, and no animation frame asked for while
// idle. Screenshots in test/out/.
//   npm run smoke:motion        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const PORT = +(process.env.MOTION_SMOKE_PORT || 8813);
const errors = [];
let checks = 0;
const check = (ok, m) => { checks++; if (!ok) { errors.push(m); console.error('  FAIL ' + m); } else console.log('  ok   ' + m); };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const URL = `http://127.0.0.1:${PORT}/test/motion-host.html`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
// counts every animation frame the page asks for (installed before the kit loads)
const countFrames = () => { window.rafCalls = 0; const r = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = fn => { window.rafCalls++; return r(fn); }; };
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 360 } });
  page.on('pageerror', e => check(false, 'page error: ' + e.message));
  await page.addInitScript(countFrames);
  await page.goto(URL);
  check(await page.evaluate(() => typeof ChartMotion === 'object' && ChartMotion.VERSION === '1.0.0'), 'a plain script sets window.ChartMotion');
  check(await page.evaluate(() => window.rafCalls) === 0, 'loading the kit asks for no animation frame');
  check(await page.evaluate(async () => {
    const keep = window.ChartMotion; delete window.ChartMotion;
    await import('/live/motion.js?as-module');
    const ok = typeof window.ChartMotion.scene === 'function'; window.ChartMotion = keep; return ok;
  }), 'an ES module import sets window.ChartMotion too');
  check(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--motion-base').trim()) === '250ms', '--motion-base is 250ms');

  // a scene: start states, a frame in the middle, the end
  const start = await page.evaluate(() => {
    window.run = ChartMotion.scene(document.getElementById('panel'), { ms: 1200 });
    const s = id => getComputedStyle(document.getElementById(id));
    return { head: s('head').opacity, stampT: s('stamp').transform, stampS: s('stamp').scale, bar: s('bar').scale, num: document.getElementById('num').textContent, draw: window.lastDraw };
  });
  check(start.head === '0' && start.bar === '0 1' && start.num === '$0.00' && start.draw === 0, 'a scene starts hidden, bars empty, numbers at 0, the canvas at 0: ' + JSON.stringify(start));
  check(start.stampT !== 'none' && start.stampS === '1.9', 'the stamp keeps its own tilt while it lands big');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, 'motion-mid.png') });
  const mid = await page.evaluate(() => ({ p: run.progress(), num: document.getElementById('num').textContent }));
  check(mid.p > 0.2 && mid.p < 0.8 && mid.num !== '+$1,284.50', 'mid scene at ' + mid.p.toFixed(2) + ', the number counting: ' + mid.num);
  await page.waitForTimeout(1000);
  const end = await page.evaluate(() => ({
    done: run.done(), styles: ['head', 'row', 'bar', 'stamp', 'btn'].map(id => document.getElementById(id).getAttribute('style') || '').join('|'),
    num: document.getElementById('num').textContent, draw: window.lastDraw, raf: window.rafCalls }));
  check(end.done && end.styles === 'margin: 0px;||width: 40%;||', 'at the end every inline style is put back exactly: ' + end.styles);
  check(end.num === '+$1,284.50' && end.draw === 1, 'the number and the canvas end on their final state');
  await page.waitForTimeout(400);
  check(await page.evaluate(() => window.rafCalls) === end.raf, 'no animation frame asked for while idle');
  await page.screenshot({ path: path.join(out, 'motion-end.png') });

  // R4: a click during a scene finishes it and still clicks
  await page.evaluate(() => { window.run = ChartMotion.scene(document.getElementById('panel'), { ms: 5000 }); });
  await page.waitForTimeout(2600);   // the button's window (.4 to .7) has started
  await page.click('#btn', { force: true });
  const r4 = await page.evaluate(() => ({ done: run.done(), clicks: window.clicks, op: getComputedStyle(document.getElementById('head')).opacity }));
  check(r4.done && r4.clicks === 1 && r4.op === '1', 'a click in a running scene finishes it and the button still acts');
  await page.evaluate(() => { window.run = ChartMotion.scene(document.getElementById('panel'), { ms: 5000 }); });
  await page.keyboard.press('Shift');
  check(await page.evaluate(() => run.done()), 'a key finishes a running scene');

  // the page setting
  const off = await page.evaluate(() => {
    ChartMotion.setReducedMotion(true);
    const r = ChartMotion.scene(document.getElementById('panel'));
    const v = { done: r.done(), fast: getComputedStyle(document.documentElement).getPropertyValue('--motion-fast').trim(), saved: localStorage.getItem('motion-reduced-v1') };
    ChartMotion.setReducedMotion(false);
    return v;
  });
  check(off.done && off.fast === '0ms' && off.saved === '1', 'setReducedMotion(true): final state at once, tokens 0, saved');

  // the system setting
  const rm = await browser.newPage({ reducedMotion: 'reduce' });
  rm.on('pageerror', e => check(false, 'page error: ' + e.message));
  await rm.addInitScript(countFrames);
  await rm.goto(URL);
  const sys = await rm.evaluate(() => {
    const r = ChartMotion.scene(document.getElementById('panel'));
    return { done: r.done(), styles: document.getElementById('row').getAttribute('style'), fast: getComputedStyle(document.documentElement).getPropertyValue('--motion-fast').trim(), raf: window.rafCalls };
  });
  check(sys.done && sys.styles === null && sys.fast === '0ms' && sys.raf === 0, 'prefers-reduced-motion: final state at once, nothing written, no frame: ' + JSON.stringify(sys));
} finally {
  await browser.close();
  server.close();
}
console.log(errors.length ? `\nmotion smoke: ${errors.length} of ${checks} checks FAILED` : `\nmotion smoke: all ${checks} checks passed`);
process.exit(errors.length ? 1 : 0);
