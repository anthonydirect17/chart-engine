// Multi-Account panel smoke (chart 1.37.0, ChartBridge 0.6.7; Anthony 2026-10-22) against the fake bridge (--bench --bench-groups:
// a made-up Lucid group, risk 5%, Evals, with SIM-A 150K, SIM-B 50K, SIM-C 25K and SIM-D on the bench, Apex with SIM-H; SIM-E and
// SIM-G in no group), in Chromium. The Desk's rows are made up here (Lucid's types for SIM-A to SIM-E, none for SIM-G, Apex's for
// SIM-H). Sample data only; nothing reaches a broker.
//   - + Add panel's Multi-Account: one a layout; the Groups tab: the group dropdown, the risk in the bar, the two lanes, each chip's own
//     dollars, the lane's sum, only this firm's accounts (SIM-H never), the firm's accounts in no group on the bench;
//   - a click and a drag move a chip (memberBench), the groups message brings it back in the other lane; refused on the page with the
//     reason on the chip while an account has a working order, for an account not in the group, and with no type;
//   - the risk percent (groupSave riskPct), Group settings (name, Type; Delete asks twice), New group (made and chosen);
//   - the Copier tab: the copier exactly as the Account page had it; the Account page has no Copier tab any more;
//   - a saved layout with the panel opens again with its group; Settings has no Account groups;
// with screenshots of both tabs at 1366x768 and 1920x1080 in test/out/ (and SHOTS_DIR when set).
//   npm run smoke:multi-account
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
const PORT = +(process.env.MULTI_SMOKE_PORT || 8977);
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, what, ms) => { const end = Date.now() + (ms || 10000); for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); } };
async function shot(page, name, clip) {
  const file = path.join(out, name);
  await page.screenshot(clip ? { path: file, clip } : { path: file });
  if (SHOTS) fs.copyFileSync(file, path.join(SHOTS, name));
}
const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--v3', '--trading', '--test-controls', '--bench', '--bench-groups', '--max-qty=MNQ:9,NQ:9',
  '--trade-accounts=SIM-A,SIM-B,SIM-C,SIM-D,SIM-E,SIM-G,SIM-H', '--version=0.6.7', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => bridge.stdout.once('data', r));
const control = async (what, q) => (await fetch(`http://127.0.0.1:${PORT}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
const groupMsgs = async () => ((await control('received')).groupMsgs || []);
const lucid = (id, name) => ({ id, firm: 'Lucid', name, version: 1, status: 'checked' });
const DESK = { accounts: [
  { account: 'SIM-A', firm: 'Lucid', archived: false, accountType: lucid('sample-lucid-150k', 'Flex 150K Eval'), source: {} },
  { account: 'SIM-B', firm: 'Lucid', archived: false, accountType: lucid('sample-lucid-50k', 'Flex 50K Eval'), source: {} },
  { account: 'SIM-C', firm: 'Lucid', archived: false, accountType: lucid('sample-lucid-25k-daily', 'Flex 25K Daily'), source: {} },
  { account: 'SIM-D', firm: 'Lucid', archived: false, accountType: lucid('sample-lucid-50k', 'Flex 50K Eval'), source: {} },
  { account: 'SIM-E', firm: 'Lucid', archived: false, accountType: lucid('sample-lucid-50k', 'Flex 50K Eval'), source: {} },
  { account: 'SIM-G', firm: 'Lucid', archived: false, accountType: null, source: {} },
  { account: 'SIM-H', firm: 'Apex', archived: false, accountType: { id: 'sample-apex-50k', firm: 'Apex', name: 'EOD 50K', version: 1, status: 'checked' }, source: {} },
] };
const TYPES = { v: 1, asOf: '2026-10-22T12:00:00Z', types: [
  { id: 'sample-lucid-50k', firm: 'Lucid', name: 'Flex 50K Eval', account_type: 'eval', account_size: 50000, drawdown: 2000, drawdown_type: 'eod', version: 1, status: 'checked' }] };
const LAYOUT = [
  { id: 'c1', type: 'chart', root: 'MNQ', tf: 'm1', x: 0, y: 0, w: 6, h: 3 },
  { id: 'tk', type: 'ticket', x: 6, y: 0, w: 2, h: 3 },
  { id: 'ap', type: 'accounts', x: 8, y: 0, w: 4, h: 3 },
];
const MA = '.ws-panel[data-id="ma"]';
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  for (const [api, body] of [['chart-accounts', DESK], ['account-types', TYPES]])
    await ctx.route('http://localhost:8800/api/' + api, r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) }));
  await ctx.addInitScript(l => { try { if (!localStorage.getItem('live-workspace-v1')) localStorage.setItem('live-workspace-v1', JSON.stringify({ v: 1, layouts: { Main: { panels: l } } })); } catch (e) { /* blocked */ } }, LAYOUT);
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  await p.goto(`http://localhost:${PORT}/live/?layout=Main`);
  await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
  await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 40000 });
  /* + Add panel: Multi-Account, at the lower left (the space the layout leaves) */
  await p.click('#wsAdd'); await p.click('#wsAddMenu [data-add="multi"]');
  const id = await until(() => p.evaluate(() => (window.workspace.panels().find(x => x.type === 'multi') || {}).id), 'the Multi-Account panel placed');
  const sel = `.ws-panel[data-id="${id}"]`;
  check(await p.$eval(`${sel} .ws-name`, e => e.textContent) === 'Multi-Account', 'the panel\'s header: Multi-Account');
  await p.click('#wsAdd');
  check(await p.$eval('#wsAddMenu [data-add="multi"]', e => e.disabled), 'one a layout: the menu item is off while it is placed');
  await p.keyboard.press('Escape');
  /* the Groups tab */
  const lanes = () => p.evaluate(s => ({ in: [...document.querySelectorAll(s + ' .ma-lane.in [data-chip]')].map(e => e.dataset.chip), bench: [...document.querySelectorAll(s + ' .ma-lane.bench [data-chip]')].map(e => e.dataset.chip),
    sumIn: (document.querySelector(s + ' .ma-lane.in .ma-lsum') || {}).textContent, sumBench: (document.querySelector(s + ' .ma-lane.bench .ma-lsum') || {}).textContent,
    group: (document.querySelector(s + ' [data-ma="group"]') || {}).value, risk: (document.querySelector(s + ' [data-ma="risk"]') || {}).value, toast: (document.querySelector(s + ' .ma-toast:last-child') || {}).textContent }), sel);
  const L0 = await until(async () => { const l = await lanes(); return l.in.length === 3 && l.bench.length >= 1 ? l : null; }, 'the lanes drawn');
  check(L0 && L0.group === 'g1' && JSON.stringify(L0.in) === '["SIM-A","SIM-B","SIM-C"]', 'Groups: Lucid chosen, SIM-A, SIM-B and SIM-C trade with it: ' + JSON.stringify(L0));
  check(L0 && JSON.stringify(L0.bench) === '["SIM-D","SIM-E","SIM-G"]' && !L0.bench.includes('SIM-H'), 'the bench: SIM-D (benched), then Lucid\'s accounts in no group (SIM-E, SIM-G); Apex\'s SIM-H never shows');
  check(L0 && L0.sumIn === '3 accounts · $375 at risk a trade' && L0.risk === '5', 'each chip\'s risk at 5% of its own max loss ($225, $100, $50), the lane\'s sum $375: ' + (L0 && L0.sumIn));
  const chip = name => p.$eval(`${sel} [data-chip="${name}"]`, e => [...e.children].map(c => c.textContent.trim()).join(' ').replace(/\s+/g, ' '));
  check(/^SIM-A ?SIM Flex 150K Eval Room \$[\d,]+ ?Risk \$225$/.test(await chip('SIM-A')), 'a chip: the account, SIM or LIVE, its type on The Desk, its room and its own risk: ' + await chip('SIM-A'));
  check(/set its type on The Desk first/.test(await chip('SIM-G')) && /not in the group: join it on the Accounts tab/.test(await chip('SIM-E')), 'SIM-G says to set its type first; SIM-E to join on the Accounts tab');
  await shot(p, 'multi-account-groups-1366.png');
  await p.locator(sel).screenshot({ path: path.join(out, 'multi-account-groups-panel-1366.png') });
  if (SHOTS) fs.copyFileSync(path.join(out, 'multi-account-groups-panel-1366.png'), path.join(SHOTS, 'multi-account-groups-panel-1366.png'));
  /* a click moves SIM-D back to trade with the group */
  await p.click(`${sel} [data-chip="SIM-D"]`);
  const mb1 = await until(async () => (await groupMsgs()).find(m => m.type === 'memberBench' && m.account === 'SIM-D'), 'memberBench for SIM-D');
  check(mb1 && mb1.benched === false, 'a click on a benched chip sends memberBench benched false: ' + JSON.stringify(mb1));
  const L1 = await until(async () => { const l = await lanes(); return l.in.includes('SIM-D') ? l : null; }, 'SIM-D in the trading lane');
  check(L1 && L1.sumIn === '4 accounts · $475 at risk a trade' && /SIM-D trades with Lucid from the next entry/.test(L1.toast), 'SIM-D trades with Lucid: the lane sums 4 accounts and $475; the line says so: ' + JSON.stringify(L1 && [L1.sumIn, L1.toast]));
  /* a drag takes SIM-B to the bench */
  await p.dragAndDrop(`${sel} [data-chip="SIM-B"]`, `${sel} .ma-lane.bench`);
  const L2 = await until(async () => { const l = await lanes(); return l.bench.includes('SIM-B') ? l : null; }, 'SIM-B on the bench after the drag');
  check(L2 && (await groupMsgs()).some(m => m.type === 'memberBench' && m.account === 'SIM-B' && m.benched === true) && L2.sumIn === '3 accounts · $375 at risk a trade', 'a drag to the bench: memberBench benched true; SIM-B sits out: ' + JSON.stringify(L2));
  /* refused on the page, with the reason on the chip: a working order on SIM-A; SIM-E not in the group */
  await control('elsewhere', { account: 'SIM-A', root: 'MNQ', side: 'buy', kind: 'limit', qty: 1, p: 24000 });
  await until(async () => /in a trade: 1 working order/.test(await chip('SIM-A')), 'SIM-A\'s working order on its chip');
  const n0 = (await groupMsgs()).filter(m => m.type === 'memberBench').length;
  await p.click(`${sel} [data-chip="SIM-A"]`, { force: true }); await wait(300);
  check((await groupMsgs()).filter(m => m.type === 'memberBench').length === n0 && /SIM-A is in a trade or has working orders \(1 working order\)\. It moves once it is flat with no working orders\./.test((await lanes()).toast),
    'SIM-A with a working order: nothing sent, the reason on the line: ' + (await lanes()).toast);
  await p.click(`${sel} [data-chip="SIM-E"]`, { force: true }); await wait(200);
  check(/SIM-E is not in Lucid: put it in the group on the Accounts tab \(Group\) first/.test(await chip('SIM-E')), 'SIM-E (in no group): it says to join on the Accounts tab: ' + await chip('SIM-E'));
  await shot(p, 'multi-account-refused-1366.png');
  /* the risk: refused while the group is not flat (SIM-A's order), then changed once it is */
  check(await p.$eval(`${sel} [data-ma="risk"]`, e => e.disabled), 'the risk box is off while the group is not flat');
  /* SIM-A's working order cancelled from the Account page's Working orders tab (its Cancel) */
  await p.click('.ws-panel[data-id="ap"] .ac-tab[data-tab="ord"]'); await wait(200);
  const ordId = ((await control('state', { root: 'MNQ' })).orders || []).find(o => o.account === 'SIM-A' && o.state === 'working').id;
  await p.click(`.ws-panel[data-id="ap"] [data-act="cancel"][data-id="${ordId}"]`);
  await p.click('.ws-panel[data-id="ap"] .ac-tab[data-tab="acc"]');
  const flatNow = await until(async () => !(await p.$eval(`${sel} [data-ma="risk"]`, e => e.disabled)), 'the risk box on once the group is flat', 6000);
  if (flatNow) {
    await p.fill(`${sel} [data-ma="risk"]`, '4'); await p.press(`${sel} [data-ma="risk"]`, 'Enter');
    const gs = await until(async () => (await groupMsgs()).find(m => m.type === 'groupSave' && m.riskPct === 4), 'groupSave riskPct 4');
    check(gs && gs.group === 'g1' && gs.name === 'Lucid' && !('drawdown' in gs) && !('noHedge' in gs) && !('hero' in gs), 'the risk: groupSave with the risk alone (no rules, no hedging switch, no hero): ' + JSON.stringify(gs));
    await until(async () => (await lanes()).sumIn === '3 accounts · $300 at risk a trade', 'the chips and the lane at 4%');
    check(/Risk \$180$/.test(await chip('SIM-A')), 'SIM-A\'s chip at 4%: $180');
  }
  /* Group settings: name and Type; Delete asks twice */
  await p.click(`${sel} [data-ma="settings"]`);
  check(await p.$eval(`${sel} .ma-set`, e => /Group name/.test(e.textContent) && /Type/.test(e.textContent) && /Delete group/.test(e.textContent) && !/Hero|drawdown size|Account size|No hedging/i.test(e.textContent.replace('max loss', ''))),
    'Group settings: the name, the Type and Delete only (no firm rules, no Hero, no hedging switch)');
  await shot(p, 'multi-account-settings-1366.png');
  await p.fill(`${sel} [data-ma="name"]`, 'Lucid Flex'); await p.selectOption(`${sel} [data-ma="type"]`, 'funded'); await p.click(`${sel} [data-ma="save"]`);
  const gs2 = await until(async () => (await groupMsgs()).find(m => m.type === 'groupSave' && m.name === 'Lucid Flex'), 'the rename');
  check(gs2 && gs2.accountType === 'funded' && !('drawdown' in gs2), 'Save: groupSave with the name and the Type: ' + JSON.stringify(gs2));
  await until(async () => (await p.$eval(`${sel} [data-ma="group"]`, s => s.options[s.selectedIndex].textContent)) === 'Lucid Flex', 'the new name in the dropdown');
  /* New group: made and chosen; then Delete (twice) */
  await p.click(`${sel} [data-ma="new"]`);
  await p.fill(`${sel} [data-ma="nname"]`, 'Tradeify'); await p.fill(`${sel} [data-ma="nrisk"]`, '3'); await p.click(`${sel} [data-ma="create"]`);
  const ng = await until(async () => (await groupMsgs()).find(m => m.type === 'groupSave' && m.name === 'Tradeify'), 'New group');
  check(ng && !ng.group && ng.accountType === 'eval' && ng.riskPct === 3 && !('size' in ng), 'New group: groupSave with a name, a Type and the risk, no rules: ' + JSON.stringify(ng));
  const L3 = await until(async () => { const l = await lanes(); return l.group === 'g3' ? l : null; }, 'the new group chosen');
  check(L3 && L3.in.length === 0, 'the new group is chosen, its lanes empty: ' + JSON.stringify(L3));
  await p.click(`${sel} [data-ma="settings"]`); await p.click(`${sel} [data-ma="delete"]`);
  check(/Delete Tradeify\? Click again/.test(await p.$eval(`${sel} [data-ma="delete"]`, e => e.textContent)), 'Delete asks first');
  await p.click(`${sel} [data-ma="delete"]`);
  check(!!(await until(async () => (await groupMsgs()).find(m => m.type === 'groupDelete' && m.group === 'g3'), 'groupDelete')), 'then groupDelete');
  await until(async () => (await lanes()).group === 'g1', 'back on Lucid Flex');
  /* the Copier tab: the copier as the Account page had it; the Account page has no Copier tab */
  await p.click(`${sel} .ma-tabs [data-tab="copier"]`);
  const cop = await until(() => p.$eval(`${sel} .ma-cop`, e => (!e.hidden && e.querySelector('.apg-cop-top') ? e.textContent : null)), 'the copier in the Copier tab');
  check(/STOOD DOWN|ARMED/.test(cop || '') && /Leader/.test(cop || '') && await p.$eval(`${sel} .ma-cop .apg-tabs`, e => e.hidden), 'the Copier tab: the copier exactly as before (ARMED or STOOD DOWN, the Leader, its rows), no tab strip of its own');
  check(!(await p.$('.ws-panel[data-id="ap"] .ac-tab[data-tab="cop"]')), 'the Account page has no Copier tab');
  await shot(p, 'multi-account-copier-1366.png');
  await p.locator(sel).screenshot({ path: path.join(out, 'multi-account-copier-panel-1366.png') });
  if (SHOTS) fs.copyFileSync(path.join(out, 'multi-account-copier-panel-1366.png'), path.join(SHOTS, 'multi-account-copier-panel-1366.png'));
  /* Settings has no Account groups */
  await p.click('#wsSet'); await wait(200);
  check(!(await p.$('#wsGroupsCol')) && !(await p.$('#wsGroupNew')), 'Settings has no Account groups (made and set on the panel)');
  await p.keyboard.press('Escape');
  /* a reload: the layout keeps the panel, its group pick and the Groups tab */
  await p.reload();
  await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
  await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 40000 });
  const L4 = await until(async () => { const l = await lanes(); return l.in.length ? l : null; }, 'the panel after a reload');
  check(L4 && L4.group === 'g1', 'after a reload: the panel is there with its group: ' + JSON.stringify(L4 && L4.group));
  await p.setViewportSize({ width: 1920, height: 1080 }); await wait(600);
  await shot(p, 'multi-account-groups-1920.png');
} catch (e) { fail('smoke threw: ' + (e && e.stack || e)); }
finally { await browser.close(); bridge.kill(); }
if (errors.length) { console.error(`multi-account smoke: ${errors.length} of ${checks} checks FAILED`); process.exit(1); }
console.log(`multi-account smoke: ${checks} checks, all ok`);
