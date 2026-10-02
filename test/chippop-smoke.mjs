// The chip settings popover (chart 1.14.0, Anthony: he changes indicator settings many times a day) against the fake
// bridge (sample data; nothing reaches a broker), in Chromium, on /single.html and in the workspace, at 1366x768,
// 1920x1080 and 2560x1440: a chip click opens its indicator's settings (the gear's card) dropped from the chip, with an
// on/off switch at the top; an edit applies and is saved; the switch hides the indicator and keeps the chip, and turns
// it back on; a click outside, Escape or the chip again closes it and the focus goes back to the page (the workspace's
// KEYS shows OFF while it is open, ON after); it fits the screen whole (never scrolls), flipped left near the right edge;
// a chip behind "+N" opens it too.
//   npm run smoke:chippop        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const SHOTS = process.env.SHOTS_DIR || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const PORT = +(process.env.CHIPPOP_SMOKE_PORT || 8898);
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
async function shot(page, name) {
  const file = path.join(out, name);
  await page.screenshot({ path: file });
  if (SHOTS) fs.copyFileSync(file, path.join(SHOTS, name));
}
let bridge = null;
async function startBridge() {
  bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--trading', '--trade-accounts=Sim101', '--test-controls',
    '--version=0.3.8', '--data-037', '--live-rate=40', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => bridge.stdout.once('data', r));
}
/* every message the page sends, and every status line it shows (as smoke:hotkeys); Close on Alt+C, Flatten all on Shift+F9 */
const spies = () => {
  window.__sent = []; window.__statusSeen = [];
  const iv = setInterval(() => { const el = document.getElementById('statusMsg') || document.getElementById('wsNote'); if (!el) return; clearInterval(iv); new MutationObserver(() => window.__statusSeen.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true }); }, 20);
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) { try { window.__sent.push(JSON.parse(d)); } catch (e) { /* not JSON */ } return send.call(this, d); };
  try { localStorage.setItem('live-hotkeys-v1', JSON.stringify({ buy: '', sell: '', be: '', close: 'Alt+C', flattenAll: 'Shift+F9' })); } catch (e) { /* none */ }
};
/* each selector's centre reaches its own element (nothing covers it), and the Close and Flatten all keys act */
async function reachAndKeys(page, sels, what) {
  const r = await page.evaluate(sels => sels.map(sel => { const el = document.querySelector(sel); if (!el || !el.getClientRects().length) return sel + ': missing';
    const b = el.getBoundingClientRect(), hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return hit && (hit === el || el.contains(hit)) ? '' : sel + ': covered by ' + (hit ? hit.className || hit.tagName : 'nothing'); }).filter(Boolean), sels);
  check(r.length === 0, what + ': every order button reachable (' + sels.length + ')' + (r.length ? ': ' + r.join('; ') : ''));
  await page.evaluate(() => { window.__sent.length = 0; window.__statusSeen.length = 0; });
  // the orders go out on the pace (1.1 s apart): wait for them rather than a fixed time
  const waitFor = async fn => { for (let k = 0; k < 40; k++) { if (await page.evaluate(fn)) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
  await new Promise(r => setTimeout(r, 450));                 // past the order bar's 0.4 s repeat guard
  await page.keyboard.press('Alt+KeyC');
  const fl = await waitFor(() => window.__sent.some(m => m.type === 'flatten'));
  await page.evaluate(() => { window.__sent.length = 0; window.__statusSeen.length = 0; });
  await page.keyboard.press('Shift+F9');
  const fa = await waitFor(() => window.__sent.some(m => m.type === 'flatten') || window.__statusSeen.some(t => /Flatten all/.test(t)) || /Flatten all: /.test(document.body.innerText));
  const why = fl && fa ? '' : ' (close ' + fl + ', flatten all ' + fa + ': ' + JSON.stringify(await page.evaluate(() => window.__statusSeen.slice(-3))) + ')';
  check(fl && fa, what + ': the Close key sent a flatten and the Flatten all key acted, with it open' + why);
}
async function openPage(ctx, url) {
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('connPill') || document.getElementById('wsConn') || document.querySelector('.cb-pin-key'), null, { timeout: 15000 });
  if (await page.$('.cb-pin-key')) await enterPin(page, TEST_PIN);
  return page;
}
/* The popover of the chart in `scope`: shown, where, whether it fits whole and scrolls, its switch, its anchor. */
const popState = (page, scope) => page.evaluate(sc => {
  const pop = document.querySelector(sc + ' .chip-pop');
  if (!pop || pop.hidden) return { open: false, active: document.activeElement === document.body ? 'body' : document.activeElement && (document.activeElement.id || document.activeElement.className) };
  const r = pop.getBoundingClientRect();
  const scrolls = [pop, ...pop.querySelectorAll('*')].some(e => { const cs = getComputedStyle(e); return /(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1); });
  const sw = pop.querySelector('[data-act="popsw"]'), chip = document.querySelector(sc + ' .ind-chip[aria-expanded="true"]');
  return { open: true, id: sw && sw.dataset.id, on: sw && sw.getAttribute('aria-pressed') === 'true', x: r.left, y: r.top, w: r.width, h: r.height,
    inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, scrolls, text: pop.innerText.replace(/\s+/g, ' ').slice(0, 90),
    chip: chip ? (() => { const c = chip.getBoundingClientRect(); return { x: c.left, y: c.top, b: c.bottom, r: c.right }; })() : null };
}, scope);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  await startBridge();
  for (const [w, h] of [[1366, 768], [1920, 1080], [2560, 1440]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await ctx.addInitScript(spies);

    /* ================================================================ /single.html */
    console.log(`/single.html ${w}x${h}`);
    const sp = await openPage(ctx, `http://localhost:${PORT}/live/single.html`);
    await sp.waitForFunction(() => /LIVE/.test((document.getElementById('connPill') || {}).textContent || '') && window.liveChart && window.liveChart.lastBar(), null, { timeout: 30000 });
    await sp.waitForTimeout(800);
    // every indicator pinned, so the strip is full at 1366 (some behind +N)
    await sp.click('#indBtn');
    for (const q of ['profile', 'bubbles']) { await sp.fill('#indQ', q); await sp.press('#indQ', 'Enter'); }
    await sp.fill('#indQ', '');
    for (const id of ['delta', 'vp', 'bubbles']) { const b = await sp.$(`#indBody [data-act="pin"][data-id="${id}"]`); if (b && (await b.getAttribute('aria-pressed')) === 'false') await b.click(); }
    await sp.keyboard.press('Escape'); await sp.waitForTimeout(300);
    await sp.click('#chart'); await sp.waitForTimeout(200);
    // review D2: every chip's popover clear of the order bar; Close and Flatten all work while it is open
    const ORDER = ['#flattenBtn', '#beBtn', '#cancelAllBtn', '#buyMkt', '#sellMkt', '#armBtn'];
    for (const id of await sp.evaluate(() => [...document.querySelectorAll('#indChips > .ind-chip[data-id]')].map(c => c.dataset.id))) {
      await sp.click(`#indChips > .ind-chip[data-id="${id}"]`); await sp.waitForTimeout(150);
      const ps = await popState(sp, 'body');
      check(ps.open && ps.inside && !ps.scrolls, `${id} popover open, whole on screen`);
      await reachAndKeys(sp, ORDER, `/single.html ${w}: the ${id} popover`);
      if (w === 1920 && id === 'levels') await shot(sp, 'chippop-single-levels-1920.png');
      await sp.keyboard.press('Escape'); await sp.waitForTimeout(100);
    }
    // from one of its boxes (a hex box has the focus): Ctrl or Alt combos still act
    await sp.click('#indChips .ind-chip[data-id="vwap"]'); await sp.focus('body .chip-pop input[data-hk="vwap"]');
    await reachAndKeys(sp, ORDER, `/single.html ${w}: a box in the VWAP popover has the focus`);
    await sp.keyboard.press('Escape'); await sp.waitForTimeout(100);
    if (await sp.evaluate(() => !document.querySelector('body .chip-pop').hidden)) await sp.keyboard.press('Escape');
    // open: the VWAP chip shows VWAP's settings, dropped from the chip; the chart is unchanged
    await sp.click('#indChips .ind-chip[data-id="vwap"]'); await sp.waitForTimeout(200);
    let s = await popState(sp, 'body');
    check(s.open && s.id === 'vwap' && s.on && /VWAP/.test(s.text) && (await sp.evaluate(() => window.liveChart.getLayers().vwap)) === true, 'a chip click opens its settings, the indicator still shown: "' + s.text + '"');
    const obB = await sp.evaluate(() => document.getElementById('obar').getBoundingClientRect().bottom);
    check(s.chip && s.y >= obB + 5 && s.inside && !s.scrolls, 'dropped under the chip, below the order bar, whole on screen, no scrolling: ' + JSON.stringify({ x: Math.round(s.x), y: Math.round(s.y), w: Math.round(s.w), h: Math.round(s.h) }));
    check(await sp.isVisible('body .chip-pop [data-f="opt:vwap:session:rth"]') && (await sp.$$('body .chip-pop input[data-ck="vwap"]')).length === 1, 'the gear\'s own content: Hours and the line color');
    if (w === 1366) await shot(sp, 'chippop-single-vwap-1366.png');
    // edit: RTH only, applied and saved for this chart
    await sp.click('body .chip-pop [data-f="opt:vwap:session:rth"]');
    check((await sp.evaluate(() => JSON.parse(localStorage.getItem('live-indicator-options-v1')).main.vwap.session)) === 'rth' && await sp.getAttribute('body .chip-pop [data-f="opt:vwap:session:rth"]', 'aria-pressed') === 'true', 'an edit applies and is saved (VWAP RTH only)');
    await sp.click('body .chip-pop [data-f="opt:vwap:session:full"]');
    // switch: off hides VWAP and keeps the chip; on again from the same popover
    await sp.click('body .chip-pop [data-act="popsw"]'); await sp.waitForTimeout(150);
    s = await popState(sp, 'body');
    const chipKept = await sp.evaluate(() => { const c = document.querySelector('#indChips .ind-chip[data-id="vwap"]'); return !!c && c.getAttribute('aria-pressed') === 'false'; });
    check(s.open && !s.on && (await sp.evaluate(() => window.liveChart.getLayers().vwap)) === false && chipKept, 'the switch off: VWAP hidden, the chip kept (dashed), the popover still open');
    await sp.click('body .chip-pop [data-act="popsw"]'); await sp.waitForTimeout(150);
    check((await sp.evaluate(() => window.liveChart.getLayers().vwap)) === true && (await popState(sp, 'body')).on, 'and on again from the same popover');
    // close: Escape, the focus back on the page; the chip again; a click outside
    await sp.keyboard.press('Escape'); await sp.waitForTimeout(100);
    s = await popState(sp, 'body');
    check(!s.open && s.active === 'body', 'Escape closes it and the focus goes back to the page (' + s.active + ')');
    await sp.click('#indChips .ind-chip[data-id="levels"]'); await sp.waitForTimeout(150);
    check((await popState(sp, 'body')).id === 'levels' && await sp.isVisible('body .chip-pop [data-f="tog:levels:ibh"]'), 'the Levels chip: its ten line toggles');
    await sp.click('#indChips .ind-chip[data-id="levels"]'); await sp.waitForTimeout(100);
    s = await popState(sp, 'body');
    check(!s.open && s.active === 'body', 'the chip again closes it, focus on the page');
    await sp.click('#indChips .ind-chip[data-id="volume"]'); await sp.waitForTimeout(100);
    const cb = await sp.locator('#chart').boundingBox();
    await sp.mouse.click(cb.x + cb.width * 0.4, cb.y + cb.height * 0.6); await sp.waitForTimeout(100);
    check(!(await popState(sp, 'body')).open, 'a click outside closes it');
    // the last chip shown, near the right of the strip, and a chip behind "+N"
    const lastId = await sp.evaluate(() => { const cs = [...document.querySelectorAll('#indChips > .ind-chip[data-id]')]; return cs[cs.length - 1].dataset.id; });
    await sp.click(`#indChips > .ind-chip[data-id="${lastId}"]`); await sp.waitForTimeout(150);
    s = await popState(sp, 'body');
    check(s.open && s.inside && !s.scrolls, `the last chip shown (${lastId}): whole on screen`);
    await sp.keyboard.press('Escape');
    const more = await sp.$('#indChips .ind-chip-more:not([hidden])');
    if (more) {
      await more.click(); await sp.waitForTimeout(100);
      const inList = await sp.evaluate(() => document.querySelector('#indChips .ind-chip-list .ind-chip').dataset.id);
      await sp.click(`#indChips .ind-chip-list .ind-chip[data-id="${inList}"]`); await sp.waitForTimeout(150);
      s = await popState(sp, 'body');
      check(s.open && s.id === inList && s.inside && !s.scrolls && (await sp.evaluate(() => document.querySelector('#indChips .ind-chip-list').hidden)), 'a chip behind "+N" (' + inList + ') opens its settings too, dropped from "+N", whole on screen');
      if (w === 1366) await shot(sp, 'chippop-single-more-1366.png');
      await sp.keyboard.press('Escape');
    } else check(w > 1366, 'no "+N" at ' + w + ' px (all seven chips fit)');
    if (w === 1366) {
      // a narrow window: "+N" near the right edge, so the popover flips left to stay whole
      await sp.setViewportSize({ width: 1000, height: 640 }); await sp.waitForTimeout(500);
      const m2 = await sp.$('#indChips .ind-chip-more:not([hidden])');
      if (m2) {
        await m2.click(); await sp.waitForTimeout(100);
        const id2 = await sp.evaluate(() => document.querySelector('#indChips .ind-chip-list .ind-chip').dataset.id);
        await sp.click(`#indChips .ind-chip-list .ind-chip[data-id="${id2}"]`); await sp.waitForTimeout(150);
        s = await popState(sp, 'body');
        const mb = await m2.boundingBox();
        check(s.open && s.inside && !s.scrolls && (mb.x + 300 <= 1000 - 8 || s.x < mb.x), 'a narrow window (1000 px): whole on screen, flipped left when "+N" is near the edge (+N at ' + Math.round(mb.x) + ', popover ' + Math.round(s.x) + ' to ' + Math.round(s.x + s.w) + ')');
        await shot(sp, 'chippop-single-narrow-1000.png');
        await sp.keyboard.press('Escape');
      } else check(false, 'a narrow window shows "+N"');
    }
    await sp.close();

    /* ================================================================ the workspace */
    console.log(`workspace ${w}x${h}`);
    const wp = await openPage(ctx, `http://localhost:${PORT}/live/?layout=Display`);
    await wp.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 });
    await wp.waitForTimeout(1500);
    const main = await wp.evaluate(() => window.workspace.panels().find(p => p.type === 'chart' && document.querySelector(`.ws-panel[data-id="${p.id}"] .ind-chip[data-id]`)).id);
    const WS = `.ws-panel[data-id="${main}"]`;
    await wp.mouse.click(4, h - 4); await wp.waitForTimeout(200);
    check(await wp.textContent('#wsKeys') === 'KEYS ON', 'KEYS ON before');
    await wp.click(`${WS} .ind-chip[data-id="levels"]`); await wp.waitForTimeout(200);
    s = await popState(wp, WS);
    check(s.open && s.id === 'levels' && s.inside && !s.scrolls && s.chip && s.y >= s.chip.b + 5, 'a panel chip opens its settings under it, whole on screen: ' + JSON.stringify({ x: Math.round(s.x), y: Math.round(s.y), h: Math.round(s.h) }));
    check(await wp.textContent('#wsKeys') === 'KEYS OFF', 'KEYS OFF while it is open');
    if (w === 1366) await shot(wp, 'chippop-ws-levels-1366.png');
    const TICKET = await wp.evaluate(() => ['#wsFlat'].concat([...document.querySelectorAll('.ws-panel[data-type="ticket"] button')].filter(b => b.getClientRects().length && b.offsetParent).map((b, i) => { b.dataset.reach = 'r' + i; return `[data-reach="r${i}"]`; })));
    for (const id of await wp.evaluate(sc => [...document.querySelectorAll(sc + ' .ind-chips > .ind-chip[data-id]')].map(c => c.dataset.id), WS)) {
      if (id !== 'levels') { await wp.keyboard.press('Escape'); await wp.click(`${WS} .ind-chip[data-id="${id}"]`); await wp.waitForTimeout(150); }
      await reachAndKeys(wp, TICKET, `workspace ${w}: the ${id} popover`);
    }
    await wp.keyboard.press('Escape'); await wp.click(`${WS} .ind-chip[data-id="levels"]`); await wp.waitForTimeout(150);
    await wp.click(`${WS} .chip-pop [data-f="tog:levels:pdh"]`);
    check((await wp.evaluate(id => JSON.parse(localStorage.getItem('live-indicator-options-v1'))[id].levels.pdh, main)) === 'off', 'an edit in a panel: PDH off, saved for that panel');
    await wp.click(`${WS} .chip-pop [data-f="tog:levels:pdh"]`);
    await wp.keyboard.press('Escape'); await wp.waitForTimeout(200);
    s = await popState(wp, WS);
    check(!s.open && s.active === 'body' && await wp.textContent('#wsKeys') === 'KEYS ON', 'Escape: closed, the focus back on the page, KEYS ON');
    // the rightmost chip of the rightmost panel with chips: flipped left if it would leave the screen
    const right = await wp.evaluate(() => { const cs = [...document.querySelectorAll('.ws-head .ind-chips > .ind-chip[data-id]')]; cs.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
      const c = cs[0]; return { panel: c.closest('.ws-panel').dataset.id, id: c.dataset.id }; });
    await wp.click(`.ws-panel[data-id="${right.panel}"] .ind-chips > .ind-chip[data-id="${right.id}"]`); await wp.waitForTimeout(200);
    s = await popState(wp, `.ws-panel[data-id="${right.panel}"]`);
    check(s.open && s.inside && !s.scrolls, 'the rightmost chip: whole on screen (' + Math.round(s.x) + ' to ' + Math.round(s.x + s.w) + ' of ' + w + ')');
    await wp.mouse.click(4, h - 4); await wp.waitForTimeout(200);
    check(!(await popState(wp, `.ws-panel[data-id="${right.panel}"]`)).open && await wp.textContent('#wsKeys') === 'KEYS ON', 'a click outside closes it, KEYS ON');
    await ctx.close();
  }
} finally {
  await browser.close();
  if (bridge) bridge.kill();
}
console.log(`\n${checks - errors.length}/${checks} checks passed`);
if (errors.length) { console.error(errors.length + ' failed'); process.exit(1); }
