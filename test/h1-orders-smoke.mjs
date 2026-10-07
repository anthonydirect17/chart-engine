// Chart 1.15.0, the orders review's probes as a smoke (workspace, fake bridge with trading, sample data; nothing reaches a
// broker), in Chromium:
//   - clicks: 60 human-speed presses (down, 120 ms, up) on the Account panel's Close and 60 on an Orders x, while the prices
//     move and the P&L changes: every one reaches its button (the rows are never replaced under the mouse);
//   - a Shift drag after a drawing tool's first click (Trend line, Zone) sends nothing and draws nothing;
//   - the Account panel's x cancels an order on ANY instrument (Anthony): nothing disarmed, cancelled while Armed, and from a
//     window without the ticket through the ticket's window;
//   - switching a panel to 1 hour (a deeper load of the instrument's line) never blanks the other charts of it: the armed
//     5 min chart keeps its bars and order lines, the 4 hour chart its bars;
//   - a header shows the bar's change without its percent;
//   - the disarmed note in a window without the ticket gives the ticket window's reason after a reconnect.
//   npm run smoke:h1orders        (CHROMIUM_PATH=/path/to/chrome; H1ORDERS_SMOKE_PORT)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.H1ORDERS_SMOKE_PORT || 8899);
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms) {
  const end = Date.now() + (ms || 10000);
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); }
}
const control = async (what, q) => (await fetch(`http://127.0.0.1:${PORT}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
const state = r => control('state', { root: r || 'MNQ' });
const received = () => control('received');

const LAYOUTS = {
  A: { panels: [
    { id: 'a1', type: 'chart', root: 'MNQ', tf: 'm5', x: 0, y: 0, w: 6, h: 6 }, { id: 'a2', type: 'chart', root: 'MNQ', tf: 'h4', x: 6, y: 0, w: 4, h: 3 },
    { id: 'a3', type: 'chart', root: 'MNQ', tf: 'm1', x: 6, y: 3, w: 4, h: 3 },
    { id: 'tk', type: 'ticket', x: 10, y: 0, w: 2, h: 3 }, { id: 'ac', type: 'account', x: 10, y: 3, w: 2, h: 3 }] },
  B: { panels: [{ id: 'b1', type: 'chart', root: 'MNQ', tf: 'm5', x: 0, y: 0, w: 8, h: 6 }, { id: 'bac', type: 'account', x: 8, y: 0, w: 4, h: 6 }] },
};
function seed(layouts) {
  try {
    if (!localStorage.getItem('live-workspace-v1')) localStorage.setItem('live-workspace-v1', JSON.stringify({ v: 1, layouts }));
    setInterval(() => { const b = document.querySelector('.nostop-ask:not([hidden]) .nostop-send'); if (b) b.click(); }, 30);
    window.__notes = [];
    const iv = setInterval(() => { const el = document.getElementById('wsNote'); if (!el) return; clearInterval(iv); new MutationObserver(() => window.__notes.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true }); }, 20);
    // the clicks test: each click on the Account panel recorded and stopped before its handler (nothing sent), when asked
    window.__clicks = []; window.__stopClicks = false;
    window.addEventListener('click', e => {
      if (!window.__stopClicks || !e.target.closest || !e.target.closest('.ws-panel.account') || e.target.closest('.ac-tabs')) return;
      window.__clicks.push(e.target.closest('button[data-close],button[data-cancel]') ? 'button' : 'missed');
      e.stopImmediatePropagation(); e.preventDefault();
    }, true);
  } catch (e) { /* blocked */ }
}
async function openWs(ctx, layout) {
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));
  await page.goto(`http://localhost:${PORT}/live/?layout=${layout}`);
  await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
  await enterPin(page, TEST_PIN);
  await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live') && window.workspace.ticket().enabled, null, { timeout: 40000 });
  return page;
}

const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--trading', '--trade-accounts=Sim101', '--max-qty=MNQ:9,NQ:4', '--test-controls',
  '--version=0.3.8', '--data-037', '--live-rate=30', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => bridge.stdout.once('data', r));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(seed, LAYOUTS);
  const A = await openWs(ctx, 'A');
  await A.waitForTimeout(2000);
  const tk = id => A.locator(`.ws-panel[data-type="ticket"] [data-tk-id="${id}"]`);
  const armed = () => A.evaluate(() => window.workspace.ticket().armed);
  const setArmed = async on => { if (await armed() !== on) await tk('armBtn').click(); await until(async () => (await armed()) === on, 'Armed ' + on, 3000); };
  const cb = await A.locator('.ws-panel[data-id="a1"] canvas').first().boundingBox();
  const y = p => A.evaluate(pr => window.workspace.chart('a1').priceToY(pr), p);
  const L = (await state()).last;

  /* ---------------- 1.16.0 (Anthony): no text on a workspace chart (the bar's change was in its legend up to 1.15.0) */
  const chg = await A.evaluate(() => document.querySelectorAll('.ws-panel .legend, .ws-panel [id$="lgChg"]').length);
  check(chg === 0, 'no legend on any workspace chart (' + chg + ')');

  /* ---------------- long 1 with legs far away, limits to cancel */
  await tk('bStop').fill('200'); await tk('bStop').press('Enter');
  await tk('bTarget').fill('200'); await tk('bTarget').press('Enter');
  await setArmed(true);
  await tk('buyMkt').click();
  await until(async () => { const s = await state(); return (s.positions['Sim101|MNQ'] || {}).qty === 1 && s.orders.length === 2; }, 'long 1 with its legs', 8000);
  for (const d of [-30, -40]) { await A.keyboard.down('Shift'); await A.mouse.click(cb.x + cb.width * 0.4, cb.y + await y(L + d)); await A.keyboard.up('Shift'); await A.waitForTimeout(500); }
  await until(async () => (await state()).orders.length === 4, 'two buy limits', 5000);

  /* ---------------- 60 presses on Close and on an x while the prices move */
  await setArmed(false);
  await A.evaluate(() => { window.__stopClicks = true; });
  let walk = true;
  (async () => { let k = 0; while (walk) { await control('price', { root: 'MNQ', p: L + ((k++ % 8) - 4) * 0.25 }).catch(() => {}); await wait(90); } })();
  for (const [tab, sel] of [['pos', '.ws-panel.account [data-close="MNQ"]'], ['ord', '.ws-panel.account [data-cancel]']]) {
    await A.click(`.ws-panel.account .ac-tab[data-tab="${tab}"]`);
    await A.waitForTimeout(400);
    const r0 = await A.evaluate(() => { window.__clicks.length = 0; const el = document.querySelector('.ws-panel.account [data-list]'); window.__mut = 0; const mo = new MutationObserver(() => window.__mut++); mo.observe(el, { childList: true }); window.__mo = mo; return true; });
    void r0;
    for (let i = 0; i < 60; i++) {
      const b = await A.evaluate(s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, sel);
      if (!b) { fail('no button for ' + tab); break; }
      await A.mouse.move(b.x, b.y); await A.mouse.down(); await wait(120); await A.mouse.up();
      await wait(120 + Math.random() * 150);
    }
    const r = await A.evaluate(() => { window.__mo.disconnect(); return { ok: window.__clicks.filter(c => c === 'button').length, n: window.__clicks.length, mut: window.__mut }; });
    check(r.ok === 60, `${tab === 'pos' ? 'Positions Close' : 'Orders x'}: 60 of 60 presses reached the button while prices moved (${r.ok}; the list rebuilt ${r.mut} times)`);
  }
  walk = false;
  await A.evaluate(() => { window.__stopClicks = false; });
  await control('price', { root: 'MNQ', p: L });

  /* ---------------- a Shift drag after a tool's first click */
  for (const t of ['trend', 'zone']) {
    const o0 = (await received()).types.order || 0;
    await setArmed(true);
    await A.evaluate(tool => window.workspace.chart('a1').setTool(tool), t);
    await A.mouse.click(cb.x + cb.width * 0.3, cb.y + cb.height * 0.3);
    await A.keyboard.down('Shift');
    await A.mouse.move(cb.x + cb.width * 0.45, cb.y + await y(L - 20)); await A.mouse.down();
    for (let k = 1; k <= 6; k++) await A.mouse.move(cb.x + cb.width * 0.45 + k * 8, cb.y + await y(L - 20) + k * 3);
    await A.mouse.up(); await A.keyboard.up('Shift');
    await A.waitForTimeout(700);
    check(((await received()).types.order || 0) === o0 && (await A.evaluate(() => window.workspace.chart('a1').getDrawings().length)) === 0, t + ': a Shift drag after the first click sends nothing and draws nothing');
    await A.keyboard.press('Escape');
    await A.evaluate(() => window.workspace.chart('a1').setTool(null));
  }

  /* ---------------- the x cancels an order on any instrument (Anthony) */
  await control('elsewhere', { account: 'Sim101', root: 'NQ', side: 'buy', kind: 'limit', qty: 1, p: (await state('NQ')).last - 50 });
  const nqOrder = await until(async () => (await state('NQ')).orders.find(o => o.root === 'NQ'), 'an NQ order placed in NinjaTrader', 5000);
  await A.click('.ws-panel.account .ac-tab[data-tab="ord"]');
  await until(() => A.$(`.ws-panel.account [data-cancel="${nqOrder.id}"]`), 'the NQ order in the Orders tab', 5000);
  check((await A.evaluate(() => window.workspace.ticket().root)) === 'MNQ', 'the ticket is on MNQ');
  await setArmed(false);
  await A.click(`.ws-panel.account [data-cancel="${nqOrder.id}"]`);
  await A.waitForTimeout(600);
  check((await state('NQ')).orders.some(o => o.id === nqOrder.id), 'x on the NQ order with Armed off: nothing sent');
  await setArmed(true);
  await A.click(`.ws-panel.account [data-cancel="${nqOrder.id}"]`);
  await until(async () => !(await state('NQ')).orders.some(o => o.id === nqOrder.id), 'the NQ order cancelled', 5000);
  check(!(await state('NQ')).orders.some(o => o.id === nqOrder.id), 'x on the NQ order while Armed (ticket on MNQ): cancelled');
  // from a window without the ticket: forwarded to the ticket's window
  await control('elsewhere', { account: 'Sim101', root: 'NQ', side: 'buy', kind: 'limit', qty: 1, p: (await state('NQ')).last - 60 });
  const nq2 = await until(async () => (await state('NQ')).orders.find(o => o.root === 'NQ'), 'a second NQ order', 5000);
  const B = await openWs(ctx, 'B');
  await B.waitForTimeout(1500);
  check(!(await B.evaluate(() => window.workspace.ticket().held)), 'window B has no ticket');
  await B.click('.ws-panel.account .ac-tab[data-tab="ord"]');
  await until(() => B.$(`.ws-panel.account [data-cancel="${nq2.id}"]`), 'the NQ order in B', 5000);
  await B.click(`.ws-panel.account [data-cancel="${nq2.id}"]`);
  await until(async () => !(await state('NQ')).orders.some(o => o.id === nq2.id), 'the NQ order cancelled from B', 5000);
  check(!(await state('NQ')).orders.some(o => o.id === nq2.id), 'x in window B (no ticket), Armed in A: forwarded and cancelled');

  /* ---------------- a deeper load of the line never blanks the other charts of the instrument */
  await A.bringToFront();                                   // window A in front (a hidden tab draws no frames)
  await A.waitForTimeout(500);
  await A.evaluate(() => {
    window.__blank = { a1: 0, a1orders: 0, a2: 0, samples: 0 };
    const tick = () => {
      if (!window.__sampling) return;
      const c1 = window.workspace.chart('a1'), c2 = window.workspace.chart('a2');
      window.__blank.samples++;
      if (!c1.bars().length) window.__blank.a1++;
      if (!c1.orderHandles().length) window.__blank.a1orders++;
      if (!c2.bars().length) window.__blank.a2++;
      requestAnimationFrame(tick);
    };
    window.__sampling = true; requestAnimationFrame(tick);
  });
  const s0 = ((await received()).subscribes || []).length;
  await A.click('.ws-panel[data-id="a3"] .ws-view'); await A.click('#wsView [data-tf="h1"]'); await A.keyboard.press('Escape');
  await until(async () => ((await received()).subscribes || []).length > s0, 'the deeper MNQ load', 5000);
  await A.waitForFunction(() => window.workspace.views().every(v => v.type !== 'chart' || v.state === 'live'), null, { timeout: 20000 });
  await A.waitForTimeout(1500);
  const bl = await A.evaluate(() => { window.__sampling = false; return window.__blank; });
  check(bl.samples > 30 && bl.a1 === 0 && bl.a1orders === 0, `the armed 5 min chart kept its bars and order lines through the reload (${bl.samples} frames: ${bl.a1} with no bars, ${bl.a1orders} with no order lines)`);
  check(bl.a2 === 0, `the 4 hour chart kept its bars (${bl.a2} frames with none)`);

  /* ---------------- the disarmed note in window B gives the ticket window's reason */
  await control('drop');
  await A.waitForFunction(() => document.getElementById('wsConn').classList.contains('live') && window.workspace.ticket().enabled, null, { timeout: 30000 });
  await B.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 });
  await B.waitForTimeout(2500);
  const bcb = await B.locator('.ws-panel[data-id="b1"] canvas').first().boundingBox();
  const h = await until(async () => (await B.evaluate(() => window.workspace.chart('b1').orderHandles()))[0], 'order lines in window B', 8000);
  if (h) {
    await B.mouse.move(bcb.x + h.box.x + 6, bcb.y + h.box.y + 9); await B.mouse.down(); await B.mouse.up();
    const n = await until(async () => { const t = await B.evaluate(() => (document.querySelector('.ws-panel[data-id="b1"] [id$="statusMsg"]') || {}).textContent || ''); return /Armed went off: ChartBridge reconnected/.test(t) ? t : null; }, 'the reason in window B', 4000);
    check(!!n, 'window B, after the reconnect: "' + n + '" (the ticket window\'s reason)');
  }
  await setArmed(false);
  await A.click('#wsFlat');
  await until(async () => { const s = await state(); return !s.orders.length && !(s.positions['Sim101|MNQ'] || {}).qty; }, 'flat at the end', 8000);
  await ctx.close();
} finally {
  await browser.close();
  bridge.kill();
}
console.log(`\n${checks - errors.length}/${checks} checks passed`);
if (errors.length) { console.error(errors.length + ' failed'); process.exit(1); }
