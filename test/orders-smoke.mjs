// Order entry smoke test: drives the workspace's order ticket and its MNQ chart (live/index.html) in Chromium against the
// fake bridge (protocol v2). Until chart 1.21.0 it drove the single chart page's order bar (live/single.html, gone); the
// ticket is the same TradeCore with the same controls, so the checks are the same, read from the ticket (its note line
// for the page's status line, the workspace's alert and "Not sent" lines for the page's). The page's own parts went with
// it: its legend, footer, title wording, tab account (sessionStorage) and phone layout.
// Sample data only; nothing reaches a broker. Screenshots in test/out/ (and SHOTS_DIR when set).
//   npm run smoke:orders        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, unlockIfAsked } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const SHOTS = process.env.SHOTS_DIR || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const BASE = +(process.env.ORDERS_SMOKE_PORT || 8796);
const errors = [];
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
let checks = 0;
const check = (ok, m) => { checks++; if (!ok) fail(m); };
const bridges = [];

async function startBridge(port, flags) {
  const child = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(port)].concat(flags), { stdio: ['ignore', 'pipe', 'inherit'] });
  bridges.push(child);
  await new Promise(r => child.stdout.once('data', r));
  return child;
}
const control = async (port, what, q) => (await fetch(`http://127.0.0.1:${port}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
async function shot(page, name) {
  const file = path.join(out, name);
  await page.screenshot({ path: file });
  if (SHOTS) fs.copyFileSync(file, path.join(SHOTS, name));
}
async function until(fn, what, ms) {
  const end = Date.now() + (ms || 5000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) { fail('timed out: ' + what); return null; }
    await new Promise(r => setTimeout(r, 100));
  }
}
/* 1.13.0: the first order with no stop after each load asks "No stop: send anyway?" (Anthony); this smoke answers Send
   (test/plan-smoke.mjs and test/nostop-smoke.mjs check the question itself) */
/* The workspace window, read as the page was: $tk(id) is the ticket's control (the order bar's id), window.liveChart the
   chart of the ticket's instrument (the first one in the layout), __chartEl() its chart box. */
const wsShim = () => {
  window.$tk = id => document.querySelector('.tk [data-tk-id="' + id + '"]');
  window.__chartPanel = () => { const w = window.workspace; if (!w) return null; const r = (window.$tk('root') || {}).value || 'MNQ'; return w.panels().find(p => p.type === 'chart' && p.root === r) || null; };
  window.__chartEl = () => { const p = window.__chartPanel(); return p ? document.querySelector('.ws-panel[data-id="' + p.id + '"] .chart-box') : null; };
  Object.defineProperty(window, 'liveChart', { configurable: true, get() { const p = window.__chartPanel(); return p ? window.workspace.chart(p.id) : undefined; } });
};
const T = id => '.tk [data-tk-id="' + id + '"]';
const wsLive = () => { const c = document.getElementById('wsConn'); return !!c && c.classList.contains('live'); };
/* the chart's canvas, measured fresh */
const chartBox = pg => pg.evaluate(() => { const r = window.__chartEl().querySelector('canvas').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
/* the chart panel's own controls (its header: Indicators, the chips; its ARMED badge) */
const panelSel = pg => pg.evaluate(() => '.ws-panel[data-id="' + window.__chartPanel().id + '"]');
/* whose fills the chart marks */
const fillAcct = pg => pg.evaluate(() => [...new Set(window.liveChart.getMarkers().map(m => m.account))].join());
const answerNoStop = () => { setInterval(() => { const b = document.querySelector('.nostop-ask:not([hidden]) .nostop-send'); if (b) b.click(); }, 30); };
async function open(browser, port, width, height) {
  const page = await browser.newPage({ viewport: { width, height: height || 860 }, deviceScaleFactor: 2 });
  await page.addInitScript(answerNoStop);
  await page.addInitScript(wsShim);
  page.on('pageerror', e => fail(width + 'px pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fail('console: ' + m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.goto(`http://localhost:${port}/live/?layout=Orders`);   // a new layout: the default one, with the ticket on MNQ
  await unlockIfAsked(page);                                   // ChartBridge 0.3.2: the page's PIN (made-up test PIN)
  await page.waitForFunction(wsLive, null, { timeout: 15000 });
  await page.waitForFunction(() => !!window.$tk('buyMkt') && !!window.__chartEl(), null, { timeout: 15000 });
  await page.waitForTimeout(600);
  return page;
}
const status = page => page.evaluate(() => { const el = window.$tk('note'); return { text: el.textContent, cls: el.className }; });   // the ticket's note line
const noSideScroll = async (page, width) => check(await page.evaluate(() => document.documentElement.scrollWidth) <= width, width + 'px: the page scrolls sideways');

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  /* ---------------- trading on: Sim101 and DEMO-EVAL, MNQ cap 5 */
  const PORT = BASE;
  // --max-ticks-away=200: ChartBridge 0.3.7 has no distance limit unless config.txt sets one; the refusal check below uses it
  await startBridge(PORT, ['--trading', '--trade-accounts=Sim101,DEMO-EVAL', '--max-qty=MNQ:5', '--max-ticks-away=200', '--test-controls', '--test-pin=' + TEST_PIN]);
  const page = await open(browser, PORT, 1440);
  const L = Math.round((await control(PORT, 'hold', { root: 'MNQ' })).last);    // hold the sample walk at a round price
  await control(PORT, 'price', { root: 'MNQ', p: L });
  const state = () => control(PORT, 'state', { root: 'MNQ' });

  // auth happened: the bar is on, lists only the allowed accounts, Sim101 first choice, qty capped at 5, Armed off
  await until(() => page.evaluate(() => !$tk('obar').hidden && !$tk('buyMkt').disabled), 'trading enabled after auth');
  check(JSON.stringify(await page.$$eval(T('oAcct') + ' option', os => os.map(o => o.value))) === '["Sim101","DEMO-EVAL"]', 'trade accounts');
  check(await page.inputValue(T('oAcct')) === 'Sim101', 'default account Sim101');
  // one account picker (1.6.0): the order bar's, larger; no toolbar picker beside it; the chart marks its fills only
  const marks = p => p.evaluate(() => window.liveChart.getMarkers().map(m => m.side + m.qty + '@' + m.price));
  const markAccounts = fillAcct;
  check(await page.evaluate(() => [...document.querySelectorAll('[id$="-acctWrap"]')].every(e => !e.getClientRects().length) && $tk('oAcct').classList.contains('acct-main')), 'one account picker: the ticket\'s');
  check(await markAccounts(page) === 'Sim101' && (await marks(page)).length === 2, 'fills follow the order account (Sim101): ' + JSON.stringify(await marks(page)));
  await page.selectOption(T('oAcct'), 'DEMO-EVAL'); await page.waitForTimeout(200);
  check(await markAccounts(page) === 'DEMO-EVAL' && (await marks(page)).length === 2, 'switching the account switches the fills (DEMO-EVAL)');
  check(await page.evaluate(() => localStorage.getItem('live-account-v1')) === '"DEMO-EVAL"', 'account choice saved');
  await shot(page, 'orders-1440-account-picker.png');
  await page.selectOption(T('oAcct'), 'Sim101'); await page.waitForTimeout(200);
  check(await markAccounts(page) === 'Sim101', 'back to Sim101');
  // 1.10.0: Qty is a select 1 to 9; above the MNQ cap of 5 the choices are off, never hidden, and the cap shows beside it
  {
    const q = await page.evaluate(() => ({ tag: $tk('oQty').tagName, opts: [...$tk('oQty').options].map(o => o.value + (o.disabled ? '-' : '+')).join(), cap: $tk('oQtyCap').textContent, title: $tk('oQty').title }));
    check(q.tag === 'SELECT' && q.opts === '1+,2+,3+,4+,5+,6-,7-,8-,9-' && q.cap === 'max 5' && /MNQ cap 5/.test(q.title), 'qty select 1 to 9, 6 to 9 off over the cap of 5: ' + JSON.stringify(q));
  }
  check(await page.getAttribute(T('armBtn'), 'aria-checked') === 'false', 'Armed off after load');

  // Armed off: Buy, Sell and Shift+click send nothing; Flatten works while disarmed (Anthony 2026-10-01: never blocked)
  const types0 = (await control(PORT, 'received')).types;
  await page.click(T('sellMkt'));
  check((await status(page)).text === 'Armed is off: nothing was sent. Turn Armed on to trade.', 'disarmed Sell: nothing sent');
  await page.waitForTimeout(450);
  await page.click(T('buyMkt'));
  let st = await status(page);
  check(/Armed is off: nothing was sent/.test(st.text) && /warn/.test(st.cls), 'disarmed click message: ' + st.text);
  const cbox = () => chartBox(page);   // measured fresh before each use
  let box = await cbox();
  const box0 = box;
  const yAt = p => page.evaluate(pr => window.liveChart.priceToY(pr), p);
  await page.keyboard.down('Shift'); await page.mouse.click(box.x + box.width * 0.5, box.y + await yAt(L - 10)); await page.keyboard.up('Shift');
  await page.click(T('flattenBtn'));
  await page.waitForTimeout(400);
  check((await state()).orders.length === 0 && !Object.values((await state()).positions).some(p => p.qty), 'nothing traded while disarmed');
  {
    const t1 = (await control(PORT, 'received')).types, n = k => (t1[k] || 0) - (types0[k] || 0);
    const st1 = await status(page);
    check(n('order') === 0 && n('change') === 0 && n('flatten') === 1 && st1.text === 'Flatten sent for Sim101 MNQ: cancel its orders, close the position at market.',
      'disarmed: no order sent, Flatten sent (it works while disarmed): ' + JSON.stringify({ order: n('order'), flatten: n('flatten'), note: st1.text }));
  }
  await shot(page, 'orders-1440-disarmed.png');

  // arm, bracket 40 / 80 ticks, buy 2 at market
  await page.click(T('armBtn'));
  check(await page.getAttribute(T('armBtn'), 'aria-checked') === 'true', 'armed');
  check((await page.title()).startsWith('ARMED'), 'title shows ARMED');
  check(await page.isVisible(await panelSel(page) + ' [id$="-bArmed"]'), 'ARMED badge on the chart');
  await page.fill(T('bStop'), '40'); await page.press(T('bStop'), 'Tab');
  await page.fill(T('bTarget'), '80'); await page.press(T('bTarget'), 'Tab');
  await page.selectOption(T('oQty'), '2');
  await page.click(T('buyMkt'));
  await until(async () => (await page.textContent(T('oPos'))).startsWith('LONG 2'), 'position LONG 2 in the bar');
  let s = await until(async () => { const x = await state(); return x.orders.length === 2 ? x : null; }, 'two bracket legs');
  const stopLeg = s && s.orders.find(o => o.role === 'stop'), targetLeg = s && s.orders.find(o => o.role === 'target');
  check(stopLeg && stopLeg.price === L - 10 && stopLeg.qty === 2 && stopLeg.side === 'sell', 'stop leg at L - 10: ' + JSON.stringify(stopLeg));
  check(targetLeg && targetLeg.price === L + 20 && targetLeg.oco === stopLeg.oco, 'target leg at L + 20, same OCO');
  check(JSON.parse(await page.evaluate(() => localStorage.getItem('live-bracket-v1'))).MNQ.stop === 40, 'bracket remembered per root');
  await until(() => page.evaluate(() => window.liveChart.getOrders().length === 2 && !!window.liveChart.getPosition()), 'order and position lines on the chart');
  await page.waitForTimeout(300);
  box = await chartBox(page);
  check(Math.abs(box.y - box0.y) < 1 && Math.abs(box.height - box0.height) < 1, 'the chart did not move when the position changed');
  await shot(page, 'orders-1440-bracket.png');

  // the live trade always stays (1.6.0, Anthony): Hide all and the Fills switch hide past fills, never the open
  // position, its entry fill, the working stop and target or the position line
  {
    const live = () => page.evaluate(() => ({ pos: window.liveChart.getPosition(), orders: window.liveChart.getOrders().length, marks: window.liveChart.getMarkers().map(m => m.side + m.qty) }));
    const before = await live();
    check(before.marks.length === 3 && before.marks.includes('buy2'), 'past fills and the entry marked: ' + JSON.stringify(before.marks));
    const PS = await panelSel(page);
    await page.click(PS + ' .ind-btn'); await page.click(PS + ' [id$="-indHideAll"]'); await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    let after = await live();
    const layers = await page.evaluate(() => window.liveChart.getLayers());
    check(!layers.volume && !layers.vwap && !layers.levels && !layers.ib, 'Hide all hid the indicators');
    check(after.pos && after.pos.qty === 2 && after.orders === 2 && JSON.stringify(after.marks) === '["buy2"]', 'Hide all keeps the open position, both legs and its entry fill, and drops the past fills: ' + JSON.stringify(after));
    await shot(page, 'orders-1440-hide-all-open-position.png');
    await page.click(PS + ' .ind-btn'); await page.click(PS + ' [id$="-indHideAll"]'); await page.keyboard.press('Escape');   // Restore
    const fillsSw = async () => { await page.click(PS + ' .ind-chips .ind-chip[data-id="fills"]'); await page.click('body .chip-pop [data-act="popsw"]'); await page.keyboard.press('Escape'); };   // 1.14.0: the chip's popover switch
    await fillsSw();                                                                                      // the Fills chip alone
    after = await live();
    check(after.pos && after.orders === 2 && JSON.stringify(after.marks) === '["buy2"]', 'Fills hidden: the entry fill, position and legs stay: ' + JSON.stringify(after));
    await fillsSw();
    check((await live()).marks.length === 3, 'Fills shown again');
  }

  // drag the target label up; the live tag follows; release sends change
  box = await cbox();
  let h = await page.evaluate(id => window.liveChart.orderHandles().find(x => x.id === id), targetLeg.id);
  const gx = box.x + h.box.x + h.box.w / 2, gy = box.y + h.box.y + h.box.h / 2;
  await page.mouse.move(gx, gy); await page.mouse.down();
  await page.mouse.move(gx, gy - 30, { steps: 6 });
  await page.waitForTimeout(150);
  await shot(page, 'orders-1440-drag.png');
  await page.mouse.up();
  s = await until(async () => { const x = await state(); const t = x.orders.find(o => o.id === targetLeg.id); return t && t.price > L + 20 ? x : null; }, 'target moved up');
  const moved = s && s.orders.find(o => o.id === targetLeg.id).price;
  check(moved && Math.abs(moved / 0.25 - Math.round(moved / 0.25)) < 1e-9, 'moved target on the tick grid: ' + moved);
  await until(() => page.evaluate(p => window.liveChart.getOrders().some(o => o.role === 'target' && o.price === p), moved), 'chart shows the moved target');

  // Escape during a drag reverts: nothing sent
  box = await cbox();
  h = await page.evaluate(id => window.liveChart.orderHandles().find(x => x.id === id), stopLeg.id);
  await page.mouse.move(box.x + h.box.x + 8, box.y + h.box.y + 9); await page.mouse.down();
  await page.mouse.move(box.x + h.box.x + 8, box.y + h.box.y + 49, { steps: 4 });
  await page.keyboard.press('Escape'); await page.mouse.up();
  await page.waitForTimeout(400);
  check((await state()).orders.find(o => o.id === stopLeg.id).price === L - 10, 'Escape reverted the stop drag');

  // a drag released outside the plot (over the toolbar) is cancelled: nothing sent, the line goes back (review N4)
  box = await cbox();
  h = await page.evaluate(id => window.liveChart.orderHandles().find(x => x.id === id), targetLeg.id);
  const tagY0 = h.box.y, changes0 = (await control(PORT, 'received')).types.change || 0;
  await page.mouse.move(box.x + h.box.x + h.box.w / 2, box.y + h.box.y + h.box.h / 2); await page.mouse.down();
  await page.mouse.move(box.x + h.box.x + h.box.w / 2, box.y + h.box.y - 40, { steps: 4 });
  await page.mouse.move(box.x + h.box.x + h.box.w / 2, 20, { steps: 6 });                // up over the toolbar
  await page.mouse.up();
  await page.waitForTimeout(600);
  const changes1 = (await control(PORT, 'received')).types.change || 0;
  check(changes1 === changes0 && (await state()).orders.find(o => o.id === targetLeg.id).price === moved, 'drag released over the toolbar sent nothing (' + (changes1 - changes0) + ' change messages)');
  check(await page.evaluate(([id, p]) => window.liveChart.getOrders().find(o => o.id === id).price === p, [targetLeg.id, moved]), 'the chart still shows the target at its price');
  h = await page.evaluate(id => window.liveChart.orderHandles().find(x => x.id === id), targetLeg.id);
  check(Math.abs(h.box.y - tagY0) < 2, 'the target label went back: ' + tagY0 + ' -> ' + h.box.y);
  check(!/^Moving order/.test((await status(page)).text), 'no "Moving order" message');

  // cancel the stop with its x: the OCO pair goes together
  box = await cbox();
  h = await page.evaluate(id => window.liveChart.orderHandles().find(x => x.id === id), stopLeg.id);
  await page.mouse.click(box.x + h.xbox.x + h.xbox.w / 2, box.y + h.xbox.y + h.xbox.h / 2);
  await until(async () => (await state()).orders.length === 0, 'x cancelled the stop and its target');
  await until(() => page.evaluate(() => window.liveChart.getOrders().length === 0), 'order lines gone');

  // Shift+click places a limit (below the market, Buy side): preview first, then the click
  box = await cbox();
  const px = box.x + box.width * 0.45; let py = box.y + await yAt(L - 15);
  await page.mouse.click(px, py);                                              // a plain click places nothing
  await page.mouse.move(px, py); await page.mouse.down(); await page.mouse.move(px + 60, py + 10, { steps: 5 }); await page.waitForTimeout(150); await page.mouse.up();   // nor does a drag (held still: no throw)
  await page.keyboard.down('Shift'); await page.mouse.move(px + 60, py + 10); await page.mouse.down(); await page.mouse.move(px, py, { steps: 5 }); await page.waitForTimeout(150); await page.mouse.up();   // nor a Shift+drag
  await page.keyboard.up('Shift');
  await page.waitForTimeout(500);
  check((await state()).orders.length === 0, 'plain click, drag or Shift+drag placed an order');
  await page.evaluate(() => window.liveChart.goLive());
  for (let k = 0, prev = -1, calm = 0; k < 40 && calm < 3; k++) { const y = await yAt(L - 15); calm = Math.abs(y - prev) < 0.25 ? calm + 1 : 0; prev = y; await page.waitForTimeout(200); }   // the view has settled
  box = await cbox(); py = box.y + await yAt(L - 15);                                              // the view moved: find the price again
  await page.keyboard.down('Shift');
  await page.mouse.move(px, py + 1); await page.mouse.move(px, py);
  await page.waitForTimeout(200);
  await shot(page, 'orders-1440-preview.png');
  await page.mouse.click(px, py);
  await page.keyboard.up('Shift');
  s = await until(async () => { const x = await state(); return x.orders.length === 1 ? x : null; }, 'Shift+click placed an order');
  const lim = s && s.orders[0];
  check(lim && lim.side === 'buy' && lim.kind === 'limit' && lim.qty === 2 && Math.abs(lim.price - (L - 15)) <= 0.5, 'Shift+click buy limit near L - 15: ' + JSON.stringify(lim));
  check(lim && lim.cid && lim.cid.startsWith('p'), 'order carries the page cid');

  // Sell side below the market: a sell stop (1.10.0: Shift + right click sells). Long 2 with a 40 / 80 bracket set: the
  // page sends no bracket on this reducing order (ChartBridge would refuse one), so it is accepted.
  box = await cbox();
  await page.keyboard.down('Shift'); await page.mouse.click(px, box.y + await yAt(L - 5), { button: 'right' }); await page.keyboard.up('Shift');
  s = await until(async () => { const x = await state(); return x.orders.length === 2 ? x : null; }, 'Shift+click sell stop');
  const sst = s && s.orders.find(o => o.side === 'sell');
  check(sst && sst.kind === 'stop', 'sell below the market is a stop: ' + JSON.stringify(sst));
  await page.waitForTimeout(300);
  await shot(page, 'orders-1440-working.png');

  // flatten: every order on Sim101 MNQ cancelled and the position closed
  await page.click(T('flattenBtn'));
  await until(async () => { const x = await state(); return x.orders.length === 0 && !Object.values(x.positions).some(p => p.qty); }, 'flatten');
  await until(async () => (await page.textContent(T('oPos'))) === 'Flat', 'bar shows Flat');
  await until(() => page.evaluate(() => !window.liveChart.getPosition() && window.liveChart.getOrders().length === 0), 'position and orders gone from the chart');

  // a 2-lot limit that fills in two pieces gets two stop and target pairs; the bar sums them up (item 4)
  await page.selectOption(T('oQty'), '2');
  await page.evaluate(() => window.liveChart.goLive());
  for (let k = 0, prev = -1, calm = 0; k < 40 && calm < 3; k++) { const y = await yAt(L - 3); calm = Math.abs(y - prev) < 0.25 ? calm + 1 : 0; prev = y; await page.waitForTimeout(200); }
  box = await cbox();
  await page.keyboard.down('Shift'); await page.mouse.click(px, box.y + await yAt(L - 3)); await page.keyboard.up('Shift');
  s = await until(async () => { const x = await state(); return x.orders.length === 1 ? x : null; }, 'buy limit for the pieces test');
  const lim3 = s && s.orders[0];
  check(lim3 && lim3.kind === 'limit' && lim3.qty === 2, 'buy limit 2: ' + JSON.stringify(lim3));
  await control(PORT, 'price', { root: 'MNQ', p: lim3.price });                // touches fill 1 at a time
  s = await until(async () => { const x = await state(); return x.orders.filter(o => o.role === 'stop').length === 2 ? x : null; }, 'two stop legs, one per fill');
  await control(PORT, 'price', { root: 'MNQ', p: lim3.price + 1 });           // off the limit, inside the bracket
  const legsText = await until(async () => { const t = await page.textContent(T('oLegs')); return t === 'Stop 2/2 · Target 2/2' ? t : null; }, 'leg summary 2 of 2');
  check(!!legsText, 'leg summary: ' + await page.textContent(T('oLegs')));
  check(!(await page.getAttribute(T('oLegs'), 'class') || '').includes('uncovered'), 'covered: not in the error color');
  await page.waitForTimeout(300);
  await shot(page, 'orders-1440-legs.png');
  // close 1 by hand: long 1 with two pairs working, more than the position: the warning color and why
  await page.selectOption(T('oQty'), '1');
  await page.click(T('sellMkt'));
  await until(async () => (await page.textContent(T('oPos'))).startsWith('LONG 1'), 'long 1 after selling 1');
  const overText = await until(async () => { const t = await page.textContent(T('oLegs')); return t === 'Stop 2/1 · Target 2/1 · over the position' ? t : null; }, 'leg summary over the position');
  check(!!overText, 'over the position: ' + await page.textContent(T('oLegs')));
  check((await page.getAttribute(T('oLegs'), 'class') || '').includes('over'), 'over: warning class');
  check(await page.evaluate(() => getComputedStyle($tk('oLegs')).color) === 'rgb(224, 180, 90)', 'over: warning color');
  await shot(page, 'orders-1440-legs-over.png');
  // buy 1 back with no bracket (0 / 0), then cancel one pair: stops 1 of 2, the error color
  await page.fill(T('bStop'), '0'); await page.press(T('bStop'), 'Tab');
  await page.fill(T('bTarget'), '0'); await page.press(T('bTarget'), 'Tab');
  await page.click(T('buyMkt'));
  await until(async () => (await page.textContent(T('oLegs'))) === 'Stop 2/2 · Target 2/2', 'long 2 again, two pairs');
  s = await state();
  const stopLegs = s.orders.filter(o => o.role === 'stop');
  box = await cbox();
  h = await page.evaluate(id => window.liveChart.orderHandles().find(x => x.id === id), stopLegs[0].id);
  await page.mouse.click(box.x + h.xbox.x + h.xbox.w / 2, box.y + h.xbox.y + h.xbox.h / 2);   // cancels that pair
  await until(async () => (await page.textContent(T('oLegs'))) === 'NO STOP on 1 · Target 1/2', 'leg summary after one pair cancelled');
  const cls = await page.getAttribute(T('oLegs'), 'class') || '';
  check(cls.includes('uncovered'), 'stops short: the uncovered class, got "' + cls + '"');
  const col = await page.evaluate(() => getComputedStyle($tk('oLegs')).color);
  check(col === 'rgb(255, 122, 122)', 'stops short: the loss red of the NO STOP tag (F2 review), got ' + col);
  await shot(page, 'orders-1440-legs-short.png');
  await page.fill(T('bStop'), '40'); await page.press(T('bStop'), 'Tab');
  await page.fill(T('bTarget'), '80'); await page.press(T('bTarget'), 'Tab');
  await page.click(T('flattenBtn'));
  await until(async () => (await page.textContent(T('oPos'))) === 'Flat', 'flat after the pieces test');
  check((await page.textContent(T('oLegs'))) === '', 'no leg summary when flat');
  await control(PORT, 'price', { root: 'MNQ', p: L });

  // rejects: qty over the cap (stopped in the page: a qty remembered over a lower cap stays picked and is refused), and a
  // ChartBridge refusal (more than 200 ticks away, maxTicksAway = 200)
  await page.evaluate(() => { const q = $tk('oQty'); q.value = '9'; q.dispatchEvent(new Event('change')); });
  await page.click(T('buyMkt'));
  st = await status(page);
  check(/Not sent: Qty 9 is over the MNQ cap of 5/.test(st.text) && /error/.test(st.cls), 'over-cap qty refused: ' + st.text);
  await shot(page, 'orders-1440-reject-qty.png');
  await page.selectOption(T('oQty'), '1');
  for (let k = 0; k < 20 && (await page.evaluate(() => window.liveChart.yToPrice(12))) < L + 60; k++) {
    await page.mouse.move(box.x + box.width - 30, box.y + box.height * 0.5); await page.mouse.wheel(0, 240); await page.waitForTimeout(60);
  }
  box = await cbox();
  await page.keyboard.down('Shift'); await page.mouse.click(px, box.y + 14); await page.keyboard.up('Shift');
  await until(async () => /^Refused by ChartBridge: .* ticks from the last price/.test((await status(page)).text), 'ChartBridge reject shown');
  st = await status(page);
  check(/error/.test(st.cls), 'reject in the error color');
  await shot(page, 'orders-1440-reject.png');
  check((await state()).orders.length === 0, 'rejected order not working');
  { const cb = await chartBox(page); await page.mouse.dblclick(cb.x + cb.width - 30, cb.y + cb.height * 0.45); }   // price axis back to auto-fit

  // an error-level status from ChartBridge stays on screen until dismissed
  await control(PORT, 'status', { level: 'error', text: 'MNQ Sim101: bracket stop rejected; the position may have NO STOP' });
  await until(() => page.isVisible('#wsAlert'), 'error alert shown');
  await page.waitForTimeout(7000);
  check(await page.isVisible('#wsAlert') && /NO STOP/.test(await page.textContent('#wsAlertText')), 'error alert still shown after 7 s');
  await shot(page, 'orders-1440-alert.png');
  await page.click('#wsAlertClose');
  check(await page.isHidden('#wsAlert'), 'alert dismissed');

  // reload: Armed is off again (and the PIN is asked again: the unlock lives in memory only)
  await page.reload();
  check(await unlockIfAsked(page), 'reload asks for the PIN again');
  await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 15000 });
  await until(() => page.evaluate(() => !$tk('buyMkt').disabled), 'trading after reload');
  check(await page.getAttribute(T('armBtn'), 'aria-checked') === 'false', 'Armed off after reload');
  check(!(await page.title()).startsWith('ARMED'), 'title not ARMED after reload');
  check(await page.inputValue(T('bStop')) === '40', 'bracket kept after reload');
  await noSideScroll(page, 1440);

  /* ---------------- 1.10.0 order bar essentials: bracket presets, qty select, B/E, Shift+click by mouse button */
  {
    const reloadPage = async () => {
      await page.reload(); await unlockIfAsked(page);
      await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 15000 });
      await until(() => page.evaluate(() => !$tk('buyMkt').disabled), 'trading after reload');
    };
    const saved = () => page.evaluate(() => ({ br: JSON.parse(localStorage.getItem('live-bracket-v1')).MNQ, sel: JSON.parse(localStorage.getItem('live-bracket-sel-v1') || '{}').MNQ, presets: JSON.parse(localStorage.getItem('live-bracket-presets-v1') || 'null') }));
    const boxes = async () => [await page.inputValue(T('bPreset')), await page.inputValue(T('bStop')), await page.inputValue(T('bTarget'))].join(' ');
    const commit = async (id, v) => { await page.fill(id, v); await page.press(id, 'Tab'); };
    const received = async () => (await control(PORT, 'received')).types.change || 0;

    // qty: the pick is remembered per root
    await page.selectOption(T('oQty'), '3');
    check(JSON.parse(await page.evaluate(() => localStorage.getItem('live-qty-v1'))).MNQ === 3, '1.10.0 qty 3 saved for MNQ');
    await reloadPage();
    check(await page.inputValue(T('oQty')) === '3', '1.10.0 qty 3 back after a reload');
    await page.selectOption(T('oQty'), '1');

    // presets: a ratio sets the target and stays linked to the stop; typing the target makes it Custom
    check(JSON.stringify(await page.$$eval(T('bPreset') + ' option', os => os.map(o => o.value))) === '["custom","1:1","1:1.5","1:2","save"]', '1.10.0 preset choices: ' + JSON.stringify(await page.$$eval(T('bPreset') + ' option', os => os.map(o => o.value))));
    await commit(T('bStop'), '12');
    check(await boxes() === 'custom 12 80', '1.10.0 Custom 12 / 80: ' + await boxes());
    await page.selectOption(T('bPreset'), '1:2');
    check(await boxes() === '1:2 12 24', '1.10.0 1:2 sets the target to 24: ' + await boxes());
    await page.fill(T('bStop'), '15');                                          // typing, not committed yet: linked at once
    check(await boxes() === '1:2 15 30', '1.10.0 the stop typed, the target follows: ' + await boxes());
    await page.press(T('bStop'), 'Tab');
    let sv = await saved();
    check(sv.br.stop === 15 && sv.br.target === 30 && sv.sel === '1:2', '1.10.0 1:2 saved: ' + JSON.stringify(sv));
    await page.selectOption(T('bPreset'), '1:1.5');
    check(await boxes() === '1:1.5 15 23', '1.10.0 1:1.5 of 15 is round(22.5) = 23: ' + await boxes());
    await commit(T('bTarget'), '40');
    check(await boxes() === 'custom 15 40', '1.10.0 typing the target makes it Custom: ' + await boxes());
    // Save current... with a name; it is picked, and survives a reload
    await page.selectOption(T('bPreset'), 'save');
    check(await page.isVisible(T('bSaveBox')) && await page.inputValue(T('bSaveName')) === '15/40t', '1.10.0 the save box opens with the numbers as the name');
    await page.fill(T('bSaveName'), 'Scalp'); await page.press(T('bSaveName'), 'Enter');
    sv = await saved();
    check(await page.isHidden(T('bSaveBox')) && await boxes() === 'p:Scalp 15 40' && JSON.stringify(sv.presets) === '[{"name":"Scalp","stop":15,"target":40}]', '1.10.0 preset Scalp saved and picked: ' + await boxes() + ' ' + JSON.stringify(sv.presets));
    await commit(T('bStop'), '20'); await commit(T('bTarget'), '60');               // Custom again, then back to the preset
    check(await boxes() === 'custom 20 60', '1.10.0 typing the stop of a saved preset makes it Custom: ' + await boxes());
    await page.selectOption(T('bPreset'), 'p:Scalp');
    check(await boxes() === 'p:Scalp 15 40', '1.10.0 the preset sets stop and target: ' + await boxes());
    await reloadPage();
    check(await boxes() === 'p:Scalp 15 40', '1.10.0 the preset pick survives a reload: ' + await boxes());
    await page.selectOption(T('bPreset'), '1:2');
    await reloadPage();
    check(await boxes() === '1:2 15 30', '1.10.0 the ratio pick survives a reload: ' + await boxes());
    // points: shown and typed in points, stored in ticks, rounded to the nearest tick on commit
    await page.click(T('bUnit') + ' >> text="pt"');
    check(await boxes() === '1:2 3.75 7.5', '1.10.0 in points: ' + await boxes());
    await commit(T('bStop'), '2.6');                                            // 10.4 ticks: rounds to 10
    sv = await saved();
    check(await boxes() === '1:2 2.5 5' && sv.br.stop === 10 && sv.br.target === 20, '1.10.0 2.6 pt commits as 10 ticks, the target linked: ' + await boxes() + ' ' + JSON.stringify(sv.br));
    await reloadPage();
    check(await boxes() === '1:2 2.5 5', '1.10.0 the unit survives a reload: ' + await boxes());
    await page.click(T('bUnit') + ' >> text="t"');
    check(await boxes() === '1:2 10 20', '1.10.0 back in ticks: ' + await boxes());
    // delete the saved preset; the stop and target stay
    await page.selectOption(T('bPreset'), 'p:Scalp');
    await page.selectOption(T('bPreset'), 'delete');
    sv = await saved();
    check(await boxes() === 'custom 15 40' && JSON.stringify(sv.presets) === '[]', '1.10.0 preset deleted: ' + await boxes() + ' ' + JSON.stringify(sv.presets));
    await shot(page, 'orders-1440-presets.png');
    await commit(T('bStop'), '40'); await commit(T('bTarget'), '80');

    // Shift+click by mouse button, armed: Shift + left buys, Shift + right and Ctrl + left sell; Ctrl and Shift together
    // send nothing
    await page.click(T('armBtn'));
    await control(PORT, 'price', { root: 'MNQ', p: L });
    await page.evaluate(() => window.liveChart.goLive());
    for (let k = 0, prev = -1, calm = 0; k < 40 && calm < 3; k++) { const y = await yAt(L - 5); calm = Math.abs(y - prev) < 0.25 ? calm + 1 : 0; prev = y; await page.waitForTimeout(200); }
    const clickAt = async (price, keys, button) => {
      box = await cbox();
      for (const k of keys) await page.keyboard.down(k);
      await page.mouse.click(box.x + box.width * 0.45, box.y + await yAt(price), { button: button || 'left' });
      for (const k of keys) await page.keyboard.up(k);
    };
    const newest = async n => { const x = await until(async () => { const v = await state(); return v.orders.length === n ? v : null; }, n + ' working orders'); return x ? x.orders[x.orders.length - 1] : null; };
    await clickAt(L - 5, ['Shift']);
    let o = await newest(1);
    check(o && o.side === 'buy' && o.kind === 'limit' && Math.abs(o.price - (L - 5)) <= 0.5, '1.10.0 Shift + left click buys (a limit below): ' + JSON.stringify(o));
    await page.waitForTimeout(450);
    await clickAt(L + 5, ['Shift'], 'right');
    o = await newest(2);
    check(o && o.side === 'sell' && o.kind === 'limit' && Math.abs(o.price - (L + 5)) <= 0.5, '1.10.0 Shift + right click sells (a limit above): ' + JSON.stringify(o));
    await page.waitForTimeout(450);
    await clickAt(L - 6, ['Control']);
    o = await newest(3);
    check(o && o.side === 'sell' && o.kind === 'stop' && Math.abs(o.price - (L - 6)) <= 0.5, '1.10.0 Ctrl + left click sells (a stop below): ' + JSON.stringify(o));
    await page.waitForTimeout(450);
    await clickAt(L - 7, ['Control', 'Shift']);
    await page.waitForTimeout(500);
    const chartNote = () => page.evaluate(() => window.__chartEl().closest('.chart-live').querySelector('[id$="-statusMsg"]').textContent);   // the chart's own note line
    check((await state()).orders.length === 3 && /^Ctrl and Shift together: nothing was sent/.test(await chartNote()), '1.10.0 Ctrl + Shift: nothing sent: ' + await chartNote());
    await page.click(T('cancelAllBtn'));
    await until(async () => (await state()).orders.length === 0, '1.10.0 the three orders cancelled');
    // no browser menu anywhere on the chart (Anthony 2026-10-01): plot (right click with or without Shift; disarmed, so
    // nothing is placed), price axis, delta pane, time axis; the order bar and the rest of the page keep it
    await page.click(T('armBtn'));
    await page.evaluate(() => { window.__cm = []; window.addEventListener('contextmenu', e => { window.__cm.push(e.defaultPrevented); }); });
    box = await cbox();
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.3, { button: 'right' });
    await page.keyboard.down('Shift'); await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.35, { button: 'right' }); await page.keyboard.up('Shift');
    await page.mouse.click(box.x + box.width - 20, box.y + box.height * 0.3, { button: 'right' });   // the price axis
    const dp = await page.evaluate(() => window.liveChart.deltaPane());
    check(dp.on && dp.height > 20, '1.10.0 the delta pane is on for the menu check: ' + JSON.stringify({ on: dp.on, top: dp.top, height: dp.height }));
    await page.mouse.click(box.x + box.width * 0.4, box.y + dp.top + dp.height / 2, { button: 'right' });   // the delta pane
    await page.mouse.click(box.x + box.width - 20, box.y + dp.top + dp.height / 2, { button: 'right' });    // the delta pane's axis
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height - 6, { button: 'right' });           // the time axis
    await page.click(T('oPos'), { button: 'right' });                                                     // the order bar
    await page.click('#wsConn', { button: 'right' });                                                   // the page (the workspace's top bar)
    const cm = await page.evaluate(() => window.__cm);
    check(JSON.stringify(cm) === '[true,true,true,true,true,true,false,false]', '1.10.0 no browser menu anywhere on the chart, the menu on the order bar and the page: ' + JSON.stringify(cm));
    check((await state()).orders.length === 0, '1.10.0 disarmed right clicks placed nothing');
    await page.click(T('armBtn'));

    // B/E: off while flat; one change per ChartBridge stop leg, to the average price rounded up a tick (long), only past it
    check(await page.isDisabled(T('beBtn')), '1.10.0 B/E off while flat');
    await commit(T('bStop'), '40'); await commit(T('bTarget'), '0');
    await page.click(T('buyMkt'));
    await until(async () => (await page.textContent(T('oPos'))).startsWith('LONG 1') && (await state()).orders.length === 1, '1.10.0 long 1 with a stop');
    await control(PORT, 'price', { root: 'MNQ', p: L + 0.25 });
    await page.waitForTimeout(450);
    await page.click(T('buyMkt'));                                              // a second fill a tick higher: average L + 0.125
    await until(async () => (await page.textContent(T('oPos'))).startsWith('LONG 2') && (await state()).orders.filter(x => x.role === 'stop').length === 2, '1.10.0 long 2, two stop legs');
    await control(PORT, 'elsewhere', { account: 'Sim101', root: 'MNQ', side: 'sell', kind: 'stop', qty: 1, p: L - 20 });   // a stop placed in NinjaTrader
    await until(async () => (await state()).orders.length === 3, '1.10.0 the NinjaTrader stop is working');
    await until(() => page.evaluate(() => !$tk('beBtn').disabled), '1.10.0 B/E on with a position and a stop leg');
    const be = L + 0.25;
    // underwater and at break-even: nothing sent
    for (const last of [L - 1, be]) {
      await control(PORT, 'price', { root: 'MNQ', p: last });
      await page.waitForTimeout(450);
      const c0 = await received();
      await page.click(T('beBtn'));
      await page.waitForTimeout(400);
      check(await received() === c0 && (await status(page)).text === 'Price is not past break-even yet; the stop stays.', '1.10.0 B/E with the last price at ' + last + ' sends nothing: ' + (await status(page)).text);
    }
    await shot(page, 'orders-1440-be-not-yet.png');
    await control(PORT, 'price', { root: 'MNQ', p: L + 2 });
    await page.waitForTimeout(450);
    const c0 = await received();
    await page.evaluate(() => { const el = $tk('note'); window.__msgs = []; new MutationObserver(() => window.__msgs.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true }); });
    await page.click(T('beBtn'));
    s = await until(async () => { const x = await state(); return x.orders.filter(q => q.role === 'stop' && q.price === be).length === 2 ? x : null; }, '1.10.0 both stop legs at break-even');
    check(await received() === c0 + 2, '1.10.0 B/E sent one change per stop leg: ' + (await received() - c0));
    const other = s && s.orders.find(q => q.role === 'other');
    check(other && other.price === L - 20, '1.10.0 the NinjaTrader stop was not touched: ' + JSON.stringify(other));
    const msgs = await page.evaluate(() => window.__msgs);
    check(msgs.some(t => t === 'Moving 2 stops to break-even ' + be.toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' · Sim101. 1 stop placed in NinjaTrader left alone.'), '1.10.0 the B/E note: ' + JSON.stringify(msgs));
    await page.waitForTimeout(450);
    // a second click: the legs are at break-even already, nothing more is sent
    const c1 = await received();
    await page.click(T('beBtn'));
    await page.waitForTimeout(400);
    check(await received() === c1, '1.10.0 a second B/E sends nothing: ' + (await status(page)).text);
    await shot(page, 'orders-1440-be.png');

    // the ticket at 1920, 1440 and 1280 (screenshots; the single chart page's order bar was one line, the ticket is a panel)
    for (const w of [1920, 1440, 1280]) {
      await page.setViewportSize({ width: w, height: 860 });
      await page.waitForTimeout(300);
      await page.locator(T('obar')).screenshot({ path: path.join(out, 'orders-' + w + '-ticket.png') });
      if (SHOTS) fs.copyFileSync(path.join(out, 'orders-' + w + '-ticket.png'), path.join(SHOTS, 'orders-' + w + '-ticket.png'));
    }
    await page.setViewportSize({ width: 1440, height: 860 });
    await page.click(T('flattenBtn'));
    await until(async () => (await page.textContent(T('oPos'))) === 'Flat' && (await state()).orders.length === 0, '1.10.0 flat after the B/E test');
    await page.click(T('armBtn'));
    await control(PORT, 'price', { root: 'MNQ', p: L });
    await commit(T('bStop'), '40'); await commit(T('bTarget'), '80');
  }

  // (until 1.21.0 the single chart page was checked at 400 px here; the workspace is not laid out for a phone)
  await page.close();

  /* ---------------- 1.6.1 (Anthony's ruling 2026-09-30): the order account after a reload or a dropped connection.
     The account last picked on this PC when ChartBridge allows it, else Sim101 with a note; Armed always off; every
     order path sends for the account shown. (Until 1.21.0 the single chart page also kept each tab's own account, with
     a ring on its picker and its own notes; the workspace has one order ticket, on the last account picked.) */
  {
    const P5 = PORT + 5;
    // MNQ cap 40: the cap counts working orders, and the Cancel all probes below keep 30 working while Anthony buys
    await startBridge(P5, ['--trading', '--trade-accounts=Sim101,DEMO-EVAL', '--max-qty=MNQ:40', '--test-controls', '--test-pin=' + TEST_PIN]);
    const L5 = Math.round((await control(P5, 'hold', { root: 'MNQ' })).last);
    await control(P5, 'price', { root: 'MNQ', p: L5 });
    const state5 = () => control(P5, 'state', { root: 'MNQ' });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 1 });
    await ctx.addInitScript(answerNoStop);
    await ctx.addInitScript(wsShim);
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    // every message a page sends, and the account of every order ChartBridge reports to it
    await ctx.addInitScript(() => {
      window.__sent = []; window.__orderAcct = {}; window.__rejects = []; window.__statusSeen = [];
      const iv = setInterval(() => { const el = window.$tk && window.$tk('note'); if (!el) return; clearInterval(iv); new MutationObserver(() => window.__statusSeen.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true }); }, 20);
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (d) { try { window.__sent.push(Object.assign(JSON.parse(d), { __at: performance.now() })); } catch (e) { /* not JSON */ } return send.call(this, d); };
      const d = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
      Object.defineProperty(WebSocket.prototype, 'onmessage', { configurable: true, get() { return d.get.call(this); }, set(fn) {
        window.__inject = m => fn({ data: JSON.stringify(m) });   // a ChartBridge message made up by the test (R17)
        d.set.call(this, ev => {
          try {
            const m = JSON.parse(ev.data);
            if (m.type === 'order' && m.id) window.__orderAcct[m.id] = m.account;
            if (m.type === 'reject') window.__rejects.push(m.reason);
            if (m.type === 'trading' && m.enabled) window.__lastTrading = m;
            if (m.type === 'trading') window.__inject = x => fn({ data: JSON.stringify(x) });   // the order connection's (a workspace has one per instrument too)
            if (m.type === 'trading' && window.__holdTrading) return;
          } catch (e) { /* not JSON */ }
          return fn(ev);   // __holdTrading: the sign-in answer held back, so trading stays off after a reconnect
        });
      } });
    });
    const tradingOn = pg => until(() => pg.evaluate(() => !!window.$tk && !!$tk('buyMkt') && !$tk('buyMkt').disabled && document.getElementById('wsConn').classList.contains('live')), 'trading on', 15000);
    const openTab = async () => {
      const pg = await ctx.newPage();
      pg.on('pageerror', e => fail('1.6.1 pageerror: ' + e.message));
      pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|WebSocket connection/.test(m.text())) fail('1.6.1 console: ' + m.text()); });
      await pg.goto(`http://localhost:${P5}/live/?layout=Orders`);
      await unlockIfAsked(pg);
      await tradingOn(pg);
      return pg;
    };
    const reloadTab = async pg => { await pg.reload(); await unlockIfAsked(pg); await tradingOn(pg); };
    const acct = pg => pg.evaluate(() => { const s = $tk('oAcct'), n = $tk('oAcctNote');
      return { shown: s.value, options: [...s.options].map(o => o.value), armed: $tk('armBtn').getAttribute('aria-checked'), note: n.textContent, warn: n.classList.contains('warn'),
        stored: JSON.parse(localStorage.getItem('live-account-v1')), fills: [...new Set(window.liveChart.getMarkers().map(m => m.account))].join() }; });

    // a first visit (nothing picked yet): Sim101, Armed off, with a note
    const A = await openTab();
    let a = await acct(A);
    check(a.shown === 'Sim101' && a.armed === 'false' && a.note === 'On Sim101. Armed is off.' && !a.warn && a.stored === null, '1.6.1 first visit: Sim101, Armed off, the note: ' + JSON.stringify(a));

    // pick DEMO-EVAL and arm; a reload (with the PIN asked again) comes back on DEMO-EVAL with Armed off
    const box0 = await chartBox(A);
    await A.selectOption(T('oAcct'), 'DEMO-EVAL'); await A.waitForTimeout(200);
    a = await acct(A);
    check(a.shown === 'DEMO-EVAL' && a.stored === 'DEMO-EVAL' && a.fills === 'DEMO-EVAL', '1.6.1: a pick is saved, the fills follow: ' + JSON.stringify(a));
    await A.click(T('armBtn'));
    check(await A.getAttribute(T('armBtn'), 'aria-checked') === 'true', '1.6.1: armed on DEMO-EVAL');
    await A.reload();
    check(await unlockIfAsked(A), '1.6.1: the reload asks for the PIN again');
    await tradingOn(A);
    a = await acct(A);
    check(a.shown === 'DEMO-EVAL' && a.armed === 'false' && a.note === 'On DEMO-EVAL. Armed is off.' && a.fills === 'DEMO-EVAL' && JSON.stringify(a.options) === '["Sim101","DEMO-EVAL"]',
      '1.6.1 reload: back on DEMO-EVAL (the last account picked), Armed off, the note, its fills: ' + JSON.stringify(a));
    check(!(await A.title()).startsWith('ARMED'), '1.6.1: the title is not ARMED after the reload');
    const box1 = await chartBox(A);
    check(Math.abs(box1.y - box0.y) < 1 && Math.abs(box1.height - box0.height) < 1, '1.6.1: the note does not move the chart: ' + box0.y + ' / ' + box1.y);
    await shot(A, 'orders-1440-account-restored.png');

    // every order path, armed on the restored account: the account shown is the account used
    const yAt5 = p => A.evaluate(pr => window.liveChart.priceToY(pr), p);
    const settle = async price => { await A.evaluate(() => window.liveChart.goLive()); for (let k = 0, prev = -1, calm = 0; k < 40 && calm < 3; k++) { const y = await yAt5(price); calm = Math.abs(y - prev) < 0.25 ? calm + 1 : 0; prev = y; await A.waitForTimeout(150); } };
    const shiftClick = async price => { await settle(price); const b = await chartBox(A); await A.keyboard.down('Shift'); await A.mouse.click(b.x + b.width * 0.45, b.y + await yAt5(price)); await A.keyboard.up('Shift'); };
    const handle = id => A.evaluate(i => window.liveChart.orderHandles().find(x => x.id === i), id);
    await A.evaluate(() => { window.__sent.length = 0; });
    await A.click(T('armBtn'));
    await A.click(T('buyMkt'));                                                         // order bar Buy
    await until(async () => (await A.textContent(T('oPos'))).startsWith('LONG 1'), '1.6.1 Buy MKT on DEMO-EVAL');
    await A.waitForTimeout(450);
    await A.click(T('sellMkt'));                                                        // order bar Sell
    await until(async () => (await A.textContent(T('oPos'))) === 'Flat', '1.6.1 Sell MKT on DEMO-EVAL');
    await shiftClick(L5 - 12);                                                       // Shift+click (click-trade)
    let s5 = await until(async () => { const x = await state5(); return x.orders.length === 1 ? x : null; }, '1.6.1 Shift+click limit');
    const lim = s5 && s5.orders[0];
    await until(() => A.evaluate(id => !!window.liveChart.orderHandles().find(x => x.id === id), lim.id), '1.6.1 the limit on the chart');
    let h = await handle(lim.id), b5 = await chartBox(A);   // drag it (modify)
    await A.mouse.move(b5.x + h.box.x + h.box.w / 2, b5.y + h.box.y + h.box.h / 2); await A.mouse.down();
    await A.mouse.move(b5.x + h.box.x + h.box.w / 2, b5.y + h.box.y + h.box.h / 2 + 25, { steps: 5 }); await A.mouse.up();
    const movedTo = await until(async () => { const x = await state5(); const o = x.orders.find(q => q.id === lim.id); return o && o.price < lim.price ? o.price : null; }, '1.6.1 limit moved');
    // the workspace's chart draws the order at the price ChartBridge confirmed: read its x once it is there
    await until(() => A.evaluate(([id, p]) => window.liveChart.getOrders().some(o => o.id === id && o.price === p), [lim.id, movedTo]), '1.6.1 the chart shows the moved limit');
    await A.waitForTimeout(450);                                                      // past the 0.4 s repeat guard
    h = await handle(lim.id); b5 = await chartBox(A);     // its x (single cancel)
    await A.mouse.click(b5.x + h.xbox.x + h.xbox.w / 2, b5.y + h.xbox.y + h.xbox.h / 2);
    if (!(await until(async () => (await state5()).orders.length === 0, '1.6.1 the x cancelled it')))
      fail('1.6.1 the x: ' + JSON.stringify({ h, b5, notes: await A.evaluate(() => [$tk('note').textContent, document.getElementById('wsNote').textContent, window.__chartEl().closest('.chart-live').querySelector('[id$="-statusMsg"]').textContent]) }));
    await shiftClick(L5 - 14); await A.waitForTimeout(450); await shiftClick(L5 - 16);  // two more, then Cancel all
    await until(async () => (await state5()).orders.length === 2, '1.6.1 two limits');
    await A.click(T('cancelAllBtn'));
    await until(async () => (await state5()).orders.length === 0, '1.6.1 Cancel all');
    await A.click(T('buyMkt'));
    await until(async () => (await A.textContent(T('oPos'))).startsWith('LONG 1'), '1.6.1 long before Flatten');
    await A.click(T('flattenBtn'));                                                     // Flatten
    await until(async () => (await A.textContent(T('oPos'))) === 'Flat', '1.6.1 Flatten');
    const sent = await A.evaluate(() => ({ sent: window.__sent.filter(m => ['order', 'flatten', 'cancel', 'change'].includes(m.type)), acct: window.__orderAcct }));
    const kinds = sent.sent.map(m => m.type + (m.type === 'order' ? ':' + m.kind : '')).join(',');
    check(kinds === 'order:market,order:market,order:limit,change,cancel,order:limit,order:limit,cancel,cancel,order:market,flatten', '1.6.1 every order path was used: ' + kinds);
    const wrong = sent.sent.filter(m => (m.type === 'order' || m.type === 'flatten') ? m.account !== 'DEMO-EVAL' : sent.acct[m.id] !== 'DEMO-EVAL');
    check(wrong.length === 0, '1.6.1 Buy, Sell, Shift+click, modify, single cancel, Cancel all and Flatten all for DEMO-EVAL, the account shown: ' + JSON.stringify(wrong));
    s5 = await state5();
    check(!Object.keys(s5.positions).some(k => k.startsWith('Sim101|')) && (await acct(A)).shown === 'DEMO-EVAL', '1.6.1 nothing reached Sim101: ' + JSON.stringify(s5.positions));
    await A.click(T('armBtn'));

    // the account last picked is not a trade account now (DEMO-EMPTY is known to ChartBridge, not allowed): Sim101, a note
    // the ticket's account (live-ticket-v1) and the last pick (live-account-v1) both DEMO-EMPTY
    await A.evaluate(() => { localStorage.setItem('live-account-v1', JSON.stringify('DEMO-EMPTY')); const t = JSON.parse(localStorage.getItem('live-ticket-v1') || '{}'); t.account = 'DEMO-EMPTY'; localStorage.setItem('live-ticket-v1', JSON.stringify(t)); });
    await reloadTab(A);
    a = await acct(A);
    check(a.shown === 'Sim101' && a.armed === 'false' && a.note === 'Last account DEMO-EMPTY not available, on Sim101.' && a.warn && a.stored === 'DEMO-EMPTY' && a.fills === 'Sim101',
      '1.6.1 not available: Sim101 with the note, storage keeps the pick: ' + JSON.stringify(a));
    await shot(A, 'orders-1440-account-not-available.png');
    await A.evaluate(() => { window.__sent.length = 0; });
    await A.click(T('armBtn')); await A.click(T('buyMkt'));
    await until(async () => (await A.textContent(T('oPos'))).startsWith('LONG 1'), '1.6.1 Buy on the fallback');
    await A.click(T('flattenBtn'));
    await until(async () => (await A.textContent(T('oPos'))) === 'Flat', '1.6.1 Flatten on the fallback');
    const sentF = await A.evaluate(() => window.__sent.filter(m => m.type === 'order' || m.type === 'flatten').map(m => m.account));
    check(sentF.length === 2 && sentF.every(x => x === 'Sim101'), '1.6.1 on the fallback, orders go to Sim101, the account shown: ' + sentF.join());
    await A.click(T('armBtn'));

    // review S5: the window's title and the chart's ARMED badge while Armed; the ticket keeps its size
    const obarBox = pg => pg.evaluate(() => { const r = $tk('obar').getBoundingClientRect(); return [r.width, r.height].join('x'); });
    await A.selectOption(T('oAcct'), 'DEMO-EVAL'); await A.waitForTimeout(200);
    const bar0 = await obarBox(A);
    await A.click(T('armBtn'));
    const armSel = await panelSel(A) + ' [id$="-bArmed"]';
    check((await A.title()).startsWith('ARMED · MNQ · DEMO-EVAL · ') && await A.isVisible(armSel) && await obarBox(A) === bar0,
      '1.6.1 S5: title "' + await A.title() + '", the ARMED badge, the ticket ' + bar0 + ' -> ' + await obarBox(A));
    await shot(A, 'orders-1440-armed-account-title.png');
    // review S3: a DEMO-EVAL long with a working stop, the ticket then on Sim101: it names the other account's live trade
    await A.fill(T('bStop'), '40'); await A.press(T('bStop'), 'Tab'); await A.fill(T('bTarget'), '0'); await A.press(T('bTarget'), 'Tab');
    await A.click(T('buyMkt'));
    await until(async () => (await A.textContent(T('oPos'))).startsWith('LONG 1') && (await state5()).orders.length === 1, '1.6.1 long 1 with a stop on DEMO-EVAL');
    await A.click(T('armBtn'));
    await A.selectOption(T('oAcct'), 'Sim101'); await A.waitForTimeout(400);
    const other = await until(() => A.evaluate(() => { const el = $tk('oOther'); return el.textContent ? { text: el.textContent, live: el.classList.contains('live'), h: el.getBoundingClientRect().height } : null; }), 'the ticket on Sim101 shows DEMO-EVAL\'s trade');
    check(other && other.text === 'Other accounts on MNQ: DEMO-EVAL: LONG 1, 1 order' && other.live, '1.6.1 S3: the other account by name: ' + JSON.stringify(other));
    await shot(A, 'orders-1440-other-account-named.png');
    await A.selectOption(T('oAcct'), 'DEMO-EVAL'); await A.waitForTimeout(200);
    await reloadTab(A);
    a = await acct(A);
    check(a.shown === 'DEMO-EVAL' && a.armed === 'false' && a.note === 'On DEMO-EVAL. Armed is off.' && (await A.textContent(T('oPos'))).startsWith('LONG 1') && a.fills === 'DEMO-EVAL',
      '1.6.1 a reload comes back on DEMO-EVAL with its long: ' + JSON.stringify(a) + ' ' + await A.textContent(T('oPos')));
    // a dropped connection, the window kept: no account change, Armed off
    let n0 = await A.evaluate(() => window.__sent.filter(m => m.type === 'subscribe').length);
    await A.click(T('armBtn'));
    await control(P5, 'drop');
    await until(() => A.evaluate(n => window.__sent.filter(m => m.type === 'subscribe').length > n, n0), '1.6.1 reconnected', 15000);
    await tradingOn(A);
    a = await acct(A);
    check(a.shown === 'DEMO-EVAL' && a.armed === 'false', '1.6.1 a reconnect keeping the window: still DEMO-EVAL, Armed off: ' + JSON.stringify(a));
    await shot(A, 'orders-1440-account-after-reconnect.png');
    // trading off (the connection back, the sign-in held): Armed off, nothing to send with; trading back: the same account
    // (the single chart page let a pick be made meanwhile; the ticket's picker lists the trade accounts, none until then)
    await A.evaluate(() => { window.__holdTrading = true; });
    n0 = await A.evaluate(() => window.__sent.filter(m => m.type === 'subscribe').length);
    await control(P5, 'drop');
    await until(() => A.evaluate(n => window.__sent.filter(m => m.type === 'subscribe').length > n, n0), '1.6.1 reconnected, trading held off', 15000);
    await until(() => A.evaluate(() => $tk('buyMkt').disabled && document.getElementById('wsConn').classList.contains('live')), '1.6.1 live with trading off');
    a = await acct(A);
    check(a.armed === 'false' && await A.evaluate(() => $tk('armBtn').disabled && $tk('sellMkt').disabled), '1.6.1: trading off after the reconnect: Armed off, the order buttons off: ' + JSON.stringify(a));
    await A.evaluate(() => { window.__holdTrading = false; });
    n0 = await A.evaluate(() => window.__sent.filter(m => m.type === 'subscribe').length);
    await control(P5, 'drop');
    await until(() => A.evaluate(n => window.__sent.filter(m => m.type === 'subscribe').length > n, n0), '1.6.1 reconnected again', 15000);
    await tradingOn(A);
    a = await acct(A);
    check(a.shown === 'DEMO-EVAL' && a.armed === 'false', '1.6.1: trading back on: still DEMO-EVAL, Armed off: ' + JSON.stringify(a));
    // back on DEMO-EVAL: flatten the long (orders only for DEMO-EVAL, the account shown)
    await A.selectOption(T('oAcct'), 'DEMO-EVAL'); await A.waitForTimeout(200);
    await A.evaluate(() => { window.__sent.length = 0; });
    await A.click(T('armBtn')); await A.click(T('flattenBtn'));
    await until(async () => (await A.textContent(T('oPos'))) === 'Flat' && (await state5()).orders.length === 0, '1.6.1 tab A flat on DEMO-EVAL');
    // review 2 S1, S2, N1, N2: a Cancel all goes out by id, 8 a second, and locks nothing: Armed, the picker, the
    // instrument and Flatten all work while it runs. The state row names what is still going out.
    await A.bringToFront();
    const place = async (n, from) => { for (let i = 0; i < n; i++) await control(P5, 'elsewhere', { account: 'DEMO-EVAL', root: 'MNQ', side: 'buy', kind: 'limit', qty: 1, p: L5 - (from || 20) - i }); };
    const evalWorking = async () => (await state5()).orders.filter(o => o.account === 'DEMO-EVAL' && o.root === 'MNQ').length;
    // the orders on the chart, and 1.2 s since the last cancels (the page sends at most 8 in any 1.1 s)
    const onChart = async n => { await until(() => A.evaluate(k => window.liveChart.getOrders().length === k, n), '1.6.1 ' + n + ' DEMO-EVAL orders on the chart'); await A.waitForTimeout(1200); };
    const sentOf = type => A.evaluate(t => window.__sent.filter(m => m.type === t).map(m => ({ id: m.id, acct: window.__orderAcct[m.id], at: m.__at, account: m.account, root: m.root })), type);
    const bar = () => A.evaluate(() => ({ unsent: document.getElementById('wsUnsent').hidden ? '' : document.getElementById('wsUnsentText').textContent, batch: $tk('oCancel').textContent,
      acct: $tk('oAcct').disabled, arm: $tk('armBtn').disabled, flatten: $tk('flattenBtn').disabled, note: $tk('oAcctNote').textContent }));
    const armOn = async () => { if (await A.getAttribute(T('armBtn'), 'aria-checked') !== 'true') await A.click(T('armBtn')); };
    const armOff = async () => { if (await A.getAttribute(T('armBtn'), 'aria-checked') === 'true') await A.click(T('armBtn')); };
    const batchDone = what => until(async () => (await bar()).batch === '' && await evalWorking() === 0, what, 8000);

    // 10 orders: nothing locked, the state row counts down, every cancel for DEMO-EVAL
    await place(10);
    await onChart(10);
    await A.evaluate(() => { window.__sent.length = 0; window.__rejects.length = 0; });
    await armOn(); await A.click(T('cancelAllBtn'));
    let bb = await bar();
    check(!bb.acct && !bb.arm && !bb.flatten && bb.batch === 'Cancelling on DEMO-EVAL MNQ: 4 left (6 a second).', '1.6.1 review 2 S1: during a Cancel all nothing is locked, the state row names it: ' + JSON.stringify(bb));
    await shot(A, 'orders-1440-cancel-all-under-way.png');
    await batchDone('1.6.1 all ten cancelled');
    let cs = await sentOf('cancel');
    check(cs.length === 10 && cs.every(x => x.acct === 'DEMO-EVAL'), '1.6.1 ten cancels, all DEMO-EVAL: ' + cs.map(x => x.acct).join());

    // R15: an instrument switch 300 ms into a batch of 30 (about 4 s of cancels, so it still runs on a slow box): Armed
    // goes off but stays usable, Flatten works at once, and all the cancels Anthony asked for go out (1.6.1 before
    // review 2, with 20: 8 sent, Armed locked about 1.8 s)
    await place(30);
    await onChart(30);
    await A.evaluate(() => { window.__sent.length = 0; window.__rejects.length = 0; });
    await armOn(); await A.click(T('cancelAllBtn'));
    await A.waitForTimeout(300);
    await A.selectOption(T('root'), 'NQ');                                            // the ticket's instrument (the page's toolbar until 1.21.0)
    bb = await bar();
    const armedAfter = await A.getAttribute(T('armBtn'), 'aria-checked');
    check(armedAfter === 'false' && !bb.arm && /^Cancelling on DEMO-EVAL MNQ: \d+ left/.test(bb.batch), 'R15: after the switch Armed is off and not locked, the state row still names DEMO-EVAL MNQ: ' + JSON.stringify(bb));
    await until(() => A.evaluate(() => document.getElementById('wsConn').classList.contains('live')), 'R15 NQ loaded', 8000);
    await A.click(T('armBtn')); await A.click(T('flattenBtn'));
    const fl15 = await sentOf('flatten');
    check(fl15.length === 1 && fl15[0].account === 'DEMO-EVAL' && fl15[0].root === 'NQ', 'R15: arm and Flatten on NQ right after the switch: ' + JSON.stringify(fl15));
    await until(async () => await evalWorking() === 0, 'R15 every MNQ order cancelled', 8000);
    cs = await sentOf('cancel');
    check(cs.length === 30 && cs.every(x => x.acct === 'DEMO-EVAL') && await evalWorking() === 0, 'R15: all 30 cancels sent by id, 0 DEMO-EVAL MNQ orders working: ' + cs.length);
    await until(async () => (await bar()).batch === '', 'R15 the batch note gone', 5000);
    await armOff();
    await A.selectOption(T('root'), 'MNQ');
    await until(() => A.evaluate(() => document.getElementById('wsConn').classList.contains('live')), 'R15 back on MNQ', 8000);

    // R16: the connection drops 300 ms into a batch of 20: a note that stays (not a 6 s status line) names the account,
    // the instrument and the 14 cancels not sent; it stays over the reconnect and goes by itself once they are cancelled
    await place(20);
    await onChart(20);
    await A.evaluate(() => { window.__sent.length = 0; });
    await armOn(); await A.click(T('cancelAllBtn'));
    await A.waitForTimeout(300);
    n0 = await A.evaluate(() => window.__sent.filter(m => m.type === 'subscribe').length);
    await control(P5, 'drop');
    await until(() => A.evaluate(n => window.__sent.filter(m => m.type === 'subscribe').length > n, n0), 'R16 reconnected', 15000);
    await tradingOn(A);
    await A.waitForTimeout(7000);                                                     // longer than any status line
    bb = await bar();
    check(/^14 cancels on DEMO-EVAL MNQ were not sent: the connection to ChartBridge dropped\.\nThose orders may still be working\./.test(bb.unsent) && await evalWorking() === 14 && (await sentOf('cancel')).length === 6,
      'R16: 6 sent, the note stays over the reconnect and 7 s: ' + JSON.stringify(bb.unsent) + ' working ' + await evalWorking() + ', sent ' + JSON.stringify(await sentOf('cancel')));
    await shot(A, 'orders-1440-cancels-not-sent.png');
    await A.click(T('armBtn')); await A.click(T('cancelAllBtn'));
    await batchDone('R16 the rest cancelled');
    await until(async () => (await bar()).unsent === '', 'R16 the note goes once those orders are no longer working', 5000);
    await armOff();

    // R17: DEMO-EVAL leaves ChartBridge's list 300 ms into a batch of 20: the rest are not sent (ChartBridge would refuse
    // them), the note says why and stays until dismissed; the fallback note keeps its 15 s after the batch (N2)
    await place(20);
    await onChart(20);
    await A.evaluate(() => { window.__sent.length = 0; });
    await armOn(); await A.click(T('cancelAllBtn'));
    await A.waitForTimeout(300);
    await A.evaluate(() => window.__inject(Object.assign({}, window.__lastTrading, { accounts: ['Sim101'] })));
    await A.waitForTimeout(3000);                                                     // past where the batch would have ended
    bb = await bar();
    const a17 = await acct(A);
    check(/^14 cancels on DEMO-EVAL MNQ were not sent: the account is no longer a trade account in ChartBridge\./.test(bb.unsent) && (await sentOf('cancel')).length === 6 && a17.shown === 'Sim101' && a17.armed === 'false' && a17.note === 'Last account DEMO-EVAL not available, on Sim101.',
      'R17 and N2: 6 sent, the note says why, the fallback note still up 3 s later: ' + JSON.stringify({ unsent: bb.unsent, note: a17.note, shown: a17.shown }));
    await A.click('#wsUnsentClose');
    check((await bar()).unsent === '', 'R17: Dismiss takes the note away');
    await A.evaluate(() => window.__inject(window.__lastTrading));                   // DEMO-EVAL allowed again
    await A.selectOption(T('oAcct'), 'DEMO-EVAL'); await A.waitForTimeout(200);
    await A.click(T('armBtn')); await A.click(T('cancelAllBtn'));
    await batchDone('R17 the rest cancelled after DEMO-EVAL came back');
    await armOff();

    // R18: Flatten 300 ms into a batch of 20 with a position: flat, every order gone, and no cancel after the Flatten
    // (so no red "No working order" from ChartBridge)
    await armOn();
    await A.fill(T('bStop'), '0'); await A.press(T('bStop'), 'Tab');
    await A.click(T('buyMkt'));                                                         // the long first (the MNQ cap counts working orders)
    await until(async () => (await A.textContent(T('oPos'))).startsWith('LONG 1'), 'R18 long 1');
    await place(20);
    await onChart(20);
    await A.evaluate(() => { window.__sent.length = 0; window.__rejects.length = 0; });
    await A.waitForTimeout(1200);                                                     // ChartBridge's 10 a second counts the Buy too
    await A.click(T('cancelAllBtn'));
    await A.waitForTimeout(300);
    await A.click(T('flattenBtn'));
    await A.waitForTimeout(3000);
    const msgs18 = await A.evaluate(() => window.__sent.filter(m => ['cancel', 'flatten'].includes(m.type)).map(m => m.type));
    const rej18 = await A.evaluate(() => window.__rejects.slice());
    check((await A.textContent(T('oPos'))) === 'Flat' && await evalWorking() === 0 && msgs18.lastIndexOf('cancel') < msgs18.indexOf('flatten') && rej18.length === 0 && (await status(A)).cls.indexOf('error') < 0,
      'R18: Flatten mid-batch: flat, no order working, no cancel after it, no reject: ' + msgs18.join(',') + ' ' + JSON.stringify(rej18));
    await armOff();

    // R19: a second Cancel all 300 ms into a batch of 20 sends nothing new; never more than 8 in any second; none left
    await place(20);
    await onChart(20);
    await A.evaluate(() => { window.__sent.length = 0; window.__rejects.length = 0; window.__statusSeen.length = 0; });
    await armOn(); await A.click(T('cancelAllBtn'));
    await A.waitForTimeout(300);
    await A.click(T('cancelAllBtn'));
    const st19 = { text: (await A.evaluate(() => window.__statusSeen.filter(t => /^Still cancelling/.test(t)))).join(' | ') };
    await batchDone('R19 all cancelled');
    const times = await A.evaluate(() => window.__sent.filter(m => m.type === 'cancel').map(m => m.__at));
    const most = Math.max(...times.map(t => times.filter(u => u >= t && u < t + 1000).length));
    const rej19 = await A.evaluate(() => window.__rejects.slice());
    check(times.length === 20 && most <= 6 && rej19.length === 0 && /^Still cancelling on DEMO-EVAL MNQ: 14 left\. Nothing new to send\./.test(st19.text),
      'R19: the second click sent nothing new (' + times.length + ' cancels, at most ' + most + ' in a second, rejects ' + JSON.stringify(rej19) + '): ' + st19.text);
    await armOff();

    // R26 (review 3 S1, S2): DEMO-EVAL long 1 with 30 orders, Cancel all, pick Sim101 150 ms later, arm, Cancel all on
    // Sim101 (3 orders): Sim101's go first, at the next slot of the pace, not behind DEMO-EVAL's. At 390 px the batch
    // line (in the warning color: DEMO-EVAL is not shown) and "Other accounts ... DEMO-EVAL: LONG 1" wrap, never cut
    await armOn();
    await A.click(T('buyMkt'));
    await until(async () => (await A.textContent(T('oPos'))).startsWith('LONG 1'), 'R26 long 1 on DEMO-EVAL');
    await armOff();
    await place(30);
    for (let i = 0; i < 3; i++) await control(P5, 'elsewhere', { account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'limit', qty: 1, p: L5 - 60 - i });
    await onChart(30);
    await A.evaluate(() => { window.__sent.length = 0; window.__rejects.length = 0; });
    await armOn(); await A.click(T('cancelAllBtn'));
    await A.waitForTimeout(150);
    await A.selectOption(T('oAcct'), 'Sim101'); await A.waitForTimeout(100);
    await A.waitForTimeout(200);
    const r26 = await A.evaluate(() => { const c = $tk('oCancel'), o = $tk('oOther');
      return { batch: c.textContent, away: c.classList.contains('away'), color: getComputedStyle(c).color, other: o.textContent, cut: [c, o].map(el => el.scrollWidth > el.clientWidth + 1) }; });
    check(/^Cancelling on DEMO-EVAL MNQ: \d+ left/.test(r26.batch) && r26.away && /DEMO-EVAL: LONG 1/.test(r26.other) && !r26.cut[0] && !r26.cut[1],
      'R26: the batch line in the warning color and "Other accounts" with LONG 1, both whole in the ticket (the single chart page was checked at 390 px): ' + JSON.stringify(r26));
    await shot(A, 'orders-1440-cancel-all-other-account.png');
    await A.click(T('armBtn'));
    // the moment of the click itself (a capture listener runs first): a DEMO-EVAL cancel the batch sends between an earlier
    // stamp and the click is not "after its click" (the check failed now and then when a pace slot fell in that gap)
    await A.evaluate(() => $tk('cancelAllBtn').addEventListener('click', () => { window.__t26 = performance.now(); }, { capture: true, once: true }));
    await A.click(T('cancelAllBtn'));
    const t26 = await A.evaluate(() => window.__t26);
    await until(async () => (await state5()).orders.filter(o => o.account === 'Sim101').length === 0, 'R26 Sim101 cancelled', 8000);
    const c26 = await A.evaluate(t => window.__sent.filter(m => m.type === 'cancel' && m.__at >= t).map(m => ({ acct: window.__orderAcct[m.id], dt: Math.round(m.__at - t) })), t26);
    const sims = c26.filter(x => x.acct === 'Sim101'), evalAfter = c26.filter(x => x.acct === 'DEMO-EVAL');
    check(sims.length === 3 && c26.slice(0, 3).every(x => x.acct === 'Sim101') && sims.every(x => x.dt <= 1300),
      'R26: Sim101\'s 3 cancels are the first sent after its click, at the next slot of the pace (' + sims.map(x => x.dt).join(', ') + ' ms), DEMO-EVAL\'s rest (' + evalAfter.length + ') after them');
    await batchDone('R26 DEMO-EVAL\'s rest cancelled');
    await armOff();
    await A.selectOption(T('oAcct'), 'DEMO-EVAL'); await A.waitForTimeout(200);

    // R23 (review 3 S4): long 1 and 30 orders; Cancel all, Buy MKT +100 ms, Sell MKT +200 ms, Flatten +300 ms: at 6 a
    // second the batch leaves room, so nothing is refused and the account ends flat
    await place(30);
    await onChart(30);
    await A.evaluate(() => { window.__sent.length = 0; window.__rejects.length = 0; });
    await armOn(); await A.click(T('cancelAllBtn'));
    await A.waitForTimeout(100); await A.click(T('buyMkt'));
    await A.waitForTimeout(100); await A.click(T('sellMkt'));
    await A.waitForTimeout(100); await A.click(T('flattenBtn'));
    await until(async () => (await A.textContent(T('oPos'))) === 'Flat' && await evalWorking() === 0, 'R23 flat, nothing working', 8000);
    const rej23 = await A.evaluate(() => window.__rejects.slice());
    const sent23 = rej23.length ? await A.evaluate(() => { const t0 = window.__sent.length ? window.__sent[0].__at : 0; return window.__sent.filter(m => ['order', 'cancel', 'change', 'flatten', 'plan'].includes(m.type)).map(m => m.type + '@' + Math.round(m.__at - t0)); }) : [];
    check(rej23.length === 0 && (await A.textContent(T('oPos'))) === 'Flat', 'R23: Cancel all, Buy, Sell and Flatten within 300 ms: none refused, flat: ' + JSON.stringify(rej23) + (sent23.length ? ' sent ' + sent23.join(' ') : ''));
    // and if ChartBridge refuses Flatten for the rate anyway, the page sends it once more 1.1 s later (a made-up refusal)
    await A.waitForTimeout(1200);                                                     // past Flatten's 0.4 s repeat guard and the last refusal's window
    await A.evaluate(() => { window.__sent.length = 0; window.__statusSeen.length = 0; });
    await A.click(T('flattenBtn'));
    await A.evaluate(() => window.__inject({ type: 'reject', reason: 'More than 10 order actions in one second. Slow down.' }));
    await until(() => A.evaluate(() => window.__sent.filter(m => m.type === 'flatten').length === 2), 'R23 Flatten sent again', 4000);
    const fl23 = await A.evaluate(() => ({ f: window.__sent.filter(m => m.type === 'flatten').map(m => m.account + ' ' + m.root + ' ' + Math.round(m.__at)), seen: window.__statusSeen.filter(t => /Flatten/.test(t)) }));
    check(fl23.f.length === 2 && fl23.f.every(x => x.startsWith('DEMO-EVAL MNQ')) && fl23.seen.some(t => /^ChartBridge refused Flatten for DEMO-EVAL MNQ .*sending it again in 1 s\./.test(t)) && fl23.seen.some(t => t === 'Flatten sent again for DEMO-EVAL MNQ.'),
      'review 3 S4: a Flatten refused for the rate is sent once more: ' + JSON.stringify(fl23));
    await armOff();

    // Anthony 2026-09-30: a drag on an order still in a Cancel all sends no change; the Cancel all cancels it
    await place(20);
    await onChart(20);
    await A.evaluate(() => { window.__sent.length = 0; window.__statusSeen.length = 0; });
    await armOn(); await A.click(T('cancelAllBtn'));
    const t0q = Date.now();
    const sentNow = await A.evaluate(() => window.__sent.filter(m => m.type === 'cancel').map(m => m.id));
    // 1.14.0, the flake's root cause: the probe took the first order still queued, whose cancel goes out at the very next
    // slot of the pace (1.1 s after the click); settle() takes 0.5 to over 1 s, so now and then the cancel went out and
    // ChartBridge removed the order before the drag, which then pressed on an empty chart (no note, the check failed).
    // The order cancelled last (20 orders at 6 a 1.1 s: the fourth slot, 3.3 s after the click) leaves seconds to spare,
    // and it is checked to be still queued, and its label read again, right before the press.
    const orderIds = await A.evaluate(() => window.liveChart.getOrders().map(o => o.id));
    const queuedIds = orderIds.filter(id => !sentNow.includes(id));
    const queued = (await A.evaluate(() => window.liveChart.getOrders().map(o => ({ id: o.id, price: o.price })))).find(o => o.id === queuedIds[queuedIds.length - 1]);
    await settle(queued.price);
    const stillQueued = await A.evaluate(id => !window.__sent.some(m => m.type === 'cancel' && m.id === id), queued.id);
    check(stillQueued, 'the drag probe: order ' + queued.id + ' is still waiting in the Cancel all when it is pressed (' + (Date.now() - t0q) + ' ms after the click)');
    const hq = await handle(queued.id), bq = await chartBox(A);
    await A.mouse.move(bq.x + hq.box.x + hq.box.w / 2, bq.y + hq.box.y + hq.box.h / 2); await A.mouse.down();
    await A.mouse.move(bq.x + hq.box.x + hq.box.w / 2, bq.y + hq.box.y + hq.box.h / 2 + 25, { steps: 5 }); await A.mouse.up();
    await batchDone('the drag probe: all cancelled');
    const dq = await A.evaluate(id => ({ changes: window.__sent.filter(m => m.type === 'change').length, cancels: window.__sent.filter(m => m.type === 'cancel' && m.id === id).length,
      seen: window.__statusSeen.filter(t => /^Not moved/.test(t)) }), queued.id);
    check(dq.changes === 0 && dq.cancels === 1 && dq.seen.includes('Not moved: order ' + queued.id + ' is in the Cancel all under way, which cancels it.') && await evalWorking() === 0,
      'a drag on order ' + queued.id + ' while it waits in a Cancel all: no change sent, cancelled once, said so: ' + JSON.stringify(dq));
    await armOff();

    // review 2 N1: a Cancel all of 3, and Armed off in the same task: all 3 are sent at the click
    await place(3);
    await onChart(3);
    await A.evaluate(() => { window.__sent.length = 0; });
    await armOn();
    await A.evaluate(() => { $tk('cancelAllBtn').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); $tk('armBtn').click(); });
    await until(async () => await evalWorking() === 0, 'N1 the three cancelled');
    check((await sentOf('cancel')).length === 3 && await A.getAttribute(T('armBtn'), 'aria-checked') === 'false', 'review 2 N1: 3 of 3 sent though Armed went off in the same task');
    // B/E in paced chunks (Anthony 2026-10-01): with 12 ChartBridge stop legs one click sends 10 at once and the last 2
    // once ChartBridge's 10 a second allows; a second click while it runs sends nothing; never over 10 in any second
    const brKept = [await A.inputValue(T('bStop')), await A.inputValue(T('bTarget'))];
    const commitA = async (id, v) => { await A.fill(id, v); await A.press(id, 'Tab'); };
    const stopLegs = async () => (await state5()).orders.filter(o => o.account === 'DEMO-EVAL' && o.root === 'MNQ' && o.role === 'stop');
    const changesSent = () => A.evaluate(() => window.__sent.filter(m => m.type === 'change').map(m => ({ id: m.id, price: m.price, at: m.__at })));
    const legs12 = async what => {
      await control(P5, 'price', { root: 'MNQ', p: L5 });
      await A.selectOption(T('oQty'), '1');
      await armOn();
      for (let i = 0; i < 12; i++) { await A.click(T('buyMkt')); await A.waitForTimeout(450); }
      await until(async () => (await stopLegs()).length === 12 && (await A.textContent(T('oPos'))).startsWith('LONG 12'), what, 8000);
      await control(P5, 'price', { root: 'MNQ', p: L5 + 2 });                        // past break-even (L5, every fill at L5)
      await A.waitForTimeout(1200);                                                   // the buys out of ChartBridge's last second
      await A.evaluate(() => { window.__sent.length = 0; window.__rejects.length = 0; window.__statusSeen.length = 0; });
    };
    const flatA = async what => { await armOn(); await A.click(T('flattenBtn')); await until(async () => (await A.textContent(T('oPos'))) === 'Flat' && await evalWorking() === 0, what); };
    await commitA(T('bStop'), '40'); await commitA(T('bTarget'), '0');
    await legs12('B/E paced: long 12 with 12 stop legs');
    await A.click(T('beBtn'));
    await A.waitForTimeout(500);
    await A.click(T('beBtn'));                                                          // while the run is under way: absorbed
    await until(async () => (await stopLegs()).filter(o => o.price === L5).length === 12, 'B/E paced: all 12 stop legs at break-even', 6000);
    await A.waitForTimeout(1300);                                                     // anything more would have gone by now
    const ch12 = await changesSent(), at12 = ch12.map(x => x.at);
    const most12 = Math.max(...at12.map(t => at12.filter(u => u >= t && u < t + 1000).length)), span12 = Math.max(...at12) - Math.min(...at12);
    const seen12 = await A.evaluate(() => window.__statusSeen.slice()), rej12 = await A.evaluate(() => window.__rejects.slice());
    check(ch12.length === 12 && new Set(ch12.map(x => x.id)).size === 12 && ch12.every(x => x.price === L5) && span12 > 1000 && most12 <= 10 && rej12.length === 0,
      'B/E paced: 12 changes, each leg once, over ' + Math.round(span12) + ' ms, at most ' + most12 + ' in any second, rejects ' + JSON.stringify(rej12) + ' (' + ch12.length + ' sent)');
    check(seen12.some(t => /^Moving 12 stops to break-even [\d,.]+ · DEMO-EVAL\. 10 now, 2 as ChartBridge's 10 a second allows\.$/.test(t)) &&
      seen12.some(t => /^B\/E under way on DEMO-EVAL MNQ: 2 left\. Nothing new was sent\.$/.test(t)) &&
      seen12.some(t => /^B\/E: 12 changes sent to break-even [\d,.]+ · DEMO-EVAL MNQ\.$/.test(t)),
      'B/E paced: the notes (start, the second click absorbed, done): ' + JSON.stringify(seen12));
    await flatA('B/E paced: flat after the 12');
    // Armed off while the run waits: the last 2 are not sent, and the note says so
    await legs12('B/E paced: long 12 again');
    await A.click(T('beBtn'));
    await A.waitForTimeout(300);
    await armOff();
    await A.waitForTimeout(1600);
    const chOff = await changesSent(), seenOff = await A.evaluate(() => window.__statusSeen.slice());
    const atBe = (await stopLegs()).filter(o => o.price === L5).length;
    check(chOff.length === 10 && atBe === 10 && seenOff.some(t => /^B\/E: 10 changes sent to break-even [\d,.]+ · DEMO-EVAL MNQ\. 2 not sent: Armed went off\.$/.test(t)),
      'B/E paced: Armed off mid-run stops the rest (' + chOff.length + ' changes, ' + atBe + ' legs moved): ' + JSON.stringify(seenOff));
    await flatA('B/E paced: flat after the disarm test');
    await commitA(T('bStop'), brKept[0]); await commitA(T('bTarget'), brKept[1]);
    await armOff();

    // (until 1.21.0 a second tab at 400 px checked the page's account note and title here: the workspace has one ticket)
    await ctx.close();
  }

  /* ---------------- trading off in config.txt: the ticket says why, every control disabled */
  await startBridge(PORT + 1, ['--test-pin=' + TEST_PIN]);
  const off = await open(browser, PORT + 1, 1440);
  await until(() => off.evaluate(() => !$tk('obar').hidden), 'disabled ticket visible');
  check(/Trading off: Trading is off\. Set trading = true in config\.txt/.test(await off.textContent(T('oOff'))), 'reason shown: ' + await off.textContent(T('oOff')));
  const enabled = await off.$$eval(T('obar') + ' button, ' + T('obar') + ' input, ' + T('obar') + ' select', els => els.filter(e => !e.disabled && !e.closest('[hidden]')).map(e => e.dataset.tkId));
  check(JSON.stringify(enabled) === '["root"]', 'while trading is off only the ticket\'s instrument works (its account picker lists the trade accounts: none): ' + enabled.join(','));
  // (the single chart page's picker, with trading off, still chose whose fills the chart marked; the ticket's has no
  // accounts to list until trading is on)
  await shot(off, 'orders-1440-trading-off.png');
  await off.close();

  /* ---------------- clickjacking: ChartBridge refuses frames; the page also refuses to trade inside one */
  const host = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  await host.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await host.setContent(`<iframe id="f" src="http://localhost:${PORT}/live/" style="width:1260px;height:860px;border:0"></iframe>`);
  await host.waitForTimeout(2500);
  const blocked = host.frames().find(f => f !== host.mainFrame());
  check(!blocked || !(await blocked.evaluate(() => !!document.getElementById('wsConn')).catch(() => false)), 'ChartBridge page loaded inside a frame');
  await startBridge(PORT + 3, ['--trading', '--trade-accounts=Sim101', '--allow-frames', '--test-pin=' + TEST_PIN]);
  await host.setContent(`<iframe id="f" src="http://localhost:${PORT + 3}/live/?layout=Orders" style="width:1260px;height:860px;border:0"></iframe>`);
  const pinFrame = await until(async () => host.frames().find(x => x !== host.mainFrame() && /\/live\/(\?.*)?$/.test(x.url())), 'framed page', 15000);
  if (pinFrame) await unlockIfAsked(pinFrame).catch(e => fail('framed page PIN: ' + e.message));
  const fr = await until(async () => { const f = host.frames().find(x => x !== host.mainFrame()); return f && await f.evaluate(wsLive).catch(() => false) ? f : null; }, 'framed page loads with --allow-frames', 15000);
  if (fr) {
    await fr.waitForTimeout(800);
    // the workspace in a frame has no order ticket (and would refuse to trade: TradeCore's framed reason)
    const fx = await fr.evaluate(() => ({ arm: !!document.querySelector('.tk [data-tk-id="armBtn"]'), off: (document.querySelector('.tk [data-tk-id="oOff"]') || {}).textContent || '',
      panel: (document.querySelector('.ws-panel[data-type="ticket"] .ws-body') || {}).textContent || '' }));
    check(!fx.arm || /inside another page/.test(fx.off), 'framed page cannot trade: ' + JSON.stringify({ arm: fx.arm, off: fx.off, panel: fx.panel.trim().slice(0, 80) }));
    await shot(host, 'orders-framed-refused.png');
  }
  await host.close();

  /* ---------------- hello with no accounts, then the sign-in turns trading on: the picker works (review 2, S1) */
  await startBridge(PORT + 4, ['--trading', '--trade-accounts=Sim101,DEMO-EVAL', '--no-hello-accounts', '--test-pin=' + TEST_PIN]);
  {
    const na = await open(browser, PORT + 4, 1440);
    await until(() => na.evaluate(() => !$tk('buyMkt').disabled), 'trading on after an empty hello');
    const r = await na.evaluate(() => ({ disabled: $tk('oAcct').disabled, options: [...$tk('oAcct').options].map(o => o.value), title: $tk('oAcct').title, toolbar: [...document.querySelectorAll('[id$="-acctWrap"]')].every(e => !e.getClientRects().length) }));
    check(!r.disabled && JSON.stringify(r.options) === '["Sim101","DEMO-EVAL"]' && /^Orders go to this account/.test(r.title) && r.toolbar, 'empty hello, then trading: the ticket\'s picker is enabled with the trade accounts: ' + JSON.stringify(r));
    await na.selectOption(T('oAcct'), 'DEMO-EVAL');
    check(await na.inputValue(T('oAcct')) === 'DEMO-EVAL', 'and the order account can be changed');
    await na.close();
  }
  /* ---------------- connecting (no hello yet): no chart shows a toolbar account picker, so nothing jumps (review 2, N4) */
  {
    const cn = await browser.newPage({ viewport: { width: 1680, height: 860 } });
    await cn.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await cn.addInitScript(() => { window.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} }; });   // never connects
    await cn.goto(`http://localhost:${PORT + 4}/live/?layout=Orders`);
    await unlockIfAsked(cn);
    await cn.waitForFunction(() => !!document.getElementById('wsConn') && !!document.querySelector('.ws-panel[data-type="chart"]'), null, { timeout: 15000 });
    await cn.waitForTimeout(300);
    check(await cn.evaluate(() => !document.getElementById('wsConn').classList.contains('live') && [...document.querySelectorAll('[id$="-acctWrap"]')].every(e => !e.getClientRects().length)), 'the workspace while connecting: no chart shows a toolbar account picker');
    await cn.close();
  }
  // (until 1.21.0 the single chart page on ChartBridge 0.2's protocol v1 was checked here: read only, its legend and picker)
} finally {
  await browser.close();
  for (const b of bridges) b.kill();
}
if (errors.length) { console.error('FAIL\n' + errors.join('\n')); process.exit(1); }
console.log('orders smoke: ok (' + checks + ' checks)');
