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
const check = (ok, m) => { if (!ok) fail(m); };
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
  await page.goto(`http://localhost:${port}/live/`);
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
  await startBridge(PORT, ['--trading', '--trade-accounts=Sim101,DEMO-EVAL', '--max-qty=MNQ:5', '--test-controls', '--test-pin=' + TEST_PIN]);
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
  check(await page.getAttribute('#oQty', 'max') === '5', 'qty max 5');
  check(await page.getAttribute('#armBtn', 'aria-checked') === 'false', 'Armed off after load');
  check(/Trading through ChartBridge/.test(await page.textContent('#statusRo')), 'footer says trading');

  // Armed off: buttons, Shift+click and flatten send nothing
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
  await shot(page, 'orders-1440-disarmed.png');

  // arm, bracket 40 / 80 ticks, buy 2 at market
  await page.click('#armBtn');
  check(await page.getAttribute('#armBtn', 'aria-checked') === 'true', 'armed');
  check((await page.title()).startsWith('ARMED'), 'title shows ARMED');
  check(await page.isVisible('#armPill'), 'ARMED pill on the chart legend');
  await page.fill('#bStop', '40'); await page.press('#bStop', 'Tab');
  await page.fill('#bTarget', '80'); await page.press('#bTarget', 'Tab');
  await page.fill('#oQty', '2');
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

  // Sell side below the market: a sell stop. Long 2 with a 40 / 80 bracket set: the page sends no bracket on this
  // reducing order (ChartBridge would refuse one), so it is accepted.
  await page.click('#sideSeg >> text="Sell"');
  box = await cbox();
  await page.keyboard.down('Shift'); await page.mouse.click(px, box.y + await yAt(L - 5)); await page.keyboard.up('Shift');
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
  await page.click('#sideSeg >> text="Buy"');
  await page.fill('#oQty', '2');
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
  await page.fill('#oQty', '1');
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

  // rejects: qty over the cap (stopped in the page), and a ChartBridge refusal (more than 200 ticks away)
  await page.fill('#oQty', '9');
  await page.click('#buyMkt');
  st = await status(page);
  check(/Not sent: Qty 9 is over the MNQ cap of 5/.test(st.text) && /error/.test(st.cls), 'over-cap qty refused: ' + st.text);
  await shot(page, 'orders-1440-reject-qty.png');
  await page.fill('#oQty', '1');
  await page.click('#sideSeg >> text="Buy"');
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
    await startBridge(P5, ['--trading', '--trade-accounts=Sim101,DEMO-EVAL', '--max-qty=MNQ:5', '--test-controls', '--test-pin=' + TEST_PIN]);
    const L5 = Math.round((await control(P5, 'hold', { root: 'MNQ' })).last);
    await control(P5, 'price', { root: 'MNQ', p: L5 });
    const state5 = () => control(P5, 'state', { root: 'MNQ' });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 1 });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    // every message a page sends, and the account of every order ChartBridge reports to it
    await ctx.addInitScript(() => {
      window.__sent = []; window.__orderAcct = {};
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (d) { try { window.__sent.push(JSON.parse(d)); } catch (e) { /* not JSON */ } return send.call(this, d); };
      const d = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
      Object.defineProperty(WebSocket.prototype, 'onmessage', { configurable: true, get() { return d.get.call(this); }, set(fn) {
        d.set.call(this, ev => {
          try { const m = JSON.parse(ev.data); if (m.type === 'order' && m.id) window.__orderAcct[m.id] = m.account; if (m.type === 'trading' && window.__holdTrading) return; } catch (e) { /* not JSON */ }
          return fn(ev);   // __holdTrading: the sign-in answer held back, so trading stays off after a reconnect
        });
      } });
    });
    const tradingOn = pg => until(() => pg.evaluate(() => !document.getElementById('buyMkt').disabled && document.getElementById('connPill').textContent === 'LIVE'), 'trading on', 15000);
    const openTab = async () => {
      const pg = await ctx.newPage();
      pg.on('pageerror', e => fail('1.6.1 pageerror: ' + e.message));
      pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|WebSocket connection/.test(m.text())) fail('1.6.1 console: ' + m.text()); });
      await pg.goto(`http://localhost:${P5}/live/`);
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
    // review N1: a Cancel all of more than 8 locks the picker and Armed until its last cancel is sent; Flatten stays free
    for (let i = 0; i < 10; i++) await control(P5, 'elsewhere', { account: 'DEMO-EVAL', root: 'MNQ', side: 'buy', kind: 'limit', qty: 1, p: L5 - 20 - i });
    await until(() => A.evaluate(() => window.liveChart.getOrders().length === 10), '1.6.1 ten DEMO-EVAL orders on the chart');
    await A.evaluate(() => { window.__sent.length = 0; });
    await A.click('#cancelAllBtn');
    const lock = await A.evaluate(() => ({ acct: document.getElementById('oAcct').disabled, arm: document.getElementById('armBtn').disabled, flatten: document.getElementById('flattenBtn').disabled, note: document.getElementById('oAcctNote').textContent }));
    check(lock.acct && lock.arm && !lock.flatten && /^Cancelling\.\.\. DEMO-EVAL and Armed are locked/.test(lock.note), '1.6.1 N1: during the batch the picker and Armed are locked, Flatten is not: ' + JSON.stringify(lock));
    await shot(A, 'orders-1440-cancel-all-locked.png');
    await until(async () => (await state5()).orders.length === 0 && await A.evaluate(() => !document.getElementById('oAcct').disabled && !document.getElementById('armBtn').disabled && document.getElementById('oAcctNote').textContent === ''), '1.6.1 N1: all ten cancelled, then unlocked', 6000);
    const cancels = await A.evaluate(() => window.__sent.filter(m => m.type === 'cancel').map(m => window.__orderAcct[m.id]));
    check(cancels.length === 10 && cancels.every(x => x === 'DEMO-EVAL'), '1.6.1 N1: ten cancels, all DEMO-EVAL: ' + cancels.join());
    await A.click('#armBtn');
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
  await host.setContent(`<iframe id="f" src="http://localhost:${PORT}/live/" style="width:1260px;height:860px;border:0"></iframe>`);
  await host.waitForTimeout(2500);
  const blocked = host.frames().find(f => f !== host.mainFrame());
  check(!blocked || !(await blocked.evaluate(() => !!document.getElementById('connPill')).catch(() => false)), 'ChartBridge page loaded inside a frame');
  await startBridge(PORT + 3, ['--trading', '--trade-accounts=Sim101', '--allow-frames', '--test-pin=' + TEST_PIN]);
  await host.setContent(`<iframe id="f" src="http://localhost:${PORT + 3}/live/" style="width:1260px;height:860px;border:0"></iframe>`);
  const pinFrame = await until(async () => host.frames().find(x => x !== host.mainFrame() && /\/live\/$/.test(x.url())), 'framed page', 15000);
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
    await cn.goto(`http://localhost:${PORT + 4}/live/`);
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
console.log('orders smoke: ok');
