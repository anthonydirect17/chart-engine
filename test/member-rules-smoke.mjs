// Chart 1.33.0 and ChartBridge 0.6.5 smoke (Anthony 2026-10-19, PRIORITY): one group of accounts of different types and sizes, each
// member with its own rules, taken from its type on The Desk without picking or typing ("so its all automatic"). Against the fake
// bridge (--mix-groups: a made-up Lucid group whose SIM-A has its own 150K rules, risk 10%) and the fake Desk (made-up types and
// accounts), at 1366 x 768 in Chromium:
//   npm run smoke:member-rules       (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
// Checks: the compact join row (the rules from The Desk, an account's own Desk number winning, the seed floor's highest close), the
// message sent; the full form for an account with no type on The Desk; Edit rules; a member's Rules later (memberRules); the
// Limits cell and Settings' group row (own rules, risk and each member's dollars); the rules dialog's Risk box fits; an older
// ChartBridge (--no-group-rules) gets the 1.26.0 question and no rule key. Screenshots in test/out/member-rules-*.png.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';
import { startDesk } from './fake-desk.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.MEMBER_RULES_SMOKE_PORT || 8797), DP = PORT + 1, OP = PORT + 2;
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const errors = [];
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { if (!ok) fail(m); else console.log('  ok   ' + m); };
const until = async (fn, what, ms) => { const end = Date.now() + (ms || 10000); for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await new Promise(r => setTimeout(r, 100)); } };

/* made-up Lucid types and accounts (sample values for the test only) */
const T = o => Object.assign({ firm: 'Lucid', account_type: 'eval', daily_loss: null, lock_at: null, profit_target: null, consistency_pct: null, max_nq: null, max_mnq: null, notes: 'sample values for the test', sources: [],
  status: 'checked', checked_at: '2026-10-19T12:00:00Z', version: 1, archived: false, created_at: '2026-10-19T12:00:00Z', updated_at: '2026-10-19T12:00:00Z' }, o);
const desk = await startDesk(DP, {
  types: [T({ id: 'sample-lucid-150k', name: 'LucidFlex 150K Eval', account_size: 150000, drawdown: 4500, drawdown_type: 'eod', lock_at: 150100, profit_target: 9000, consistency_pct: 50, max_nq: 10, max_mnq: 100 }),
    T({ id: 'sample-lucid-50k', name: 'LucidFlex 50K Eval', account_size: 50000, drawdown: 2000, drawdown_type: 'eod', lock_at: 50100, profit_target: 3000, consistency_pct: 50, max_nq: 4, max_mnq: 40 }),
    T({ id: 'sample-lucid-25k-daily', name: 'LucidDaily 25K Eval', account_size: 25000, daily_loss: 500, drawdown: 1000, drawdown_type: 'intraday', lock_at: 25100, profit_target: 1250, max_nq: 2, max_mnq: 20, status: 'not_checked' })],
  accounts: [{ account: 'SIM-A', firm: 'Lucid', archived: false, account_type: 'sample-lucid-150k' },
    /* SIM-B: a 50K Flex with its own daily loss set on The Desk (wins over the type) and a seed floor */
    { account: 'SIM-B', firm: 'Lucid', archived: false, account_type: 'sample-lucid-50k', daily_loss_limit: 1200, source: { daily_loss_limit: 'account', trailing_drawdown: 'type', account_size: 'type' }, seed_floor: 49234.5, seed_date: '2026-10-17' },
    { account: 'SIM-C', firm: 'Lucid', archived: false, account_type: 'sample-lucid-25k-daily' },
    { account: 'SIM-D', firm: 'Lucid', archived: false, account_type: null }] });
const spawnBridge = (port, extra) => { const b = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(port), '--v3', '--trading', '--test-controls', '--mix-groups', '--trade-accounts=SIM-A,SIM-B,SIM-C,SIM-D', '--test-pin=' + TEST_PIN, '--desk-url=http://127.0.0.1:' + DP].concat(extra || []), { stdio: ['ignore', 'pipe', 'inherit'] }); return new Promise(r => b.stdout.once('data', () => r(b))); };
const bridge = await spawnBridge(PORT), older = await spawnBridge(OP, ['--no-group-rules']);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const groupMsgs = async port => ((await (await fetch(`http://127.0.0.1:${port}/test/received`, { method: 'POST' })).json()).groupMsgs || []);
const AP = '.ws-panel[data-id="ap"]';

async function openPage(port) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } }).then(async c => { await c.addInitScript(() => { try { if (!localStorage.getItem('live-acc-open-v1')) localStorage.setItem('live-acc-open-v1', JSON.stringify({ sim: true, all: true })); } catch (e) { /* none */ } }); return c; });
  await ctx.addInitScript(() => { try { if (!localStorage.getItem('live-workspace-v1')) localStorage.setItem('live-workspace-v1', JSON.stringify({ v: 1, layouts: { Mix: { panels: [{ id: 'ap', type: 'accounts', x: 0, y: 0, w: 12, h: 6 }] } } })); } catch (e) { /* blocked */ } });
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  await p.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await p.goto(`http://localhost:${port}/live/?layout=Mix`);
  await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
  await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 40000 });
  await until(async () => (await p.$$(`${AP} select.apg-grp`)).length >= 4 && (await p.$$(`${AP} .apg-ttext`)).length >= 4 && !/not known/.test(await p.$eval(`${AP} .apg-type`, e => e.textContent)), 'the Accounts tab with groups and The Desk\'s types');
  return { ctx, p };
}
const joinText = p => p.$eval(`${AP} .apg-join`, e => e.textContent.replace(/\s+/g, ' ').trim());
/* nothing in the row reaches past the panel at 1366 (no sideways scroll), every box and button whole */
const fits = (p, sel) => p.evaluate(([ap, sel]) => { const panel = document.querySelector(ap).getBoundingClientRect(), r = document.querySelector(sel); if (!r) return false;
  return [...r.querySelectorAll('input, select, button')].every(x => { const b = x.getBoundingClientRect(); return b.right <= panel.right + 0.5 && b.left >= panel.left - 0.5 && b.width > 0; }) && document.documentElement.scrollWidth <= window.innerWidth; }, [AP, sel]);

try {
  const { ctx, p } = await openPage(PORT);
  /* 1. the member with its own rules: its Limits cell (its floor by its own rules, Rules) */
  const limA = await until(() => p.$eval(`${AP} .gr-row[data-k="dr|SIM-A"] .apg-mrules`, e => ({ text: e.textContent, tip: e.querySelector('.apg-mfloor').title })), 'SIM-A\'s Limits cell');
  check(limA && /^floor \$146,500\.00Rules$/.test(limA.text) && /its own rules/.test(limA.tip) && /\$150,000 · daily none · drawdown \$4,500 end of day, stops at \$150,100 · target \$9,000 · consistency 50% · max 10 minis \/ 100 micros/.test(limA.tip),
    'SIM-A (150K, its own rules): floor 151000 - 4500 = 146,500 with Rules; its rules in the tooltip: ' + JSON.stringify(limA));
  /* 2. SIM-B joins: one compact row with the rules from its type on The Desk, its own Desk daily loss winning, the seed floor's close */
  await p.selectOption(`${AP} select.apg-grp[data-id="SIM-B"]`, 'g1');
  const jb = await until(() => joinText(p), 'SIM-B\'s join row');
  check(/^Put SIM-B in Lucid with its rules from Lucid LucidFlex 50K Eval \(its own on The Desk: daily loss \$1,200\): \$50,000 · daily \$1,200 · drawdown \$2,000 end of day, stops at \$50,100 · target \$3,000 · consistency 50% · max 4 minis \/ 40 micros · risk 10% of each account's max loss: \$200\./.test(jb || ''),
    'the compact row: every rule from The Desk (no picking, no typing), its own daily loss winning, 10% of its $2,000 max loss = $200: ' + jb);
  check((await p.$eval(`${AP} [data-act="join-high"]`, e => e.value)) === '51234.5' && /\(highest close from The Desk's seed of 2026-10-17\)/.test(jb || ''), 'highest close prefilled from The Desk\'s seed floor 49,234.50 plus the drawdown 2,000');
  check(await p.$$eval(`${AP} .apg-join input:not([data-act="join-high"])`, e => e.length) === 0, 'the compact row asks only the highest close (no rule boxes)');
  check(await fits(p, `${AP} .apg-join`), 'the compact row fits the panel at 1366 x 768');
  await p.screenshot({ path: path.join(out, 'member-rules-join-auto-1366.png') });
  await p.click(`${AP} [data-act="join-yes"][data-id="SIM-B"]`);
  const sentB = await until(async () => (await groupMsgs(PORT)).find(m => m.type === 'accountGroup' && m.account === 'SIM-B'), 'SIM-B\'s accountGroup');
  check(sentB && sentB.group === 'g1' && sentB.highClose === 51234.5 && sentB.size === 50000 && sentB.dailyLoss === 1200 && sentB.drawdown === 2000 && sentB.drawdownType === 'eod' && sentB.lockAt === 50100 &&
    sentB.target === 3000 && sentB.consistency === 50 && sentB.maxMinis === 4 && sentB.maxMicros === 40 && sentB.typeId === 'sample-lucid-50k', 'sent: accountGroup with every rule and The Desk\'s type id: ' + JSON.stringify(sentB));
  const limB = await until(async () => { const t = await p.$eval(`${AP} .gr-row[data-k="dr|SIM-B"] .apg-mrules`, e => e.textContent).catch(() => null); return t && /^floor \$49,234\.50Rules$/.test(t) ? t : null; }, 'SIM-B\'s floor by its own rules');
  check(!!limB, 'SIM-B in Lucid: floor 51,234.50 - 2,000 = 49,234.50 (its own rules): ' + limB);
  /* 3. SIM-C (a 25K intraday type): the row says highest balance so far (intraday) */
  await p.selectOption(`${AP} select.apg-grp[data-id="SIM-C"]`, 'g1');
  const jc = await until(() => joinText(p), 'SIM-C\'s join row');
  check(/with its rules from Lucid LucidDaily 25K Eval \(not checked\): \$25,000 · daily \$500 · drawdown \$1,000 intraday, stops at \$25,100 · target \$1,250 · max 2 minis \/ 20 micros · risk 10% of each account's max loss: \$100\. highest balance so far \(intraday\)/.test(jc || '') &&
    (await p.$eval(`${AP} [data-act="join-high"]`, e => e.value)) === '25000', 'an intraday type asks the highest balance so far (intraday), prefilled with its own size (no seed): ' + jc);
  /* Edit rules: the full form, prefilled with what The Desk gave */
  await p.click(`${AP} [data-act="join-edit"][data-id="SIM-C"]`);
  const formC = await until(() => p.$$eval(`${AP} .apg-rform [data-rf]`, els => Object.fromEntries(els.map(e => [e.dataset.rf, e.value]))), 'the Edit rules form');
  check(formC && formC.size === '25000' && formC.dailyLoss === '500' && formC.drawdown === '1000' && formC.drawdownType === 'intraday' && formC.lockAt === '25100' && formC.maxMicros === '20', 'Edit rules: every box prefilled from The Desk: ' + JSON.stringify(formC));
  await p.fill(`${AP} [data-rf="maxMicros"][data-id="SIM-C"]`, '15');
  await p.click(`${AP} [data-act="join-yes"][data-id="SIM-C"]`);
  const sentC = await until(async () => (await groupMsgs(PORT)).find(m => m.type === 'accountGroup' && m.account === 'SIM-C'), 'SIM-C\'s accountGroup');
  check(sentC && sentC.maxMicros === 15 && sentC.drawdownType === 'intraday' && sentC.typeId === 'sample-lucid-25k-daily' && sentC.highClose === 25000, 'sent with the box changed by hand, the type id kept: ' + JSON.stringify(sentC));
  /* 4. SIM-D has no type on The Desk: the full form, prefilled with the group's own rules */
  await p.selectOption(`${AP} select.apg-grp[data-id="SIM-D"]`, 'g1');
  const jd = await until(() => joinText(p), 'SIM-D\'s form');
  check(/^Put SIM-D in Lucid with these rules \(no account type on The Desk\):/.test(jd || ''), 'no type on The Desk: the full form, with the reason: ' + jd);
  check(await fits(p, `${AP} .apg-rform`), 'the full form fits the panel at 1366 x 768 (it wraps, no sideways scroll)');
  await p.screenshot({ path: path.join(out, 'member-rules-join-form-1366.png') });
  await p.fill(`${AP} [data-rf="drawdown"][data-id="SIM-D"]`, '60000');
  await p.click(`${AP} [data-act="join-yes"][data-id="SIM-D"]`);
  await p.waitForTimeout(300);
  check(!(await groupMsgs(PORT)).some(m => m.account === 'SIM-D') && !!(await p.$(`${AP} .apg-rform`)), 'a drawdown above the size: nothing sent, the form stays open');
  await p.fill(`${AP} [data-rf="drawdown"][data-id="SIM-D"]`, '2500');
  await p.fill(`${AP} [data-rf="maxMinis"][data-id="SIM-D"]`, '5');
  await p.click(`${AP} [data-act="join-yes"][data-id="SIM-D"]`);
  const sentD = await until(async () => (await groupMsgs(PORT)).find(m => m.type === 'accountGroup' && m.account === 'SIM-D'), 'SIM-D\'s accountGroup');
  check(sentD && sentD.size === 50000 && sentD.drawdown === 2500 && sentD.maxMinis === 5 && !('typeId' in sentD), 'sent: the rules typed, no type id: ' + JSON.stringify(sentD));
  /* 5. a member's rules later: Rules on SIM-A, Save rules sends memberRules */
  await p.click(`${AP} [data-act="rules-edit"][data-id="SIM-A"]`);
  const formA = await until(() => p.$$eval(`${AP} .apg-rform [data-rf]`, els => Object.fromEntries(els.map(e => [e.dataset.rf, e.value]))), 'SIM-A\'s rules form');
  check(formA && formA.size === '150000' && formA.drawdown === '4500' && formA.lockAt === '150100' && formA.maxMinis === '10', 'Rules: the form with SIM-A\'s rules now: ' + JSON.stringify(formA));
  await p.fill(`${AP} [data-rf="dailyLoss"][data-id="SIM-A"]`, '3000');
  await p.screenshot({ path: path.join(out, 'member-rules-edit-1366.png') });
  await p.click(`${AP} [data-act="rules-save"][data-id="SIM-A"]`);
  const sentA = await until(async () => (await groupMsgs(PORT)).find(m => m.type === 'memberRules' && m.account === 'SIM-A'), 'SIM-A\'s memberRules');
  check(sentA && sentA.dailyLoss === 3000 && sentA.size === 150000 && sentA.typeId === 'sample-lucid-150k', 'sent: memberRules with the daily loss changed, the rest as it was: ' + JSON.stringify(sentA));
  const roomA = await until(async () => { const t = await p.$eval(`${AP} .gr-row[data-k="SIM-A"] .apg-rtext`, e => e.title).catch(() => ''); return /Daily loss: \$3,000\.00 left of \$3,000\.00/.test(t) ? t : null; }, 'SIM-A\'s daily room from its own rules');
  if (!roomA) console.log('  info: room tip ' + await p.$eval(`${AP} .gr-row[data-k="SIM-A"] .apg-rtext`, e => e.title).catch(() => 'none'));
  check(!!roomA, 'the Room reads the member\'s own daily loss ($3,000 of $3,000): ' + (roomA || '').split('\n').join(' | '));
  await p.screenshot({ path: path.join(out, 'member-rules-accounts-1366.png') });
  /* 6. Settings: the group's row says each member keeps its own rules and the risk with each member's dollars; the dialog fits */
  await p.click('#wsSet');
  const row = await until(async () => { const t = await p.$eval('#wsGroups .gp-row[data-id="g1"]', e => e.textContent).catch(() => ''); return /each with its own rules/.test(t) ? t : null; }, 'the group\'s row in Settings');
  check(/4 accounts \(each with its own rules\) · risk 10% of each account's max loss \(SIM-A \$450, SIM-B \$200, SIM-C \$100, SIM-D \$250\)/.test(row || ''), 'Settings: each member with its own rules, 10% of each one\'s max loss: ' + row);
  await p.click('#wsGroups [data-gp="edit"][data-id="g1"]');
  await p.waitForSelector('#gp-riskPct', { timeout: 5000 });
  check((await p.$eval('#gp-riskPct', e => e.value)) === '10', 'the rules dialog\'s Risk % of max loss box: 10');
  const dlgFit = await p.$eval('.ws-gp', f => { const r = f.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth; });
  check(dlgFit, 'the rules dialog with the Risk box fits 1366 x 768');
  await p.screenshot({ path: path.join(out, 'member-rules-dialog-1366.png') });
  await p.fill('#gp-riskPct', '');
  await p.click('.ws-gp button[type="submit"]');
  const save = await until(async () => (await groupMsgs(PORT)).find(m => m.type === 'groupSave'), 'groupSave');
  check(save && save.riskPct === 0, 'Risk emptied: groupSave riskPct 0 (off): ' + JSON.stringify(save));
  await ctx.close();
  /* 7. an older ChartBridge (one rule set per group): the 1.26.0 question, no rule key, no risk box */
  const o = await openPage(OP);
  await o.p.selectOption(`${AP} select.apg-grp[data-id="SIM-B"]`, 'g1');
  const jo = await until(() => joinText(o.p), 'the older ChartBridge\'s join question');
  check(/^Put SIM-B in Lucid: highest close so far/.test(jo || '') && await o.p.$$eval(`${AP} .apg-join [data-rf]`, e => e.length) === 0, 'an older ChartBridge: the 1.26.0 question only: ' + jo);
  await o.p.click(`${AP} [data-act="join-yes"][data-id="SIM-B"]`);
  const so = await until(async () => (await groupMsgs(OP)).find(m => m.type === 'accountGroup' && m.account === 'SIM-B'), 'the older join');
  check(so && !('size' in so) && !('typeId' in so), 'no rule key to an older ChartBridge (it refuses keys it does not know): ' + JSON.stringify(so));
  check(!(await o.p.$(`${AP} .apg-mrules`)), 'no Rules button with an older ChartBridge');
  await o.p.click('#wsSet'); await o.p.click('#wsGroups [data-gp="edit"][data-id="g1"]');
  await o.p.waitForSelector('#gp-size', { timeout: 5000 });
  check(!(await o.p.$('#gp-riskPct')), 'no Risk box with an older ChartBridge');
  await o.ctx.close();
} catch (e) { fail('threw: ' + (e && e.stack || e)); }
finally { await browser.close(); bridge.kill(); older.kill(); await desk.close(); }
console.log(errors.length ? errors.length + ' FAILED' : 'member-rules smoke: all passed');
process.exit(errors.length ? 1 : 0);
