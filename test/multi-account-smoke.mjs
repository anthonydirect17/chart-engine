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
//   - 1.40.0: a member NinjaTrader no longer lists: its chip says so, no bench move, Remove (a second click) sends accountGroup null;
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
  '--trade-accounts=SIM-A,SIM-B,SIM-C,SIM-D,SIM-E,SIM-F,SIM-G,SIM-H', '--version=0.6.7', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
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
  { account: 'SIM-F', firm: 'Lucid', archived: false, accountType: lucid('sample-lucid-50k', 'Flex 50K Eval'), source: {} },
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
  check(L0 && JSON.stringify(L0.bench) === '["SIM-D","SIM-E","SIM-F","SIM-G"]' && !L0.bench.includes('SIM-H'), 'the bench: SIM-D (benched), then Lucid\'s accounts in no group (SIM-E, SIM-F, SIM-G); Apex\'s SIM-H never shows');
  check(L0 && L0.sumIn === '3 accounts · $375 at risk a trade' && L0.risk === '5', 'each chip\'s risk at 5% of its own max loss ($225, $100, $50), the lane\'s sum $375: ' + (L0 && L0.sumIn));
  const chip = name => p.$eval(`${sel} [data-chip="${name}"]`, e => [...e.children].map(c => c.textContent.trim()).join(' ').replace(/\s+/g, ' '));
  check(/^SIM-A ?SIM Flex 150K Eval Room \$[\d,]+ ?Risk \$225$/.test(await chip('SIM-A')), 'a chip: the account, SIM or LIVE, its type on The Desk, its room and its own risk: ' + await chip('SIM-A'));
  check(/set its type on The Desk first/.test(await chip('SIM-G')) && /not in the group: drag or click it in to join/.test(await chip('SIM-E')), 'SIM-G says to set its type first; SIM-E that it joins by a drag or a click');
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
  /* refused on the page, with the reason on the chip: a working order on SIM-A */
  await control('elsewhere', { account: 'SIM-A', root: 'MNQ', side: 'buy', kind: 'limit', qty: 1, p: 24000 });
  await until(async () => /in a trade: 1 working order/.test(await chip('SIM-A')), 'SIM-A\'s working order on its chip');
  const n0 = (await groupMsgs()).filter(m => m.type === 'memberBench').length;
  await p.click(`${sel} [data-chip="SIM-A"]`, { force: true }); await wait(300);
  check((await groupMsgs()).filter(m => m.type === 'memberBench').length === n0 && /SIM-A is in a trade or has working orders \(1 working order\)\. It moves once it is flat with no working orders\./.test((await lanes()).toast),
    'SIM-A with a working order: nothing sent, the reason on the line: ' + (await lanes()).toast);
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
  /* 1.37.0 (Anthony 2026-10-22, "Join flow on the chip"): the firm's account in no group joins from its chip: the Accounts tab's own
     join step (its rules from its type on The Desk, the highest close), Put in sends the same accountGroup; Cancel leaves it */
  const joins = async () => (await groupMsgs()).filter(m => m.type === 'accountGroup');
  /* review M1: a highest close typed in one account's join step never carries into another's: SIM-E's step, 50250 typed, then a
     click on SIM-F (typed, in no group): SIM-F's box shows SIM-F's own prefill, and Put in sends that */
  const jm0 = (await joins()).length;
  await p.click(`${sel} [data-chip="SIM-E"]`);
  await until(() => p.$(`${sel} [data-jkey="SIM-E|g1"]`), 'SIM-E\'s join step');
  await p.fill(`${sel} [data-ma="jhigh"]`, '50250');
  await p.click(`${sel} [data-chip="SIM-F"]`);
  const fbox = await until(() => p.$eval(`${sel} [data-jkey="SIM-F|g1"]`, e => ({ value: e.value, prefill: e.getAttribute('value') })).catch(() => null), 'SIM-F\'s join step');
  check(fbox && fbox.value === fbox.prefill && fbox.value !== '50250' && !(await p.$(`${sel} [data-jkey="SIM-E|g1"]`)),
    'review M1: SIM-E\'s typed 50250 does not carry into SIM-F\'s step: SIM-F\'s box shows its own prefill: ' + JSON.stringify(fbox));
  await p.click(`${sel} [data-ma="join-yes"]`);
  const fm = await until(async () => (await joins()).slice(jm0).find(m => m.account === 'SIM-F'), 'SIM-F\'s accountGroup');
  check(fm && fbox && fm.group === 'g1' && fm.highClose === Number(fbox.prefill.replace(/,/g, '')) && !(await joins()).slice(jm0).some(m => m.account === 'SIM-E'),
    'review M1: Put in sends SIM-F with its own prefill (' + (fbox && fbox.prefill) + '), nothing for SIM-E: ' + JSON.stringify(fm));
  await until(async () => { const l = await lanes(); return l.in.includes('SIM-F') ? l : null; }, 'SIM-F in the trading lane');
  const j0 = (await joins()).length;
  await p.click(`${sel} [data-chip="SIM-E"]`);
  const step = await until(() => p.$eval(`${sel} .ma-join`, e => ({ words: e.querySelector('.ma-jwords').textContent, high: e.querySelector('[data-ma="jhigh"]').value })), 'the join step under SIM-E');
  check(step && /^Put SIM-E in Lucid Flex with its rules from Lucid Flex 50K Eval: \$50,000 · daily none · drawdown \$2,000 end of day/.test(step.words) && step.high === '50000',
    'a click on SIM-E (in no group): the join step under its chip, the Accounts tab\'s words, the highest close prefilled: ' + JSON.stringify(step));
  await p.locator(sel).screenshot({ path: path.join(out, 'multi-account-join-1366.png') });
  if (SHOTS) fs.copyFileSync(path.join(out, 'multi-account-join-1366.png'), path.join(SHOTS, 'multi-account-join-1366.png'));
  await p.click(`${sel} [data-ma="join-no"]`); await wait(300);
  check(!(await p.$(`${sel} .ma-join`)) && (await lanes()).bench.includes('SIM-E') && (await joins()).length === j0, 'Cancel: the step closes, SIM-E stays on the bench, nothing sent');
  await p.dragAndDrop(`${sel} [data-chip="SIM-E"]`, `${sel} .ma-lane.in`);
  await until(() => p.$(`${sel} .ma-join`), 'the join step after a drag into the group');
  await p.fill(`${sel} [data-ma="jhigh"]`, '50250');
  await p.click(`${sel} [data-ma="join-yes"]`);
  const jm = await until(async () => (await joins()).slice(j0).find(m => m.account === 'SIM-E'), 'SIM-E\'s accountGroup');
  check(jm && jm.group === 'g1' && jm.highClose === 50250 && jm.typeId === 'sample-lucid-50k' && jm.size === 50000 && jm.drawdown === 2000, 'Put in: the Accounts tab\'s accountGroup, with its rules from its type and the highest close: ' + JSON.stringify(jm));
  const LJ = await until(async () => { const l = await lanes(); return l.in.includes('SIM-E') ? l : null; }, 'SIM-E in the trading lane');
  check(LJ && /SIM-E joined Lucid Flex/.test(LJ.toast), 'SIM-E lands in the trading lane: ' + JSON.stringify(LJ && [LJ.in, LJ.toast]));
  const j1 = (await joins()).length;
  await p.click(`${sel} [data-chip="SIM-G"]`, { force: true }); await wait(300);
  check(!(await p.$(`${sel} .ma-join`)) && (await joins()).length === j1 && /SIM-G has no account type on The Desk: set its type there first/.test(await chip('SIM-G')), 'SIM-G (no type): no join step, nothing sent, the reason on its chip');
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

  /* a ChartBridge older than 0.6.7 (no bench): a join from a chip says it needs 0.6.7, as moving a chip does */
  const OLDP = PORT + 1;
  const ob = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(OLDP), '--v3', '--trading', '--test-controls', '--bench-groups', '--max-qty=MNQ:9,NQ:9',
    '--trade-accounts=SIM-A,SIM-B,SIM-C,SIM-D,SIM-E,SIM-F,SIM-G,SIM-H', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => ob.stdout.once('data', r));
  try {
    const q = await ctx.newPage();
    q.on('pageerror', e => fail('pageerror (older): ' + e.message));
    await q.goto(`http://localhost:${OLDP}/live/?layout=Main`);
    await q.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(q, TEST_PIN);
    await q.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 40000 });
    await q.click('#wsAdd'); await q.click('#wsAddMenu [data-add="multi"]');
    const qs = await until(() => q.evaluate(() => (window.workspace.panels().find(x => x.type === 'multi') || {}).id), 'the panel on the older ChartBridge');
    const qsel = `.ws-panel[data-id="${qs}"]`;
    await until(() => q.$(`${qsel} [data-chip="SIM-E"]`), 'SIM-E on the older ChartBridge');
    const n1 = ((await (await fetch(`http://127.0.0.1:${OLDP}/test/received`, { method: 'POST' })).json()).groupMsgs || []).length;
    await q.click(`${qsel} [data-chip="SIM-E"]`, { force: true }); await wait(300);
    const t = await q.$eval(`${qsel} .ma-toast:last-child`, e => e.textContent);
    check(/^Joining from the panel needs ChartBridge 0\.6\.7/.test(t) && !(await q.$(`${qsel} .ma-join`)) && ((await (await fetch(`http://127.0.0.1:${OLDP}/test/received`, { method: 'POST' })).json()).groupMsgs || []).length === n1,
      'an older ChartBridge: the join says it needs 0.6.7 (as moving a chip does), nothing sent: ' + t);
    await q.close();
  } finally { ob.kill(); }
  await p.setViewportSize({ width: 1920, height: 1080 }); await wait(600);
  await shot(p, 'multi-account-groups-1920.png');
  /* 1.38.0 (WORK 2026-10-22): at about 610 px the trading lane's sum ("4 accounts · $350 at risk a trade") ran over the Bench's
     header. Each lane's header now wraps inside its lane: at every width below, no piece of one header touches the other's, and
     every piece stays inside its own lane */
  await p.click(`${sel} .ma-tabs [data-tab="groups"]`).catch(() => {});
  await p.click(`${sel} [data-chip="SIM-D"]`).catch(() => {});   // four in the trading lane, as Anthony's
  await until(async () => (await lanes()).in.length >= 4, 'four accounts trading with the group', 6000);
  for (const w of [760, 700, 660, 640, 620, 610, 580, 520, 460, 400, 340, 300]) {
    await p.$eval(sel, (e, w) => { e.style.width = w + 'px'; e.style.justifySelf = 'start'; }, w); await wait(250);
    const g = await p.$eval(sel, e => {
      const R = x => { const r = x.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
      const parts = k => [...e.querySelectorAll('.ma-lane.' + k + ' .ma-lhead > *')].filter(x => x.getBoundingClientRect().width > 0).map(R);
      return { inL: R(e.querySelector('.ma-lane.in')), benchL: R(e.querySelector('.ma-lane.bench')), a: parts('in'), b: parts('bench'), narrow: e.classList.contains('ma-narrow'),
        sum: (e.querySelector('.ma-lane.in .ma-lsum') || {}).textContent, w: Math.round(e.getBoundingClientRect().width) };
    });
    const hit = (x, y) => x.l < y.r - 0.5 && x.r > y.l + 0.5 && x.t < y.b - 0.5 && x.b > y.t + 0.5;
    const inside = (x, L) => x.l >= L.l - 0.5 && x.r <= L.r + 0.5;
    const clash = g.a.some(x => g.b.some(y => hit(x, y)));
    const outside = g.a.some(x => !inside(x, g.inL)) || g.b.some(x => !inside(x, g.benchL));
    check(!clash && !outside, 'the lane headers at ' + g.w + ' px' + (g.narrow ? ' (lanes stacked)' : '') + ': no overlap, each inside its lane (' + g.sum + ')');
    if (w === 610 || w === 640 || w === 400) await p.locator(sel).screenshot({ path: path.join(out, 'multi-account-heads-' + w + '.png') }).then(() => { if (SHOTS) fs.copyFileSync(path.join(out, 'multi-account-heads-' + w + '.png'), path.join(SHOTS, 'multi-account-heads-' + w + '.png')); });
  }
  await p.$eval(sel, e => { e.style.width = ''; e.style.justifySelf = ''; });
  /* 1.40.0 (audit 6): a member NinjaTrader no longer lists (the fake's /test/unlist-account, ChartBridge 0.6.10's notListed): its chip
     says so (never "set its type on The Desk first"), offers no bench move, and Remove takes it out of the group (a second click sends it) */
  await control('unlist-account', { name: 'SIM-C' });
  const dc = await until(async () => { const t = await chip('SIM-C'); return /not in NinjaTrader now/.test(t) ? t : null; }, 'SIM-C says not in NinjaTrader now');
  check(dc && !/set its type on The Desk first/.test(dc) && await p.$eval(`${sel} [data-chip="SIM-C"]`, e => e.classList.contains('missing') && e.getAttribute('draggable') === 'false'), '1.40.0: a member NinjaTrader does not list: "not in NinjaTrader now", not the type, no drag: ' + dc);
  const g0 = (await groupMsgs()).length;
  await p.click(`${sel} [data-chip="SIM-C"]`, { force: true }); await wait(300);
  const tm = (await lanes()).toast;
  check((await groupMsgs()).length === g0 && /SIM-C is not in NinjaTrader now: it sits out every entry and cannot move between the lanes/.test(tm), '1.40.0: a click on it moves nothing (no memberBench ChartBridge would refuse), the toast says why: ' + tm);
  check(await p.$eval(`${sel} .ma-dead`, e => /SIM-C is not in NinjaTrader now\./.test(e.textContent) && !!e.querySelector('[data-ma="remove"][data-name="SIM-C"]')), '1.40.0: under its chip: the words and Remove');
  await shot(p, 'multi-account-missing-1366.png');
  await p.locator(sel).screenshot({ path: path.join(out, 'multi-account-missing-panel-1366.png') });
  if (SHOTS) fs.copyFileSync(path.join(out, 'multi-account-missing-panel-1366.png'), path.join(SHOTS, 'multi-account-missing-panel-1366.png'));
  await p.click(`${sel} [data-ma="remove"][data-name="SIM-C"]`); await wait(200);
  check(/Click again/.test(await p.$eval(`${sel} [data-ma="remove"][data-name="SIM-C"]`, e => e.textContent)) && (await groupMsgs()).length === g0, '1.40.0: Remove asks with a second click, nothing sent yet');
  await p.click(`${sel} [data-ma="remove"][data-name="SIM-C"]`);
  const rm = await until(async () => (await groupMsgs()).slice(g0).find(m => m.type === 'accountGroup' && m.account === 'SIM-C'), 'SIM-C\'s accountGroup');
  check(rm && rm.group === null && Object.keys(rm).sort().join(',') === 'account,cid,group,type', '1.40.0: Remove sends accountGroup with no group, nothing else: ' + JSON.stringify(rm));
  const LR = await until(async () => { const l = await lanes(); return !l.in.includes('SIM-C') && !l.bench.includes('SIM-C') ? l : null; }, 'SIM-C out of the group');
  check(LR && /SIM-C is out of /.test(LR.toast), '1.40.0: SIM-C leaves both lanes, the toast says so: ' + (LR && LR.toast));
  await control('unlist-account', { name: 'SIM-C', on: '0' });
} catch (e) { fail('smoke threw: ' + (e && e.stack || e)); }
finally { await browser.close(); bridge.kill(); }
if (errors.length) { console.error(`multi-account smoke: ${errors.length} of ${checks} checks FAILED`); process.exit(1); }
console.log(`multi-account smoke: ${checks} checks, all ok`);
