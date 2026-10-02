// An order drag holds the price scale still (chart 1.14.0, review D2, from the reviewer's drag probe), in Chromium, the
// engine alone: while an order's line is dragged, (a) a trade near the header on a scale set by hand, (b) a new order
// far off the scale (zoom to brackets), (c) a change of the room right, (d) a trade that widens an auto-fit scale must
// not move the scale or the line: the line stays under the pointer and the price sent on the drop is the price drawn.
// After the drop the scale eases on to take in what came meanwhile.
//   npm run smoke:dragfreeze        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = fs.readFileSync(path.join(root, 'src', 'chart-engine.js'), 'utf8');
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  page.on('pageerror', e => fail('page error: ' + e.message));
  await page.setContent('<!doctype html><html><body style="margin:0;background:#000"><div id="c" style="position:absolute;left:0;top:0;width:900px;height:500px"></div></body></html>');
  await page.addScriptTag({ content: ENGINE });
  for (const mid of ['header', 'brackets', 'room', 'trade']) {
    await page.evaluate(() => {
      const div = document.getElementById('c'); div.innerHTML = '';
      const c = window.c = window.ChartEngine.create(div, { tick: 0.25, layers: { volume: false }, motion: { candle: 0, fit: 120, follow: 0, zoom: 0 } });
      const bars = []; for (let i = 0; i < 80; i++) bars.push({ t: 36000 + i * 60, o: 100, h: 101, l: 99, c: 100 + (i % 3) * 0.25, v: 10 });
      c.setBars(bars, { barSeconds: 60 });
      c.setOrders([{ id: 'S', side: 'sell', kind: 'stop', price: 99.75, qty: 1 }]);
      c.setOrderEditing(true);
      window.moves = []; c.on('orderMove', e => window.moves.push(e));
    });
    await page.waitForTimeout(500);
    if (mid === 'header') {                                  // a scale squashed by hand: the wheel over the price axis
      await page.mouse.move(880, 250); for (let k = 0; k < 4; k++) await page.mouse.wheel(0, 200);
      await page.waitForTimeout(300);
    }
    const h = await page.evaluate(() => window.c.orderHandles().find(x => x.id === 'S'));
    const box = h.box, x0 = box.x + box.w / 2, y0 = box.y + box.h / 2;
    await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x0, y0 + 60, { steps: 8 });
    await page.waitForTimeout(100);
    const scale = () => page.evaluate(() => { const s = window.c.priceScale(); return { lo: s.lo, hi: s.hi, auto: s.auto }; });
    const lineY = () => page.evaluate(() => { const b = window.c.orderHandles().find(x => x.id === 'S').box; return b.y + b.h / 2; });
    const s0 = await scale(), l0 = await lineY();
    await page.evaluate(m => {                                // the event, the mouse held still
      const c = window.c, b = c.bars(), last = b[b.length - 1];
      if (m === 'header') { const s = c.priceScale(); c.update({ t: last.t, o: last.o, h: s.hi - (s.hi - s.lo) * 0.005, l: last.l, c: s.hi - (s.hi - s.lo) * 0.006, v: last.v + 1 }); }
      if (m === 'brackets') c.setOrders([{ id: 'S', side: 'sell', kind: 'stop', price: 99.75, qty: 1 }, { id: 'T', side: 'sell', kind: 'limit', price: 140, qty: 1 }]);
      if (m === 'room') c.setRoom(160);
      if (m === 'trade') c.update({ t: last.t, o: last.o, h: 112, l: last.l, c: 111.75, v: last.v + 1 });
    }, mid);
    await page.waitForTimeout(600);
    const s1 = await scale(), l1 = await lineY();
    await page.mouse.move(x0, y0 + 61); await page.mouse.move(x0, y0 + 60);
    const l2 = await lineY();
    const drawn = await page.evaluate(y => Math.round(window.c.yToPrice(y) * 4) / 4, l2);
    const pxTick = await page.evaluate(() => Math.abs(window.c.priceToY(100) - window.c.priceToY(100.25)));
    await page.mouse.up(); await page.waitForTimeout(80);
    const moves = await page.evaluate(() => window.moves);
    check(s1.lo === s0.lo && s1.hi === s0.hi && s1.auto === s0.auto, `${mid}: the scale held still during the drag (${s0.lo.toFixed(2)} to ${s0.hi.toFixed(2)}, auto ${s0.auto})`);
    check(Math.abs(l1 - l0) < 0.5 && Math.abs(l2 - (y0 + 60)) <= pxTick / 2 + 1, `${mid}: the line stayed under the pointer (line ${l1.toFixed(1)}, pointer ${(y0 + 60).toFixed(1)})`);
    check(moves.length === 1 && moves[0].price === drawn, `${mid}: the price sent is the price drawn (${JSON.stringify(moves)} vs ${drawn})`);
    if (mid === 'brackets' || mid === 'trade') {
      await page.waitForTimeout(800);
      const s2 = await scale();
      check(s2.hi > s0.hi + 1, `${mid}: after the drop the scale eases on to take it in (top ${s0.hi.toFixed(2)} to ${s2.hi.toFixed(2)})`);
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${checks - errors.length}/${checks} checks passed`);
if (errors.length) { console.error(errors.length + ' failed'); process.exit(1); }
