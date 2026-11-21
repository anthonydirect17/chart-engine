// The planner across windows (chart 1.62.0, decisions 1 A and 11 A) against the fake bridge and the fake Desk's plan log, two
// windows of one browser at 1366 x 768 (sample data only):
//   - one window leads (Web Lock); a plan drawn, submitted and armed in the OTHER window is sent by the leader, once;
//   - the leader closes with the entry working: the other window takes the lead, finds the entry by its cid (the send journal and
//     The Desk say it was sent) and never sends it again; the fill is recorded there;
//   - a confirmation armed, then the leader closes before the touch: the new leader watches, and the touch and the minute's close
//     back send exactly one market order;
//   - over the whole run exactly one order message per plan, and The Desk flags no second sent.
//   npm run smoke:planner-windows        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startDesk } from './fake-desk.mjs';
import { checker, startBridge, spyContext, openPage, st, card, drawAt, orders, wait } from './planner-smoke-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.PLANNER_WINDOWS_SMOKE_PORT || 8883), DP = PORT + 40;
const { fail, check, until, done } = checker();
const desk = await startDesk(DP, {});
const bridge = await startBridge(root, PORT, DP);
const control = async (what, q) => (await fetch(`http://127.0.0.1:${PORT}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
const setPrice = async px => { await control('price', { root: 'MNQ', p: px }); await wait(150); };
const kinds = v => v.events.map(e => e.kind);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const ctx = await spyContext(browser);
  let a = await openPage(ctx, PORT, fail);
  await until(() => a.$eval('[data-tk-id="oAcct"]', s => [...s.options].some(o => o.value === 'Sim101')), 'Sim101 in the ticket\'s picker');
  await a.selectOption('[data-tk-id="oAcct"]', 'Sim101'); await wait(300);
  await until(async () => (await st(a)).leader === true, 'the first window leads', 15000);
  let b = await openPage(ctx, PORT, fail);
  await until(async () => (await st(b)).ok === true, 'the second window\'s planner');
  check((await st(b)).leader === false, 'the second window does not lead');
  await setPrice(25000);

  /* ---- drawn, submitted and armed in the window that does not lead: the leader sends it, once */
  await drawAt(b, 24990, until);
  await until(async () => (await st(b)).drafts.length === 1, 'a plan drawn in the second window');
  await until(async () => (await st(a)).drafts.length === 1, 'the first window shows it too');
  check(await until(() => a.evaluate(() => window.workspace.chart('c1').getPlans().length === 1), 'drawn on the first window\'s chart'), 'every window draws it (decision 1 A)');
  await b.click(card('submit'));
  await until(() => desk.plans.length === 1, 'submitted');
  await until(async () => (await st(b)).plans.some(x => x.phase === 'submitted'), 'submitted on the page');
  await b.click(card('arm'));
  await until(async () => (await orders(a)).length === 1, 'the leader sent it');
  await wait(800);
  check((await orders(a)).length === 1 && (await orders(b)).length === 0, 'one order, from the leader only');
  await until(() => kinds(desk.plans[0]).includes('placed'), 'placed');
  const sent1 = (await orders(a))[0];
  check(sent1.cid === 'pl' + desk.plans[0].uid + '-e', 'its cid is the plan\'s');

  /* ---- the leader closes with the entry working: the other window leads, finds it, never sends again */
  await a.close();
  await until(async () => (await st(b)).leader === true, 'the second window takes the lead', 10000);
  await wait(1500);
  check((await orders(b)).length === 0, 'the new leader never sends the entry again');
  check(!desk.plans[0].events.some(e => e.kind === 'owner' && e.detail.what === 'unknown'), 'it found the working entry (no alarm)');
  await setPrice(24989);
  await until(() => kinds(desk.plans[0]).includes('filled'), 'the new leader records the fill', 8000);
  /* Flatten all from the window without the ticket (never blocked): recorded as an override, and the plan ends closed */
  await b.click('#wsFlat');
  await until(() => desk.plans[0].events.some(e => e.kind === 'override' && e.detail.what === 'flatten_all'), 'Flatten all recorded as an override', 8000);
  await until(() => kinds(desk.plans[0]).includes('closed'), 'the plan closed when flat', 8000);

  /* ---- a confirmation; the leader closes before the touch; the new leader sends exactly one market order */
  await setPrice(25000);
  a = await openPage(ctx, PORT, fail);
  await until(async () => (await st(a)).ok === true, 'the first window again');
  check((await st(a)).leader === false && (await st(b)).leader === true, 'the second window still leads');
  await drawAt(a, 24995, until);
  await until(async () => (await st(a)).drafts.length === 1, 'a confirmation drawn');
  await a.selectOption(card('type'), 'touch_confirm'); await wait(200);
  await a.click(card('submit'));
  await until(() => desk.plans.length === 2, 'submitted');
  await until(async () => (await st(a)).plans.some(x => x.seq === desk.plans[1].seq && x.phase === 'submitted'), 'submitted on the page');
  await a.click(card('arm'));
  await until(() => kinds(desk.plans[1]).includes('arm'), 'armed');
  await wait(600);
  await b.close();
  await until(async () => (await st(a)).leader === true, 'the first window leads again', 10000);
  await wait(800);
  await setPrice(24995);
  await until(() => kinds(desk.plans[1]).includes('touched'), 'the touch, seen by the new leader');
  await setPrice(24997);
  await until(async () => (await orders(a)).length === 1, 'one market order after the minute\'s close (up to a minute)', 75000);
  await wait(1500);
  const o2 = await orders(a);
  check(o2.length === 1 && o2[0].kind === 'market' && o2[0].cid === 'pl' + desk.plans[1].uid + '-e', 'exactly one market order for the confirmation: ' + JSON.stringify(o2));
  check(desk.planFlags.length === 0, 'The Desk flagged no second sent');
  await a.click('#wsFlat'); await wait(500);
} finally {
  await browser.close();
  bridge.kill(); await desk.close();
}
done('planner windows smoke');
