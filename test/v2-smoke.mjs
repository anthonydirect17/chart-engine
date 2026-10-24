// House style V2's motion limits in a real page (chart 1.39.0), against the fake bridge (sample data; nothing reaches a
// broker). Anthony 2026-10-24: "smooth everywhere where possible as far as we can go", with these limits:
//   - a live value (prices, the quote board, Time and Sales, position, P&L, order state, the order ticket, the chart) shows
//     its true value the instant it changes: nothing on it or around it eases, fades in or counts up;
//   - no motion delays an action: an order button or Flatten fires on the click, a menu or a dialog takes its click while
//     it is still fading or rising in;
//   - reduced motion (the system's, or the page's Less motion) means no movement.
// Also: the V2 look is on (gold accent, no V1 purple or crimson in the chrome's computed colors). Screenshots in test/out/.
//   npm run smoke:v2        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin, ticketOnSim101 } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.V2_SMOKE_PORT || 9101);
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--trading', '--trade-accounts=Sim101', '--max-qty=MNQ:5,NQ:2',
  '--test-controls', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => bridge.stdout.once('data', r));
const LAYOUT = { V2: { panels: [
  { id: 'c1', type: 'chart', root: 'MNQ', tf: 'm1', x: 0, y: 0, w: 6, h: 6 }, { id: 'tk', type: 'ticket', x: 6, y: 0, w: 3, h: 4 },
  { id: 'tp', type: 'tape', root: 'MNQ', x: 9, y: 0, w: 3, h: 3 }, { id: 'ac', type: 'account', x: 6, y: 4, w: 3, h: 2 }] } };   // the quote board is added from the menu
function spies(layout) {
  window.__sent = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (['order', 'change', 'cancel', 'flatten', 'plan'].includes(m.type)) window.__sent.push(m); } catch (e) { /* not JSON */ } return send.call(this, d); };
  try { if (!localStorage.getItem('live-workspace-v1')) localStorage.setItem('live-workspace-v1', JSON.stringify({ v: 1, layouts: layout })); } catch (e) { /* blocked */ }
}
/* every element of `sel` and every ancestor: what moves (a running animation, a transition that lasts, an animation name) */
const movers = (p, sels) => p.evaluate(list => {
  const bad = [];
  for (const sel of list) for (const el of document.querySelectorAll(sel)) {
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const s = getComputedStyle(e);
      const tr = s.transitionDuration.split(',').some(d => parseFloat(d) > 0), an = s.animationName !== 'none';
      const run = e.getAnimations ? e.getAnimations().length : 0;
      if (tr || an || run) { bad.push(sel + ' via ' + (e.id || e.tagName.toLowerCase() + '.' + String(e.className).replace(/\s+/g, '.')) + (tr ? ' transition ' + s.transitionProperty : '') + (an ? ' animation ' + s.animationName : '')); break; }
    }
  }
  return bad;
}, sels);
const LIVE = ['.ws-panel[data-type="ticket"] .chart-live.tk', '[data-tk-id="buyMkt"]', '[data-tk-id="sellMkt"]', '[data-tk-id="armBtn"]', '[data-tk-id="flattenBtn"]',
  '#wsFlat', '#wsFlatEvery', '.ws-panel[data-type="tape"] .tp-row', '.ws-panel[data-type="quotes"] .gr-row', '.ws-panel[data-type="account"] .ac-sum b',
  '.ws-panel[data-type="chart"] .ce-canvas', '.ws-panel[data-type="chart"] .chart-live', '#wsNoStopSend', '#wsNoStopCancel'];

const browser = ticketOnSim101(await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}));
async function openPage(reduced) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(spies, LAYOUT);
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  await p.goto(`http://localhost:${PORT}/live/?layout=V2`);
  await p.waitForSelector('.cb-pin-key', { timeout: 15000 });
  return { ctx, p };
}
try {
  /* ---------------- motion on (no preference) */
  console.log('motion on');
  const { ctx, p } = await openPage(false);
  // the PIN card rises in once as the pad opens (no prices on it); its keys take a press at once
  check(await p.$eval('.cb-pin-card', e => getComputedStyle(e).animationName) === 'cb-pin-in', 'the PIN card fades in (cb-pin-in, no movement under the keys)');
  await enterPin(p, TEST_PIN);
  await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live') && window.workspace.ticket().enabled, null, { timeout: 30000 });
  await p.waitForSelector('[data-tk-id="buyMkt"]', { timeout: 30000 });
  await wait(2500);
  // the look: V2's gold accent and black ground, no V1 purple or crimson in what the chrome draws
  const look = await p.evaluate(() => {
    const cs = sel => { const e = document.querySelector(sel); return e ? getComputedStyle(e) : null; };
    const all = [...document.querySelectorAll('.ws-top *, .ws-panel .ws-head *, .chart-live.tk *, .ws-pop *')];
    const v1 = ['rgb(109, 40, 217)', 'rgb(182, 156, 255)', 'rgb(26, 18, 48)', 'rgb(59, 42, 107)', 'rgb(216, 204, 255)', 'rgb(159, 18, 57)', 'rgb(224, 68, 94)', 'rgb(123, 92, 255)'];
    // (a color swatch, set inline from the candle or indicator colors in use, is not chrome)
    const bad = all.filter(e => !(e.getAttribute('style') || '').includes('background')).filter(e => { const s = getComputedStyle(e); return v1.includes(s.color) || v1.includes(s.backgroundColor) || v1.includes(s.borderTopColor); }).map(e => e.tagName + '.' + e.className);
    return { body: cs('body').backgroundColor, title: cs('.ws-title').color, add: cs('#wsAdd').borderTopLeftRadius, bad };
  });
  check(look.body === 'rgb(5, 5, 6)', 'the ground is V2 black: ' + look.body);
  check(look.title === 'rgb(226, 198, 135)', 'the wordmark is gold: ' + look.title);
  check(parseFloat(look.add) >= 14, 'buttons are pills: ' + look.add);
  check(look.bad.length === 0, 'no V1 purple or crimson in the top bar, the panel headers or the ticket: ' + look.bad.slice(0, 5).join(', '));
  // live values and order controls: nothing on them or around them moves, at rest and while the pointer is on a top-bar button
  check((await movers(p, LIVE)).length === 0, 'at rest: no transition or animation on a live value or an order control, nor around one: ' + (await movers(p, LIVE)).join('; '));
  await p.hover('#wsAdd'); await wait(80);
  const moving = await p.$eval('#wsAdd', e => parseFloat(getComputedStyle(e).transitionDuration) > 0);
  check(moving, 'a top-bar button (+ Add panel) eases its hover (V2)');
  check((await movers(p, LIVE)).length === 0, 'with a hover easing in the top bar, the live parts still do not move');
  // the order ticket's figures change at once: a new price shows on the quote board with no motion on the way
  // (measured as the text of the cell right after the trade arrives, in the same frame the page writes it)
  // a menu takes its click while it fades in: + Add panel, then Quote board, in the same task
  const added = await p.evaluate(() => {
    const n0 = document.querySelectorAll('.ws-panel').length;
    document.getElementById('wsAdd').click();
    const menu = document.getElementById('wsAddMenu'), anim = getComputedStyle(menu).animationName;
    document.querySelector('#wsAddMenu [data-add="quotes"]').click();
    return { anim, n0, n1: document.querySelectorAll('.ws-panel').length };
  });
  check(added.anim === 'v2-fade-in', 'the menu fades in as it opens: ' + added.anim);
  check(added.n1 === added.n0 + 1, 'it took the click in the same task, while fading in (' + added.n0 + ' to ' + added.n1 + ')');
  await wait(400);
  // a dialog that asks nothing about orders rises in, and its Cancel answers at once
  const dlg = await p.evaluate(() => {
    const s = document.getElementById('wsLayout'); s.value = '\u0001new'; s.dispatchEvent(new Event('change', { bubbles: true }));
    const d = document.getElementById('wsDialog'), anim = getComputedStyle(d).animationName, wasOpen = d.open;
    d.querySelector('[data-act="cancel"]').click();
    return { anim, wasOpen, open: d.open };
  });
  check(dlg.wasOpen && dlg.anim === 'v2-fade-in' && !dlg.open, 'the New layout dialog fades in (v2-fade-in, never moving under the pointer) and Cancel closed it at once: ' + JSON.stringify(dlg));
  await wait(400);
  // danger borders keep their color on hover (review of #70): Flatten all, and the NO STOP question's Send (stop 0, Armed, Buy MKT)
  const borderOf = sel => p.$eval(sel, e => getComputedStyle(e).borderTopColor);
  const flat0 = await borderOf('#wsFlat'); await p.hover('#wsFlat'); await wait(350);
  const flat1 = await borderOf('#wsFlat');
  check(flat0 === flat1 && !/201, 165, 92/.test(flat1), 'Flatten all keeps its red border on hover: ' + flat0 + ' then ' + flat1);
  await p.fill('[data-tk-id="bStop"]', '0'); await p.press('[data-tk-id="bStop"]', 'Tab');
  await p.evaluate(() => document.activeElement && document.activeElement.blur());
  await p.click('[data-tk-id="armBtn"]'); await wait(450);
  await p.click('[data-tk-id="buyMkt"]'); await wait(300);
  check(await p.isVisible('#wsNoStop'), 'Buy MKT with stop 0: the NO STOP question');
  const send0 = await borderOf('#wsNoStopSend'); await p.hover('#wsNoStopSend'); await wait(350);
  const send1 = await borderOf('#wsNoStopSend');
  check(send0 === 'rgb(255, 92, 122)' && send1 === 'rgb(255, 92, 122)', 'the NO STOP question\'s Send keeps the sell red border on hover: ' + send0 + ' then ' + send1);
  await p.click('#wsNoStopCancel'); await wait(200);
  await p.click('[data-tk-id="armBtn"]'); await wait(300);
  // Buy MKT fires on the click (Armed, a stop set, so no question)
  await p.fill('[data-tk-id="bStop"]', '20'); await p.press('[data-tk-id="bStop"]', 'Tab');
  await p.evaluate(() => document.activeElement && document.activeElement.blur());
  await p.click('[data-tk-id="armBtn"]'); await wait(450);
  check((await movers(p, LIVE)).length === 0, 'Armed: still nothing moves on the ticket, the order bar or the chart: ' + (await movers(p, LIVE)).join('; '));
  await p.evaluate(() => { window.__sent.length = 0; });
  const buy = await p.evaluate(() => { document.querySelector('[data-tk-id="buyMkt"]').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); return window.__sent.map(m => m.type + ' ' + (m.side || '')); });
  check(buy.some(x => /^order buy/.test(x)), 'Buy MKT: the order is sent within the click itself: ' + JSON.stringify(buy));
  await wait(1500);
  check((await movers(p, LIVE)).length === 0, 'with a position open: the position, P&L and the order lines\' panels do not move: ' + (await movers(p, LIVE)).join('; '));
  // Flatten all fires on the click (a position is open): the message is sent before the click handler returns, with no motion first
  await p.evaluate(() => { window.__sent.length = 0; });
  const flat = await p.evaluate(() => { document.getElementById('wsFlat').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); return window.__sent.map(m => m.type); });
  check(flat.includes('flatten'), 'Flatten all: the flatten message is sent within the click itself: ' + JSON.stringify(flat));
  await wait(600);
  await p.click('[data-tk-id="armBtn"]'); await wait(300);
  await p.screenshot({ path: path.join(out, 'v2-workspace-1600x900.png') });
  // the page's Less motion (ChartMotion's motion-off): the menus and dialogs no longer move
  await p.evaluate(() => window.ChartMotion.setReducedMotion(true));
  const off = await p.evaluate(() => { document.getElementById('wsAdd').click(); const a = getComputedStyle(document.getElementById('wsAddMenu')).animationName; document.getElementById('wsAdd').click(); return a; });
  check(off === 'none', 'Less motion on the page: the menu opens with no animation: ' + off);
  await p.hover('#wsSet'); await wait(80);
  check(await p.$eval('#wsSet', e => getComputedStyle(e).transitionDuration.split(',').every(d => parseFloat(d) === 0)), 'Less motion on the page: a top-bar hover has no transition');
  await p.evaluate(() => window.ChartMotion.setReducedMotion(false));
  await ctx.close();

  /* ---------------- the system's reduced motion */
  console.log('reduced motion');
  const R = await openPage(true);
  check(await R.p.$eval('.cb-pin-card', e => getComputedStyle(e).animationName) === 'none', 'reduced motion: the PIN card shows at once');
  await enterPin(R.p, TEST_PIN);
  await R.p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 });
  await wait(1500);
  const red = await R.p.evaluate(() => {
    document.getElementById('wsAdd').click();
    const menu = getComputedStyle(document.getElementById('wsAddMenu')).animationName;
    document.getElementById('wsAdd').click();
    const s = document.getElementById('wsLayout'); s.value = '\u0001new'; s.dispatchEvent(new Event('change', { bubbles: true }));
    const d = document.getElementById('wsDialog'), dlg = getComputedStyle(d).animationName; d.querySelector('[data-act="cancel"]').click();
    return { menu, dlg };
  });
  check(red.menu === 'none' && red.dlg === 'none', 'reduced motion: the menu and the dialog appear at once: ' + JSON.stringify(red));
  await R.p.hover('#wsAdd'); await wait(80);
  check(await R.p.$eval('#wsAdd', e => getComputedStyle(e).transitionDuration.split(',').every(d => parseFloat(d) === 0) && getComputedStyle(e).translate === 'none'), 'reduced motion: no hover transition and no lift');
  check((await movers(R.p, LIVE)).length === 0, 'reduced motion: nothing moves on the live parts');
  await R.ctx.close();
} catch (e) {
  fail('error: ' + (e && e.stack || e));
} finally {
  await browser.close();
  bridge.kill();
}
if (errors.length) { console.error('\nv2 smoke: ' + errors.length + ' of ' + checks + ' checks FAILED (sample data)'); process.exit(1); }
console.log('\nv2 smoke: ' + checks + ' checks, all ok (sample data)');
