// The NO STOP question never blocks Close or Flatten all (chart 1.13.0, the F2 review; ported from its probes
// probe-nostop-flatten.mjs and probe-nostop-ws.mjs), against the fake bridge (ChartBridge 0.3.8's protocol, sample
// data; nothing reaches a broker):
//   - /single.html: with the question open, the Close key, the Flatten all key and a click on Flatten each send at once
//     and close the question (its order not sent); the question is in the page's flow and covers nothing; Cancel has
//     the focus, so Enter sends nothing; a reversal (Sell 3 while long 1) is asked, a reducing Sell is not;
//   - the workspace (two windows): the same for the ticket's Close, the top bar's Flatten all and the keys, in the
//     ticket's window and in a window that forwards; Cancel has the focus there too; a Buy confirmed in the other window
//     carries its instrument and the ticket's window refuses it once the ticket is on another one.
//   npm run smoke:nostop        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser; NOSTOP_PART=single or
//                               workspace runs one part)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TEST_PIN, unlockIfAsked, enterPin } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.NOSTOP_SMOKE_PORT || 8881);
const PART = process.env.NOSTOP_PART || '';
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const child = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--trading', '--trade-accounts=Sim101', '--max-qty=MNQ:9,NQ:2,MES:2,ES:2', '--test-controls', '--version=0.3.8', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => child.stdout.once('data', r));
const control = async (what, q) => (await fetch(`http://127.0.0.1:${PORT}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
const state = r => control('state', { root: r || 'MNQ' });
async function until(fn, what, ms) {
  const end = Date.now() + (ms || 8000);
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); }
}
const HOTKEYS = { buy: 'Alt+B', sell: 'Alt+S', be: 'Alt+K', close: 'Alt+C', flattenAll: 'Shift+F9' };
const spies = keys => {
  window.__sent = []; window.__notes = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (['order', 'change', 'cancel', 'flatten', 'plan'].includes(m.type)) window.__sent.push(m); } catch (e) { /* not JSON */ } return send.call(this, d); };
  try { localStorage.setItem('live-hotkeys-v1', JSON.stringify(keys)); } catch (e) { /* blocked */ }
  const iv = setInterval(() => { const el = document.getElementById('statusMsg') || document.getElementById('wsNote'); if (!el) return; clearInterval(iv); new MutationObserver(() => window.__notes.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true }); }, 20);
};
const sent = (p, types) => p.evaluate(t => window.__sent.filter(m => !t || t.includes(m.type)).map(m => { const c = Object.assign({}, m); delete c.cid; return c; }), types || null);
const clear = p => p.evaluate(() => { window.__sent.length = 0; window.__notes.length = 0; });
const notes = p => p.evaluate(() => window.__notes.slice());
const blur = p => p.evaluate(() => document.activeElement && document.activeElement.blur());
/* a working order placed in NinjaTrader, so Flatten all has something to flatten */
const elsewhere = L => control('elsewhere', { account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'limit', qty: 1, p: L - 40 });
/* whether the element at the middle of `sel` is it (or inside it): nothing covers it */
const uncovered = (p, sel) => p.evaluate(s => { const e = document.querySelector(s); const r = e.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!at && (at === e || e.contains(at)); }, sel);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const L = Math.round((await control('hold', { root: 'MNQ' })).last);
  await control('price', { root: 'MNQ', p: L });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(spies, HOTKEYS);

  /* ================================================================ /single.html */
  if (PART !== 'workspace') {
  console.log('/single.html');
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('pageerror: ' + e.message));
  const openSingle = async () => {
    await page.goto(`http://localhost:${PORT}/live/single.html`);
    await unlockIfAsked(page);
    await page.waitForFunction(() => document.getElementById('connPill').textContent === 'LIVE' && !document.getElementById('buyMkt').disabled, null, { timeout: 30000 });
    await wait(600);
    await page.fill('#bStop', '0'); await page.press('#bStop', 'Tab'); await blur(page);
  };
  await openSingle();
  const asked = () => page.evaluate(() => !document.getElementById('noStopAsk').hidden);
  await page.click('#armBtn'); await wait(450);
  await page.click('#buyMkt'); await wait(250);
  check(await asked() && !(await sent(page)).length, 'Buy MKT with stop 0: the question, nothing sent');
  check(await page.evaluate(() => document.activeElement === document.getElementById('noStopCancel')), 'Cancel has the focus');
  const flow = await page.evaluate(() => getComputedStyle(document.getElementById('noStopAsk')).position);
  check(flow === 'static' && await uncovered(page, '#flattenBtn') && await uncovered(page, '#armBtn') && await uncovered(page, '#buyMkt'), 'the question is in the page\'s flow (' + flow + '): the order bar is not covered');
  await page.keyboard.press('Enter'); await wait(300);
  check(!(await asked()) && !(await sent(page)).length, 'Enter on the question: Cancel, nothing sent');

  const flattenWhileAsked = async (what, act) => {
    await elsewhere(L); await wait(500);
    await clear(page); await wait(450);
    await page.click('#buyMkt'); await wait(250);
    const open = await asked();
    await act(); await wait(400);
    const s = await sent(page);
    check(open && s.length >= 1 && s.every(m => m.type === 'flatten' && m.root === 'MNQ') && !(await asked()), what + ' with the question open: sent at once (' + JSON.stringify(s) + '), the question closed, its order not sent');
  };
  await flattenWhileAsked('the Close key', () => page.keyboard.press('Alt+C'));
  await flattenWhileAsked('the Flatten all key', () => page.keyboard.press('Shift+F9'));
  await flattenWhileAsked('a click on Flatten', () => page.click('#flattenBtn'));
  await until(async () => !(await state()).orders.length, 'no working order left');

  // Escape is Cancel; Send sends it
  await clear(page); await wait(450);
  await page.click('#buyMkt'); await wait(250);
  await page.keyboard.press('Escape'); await wait(200);
  check(!(await asked()) && !(await sent(page)).length, 'Escape: Cancel, nothing sent');
  await wait(450); await page.click('#buyMkt'); await wait(250);
  await page.click('#noStopSend');
  await until(async () => Object.values((await state()).positions).some(p => p.qty === 1), 'long 1');

  // a reversal opens a position: asked as an entry (a new page load, so the question is back); reducing is not
  await openSingle();
  await page.click('#armBtn'); await wait(450);
  await page.selectOption('#oQty', '3'); await blur(page); await clear(page);
  await page.click('#sellMkt'); await wait(250);
  check(await asked() && !(await sent(page)).length, 'long 1, Sell 3 (a reversal: it opens short 2) with stop 0: asked');
  await page.click('#noStopCancel'); await wait(450);
  await page.selectOption('#oQty', '1'); await blur(page); await clear(page);
  await page.click('#sellMkt'); await wait(400);
  const red = await sent(page, ['order']);
  check(!(await asked()) && red.length === 1 && red[0].side === 'sell' && !red[0].bracket, 'long 1, Sell 1 (reduces): never asked, sent');
  await until(async () => !Object.values((await state()).positions).some(p => p.qty), 'flat (single)');
  await page.close();
  }

  /* ================================================================ the workspace: two windows */
  if (PART !== 'single') {
  console.log('the workspace');
  const openWs = async layout => {
    const q = await ctx.newPage();
    q.on('pageerror', e => fail(layout + ' pageerror: ' + e.message));
    await q.goto(`http://localhost:${PORT}/live/?layout=${layout}`);
    await q.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(q, TEST_PIN);
    await q.waitForFunction(() => document.getElementById('wsConn').classList.contains('live') && window.workspace.ticket().enabled, null, { timeout: 30000 });
    await wait(800);
    return q;
  };
  const A = await openWs('Main');
  await A.waitForSelector('[data-tk-id="buyMkt"]', { timeout: 30000 });
  const B = await openWs('Second');
  await B.waitForFunction(() => window.workspace.ticket().holder !== null);
  const tk = i => `[data-tk-id="${i}"]`;
  const wsAsked = p => p.evaluate(() => !document.getElementById('wsNoStop').hidden);
  await A.bringToFront();
  await A.fill(tk('bStop'), '0'); await A.press(tk('bStop'), 'Tab'); await blur(A);
  await A.click(tk('armBtn')); await wait(450);
  await A.click(tk('buyMkt')); await wait(250);
  check(await wsAsked(A) && !(await sent(A)).length, 'the ticket\'s Buy MKT with stop 0: the question in A, nothing sent');
  check(await A.evaluate(() => document.activeElement === document.getElementById('wsNoStopCancel')), 'Cancel has the focus');
  const pos = await A.evaluate(() => getComputedStyle(document.getElementById('wsNoStop')).position);
  check(pos === 'static' && await uncovered(A, '#wsFlat') && await uncovered(A, tk('flattenBtn')), 'the question is under the top bar in the page\'s flow (' + pos + '): the top bar and the ticket\'s Close are not covered');
  await A.keyboard.press('Enter'); await wait(300);
  check(!(await wsAsked(A)) && !(await sent(A)).length, 'Enter on the question: Cancel, nothing sent');

  const wsFlattenWhileAsked = async (p, what, ask, act) => {
    await elsewhere(L); await wait(500);
    await clear(A); await clear(B); await wait(450);
    await ask(); await wait(300);
    const open = await wsAsked(p);
    await act(); await wait(500);
    const s = await sent(p);
    check(open && s.length >= 1 && s.every(m => m.type === 'flatten' && m.root === 'MNQ') && !(await wsAsked(p)) && !(await sent(A, ['order'])).length, what + ': sent at once (' + JSON.stringify(s) + '), the question closed, its order not sent');
  };
  await wsFlattenWhileAsked(A, 'A, question open, the Close key', () => A.click(tk('buyMkt')), () => A.keyboard.press('Alt+C'));
  await wsFlattenWhileAsked(A, 'A, question open, the Flatten all key', () => A.click(tk('buyMkt')), () => A.keyboard.press('Shift+F9'));
  await wsFlattenWhileAsked(A, 'A, question open, the ticket\'s Close', () => A.click(tk('buyMkt')), () => A.click(tk('flattenBtn')));
  await wsFlattenWhileAsked(A, 'A, question open, the top bar\'s Flatten all', () => A.click(tk('buyMkt')), () => A.click('#wsFlat'));

  // B forwards: asked in B, Cancel focused there, and Close / Flatten all from B work while it is open
  await B.bringToFront(); await blur(B); await clear(A); await clear(B); await wait(450);
  await B.keyboard.press('Alt+B'); await wait(300);
  check(await wsAsked(B) && !(await wsAsked(A)) && await B.evaluate(() => document.activeElement === document.getElementById('wsNoStopCancel')), 'B\'s Buy key: asked in B, Cancel has the focus there');
  await B.keyboard.press('Enter'); await wait(400);
  check(!(await wsAsked(B)) && !(await sent(A)).length && !(await sent(B)).length, 'Enter in B: Cancel, nothing sent anywhere');
  await wsFlattenWhileAsked(B, 'B, question open, the Close key', async () => { await blur(B); await B.keyboard.press('Alt+B'); }, () => B.keyboard.press('Alt+C'));
  await wsFlattenWhileAsked(B, 'B, question open, the top bar\'s Flatten all', async () => { await blur(B); await B.keyboard.press('Alt+B'); }, () => B.click('#wsFlat'));
  await until(async () => !(await state()).orders.length, 'no working order left (workspace)');

  // a Buy confirmed in B goes with its instrument: the ticket moved on to NQ meanwhile, so A refuses it
  await clear(A); await clear(B); await wait(450);
  await blur(B); await B.keyboard.press('Alt+B'); await wait(300);
  check(await wsAsked(B), 'B asked about the MNQ Buy');
  await A.selectOption(tk('root'), 'NQ'); await wait(600);
  await A.fill(tk('bStop'), '0'); await A.press(tk('bStop'), 'Tab'); await blur(A);
  await A.click(tk('armBtn')); await wait(400);
  await B.waitForFunction(() => window.workspace.ticket().holder && window.workspace.ticket().holder.root === 'NQ', null, { timeout: 5000 });
  await B.click('#wsNoStopSend'); await wait(800);
  const bn = await notes(B);
  check(!(await sent(A, ['order'])).length && bn.some(t => /order ticket is on NQ now, not MNQ/.test(t)), 'Send in B after the ticket moved to NQ: A refuses the MNQ Buy, nothing sent (' + JSON.stringify(bn.slice(-2)) + ')');
  await A.click(tk('buyMkt')); await wait(300);
  check(await wsAsked(A), 'and A was not told "Send" by it: its own NQ order with no stop is still asked');
  await A.click('#wsNoStopCancel');
  }
  await ctx.close();
} catch (e) {
  fail('error: ' + (e && e.stack || e));
} finally {
  await browser.close();
  child.kill();
}
if (errors.length) { console.error('nostop smoke: ' + errors.length + ' of ' + checks + ' checks FAILED'); process.exit(1); }
console.log('nostop smoke: all ' + checks + ' checks passed');
