// Release 1, Bot-Lab plan step 1.6c smoke (Anthony 2026-11-17, the mini ticket mockup): the mini ticket and Cut half in the
// workspace. Against the fake bridge (--v3: made-up accounts, trade accounts Sim101 and EVAL-A; sample prices only), at 1366 x 768:
//   npm run smoke:mini-ticket       (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
// Checks: the regular ticket's Close is Flatten and Cut half sits beside it; Mini ticket is added from a chart's Indicators menu;
// compact it shows Armed, Qty, Buy MKT, Sell MKT, Flatten, Cut half and Merge (Merge greyed, one stop) and no account picker; its
// Qty and Armed are the ticket's (a change on one shows on the other); a Buy from it goes as the ticket's; Cut half with Armed off
// sends one cutHalf, the position halves and the stop and target follow to the size left; 3 closes 1 and keeps 2; at 1 it is
// greyed; the arrow shows every control with the account picker, the ticket's same choice; its grip drags it and its spot is kept
// after a reload; a second window (no ticket) forwards Cut half to the ticket's window; on a chart of another instrument it says
// so and every order button is off. Screenshots test/out/mini-ticket-*.png.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.MINI_TICKET_SMOKE_PORT || 8806);
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const errors = [];
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, what, ms) => { const end = Date.now() + (ms || 10000); for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); } };
const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--v3', '--trading', '--test-controls', '--max-qty=MNQ:9,NQ:9', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => bridge.stdout.once('data', r));
const control = async (what, q) => (await fetch(`http://127.0.0.1:${PORT}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
const state = async r => control('state', { root: r || 'MNQ' });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const tk = i => `.ws-panel.ticket [data-tk-id="${i}"]`;
const sendSpy = () => {
  window.__sent = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (['order', 'change', 'cancel', 'flatten', 'cutHalf', 'merge'].includes(m.type)) window.__sent.push(Object.assign({ at: Date.now() }, m)); } catch (e) { /* not JSON */ } return send.call(this, d); };
};
async function open(ctx, first) {
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  await p.goto(`http://localhost:${PORT}/live/?layout=Main`);
  if (first) { await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN); }
  else await p.waitForSelector('.cb-pin-key', { timeout: 15000 }).then(() => enterPin(p, TEST_PIN)).catch(() => {});
  await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live') && window.workspace.ticket().enabled, null, { timeout: 40000 });
  return p;
}
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(sendSpy);
  for (const R of ['MNQ', 'NQ', 'ES']) await control('price', { root: R, p: R === 'ES' ? 6000 : 21480 });
  const p = await open(ctx, true);
  const sent = (pg, type) => pg.evaluate(t => window.__sent.filter(m => m.type === t), type);
  const clearSent = pg => pg.evaluate(() => { window.__sent.length = 0; });
  await until(() => p.evaluate(() => window.workspace.ticket().held), 'this window holds the ticket');
  const charts = await p.evaluate(() => window.workspace.panels().filter(x => x.type === 'chart').map(x => ({ id: x.id, root: x.root })));
  const mnq = charts.find(c => c.root === 'MNQ'), nq = charts.find(c => c.root === 'NQ');
  const P = id => `.ws-panel[data-id="${id}"]`, M = (id, i) => `${P(id)} .mini-tk [data-mt-id="${i}"]`;

  /* the regular ticket: Close is Flatten, Cut half beside it */
  const btns = await p.$$eval('.ws-panel.ticket .tk-three button', bs => bs.filter(b => !b.hidden).map(b => b.textContent));
  check(JSON.stringify(btns.slice(0, 4)) === JSON.stringify(['B/E', 'Flatten', 'Cut half', 'Cancel all']), 'the ticket: B/E, Flatten (was Close), Cut half, Cancel all: ' + JSON.stringify(btns));
  await p.selectOption(tk('oAcct'), 'Sim101'); await wait(300);
  await p.fill(tk('bStop'), '20'); await p.press(tk('bStop'), 'Tab');
  await p.fill(tk('bTarget'), '40'); await p.press(tk('bTarget'), 'Tab');

  /* the mini ticket from the chart's Indicators menu */
  await p.click(P(mnq.id) + ' .ind-btn');
  await p.fill(P(mnq.id) + ' .ind-search input', 'mini');
  await until(() => p.$(P(mnq.id) + ' [data-f="add:ticket"]'), 'Mini ticket in the menu');
  await p.click(P(mnq.id) + ' [data-f="add:ticket"]');
  await p.keyboard.press('Escape');
  await until(() => p.$(P(mnq.id) + ' .mini-tk'), 'the mini ticket on the chart');
  const shown = await p.$eval(P(mnq.id) + ' .mini-tk', el => [...el.querySelectorAll('button, select')].filter(x => x.offsetParent !== null).map(x => x.dataset.mtId));
  check(['armBtn', 'oQty', 'buyMkt', 'sellMkt', 'flattenBtn', 'cutHalfBtn', 'mergeBtn'].every(x => shown.includes(x)) && !shown.includes('oAcct') && !shown.includes('beBtn') && !shown.includes('cancelAllBtn') && !shown.includes('bPreset'),
    'compact: Armed, Qty, Buy, Sell, Flatten, Cut half, Merge; no account picker, no B/E or Cancel all: ' + JSON.stringify(shown));
  check(await p.$eval(M(mnq.id, 'cutHalfBtn'), b => b.disabled) && /needs 2 or more/.test(await p.$eval(M(mnq.id, 'cutHalfBtn'), b => b.title)), 'flat: Cut half greyed, its hover says why');
  /* Qty and Armed are the ticket's */
  await p.selectOption(M(mnq.id, 'oQty'), '4'); await wait(300);
  check((await p.$eval(tk('oQty'), s => s.value)) === '4', 'Qty 4 picked on the mini ticket: the ticket shows 4');
  await p.click(M(mnq.id, 'armBtn')); await wait(300);
  check((await p.$eval(tk('armBtn'), b => b.getAttribute('aria-checked'))) === 'true' && (await p.$eval(M(mnq.id, 'armBtn'), b => b.getAttribute('aria-checked'))) === 'true', 'Armed on the mini ticket: the ticket is Armed (one switch)');
  await clearSent(p);
  await p.click(M(mnq.id, 'buyMkt'));
  const pos4 = await until(async () => { const s = await state(); return s.positions['Sim101|MNQ'] && s.positions['Sim101|MNQ'].qty === 4 && s.orders.filter(o => o.account === 'Sim101' && o.role === 'stop').length ? s : null; }, 'long 4 with its stop');
  const buy = (await sent(p, 'order'))[0];
  check(!!buy && buy.account === 'Sim101' && buy.qty === 4 && buy.side === 'buy' && buy.kind === 'market' && buy.bracket && buy.bracket.stop === 20, 'Buy MKT from the mini ticket: the ticket\'s order (Sim101, 4, its bracket): ' + JSON.stringify(buy));
  await p.screenshot({ path: path.join(out, 'mini-ticket-compact-1366.png') });
  await p.locator(P(mnq.id) + ' .mini-tk').screenshot({ path: path.join(out, 'mini-ticket-compact-zoom.png') });
  /* Cut half with Armed off */
  await p.click(M(mnq.id, 'armBtn')); await wait(300);
  check((await p.$eval(tk('armBtn'), b => b.getAttribute('aria-checked'))) === 'false', 'Armed off from the mini ticket');
  check(!(await p.$eval(M(mnq.id, 'cutHalfBtn'), b => b.disabled)) && /close 2 of 4/.test(await p.$eval(M(mnq.id, 'cutHalfBtn'), b => b.title)), 'long 4: Cut half on, it says close 2 of 4, Armed off');
  await clearSent(p);
  await p.$eval(M(mnq.id, 'note'), el => { window.__notes = []; new MutationObserver(() => window.__notes.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true }); });
  await p.click(M(mnq.id, 'cutHalfBtn'));
  const s2 = await until(async () => { const s = await state(); return s.positions['Sim101|MNQ'].qty === 2 ? s : null; }, 'long 2 after Cut half');
  const cuts = await sent(p, 'cutHalf');
  check(cuts.length === 1 && cuts[0].account === 'Sim101' && cuts[0].root === 'MNQ' && cuts[0].position === 4, 'one cutHalf with the position shown: ' + JSON.stringify(cuts));
  const legs2 = s2 ? s2.orders.filter(o => o.account === 'Sim101' && (o.role === 'stop' || o.role === 'target')).map(o => o.role + ' ' + (o.qty - o.filled)) : [];
  check(legs2.length === 2 && legs2.every(x => / 2$/.test(x)), 'the stop and the target follow to 2: ' + JSON.stringify(legs2));
  const notes = await p.evaluate(() => window.__notes);   // an order event's note may follow it
  check(notes.some(n => /^Cut half sent for Sim101 MNQ: close 2 of 4 at market; the stop and target shrink to 2\.$/.test(n)), 'its note says what was sent: ' + JSON.stringify(notes));
  /* odd: 3 closes 1 and keeps 2 */
  await p.click(M(mnq.id, 'armBtn')); await p.selectOption(M(mnq.id, 'oQty'), '1'); await wait(200);
  await p.click(M(mnq.id, 'buyMkt'));
  await until(async () => (await state()).positions['Sim101|MNQ'].qty === 3, 'long 3');
  await wait(600);
  await p.click(M(mnq.id, 'cutHalfBtn'));
  const s3 = await until(async () => { const s = await state(); return s.positions['Sim101|MNQ'].qty === 2 ? s : null; }, 'long 2 after cutting 3');
  check(!!s3, 'long 3: Cut half closes 1 and keeps 2');
  await wait(600);
  await p.click(M(mnq.id, 'cutHalfBtn'));
  await until(async () => (await state()).positions['Sim101|MNQ'].qty === 1, 'long 1');
  await wait(600);
  check(await p.$eval(M(mnq.id, 'cutHalfBtn'), b => b.disabled), 'at 1 contract Cut half is greyed');
  check(!(await p.$eval(M(mnq.id, 'mergeBtn'), b => b.hidden)) && await p.$eval(M(mnq.id, 'mergeBtn'), b => b.disabled), 'Merge shows (the switch is on) and is greyed with one stop, as on the ticket');

  /* the arrow: every control, the account picker the ticket's same choice */
  await p.click(M(mnq.id, 'chev')); await wait(300);
  const open1 = await p.$eval(P(mnq.id) + ' .mini-tk', el => ({ acct: el.querySelector('[data-mt-id="oAcct"]').value, picker: el.querySelector('[data-mt-id="oAcct"]').offsetParent !== null,
    be: el.querySelector('[data-mt-id="beBtn"]').offsetParent !== null, cancel: el.querySelector('[data-mt-id="cancelAllBtn"]').offsetParent !== null, bracket: el.querySelector('[data-mt-id="bStop"]').value, merge: el.querySelector('[data-mt-id="mergeBtn"]').offsetParent !== null }));
  check(open1.picker && open1.acct === 'Sim101' && open1.be && open1.cancel && open1.bracket === '20' && open1.merge, 'expanded: the account picker (Sim101, the ticket\'s), B/E, Cancel all, the bracket (20), Merge: ' + JSON.stringify(open1));
  await p.selectOption(M(mnq.id, 'oAcct'), 'EVAL-A'); await wait(300);
  check((await p.$eval(tk('oAcct'), s => s.value)) === 'EVAL-A', 'the account picked on the mini ticket is the ticket\'s');
  await p.selectOption(tk('oAcct'), 'Sim101'); await wait(300);
  check((await p.$eval(M(mnq.id, 'oAcct'), s => s.value)) === 'Sim101', 'and back from the ticket');
  await p.screenshot({ path: path.join(out, 'mini-ticket-expanded-1366.png') });
  await p.locator(P(mnq.id) + ' .mini-tk').screenshot({ path: path.join(out, 'mini-ticket-expanded-zoom.png') });
  await p.click(M(mnq.id, 'chev')); await wait(200);

  /* the grip: dragged, kept for this chart after a reload */
  const g = await p.$eval(M(mnq.id, 'grip'), b => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await p.mouse.move(g.x, g.y); await p.mouse.down(); await p.mouse.move(g.x - 300, g.y + 120, { steps: 8 }); await p.mouse.up();
  await wait(300);
  const at1 = await p.$eval(P(mnq.id) + ' .mini-tk', el => ({ left: el.style.left, top: el.style.top }));
  const saved = await p.evaluate(id => JSON.parse(localStorage.getItem('live-mini-ticket-v1') || '{}')[id], mnq.id);
  check(!!saved && Math.abs(saved.x - parseFloat(at1.left)) <= 1 && Math.abs(saved.y - parseFloat(at1.top)) <= 1, 'dragged by its grip, its spot saved for this chart: ' + JSON.stringify([at1, saved]));

  /* a second window: no ticket; its mini ticket forwards to the ticket's window */
  const p2 = await open(ctx, false);
  await until(() => p2.$(P(mnq.id) + ' .mini-tk'), 'the mini ticket in the second window (the chart\'s indicators are this browser\'s)');
  await until(async () => (await p2.$eval(M(mnq.id, 'oAcct'), s => s.value)) === 'Sim101', 'the second window shows the ticket\'s account');
  await p.click(M(mnq.id, 'armBtn')); await p.selectOption(M(mnq.id, 'oQty'), '3'); await wait(200);
  await p.click(M(mnq.id, 'buyMkt'));
  await until(async () => (await state()).positions['Sim101|MNQ'].qty === 4, 'long 4 again');
  await p.click(M(mnq.id, 'armBtn')); await wait(800);
  await clearSent(p); await clearSent(p2);
  await until(() => p2.$eval(M(mnq.id, 'cutHalfBtn'), b => !b.disabled), 'Cut half on in the second window');
  await p2.click(M(mnq.id, 'cutHalfBtn'));
  await until(async () => (await state()).positions['Sim101|MNQ'].qty === 2, 'long 2 after the forwarded Cut half');
  const c1 = await sent(p, 'cutHalf'), c2 = await sent(p2, 'cutHalf');
  check(c1.length === 1 && c2.length === 0 && c1[0].position === 4, 'Cut half in the window without the ticket goes to the ticket\'s window and is sent there: ' + JSON.stringify([c1, c2]));
  await p2.click(M(mnq.id, 'armBtn')); await wait(300);
  check((await p.$eval(tk('armBtn'), b => b.getAttribute('aria-checked'))) === 'false' && /arm it in the ticket's window/.test(await p2.$eval(M(mnq.id, 'note'), e => e.textContent)), 'Armed in the second window says to arm it in the ticket\'s window; nothing changes');
  await p2.screenshot({ path: path.join(out, 'mini-ticket-second-window-1366.png') });
  await p2.close();

  /* on a chart of another instrument: said, every order button off (the fake's account alert dismissed first: it covers the head) */
  if (await p.$eval('#wsAlert', e => !e.hidden)) await p.click('#wsAlertClose');
  await p.click(P(nq.id) + ' .ind-btn');
  await p.fill(P(nq.id) + ' .ind-search input', 'mini');
  await until(() => p.$(P(nq.id) + ' [data-f="add:ticket"]'), 'Mini ticket in the NQ chart\'s menu');
  await p.click(P(nq.id) + ' [data-f="add:ticket"]'); await p.keyboard.press('Escape');
  await until(() => p.$(P(nq.id) + ' .mini-tk'), 'the mini ticket on the NQ chart');
  const away = await p.$eval(P(nq.id) + ' .mini-tk', el => ({ text: el.querySelector('[data-mt-id="away"]').textContent, off: ['buyMkt', 'sellMkt', 'flattenBtn', 'cutHalfBtn', 'armBtn'].every(i => el.querySelector('[data-mt-id="' + i + '"]').disabled) }));
  check(/The order ticket is on MNQ: this chart is NQ/.test(away.text) && away.off, 'on the NQ chart: it says the ticket is on MNQ, every order button off: ' + JSON.stringify(away));
  await p.screenshot({ path: path.join(out, 'mini-ticket-away-1366.png') });

  /* a reload: the mini ticket comes back on its chart at its spot */
  await p.reload();
  await p.waitForSelector('.cb-pin-key', { timeout: 15000 }).then(() => enterPin(p, TEST_PIN)).catch(() => {});
  await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live') && window.workspace.ticket().enabled, null, { timeout: 40000 });
  const back = await until(() => p.$eval(P(mnq.id) + ' .mini-tk', el => ({ left: el.style.left, top: el.style.top })), 'the mini ticket after a reload');
  check(back && back.left === at1.left && back.top === at1.top, 'after a reload it is back at its spot: ' + JSON.stringify(back));
  check(!(await p.$eval(P(mnq.id) + ' .mini-tk', el => el.classList.contains('is-open'))), 'compact again after a reload (compact by default)');
  await ctx.close();
} catch (e) { fail('threw: ' + (e && e.stack || e)); }
finally { await browser.close(); bridge.kill(); }
console.log(errors.length ? errors.length + ' FAILED' : 'mini-ticket smoke: all passed');
process.exit(errors.length ? 1 : 0);
