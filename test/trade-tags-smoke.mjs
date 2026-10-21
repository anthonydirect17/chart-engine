// Chart 1.34.0 smoke (Anthony 2026-10-21): the Trade tags panel. Against the fake bridge (--v3: made-up accounts, trade
// accounts Sim101 and EVAL-A; sample data only) and the fake Desk (test/fake-desk.mjs), at 1366 x 768:
//   npm run smoke:trade-tags        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
// Checks: Trade tags is in + Add panel and placed on the grid; flat, a click records `pre` for the next trade; a key press on a
// chip records nothing; with a position open the chips set before it show with their phase and a click records `open` with the
// trade's first fill; after the close, Last trade shows that trade's chips and a click records `after` (a change is a new
// record, the newest shown); a click on the set chip clears its row; The Desk down: the record waits and goes once it is back;
// nothing the panel does sends an order message. Screenshots test/out/trade-tags-*.png.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';
import { startDesk } from './fake-desk.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.TRADE_TAGS_SMOKE_PORT || 8805), DP = PORT + 40;
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const errors = [];
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, what, ms) => { const end = Date.now() + (ms || 10000); for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); } };
const desk = await startDesk(DP, {});
const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--v3', '--trading', '--test-controls', '--max-qty=MNQ:9,NQ:9', '--test-pin=' + TEST_PIN, '--desk-url=http://127.0.0.1:' + DP], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => bridge.stdout.once('data', r));
const control = async (what, q) => (await fetch(`http://127.0.0.1:${PORT}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const tk = i => `[data-tk-id="${i}"]`;
const TAGS = '.ws-panel.tags';
const chip = (dim, val) => `${TAGS} .tt-chip[data-dim="${dim}"][data-val="${val}"]`;
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(() => {
    window.__sent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (['order', 'change', 'cancel', 'flatten', 'groupPreview', 'groupOrder'].includes(m.type)) window.__sent.push(m); } catch (e) { /* not JSON */ } return send.call(this, d); };
    try { if (!localStorage.getItem('live-workspace-v1')) localStorage.setItem('live-workspace-v1', JSON.stringify({ v: 1, layouts: { Tags: { panels: [
      { id: 'c1', type: 'chart', root: 'MNQ', tf: 'm1', x: 0, y: 0, w: 8, h: 6 }, { id: 'tk', type: 'ticket', x: 8, y: 0, w: 4, h: 4 }] } } })); } catch (e) { /* blocked */ }
  });
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  await p.goto(`http://localhost:${PORT}/live/?layout=Tags`);
  await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
  await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live') && window.workspace.ticket().enabled, null, { timeout: 40000 });
  await until(() => p.$eval(tk('oAcct'), s => [...s.options].some(o => o.value === 'Sim101')), 'Sim101 in the ticket\'s picker');
  await p.selectOption(tk('oAcct'), 'Sim101'); await p.selectOption(tk('root'), 'MNQ'); await wait(500);

  /* + Add panel: Trade tags, placed in the free cells */
  await p.click('#wsAdd');
  check(await p.$eval('#wsAddMenu [data-add="tags"]', b => b.textContent === 'Trade tags'), '+ Add panel offers Trade tags');
  await p.click('#wsAddMenu [data-add="tags"]');
  const placed = await until(() => p.evaluate(() => window.workspace.panels().find(x => x.type === 'tags')), 'the panel in the layout');
  check(placed && placed.x === 8 && placed.y === 4 && placed.w === 4 && placed.h === 2, 'placed where there is room, out of the way: ' + JSON.stringify(placed));
  await until(() => p.$eval(`${TAGS} [data-t="which"]`, e => e.textContent === 'Next trade · MNQ · flat'), 'flat: the next trade');
  check(await p.$eval(`${TAGS} .ws-acct`, e => e.textContent === 'Sim101 · MNQ'), 'the header follows the ticket\'s account and instrument');
  const fits = await p.$eval(TAGS, el => { const r = el.getBoundingClientRect(); return [...el.querySelectorAll('.tt-chip')].every(b => { const c = b.getBoundingClientRect(); return c.width > 0 && c.right <= r.right + 0.5; }) && document.documentElement.scrollWidth <= innerWidth; });
  check(fits, 'every chip inside the panel at 1366, no sideways scroll');

  /* flat: pre records */
  await p.click(chip('setup', 'breakout')); await p.click(chip('grade', 'A+'));
  await until(() => desk.tags.length === 2, 'two records on The Desk');
  check(desk.tags.every(t => t.account === 'Sim101' && t.root === 'MNQ' && t.phase === 'pre' && t.trade_open_ms === null) && desk.tags.map(t => t.dim + '=' + t.value).join() === 'setup=breakout,grade=A+',
    'flat: each click is one pre record, no trade yet: ' + JSON.stringify(desk.tags.map(t => [t.dim, t.value, t.phase])));
  check(await p.$eval(chip('setup', 'breakout'), b => b.getAttribute('aria-pressed') === 'true' && b.querySelector('.tt-ph').textContent === 'pre'), 'the set chip is shown, with its phase');
  await p.focus(chip('context', 'with_trend')); await p.keyboard.press('Enter'); await p.keyboard.press('Space'); await wait(600);
  check(desk.tags.length === 2 && /click only/.test(await p.$eval(`${TAGS} [data-t="foot"]`, e => e.textContent)), 'Enter and Space on a chip record nothing (clicks only)');
  await p.screenshot({ path: path.join(out, 'trade-tags-flat-1366.png') });

  /* the fill: open */
  await control('price', { root: 'MNQ', p: 25000 });
  await control('elsewhere', { account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'market', qty: 2, p: 0 });
  await until(() => p.$eval(`${TAGS} [data-t="which"]`, e => /^Open trade · LONG 2 MNQ since \d\d:\d\d:\d\d$/.test(e.textContent)), 'open: LONG 2', 8000);
  check(await p.$eval(chip('grade', 'A+'), b => b.getAttribute('aria-pressed') === 'true' && b.querySelector('.tt-ph').textContent === 'pre') && await p.$eval(`${TAGS} .tt-switch`, e => e.hidden),
    'open: the chips set before the fill are this trade\'s (pre); the Next/Last switch hides');
  check(await until(() => p.$eval(`${TAGS} .tt-long`, e => getComputedStyle(e).color === 'rgb(61, 220, 151)'), 'the side\'s color', 5000), 'the side in green (trade side only)');
  await p.click(chip('trigger', 'absorption')); await p.click(chip('context', 'with_trend'));
  await until(() => desk.tags.length === 4, 'the open records');
  const opened = desk.tags.slice(2);
  check(opened.every(t => t.phase === 'open' && Number.isInteger(t.trade_open_ms) && t.trade_open_ms > 0) && opened[0].trade_open_ms === opened[1].trade_open_ms, 'open: records name the trade by its first fill: ' + JSON.stringify(opened.map(t => [t.dim, t.phase, t.trade_open_ms])));
  await p.screenshot({ path: path.join(out, 'trade-tags-open-1366.png') });
  const box = await p.$eval(TAGS, e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  await p.screenshot({ path: path.join(out, 'trade-tags-panel.png'), clip: box });

  /* the close: Last trade, after */
  await control('elsewhere', { account: 'Sim101', root: 'MNQ', side: 'sell', kind: 'market', qty: 2, p: 0 });
  await until(() => p.$eval(`${TAGS} [data-t="which"]`, e => e.textContent === 'Next trade · MNQ · flat'), 'flat again: the next trade', 8000);
  check(await p.$$eval(`${TAGS} .tt-chip[aria-pressed="true"]`, bs => bs.length === 0), 'the next trade starts with no chips');
  await p.click(`${TAGS} .tt-sw[data-target="last"]`);
  await until(() => p.$eval(`${TAGS} [data-t="which"]`, e => /^Last trade · closed \d\d:\d\d:\d\d · MNQ$/.test(e.textContent)), 'Last trade');
  const lastChips = await p.$$eval(`${TAGS} .tt-chip[aria-pressed="true"]`, bs => bs.map(b => b.dataset.dim + '=' + b.dataset.val + ':' + b.querySelector('.tt-ph').textContent).sort());
  check(lastChips.join() === 'context=with_trend:open,grade=A+:pre,setup=breakout:pre,trigger=absorption:open', 'Last trade: its chips with their phases: ' + lastChips.join());
  await p.click(chip('grade', 'A'));
  await until(() => desk.tags.length === 5, 'the after record');
  const after = desk.tags[4];
  check(after.phase === 'after' && after.dim === 'grade' && after.value === 'A' && after.trade_open_ms === opened[0].trade_open_ms, 'after: a new record for that trade (never an overwrite): ' + JSON.stringify(after));
  check(await p.$eval(chip('grade', 'A'), b => b.getAttribute('aria-pressed') === 'true' && b.querySelector('.tt-ph').textContent === 'after') && await p.$eval(chip('grade', 'A+'), b => b.getAttribute('aria-pressed') === 'false'), 'the newest record is the row\'s chip');
  await p.click(chip('context', 'with_trend'));
  await until(() => desk.tags.length === 6, 'the clear');
  check(desk.tags[5].value === null && desk.tags[5].dim === 'context' && await p.$eval(chip('context', 'with_trend'), b => b.getAttribute('aria-pressed') === 'false'), 'a click on the set chip clears its row (a record with value null)');
  await p.screenshot({ path: path.join(out, 'trade-tags-last-1366.png') });

  /* The Desk down: kept, sent again */
  desk.down = true;
  await p.click(chip('setup', 'reversal'));
  await until(() => p.$eval(`${TAGS} [data-t="foot"]`, e => /^1 waiting for The Desk/.test(e.textContent)), 'the waiting note', 9000);
  check(desk.tags.length === 6, 'The Desk down: the record waits in this browser');
  desk.down = false;
  await until(() => desk.tags.length === 7 && desk.tags[6].value === 'reversal', 'the resend', 15000);
  check(desk.tags.length === 7, 'The Desk back: sent again within 10 seconds');
  check((await p.evaluate(() => window.__sent.length)) === 0, 'nothing the panel did sent an order message');

  /* a reload keeps the panel and the chips */
  await p.reload();
  await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
  await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live') && window.workspace.ticket().enabled, null, { timeout: 40000 });
  await until(() => p.$(TAGS), 'the panel after a reload');
  /* (the fake bridge replays only its sample fills on a reconnect, so the last trade cannot be named here; ChartBridge replays
     the session's executions) the records are this browser's and The Desk's again */
  const kept = await p.evaluate(() => { try { return JSON.parse(localStorage.getItem('live-trade-tags-v1')); } catch (e) { return null; } });
  check(kept && kept.records.length === 7 && kept.pending.length === 0, 'a reload keeps the panel and the 7 records, none waiting');
  check(await until(() => desk.log.some(x => x.method === 'GET' && x.which === 'trade-tags'), 'The Desk read back', 8000), 'the panel reads The Desk\'s records for the session (another window\'s clicks)');
} catch (e) {
  fail('threw: ' + (e && e.stack || e));
} finally {
  await browser.close();
  bridge.kill();
  await desk.close();
}
console.log(errors.length ? `\n${errors.length} FAILED` : '\nall passed');
process.exit(errors.length ? 1 : 0);
