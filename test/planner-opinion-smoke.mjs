// The planner's opinion on the plan card (chart 1.64.0, phase 6 part B) against the fake bridge (--v3: made-up accounts, Sim101;
// sample data, nothing reaches a broker) and the fake Desk's opinion route (test/fake-desk.mjs: sample answers, no model asked),
// in the workspace at 1366 x 768:
//   - Submit asks The Desk once, from the submitting window, with the page's context (60 one minute and 24 five minute bars as
//     [minutes_before, o, h, l, c, v], the levels by name, the drawn lines; no account, PC or date); the card says "Asking Opus..."
//     under the buttons, and Arm is enabled all the while;
//   - The Desk's stamp shows: "Opus: agree · A", the reasons, "Wrong if ...", "stamped hh:mm:ss · 7.2 s · $0.02";
//   - Arm pressed while it is asked: armed and ONE order sent at once, nothing waits; the opinion that lands after shows "(after Arm)";
//   - a no-opinion stamp ("No opinion: day cap") and The Desk's "off" ("No opinion: the service is off", nothing stamped);
//   - the page never sends an opinion fact of its own.
//   npm run smoke:planner-opinion        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { startDesk } from './fake-desk.mjs';
import { checker, startBridge, spyContext, openPage, st, card, drawAt, orders, wait } from './planner-smoke-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.PLANNER_OPINION_SMOKE_PORT || 8885), DP = PORT + 40;
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const { fail, check, until, done } = checker();
const desk = await startDesk(DP, {});
const bridge = await startBridge(root, PORT, DP);
const control = async (what, q) => (await fetch(`http://127.0.0.1:${PORT}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
const setPrice = async px => { await control('price', { root: 'MNQ', p: px }); await wait(150); };
const kinds = v => v.events.map(e => e.kind);
const ANSWER = { status: 'reported', verdict: 'agree', grade: 'A', reasons: ['Sample reason one (made up for the smoke).', 'Sample reason two.'], wrong_if: 'a made-up condition is met', model_reported: 'sample', latency_s: 7.2, cost_usd: 0.0193 };
const opText = pg => pg.evaluate(() => { const el = document.querySelector('.pl-card [data-pl="opinion"]'); return el ? el.innerText.replace(/\s+/g, ' ').trim() : ''; });
const armEnabled = pg => pg.evaluate(() => { const b = document.querySelector('.pl-card [data-pl="arm"]'); return !!b && !b.disabled; });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const ctx = await spyContext(browser);
  const p = await openPage(ctx, PORT, fail);
  await until(() => p.$eval('[data-tk-id="oAcct"]', s => [...s.options].some(o => o.value === 'Sim101')), 'Sim101 in the ticket\'s picker');
  await p.selectOption('[data-tk-id="oAcct"]', 'Sim101'); await wait(300);
  await until(async () => (await st(p)).ok === true && (await st(p)).leader === true, 'the planner leads', 15000);
  await setPrice(25000);
  /* a drawn line near the plan (Anthony's own lines go with the ask) */
  await p.evaluate(() => { const c = window.workspace.chart('c1'); c.setDrawings(c.getDrawings().concat([{ id: 'smoke-h1', type: 'hline', price: 24975 }])); });

  /* ---- 1: Submit asks; Arm stays enabled while it asks; the stamp shows */
  desk.opinion = { delayMs: 2500, detail: ANSWER };
  await drawAt(p, 24990, until);
  await until(async () => (await st(p)).drafts.length === 1, 'a plan drawn');
  await p.click(card('submit'));
  await until(() => desk.plans.length === 1, 'submitted');
  const ask = await until(() => desk.opinionAsks[0] || null, 'the page asked The Desk for the opinion');
  if (ask) {
    const c = ask.body.context;
    check(ask.seq === desk.plans[0].seq && /^[A-Za-z0-9_-]{6,64}$/.test(ask.body.uid), 'the ask names the plan and carries its own uid');
    check(c.bars_1m.length === 60 && c.bars_5m.length === 24 && c.bars_1m.concat(c.bars_5m).every(b => b.length === 6 && b.every(x => typeof x === 'number') && b[0] >= 0 && b[0] < 1000),
      'the last 60 one minute and 24 five minute bars, each [minutes_before, o, h, l, c, v] (' + c.bars_1m.length + ', ' + c.bars_5m.length + ')');
    check(c.bars_1m.every((b, i) => i === 0 || b[0] < c.bars_1m[i - 1][0]) && c.bars_1m[59][0] <= 1, 'oldest first, the last at the Submit');
    check(Object.keys(c.levels).every(k => /^[a-z][a-z_]*$/.test(k)) && c.lines.includes(24975), 'levels by name (letters and _ only), the drawn line sent: ' + JSON.stringify({ levels: c.levels, lines: c.lines.slice(0, 5) }));
    check(!/Sim101|TESTPC|"account"|"pc"|20\d\d-\d\d/.test(JSON.stringify(ask.body)), 'no account, PC or date in the ask');
  }
  check(await until(async () => /Asking Opus\.\.\./.test(await opText(p)), 'Asking Opus... on the card'), 'the card says "Asking Opus..." under the buttons');
  check(await armEnabled(p), 'Arm is enabled while it asks (nothing waits on the opinion)');
  await p.screenshot({ path: path.join(out, 'planner-opinion-asking-1366.png') });
  const t1 = await until(async () => { const t = await opText(p); return /Opus: agree · A/.test(t) ? t : null; }, 'the stamped opinion on the card', 10000);
  check(t1 && /Sample reason one/.test(t1) && /Sample reason two/.test(t1) && /Wrong if a made-up condition is met/.test(t1) && /stamped \d\d:\d\d:\d\d · 7\.2 s · \$0\.02/.test(t1),
    'the card shows the verdict and grade, the reasons, Wrong if, and stamped hh:mm:ss · 7.2 s · $0.02: ' + t1);
  check(kinds(desk.plans[0]).filter(k => k === 'opinion').length === 1 && (await st(p)).plans[0].phase === 'submitted', 'one opinion fact, stamped by The Desk; the plan is still submitted');
  check(await armEnabled(p), 'Arm enabled after the opinion as before');
  await p.screenshot({ path: path.join(out, 'planner-opinion-1366.png') });
  await p.click(card('cancel'));
  await until(() => kinds(desk.plans[0]).includes('cancel'), 'plan 1 cancelled');

  /* ---- 2: Arm while it asks: armed and sent at once; the late opinion says (after Arm) */
  desk.opinion = { delayMs: 6000, detail: Object.assign({}, ANSWER, { verdict: 'doubt', grade: 'B' }) };
  await drawAt(p, 24985, until);
  await until(async () => (await st(p)).drafts.length === 1, 'a second plan drawn');
  await p.click(card('submit'));
  await until(() => desk.plans.length === 2, 'the second plan submitted');
  await until(async () => /Asking Opus/.test(await opText(p)), 'asking for the second plan');
  await p.evaluate(() => { window.__sent.length = 0; });
  const t0 = Date.now();
  await p.click(card('arm'));
  await until(() => kinds(desk.plans[1]).includes('arm'), 'armed while the opinion is asked');
  const sent = await until(async () => { const o = await orders(p); return o.length ? o : null; }, 'the entry sent');
  check(sent && sent.length === 1 && sent[0].cid === 'pl' + desk.plans[1].uid + '-e' && Date.now() - t0 < 5000 && !kinds(desk.plans[1]).includes('opinion'),
    'Arm went and ONE entry was sent before the opinion came (nothing waits on it): ' + JSON.stringify(sent));
  const t2 = await until(async () => { const t = await opText(p); return /Opus: doubt · B/.test(t) ? t : null; }, 'the second opinion on the card', 12000);
  check(t2 && /\(after Arm\)/.test(t2), 'the opinion that lands after Arm says so: ' + t2);
  await wait(500);
  check((await orders(p)).length === 1, 'still one order: the opinion changed nothing of the armed plan');
  await p.screenshot({ path: path.join(out, 'planner-opinion-after-arm-1366.png') });
  await p.click(card('cancel'));
  await until(() => kinds(desk.plans[1]).includes('cancel'), 'plan 2 cancelled');

  /* ---- 3: a no-opinion stamp, and The Desk's off */
  desk.opinion = { delayMs: 300, detail: { status: 'day cap', why: null, cost_usd: 0, latency_s: null } };
  await drawAt(p, 24980, until);
  await until(async () => (await st(p)).drafts.length === 1, 'a third plan drawn');
  await p.click(card('submit'));
  const t3 = await until(async () => { const t = await opText(p); return /No opinion: day cap/.test(t) ? t : null; }, 'No opinion: day cap');
  check(!!t3, 'a no-opinion stamp shows its reason: ' + t3);
  await p.click(card('cancel'));
  desk.opinion = { off: true };
  await drawAt(p, 24980, until);
  await until(async () => (await st(p)).drafts.length === 1, 'a fourth plan drawn');
  await p.click(card('submit'));
  const t4 = await until(async () => { const t = await opText(p); return /No opinion: the service is off/.test(t) ? t : null; }, 'No opinion: the service is off');
  check(!!t4 && !kinds(desk.plans[3]).includes('opinion'), 'The Desk asks no one: the card says so and nothing is stamped');
  await p.screenshot({ path: path.join(out, 'planner-opinion-off-1366.png') });
  await p.click(card('cancel'));

  check(desk.opinionAsks.length === 4, 'one ask per Submit, never again by itself (' + desk.opinionAsks.length + ')');
  check(!desk.log.some(l => l.method === 'POST' && /\/events$/.test(l.url) && l.body && l.body.kind === 'opinion'), 'the page never sends an opinion fact');
  check(desk.planFlags.length === 0, 'The Desk flagged nothing');
  await p.click('#wsFlat').catch(() => {}); await wait(300);
} finally {
  await browser.close();
  bridge.kill(); await desk.close();
}
done('planner opinion smoke');
