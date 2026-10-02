// Planned stop and target, NO STOP and the deep red Armed (chart 1.13.0) against the fake bridge (ChartBridge 0.3.8's
// protocol, sample data; nothing reaches a broker), on /single.html and in the workspace (two windows):
//   - a resting limit's planned stop and target drawn at the entry price minus and plus the ticks, labelled "SL plan" /
//     "TP plan"; they follow the entry while it is dragged and redraw from the confirmed price after the drop;
//   - dragging a planned line sends `plan` with the new ticks; across the entry it is refused on the page; its x sends
//     null; "+SL" / "+TP" on the entry adds it back at the bracket's distance;
//   - an older ChartBridge (no `planned` in its order messages): no planned lines, nothing new;
//   - the NO STOP tag and the one question before the first order with no stop (Cancel sends nothing, Send sends it, no
//     second question), Flatten never asked; in the workspace the question in the window clicked;
//   - Armed in deep red; screenshots of a resting limit with its planned lines at 1920x1080 on both pages.
//   npm run smoke:plan        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, unlockIfAsked, enterPin } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const PORT = +(process.env.PLAN_SMOKE_PORT || 8871);
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const bridges = [];
async function startBridge(port, flags) {
  const child = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(port)].concat(flags), { stdio: ['ignore', 'pipe', 'inherit'] });
  bridges.push(child);
  await new Promise(r => child.stdout.once('data', r));
}
const control = async (what, q) => (await fetch(`http://127.0.0.1:${PORT}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
const state = r => control('state', { root: r || 'MNQ' });
async function until(fn, what, ms) {
  const end = Date.now() + (ms || 8000);
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); }
}
/* every order message a page sends (any connection), and the notes it shows */
const spies = () => {
  window.__sent = []; window.__notes = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (['order', 'change', 'cancel', 'flatten', 'plan'].includes(m.type)) window.__sent.push(m); } catch (e) { /* not JSON */ } return send.call(this, d); };
  const iv = setInterval(() => { const el = document.getElementById('statusMsg') || document.getElementById('wsNote'); if (!el) return; clearInterval(iv); new MutationObserver(() => window.__notes.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true }); }, 20);
};
/* an older ChartBridge: its order messages have no `planned` */
const noPlanned = () => {
  const d = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
  Object.defineProperty(WebSocket.prototype, 'onmessage', { configurable: true, get() { return d.get.call(this); }, set(fn) {
    d.set.call(this, fn && function (ev) {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return fn.call(this, ev); }
      const strip = o => { if (o && typeof o === 'object') delete o.planned; };
      if (m && m.type === 'order') strip(m); else if (m && m.type === 'orders') (m.list || []).forEach(strip); else return fn.call(this, ev);
      return fn.call(this, new MessageEvent('message', { data: JSON.stringify(m) }));
    });
  } });
};
const strip = list => list.map(m => { const c = Object.assign({}, m); delete c.cid; return c; });

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  await startBridge(PORT, ['--trading', '--trade-accounts=Sim101', '--max-qty=MNQ:9,NQ:2,MES:2,ES:2', '--test-controls', '--version=0.3.8', '--test-pin=' + TEST_PIN]);
  const L = Math.round((await control('hold', { root: 'MNQ' })).last);
  await control('price', { root: 'MNQ', p: L });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(spies);

  /* ================================================================ /single.html */
  console.log('/single.html');
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('pageerror: ' + e.message));
  await page.goto(`http://localhost:${PORT}/live/single.html`);
  await unlockIfAsked(page);
  await page.waitForFunction(() => document.getElementById('connPill').textContent === 'LIVE' && !document.getElementById('buyMkt').disabled, null, { timeout: 30000 });
  await page.evaluate(() => window.liveChart.goLive()); await wait(1200);
  const sent = (p, t) => p.evaluate(ty => window.__sent.filter(m => !ty || ty.includes(m.type)), t);
  const clear = p => p.evaluate(() => { window.__sent.length = 0; window.__notes.length = 0; });
  const notes = p => p.evaluate(() => window.__notes.slice());
  const asked = () => page.evaluate(() => !document.getElementById('noStopAsk').hidden);

  // NO STOP: the tag, Flatten never asked, the one question
  const tag = await page.evaluate(() => { const t = document.getElementById('bNoStop'); return { shown: !t.hidden, text: t.textContent, color: getComputedStyle(t).color }; });
  check(tag.shown && tag.text === 'NO STOP' && tag.color === 'rgb(255, 122, 122)', 'the stop box is 0: a red NO STOP tag beside the bracket (' + JSON.stringify(tag) + ')');
  await clear(page);
  await page.click('#flattenBtn'); await wait(300);
  check(!(await asked()) && strip(await sent(page)).length === 1 && (await sent(page))[0].type === 'flatten', 'Flatten with no stop and disarmed: sent at once, never asked');
  await page.click('#armBtn');
  const red = await page.evaluate(() => { const a = getComputedStyle(document.getElementById('armBtn')), b = getComputedStyle(document.getElementById('obar')), p = getComputedStyle(document.getElementById('armPill'));
    return { arm: a.backgroundColor, armText: a.color, bar: b.borderTopColor, pill: p.backgroundColor }; });
  check(red.arm === 'rgb(159, 18, 57)' && red.armText === 'rgb(255, 228, 234)' && red.bar === 'rgb(224, 68, 94)' && red.pill === 'rgb(159, 18, 57)', 'Armed in deep red: the switch, the bar outline and the ARMED badge (' + JSON.stringify(red) + ')');
  await clear(page); await wait(450);
  await page.click('#buyMkt'); await wait(200);
  check(await asked() && /No stop: send anyway\?/.test(await page.textContent('#noStopAsk')) && !(await sent(page)).length, 'the first order with no stop asks "No stop: send anyway?" in the page, nothing sent yet');
  check(await page.evaluate(() => document.activeElement === document.getElementById('noStopCancel')), 'Cancel has the focus (Enter does not send by accident)');
  await page.keyboard.press('Alt+C');                                              // a key while the question is open: nothing
  await page.click('#noStopCancel'); await wait(200);
  check(!(await asked()) && !(await sent(page)).length, 'Cancel: nothing sent');
  await wait(450); await page.click('#buyMkt'); await wait(200);
  check(await asked(), 'the next one asks again (no answer yet)');
  await page.click('#noStopSend');
  await until(async () => (await sent(page, ['order'])).length === 1, 'sent after Send');
  const m1 = strip(await sent(page, ['order']))[0];
  check(m1 && m1.kind === 'market' && m1.side === 'buy' && !m1.bracket, 'Send: the order goes, with no bracket: ' + JSON.stringify(m1));
  await wait(450); await page.click('#sellMkt'); await wait(300);
  check(!(await asked()) && (await sent(page, ['order'])).length === 2, 'no second question this page load');
  await page.click('#armBtn');                                                     // disarmed: Flatten still never asked
  await clear(page); await page.click('#flattenBtn'); await wait(200);
  check(!(await asked()) && (await sent(page, ['flatten'])).length === 1, 'Flatten disarmed: sent');
  await until(async () => { const s = await state(); return !s.orders.length && !Object.values(s.positions).some(p => p.qty); }, 'flat');

  // a resting limit with its planned stop and target
  await page.click('#armBtn');
  for (const [k, v] of [['#bStop', '12'], ['#bTarget', '24']]) { await page.fill(k, v); await page.press(k, 'Tab'); }
  check(await page.evaluate(() => document.getElementById('bNoStop').hidden), 'a stop set: no NO STOP tag');
  const box = await page.locator('#chart canvas').boundingBox();
  const yAt = pr => page.evaluate(x => window.liveChart.priceToY(x), pr);
  await clear(page); await wait(450);
  await page.keyboard.down('Shift'); await page.mouse.click(box.x + box.width * 0.4, box.y + await yAt(L - 5)); await page.keyboard.up('Shift');
  const entry = await until(async () => (await state()).orders.find(o => o.role === 'entry' && o.state === 'working'), 'a resting buy limit');
  const lines = () => page.evaluate(() => window.liveChart.getOrders().map(o => ({ id: o.id, price: o.price, plan: o.plan || null, adds: o.adds || null })));
  let ls = await until(async () => { const l = await lines(); return l.length === 3 ? l : null; }, 'the entry and its two planned lines');
  const id = entry && entry.id;
  check(ls && ls.find(o => o.id === id + ':sl').price === L - 5 - 3 && ls.find(o => o.id === id + ':tp').price === L - 5 + 6, 'planned stop at the entry - 12 ticks, target + 24 ticks: ' + JSON.stringify(ls));
  const hs = () => page.evaluate(() => window.liveChart.orderHandles());
  const hOf = async i => (await hs()).find(h => h.id === i);
  await wait(300);
  await page.screenshot({ path: path.join(out, 'plan-single-1920x1080.png') });
  // the entry dragged: the planned lines follow while it moves; after the drop they redraw from the confirmed price
  let h = await hOf(id), slY0 = (await hOf(id + ':sl')).box.y;
  await page.mouse.move(box.x + h.box.x + h.box.w / 2, box.y + h.box.y + h.box.h / 2); await page.mouse.down();
  const yTo = await yAt(L - 7);
  await page.mouse.move(box.x + h.box.x + h.box.w / 2, box.y + yTo, { steps: 6 }); await wait(150);
  const slMid = (await hOf(id + ':sl')).box.y, entryMid = (await hOf(id)).box.y;
  check(Math.abs((slMid - slY0) - (entryMid - h.box.y)) < 3 && slMid - slY0 > 3, 'while the entry is dragged its planned stop moves with it (' + Math.round(slMid - slY0) + ' px, the entry ' + Math.round(entryMid - h.box.y) + ' px)');
  await clear(page);
  await page.mouse.up();
  await until(async () => (await state()).orders.some(o => o.id === id && o.price === L - 7), 'the entry moved to L - 7');
  check(strip(await sent(page)).every(m => m.type === 'change') && (await sent(page)).length === 1, 'the drop sends one change for the entry and nothing for its plan: ' + JSON.stringify(strip(await sent(page))));
  ls = await until(async () => { const l = await lines(); return l.find(o => o.id === id + ':sl' && o.price === L - 7 - 3) ? l : null; }, 'planned lines from the confirmed price');
  check(!!ls && ls.find(o => o.id === id + ':tp').price === L - 7 + 6, 'after the drop the planned lines are at the confirmed entry - 12 / + 24 ticks');
  // a planned line dragged: plan with the new ticks
  const dragLine = async (lid, toPrice) => {
    const g = await hOf(lid);
    await page.mouse.move(box.x + g.box.x + g.box.w / 2, box.y + g.box.y + g.box.h / 2); await page.mouse.down();
    await page.mouse.move(box.x + g.box.x + g.box.w / 2, box.y + await yAt(toPrice), { steps: 6 }); await page.mouse.up(); await wait(400);
  };
  await clear(page); await wait(450);
  await dragLine(id + ':sl', L - 7 - 4);                                           // 16 ticks under the entry
  await until(async () => (await sent(page, ['plan'])).length === 1, 'a plan for the stop');
  check(JSON.stringify(strip(await sent(page, ['plan']))) === JSON.stringify([{ type: 'plan', id, stopTicks: 16 }]), 'the planned stop dragged to 16 ticks: plan stopTicks 16');
  await until(async () => (await state()).orders.find(o => o.id === id).planned.stopTicks === 16, 'ChartBridge keeps 16');
  await clear(page); await wait(450);
  await dragLine(id + ':sl', L - 7 + 2);                                           // across the entry
  check(!(await sent(page, ['plan'])).length && (await notes(page)).some(t => /a stop goes on the loss side of the entry/.test(t)), 'the stop dragged across the entry: refused on the page, nothing sent');
  // the x on the planned target removes it; "+TP" on the entry adds it back at the bracket's 24 ticks
  await clear(page); await wait(450);
  let g = await hOf(id + ':tp');
  await page.mouse.click(box.x + g.xbox.x + g.xbox.w / 2, box.y + g.xbox.y + g.xbox.h / 2);
  await until(async () => (await state()).orders.find(o => o.id === id).planned.targetTicks === null, 'the target removed');
  check(JSON.stringify(strip(await sent(page, ['plan']))) === JSON.stringify([{ type: 'plan', id, targetTicks: null }]), 'its x sends targetTicks null');
  const adds = await until(async () => { const e = await hOf(id); return e && e.adds && e.adds.length ? e.adds : null; }, '+TP on the entry');
  check(adds && adds.map(a => a.which).join() === 'target', 'the entry offers "+TP"');
  await clear(page); await wait(450);
  g = (await hOf(id)).adds[0];
  await page.mouse.click(box.x + g.box.x + g.box.w / 2, box.y + g.box.y + g.box.h / 2);
  await until(async () => (await state()).orders.find(o => o.id === id).planned.targetTicks === 24, 'the target back');
  check(JSON.stringify(strip(await sent(page, ['plan']))) === JSON.stringify([{ type: 'plan', id, targetTicks: 24 }]), '"+TP" adds it at the bracket\'s 24 ticks');
  // disarmed: the lines stay, a drag sends nothing
  await page.click('#armBtn'); await wait(300);
  await clear(page);
  g = await hOf(id + ':sl');
  check(!!(await lines()).find(o => o.id === id + ':sl'), 'disarmed: the planned lines still show');
  await page.mouse.move(box.x + g.box.x + g.box.w / 2, box.y + g.box.y + g.box.h / 2); await page.mouse.down(); await page.mouse.move(box.x + g.box.x + g.box.w / 2, box.y + g.box.y + 40, { steps: 4 }); await page.mouse.up(); await wait(300);
  check(!(await sent(page)).length, 'disarmed: dragging a planned line sends nothing');
  await page.click('#flattenBtn');
  await until(async () => !(await state()).orders.length, 'flat');

  // an older ChartBridge: no `planned`, no lines, no "+SL"
  const oldp = await ctx.newPage();
  await oldp.addInitScript(noPlanned);
  oldp.on('pageerror', e => fail('old pageerror: ' + e.message));
  await oldp.goto(`http://localhost:${PORT}/live/single.html`);
  await unlockIfAsked(oldp);
  await oldp.waitForFunction(() => document.getElementById('connPill').textContent === 'LIVE' && !document.getElementById('buyMkt').disabled, null, { timeout: 30000 });
  await control('elsewhere', { account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'limit', qty: 1, p: L - 6 });
  await page.click('#armBtn'); await wait(450);
  await page.keyboard.down('Shift'); await page.mouse.click(box.x + box.width * 0.4, box.y + await yAt(L - 4)); await page.keyboard.up('Shift');
  await until(async () => (await state()).orders.filter(o => o.role === 'entry').length === 1, 'a ChartBridge entry with a plan');
  await wait(800);
  const oldLines = await oldp.evaluate(() => window.liveChart.getOrders().map(o => o.id + (o.plan ? ' plan' : '') + (o.adds && o.adds.length ? ' adds' : '')));
  const newLines = (await lines()).map(o => o.id);
  check(oldLines.length === 2 && oldLines.every(x => !/plan|adds/.test(x)) && newLines.length === 4, 'an older ChartBridge (no planned in its messages): the orders only, no planned lines, no +SL (' + oldLines + ' vs ' + newLines + ')');
  await oldp.close();
  await page.click('#flattenBtn');
  await until(async () => !(await state()).orders.length, 'flat');
  await page.close();

  /* ================================================================ the workspace: two windows */
  console.log('the workspace');
  async function openWs(layout) {
    const p = await ctx.newPage();
    p.on('pageerror', e => fail('ws pageerror: ' + e.message));
    await p.goto(`http://localhost:${PORT}/live/?layout=${layout}`);
    await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
    await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live') && window.workspace.ticket().enabled, null, { timeout: 30000 });
    return p;
  }
  await ctx.addInitScript(() => { try { localStorage.setItem('live-bracket-v1', JSON.stringify({ MNQ: { stop: 0, target: 0 } })); } catch (e) {} });
  const A = await openWs('Main');
  await A.waitForSelector('[data-tk-id="buyMkt"]');
  const B = await openWs('Second');
  await B.waitForFunction(() => window.workspace.ticket().holder !== null);
  const tk = id2 => `[data-tk-id="${id2}"]`;
  check(await A.evaluate(() => !document.querySelector('[data-tk-id="bNoStop"]').hidden), 'the ticket shows NO STOP (stop 0)');
  await A.click(tk('armBtn'));
  const tred = await A.evaluate(() => ({ arm: getComputedStyle(document.querySelector('[data-tk-id="armBtn"]')).backgroundColor, outline: getComputedStyle(document.querySelector('[data-tk-id="obar"]')).borderTopColor }));
  check(tred.arm === 'rgb(159, 18, 57)' && tred.outline === 'rgb(224, 68, 94)', 'the ticket\'s Armed switch and outline in deep red (' + JSON.stringify(tred) + ')');
  const mnqA = (await A.evaluate(() => window.workspace.panels())).find(x => x.type === 'chart' && x.root === 'MNQ');
  const mnqB = (await B.evaluate(() => window.workspace.panels())).find(x => x.type === 'chart' && x.root === 'MNQ');
  const glow = await A.evaluate(i => getComputedStyle(document.querySelector(`.ws-panel[data-id="${i}"] .stage`)).borderTopColor, mnqA.id);
  check(glow === 'rgb(123, 92, 255)', 'the chart borders stay purple (' + glow + ')');
  // the question in the window clicked: B's Buy key while the ticket (A) has stop 0
  await A.evaluate(() => { window.__sent.length = 0; }); await B.evaluate(() => { window.__sent.length = 0; });
  await B.bringToFront(); await B.evaluate(() => { localStorage.setItem('live-hotkeys-v1', JSON.stringify({ buy: 'Alt+B', sell: '', be: '', close: 'Alt+C', flattenAll: '' })); window.dispatchEvent(new StorageEvent('storage', { key: 'live-hotkeys-v1' })); });
  await B.evaluate(() => document.activeElement && document.activeElement.blur());
  await B.keyboard.press('Alt+B'); await wait(300);
  const bAsk = await B.evaluate(() => { const d = document.getElementById('wsDialog'); return d.open ? d.textContent : ''; });
  const aAsk = await A.evaluate(() => document.getElementById('wsDialog').open);
  check(/No stop: send anyway\?/.test(bAsk) && !aAsk && !(await sent(A)).length, 'B\'s Buy key with the ticket\'s stop 0: B asks (the window clicked), A does not, nothing sent yet');
  await B.click('#wsDialog [data-act="cancel"]'); await wait(300);
  check(!(await sent(A)).length, 'Cancel in B: nothing sent');
  await B.keyboard.press('Alt+C'); await wait(300);
  check((await sent(B, ['flatten'])).length === 1 && !(await B.evaluate(() => document.getElementById('wsDialog').open)), 'Close from B: never asked, sent');
  await wait(450); await B.keyboard.press('Alt+B'); await wait(300);
  await B.click('#wsDialog [type="submit"]');
  await until(async () => (await sent(A, ['order'])).length === 1, 'B\'s Buy sent from A after Send');
  await until(async () => (await A.evaluate(() => window.workspace.ticket().holder === null && true)) !== undefined, 'x');
  await A.bringToFront(); await wait(450);
  await A.click(tk('buyMkt')); await wait(300);
  check(!(await A.evaluate(() => document.getElementById('wsDialog').open)) && (await sent(A, ['order'])).length === 2, 'after Send in B, A does not ask again either (one question per ticket load)');
  await A.click(tk('flattenBtn'));
  await until(async () => { const s = await state(); return !s.orders.length && !Object.values(s.positions).some(p => p.qty); }, 'flat (workspace)');
  // a resting limit from A's chart with a bracket: planned lines on both windows' MNQ charts; B's drag goes through A
  for (const [k, v] of [['bStop', '12'], ['bTarget', '24']]) { await A.fill(tk(k), v); await A.press(tk(k), 'Tab'); }
  await A.evaluate(i => window.workspace.chart(i).goLive(), mnqA.id); await wait(500);
  const cbA = await A.locator(`.ws-panel[data-id="${mnqA.id}"] canvas`).first().boundingBox();
  const yA = await A.evaluate(([i, p]) => window.workspace.chart(i).priceToY(p), [mnqA.id, L - 5]);
  await wait(450);
  await A.keyboard.down('Shift'); await A.mouse.click(cbA.x + cbA.width * 0.4, cbA.y + yA); await A.keyboard.up('Shift');
  const e2 = await until(async () => (await state()).orders.find(o => o.role === 'entry' && o.state === 'working'), 'a resting limit from the workspace');
  const linesIn = (p, i) => p.evaluate(x => window.workspace.chart(x).getOrders().map(o => o.id), i);
  await until(async () => (await linesIn(B, mnqB.id)).length === 3 && (await linesIn(A, mnqA.id)).length === 3, 'planned lines in both windows');
  check((await linesIn(B, mnqB.id)).includes(e2.id + ':sl') && (await linesIn(B, mnqB.id)).includes(e2.id + ':tp'), 'B\'s MNQ chart shows the planned stop and target too');
  await A.evaluate(i => window.workspace.chart(i).goLive(), mnqA.id); await wait(500);
  await A.screenshot({ path: path.join(out, 'plan-workspace-1920x1080.png') });
  await B.bringToFront();
  await B.evaluate(i => window.workspace.chart(i).goLive(), mnqB.id); await wait(500);
  const cbB = await B.locator(`.ws-panel[data-id="${mnqB.id}"] canvas`).first().boundingBox();
  const gB = await B.evaluate(([i, id2]) => window.workspace.chart(i).orderHandles().find(x => x.id === id2), [mnqB.id, e2.id + ':tp']);
  const toB = await B.evaluate(([i, p]) => window.workspace.chart(i).priceToY(p), [mnqB.id, L - 5 + 8]);
  await A.evaluate(() => { window.__sent.length = 0; }); await B.evaluate(() => { window.__sent.length = 0; });
  await B.mouse.move(cbB.x + gB.box.x + gB.box.w / 2, cbB.y + gB.box.y + gB.box.h / 2); await B.mouse.down();
  await B.mouse.move(cbB.x + gB.box.x + gB.box.w / 2, cbB.y + toB, { steps: 6 }); await B.mouse.up();
  await until(async () => (await state()).orders.find(o => o.id === e2.id).planned.targetTicks === 32, 'the target at 32 ticks');
  check(JSON.stringify(strip(await sent(A, ['plan']))) === JSON.stringify([{ type: 'plan', id: e2.id, targetTicks: 32 }]) && !(await sent(B, ['plan'])).length, 'B\'s drag of the planned target: plan targetTicks 32, sent from the ticket\'s window');
  await A.bringToFront(); await A.click(tk('flattenBtn'));
  await until(async () => !(await state()).orders.length, 'flat at the end');
} catch (e) {
  fail('exception: ' + (e && e.stack || e));
} finally {
  await browser.close();
  for (const b of bridges) b.kill();
}
console.log(errors.length ? `plan smoke: ${errors.length} of ${checks} checks FAILED` : `plan smoke: all ${checks} checks passed`);
process.exit(errors.length ? 1 : 0);
