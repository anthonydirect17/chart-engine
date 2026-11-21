// The planner (chart 1.62.0, Anthony 2026-11-21) against the fake bridge (--v3: made-up accounts, Sim101; sample data, nothing
// reaches a broker) and the fake Desk's plan log (test/fake-desk.mjs), in the workspace at 1366 x 768:
//   - the Plan tool on the drawing ring draws a plan where clicked, on every chart of the instrument; the card; Submit stamps it;
//   - Arm stamps it, turns the ticket's Armed off (the light lock), and the leader sends ONE order built from the plan alone
//     (cid pl<uid>-e, the plan's account, qty and bracket in ticks from the line) while the ticket shows other values;
//   - the limit fills: placed and filled are recorded; Flatten works with the ticket unarmed and is recorded (an override), and
//     the plan ends closed; Flatten, Flatten all and Cut half are never blocked;
//   - Market on touch on the stop side: a stop-market at the line;
//   - a confirmation: nothing until the touch, then a 1 minute close back over the line: one market order, the bracket from the
//     last price;
//   - stop-through before the fill ends the plan with nothing sent; expiry cancels the working entry; Cancel on the card cancels it;
//   - Planner off refuses a new plan; an older Desk with no plan log: the planner says so and hides.
// CME's hours are not the page's here: the smoke opens CME (ChartEngine.util.cmeClosed answers false) so Arm works any day.
//   npm run smoke:planner        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';
import { startDesk } from './fake-desk.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.PLANNER_SMOKE_PORT || 8881), DP = PORT + 40;
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, what, ms) => { const end = Date.now() + (ms || 10000); for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); } };
const desk = await startDesk(DP, {});
const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--v3', '--trading', '--test-controls', '--max-qty=MNQ:9,NQ:9', '--pc=TESTPC', '--test-pin=' + TEST_PIN, '--desk-url=http://127.0.0.1:' + DP], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => bridge.stdout.once('data', r));
const control = async (what, q) => (await fetch(`http://127.0.0.1:${PORT}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const tk = i => `[data-tk-id="${i}"]`;
const plans = () => desk.plans;
const kinds = v => v.events.map(e => e.kind);
const LAYOUT = { v: 1, layouts: { Plan: { panels: [{ id: 'c1', type: 'chart', root: 'MNQ', tf: 'm1', x: 0, y: 0, w: 5, h: 6 }, { id: 'c2', type: 'chart', root: 'MNQ', tf: 'm5', x: 5, y: 0, w: 4, h: 6 }, { id: 'tk', type: 'ticket', x: 9, y: 0, w: 3, h: 6 }] } } };
let p;
async function openPage(ctx) {
  const pg = await ctx.newPage();
  pg.on('pageerror', e => fail('pageerror: ' + e.message));
  pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log('  console: ' + m.text()); });
  await pg.goto(`http://localhost:${PORT}/live/?layout=Plan`);
  await pg.waitForSelector('.cb-pin-key', { timeout: 15000 }).then(() => enterPin(pg, TEST_PIN), () => {});
  await pg.waitForFunction(() => document.getElementById('wsConn').classList.contains('live') && window.workspace.ticket().enabled, null, { timeout: 40000 });
  await pg.evaluate(() => { window.ChartEngine.util.cmeClosed = () => false; });   // CME open, whatever day the smoke runs
  return pg;
}
/* the Plan tool on chart c1 (the drawing ring's fifth button), then a click at `price` */
async function drawAt(pg, price, chartId) {
  const id = chartId || 'c1';
  const box = await pg.$eval(`.ws-panel[data-id="${id}"] canvas.ce-canvas`, c => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await pg.mouse.click(box.x + box.w * 0.45, box.y + box.h * 0.35, { button: 'middle' });
  await pg.click('#wsRing [data-ring="plan"]');
  /* the price scale settles first (a price set by the test can be off the scale while it eases) */
  await until(() => pg.evaluate(([i, pr]) => { const c = window.workspace.chart(i), s = c.priceScale(), y = c.priceToY(pr); return !s.target || (Math.abs(s.lo - s.target.lo) < 1 && Math.abs(s.hi - s.target.hi) < 1) ? y > 20 && y < s.plotHeight - 20 : false; }, [id, price]), 'the price scale shows ' + price, 8000);
  const y = await pg.evaluate(([i, pr]) => window.workspace.chart(i).priceToY(pr), [id, price]);
  await pg.mouse.click(box.x + box.w * 0.72, box.y + y);   // right of the plan card (bottom left)
}
const st = pg => pg.evaluate(() => window.workspace.planner());
const card = s => `.pl-card [data-pl="${s}"]`;
async function setPrice(px) { await control('price', { root: 'MNQ', p: px }); await wait(150); }
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(l => {
    window.__sent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (['order', 'change', 'cancel', 'flatten', 'cutHalf'].includes(m.type)) window.__sent.push(m); } catch (e) { /* not JSON */ } return send.call(this, d); };
    try { if (!localStorage.getItem('live-workspace-v1')) localStorage.setItem('live-workspace-v1', JSON.stringify(l)); } catch (e) { /* blocked */ }
  }, LAYOUT);
  p = await openPage(ctx);
  await until(() => p.$eval(tk('oAcct'), s => [...s.options].some(o => o.value === 'Sim101')), 'Sim101 in the ticket\'s picker');
  await p.selectOption(tk('oAcct'), 'Sim101'); await p.selectOption(tk('root'), 'MNQ'); await wait(300);
  await until(async () => (await st(p)).ok === true, 'the planner found The Desk\'s plan log', 15000);
  check((await st(p)).pc === 'TESTPC' && (await st(p)).leader === true, 'this PC\'s name from /diag; the one window leads');
  await setPrice(25000);

  /* ---- draw, on every chart of the instrument; the card; Submit */
  await drawAt(p, 24990);
  const s1 = await until(async () => { const s = await st(p); return s.drafts.length === 1 ? s : null; }, 'a drawn plan');
  const d1 = s1.drafts[0];
  check(d1.side === 'long' && d1.entry === 24990 && d1.account === 'Sim101' && d1.entryType === 'limit' && d1.expiryMin === 30 && d1.grade === 'A+', 'drawn: long at the click, the ticket\'s account, limit, 30 minutes, A+: ' + JSON.stringify(d1));
  await until(() => p.evaluate(() => window.workspace.chart('c1').getPlans().length === 1 && window.workspace.chart('c2').getPlans().length === 1), 'the plan on both MNQ charts (1 and 5 minute)');
  check(await p.$('.pl-card') !== null, 'the plan card shows');
  await p.screenshot({ path: path.join(out, 'planner-draft-1366.png') });
  await p.click(card('submit'));
  await until(() => plans().length === 1, 'The Desk has the plan');
  const v1 = plans()[0];
  check(v1.uid === d1.uid && v1.pc === 'TESTPC' && v1.values.qty === d1.qty && v1.values.target === d1.target && v1.values.entry_type === 'limit' && v1.contract === 'MNQ 12-26', 'Submit sends the plan with its uid, this PC, the contract, qty and target 1: ' + JSON.stringify(v1.values));
  await until(async () => (await st(p)).plans.some(x => x.seq === v1.seq && x.phase === 'submitted'), 'submitted on the page');

  /* ---- Arm: the light lock, one order from the plan alone */
  await p.selectOption(tk('oQty'), '3'); await p.click(tk('armBtn')); await wait(200);
  check((await p.evaluate(() => window.workspace.ticket().armed)) === true, 'the ticket armed by hand (Qty 3)');
  await p.evaluate(() => { window.__sent.length = 0; });
  await p.click(card('arm'));
  await until(() => kinds(plans()[0]).includes('arm'), 'The Desk stamped arm');
  await until(() => p.evaluate(() => window.workspace.ticket().armed === false), 'the ticket\'s Armed off (the light lock)');
  const sent1 = await until(() => p.evaluate(() => { const o = window.__sent.filter(m => m.type === 'order'); return o.length ? o : null; }), 'the entry sent');
  const want = { type: 'order', cid: 'pl' + v1.uid + '-e', account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'limit', qty: d1.qty, price: 24990, bracket: { stop: Math.round((24990 - d1.stop) / 0.25), target: Math.round((d1.target - 24990) / 0.25) } };
  check(sent1 && sent1.length === 1 && JSON.stringify(sent1[0]) === JSON.stringify(want), 'exactly one order, from the plan alone (not the ticket\'s Qty 3): ' + JSON.stringify(sent1));
  await until(() => kinds(plans()[0]).includes('sent') && kinds(plans()[0]).includes('placed'), 'sent and placed recorded');
  await p.screenshot({ path: path.join(out, 'planner-armed-1366.png') });
  /* a press on the plan's working entry while unarmed says it is the plan's */
  /* ---- the fill, then Flatten (unarmed), recorded; the plan ends closed */
  await setPrice(24989);
  await until(() => kinds(plans()[0]).includes('filled'), 'the fill recorded', 8000);
  const fe = plans()[0].events.find(e => e.kind === 'filled');
  check(Array.isArray(fe.detail.exec_ids) && fe.detail.exec_ids.length >= 1 && fe.detail.qty === d1.qty, 'filled: the exec ids and qty: ' + JSON.stringify(fe.detail));
  await p.click(tk('flattenBtn'));
  await until(() => kinds(plans()[0]).includes('override'), 'the Flatten recorded as an override');
  check(plans()[0].events.some(e => e.kind === 'override' && e.detail.what === 'flatten'), 'override: flatten');
  await until(() => kinds(plans()[0]).includes('closed'), 'the plan closed when flat', 8000);
  check(desk.planFlags.length === 0, 'The Desk flagged nothing (never a second sent)');

  /* ---- Market on touch on the stop side: a stop-market at the line */
  await setPrice(25000);
  await drawAt(p, 25010);
  await until(async () => (await st(p)).drafts.length === 1, 'a second plan');
  check((await st(p)).drafts[0].side === 'short', 'drawn above the price: short to start');
  await p.click(card('side')); await p.click(`.pl-card [data-pl="side"][data-v="long"]`); await wait(200);
  await p.selectOption(card('type'), 'market_on_touch'); await wait(200);
  await p.click(card('submit'));
  await until(() => plans().length === 2, 'plan 2 at The Desk');
  await setPrice(25008);   // under the line, over its stop (a price already through the stop is never armed)
  await p.evaluate(() => { window.__sent.length = 0; });
  await p.click(card('arm'));
  const sent2 = await until(() => p.evaluate(() => { const o = window.__sent.filter(m => m.type === 'order'); return o.length ? o : null; }), 'plan 2 sent');
  check(sent2 && sent2.length === 1 && sent2[0].kind === 'stop' && sent2[0].side === 'buy' && sent2[0].price === 25010, 'touch on the stop side: a buy stop-market at the line: ' + JSON.stringify(sent2));
  /* ---- Cancel on the card: its working entry cancelled */
  await until(() => kinds(plans()[1]).includes('placed'), 'plan 2 placed');
  await p.evaluate(() => { window.__sent.length = 0; });
  await p.click(card('cancel'));
  await until(() => kinds(plans()[1]).includes('cancel'), 'The Desk stamped the cancel');
  check((await p.evaluate(() => window.__sent.filter(m => m.type === 'cancel').length)) >= 1, 'Cancel sent the entry\'s cancel');

  /* ---- expiry cancels the working entry */
  desk.expiryMs = 4000;
  await drawAt(p, 24980);
  await until(async () => (await st(p)).drafts.length === 1, 'plan 3');
  await p.click(card('submit')); await until(() => plans().length === 3, 'plan 3 at The Desk');
  await p.evaluate(() => { window.__sent.length = 0; });
  await p.click(card('arm'));
  await until(() => kinds(plans()[2]).includes('placed'), 'plan 3 placed');
  await until(() => kinds(plans()[2]).includes('expired'), 'plan 3 expired', 10000);
  check((await p.evaluate(() => window.__sent.filter(m => m.type === 'cancel').length)) === 1, 'expiry cancelled the working entry');
  desk.expiryMs = 0;

  /* ---- stop-through before the fill: a confirmation plan ends, nothing sent */
  await setPrice(25000);
  await drawAt(p, 24990);
  await until(async () => (await st(p)).drafts.length === 1, 'plan 4');
  await p.selectOption(card('type'), 'touch_confirm'); await wait(200);
  await p.click(card('submit')); await until(() => plans().length === 4, 'plan 4 at The Desk');
  await p.evaluate(() => { window.__sent.length = 0; });
  await p.click(card('arm'));
  await until(() => kinds(plans()[3]).includes('arm'), 'plan 4 armed');
  await wait(400);
  check((await p.evaluate(() => window.__sent.length)) === 0, 'a confirmation sends nothing at Arm');
  const p4 = (await st(p)).plans.find(x => x.seq === plans()[3].seq);
  await setPrice(p4.stop - 0.25);
  await until(() => kinds(plans()[3]).includes('stop_through'), 'stop-through recorded');
  check((await p.evaluate(() => window.__sent.length)) === 0, 'nothing was sent');

  /* ---- a confirmation: the touch, a 1 minute close back over the line, one market order */
  await setPrice(25000);
  await drawAt(p, 24995);
  await until(async () => (await st(p)).drafts.length === 1, 'plan 5');
  await p.selectOption(card('type'), 'touch_confirm'); await wait(200);
  await p.click(card('submit')); await until(() => plans().length === 5, 'plan 5 at The Desk');
  await p.click(card('arm'));
  await until(() => kinds(plans()[4]).includes('arm'), 'plan 5 armed');
  await p.evaluate(() => { window.__sent.length = 0; });
  await setPrice(24995);
  await until(() => kinds(plans()[4]).includes('touched'), 'the touch recorded');
  await setPrice(24997);
  const s5 = await until(() => p.evaluate(() => { const o = window.__sent.filter(m => m.type === 'order'); return o.length ? o : null; }), 'the confirmation\'s market order (up to a minute)', 75000);
  const p5 = (await st(p)).plans.find(x => x.seq === plans()[4].seq);
  check(s5 && s5.length === 1 && s5[0].kind === 'market' && s5[0].bracket.stop === Math.round((24997 - p5.stop) / 0.25), 'one market order, its bracket from the last price: ' + JSON.stringify(s5));
  check(kinds(plans()[4]).includes('confirmed'), 'confirmed recorded');
  await p.click(tk('flattenBtn'));
  await wait(800);

  /* ---- Anthony 2026-11-21 ("Flatten ends it"): Flatten on the pair ends a working plan, cancels its entry, recorded */
  await setPrice(25000);
  await drawAt(p, 24985);
  await until(async () => (await st(p)).drafts.length === 1, 'a plan to flatten');
  const nF = plans().length;
  await p.click(card('submit'));
  await until(() => plans().length === nF + 1, 'submitted');
  const vF = desk.plans[nF];
  await until(async () => (await st(p)).plans.some(x => x.seq === vF.seq && x.phase === 'submitted'), 'submitted on the page');
  await p.click(card('arm'));
  await until(() => kinds(vF).includes('placed'), 'its entry placed');
  check(vF.events.find(e => e.kind === 'arm').detail.client.entry_kind === 'limit', 'the entry kind is fixed at Arm (the arm fact carries it)');
  await p.evaluate(() => { window.__sent.length = 0; });
  await p.click(tk('flattenBtn'));
  await until(() => kinds(vF).includes('ended'), 'Flatten ended the plan');
  check(vF.events.some(e => e.kind === 'override' && e.detail.what === 'flatten') && vF.events.some(e => e.kind === 'ended'), 'Flatten: an override, and the plan ends (nothing enters afterwards)');
  await until(() => p.evaluate(() => !window.workspace.planner().plans.some(x => x.phase === 'working')), 'no plan left working');
  await setPrice(24984);
  await wait(800);
  check(!kinds(vF).includes('filled'), 'its entry never filled after the Flatten');

  /* ---- Anthony 2026-11-21 ("Refuse at Arm"): touch, then confirm is a pullback entry: a long with its line over the price is refused */
  await setPrice(25000);
  await drawAt(p, 25006);
  await until(async () => (await st(p)).drafts.length === 1, 'a plan over the price');
  if ((await st(p)).drafts[0].side === 'short') { await p.click(`.pl-card [data-pl="side"][data-v="long"]`); await wait(200); }
  await p.selectOption(card('type'), 'touch_confirm'); await wait(200);
  await p.click(card('submit'));
  const vR = await until(() => { const v = desk.plans[desk.plans.length - 1]; return v && v.values.entry === 25006 && v.values.entry_type === 'touch_confirm' ? v : null; }, 'submitted');
  await until(async () => (await st(p)).plans.some(x => x.seq === vR.seq && x.phase === 'submitted'), 'submitted on the page');
  await p.click(card('arm'));
  const why7 = await until(() => p.$eval(card('note'), e => (/pullback entry/.test(e.textContent) ? e.textContent : null)), 'the card says why');
  check(!!why7, 'refused at Arm with a clear note: ' + why7);
  check(!kinds(vR).includes('arm'), 'refused at Arm: The Desk never stamped it');
  await p.click(card('cancel'));
  await until(() => kinds(vR).includes('cancel'), 'cancelled');

  /* ---- the second delta review: an entry moved by hand (its cid kept; decision 4 A) is still the plan's own: expiry, Cancel and
     Flatten each cancel it, whatever its price now */
  const movedPlan = async (price, to) => {
    await setPrice(25000);
    await drawAt(p, price);
    await until(async () => (await st(p)).drafts.length === 1, 'a plan at ' + price);
    const n = plans().length;
    await p.click(card('submit'));
    await until(() => plans().length === n + 1, 'submitted');
    const v = desk.plans[n];
    await p.click(card('arm'));
    await until(() => kinds(v).includes('placed'), 'placed');
    const id = v.events.find(e => e.kind === 'placed').detail.id;
    await control('move', { id, p: to });
    await until(() => v.events.some(e => e.kind === 'override' && e.detail.what === 'moved_outside'), 'the move by hand recorded (moved_outside)');
    await p.evaluate(() => { window.__sent.length = 0; });
    return { v, id };
  };
  const working = async id => (await control('state', { root: 'MNQ' })).orders.some(o => o.id === id);
  desk.expiryMs = 5000;
  const m1 = await movedPlan(24984, 24975);
  await until(() => kinds(m1.v).includes('expired'), 'the moved plan expired', 12000);
  check(await until(async () => !(await working(m1.id)), 'the moved entry cancelled at expiry', 8000), 'expiry cancels the entry moved by hand (' + m1.id + ')');
  desk.expiryMs = 0;
  const m2 = await movedPlan(24983, 24974);
  await p.click(card('cancel'));
  await until(() => kinds(m2.v).includes('cancel'), 'cancelled at The Desk');
  check(await until(async () => !(await working(m2.id)), 'the moved entry cancelled by Cancel', 8000), 'Cancel on the card cancels the entry moved by hand (' + m2.id + ')');
  check(await p.evaluate(id => window.__sent.some(m => m.type === 'cancel' && m.id === id), m2.id), 'by its id');
  const m3 = await movedPlan(24982, 24973);
  await p.click(tk('flattenBtn'));
  await until(() => kinds(m3.v).includes('ended'), 'Flatten ended the moved plan');
  check(await until(async () => !(await working(m3.id)), 'the moved entry gone after Flatten', 8000), 'Flatten ends the plan and its entry moved by hand is gone (' + m3.id + ')');
  check(desk.planFlags.length === 0, 'The Desk flagged nothing');

  /* ---- Planner off */
  await p.check(card('off'));
  await drawAt(p, 24990);
  await wait(400);
  check((await st(p)).drafts.length === 0, 'Planner off: no new plan');
  await p.uncheck(card('off')).catch(() => {});
  await p.evaluate(() => localStorage.setItem('live-planner-off-v1', 'false'));
  await p.screenshot({ path: path.join(out, 'planner-ended-1366.png') });
  check(desk.planFlags.length === 0, 'The Desk flagged nothing over the whole run');

  /* ---- a Desk that is not the live one: its writes answer 409 "not live": the planner says it has no plan log and hides */
  desk.notLive = true;
  await setPrice(25000);
  await drawAt(p, 24990);
  await until(async () => (await st(p)).drafts.length === 1, 'a plan drawn before the Desk said not live');
  await p.click(card('submit'));
  await until(async () => (await st(p)).ok === false, 'the planner hides after a "not live" refusal');
  check(/no live plan log/.test((await st(p)).why), 'it says The Desk has no (live) plan log: ' + (await st(p)).why);
  check((await p.evaluate(() => window.workspace.chart('c1').getPlans().length)) === 0, 'no plan drawn once it hides');
  desk.notLive = false;

  /* ---- an older Desk: no plan log */
  desk.noPlans = true;
  const p2 = await openPage(ctx);
  await until(async () => (await st(p2)).ok === false, 'the planner hides');
  check(/no plan log/.test((await st(p2)).why), 'it says The Desk has no plan log: ' + (await st(p2)).why);
  await drawAt(p2, 24990);
  await until(() => p2.$eval('#wsNote', e => /no plan log/.test(e.textContent)), 'the Plan tool says so');
  check((await p2.evaluate(() => window.workspace.chart('c1').getPlans().length)) === 0, 'no plan drawn');
  await p2.close();
} finally {
  await browser.close();
  bridge.kill(); await desk.close();
}
if (errors.length) { console.error('FAIL (' + errors.length + ' of ' + checks + ')\n' + errors.join('\n')); process.exit(1); }
console.log('planner smoke: ok (' + checks + ' checks)');

