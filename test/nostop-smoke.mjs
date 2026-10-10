// The NO STOP question never blocks Close or Flatten all (chart 1.13.0, the F2 review; ported from its probes
// probe-nostop-flatten.mjs and probe-nostop-ws.mjs), against the fake bridge (ChartBridge 0.3.8's protocol, sample
// data; nothing reaches a broker):
//   - the workspace (two windows): with the question open, the ticket's Close, the top bar's Flatten all and the keys
//     send at once and close the question (its order not sent), in the ticket's window and in a window that forwards;
//     Cancel has the focus, so Enter sends nothing, and Escape is Cancel; Send sends it; the question sits over the top
//     bar, so the grid never resizes and the ticket never scrolls (1366x768, 1920x1080, 2560x1440); Armed off, the ticket
//     on another instrument, or a Close in the other window drops it; an answer that reaches the ticket's window after a
//     Close of its instrument (the drop arriving late) is refused (the F2 re-review); a reversal (Sell 3 while long 1) is
//     asked, a reducing Sell is not. (Chart 1.21.0: the single chart page's own part went with that page; its Escape,
//     Send, reversal and reducing checks run on the ticket here.)
//   npm run smoke:nostop        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.NOSTOP_SMOKE_PORT || 8881);
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
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
  // window.__deafFlat: this window misses the other windows' "a Close or Flatten went out" (a late broadcast)
  const BC = window.BroadcastChannel;
  if (typeof BC === 'function') window.BroadcastChannel = class extends BC {
    set onmessage(f) { super.onmessage = this.name === 'chartbridge-noflat-v1' && f ? (e => { if (!window.__deafFlat) f(e); }) : f; }
    get onmessage() { return super.onmessage; }
  };
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

  /* ================================================================ the workspace: two windows */
  {
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
  // no scrolling, ever: the grid does not move and the ticket does not scroll when the question shows; Close, Flatten
  // all, KEYS, Cancel and Send all in view and not covered, at each screen size
  const layoutOf = () => A.evaluate(() => { const t = document.querySelector('.ws-panel[data-type="ticket"] .chart-live.tk'), g = document.getElementById('wsGrid').getBoundingClientRect();
    return { grid: [Math.round(g.top), Math.round(g.height)], sh: t.scrollHeight, ch: t.clientHeight, sw: t.scrollWidth, cw: t.clientWidth }; });
  for (const [w, h] of [[1366, 768], [1920, 1080], [2560, 1440]]) {
    await A.setViewportSize({ width: w, height: h }); await wait(900);
    const before = await layoutOf();
    await clear(A); await wait(450);
    await A.click(tk('buyMkt')); await wait(300);
    const open = await layoutOf();
    if (w === 1366) await A.screenshot({ path: path.join(out, 'nostop-workspace-1366x768.png') });
    const seen = [];
    for (const sel of ['#wsFlat', '#wsKeys', tk('flattenBtn'), '#wsNoStopCancel', '#wsNoStopSend']) if (!(await uncovered(A, sel))) seen.push(sel);
    check(await wsAsked(A) && JSON.stringify(open.grid) === JSON.stringify(before.grid) && open.sh <= open.ch + 1 && open.sw <= open.cw + 1 && !seen.length,
      w + 'x' + h + ': the question shows, the grid stays put, the ticket does not scroll, nothing covered (' + JSON.stringify({ before, open, covered: seen }) + ')');
    await A.click('#wsNoStopCancel'); await wait(200);
  }
  await A.setViewportSize({ width: 1600, height: 900 }); await wait(900);
  await A.click(tk('buyMkt')); await wait(250);
  check(await wsAsked(A) && !(await sent(A)).length, 'the ticket\'s Buy MKT with stop 0: the question in A, nothing sent');
  check(await A.evaluate(() => document.activeElement === document.getElementById('wsNoStopCancel')), 'Cancel has the focus');
  const pos = await A.evaluate(() => getComputedStyle(document.getElementById('wsNoStop')).position);
  check(pos === 'absolute', 'the question sits over the top bar (' + pos + ')');
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

  // Armed off in the ticket's window drops its own question and B's (F2 re-review)
  await clear(A); await clear(B); await A.bringToFront(); await wait(450);
  await A.click(tk('buyMkt')); await wait(250);
  await B.bringToFront(); await blur(B); await B.keyboard.press('Alt+B'); await wait(400);
  const both = (await wsAsked(A)) && (await wsAsked(B));
  await A.bringToFront(); await A.click(tk('armBtn')); await wait(500);
  check(both && !(await wsAsked(A)) && !(await wsAsked(B)) && !(await sent(A)).length, 'Armed off in A: A\'s question and B\'s both go, nothing sent');
  await A.click(tk('armBtn')); await wait(400);

  // B asked about MNQ, then the ticket moves on to NQ: B's question goes, nothing sent
  await clear(A); await clear(B); await wait(450);
  await B.bringToFront(); await blur(B); await B.keyboard.press('Alt+B'); await wait(300);
  const bOpen = await wsAsked(B);
  await A.selectOption(tk('root'), 'NQ'); await wait(600);
  await A.click(tk('armBtn')); await wait(400);
  await B.waitForFunction(() => window.workspace.ticket().holder && window.workspace.ticket().holder.root === 'NQ', null, { timeout: 5000 });
  await wait(300);
  check(bOpen && !(await wsAsked(B)) && !(await sent(A)).length, 'B asked about MNQ, the ticket moved to NQ: B\'s question is gone, nothing sent');
  await A.selectOption(tk('root'), 'MNQ'); await wait(600);
  await A.fill(tk('bStop'), '0'); await A.press(tk('bStop'), 'Tab'); await blur(A);
  await A.click(tk('armBtn')); await wait(400);
  await B.waitForFunction(() => { const h = window.workspace.ticket().holder; return h && h.root === 'MNQ' && h.armed; }, null, { timeout: 5000 });

  // a Close in A drops B's question; and when B misses that (a late broadcast), A refuses B's answer
  await clear(A); await clear(B); await wait(450);
  await B.bringToFront(); await blur(B); await B.keyboard.press('Alt+B'); await wait(300);
  const bAsk2 = await wsAsked(B);
  await A.bringToFront(); await blur(A); await A.keyboard.press('Alt+C'); await wait(500);
  check(bAsk2 && (await sent(A, ['flatten'])).length === 1 && !(await wsAsked(B)), 'a Close in A: sent at once, and B\'s question goes');
  await B.evaluate(() => { window.__deafFlat = true; });
  await clear(A); await clear(B); await wait(450);
  await B.bringToFront(); await blur(B); await B.keyboard.press('Alt+B'); await wait(300);
  const bAsk3 = await wsAsked(B);
  await A.bringToFront(); await blur(A); await A.keyboard.press('Alt+C'); await wait(500);
  const stillB = await wsAsked(B);
  await B.bringToFront(); await B.click('#wsNoStopSend'); await wait(800);
  const bn = await notes(B);
  check(bAsk3 && stillB && !(await sent(A, ['order'])).length && bn.some(t => /went out after that order was asked about/.test(t)),
    'B missed the Close (late): its Send reaches A, which refuses it, nothing sent (' + JSON.stringify(bn.slice(-1)) + ')');
  await B.evaluate(() => { window.__deafFlat = false; });
  await A.bringToFront(); await A.click(tk('buyMkt')); await wait(300);
  check(await wsAsked(A), 'and A was not told "Send" by it: its own order with no stop is still asked');
  await A.click('#wsNoStopCancel');

  // Escape is Cancel (the single chart page's checks until 1.21.0, now on the ticket)
  await clear(A); await clear(B); await A.bringToFront(); await wait(450);
  await A.click(tk('buyMkt')); await wait(250);
  await A.keyboard.press('Escape'); await wait(200);
  check(!(await wsAsked(A)) && !(await sent(A)).length, 'Escape: Cancel, nothing sent');
  // a reversal opens a position: asked as an entry; reducing is not (long 1 placed in NinjaTrader itself)
  await control('elsewhere', { account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'market', qty: 1 });
  await until(async () => Object.values((await state()).positions).some(p => p.qty === 1), 'long 1');
  await A.selectOption(tk('oQty'), '3'); await blur(A); await clear(A); await wait(450);
  await A.click(tk('sellMkt')); await wait(300);
  check(await wsAsked(A) && !(await sent(A)).length, 'long 1, Sell 3 (a reversal: it opens short 2) with stop 0: asked');
  await A.click('#wsNoStopCancel'); await wait(450);
  await A.selectOption(tk('oQty'), '1'); await blur(A); await clear(A); await wait(450);
  await A.click(tk('sellMkt')); await wait(600);
  const red = await sent(A, ['order']);
  check(!(await wsAsked(A)) && red.length === 1 && red[0].side === 'sell' && !red[0].bracket, 'long 1, Sell 1 (reduces): never asked, sent: ' + JSON.stringify(red));
  await until(async () => !Object.values((await state()).positions).some(p => p.qty), 'flat (workspace)');
  // Send sends it
  await wait(450); await A.click(tk('buyMkt')); await wait(250);
  await A.click('#wsNoStopSend');
  await until(async () => Object.values((await state()).positions).some(p => p.qty === 1), 'long 1 after Send');
  await A.click(tk('flattenBtn'));
  await until(async () => !Object.values((await state()).positions).some(p => p.qty), 'flat after Send (workspace)');
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
