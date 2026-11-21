// The planner's resume (chart 1.62.0, section 3: never taken late, never sent twice) against the fake bridge and the fake Desk's
// plan log, one window at 1366 x 768 (sample data only):
//   - a limit plan armed and working; the window reloads: it leads again, finds the entry by its cid and sends nothing;
//   - ChartBridge restarts (the fake keeps no orders across a restart): the plan's entry is not found, so the plan says "sent,
//     outcome not known: check NinjaTrader" with an alarm, and it is NEVER sent again;
//   - a confirmation armed, every window closed, the line touched meanwhile: on the next open it is missed (decision 10 A),
//     nothing sent;
//   - a plan armed with a short expiry and every window closed past it: on the next open it is expired, nothing sent.
//   npm run smoke:planner-resume        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { startDesk } from './fake-desk.mjs';
import { checker, startBridge, spyContext, openPage, livePage, st, card, drawAt, orders, wait } from './planner-smoke-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.PLANNER_RESUME_SMOKE_PORT || 8885), DP = PORT + 40;
const pinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-resume-')), pinFile = path.join(pinDir, 'pin.txt');
const { fail, check, until, done } = checker();
const desk = await startDesk(DP, {});
let bridge = await startBridge(root, PORT, DP, pinFile, ['--fold-trades']);
const control = async (what, q) => (await fetch(`http://127.0.0.1:${PORT}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
const setPrice = async px => { await control('price', { root: 'MNQ', p: px }); await wait(150); };
const kinds = v => v.events.map(e => e.kind);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
async function planOn(p, price, type) {
  const n = desk.plans.length;
  await drawAt(p, price, until);
  await until(async () => (await st(p)).drafts.length === 1, 'a plan drawn at ' + price);
  if (type) { await p.selectOption(card('type'), type); await wait(200); }
  await p.click(card('submit'));
  await until(() => desk.plans.length === n + 1, 'submitted');
  await until(async () => (await st(p)).plans.some(x => x.seq === desk.plans[n].seq && x.phase === 'submitted'), 'submitted on the page');
  await p.click(card('arm'));
  await until(() => kinds(desk.plans[n]).includes('arm'), 'armed');
  return desk.plans[n];
}
try {
  const ctx = await spyContext(browser);
  let p = await openPage(ctx, PORT, fail);
  await until(() => p.$eval('[data-tk-id="oAcct"]', s => [...s.options].some(o => o.value === 'Sim101')), 'Sim101 in the ticket\'s picker');
  await p.selectOption('[data-tk-id="oAcct"]', 'Sim101'); await wait(300);
  await until(async () => (await st(p)).leader === true, 'it leads', 15000);
  await setPrice(25000);

  /* ---- armed and working; a reload: found by its cid, nothing sent */
  const v1 = await planOn(p, 24990);
  await until(() => kinds(v1).includes('placed'), 'placed');
  check((await orders(p)).length === 1, 'one order sent');
  await p.reload(); await livePage(p);
  await until(async () => (await st(p)).leader === true, 'it leads again after the reload', 15000);
  await wait(2000);
  check((await orders(p)).length === 0, 'after the reload nothing is sent again');
  check(!v1.events.some(e => e.kind === 'owner'), 'the working entry was found (no alarm)');

  /* ---- ChartBridge restarts and the entry is gone: outcome not known, an alarm, never sent again */
  bridge.kill(); await wait(800);
  bridge = await startBridge(root, PORT, DP, pinFile, ['--fold-trades']);
  await until(() => p.evaluate(() => document.getElementById('wsConn').classList.contains('live') && window.workspace.ticket().snapReady), 'connected again', 30000);
  check(await until(() => v1.events.some(e => e.kind === 'owner' && e.detail.what === 'unknown'), 'sent, outcome not known: recorded', 10000), 'after the restart the entry is not found: sent, outcome not known, recorded');
  await until(() => p.$eval('#wsAlertText', e => /Planner: Plan #\d+: Sent, outcome not known: check NinjaTrader/.test(e.textContent)), 'the alarm on the page');
  await wait(1500);
  check((await orders(p)).length === 0, 'never sent again');
  check(desk.planFlags.length === 0, 'The Desk flagged no second sent');
  await p.click(card('cancel')).catch(() => {});
  await wait(500);

  /* ---- a confirmation; every window closed; the line touched meanwhile: missed */
  await setPrice(25000);
  const v2 = await planOn(p, 24995, 'touch_confirm');
  await p.close();
  await setPrice(24994); await setPrice(25002);
  p = await openPage(ctx, PORT, fail);
  await until(() => kinds(v2).includes('missed'), 'missed (not taken late)', 15000);
  await wait(1000);
  check(kinds(v2).includes('missed') && !kinds(v2).includes('sent'), 'missed, from the minutes since Arm (decision 10 A)');
  check((await orders(p)).length === 0, 'a missed touch sends nothing');

  /* ---- armed with a short expiry; every window closed past it: expired */
  desk.expiryMs = 2000;
  await setPrice(25000);
  const v3 = await planOn(p, 24980, 'touch_confirm');
  await p.close();
  await wait(3000);
  p = await openPage(ctx, PORT, fail);
  await until(() => kinds(v3).includes('expired'), 'expired while no window watched it', 15000);
  check(kinds(v3).includes('expired') && !kinds(v3).includes('sent'), 'expired while no window watched it');
  check((await orders(p)).length === 0, 'an expired plan sends nothing');
  desk.expiryMs = 0;
} finally {
  await browser.close();
  bridge.kill(); await desk.close();
  fs.rmSync(pinDir, { recursive: true, force: true });
}
done('planner resume smoke');
