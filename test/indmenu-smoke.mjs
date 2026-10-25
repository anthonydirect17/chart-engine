// Chart 1.39.1 smoke: a tall Indicators menu in the workspace stays in the visible area below the top bar and scrolls inside
// itself, and so does an indicator's gear card. Against the fake bridge (sample data, made-up accounts; nothing reaches a
// broker), 9 indicators on one chart:
//   at 1366 x 768: the menu is taller than the window, so it starts just below the top bar, ends on screen, and its list
//     scrolls inside it (to its last group); each gear's card beside it, below the top bar, on screen;
//   a window made shorter while the menu is open (1366 x 420): placed again, still below the top bar and on screen; a gear card
//     taller than that room scrolls inside itself;
//   at 400 x 768 (no room beside the menu for a card): the same for the menu; each gear's card goes in the list under its row,
//     in sight, never off the screen.
//   npm run smoke:indmenu      (CHROMIUM_PATH=/path/to/chrome; INDMENU_SMOKE_PORT)
// Screenshots test/out/indmenu-1366.png, indmenu-gear-1366.png, indmenu-short-1366.png, indmenu-400.png, indmenu-gear-400.png.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin, ticketOnSim101 } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const PORT = +(process.env.INDMENU_SMOKE_PORT || 8957);
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));

const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--trading', '--trade-accounts=Sim101', '--test-controls', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => bridge.stdout.once('data', r));
const browser = ticketOnSim101(await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}));

/* in the page: where the menu, its list and the open gear's card are, against the top bar and the window */
const where = sel => {
  const bar = document.querySelector('.ws-top').getBoundingClientRect(), pn = document.querySelector(sel + ' .ind-panel'), r = pn.getBoundingClientRect();
  const body = pn.querySelector('.ind-body'), b = body.getBoundingClientRect(), c = pn.querySelector('.ind-set'), cr = c ? c.getBoundingClientRect() : null;
  const R = x => Math.round(x);
  return { bar: R(bar.bottom), top: R(r.top), bottom: R(r.bottom), left: R(r.left), right: R(r.right), w: innerWidth, h: innerHeight,
    list: { top: R(b.top), bottom: R(b.bottom), scroll: body.scrollHeight, client: body.clientHeight },
    card: cr ? { top: R(cr.top), bottom: R(cr.bottom), left: R(cr.left), right: R(cr.right), scroll: c.scrollHeight, client: c.clientHeight, inList: body.contains(c) && getComputedStyle(c).position === 'static' } : null };
};
const inMenu = (u) => u.top >= u.bar && u.bottom <= u.h && u.left >= 0 && u.right <= u.w;
const cardOk = (u) => !u.card || (u.card.inList
  ? u.card.top >= u.list.top - 1 && u.card.bottom <= u.list.bottom + 1 || (u.card.bottom - u.card.top > u.list.bottom - u.list.top && u.card.top <= u.list.top + 1)   // in the list, in sight
  : u.card.top >= u.bar && u.card.bottom <= u.h && u.card.left >= 0 && u.card.right <= u.w);

async function open(w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));
  await page.goto(`http://localhost:${PORT}/live/`);
  await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
  await enterPin(page, TEST_PIN);
  await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 });
  await wait(800);
  const pid = await page.evaluate(() => window.workspace.panels().find(p => p.type === 'chart').id);
  return { ctx, page, P: `.ws-panel[data-id="${pid}"]` };
}
/* nine indicators on the chart, from the menu's groups (each group opened in turn, its first + taken) */
async function nineOn(page, P) {
  await page.$eval(P + ' .ind-btn', b => b.click()); await wait(200);
  for (let k = 0; k < 20; k++) {
    if ((await page.$$eval(P + ' .ind-panel .ind-switch', l => l.length)) >= 9) break;
    let added = false;
    for (const c of await page.$$eval(P + ' .ind-panel [data-act="cat"]', l => l.map(b => b.dataset.id))) {
      await page.$eval(P + ` .ind-panel [data-act="cat"][data-id="${c}"]`, b => { if (b.getAttribute('aria-expanded') !== 'true') b.click(); }); await wait(50);
      const a = await page.$(P + ' .ind-panel .ind-add');
      if (a) { await a.evaluate(b => b.click()); added = true; await wait(100); break; }
    }
    if (!added) break;
  }
  const n = await page.$$eval(P + ' .ind-panel .ind-switch', l => l.length);
  await page.$eval(P + ' .ind-btn', b => b.click()); await wait(100);   // closed; opened again below, groups folded
  return n;
}
async function gears(page, P, label, shot) {
  const ids = await page.$$eval(P + ' .ind-panel [data-act="gear"]', l => l.map(b => b.dataset.id));
  const bad = [];
  let inList = 0;
  for (const g of ids) {
    await page.$eval(P + ` .ind-panel [data-act="gear"][data-id="${g}"]`, b => b.click()); await wait(250);
    const u = await page.evaluate(where, P);
    if (!u.card) bad.push(g + ': no card');
    else { if (u.card.inList) inList++; if (!inMenu(u) || !cardOk(u)) bad.push(g + ' ' + JSON.stringify({ menu: [u.top, u.bottom, u.left, u.right], card: u.card, list: u.list, bar: u.bar })); }
    if (shot && g === 'bands') await page.screenshot({ path: path.join(out, shot) });
    await page.$eval(P + ` .ind-panel [data-act="gear"][data-id="${g}"]`, b => b.click()); await wait(100);
  }
  return { n: ids.length, bad, inList };
}

try {
  /* ---------------- 1366 x 768 */
  console.log('1366 x 768, 9 indicators on');
  let { ctx, page, P } = await open(1366, 768);
  check(await nineOn(page, P) === 9, 'nine indicators on one chart');
  await page.$eval(P + ' .ind-btn', b => b.click()); await wait(400);
  let u = await page.evaluate(where, P);
  check(inMenu(u) && u.top <= u.bar + 8, 'the menu, taller than the window, starts just below the top bar and ends on screen: ' + JSON.stringify([u.bar, u.top, u.bottom, u.h]));
  check(u.list.scroll > u.list.client, 'its list scrolls inside it (' + u.list.scroll + ' in ' + u.list.client + ' px)');
  await page.$eval(P + ' .ind-body', b => { b.scrollTop = b.scrollHeight; }); await wait(100);
  const last = await page.$eval(P + ' .ind-body', b => { const l = [...b.querySelectorAll('.ind-cat')].pop(), r = l.getBoundingClientRect(), br = b.getBoundingClientRect(); return r.top >= br.top && r.bottom <= br.bottom; });
  check(last, 'scrolled inside, its last group comes into sight');
  await page.$eval(P + ' .ind-body', b => { b.scrollTop = 0; });
  await page.screenshot({ path: path.join(out, 'indmenu-1366.png') });
  let g = await gears(page, P, '1366', 'indmenu-gear-1366.png');
  check(g.n === 9 && !g.bad.length && g.inList === 0, 'each of the 9 gears: its card beside the menu, below the top bar and on screen' + (g.bad.length ? ': ' + g.bad.join('; ') : ''));
  /* the window made shorter while the menu is open */
  await page.setViewportSize({ width: 1366, height: 420 }); await wait(300);
  u = await page.evaluate(where, P);
  check(inMenu(u), 'the window made 420 px tall while it is open: placed again, below the top bar and on screen: ' + JSON.stringify([u.bar, u.top, u.bottom, u.h]));
  await page.$eval(P + ' .ind-panel [data-act="gear"][data-id="levels"]', b => b.click()); await wait(250);
  u = await page.evaluate(where, P);
  check(!!u.card && cardOk(u) && u.card.scroll > u.card.client, 'a gear card taller than the room (Levels at 420 px) stays below the top bar and on screen and scrolls inside itself: ' + JSON.stringify(u.card));
  await page.screenshot({ path: path.join(out, 'indmenu-short-1366.png') });
  await ctx.close();

  /* ---------------- 400 x 768 */
  console.log('400 x 768, 9 indicators on');
  ({ ctx, page, P } = await open(400, 768));
  check(await nineOn(page, P) === 9, 'nine indicators on one chart');
  const sw0 = await page.evaluate(() => document.documentElement.scrollWidth);   // the workspace's own width at 400 px, menu closed
  await page.$eval(P + ' .ind-btn', b => b.click()); await wait(400);
  u = await page.evaluate(where, P);
  check(inMenu(u), 'the menu below the top bar and whole on the 400 px screen: ' + JSON.stringify([u.bar, u.top, u.bottom, u.left, u.right]));
  check(u.list.scroll > u.list.client, 'its list scrolls inside it (' + u.list.scroll + ' in ' + u.list.client + ' px)');
  await page.screenshot({ path: path.join(out, 'indmenu-400.png') });
  g = await gears(page, P, '400', 'indmenu-gear-400.png');
  check(g.n === 9 && !g.bad.length && g.inList === 9, 'each of the 9 gears: no room beside the menu, so its card is in the list under its row, in sight, never off the screen' + (g.bad.length ? ': ' + g.bad.join('; ') : ''));
  /* not checked here: the workspace itself is wider than a 400 px window (its grid, before this release too) */
  console.log('  note the workspace at 400 px is ' + sw0 + ' px wide with the menu closed (its grid; not this release)');
  await ctx.close();
} catch (e) {
  fail('exception: ' + (e && e.stack || e));
} finally {
  await browser.close();
  bridge.kill();
}
console.log(errors.length ? `indmenu smoke: ${errors.length} of ${checks} checks FAILED` : `indmenu smoke: all ${checks} checks passed`);
process.exit(errors.length ? 1 : 0);
