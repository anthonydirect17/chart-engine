// Break-even labels smoke (chart 1.38.0, Anthony 2026-10-22 at WORK: "when I am dragging the stop over the entry, it kicks out over
// the active candles, the entry is usually where I am moving my stop to b/e so it still gets in the way"). One chart in Chromium at
// 2x with a long position, its stop below, a target above and a working buy limit at the entry price; the stop's label is dragged
// up onto the entry price (break-even). Both as the workspace draws them (compact labels, room right 120 px) and full labels (room
// right 260 px):
//   - while the drag is held and after it lands: no label pixel left of the room-right gap's start (the last bar's right edge),
//     so nothing over the newest candles: every pixel that differs from the same chart with no orders, off the lines' own rows, the
//     crosshair and the price axis, is right of it;
//   - the labels do not overlap, each stays in the gutter (right-aligned at the plot's edge), the dragged label stays at its line;
//   - each label is visible and hittable: its x cancels its own order (orderCancel) and a drag of its body moves its own order.
// BE_ENGINE=path runs it on another engine file (the 1.37.0 engine for Anthony's before pictures; BE_SHOTS_ONLY=1 then checks
// nothing). Screenshots in test/out/ (and BE_SHOTS=dir). Sample data only (a random walk made here).
//   npm run smoke:be-labels
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const SHOTS = process.env.BE_SHOTS || '', ONLY = process.env.BE_SHOTS_ONLY === '1';
const ENGINE = process.env.BE_ENGINE || path.join(root, 'src', 'chart-engine.js');
const TAG = process.env.BE_TAG || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const errors = [];
let checks = 0;
const check = (ok, m) => { if (ONLY) { console.log('  (info) ' + (ok ? 'would pass: ' : 'would FAIL: ') + m); return ok; } checks++; if (!ok) { errors.push(m); console.error('  FAIL ' + m); } else console.log('  ok   ' + m); return ok; };
async function shot(page, name, clip) {
  const file = path.join(out, name);
  await page.screenshot(clip ? { path: file, clip } : { path: file });
  if (SHOTS) fs.copyFileSync(file, path.join(SHOTS, name));
}
const W = 1000, H = 560;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

async function run(mode) {
  const compact = mode === 'compact', room = compact ? 120 : 260;
  console.log(`-- ${compact ? 'compact labels (as the workspace), room 120 px' : 'full labels, room 260 px'}`);
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.setContent('<!doctype html><html><head><link rel="stylesheet" href="file://' + path.join(root, 'live', 'fonts', 'plex.css') + '"><style>html,body{margin:0;height:100%;background:#080B10}#c{position:absolute;left:0;top:0;width:' + W + 'px;height:' + H + 'px}</style></head><body><div id="c"></div></body></html>');
  await page.addScriptTag({ path: ENGINE });
  const S = await page.evaluate(async ([compact, room]) => {
    const host = document.getElementById('c');
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const bars = []; let p = 20000;
    for (let i = 0; i < 300; i++) { const o = p, c = o + (rnd() - 0.5) * 6, h = Math.max(o, c) + rnd() * 3, l = Math.min(o, c) - rnd() * 3; bars.push({ t: 1760000000 + i * 60, o, h, l, c, v: 100 }); p = c; }
    const ch = window.__ch = ChartEngine.create(host, { barSpacing: 8, liveButton: false, lockButton: false, room, pointValue: 2, compactLabels: compact,
      motion: { zoom: 0, fit: 0, candle: 0, follow: 0, friction: 0 }, layers: { volume: false, vwap: false, levels: false, trades: false, ib: false }, clock: () => 1760000000 + 300 * 60 });
    ch.setBars(bars);
    const q = v => Math.round(v * 4) / 4, last = bars[bars.length - 1].c;
    const tail = bars.slice(-40), lo = Math.min(...tail.map(b => b.l)), hi = Math.max(...tail.map(b => b.h));
    const avg = q(last), stop = q(Math.max(lo + 1, avg - 8)), target = q(Math.min(hi - 1, avg + 8));
    window.__S = { avg, stop, target, lo, hi };
    window.__ev = []; for (const k of ['orderMove', 'orderCancel']) ch.on(k, e => window.__ev.push(Object.assign({ k }, e)));
    window.__set = () => { ch.setPosition({ qty: 2, avgPrice: avg, pointValue: 2 }); ch.setOrders(window.__orders); };
    window.__orders = [{ id: 's1', side: 'sell', kind: 'stop', price: stop, qty: 2, role: 'stop' }, { id: 't1', side: 'sell', kind: 'limit', price: target, qty: 2, role: 'target' },
      { id: 'e1', side: 'buy', kind: 'limit', price: avg, qty: 1 }];
    ch.setOrderEditing(true);
    await new Promise(r => setTimeout(r, 200));
    const n = ch.bars().length - 1, gap = ch.room().gap, xl = ch.barToX(n), sp = ch.barToX(n) - ch.barToX(n - 1);
    return { avg, stop, target, gapStart: xl + sp / 2, plotW: xl + gap, spacing: sp };
  }, [compact, room]);
  const wait = ms => page.waitForTimeout(ms);
  const yOf = p => page.evaluate(p => window.__ch.priceToY(p), p);
  /* canvas grabs stay in the page (window.__img[name]); only the counts come back */
  const grab = name => page.evaluate(name => { const cv = document.querySelector('#c canvas'); (window.__img = window.__img || {})[name] = { w: cv.width, h: cv.height, d: cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data }; return name; }, name);
  const handles = () => page.evaluate(() => window.__ch.orderHandles());
  /* the reference: the same chart, no orders, the mouse where the drag will end (the crosshair the same) */
  const yAvg = await yOf(S.avg), yStop0 = await yOf(S.stop);
  await page.evaluate(() => window.__set());
  await wait(200);
  const h0 = await handles();
  const sBox = h0.find(h => h.id === 's1').box;
  const gx = Math.round(sBox.x + sBox.w - 8);                 // on the drawn chip (compact labels draw at the right of their box)
  const endY = yAvg + (sBox.y + sBox.h / 2 - yStop0);         // the grab point moved by exactly the stop's way to the entry
  await page.evaluate(() => { window.__ch.setOrders([]); window.__ch.setPosition(null); });
  await page.mouse.move(gx, endY); await wait(250);
  await grab('ref');
  check(Math.abs((await yOf(S.avg)) - yAvg) < 0.01, 'the scale does not move with the orders (the reference is comparable)');
  await page.evaluate(() => window.__set());
  await page.mouse.move(20, 20); await wait(250);
  await shot(page, `be-labels-${mode}${TAG}-start.png`, { x: Math.max(0, S.gapStart - 300), y: Math.max(0, yAvg - 110), width: Math.min(W, 300 + 260 + 70), height: 220 });
  /* the drag: the stop's label from its line up onto the entry price */
  await page.mouse.move(gx, sBox.y + sBox.h / 2); await wait(100);
  await page.mouse.down();
  await page.mouse.move(gx, endY, { steps: 8 }); await wait(250);
  await grab('drag'); const hDrag = await handles();
  await shot(page, `be-labels-${mode}${TAG}-drag.png`, { x: Math.max(0, S.gapStart - 300), y: Math.max(0, yAvg - 110), width: Math.min(W, 300 + 260 + 70), height: 220 });
  /* pixels left of the gap's start that differ from the reference: rows of the lines (entry, stop, target, the crosshair) and the
     crosshair's column left out; anything else there is a label over the newest candles */
  const yT = await yOf(S.target);
  const strayLeft = (name, rows, col) => page.evaluate(([name, rows, gapStart, gx]) => {
    const img = window.__img[name], ref = window.__img.ref, d = 2, x0 = Math.floor(gapStart * d) - 1;
    const skipRow = y => rows.some(r => Math.abs(y / d - r) <= 1.6), skipCol = x => Math.abs(x / d - gx) <= 1.6;
    let n = 0, minX = Infinity;
    for (let y = 0; y < img.h; y++) {
      if (skipRow(y)) continue;
      for (let x = 0; x < x0; x++) {
        if (skipCol(x)) continue;
        const i = (y * img.w + x) * 4;
        if (Math.abs(img.d[i] - ref.d[i]) + Math.abs(img.d[i + 1] - ref.d[i + 1]) + Math.abs(img.d[i + 2] - ref.d[i + 2]) > 24) { n++; if (x < minX) minX = x; }
      }
    }
    return { n, minX: minX / d };
  }, [name, rows, S.gapStart, col === undefined ? gx : col]);
  const stray = await strayLeft('drag', [yAvg, yT, endY]);
  check(stray.n === 0, 'while the stop is dragged onto the entry: no label pixel left of the room-right gap (' + S.gapStart.toFixed(1) + ' px): ' + stray.n + ' pixels' + (stray.n ? ' from x ' + stray.minX.toFixed(1) : ''));
  const sDrag = hDrag.find(h => h.id === 's1');
  check(!!sDrag && Math.abs(sDrag.box.y + sDrag.box.h / 2 - endY + (sBox.y + sBox.h / 2 - yStop0)) <= 1.5, 'the dragged label stays pinned at its line, in the gutter: ' + JSON.stringify(sDrag && sDrag.box));
  await page.mouse.up(); await wait(200);
  const mv = (await page.evaluate(() => window.__ev)).filter(e => e.k === 'orderMove');
  check(mv.length === 1 && mv[0].id === 's1' && mv[0].price === S.avg, 'the drag moves the stop to the entry price: ' + JSON.stringify(mv));
  /* the stop lands at break-even (as ChartBridge would confirm it) */
  await page.evaluate(avg => { window.__orders = window.__orders.map(o => (o.id === 's1' ? Object.assign({}, o, { price: avg }) : o)); window.__ch.setOrders(window.__orders); window.__ev = []; }, S.avg);
  /* at rest, the mouse away (a compact label under the mouse shows in full, as since 1.15.0): a reference with the mouse there too */
  await page.evaluate(() => { window.__ch.setOrders([]); window.__ch.setPosition(null); });
  await page.mouse.move(20, 20); await wait(250);
  await grab('ref');
  await page.evaluate(() => window.__set()); await wait(250);
  await grab('be'); const h1 = await handles();
  const stray2 = await strayLeft('be', [yAvg, yT, 20], 20);
  check(stray2.n === 0, 'at break-even (stop, entry and limit at one price): no label pixel left of the gap: ' + stray2.n + ' pixels' + (stray2.n ? ' from x ' + stray2.minX.toFixed(1) : ''));
  await page.mouse.move(20, 20); await wait(250);
  await shot(page, `be-labels-${mode}${TAG}-be.png`, { x: Math.max(0, S.gapStart - 300), y: Math.max(0, yAvg - 110), width: Math.min(W, 300 + 260 + 70), height: 220 });
  const h2 = await handles();
  const pb = await page.evaluate(() => window.__ch.positionBox());
  const boxes = h2.map(h => ({ id: h.id, b: h.box })).concat(pb ? [{ id: 'position', b: pb }] : []);
  const over = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  check(boxes.every((a, i) => boxes.every((b, j) => i === j || !over(a.b, b.b))), 'the labels do not overlap: ' + JSON.stringify(boxes.map(x => [x.id, Math.round(x.b.y)])));
  check(boxes.every(x => Math.abs(x.b.x + x.b.w + ((h2.find(h => h.id === x.id) || {}).xbox ? 18 : 0) - (S.plotW - 6)) <= 1), 'every label right-aligned in the gutter at the plot\'s edge');
  /* each visible and hittable: its x cancels its own order, its body drags its own order */
  for (const id of ['s1', 'e1']) {
    const h = h2.find(x => x.id === id);
    if (!check(!!h && !!h.xbox, id + ': a label with its x')) continue;
    await page.evaluate(() => { window.__ev = []; });
    await page.mouse.click(h.xbox.x + h.xbox.w / 2, h.xbox.y + h.xbox.h / 2); await wait(150);
    const ev = await page.evaluate(() => window.__ev);
    check(ev.length === 1 && ev[0].k === 'orderCancel' && ev[0].id === id, id + ': its x cancels its own order: ' + JSON.stringify(ev));
    await page.evaluate(() => { window.__ev = []; });
    const bx = Math.round(h.box.x + h.box.w - 8), by = h.box.y + h.box.h / 2;
    await page.mouse.move(bx, by); await page.mouse.down(); await page.mouse.move(bx, by - 24, { steps: 4 }); await page.mouse.up(); await wait(150);
    const ev2 = (await page.evaluate(() => window.__ev)).filter(e => e.k === 'orderMove');
    check(ev2.length === 1 && ev2[0].id === id, id + ': a drag of its label moves its own order: ' + JSON.stringify(ev2));
    await page.evaluate(() => window.__ch.setOrders(window.__orders)); await page.mouse.move(20, 20); await wait(150);
  }
  void h1;
  /* re-review of 1.38.0 (the rule: the label under a mouse that has not moved never changes owner): a buy limit and a sell stop at one
     price, the limit first in the list, so the stop's label is pushed a row down. A plain click on the stop's label, a press that
     moves 2 px (no tick), a drag undone with Escape and one released over the price axis: none moves any label, and the next
     press-drag where the mouse is (or, after Escape or the axis, where it was pressed) moves the stop again, never the limit */
  for (const how of ['click', '2px', 'escape', 'axis']) {
    await page.evaluate(avg => { window.__ch.setPosition(null); window.__orders = [{ id: 'e1', side: 'buy', kind: 'limit', price: avg, qty: 1 }, { id: 's1', side: 'sell', kind: 'stop', price: avg, qty: 2, role: 'stop' }]; window.__ch.setOrders(window.__orders); window.__ev = []; }, S.avg);
    await page.mouse.move(20, 20); await wait(250);
    const before = await handles(), sb = before.find(h => h.id === 's1').box, eb = before.find(h => h.id === 'e1').box;
    const px = Math.round(sb.x + sb.w - 8), py = sb.y + sb.h / 2;
    const displaced = Math.abs(sb.y - eb.y) >= 18;
    await page.mouse.move(px, py); await wait(150);
    await page.mouse.down();
    if (how === '2px') await page.mouse.move(px, py - 2, { steps: 2 });
    if (how === 'escape') { await page.mouse.move(px, py - 40, { steps: 5 }); await wait(100); await page.keyboard.press('Escape'); }
    await wait(80); await page.mouse.up(); await wait(200);
    if (how === 'axis') await page.mouse.move(Math.round(S.plotW + 30), py - 40, { steps: 5 });   // released over the price axis: cancelled
    if (how === 'escape' || how === 'axis') { await page.mouse.move(px, py); await wait(150); }
    const ev0 = (await page.evaluate(() => window.__ev)).filter(e => e.k === 'orderMove');
    const after = await handles();
    const same = JSON.stringify(after.map(h => [h.id, Math.round(h.box.y)])) === JSON.stringify(before.map(h => [h.id, Math.round(h.box.y)]));
    await page.evaluate(() => { window.__ev = []; });
    const ny = how === '2px' ? py - 2 : py;
    await page.mouse.down(); await page.mouse.move(px, ny - 12, { steps: 3 }); await page.mouse.up(); await wait(150);
    const ev1 = (await page.evaluate(() => window.__ev)).filter(e => e.k === 'orderMove');
    check(displaced && ev0.length === 0 && same && ev1.length === 1 && ev1[0].id === 's1', 'the stop\'s displaced label: a ' + how + ' (no move sent) leaves every label where it was (' + same + (same ? '' : ' ' + JSON.stringify([before, after].map(l => l.map(h => [h.id, Math.round(h.box.y)])))) + '), and the next press-drag there moves the stop: ' + JSON.stringify(ev1));
  }
  /* review of 1.38.0 (a real-money finding): right after a drag lands, with the mouse still where it let go, the stack must not
     reorder under it: a second press there (to nudge the same order one more tick) acts on the order just dragged, never on the
     label that was pushed aside. The stop (a sell stop) onto the entry, then the target (a sell limit) onto it, then (the
     reviewer's probe) the stop onto the buy limit with no position on: there 1.38.0 before this fix moved the buy limit */
  for (const [id, pos] of [['s1', true], ['t1', true], ['s1', false]]) {
    await page.evaluate(pos => window.__ch.setPosition(pos ? { qty: 2, avgPrice: window.__S.avg, pointValue: 2 } : null), pos);
    const list = [{ id: 's1', side: 'sell', kind: 'stop', price: S.stop, qty: 2, role: 'stop' }, { id: 't1', side: 'sell', kind: 'limit', price: S.target, qty: 2, role: 'target' },
      { id: 'e1', side: 'buy', kind: 'limit', price: S.avg, qty: 1 }];
    if (!pos) list.unshift(list.pop());                          // the probe: the buy limit first in the list, as ChartBridge may send it
    await page.evaluate(o => { window.__orders = o; window.__ch.setOrders(o); window.__ev = []; }, list);
    await page.mouse.move(20, 20); await wait(250);
    const hb = (await handles()).find(h => h.id === id).box, gy = hb.y + hb.h / 2, gxx = Math.round(hb.x + hb.w - 8);
    const yFrom = await yOf(id === 's1' ? S.stop : S.target), endAt = yAvg + (gy - yFrom);
    await page.mouse.move(gxx, gy); await wait(80); await page.mouse.down(); await page.mouse.move(gxx, endAt, { steps: 8 }); await wait(150);
    await page.mouse.up(); await wait(150);
    const mv1 = (await page.evaluate(() => window.__ev)).filter(e => e.k === 'orderMove');
    /* the move confirmed (as ChartBridge would), the mouse not moved */
    await page.evaluate(([id, avg]) => { window.__orders = window.__orders.map(o => (o.id === id ? Object.assign({}, o, { price: avg }) : o)); window.__ch.setOrders(window.__orders); window.__ev = []; }, [id, S.avg]);
    await wait(250);
    await page.mouse.down(); await page.mouse.move(gxx, endAt - 6, { steps: 3 }); await page.mouse.up(); await wait(150);
    const mv2 = (await page.evaluate(() => window.__ev)).filter(e => e.k === 'orderMove');
    check(mv1.length === 1 && mv1[0].id === id && mv2.length === 1 && mv2[0].id === id, id + (pos ? '' : ' (no position, onto the buy limit)') + ': dragged onto the entry, then a second press at the same spot right after it lands: it moves ' + id + ' again (' + JSON.stringify(mv1) + ', then ' + JSON.stringify(mv2) + ')');
  }
  /* 1.39.1 (the reviewer's probe): the mouse still on an order's label, a new order arrives at the same price earlier in the order
     list (it would take the label's row at its line); a press there drags the order Anthony was over, never the new one. Then the
     mouse moved off and onto the new order's label: a press acts on what is under the mouse then. Only which label a press finds is checked here; the orderMove event is the one the drag always sends. */
  for (const kind of ['stop', 'limit']) {   // h1: an order no earlier drag has made labelFirst (that one is gone with its order)
    await page.evaluate(avg => { window.__ch.setPosition(null); window.__orders = [{ id: 'h1', side: 'sell', kind: 'stop', price: avg, qty: 2, role: 'stop' }]; window.__ch.setOrders(window.__orders); window.__ev = []; }, S.avg);
    await page.mouse.move(20, 20); await wait(250);
    const hb = (await handles()).find(h => h.id === 'h1').box, hx = Math.round(hb.x + hb.w - 8), hy = hb.y + hb.h / 2;
    await page.mouse.move(hx, hy); await wait(250);                // hovering the stop's label, the mouse still
    const n2 = kind === 'stop' ? { id: 'n2', side: 'sell', kind: 'stop', price: S.avg, qty: 1, role: 'stop' } : { id: 'n2', side: 'buy', kind: 'limit', price: S.avg, qty: 1 };
    await page.evaluate(n2 => { window.__orders = [n2].concat(window.__orders); window.__ch.setOrders(window.__orders); window.__ev = []; }, n2);
    await wait(250);                                               // frames drawn with the new order, the mouse not moved
    const held = (await handles()).find(h => h.id === 'h1').box;
    await page.mouse.down(); await page.mouse.move(hx, hy - 12, { steps: 3 }); await page.mouse.up(); await wait(150);
    const ev = (await page.evaluate(() => window.__ev)).filter(e => e.k === 'orderMove');
    check(Math.abs(held.y - hb.y) < 0.5 && ev.length === 1 && ev[0].id === 'h1', 'a new ' + kind + ' at the same price, earlier in the list, while the mouse rests on the stop label: the stop keeps its row (y ' + Math.round(hb.y) + ' -> ' + Math.round(held.y) + ') and the press drags the stop: ' + JSON.stringify(ev));
    /* moved off it and onto the new order's label: the press acts on the label under the mouse then */
    await page.evaluate(() => { window.__orders = window.__orders.map(o => Object.assign({}, o, { price: window.__S.avg })); window.__ch.setOrders(window.__orders); window.__ev = []; });
    await page.mouse.move(20, 20); await wait(250);
    const hs = await handles(), nb = hs.find(h => h.id === 'n2').box;
    await page.mouse.move(Math.round(nb.x + nb.w - 8), nb.y + nb.h / 2); await wait(200);
    await page.mouse.down(); await page.mouse.move(Math.round(nb.x + nb.w - 8), nb.y + nb.h / 2 - 12, { steps: 3 }); await page.mouse.up(); await wait(150);
    const ev2 = (await page.evaluate(() => window.__ev)).filter(e => e.k === 'orderMove');
    check(ev2.length === 1 && ev2[0].id === 'n2', 'after the mouse moved off and onto the new ' + kind + '\'s label: a press there drags the new ' + kind + ': ' + JSON.stringify(ev2));
  }
  /* the review of #72 (HIGH): the hover pin held the label at last frame's screen y, so when the price scale moved under a still
     mouse (auto-scale on a new high or low, a scroll back in time, a zoom: the first two here) the label left its line and a drag from it landed far
     from where Anthony aimed. The label under a still mouse keeps its row against its own line: one label alone stays on its line */
  for (const how of ['a wide bar (auto-scale)', 'ArrowLeft (a scroll back in time)']) {
    await page.evaluate(avg => { window.__ch.setPosition(null); window.__orders = [{ id: 'k1', side: 'sell', kind: 'stop', price: avg - 3, qty: 1, role: 'stop' }]; window.__ch.setOrders(window.__orders); window.__ev = []; }, S.avg);
    await page.mouse.move(20, 20); await wait(250);
    const kb = (await handles()).find(h => h.id === 'k1').box, kx = Math.round(kb.x + kb.w - 8), ky = kb.y + kb.h / 2;
    await page.mouse.move(kx, ky); await wait(250);                 // resting on the stop's label
    const y0 = (await handles()).find(h => h.id === 'k1').y;
    if (how.startsWith('a wide')) await page.evaluate(() => { const b = window.__ch.bars()[window.__ch.bars().length - 1]; window.__ch.update({ t: b.t, o: b.o, h: b.h + 40, l: b.l - 40, c: b.c, v: 100 }); });
    else { await page.evaluate(() => document.getElementById('c').focus()); await page.keyboard.press('ArrowLeft'); }
    await wait(400);
    const k = (await handles()).find(h => h.id === 'k1');
    const onLine = !!k && Math.abs(k.box.y + k.box.h / 2 - k.y) <= 1.5;
    check(!!k && Math.abs(k.y - y0) > 3 && onLine, 'the stop label under a still mouse, the scale moved by ' + how + ': its line ' + Math.round(y0) + ' -> ' + (k ? Math.round(k.y) : '?') + ', the label stays on it (' + (k ? Math.round(k.box.y + k.box.h / 2) : '?') + ')');
    if (how.startsWith('a wide')) {
      /* a drag from the label where it now is moves the stop by the mouse's distance (24 px up) */
      await page.evaluate(() => { window.__ev = []; });
      const gx2 = Math.round(k.box.x + k.box.w - 8), gy2 = k.box.y + k.box.h / 2;
      await page.mouse.move(gx2, gy2); await wait(80);
      const want = await page.evaluate(y => window.__ch.yToPrice(y), k.y - 24);
      await page.mouse.down(); await page.mouse.move(gx2, gy2 - 24, { steps: 4 }); await page.mouse.up(); await wait(150);
      const mv = (await page.evaluate(() => window.__ev)).filter(e => e.k === 'orderMove');
      check(mv.length === 1 && mv[0].id === 'k1' && Math.abs(mv[0].price - want) <= 0.25 + 1e-9, 'after the scale moved, a drag from the label moves the stop by the mouse\'s distance: ' + JSON.stringify(mv) + ' (wanted about ' + want.toFixed(2) + ')');
    }
    await page.evaluate(() => { window.__ch.reset && window.__ch.reset(); }); await wait(300);
  }
  await page.close();
}
try {
  await run('compact');
  await run('full');
} catch (e) { errors.push('threw: ' + (e && e.stack || e)); console.error(e); }
await browser.close();
if (ONLY) { console.log('be-labels smoke: screenshots only'); process.exit(0); }
if (errors.length) { console.error(`be-labels smoke: ${errors.length} of ${checks} checks FAILED\n` + errors.join('\n')); process.exit(1); }
console.log(`be-labels smoke: ${checks} checks, all ok`);
