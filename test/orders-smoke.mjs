// Order entry smoke test: drives the live page in Chromium against the fake bridge (protocol v2).
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
async function open(browser, port, width, height) {
  const page = await browser.newPage({ viewport: { width, height: height || 860 }, deviceScaleFactor: 2 });
  page.on('pageerror', e => fail(width + 'px pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fail('console: ' + m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.goto(`http://localhost:${port}/live/single.html`);
  await unlockIfAsked(page);                                   // ChartBridge 0.3.2: the page's PIN (made-up test PIN)
  await page.waitForFunction(() => document.getElementById('connPill').textContent === 'LIVE', null, { timeout: 15000 });
  await page.waitForTimeout(600);
  return page;
}
const status = page => page.evaluate(() => { const el = document.getElementById('statusMsg'); return { text: el.textContent, cls: el.className }; });
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
  await until(() => page.evaluate(() => !document.getElementById('obar').hidden && !document.getElementById('buyMkt').disabled), 'trading enabled after auth');
  check(JSON.stringify(await page.$$eval('#oAcct option', os => os.map(o => o.value))) === '["Sim101","DEMO-EVAL"]', 'trade accounts');
  check(await page.inputValue('#oAcct') === 'Sim101', 'default account Sim101');
  // one account picker (1.6.0): the order bar's, larger; no toolbar picker beside it; the chart marks its fills only
  const marks = p => p.evaluate(() => window.liveChart.getMarkers().map(m => m.side + m.qty + '@' + m.price));
  const markAccounts = p => p.evaluate(() => document.getElementById('lgFill').textContent.split(' · ').pop());
  check(await page.isHidden('#acctWrap') && await page.evaluate(() => document.getElementById('oAcct').classList.contains('acct-main')), 'one account picker: the order bar\'s');
  check(await markAccounts(page) === 'Sim101' && (await marks(page)).length === 2, 'fills follow the order account (Sim101): ' + JSON.stringify(await marks(page)));
  await page.selectOption('#oAcct', 'DEMO-EVAL'); await page.waitForTimeout(200);
  check(await markAccounts(page) === 'DEMO-EVAL' && (await marks(page)).length === 2, 'switching the account switches the fills (DEMO-EVAL)');
  check(await page.evaluate(() => localStorage.getItem('live-account-v1')) === '"DEMO-EVAL"', 'account choice saved');
  await shot(page, 'orders-1440-account-picker.png');
  await page.selectOption('#oAcct', 'Sim101'); await page.waitForTimeout(200);
  check(await markAccounts(page) === 'Sim101', 'back to Sim101');
  // 1.10.0: Qty is a select 1 to 9; above the MNQ cap of 5 the choices are off, never hidden, and the cap shows beside it
  {
    const q = await page.evaluate(() => ({ tag: document.getElementById('oQty').tagName, opts: [...document.getElementById('oQty').options].map(o => o.value + (o.disabled ? '-' : '+')).join(), cap: document.getElementById('oQtyCap').textContent, title: document.getElementById('oQty').title }));
    check(q.tag === 'SELECT' && q.opts === '1+,2+,3+,4+,5+,6-,7-,8-,9-' && q.cap === 'max 5' && /MNQ cap 5/.test(q.title), 'qty select 1 to 9, 6 to 9 off over the cap of 5: ' + JSON.stringify(q));
  }
  check(await page.getAttribute('#armBtn', 'aria-checked') === 'false', 'Armed off after load');
  check(/Trading through ChartBridge/.test(await page.textContent('#statusRo')), 'footer says trading');

  // Armed off: Buy, Sell and Shift+click send nothing; Flatten works while disarmed (Anthony 2026-10-01: never blocked)
  const types0 = (await control(PORT, 'received')).types;
  await page.click('#sellMkt');
  check((await status(page)).text === 'Armed is off: nothing was sent. Turn Armed on to trade.', 'disarmed Sell: nothing sent');
  await page.waitForTimeout(450);
  await page.click('#buyMkt');
  let st = await status(page);
  check(/Armed is off: nothing was sent/.test(st.text) && /warn/.test(st.cls), 'disarmed click message: ' + st.text);
  const cbox = () => page.locator('#chart canvas').boundingBox();   // measured fresh before each use
  let box = await cbox();
  const box0 = box;
  const yAt = p => page.evaluate(pr => window.liveChart.priceToY(pr), p);
  await page.keyboard.down('Shift'); await page.mouse.click(box.x + box.width * 0.5, box.y + await yAt(L - 10)); await page.keyboard.up('Shift');
  await page.click('#flattenBtn');
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
  await page.click('#armBtn');
  check(await page.getAttribute('#armBtn', 'aria-checked') === 'true', 'armed');
  check((await page.title()).startsWith('ARMED'), 'title shows ARMED');
  check(await page.isVisible('#armPill'), 'ARMED pill on the chart legend');
  await page.fill('#bStop', '40'); await page.press('#bStop', 'Tab');
  await page.fill('#bTarget', '80'); await page.press('#bTarget', 'Tab');
  await page.selectOption('#oQty', '2');
  await page.click('#buyMkt');
  await until(async () => (await page.textContent('#oPos')).startsWith('LONG 2'), 'position LONG 2 in the bar');
  let s = await until(async () => { const x = await state(); return x.orders.length === 2 ? x : null; }, 'two bracket legs');
  const stopLeg = s && s.orders.find(o => o.role === 'stop'), targetLeg = s && s.orders.find(o => o.role === 'target');
  check(stopLeg && stopLeg.price === L - 10 && stopLeg.qty === 2 && stopLeg.side === 'sell', 'stop leg at L - 10: ' + JSON.stringify(stopLeg));
  check(targetLeg && targetLeg.price === L + 20 && targetLeg.oco === stopLeg.oco, 'target leg at L + 20, same OCO');
  check(JSON.parse(await page.evaluate(() => localStorage.getItem('live-bracket-v1'))).MNQ.stop === 40, 'bracket remembered per root');
  await until(() => page.evaluate(() => window.liveChart.getOrders().length === 2 && !!window.liveChart.getPosition()), 'order and position lines on the chart');
  await page.waitForTimeout(300);
  box = await page.locator('#chart canvas').boundingBox();
  check(Math.abs(box.y - box0.y) < 1 && Math.abs(box.height - box0.height) < 1, 'the chart did not move when the position changed');
  await shot(page, 'orders-1440-bracket.png');

  // the live trade always stays (1.6.0, Anthony): Hide all and the Fills switch hide past fills, never the open
  // position, its entry fill, the working stop and target or the position line
  {
    const live = () => page.evaluate(() => ({ pos: window.liveChart.getPosition(), orders: window.liveChart.getOrders().length, marks: window.liveChart.getMarkers().map(m => m.side + m.qty) }));
    const before = await live();
    check(before.marks.length === 3 && before.marks.includes('buy2'), 'past fills and the entry marked: ' + JSON.stringify(before.marks));
    await page.click('#indBtn'); await page.click('#indHideAll'); await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    let after = await live();
    const layers = await page.evaluate(() => window.liveChart.getLayers());
    check(!layers.volume && !layers.vwap && !layers.levels && !layers.ib, 'Hide all hid the indicators');
    check(after.pos && after.pos.qty === 2 && after.orders === 2 && JSON.stringify(after.marks) === '["buy2"]', 'Hide all keeps the open position, both legs and its entry fill, and drops the past fills: ' + JSON.stringify(after));
    await shot(page, 'orders-1440-hide-all-open-position.png');
    await page.click('#indBtn'); await page.click('#indHideAll'); await page.keyboard.press('Escape');   // Restore
    await page.click('#indChips .ind-chip[data-id="fills"]');                                           // the Fills chip alone
    after = await live();
    check(after.pos && after.orders === 2 && JSON.stringify(after.marks) === '["buy2"]', 'Fills hidden: the entry fill, position and legs stay: ' + JSON.stringify(after));
    await page.click('#indChips .ind-chip[data-id="fills"]');
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
  await page.click('#flattenBtn');
  await until(async () => { const x = await state(); return x.orders.length === 0 && !Object.values(x.positions).some(p => p.qty); }, 'flatten');
  await until(async () => (await page.textContent('#oPos')) === 'Flat', 'bar shows Flat');
  await until(() => page.evaluate(() => !window.liveChart.getPosition() && window.liveChart.getOrders().length === 0), 'position and orders gone from the chart');

  // a 2-lot limit that fills in two pieces gets two stop and target pairs; the bar sums them up (item 4)
  await page.selectOption('#oQty', '2');
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
  const legsText = await until(async () => { const t = await page.textContent('#oLegs'); return t === 'stops cover 2 of 2, targets cover 2 of 2' ? t : null; }, 'leg summary 2 of 2');
  check(!!legsText, 'leg summary: ' + await page.textContent('#oLegs'));
  check(!(await page.getAttribute('#oLegs', 'class') || '').includes('uncovered'), 'covered: not in the error color');
  await page.waitForTimeout(300);
  await shot(page, 'orders-1440-legs.png');
  // close 1 by hand: long 1 with two pairs working, more than the position: the warning color and why
  await page.selectOption('#oQty', '1');
  await page.click('#sellMkt');
  await until(async () => (await page.textContent('#oPos')).startsWith('LONG 1'), 'long 1 after selling 1');
  const overText = await until(async () => { const t = await page.textContent('#oLegs'); return /^stops cover 2 of 1, targets cover 2 of 1 · .*over the position/.test(t) ? t : null; }, 'leg summary over the position');
  check(!!overText, 'over the position: ' + await page.textContent('#oLegs'));
  check((await page.getAttribute('#oLegs', 'class') || '').includes('over'), 'over: warning class');
  check(await page.evaluate(() => getComputedStyle(document.getElementById('oLegs')).color) === 'rgb(224, 180, 90)', 'over: warning color');
  await shot(page, 'orders-1440-legs-over.png');
  // buy 1 back with no bracket (0 / 0), then cancel one pair: stops 1 of 2, the error color
  await page.fill('#bStop', '0'); await page.press('#bStop', 'Tab');
  await page.fill('#bTarget', '0'); await page.press('#bTarget', 'Tab');
  await page.click('#buyMkt');
  await until(async () => (await page.textContent('#oLegs')) === 'stops cover 2 of 2, targets cover 2 of 2', 'long 2 again, two pairs');
  s = await state();
  const stopLegs = s.orders.filter(o => o.role === 'stop');
  box = await cbox();
  h = await page.evaluate(id => window.liveChart.orderHandles().find(x => x.id === id), stopLegs[0].id);
  await page.mouse.click(box.x + h.xbox.x + h.xbox.w / 2, box.y + h.xbox.y + h.xbox.h / 2);   // cancels that pair
  await until(async () => (await page.textContent('#oLegs')) === 'stops cover 1 of 2, targets cover 1 of 2', 'leg summary after one pair cancelled');
  const cls = await page.getAttribute('#oLegs', 'class') || '';
  check(cls.includes('uncovered'), 'stops short: error class, got "' + cls + '"');
  const col = await page.evaluate(() => getComputedStyle(document.getElementById('oLegs')).color);
  check(col === 'rgb(255, 122, 122)', 'stops short: error color, got ' + col);
  await shot(page, 'orders-1440-legs-short.png');
  await page.fill('#bStop', '40'); await page.press('#bStop', 'Tab');
  await page.fill('#bTarget', '80'); await page.press('#bTarget', 'Tab');
  await page.click('#flattenBtn');
  await until(async () => (await page.textContent('#oPos')) === 'Flat', 'flat after the pieces test');
  check((await page.textContent('#oLegs')) === '', 'no leg summary when flat');
  await control(PORT, 'price', { root: 'MNQ', p: L });

  // rejects: qty over the cap (stopped in the page: a qty remembered over a lower cap stays picked and is refused), and a
  // ChartBridge refusal (more than 200 ticks away, maxTicksAway = 200)
  await page.evaluate(() => { const q = document.getElementById('oQty'); q.value = '9'; q.dispatchEvent(new Event('change')); });
  await page.click('#buyMkt');
  st = await status(page);
  check(/Not sent: Qty 9 is over the MNQ cap of 5/.test(st.text) && /error/.test(st.cls), 'over-cap qty refused: ' + st.text);
  await shot(page, 'orders-1440-reject-qty.png');
  await page.selectOption('#oQty', '1');
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
  await page.dblclick('.stage', { position: { x: 1360, y: 400 } });            // price axis back to auto-fit

  // an error-level status from ChartBridge stays on screen until dismissed
  await control(PORT, 'status', { level: 'error', text: 'MNQ Sim101: bracket stop rejected; the position may have NO STOP' });
  await until(() => page.isVisible('#alertBar'), 'error alert shown');
  await page.waitForTimeout(7000);
  check(await page.isVisible('#alertBar') && /NO STOP/.test(await page.textContent('#alertText')), 'error alert still shown after 7 s');
  await shot(page, 'orders-1440-alert.png');
  await page.click('#alertClose');
  check(await page.isHidden('#alertBar'), 'alert dismissed');

  // reload: Armed is off again (and the PIN is asked again: the unlock lives in memory only)
  await page.reload();
  check(await unlockIfAsked(page), 'reload asks for the PIN again');
  await page.waitForFunction(() => document.getElementById('connPill').textContent === 'LIVE', null, { timeout: 15000 });
  await until(() => page.evaluate(() => !document.getElementById('buyMkt').disabled), 'trading after reload');
  check(await page.getAttribute('#armBtn', 'aria-checked') === 'false', 'Armed off after reload');
  check(!(await page.title()).startsWith('ARMED'), 'title not ARMED after reload');
  check(await page.inputValue('#bStop') === '40', 'bracket kept after reload');
  await noSideScroll(page, 1440);

  /* ---------------- 1.10.0 order bar essentials: bracket presets, qty select, B/E, Shift+click by mouse button */
  {
    const reloadPage = async () => {
      await page.reload(); await unlockIfAsked(page);
      await page.waitForFunction(() => document.getElementById('connPill').textContent === 'LIVE', null, { timeout: 15000 });
      await until(() => page.evaluate(() => !document.getElementById('buyMkt').disabled), 'trading after reload');
    };
    const saved = () => page.evaluate(() => ({ br: JSON.parse(localStorage.getItem('live-bracket-v1')).MNQ, sel: JSON.parse(localStorage.getItem('live-bracket-sel-v1') || '{}').MNQ, presets: JSON.parse(localStorage.getItem('live-bracket-presets-v1') || 'null') }));
    const boxes = async () => [await page.inputValue('#bPreset'), await page.inputValue('#bStop'), await page.inputValue('#bTarget')].join(' ');
    const commit = async (id, v) => { await page.fill(id, v); await page.press(id, 'Tab'); };
    const received = async () => (await control(PORT, 'received')).types.change || 0;

    // qty: the pick is remembered per root
    await page.selectOption('#oQty', '3');
    check(JSON.parse(await page.evaluate(() => localStorage.getItem('live-qty-v1'))).MNQ === 3, '1.10.0 qty 3 saved for MNQ');
    await reloadPage();
    check(await page.inputValue('#oQty') === '3', '1.10.0 qty 3 back after a reload');
    await page.selectOption('#oQty', '1');

    // presets: a ratio sets the target and stays linked to the stop; typing the target makes it Custom
    check(JSON.stringify(await page.$$eval('#bPreset option', os => os.map(o => o.value))) === '["custom","1:1","1:1.5","1:2","save"]', '1.10.0 preset choices: ' + JSON.stringify(await page.$$eval('#bPreset option', os => os.map(o => o.value))));
    await commit('#bStop', '12');
    check(await boxes() === 'custom 12 80', '1.10.0 Custom 12 / 80: ' + await boxes());
    await page.selectOption('#bPreset', '1:2');
    check(await boxes() === '1:2 12 24', '1.10.0 1:2 sets the target to 24: ' + await boxes());
    await page.fill('#bStop', '15');                                          // typing, not committed yet: linked at once
    check(await boxes() === '1:2 15 30', '1.10.0 the stop typed, the target follows: ' + await boxes());
    await page.press('#bStop', 'Tab');
    let sv = await saved();
    check(sv.br.stop === 15 && sv.br.target === 30 && sv.sel === '1:2', '1.10.0 1:2 saved: ' + JSON.stringify(sv));
    await page.selectOption('#bPreset', '1:1.5');
    check(await boxes() === '1:1.5 15 23', '1.10.0 1:1.5 of 15 is round(22.5) = 23: ' + await boxes());
    await commit('#bTarget', '40');
    check(await boxes() === 'custom 15 40', '1.10.0 typing the target makes it Custom: ' + await boxes());
    // Save current... with a name; it is picked, and survives a reload
    await page.selectOption('#bPreset', 'save');
    check(await page.isVisible('#bSaveBox') && await page.inputValue('#bSaveName') === '15/40t', '1.10.0 the save box opens with the numbers as the name');
    await page.fill('#bSaveName', 'Scalp'); await page.press('#bSaveName', 'Enter');
    sv = await saved();
    check(await page.isHidden('#bSaveBox') && await boxes() === 'p:Scalp 15 40' && JSON.stringify(sv.presets) === '[{"name":"Scalp","stop":15,"target":40}]', '1.10.0 preset Scalp saved and picked: ' + await boxes() + ' ' + JSON.stringify(sv.presets));
    await commit('#bStop', '20'); await commit('#bTarget', '60');               // Custom again, then back to the preset
    check(await boxes() === 'custom 20 60', '1.10.0 typing the stop of a saved preset makes it Custom: ' + await boxes());
    await page.selectOption('#bPreset', 'p:Scalp');
    check(await boxes() === 'p:Scalp 15 40', '1.10.0 the preset sets stop and target: ' + await boxes());
    await reloadPage();
    check(await boxes() === 'p:Scalp 15 40', '1.10.0 the preset pick survives a reload: ' + await boxes());
    await page.selectOption('#bPreset', '1:2');
    await reloadPage();
    check(await boxes() === '1:2 15 30', '1.10.0 the ratio pick survives a reload: ' + await boxes());
    // points: shown and typed in points, stored in ticks, rounded to the nearest tick on commit
    await page.click('#bUnit >> text="pt"');
    check(await boxes() === '1:2 3.75 7.5', '1.10.0 in points: ' + await boxes());
    await commit('#bStop', '2.6');                                            // 10.4 ticks: rounds to 10
    sv = await saved();
    check(await boxes() === '1:2 2.5 5' && sv.br.stop === 10 && sv.br.target === 20, '1.10.0 2.6 pt commits as 10 ticks, the target linked: ' + await boxes() + ' ' + JSON.stringify(sv.br));
    await reloadPage();
    check(await boxes() === '1:2 2.5 5', '1.10.0 the unit survives a reload: ' + await boxes());
    await page.click('#bUnit >> text="t"');
    check(await boxes() === '1:2 10 20', '1.10.0 back in ticks: ' + await boxes());
    // delete the saved preset; the stop and target stay
    await page.selectOption('#bPreset', 'p:Scalp');
    await page.selectOption('#bPreset', 'delete');
    sv = await saved();
    check(await boxes() === 'custom 15 40' && JSON.stringify(sv.presets) === '[]', '1.10.0 preset deleted: ' + await boxes() + ' ' + JSON.stringify(sv.presets));
    await shot(page, 'orders-1440-presets.png');
    await commit('#bStop', '40'); await commit('#bTarget', '80');

    // Shift+click by mouse button, armed: Shift + left buys, Shift + right and Ctrl + left sell; Ctrl and Shift together
    // send nothing
    await page.click('#armBtn');
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
    check((await state()).orders.length === 3 && /^Ctrl and Shift together: nothing was sent/.test((await status(page)).text), '1.10.0 Ctrl + Shift: nothing sent: ' + (await status(page)).text);
    await page.click('#cancelAllBtn');
    await until(async () => (await state()).orders.length === 0, '1.10.0 the three orders cancelled');
    // no browser menu anywhere on the chart (Anthony 2026-10-01): plot (right click with or without Shift; disarmed, so
    // nothing is placed), price axis, delta pane, time axis; the order bar and the rest of the page keep it
    await page.click('#armBtn');
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
    await page.click('#oPos', { button: 'right' });                                                     // the order bar
    await page.click('#statusRo', { button: 'right' });                                                 // the page
    const cm = await page.evaluate(() => window.__cm);
    check(JSON.stringify(cm) === '[true,true,true,true,true,true,false,false]', '1.10.0 no browser menu anywhere on the chart, the menu on the order bar and the page: ' + JSON.stringify(cm));
    check((await state()).orders.length === 0, '1.10.0 disarmed right clicks placed nothing');
    await page.click('#armBtn');

    // B/E: off while flat; one change per ChartBridge stop leg, to the average price rounded up a tick (long), only past it
    check(await page.isDisabled('#beBtn'), '1.10.0 B/E off while flat');
    await commit('#bStop', '40'); await commit('#bTarget', '0');
    await page.click('#buyMkt');
    await until(async () => (await page.textContent('#oPos')).startsWith('LONG 1') && (await state()).orders.length === 1, '1.10.0 long 1 with a stop');
    await control(PORT, 'price', { root: 'MNQ', p: L + 0.25 });
    await page.waitForTimeout(450);
    await page.click('#buyMkt');                                              // a second fill a tick higher: average L + 0.125
    await until(async () => (await page.textContent('#oPos')).startsWith('LONG 2') && (await state()).orders.filter(x => x.role === 'stop').length === 2, '1.10.0 long 2, two stop legs');
    await control(PORT, 'elsewhere', { account: 'Sim101', root: 'MNQ', side: 'sell', kind: 'stop', qty: 1, p: L - 20 });   // a stop placed in NinjaTrader
    await until(async () => (await state()).orders.length === 3, '1.10.0 the NinjaTrader stop is working');
    await until(() => page.evaluate(() => !document.getElementById('beBtn').disabled), '1.10.0 B/E on with a position and a stop leg');
    const be = L + 0.25;
    // underwater and at break-even: nothing sent
    for (const last of [L - 1, be]) {
      await control(PORT, 'price', { root: 'MNQ', p: last });
      await page.waitForTimeout(450);
      const c0 = await received();
      await page.click('#beBtn');
      await page.waitForTimeout(400);
      check(await received() === c0 && (await status(page)).text === 'Price is not past break-even yet; the stop stays.', '1.10.0 B/E with the last price at ' + last + ' sends nothing: ' + (await status(page)).text);
    }
    await shot(page, 'orders-1440-be-not-yet.png');
    await control(PORT, 'price', { root: 'MNQ', p: L + 2 });
    await page.waitForTimeout(450);
    const c0 = await received();
    await page.evaluate(() => { const el = document.getElementById('statusMsg'); window.__msgs = []; new MutationObserver(() => window.__msgs.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true }); });
    await page.click('#beBtn');
    s = await until(async () => { const x = await state(); return x.orders.filter(q => q.role === 'stop' && q.price === be).length === 2 ? x : null; }, '1.10.0 both stop legs at break-even');
    check(await received() === c0 + 2, '1.10.0 B/E sent one change per stop leg: ' + (await received() - c0));
    const other = s && s.orders.find(q => q.role === 'other');
    check(other && other.price === L - 20, '1.10.0 the NinjaTrader stop was not touched: ' + JSON.stringify(other));
    const msgs = await page.evaluate(() => window.__msgs);
    check(msgs.some(t => t === 'Moving 2 stops to break-even ' + be.toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' · Sim101. 1 stop placed in NinjaTrader left alone.'), '1.10.0 the B/E note: ' + JSON.stringify(msgs));
    await page.waitForTimeout(450);
    // a second click: the legs are at break-even already, nothing more is sent
    const c1 = await received();
    await page.click('#beBtn');
    await page.waitForTimeout(400);
    check(await received() === c1, '1.10.0 a second B/E sends nothing: ' + (await status(page)).text);
    await shot(page, 'orders-1440-be.png');

    // the order bar on one line at 1920 and 1440 (it may wrap below about 1200, as before); screenshots at 1920, 1440, 1280
    const oneLine = () => page.evaluate(() => {
      const kids = [...document.getElementById('obar').children].filter(c => !c.classList.contains('ostate'));
      const tops = kids.map(k => k.getBoundingClientRect().top), bottoms = kids.map(k => k.getBoundingClientRect().bottom);
      return { spread: Math.max(...tops) - Math.min(...tops), height: Math.max(...bottoms) - Math.min(...tops) };
    });
    for (const w of [1920, 1440, 1280]) {
      await page.setViewportSize({ width: w, height: 860 });
      await page.waitForTimeout(300);
      const ol = await oneLine();
      if (w >= 1440) check(ol.spread < 4 && ol.height < 40, '1.10.0 the order bar is one line at ' + w + ': ' + JSON.stringify(ol));
      await page.locator('.obar-ground').screenshot({ path: path.join(out, 'orders-' + w + '-order-bar.png') });
      if (SHOTS) fs.copyFileSync(path.join(out, 'orders-' + w + '-order-bar.png'), path.join(SHOTS, 'orders-' + w + '-order-bar.png'));
    }
    await page.setViewportSize({ width: 1440, height: 860 });
    await page.click('#flattenBtn');
    await until(async () => (await page.textContent('#oPos')) === 'Flat' && (await state()).orders.length === 0, '1.10.0 flat after the B/E test');
    await page.click('#armBtn');
    await control(PORT, 'price', { root: 'MNQ', p: L });
    await commit('#bStop', '40'); await commit('#bTarget', '80');
  }

  // 400 px: armed with a position and a bracket
  const phone = await open(browser, PORT, 400, 860);
  await until(() => phone.evaluate(() => !document.getElementById('buyMkt').disabled), 'phone: trading enabled');
  await phone.click('#armBtn');
  await phone.click('#buyMkt');
  await until(async () => (await phone.textContent('#oPos')).startsWith('LONG 1'), 'phone: position');
  await phone.waitForTimeout(400);
  await noSideScroll(phone, 400);
  await shot(phone, 'orders-400-armed.png');
  await phone.click('#flattenBtn');
  await until(async () => (await phone.textContent('#oPos')) === 'Flat', 'phone: flatten');
  await phone.close();
  await page.close();

  /* ---------------- 1.6.1 (Anthony's ruling 2026-09-30): the order account after a reload or a dropped connection.
     The account last picked on this PC when ChartBridge allows it, else Sim101 with a note; Armed always off; the
     picker highlighted; every order path sends for the account shown; two tabs each keep their own account. */
  {
    const P5 = PORT + 5;
    // MNQ cap 40: the cap counts working orders, and the Cancel all probes below keep 30 working while Anthony buys
    await startBridge(P5, ['--trading', '--trade-accounts=Sim101,DEMO-EVAL', '--max-qty=MNQ:40', '--test-controls', '--test-pin=' + TEST_PIN]);
    const L5 = Math.round((await control(P5, 'hold', { root: 'MNQ' })).last);
    await control(P5, 'price', { root: 'MNQ', p: L5 });
    const state5 = () => control(P5, 'state', { root: 'MNQ' });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 1 });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    // every message a page sends, and the account of every order ChartBridge reports to it
    await ctx.addInitScript(() => {
      window.__sent = []; window.__orderAcct = {}; window.__rejects = []; window.__statusSeen = [];
      const iv = setInterval(() => { const el = document.getElementById('statusMsg'); if (!el) return; clearInterval(iv); new MutationObserver(() => window.__statusSeen.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true }); }, 20);
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
            if (m.type === 'trading' && window.__holdTrading) return;
          } catch (e) { /* not JSON */ }
          return fn(ev);   // __holdTrading: the sign-in answer held back, so trading stays off after a reconnect
        });
      } });
    });
    const tradingOn = pg => until(() => pg.evaluate(() => !document.getElementById('buyMkt').disabled && document.getElementById('connPill').textContent === 'LIVE'), 'trading on', 15000);
    const openTab = async () => {
      const pg = await ctx.newPage();
      pg.on('pageerror', e => fail('1.6.1 pageerror: ' + e.message));
      pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|WebSocket connection/.test(m.text())) fail('1.6.1 console: ' + m.text()); });
      await pg.goto(`http://localhost:${P5}/live/single.html`);
      await unlockIfAsked(pg);
      await tradingOn(pg);
      return pg;
    };
    const reloadTab = async pg => { await pg.reload(); await unlockIfAsked(pg); await tradingOn(pg); };
    const acct = pg => pg.evaluate(() => { const s = document.getElementById('oAcct'), n = document.getElementById('oAcctNote');
      return { shown: s.value, options: [...s.options].map(o => o.value), armed: document.getElementById('armBtn').getAttribute('aria-checked'), note: n.textContent, warn: n.classList.contains('warn'),
        ring: s.classList.contains('acct-flash'), stored: JSON.parse(localStorage.getItem('live-account-v1')), tab: JSON.parse(sessionStorage.getItem('live-account-tab-v1')), fills: document.getElementById('lgFill').textContent.split(' · ').pop() }; });

    // a first visit (nothing picked yet): Sim101, Armed off, and the picker stands out with a note
    const A = await openTab();
    let a = await acct(A);
    check(a.shown === 'Sim101' && a.armed === 'false' && a.note === 'On Sim101. Armed is off.' && a.ring && !a.warn && a.stored === null, '1.6.1 first visit: Sim101, Armed off, highlighted: ' + JSON.stringify(a));
    check(await A.evaluate(() => { const b = document.getElementById('oAcct').getBoundingClientRect(); return getComputedStyle(document.getElementById('oAcct')).boxShadow !== 'none' && b.height >= 30; }), '1.6.1: the highlight is a ring around the picker');
    await A.waitForTimeout(3800);
    a = await acct(A);
    check(!a.ring && a.note !== '', '1.6.1: the ring goes after a few seconds, the note stays a little longer');

    // pick DEMO-EVAL and arm; a reload (with the PIN asked again) comes back on DEMO-EVAL with Armed off
    const box0 = await A.locator('#chart canvas').boundingBox();
    await A.selectOption('#oAcct', 'DEMO-EVAL'); await A.waitForTimeout(200);
    a = await acct(A);
    check(a.shown === 'DEMO-EVAL' && a.stored === 'DEMO-EVAL' && a.note === '' && a.fills === 'DEMO-EVAL', '1.6.1: a pick is saved, the note cleared, the fills follow: ' + JSON.stringify(a));
    await A.click('#armBtn');
    check(await A.getAttribute('#armBtn', 'aria-checked') === 'true', '1.6.1: armed on DEMO-EVAL');
    await A.reload();
    check(await unlockIfAsked(A), '1.6.1: the reload asks for the PIN again');
    await tradingOn(A);
    a = await acct(A);
    check(a.shown === 'DEMO-EVAL' && a.armed === 'false' && a.note === 'On DEMO-EVAL, the account this tab was on. Armed is off.' && a.ring && a.fills === 'DEMO-EVAL' && JSON.stringify(a.options) === '["Sim101","DEMO-EVAL"]',
      '1.6.1 reload: back on DEMO-EVAL (this tab\'s account), Armed off, highlighted, its fills: ' + JSON.stringify(a));
    check(!(await A.title()).startsWith('ARMED'), '1.6.1: the title is not ARMED after the reload');
    const box1 = await A.locator('#chart canvas').boundingBox();
    check(Math.abs(box1.y - box0.y) < 1 && Math.abs(box1.height - box0.height) < 1, '1.6.1: the note and the ring do not move the chart: ' + box0.y + ' / ' + box1.y);
    await shot(A, 'orders-1440-account-restored.png');

    // every order path, armed on the restored account: the account shown is the account used
    const yAt5 = p => A.evaluate(pr => window.liveChart.priceToY(pr), p);
    const settle = async price => { await A.evaluate(() => window.liveChart.goLive()); for (let k = 0, prev = -1, calm = 0; k < 40 && calm < 3; k++) { const y = await yAt5(price); calm = Math.abs(y - prev) < 0.25 ? calm + 1 : 0; prev = y; await A.waitForTimeout(150); } };
    const shiftClick = async price => { await settle(price); const b = await A.locator('#chart canvas').boundingBox(); await A.keyboard.down('Shift'); await A.mouse.click(b.x + b.width * 0.45, b.y + await yAt5(price)); await A.keyboard.up('Shift'); };
    const handle = id => A.evaluate(i => window.liveChart.orderHandles().find(x => x.id === i), id);
    await A.evaluate(() => { window.__sent.length = 0; });
    await A.click('#armBtn');
    await A.click('#buyMkt');                                                         // order bar Buy
    await until(async () => (await A.textContent('#oPos')).startsWith('LONG 1'), '1.6.1 Buy MKT on DEMO-EVAL');
    await A.waitForTimeout(450);
    await A.click('#sellMkt');                                                        // order bar Sell
    await until(async () => (await A.textContent('#oPos')) === 'Flat', '1.6.1 Sell MKT on DEMO-EVAL');
    await shiftClick(L5 - 12);                                                       // Shift+click (click-trade)
    let s5 = await until(async () => { const x = await state5(); return x.orders.length === 1 ? x : null; }, '1.6.1 Shift+click limit');
    const lim = s5 && s5.orders[0];
    await until(() => A.evaluate(id => !!window.liveChart.orderHandles().find(x => x.id === id), lim.id), '1.6.1 the limit on the chart');
    let h = await handle(lim.id), b5 = await A.locator('#chart canvas').boundingBox();   // drag it (modify)
    await A.mouse.move(b5.x + h.box.x + h.box.w / 2, b5.y + h.box.y + h.box.h / 2); await A.mouse.down();
    await A.mouse.move(b5.x + h.box.x + h.box.w / 2, b5.y + h.box.y + h.box.h / 2 + 25, { steps: 5 }); await A.mouse.up();
    await until(async () => { const x = await state5(); const o = x.orders.find(q => q.id === lim.id); return o && o.price < lim.price; }, '1.6.1 limit moved');
    h = await handle(lim.id); b5 = await A.locator('#chart canvas').boundingBox();     // its x (single cancel)
    await A.mouse.click(b5.x + h.xbox.x + h.xbox.w / 2, b5.y + h.xbox.y + h.xbox.h / 2);
    await until(async () => (await state5()).orders.length === 0, '1.6.1 the x cancelled it');
    await shiftClick(L5 - 14); await A.waitForTimeout(450); await shiftClick(L5 - 16);  // two more, then Cancel all
    await until(async () => (await state5()).orders.length === 2, '1.6.1 two limits');
    await A.click('#cancelAllBtn');
    await until(async () => (await state5()).orders.length === 0, '1.6.1 Cancel all');
    await A.click('#buyMkt');
    await until(async () => (await A.textContent('#oPos')).startsWith('LONG 1'), '1.6.1 long before Flatten');
    await A.click('#flattenBtn');                                                     // Flatten
    await until(async () => (await A.textContent('#oPos')) === 'Flat', '1.6.1 Flatten');
    const sent = await A.evaluate(() => ({ sent: window.__sent.filter(m => ['order', 'flatten', 'cancel', 'change'].includes(m.type)), acct: window.__orderAcct }));
    const kinds = sent.sent.map(m => m.type + (m.type === 'order' ? ':' + m.kind : '')).join(',');
    check(kinds === 'order:market,order:market,order:limit,change,cancel,order:limit,order:limit,cancel,cancel,order:market,flatten', '1.6.1 every order path was used: ' + kinds);
    const wrong = sent.sent.filter(m => (m.type === 'order' || m.type === 'flatten') ? m.account !== 'DEMO-EVAL' : sent.acct[m.id] !== 'DEMO-EVAL');
    check(wrong.length === 0, '1.6.1 Buy, Sell, Shift+click, modify, single cancel, Cancel all and Flatten all for DEMO-EVAL, the account shown: ' + JSON.stringify(wrong));
    s5 = await state5();
    check(!Object.keys(s5.positions).some(k => k.startsWith('Sim101|')) && (await acct(A)).shown === 'DEMO-EVAL', '1.6.1 nothing reached Sim101: ' + JSON.stringify(s5.positions));
    await A.click('#armBtn');

    // the account last picked is not a trade account now (DEMO-EMPTY is known to ChartBridge, not allowed): Sim101, a note
    await A.evaluate(() => { localStorage.setItem('live-account-v1', JSON.stringify('DEMO-EMPTY')); sessionStorage.setItem('live-account-tab-v1', JSON.stringify('DEMO-EMPTY')); });
    await reloadTab(A);
    a = await acct(A);
    check(a.shown === 'Sim101' && a.armed === 'false' && a.note === 'Last account DEMO-EMPTY not available, on Sim101.' && a.warn && a.ring && a.stored === 'DEMO-EMPTY' && a.fills === 'Sim101',
      '1.6.1 not available: Sim101 with the note, storage keeps the pick: ' + JSON.stringify(a));
    await shot(A, 'orders-1440-account-not-available.png');
    await A.evaluate(() => { window.__sent.length = 0; });
    await A.click('#armBtn'); await A.click('#buyMkt');
    await until(async () => (await A.textContent('#oPos')).startsWith('LONG 1'), '1.6.1 Buy on the fallback');
    await A.click('#flattenBtn');
    await until(async () => (await A.textContent('#oPos')) === 'Flat', '1.6.1 Flatten on the fallback');
    const sentF = await A.evaluate(() => window.__sent.filter(m => m.type === 'order' || m.type === 'flatten').map(m => m.account));
    check(sentF.length === 2 && sentF.every(x => x === 'Sim101'), '1.6.1 on the fallback, orders go to Sim101, the account shown: ' + sentF.join());
    await A.click('#armBtn');

    // two tabs (review S1): each tab keeps its own account while it is open, and a reload of a tab comes back on that
    // tab's account (sessionStorage); a new tab starts on the last one picked on this PC
    const obarBox = pg => pg.evaluate(() => { const r = document.getElementById('obar').getBoundingClientRect(); return [r.width, r.height].join('x'); });
    await A.selectOption('#oAcct', 'DEMO-EVAL'); await A.waitForTimeout(200);
    const bar0 = await obarBox(A);
    await A.click('#armBtn');
    // review S5: the tab title and the ARMED pill name the account; the order bar keeps its size
    check(await A.title() === 'ARMED · MNQ · DEMO-EVAL' && await A.textContent('#armPill') === 'ARMED · DEMO-EVAL' && await A.isVisible('#armPill') && await obarBox(A) === bar0,
      '1.6.1 S5: title "' + await A.title() + '", pill "' + await A.textContent('#armPill') + '", order bar ' + bar0 + ' -> ' + await obarBox(A));
    await shot(A, 'orders-1440-armed-account-title.png');
    const B = await openTab();
    let b = await acct(B);
    check(b.shown === 'DEMO-EVAL' && b.armed === 'false' && b.note === 'On DEMO-EVAL, the last account picked. Armed is off.' && b.tab === null && await B.title() === 'MNQ · DEMO-EVAL · Live Chart',
      '1.6.1 two tabs: a new tab B opens on the last pick, DEMO-EVAL, Armed off: ' + JSON.stringify(b) + ' ' + await B.title());
    // the review's case: tab A has a DEMO-EVAL long with a working stop; tab B picks Sim101; tab A reloads
    await A.fill('#bStop', '40'); await A.press('#bStop', 'Tab'); await A.fill('#bTarget', '0'); await A.press('#bTarget', 'Tab');
    await A.click('#buyMkt');
    await until(async () => (await A.textContent('#oPos')).startsWith('LONG 1') && (await state5()).orders.length === 1, '1.6.1 tab A long 1 with a stop on DEMO-EVAL');
    await B.selectOption('#oAcct', 'Sim101'); await B.waitForTimeout(400);
    a = await acct(A); b = await acct(B);
    check(a.shown === 'DEMO-EVAL' && a.armed === 'true' && a.fills === 'DEMO-EVAL' && b.shown === 'Sim101' && a.stored === 'Sim101' && a.tab === 'DEMO-EVAL' && b.tab === 'Sim101',
      '1.6.1 two tabs: B picks Sim101 (saved for new tabs); A stays on DEMO-EVAL, still armed: ' + JSON.stringify({ a, b }));
    // review S3: tab B names the other account's live trade, in the warning color, on one line
    const other = await until(() => B.evaluate(() => { const el = document.getElementById('oOther'); return el.textContent ? { text: el.textContent, live: el.classList.contains('live'), h: el.getBoundingClientRect().height } : null; }), 'tab B shows DEMO-EVAL\'s trade');
    check(other && other.text === 'Other accounts on MNQ: DEMO-EVAL: LONG 1, 1 order' && other.live && other.h <= 20, '1.6.1 S3: the other account by name: ' + JSON.stringify(other));
    await shot(B, 'orders-1440-other-account-named.png');
    await reloadTab(A);
    a = await acct(A);
    check(a.shown === 'DEMO-EVAL' && a.armed === 'false' && a.note === 'On DEMO-EVAL, the account this tab was on. Armed is off.' && (await A.textContent('#oPos')).startsWith('LONG 1') && a.fills === 'DEMO-EVAL',
      '1.6.1 S1: tab A reloaded comes back on its own account, DEMO-EVAL, with its long: ' + JSON.stringify(a) + ' ' + await A.textContent('#oPos'));
    // a dropped connection, the page kept: no account changes, Armed off
    let n0 = await A.evaluate(() => window.__sent.filter(m => m.type === 'subscribe').length);
    await control(P5, 'drop');
    await until(() => A.evaluate(n => window.__sent.filter(m => m.type === 'subscribe').length > n, n0), '1.6.1 tab A reconnected', 15000);
    await tradingOn(A); await tradingOn(B);
    await until(async () => (await acct(A)).note === 'Still on DEMO-EVAL. Armed is off.', '1.6.1 the reconnect note in tab A');
    a = await acct(A); b = await acct(B);
    check(a.shown === 'DEMO-EVAL' && a.armed === 'false' && a.ring && b.shown === 'Sim101' && b.armed === 'false' && b.note === 'Still on Sim101. Armed is off.',
      '1.6.1 reconnect keeping the page: A still DEMO-EVAL, B still Sim101, both Armed off: ' + JSON.stringify({ a, b }));
    await shot(A, 'orders-1440-account-after-reconnect.png');
    // review S2: Armed on clears the note ("Armed is off" would contradict it)
    await A.click('#armBtn');
    check((await acct(A)).note === '' && (await acct(A)).armed === 'true', '1.6.1 S2: arming clears the note');
    await A.click('#armBtn');
    // review S2 and N3: trading off (the connection back, the sign-in held): the note goes; a pick then is named on return
    await A.evaluate(() => { window.__holdTrading = true; });
    n0 = await A.evaluate(() => window.__sent.filter(m => m.type === 'subscribe').length);
    await control(P5, 'drop');
    await until(() => A.evaluate(n => window.__sent.filter(m => m.type === 'subscribe').length > n, n0), '1.6.1 tab A reconnected, trading held off', 15000);
    await until(() => A.evaluate(() => document.getElementById('buyMkt').disabled && document.getElementById('connPill').textContent === 'LIVE'), '1.6.1 tab A live with trading off');
    check((await acct(A)).note === '', '1.6.1 S2: trading lost clears the note');
    await A.selectOption('#oAcct', 'Sim101'); await A.waitForTimeout(200);
    a = await acct(A);
    check(a.shown === 'Sim101' && a.note === '' && a.tab === 'Sim101', '1.6.1: a pick while trading is off: the picker shows it, no stale note: ' + JSON.stringify(a));
    await A.evaluate(() => { window.__holdTrading = false; });
    n0 = await A.evaluate(() => window.__sent.filter(m => m.type === 'subscribe').length);
    await control(P5, 'drop');
    await until(() => A.evaluate(n => window.__sent.filter(m => m.type === 'subscribe').length > n, n0), '1.6.1 tab A reconnected again', 15000);
    await tradingOn(A);
    await until(async () => (await acct(A)).note !== '', '1.6.1 the note after trading came back');
    a = await acct(A);
    check(a.shown === 'Sim101' && a.armed === 'false' && a.note === 'On Sim101 (picked while trading was off). Armed is off.', '1.6.1 N3: the note says the account changed while off: ' + JSON.stringify(a));
    // back on DEMO-EVAL: flatten the long (orders only for DEMO-EVAL, the account shown)
    await A.selectOption('#oAcct', 'DEMO-EVAL'); await A.waitForTimeout(200);
    await A.evaluate(() => { window.__sent.length = 0; });
    await A.click('#armBtn'); await A.click('#flattenBtn');
    await until(async () => (await A.textContent('#oPos')) === 'Flat' && (await state5()).orders.length === 0, '1.6.1 tab A flat on DEMO-EVAL');
    // review 2 S1, S2, N1, N2: a Cancel all goes out by id, 8 a second, and locks nothing: Armed, the picker, the
    // instrument and Flatten all work while it runs. The state row names what is still going out.
    await A.bringToFront();                                                           // tab B opened after A: timers of a tab behind run late
    const place = async (n, from) => { for (let i = 0; i < n; i++) await control(P5, 'elsewhere', { account: 'DEMO-EVAL', root: 'MNQ', side: 'buy', kind: 'limit', qty: 1, p: L5 - (from || 20) - i }); };
    const evalWorking = async () => (await state5()).orders.filter(o => o.account === 'DEMO-EVAL' && o.root === 'MNQ').length;
    // the orders on the chart, and 1.2 s since the last cancels (the page sends at most 8 in any 1.1 s)
    const onChart = async n => { await until(() => A.evaluate(k => window.liveChart.getOrders().length === k, n), '1.6.1 ' + n + ' DEMO-EVAL orders on the chart'); await A.waitForTimeout(1200); };
    const sentOf = type => A.evaluate(t => window.__sent.filter(m => m.type === t).map(m => ({ id: m.id, acct: window.__orderAcct[m.id], at: m.__at, account: m.account, root: m.root })), type);
    const bar = () => A.evaluate(() => ({ unsent: document.getElementById('unsentBar').hidden ? '' : document.getElementById('unsentText').textContent, batch: document.getElementById('oCancel').textContent,
      acct: document.getElementById('oAcct').disabled, arm: document.getElementById('armBtn').disabled, flatten: document.getElementById('flattenBtn').disabled, note: document.getElementById('oAcctNote').textContent }));
    const armOn = async () => { if (await A.getAttribute('#armBtn', 'aria-checked') !== 'true') await A.click('#armBtn'); };
    const armOff = async () => { if (await A.getAttribute('#armBtn', 'aria-checked') === 'true') await A.click('#armBtn'); };
    const batchDone = what => until(async () => (await bar()).batch === '' && await evalWorking() === 0, what, 8000);

    // 10 orders: nothing locked, the state row counts down, every cancel for DEMO-EVAL
    await place(10);
    await onChart(10);
    await A.evaluate(() => { window.__sent.length = 0; window.__rejects.length = 0; });
    await armOn(); await A.click('#cancelAllBtn');
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
    await armOn(); await A.click('#cancelAllBtn');
    await A.waitForTimeout(300);
    await A.click('#symSeg button[data-v="NQ"]');
    bb = await bar();
    const armedAfter = await A.getAttribute('#armBtn', 'aria-checked');
    check(armedAfter === 'false' && !bb.arm && /^Cancelling on DEMO-EVAL MNQ: \d+ left/.test(bb.batch), 'R15: after the switch Armed is off and not locked, the state row still names DEMO-EVAL MNQ: ' + JSON.stringify(bb));
    await until(() => A.evaluate(() => document.getElementById('connPill').textContent === 'LIVE'), 'R15 NQ loaded', 8000);
    await A.click('#armBtn'); await A.click('#flattenBtn');
    const fl15 = await sentOf('flatten');
    check(fl15.length === 1 && fl15[0].account === 'DEMO-EVAL' && fl15[0].root === 'NQ', 'R15: arm and Flatten on NQ right after the switch: ' + JSON.stringify(fl15));
    await until(async () => await evalWorking() === 0, 'R15 every MNQ order cancelled', 8000);
    cs = await sentOf('cancel');
    check(cs.length === 30 && cs.every(x => x.acct === 'DEMO-EVAL') && await evalWorking() === 0, 'R15: all 30 cancels sent by id, 0 DEMO-EVAL MNQ orders working: ' + cs.length);
    await until(async () => (await bar()).batch === '', 'R15 the batch note gone', 5000);
    await armOff();
    await A.click('#symSeg button[data-v="MNQ"]');
    await until(() => A.evaluate(() => document.getElementById('connPill').textContent === 'LIVE'), 'R15 back on MNQ', 8000);

    // R16: the connection drops 300 ms into a batch of 20: a note that stays (not a 6 s status line) names the account,
    // the instrument and the 14 cancels not sent; it stays over the reconnect and goes by itself once they are cancelled
    await place(20);
    await onChart(20);
    await A.evaluate(() => { window.__sent.length = 0; });
    await armOn(); await A.click('#cancelAllBtn');
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
    await A.click('#armBtn'); await A.click('#cancelAllBtn');
    await batchDone('R16 the rest cancelled');
    await until(async () => (await bar()).unsent === '', 'R16 the note goes once those orders are no longer working', 5000);
    await armOff();

    // R17: DEMO-EVAL leaves ChartBridge's list 300 ms into a batch of 20: the rest are not sent (ChartBridge would refuse
    // them), the note says why and stays until dismissed; the fallback note keeps its 15 s after the batch (N2)
    await place(20);
    await onChart(20);
    await A.evaluate(() => { window.__sent.length = 0; });
    await armOn(); await A.click('#cancelAllBtn');
    await A.waitForTimeout(300);
    await A.evaluate(() => window.__inject(Object.assign({}, window.__lastTrading, { accounts: ['Sim101'] })));
    await A.waitForTimeout(3000);                                                     // past where the batch would have ended
    bb = await bar();
    const a17 = await acct(A);
    check(/^14 cancels on DEMO-EVAL MNQ were not sent: the account is no longer a trade account in ChartBridge\./.test(bb.unsent) && (await sentOf('cancel')).length === 6 && a17.shown === 'Sim101' && a17.armed === 'false' && a17.note === 'Last account DEMO-EVAL not available, on Sim101.',
      'R17 and N2: 6 sent, the note says why, the fallback note still up 3 s later: ' + JSON.stringify({ unsent: bb.unsent, note: a17.note, shown: a17.shown }));
    await A.click('#unsentClose');
    check((await bar()).unsent === '', 'R17: Dismiss takes the note away');
    await A.evaluate(() => window.__inject(window.__lastTrading));                   // DEMO-EVAL allowed again
    await A.selectOption('#oAcct', 'DEMO-EVAL'); await A.waitForTimeout(200);
    await A.click('#armBtn'); await A.click('#cancelAllBtn');
    await batchDone('R17 the rest cancelled after DEMO-EVAL came back');
    await armOff();

    // R18: Flatten 300 ms into a batch of 20 with a position: flat, every order gone, and no cancel after the Flatten
    // (so no red "No working order" from ChartBridge)
    await armOn();
    await A.fill('#bStop', '0'); await A.press('#bStop', 'Tab');
    await A.click('#buyMkt');                                                         // the long first (the MNQ cap counts working orders)
    await until(async () => (await A.textContent('#oPos')).startsWith('LONG 1'), 'R18 long 1');
    await place(20);
    await onChart(20);
    await A.evaluate(() => { window.__sent.length = 0; window.__rejects.length = 0; });
    await A.waitForTimeout(1200);                                                     // ChartBridge's 10 a second counts the Buy too
    await A.click('#cancelAllBtn');
    await A.waitForTimeout(300);
    await A.click('#flattenBtn');
    await A.waitForTimeout(3000);
    const msgs18 = await A.evaluate(() => window.__sent.filter(m => ['cancel', 'flatten'].includes(m.type)).map(m => m.type));
    const rej18 = await A.evaluate(() => window.__rejects.slice());
    check((await A.textContent('#oPos')) === 'Flat' && await evalWorking() === 0 && msgs18.lastIndexOf('cancel') < msgs18.indexOf('flatten') && rej18.length === 0 && (await status(A)).cls.indexOf('error') < 0,
      'R18: Flatten mid-batch: flat, no order working, no cancel after it, no reject: ' + msgs18.join(',') + ' ' + JSON.stringify(rej18));
    await armOff();

    // R19: a second Cancel all 300 ms into a batch of 20 sends nothing new; never more than 8 in any second; none left
    await place(20);
    await onChart(20);
    await A.evaluate(() => { window.__sent.length = 0; window.__rejects.length = 0; window.__statusSeen.length = 0; });
    await armOn(); await A.click('#cancelAllBtn');
    await A.waitForTimeout(300);
    await A.click('#cancelAllBtn');
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
    await A.click('#buyMkt');
    await until(async () => (await A.textContent('#oPos')).startsWith('LONG 1'), 'R26 long 1 on DEMO-EVAL');
    await armOff();
    await place(30);
    for (let i = 0; i < 3; i++) await control(P5, 'elsewhere', { account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'limit', qty: 1, p: L5 - 60 - i });
    await onChart(30);
    await A.evaluate(() => { window.__sent.length = 0; window.__rejects.length = 0; });
    await armOn(); await A.click('#cancelAllBtn');
    await A.waitForTimeout(150);
    await A.selectOption('#oAcct', 'Sim101'); await A.waitForTimeout(100);
    await A.setViewportSize({ width: 390, height: 860 });
    await A.waitForTimeout(200);
    const r26 = await A.evaluate(() => { const c = document.getElementById('oCancel'), o = document.getElementById('oOther');
      return { batch: c.textContent, away: c.classList.contains('away'), color: getComputedStyle(c).color, other: o.textContent, cut: [c, o].map(el => el.scrollWidth > el.clientWidth + 1), sw: document.documentElement.scrollWidth }; });
    check(/^Cancelling on DEMO-EVAL MNQ: \d+ left/.test(r26.batch) && r26.away && /DEMO-EVAL: LONG 1/.test(r26.other) && !r26.cut[0] && !r26.cut[1] && r26.sw <= 390,
      'R26 at 390 px: the batch line in the warning color and "Other accounts" with LONG 1, both whole: ' + JSON.stringify(r26));
    await shot(A, 'orders-390-cancel-all-other-account.png');
    await A.setViewportSize({ width: 1440, height: 860 });
    await A.click('#armBtn');
    const t26 = await A.evaluate(() => performance.now());
    await A.click('#cancelAllBtn');
    await until(async () => (await state5()).orders.filter(o => o.account === 'Sim101').length === 0, 'R26 Sim101 cancelled', 8000);
    const c26 = await A.evaluate(t => window.__sent.filter(m => m.type === 'cancel' && m.__at >= t).map(m => ({ acct: window.__orderAcct[m.id], dt: Math.round(m.__at - t) })), t26);
    const sims = c26.filter(x => x.acct === 'Sim101'), evalAfter = c26.filter(x => x.acct === 'DEMO-EVAL');
    check(sims.length === 3 && c26.slice(0, 3).every(x => x.acct === 'Sim101') && sims.every(x => x.dt <= 1300),
      'R26: Sim101\'s 3 cancels are the first sent after its click, at the next slot of the pace (' + sims.map(x => x.dt).join(', ') + ' ms), DEMO-EVAL\'s rest (' + evalAfter.length + ') after them');
    await batchDone('R26 DEMO-EVAL\'s rest cancelled');
    await armOff();
    await A.selectOption('#oAcct', 'DEMO-EVAL'); await A.waitForTimeout(200);

    // R23 (review 3 S4): long 1 and 30 orders; Cancel all, Buy MKT +100 ms, Sell MKT +200 ms, Flatten +300 ms: at 6 a
    // second the batch leaves room, so nothing is refused and the account ends flat
    await place(30);
    await onChart(30);
    await A.evaluate(() => { window.__sent.length = 0; window.__rejects.length = 0; });
    await armOn(); await A.click('#cancelAllBtn');
    await A.waitForTimeout(100); await A.click('#buyMkt');
    await A.waitForTimeout(100); await A.click('#sellMkt');
    await A.waitForTimeout(100); await A.click('#flattenBtn');
    await until(async () => (await A.textContent('#oPos')) === 'Flat' && await evalWorking() === 0, 'R23 flat, nothing working', 8000);
    const rej23 = await A.evaluate(() => window.__rejects.slice());
    check(rej23.length === 0 && (await A.textContent('#oPos')) === 'Flat', 'R23: Cancel all, Buy, Sell and Flatten within 300 ms: none refused, flat: ' + JSON.stringify(rej23));
    // and if ChartBridge refuses Flatten for the rate anyway, the page sends it once more 1.1 s later (a made-up refusal)
    await A.waitForTimeout(1200);                                                     // past Flatten's 0.4 s repeat guard and the last refusal's window
    await A.evaluate(() => { window.__sent.length = 0; window.__statusSeen.length = 0; });
    await A.click('#flattenBtn');
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
    await armOn(); await A.click('#cancelAllBtn');
    const sentNow = await A.evaluate(() => window.__sent.filter(m => m.type === 'cancel').map(m => m.id));
    const queued = (await A.evaluate(() => window.liveChart.getOrders().map(o => ({ id: o.id, price: o.price })))).find(o => !sentNow.includes(o.id));
    await settle(queued.price);
    const hq = await handle(queued.id), bq = await A.locator('#chart canvas').boundingBox();
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
    await A.evaluate(() => { document.getElementById('cancelAllBtn').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); document.getElementById('armBtn').click(); });
    await until(async () => await evalWorking() === 0, 'N1 the three cancelled');
    check((await sentOf('cancel')).length === 3 && await A.getAttribute('#armBtn', 'aria-checked') === 'false', 'review 2 N1: 3 of 3 sent though Armed went off in the same task');
    // B/E in paced chunks (Anthony 2026-10-01): with 12 ChartBridge stop legs one click sends 10 at once and the last 2
    // once ChartBridge's 10 a second allows; a second click while it runs sends nothing; never over 10 in any second
    const brKept = [await A.inputValue('#bStop'), await A.inputValue('#bTarget')];
    const commitA = async (id, v) => { await A.fill(id, v); await A.press(id, 'Tab'); };
    const stopLegs = async () => (await state5()).orders.filter(o => o.account === 'DEMO-EVAL' && o.root === 'MNQ' && o.role === 'stop');
    const changesSent = () => A.evaluate(() => window.__sent.filter(m => m.type === 'change').map(m => ({ id: m.id, price: m.price, at: m.__at })));
    const legs12 = async what => {
      await control(P5, 'price', { root: 'MNQ', p: L5 });
      await A.selectOption('#oQty', '1');
      await armOn();
      for (let i = 0; i < 12; i++) { await A.click('#buyMkt'); await A.waitForTimeout(450); }
      await until(async () => (await stopLegs()).length === 12 && (await A.textContent('#oPos')).startsWith('LONG 12'), what, 8000);
      await control(P5, 'price', { root: 'MNQ', p: L5 + 2 });                        // past break-even (L5, every fill at L5)
      await A.waitForTimeout(1200);                                                   // the buys out of ChartBridge's last second
      await A.evaluate(() => { window.__sent.length = 0; window.__rejects.length = 0; window.__statusSeen.length = 0; });
    };
    const flatA = async what => { await armOn(); await A.click('#flattenBtn'); await until(async () => (await A.textContent('#oPos')) === 'Flat' && await evalWorking() === 0, what); };
    await commitA('#bStop', '40'); await commitA('#bTarget', '0');
    await legs12('B/E paced: long 12 with 12 stop legs');
    await A.click('#beBtn');
    await A.waitForTimeout(500);
    await A.click('#beBtn');                                                          // while the run is under way: absorbed
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
    await A.click('#beBtn');
    await A.waitForTimeout(300);
    await armOff();
    await A.waitForTimeout(1600);
    const chOff = await changesSent(), seenOff = await A.evaluate(() => window.__statusSeen.slice());
    const atBe = (await stopLegs()).filter(o => o.price === L5).length;
    check(chOff.length === 10 && atBe === 10 && seenOff.some(t => /^B\/E: 10 changes sent to break-even [\d,.]+ · DEMO-EVAL MNQ\. 2 not sent: Armed went off\.$/.test(t)),
      'B/E paced: Armed off mid-run stops the rest (' + chOff.length + ' changes, ' + atBe + ' legs moved): ' + JSON.stringify(seenOff));
    await flatA('B/E paced: flat after the disarm test');
    await commitA('#bStop', brKept[0]); await commitA('#bTarget', brKept[1]);
    await armOff();

    // a phone: the note never wraps the order bar
    await B.setViewportSize({ width: 400, height: 860 });
    await reloadTab(B);
    const n400 = await B.evaluate(() => { const n = document.getElementById('oAcctNote'); return { text: n.textContent, h: n.getBoundingClientRect().height, sw: document.documentElement.scrollWidth }; });
    check(n400.text === 'On Sim101, the account this tab was on. Armed is off.' && n400.h <= 20 && n400.sw <= 400, '1.6.1 400 px: the note on one line, no sideways scroll: ' + JSON.stringify(n400));
    await shot(B, 'orders-400-account-restored.png');
    const barB = await obarBox(B);
    await B.click('#armBtn');
    check(await B.title() === 'ARMED · MNQ · Sim101' && await B.textContent('#armPill') === 'ARMED · Sim101' && await obarBox(B) === barB && await B.evaluate(() => document.documentElement.scrollWidth <= 400),
      '1.6.1 S5 at 400 px: title and pill name the account, the order bar keeps its size (' + barB + '), no sideways scroll');
    await shot(B, 'orders-400-armed-account.png');
    await B.click('#armBtn');
    await ctx.close();
  }

  /* ---------------- trading off in config.txt: the bar says why, every control disabled */
  await startBridge(PORT + 1, ['--test-pin=' + TEST_PIN]);
  const off = await open(browser, PORT + 1, 1440);
  await until(() => off.evaluate(() => !document.getElementById('obar').hidden), 'disabled bar visible');
  check(/Trading off: Trading is off\. Set trading = true in config\.txt/.test(await off.textContent('#oOff')), 'reason shown: ' + await off.textContent('#oOff'));
  const enabled = await off.$$eval('#obar button, #obar input, #obar select', els => els.filter(e => !e.disabled).map(e => e.id));
  check(JSON.stringify(enabled) === '["oAcct"]', 'while trading is off only the account picker works: ' + enabled.join(','));
  check(/^Trading is off: this picks whose fills the chart marks, and the account orders go to when trading comes back on$/.test(await off.getAttribute('#oAcct', 'title')), 'trading off: the picker says what it picks (1.6.1: also the account used when trading comes back): ' + await off.getAttribute('#oAcct', 'title'));
  // trading off: the picker still switches whose fills are marked (the accounts ChartBridge knows)
  check(await off.isHidden('#acctWrap') && await off.inputValue('#oAcct') === 'Sim101' && /Sim101/.test(await off.textContent('#lgFill')), 'trading off: Sim101 picked, its fills marked');
  await off.selectOption('#oAcct', 'DEMO-EVAL'); await off.waitForTimeout(200);
  check(/DEMO-EVAL/.test(await off.textContent('#lgFill')), 'trading off: the account switches and the fills follow');
  await shot(off, 'orders-1440-trading-off-account.png');
  await off.reload(); await unlockIfAsked(off); await off.waitForFunction(() => document.getElementById('connPill').textContent === 'LIVE', null, { timeout: 15000 });
  await off.waitForTimeout(400);
  check(await off.inputValue('#oAcct') === 'DEMO-EVAL', 'trading off: the account is remembered');
  check(/^Read only/.test(await off.textContent('#statusRo')), 'footer read only');
  await shot(off, 'orders-1440-trading-off.png');
  const offPhone = await open(browser, PORT + 1, 400, 860);
  await noSideScroll(offPhone, 400);
  await shot(offPhone, 'orders-400-trading-off.png');
  await offPhone.close(); await off.close();

  /* ---------------- clickjacking: ChartBridge refuses frames; the page also refuses to trade inside one */
  const host = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  await host.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await host.setContent(`<iframe id="f" src="http://localhost:${PORT}/live/single.html" style="width:1260px;height:860px;border:0"></iframe>`);
  await host.waitForTimeout(2500);
  const blocked = host.frames().find(f => f !== host.mainFrame());
  check(!blocked || !(await blocked.evaluate(() => !!document.getElementById('connPill')).catch(() => false)), 'ChartBridge page loaded inside a frame');
  await startBridge(PORT + 3, ['--trading', '--trade-accounts=Sim101', '--allow-frames', '--test-pin=' + TEST_PIN]);
  await host.setContent(`<iframe id="f" src="http://localhost:${PORT + 3}/live/single.html" style="width:1260px;height:860px;border:0"></iframe>`);
  const pinFrame = await until(async () => host.frames().find(x => x !== host.mainFrame() && /\/live\/single\.html$/.test(x.url())), 'framed page', 15000);
  if (pinFrame) await unlockIfAsked(pinFrame).catch(e => fail('framed page PIN: ' + e.message));
  const fr = await until(async () => { const f = host.frames().find(x => x !== host.mainFrame()); return f && await f.evaluate(() => document.getElementById('connPill') && document.getElementById('connPill').textContent === 'LIVE').catch(() => false) ? f : null; }, 'framed page loads with --allow-frames', 15000);
  if (fr) {
    await fr.waitForTimeout(800);
    check(/inside another page/.test(await fr.textContent('#oOff')), 'framed page says why it cannot trade: ' + await fr.textContent('#oOff'));
    check(await fr.isDisabled('#armBtn'), 'framed page cannot arm');
    await shot(host, 'orders-framed-refused.png');
  }
  await host.close();

  /* ---------------- hello with no accounts, then the sign-in turns trading on: the picker works (review 2, S1) */
  await startBridge(PORT + 4, ['--trading', '--trade-accounts=Sim101,DEMO-EVAL', '--no-hello-accounts', '--test-pin=' + TEST_PIN]);
  {
    const na = await open(browser, PORT + 4, 1440);
    await until(() => na.evaluate(() => !document.getElementById('buyMkt').disabled), 'trading on after an empty hello');
    const r = await na.evaluate(() => ({ disabled: document.getElementById('oAcct').disabled, options: [...document.getElementById('oAcct').options].map(o => o.value), title: document.getElementById('oAcct').title, toolbar: document.getElementById('acctWrap').hidden }));
    check(!r.disabled && JSON.stringify(r.options) === '["Sim101","DEMO-EVAL"]' && /^Orders go to this account/.test(r.title) && r.toolbar, 'empty hello, then trading: the order bar picker is enabled with the trade accounts: ' + JSON.stringify(r));
    await na.selectOption('#oAcct', 'DEMO-EVAL');
    check(await na.inputValue('#oAcct') === 'DEMO-EVAL', 'and the order account can be changed');
    await na.close();
  }
  /* ---------------- connecting (no hello yet): the trading page shows no toolbar picker, so the toolbar never jumps (review 2, N4) */
  {
    const cn = await browser.newPage({ viewport: { width: 1680, height: 860 } });
    await cn.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await cn.addInitScript(() => { window.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} }; });   // never connects
    await cn.goto(`http://localhost:${PORT + 4}/live/single.html`);
    await unlockIfAsked(cn);
    await cn.waitForFunction(() => document.getElementById('connPill') && document.getElementById('connPill').textContent === 'CONNECTING', null, { timeout: 15000 });
    await cn.waitForTimeout(300);
    check(await cn.isHidden('#acctWrap'), 'trading page while connecting: no toolbar account picker');
    await cn.close();
  }

  /* ---------------- ChartBridge 0.2 (protocol v1): read only exactly as before */
  await startBridge(PORT + 2, ['--v1']);
  const v1 = await open(browser, PORT + 2, 1440);
  await v1.waitForTimeout(500);
  check(await v1.isHidden('#obar'), 'no order bar with ChartBridge 0.2');
  check(await v1.textContent('#statusRo') === 'Read only. Orders are placed in NinjaTrader. Live CME data is for this screen only.', 'v1 footer');
  check(/Last fill (BUY|SELL)/.test(await v1.textContent('#legend')), 'v1 fills still shown');
  check(await v1.isVisible('#acctPick') && JSON.stringify(await v1.$$eval('#acctPick option', os => os.map(o => o.value))) === '["DEMO-EVAL","Sim101","DEMO-EMPTY"]', 'no order bar: the compact account picker in the toolbar, no "All accounts"');
  await shot(v1, 'orders-1440-v1-read-only.png');
  await v1.close();
} finally {
  await browser.close();
  for (const b of bridges) b.kill();
}
if (errors.length) { console.error('FAIL\n' + errors.join('\n')); process.exit(1); }
console.log('orders smoke: ok (' + checks + ' checks)');
