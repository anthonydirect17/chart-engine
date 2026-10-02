// No scrolling, ever (chart 1.14.0, Anthony's item 1): every panel, menu, popover and dialog fits its content with no
// scrollbar and nothing cut, at 1366x768, 1920x1080 and 2560x1440, in the workspace (live/index.html) and on the single
// chart page (/single.html), against the fake bridge (sample data; nothing reaches a broker).
//   Opened one at a time: Colors, Settings, the Indicators menu with each indicator's gear, the chart's instrument and bars
//   popover and its small menu, Add panel, the Time and Sales gear, the Layout select, the New layout and Reset dialogs;
//   the order ticket and the order bar as they stand; the single chart page's toolbar on one line.
//   Fails on any element (the open one and everything in it) whose content is wider than its box (scrollWidth >
//   clientWidth) where it would scroll or be cut, any vertical scroll (Time and Sales rows are the only intended one), and
//   any part of it off the screen. Text cut on purpose with an ellipsis (its whole text in a tooltip) is not counted.
//   npm run smoke:noscroll        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const PORT = +(process.env.NOSCROLL_SMOKE_PORT || 8891);
const SIZES = [[1366, 768], [1920, 1080], [2560, 1440]];
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };

/* In the page: everything under `sel` (and the element itself) that scrolls or is cut, and whether it is on screen. */
function scan(sel) {
  const rootEl = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (!rootEl) return { missing: true, bad: [] };
  const bad = [];
  const name = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  const visible = el => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0; };
  const all = [rootEl, ...rootEl.querySelectorAll('*')];
  for (const el of all) {
    if (!visible(el) || el.tagName === 'CANVAS' || el.tagName === 'OPTION' || el.tagName === 'svg' || el.closest('svg')) continue;
    if (el.closest('.tp-list')) continue;                                  // Time and Sales rows: the one intended scroll
    if (el.closest('.visually-hidden')) continue;                          // for screen readers only, clipped on purpose
    const s = getComputedStyle(el);
    if (s.textOverflow === 'ellipsis') continue;                           // cut on purpose, the whole text in its tooltip
    const clipsX = s.overflowX !== 'visible', clipsY = s.overflowY !== 'visible';
    const isBox = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
    if ((clipsX || isBox) && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) bad.push(name(el) + ' wide ' + el.scrollWidth + '>' + el.clientWidth);
    if (clipsY && el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0 && !isBox) bad.push(name(el) + ' tall ' + el.scrollHeight + '>' + el.clientHeight);
  }
  for (const el of all) {                                                  // a card of its own (an indicator's gear) on screen too
    if (el === rootEl || !visible(el) || !['absolute', 'fixed'].includes(getComputedStyle(el).position) || el.closest('.visually-hidden')) continue;
    const q = el.getBoundingClientRect();
    if (q.width > 1 && (q.left < -0.5 || q.top < -0.5 || q.right > innerWidth + 0.5 || q.bottom > innerHeight + 0.5)) bad.push(name(el) + ' off screen ' + JSON.stringify([Math.round(q.left), Math.round(q.top), Math.round(q.right), Math.round(q.bottom)]));
  }
  const r = rootEl.getBoundingClientRect();
  if (r.left < -0.5 || r.top < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) bad.push(name(rootEl) + ' off screen ' + JSON.stringify([Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]));
  const d = document.documentElement;
  if (d.scrollWidth > innerWidth + 1 || d.scrollHeight > innerHeight + 1) bad.push('the page scrolls ' + d.scrollWidth + 'x' + d.scrollHeight);
  return { bad, w: Math.round(r.width), h: Math.round(r.height) };
}
/* In the page: for each of `sels`, whether the NO STOP question (`q`) leaves it uncovered (no overlap of the two boxes; its
   own buttons: on top at their center). */
function uncovered([q, sels]) {
  const out = {}, qe = document.querySelector(q), qr = qe.getBoundingClientRect();
  for (const s of sels) {
    const el = document.querySelector(s);
    if (!el || !el.getClientRects().length) { out[s] = 'not shown'; continue; }
    const r = el.getBoundingClientRect();
    if (qe.contains(el)) { const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); out[s] = !!hit && (hit === el || el.contains(hit)); continue; }
    out[s] = r.right <= qr.left || r.left >= qr.right || r.bottom <= qr.top || r.top >= qr.bottom;
  }
  return out;
}
async function expectFits(page, sel, what) {
  await page.waitForTimeout(80);
  const r = await page.evaluate(scan, sel);
  check(!r.missing && !r.bad.length, what + (r.missing ? ': not found' : ' fits (' + r.w + 'x' + r.h + ')' + (r.bad.length ? ': ' + r.bad.slice(0, 6).join('; ') : '')));
}

const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--trading', '--trade-accounts=Sim101', '--test-controls',
  '--version=0.3.8', '--data-037', '--live-rate=40', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => bridge.stdout.once('data', r));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  for (const [w, h] of SIZES) {
    console.log(`\n${w}x${h}`);
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    const page = await ctx.newPage();
    page.on('pageerror', e => fail('page error: ' + e.message));

    /* ---------------- the workspace */
    await page.goto(`http://localhost:${PORT}/live/`);
    await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
    await enterPin(page, TEST_PIN);
    await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 });
    await page.waitForTimeout(800);
    const esc = async () => { await page.keyboard.press('Escape'); await page.mouse.click(w - 4, h - 4); await page.waitForTimeout(60); };
    await expectFits(page, '.ws-top', 'workspace top bar');
    for (const id of (await page.evaluate(() => window.workspace.panels().map(p => p.id + ':' + p.type)))) {
      const [pid, type] = id.split(':');
      await expectFits(page, `.ws-panel[data-id="${pid}"] .ws-head`, 'the ' + type + ' panel\'s header');
      if (type === 'ticket') await expectFits(page, `.ws-panel[data-id="${pid}"] .ws-body`, 'the order ticket');
      if (type === 'tape') await expectFits(page, `.ws-panel[data-id="${pid}"] .ws-body`, 'Time and Sales (its rows the only scroll)');
    }
    await page.click('#wsColors .ce-theme-btn'); await expectFits(page, '#wsColors .ce-theme-panel', 'Colors'); await esc();
    await page.click('#wsSet'); await expectFits(page, '#wsSettings', 'Settings'); await esc();
    await page.click('#wsAdd'); await expectFits(page, '#wsAddMenu', 'Add panel'); await esc();
    await expectFits(page, '#wsLayout', 'the Layout select');
    const first = await page.evaluate(() => window.workspace.panels().find(p => p.type === 'chart').id);
    await page.click(`.ws-panel[data-id="${first}"] .ws-view`); await expectFits(page, '#wsView', 'a chart\'s instrument and bars'); await esc();
    await page.click(`.ws-panel[data-id="${first}"] .ws-more`); await expectFits(page, '#wsMore', 'a chart\'s small menu'); await esc();
    for (const pid of await page.evaluate(() => window.workspace.panels().filter(p => p.type === 'chart').map(p => p.id))) {
      await page.click(`.ws-panel[data-id="${pid}"] .ind-btn`);
      await expectFits(page, `.ws-panel[data-id="${pid}"] .ind-panel`, 'Indicators of chart ' + pid);
      const gears = await page.$$eval(`.ws-panel[data-id="${pid}"] .ind-panel [data-act="gear"]`, l => l.map(b => b.dataset.id));
      for (const g of gears) {
        await page.click(`.ws-panel[data-id="${pid}"] .ind-panel [data-act="gear"][data-id="${g}"]`);
        await expectFits(page, `.ws-panel[data-id="${pid}"] .ind-panel`, '  its ' + g + ' gear');
        await page.click(`.ws-panel[data-id="${pid}"] .ind-panel [data-act="gear"][data-id="${g}"]`);
      }
      await esc();
      if (w !== 1366) break;                               // every chart at the smallest size; the first at the others
    }
    const tape = await page.evaluate(() => (window.workspace.panels().find(p => p.type === 'tape') || {}).id);
    if (tape) { await page.click(`.ws-panel[data-id="${tape}"] [data-act="gear"]`); await expectFits(page, '#wsGear', 'the Time and Sales gear'); await esc(); }
    await page.selectOption('#wsLayout', '\u0001new'); await expectFits(page, '#wsDialog', 'the New layout dialog'); await page.keyboard.press('Escape');
    await page.click('#wsSet'); await page.click('#wsReset'); await expectFits(page, '#wsDialog', 'the Reset dialog'); await page.keyboard.press('Escape');
    if (w === 1366) { await page.click('#wsColors .ce-theme-btn'); await page.screenshot({ path: path.join(out, 'noscroll-ws-colors-1366.png') }); await esc(); }
    // the NO STOP question (1.13.0; 1.14.0 placed after the connection status): Armed, Buy MKT with the stop at 0
    if (await page.$('.tk [data-tk-id="armBtn"]')) {
      await page.click('.tk [data-tk-id="armBtn"]');
      await page.fill('.tk [data-tk-id="bStop"]', '0'); await page.press('.tk [data-tk-id="bStop"]', 'Enter');
      await page.click('.tk [data-tk-id="buyMkt"]');
      await page.waitForSelector('#wsNoStop:not([hidden])', { timeout: 5000 }).catch(() => fail('the NO STOP question did not show'));
      await expectFits(page, '#wsNoStop', 'the NO STOP question');
      const u = await page.evaluate(uncovered, ['#wsNoStop', ['#wsConn', '#wsKeys', '#wsFlat', '#wsNoStopCancel', '#wsNoStopSend', '.tk [data-tk-id="flattenBtn"]', '.tk [data-tk-id="armBtn"]']]);
      check(Object.values(u).every(v => v === true), 'the NO STOP question covers none of: the connection status, KEYS, Flatten all, Cancel, Send, the ticket\'s Close and Armed ' + JSON.stringify(u));
      const cut = await page.evaluate(() => ['wsNoStopTitle', 'wsNoStopText'].map(id => document.getElementById(id)).filter(e => !e.hidden && e.scrollWidth > e.clientWidth + 1).map(e => e.id + ': ' + e.textContent));
      check(cut.length === 0, `the NO STOP question's text on one line, not cut (review D2): "${await page.textContent('#wsNoStop')}"` + (cut.length ? ' cut: ' + cut.join('; ') : ''));
      await page.screenshot({ path: path.join(out, `noscroll-ws-nostop-${w}.png`) });
      await page.click('#wsNoStopCancel');
      await page.click('.tk [data-tk-id="armBtn"]');
    }

    /* ---------------- the single chart page */
    await page.goto(`http://localhost:${PORT}/live/single.html`);
    await page.waitForFunction(() => document.getElementById('connPill') || document.querySelector('.cb-pin-key'), null, { timeout: 15000 });
    if (await page.$('.cb-pin-key')) await enterPin(page, TEST_PIN);
    await page.waitForFunction(() => /LIVE/.test((document.getElementById('connPill') || {}).textContent || ''), null, { timeout: 30000 });
    await page.waitForTimeout(600);
    await expectFits(page, 'header.bar', 'single: the toolbar');
    // one line: every item of the toolbar overlaps every other vertically
    const line = await page.evaluate(() => { const rs = [...document.querySelector('header.bar').children].filter(c => c.getClientRects().length).map(c => c.getBoundingClientRect());
      return { one: Math.max(...rs.map(r => r.top)) < Math.min(...rs.map(r => r.bottom)), h: Math.round(document.querySelector('header.bar').getBoundingClientRect().height) }; });
    check(line.one, 'single: the toolbar is one line (' + line.h + ' px tall)');
    await expectFits(page, '#obar', 'single: the order bar');
    await page.click('.ce-theme-btn'); await expectFits(page, '.ce-theme-panel', 'single: Colors'); await esc();
    // the NO STOP question: under the legend, the LIVE and ARMED pills in view
    await page.click('#armBtn');
    await page.fill('#bStop', '0'); await page.press('#bStop', 'Enter');
    await page.click('#buyMkt');
    await page.waitForSelector('#noStopAsk:not([hidden])', { timeout: 5000 }).catch(() => fail('single: the NO STOP question did not show'));
    await expectFits(page, '#noStopAsk', 'single: the NO STOP question');
    const su = await page.evaluate(uncovered, ['#noStopAsk', ['#connPill', '#armPill', '#legend', '#flattenBtn', '#armBtn', '#noStopCancel', '#noStopSend']]);
    check(Object.values(su).every(v => v === true), 'single: the NO STOP question covers none of: LIVE, ARMED, the legend, Flatten, the Armed switch, Cancel, Send ' + JSON.stringify(su));
    await page.screenshot({ path: path.join(out, `noscroll-single-nostop-${w}.png`) });
    await page.click('#noStopCancel');
    await page.click('#armBtn');
    await page.click('#setBtn'); await expectFits(page, '#setPanel', 'single: Settings'); await esc();
    await page.click('#moreBtn'); await expectFits(page, '#moreMenu', 'single: the small menu (drawing tools, Reset view)'); await esc();
    await page.click('#indBtn'); await expectFits(page, '#indPanel', 'single: Indicators');
    for (const g of await page.$$eval('#indPanel [data-act="gear"]', l => l.map(b => b.dataset.id))) {
      await page.click(`#indPanel [data-act="gear"][data-id="${g}"]`);
      await expectFits(page, '#indPanel', 'single:   its ' + g + ' gear');
      await page.click(`#indPanel [data-act="gear"][data-id="${g}"]`);
    }
    await esc();
    await ctx.close();
  }
} finally {
  await browser.close();
  bridge.kill();
}
console.log(`\n${checks - errors.length}/${checks} checks passed`);
if (errors.length) { console.error(errors.length + ' failed'); process.exit(1); }
