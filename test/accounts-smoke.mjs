// Smoke for the Account page and the Quote board's quote-only markets (chart 1.16.0, live/accounts.js; Anthony's spec,
// chart page section 1, items 14, 15 and 20) against the fake bridge's protocol v3 (test/fake-bridge.mjs --v3). Sample data
// and made-up accounts only (Sim101, EVAL-A, EVAL-B, FUNDED-C, SIM-F1, SIM-F2); The Desk's GET /api/chart-accounts is
// answered by the test (a made-up firm's limits and commission).
//
//   1. every switch on: the Accounts tab with the checkmarks (one checked from the page), EVAL-B Gone after the grace and
//      archived through the in-page confirm (Keep first), FUNDED-C amber from The Desk's trailing drawdown and the chart's
//      warning on it, Positions, Working orders with Cancel, Today's trades (gross and net), the Copier tab (Re-arm, a
//      follower's quantity), the Log; the Quote board's rows NQ, ES, then YM to ZB with ZN and ZB in 32nds
//   2. every switch off (--v3-off=...): no checkbox, no Archive, no Cancel, no Copier tab, no box or list at all on the page
//   3. ChartBridge 0.3.8 (no v3): the page says what it needs, opens no connection of its own; the Quote board NQ and ES only
// Screenshots in test/out/accounts-*.png.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const PORT = +(process.env.ACCOUNTS_SMOKE_PORT || 8961), OFF_PORT = PORT + 1, OLD_PORT = PORT + 2;
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms) {
  const end = Date.now() + (ms || 10000);
  for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); }
}
const bridges = [];
async function startBridge(port, flags) {
  const child = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(port)].concat(flags), { stdio: ['ignore', 'pipe', 'inherit'] });
  bridges.push(child);
  await new Promise(r => child.stdout.once('data', r));
}
const control = async (port, what, q) => (await fetch(`http://127.0.0.1:${port}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
const v3 = port => control(port, 'v3');

const LAYOUT = [
  { id: 'c1', type: 'chart', root: 'MNQ', tf: 'm1', x: 0, y: 0, w: 4, h: 3 },
  { id: 'tk', type: 'ticket', x: 4, y: 0, w: 2, h: 3 },
  { id: 'qb', type: 'quotes', x: 0, y: 3, w: 3, h: 3 },
  { id: 'ap', type: 'accounts', x: 6, y: 0, w: 6, h: 6 },
  { id: 'c2', type: 'chart', root: 'NQ', tf: 'm5', x: 3, y: 3, w: 3, h: 3 },
];
function seed([layouts]) {
  try { if (!localStorage.getItem('live-workspace-v1')) localStorage.setItem('live-workspace-v1', JSON.stringify({ v: 1, layouts })); } catch (e) { /* blocked */ }
}
/* The Desk (made-up numbers): FUNDED-C's trailing drawdown 15,000, so ChartBridge's room 2,500 is 83 percent used: amber;
   Sim101's commission for the net column */
const DESK = { accounts: [
  { account: 'FUNDED-C', firm: 'Firm A', archived: false, daily_loss_limit: null, trailing_drawdown: 15000, account_size: 50000, source: {} },
  { account: 'EVAL-A', firm: 'Firm A', archived: false, daily_loss_limit: 100000, trailing_drawdown: null, account_size: 50000, source: {} },
  { account: 'Sim101', firm: null, archived: false, daily_loss_limit: null, trailing_drawdown: null, account_size: null, source: {}, commission: { MNQ: 0.5, NQ: 2 } },
] };
async function openWs(ctx, port, layout) {
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));
  await page.route('http://localhost:8800/api/chart-accounts', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': 'http://localhost:' + port }, body: JSON.stringify(DESK) }));
  await page.goto(`http://localhost:${port}/live/?layout=${layout}`);
  await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
  await enterPin(page, TEST_PIN);
  await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 40000 });
  return page;
}
const AP = '.ws-panel[data-id="ap"]';
const tab = async (page, id) => { await page.click(`${AP} .ac-tab[data-tab="${id}"]`); await wait(150); };
const rows = (page, sel) => page.$$eval(`${AP} ${sel} .gr-row:not(.gr-h)`, els => els.map(e => ({ k: e.dataset.k, text: e.textContent, cls: e.className })));
const quoteRows = page => page.$$eval('.ws-panel[data-id="qb"] [data-root]', els => els.map(e => ({ root: e.dataset.root, cls: e.className, last: e.querySelector('[data-q="last"]').textContent, chg: e.querySelector('[data-q="chg"]').textContent })));
const controlsOnPage = page => page.$$eval(`${AP} .ac-list input, ${AP} .ac-list select, ${AP} .ac-list button[data-act="archive"], ${AP} .ac-list button[data-act="cancel"], ${AP} .ac-list button[data-act="rearm"], ${AP} .ac-list button[data-act="mode"]`, els => els.length);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  await startBridge(PORT, ['--v3', '--trading', '--test-controls', '--data-037', '--gone-grace-ms=1500', '--max-qty=MNQ:9,NQ:4', '--test-pin=' + TEST_PIN]);
  /* ================================================================ 1. every switch on */
  console.log('every v3 switch on');
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await ctx.addInitScript(seed, [{ Acc: { panels: LAYOUT } }]);
  const page = await openWs(ctx, PORT, 'Acc');
  const feed = await until(() => page.evaluate(() => { const f = window.workspace.accountFeed(); return f && f.enabled && f.switches.copier ? f : null; }), 'the Account page signed in with the switches', 20000);
  check(feed && feed.v3 && Object.values(feed.switches).every(Boolean), 'the Account page\'s own connection: v3, signed in, every switch named on');
  // Accounts tab
  await until(async () => (await rows(page, '.apg-acc-g')).length >= 5, 'the Accounts tab rows');
  const acc = await rows(page, '.apg-acc-g');
  check(['EVAL-A', 'FUNDED-C', 'SIM-F1', 'SIM-F2', 'Sim101'].every(n => acc.some(r => r.k === n)), 'Accounts: a row per watched account (' + acc.map(r => r.k).join(', ') + ')');
  const checked = await page.$$eval(`${AP} input[data-act="trade"]`, els => Object.fromEntries(els.map(e => [e.dataset.id, e.checked])));
  check(checked['EVAL-A'] === true && checked.Sim101 === true && checked['FUNDED-C'] === false, 'checkmarks: tradeAccounts pre-checked (EVAL-A, Sim101), FUNDED-C not (' + JSON.stringify(checked) + ')');
  await page.click(`${AP} input[data-act="trade"][data-id="FUNDED-C"]`);
  await until(async () => (await v3(PORT)).accounts.list.find(a => a.name === 'FUNDED-C').trade === true, 'FUNDED-C checked through ChartBridge');
  await until(() => page.$eval(`${AP} input[data-act="trade"][data-id="FUNDED-C"]`, e => e.checked), 'the checkmark shows what ChartBridge says');
  check(true, 'a checkmark set from the page: accountTrade, then shown as ChartBridge says');
  // the limit warning: The Desk's trailing drawdown 15,000 and ChartBridge's room 2,500: 83 percent used
  await until(async () => (await rows(page, '.apg-acc-g')).find(r => r.k === 'FUNDED-C' && /apg-amber/.test(r.cls)), 'FUNDED-C amber');
  const fc = (await rows(page, '.apg-acc-g')).find(r => r.k === 'FUNDED-C');
  check(fc && /83% used/.test(fc.text), 'FUNDED-C amber at 83 percent of the room used (' + (fc && fc.text) + ')');
  // the chart's warning, on the ticket's account
  await until(() => page.evaluate(() => window.workspace.ticket().held), 'the ticket held');
  await until(() => page.$eval('.ws-panel[data-id="tk"] [data-tk-id="oAcct"]', s => [...s.options].some(o => o.value === 'FUNDED-C')), 'FUNDED-C in the ticket\'s accounts');
  await page.selectOption('.ws-panel[data-id="tk"] [data-tk-id="oAcct"]', 'FUNDED-C');
  await until(async () => (await page.evaluate(() => window.workspace.ticket().account)) === 'FUNDED-C', 'the ticket on FUNDED-C');
  const badge = await until(() => page.$$eval('.ws-limit', els => { const t = els.map(e => e.className + '|' + e.textContent); return t.length && t.every(x => /amber\|Limit 83%/.test(x)) ? t : null; }), 'every chart warns of FUNDED-C\'s limit');
  check(!!badge, 'the charts trading FUNDED-C show its limit warning (' + JSON.stringify(badge) + ')');
  await page.screenshot({ path: path.join(out, 'accounts-1-accounts.png') });
  await page.selectOption('.ws-panel[data-id="tk"] [data-tk-id="oAcct"]', 'Sim101');
  await until(() => page.$$eval('.ws-limit', els => els.every(e => !e.textContent)), 'the warning goes with an account not near its limit');
  // Gone and Archive (the in-page confirm)
  await until(() => page.$(`${AP} .apg-gone-g [data-k="g|EVAL-B"]`), 'EVAL-B in the Gone list after the grace', 8000);
  check(!(await rows(page, '.apg-acc-g')).some(r => r.k === 'EVAL-B'), 'a Gone account leaves the active rows');
  await page.click(`${AP} button[data-act="archive"][data-id="EVAL-B"]`);
  const ask = await page.$eval(`${AP} .apg-confirm`, e => e.textContent).catch(() => '');
  check(/Archive EVAL-B\? It leaves every list; its history stays\./.test(ask), 'Archive asks in the page first (' + ask + ')');
  check((await page.$('dialog[open]')) === null, 'no browser dialog for it');
  await page.click(`${AP} button[data-act="archive-no"]`);
  check((await v3(PORT)).accounts.archived.length === 0 && (await page.$(`${AP} .apg-confirm`)) === null, 'Keep: nothing sent, the question goes');
  await page.click(`${AP} button[data-act="archive"][data-id="EVAL-B"]`);
  await page.click(`${AP} button[data-act="archive-yes"]`);
  await until(async () => (await v3(PORT)).accounts.archived.some(a => a.name === 'EVAL-B'), 'EVAL-B archived through ChartBridge');
  await until(async () => /Archived: EVAL-B/.test(await page.$eval(AP, e => e.textContent)) && !(await page.$(`${AP} [data-k="g|EVAL-B"]`)), 'EVAL-B out of every list, named under Archived');
  check(true, 'Archive after the confirm: accountArchive with confirm true; EVAL-B leaves the lists');
  // Positions
  await tab(page, 'pos');
  const pos = await rows(page, '.apg-pos-g');
  check(pos.some(r => r.k === 'EVAL-A|MNQ' && /\+2/.test(r.text)), 'Positions: EVAL-A long 2 MNQ (' + pos.map(r => r.text).join(' / ') + ')');
  // Working orders, Cancel (cancelFromList on)
  await tab(page, 'ord');
  const ord = await rows(page, '.apg-ord-g');
  check(ord.some(r => /FUNDED-C/.test(r.text) && /Buy limit/.test(r.text)) && ord.some(r => /EVAL-A/.test(r.text) && /Sell limit/.test(r.text)), 'Working orders: every account\'s (' + ord.map(r => r.text).join(' / ') + ')');
  const fcOrder = ord.find(r => /FUNDED-C/.test(r.text));
  check(await page.$(`${AP} button[data-act="cancel"]`) !== null, 'Cancel shows with cancelFromList on');
  await page.click(`${AP} button[data-act="cancel"][data-id="${fcOrder.k}"]`);
  await until(async () => !(await rows(page, '.apg-ord-g')).some(r => r.k === fcOrder.k), 'the FUNDED-C order cancelled from the list');
  check(true, 'Cancel from the Working orders tab: cancel with from "list"');
  // Today's trades: a Sim101 round trip in NinjaTrader (the fake's "elsewhere"), gross and net
  await control(PORT, 'elsewhere', { account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'market', qty: 2 });
  await wait(300);
  await control(PORT, 'elsewhere', { account: 'Sim101', root: 'MNQ', side: 'sell', kind: 'market', qty: 2 });
  await tab(page, 'trd');
  const trd = await until(async () => { const r = await rows(page, '.apg-trd-g'); return r.some(x => /Sim101/.test(x.k) && !/open/.test(x.text)) ? r : null; }, 'the Sim101 round trip');
  const heads = await page.$$eval(`${AP} .apg-gh`, els => els.map(e => e.textContent));
  const simHead = heads.find(t => /^Sim101/.test(t)) || '';
  check(/gross [+-]?\$[\d,.]+ · net [+-]?\$[\d,.]+/.test(simHead), 'Today\'s trades: Sim101 gross and net, net with The Desk\'s commission (' + simHead + ')');
  const tr = (trd || []).find(x => /Sim101/.test(x.k));
  check(tr && (tr.text.match(/\$/g) || []).length >= 2, 'a round trip row has gross and net in two columns (' + (tr && tr.text) + ')');
  check(await page.$eval(`${AP} .apg-trd-g .gr-row.apg-link`, e => /^\d{4}-\d\d-\d\d$/.test(e.dataset.review)).catch(() => false), 'each row opens The Desk\'s Review of its session');
  await page.click(`${AP} .apg-seg button[data-v="fills"]`);
  check((await rows(page, '.apg-fil-g')).length >= 2, 'the Fills view lists the day\'s fills');
  await page.screenshot({ path: path.join(out, 'accounts-2-trades.png') });
  // Copier
  await tab(page, 'cop');
  const cop = await rows(page, '.apg-cop-g');
  check(cop.some(r => /SIM-F1/.test(r.k)) && cop.some(r => /SIM-F2/.test(r.k)) && !cop.some(r => /EVAL-A|FUNDED-C|Sim101/.test(r.k)), 'Copier: a row per Sim follower, never a real account or the leader (' + cop.map(r => r.k).join(', ') + ')');
  check(/STOOD DOWN/.test(await page.$eval(`${AP} .apg-arm`, e => e.textContent)), 'the copier starts stood down');
  await page.click(`${AP} button[data-act="rearm"]`);
  await until(async () => (await v3(PORT)).copier.armed === true, 'Re-arm through ChartBridge');
  await until(async () => /ARMED/.test(await page.$eval(`${AP} .apg-arm`, e => e.textContent)) && !(await page.$(`${AP} button[data-act="rearm"]`)), 'ARMED, Re-arm gone');
  check(true, 'Re-arm after the stand-down');
  await page.selectOption(`${AP} [data-follower="SIM-F1"] select[data-act="f-qty"]`, '2');
  await until(async () => (await v3(PORT)).copier.followers.find(x => x.account === 'SIM-F1').qty === 2, 'SIM-F1 quantity 2 through copierFollower');
  check(true, 'a follower\'s quantity set from its dropdown');
  const ll = await page.$eval(`${AP} [data-follower="SIM-F1"] input[data-act="f-ll-on"]`, e => e.checked);
  check(ll === false, 'the daily loss option is off by default');
  await page.click(`${AP} [data-follower="SIM-F1"] input[data-act="f-ll-on"]`);
  await page.fill(`${AP} [data-follower="SIM-F1"] input[data-act="f-ll"]`, '400');
  await page.press(`${AP} [data-follower="SIM-F1"] input[data-act="f-ll"]`, 'Tab');
  await until(async () => (await v3(PORT)).copier.followers.find(x => x.account === 'SIM-F1').lossLimit === 400, 'SIM-F1 daily loss 400');
  check(true, 'a follower\'s daily loss limit: a flat dollar amount');
  await page.screenshot({ path: path.join(out, 'accounts-3-copier.png') });
  // Log
  await tab(page, 'log');
  const log = await page.$eval(`${AP} .apg-log`, e => e.textContent).catch(() => '');
  check(/EVAL-B: archived/.test(log) && /Copier: Re-armed by the page/.test(log), 'the Log: the archive and the copier\'s decisions (' + log.slice(0, 200) + ')');
  // the Quote board: NQ, ES, then the quote-only markets; ZN and ZB in 32nds
  const qb = await until(async () => { const r = await quoteRows(page); return r.length === 10 && r.every(x => x.last && x.last !== '-') ? r : null; }, 'the Quote board\'s 10 rows with prices');
  check(qb && qb.map(r => r.root).join() === 'NQ,ES,YM,RTY,GC,SI,CL,6E,ZN,ZB', 'Quote board rows: NQ, ES, then YM, RTY, GC, SI, CL, 6E, ZN, ZB (' + (qb || []).map(r => r.root).join() + ')');
  check(qb && qb.slice(2).every(r => /qb-q/.test(r.cls)) && qb.slice(0, 2).every(r => !/qb-q/.test(r.cls)), 'the quote-only rows are compact');
  const zn = (qb || []).find(r => r.root === 'ZN'), zb = (qb || []).find(r => r.root === 'ZB');
  check(zn && /^\d{2,3}'\d\d[05]$/.test(zn.last), 'ZN in 32nds with the half (' + (zn && zn.last) + ')');
  check(zb && /^\d{2,3}'\d\d$/.test(zb.last), 'ZB in 32nds (' + (zb && zb.last) + ')');
  check(zn && (zn.chg === '' || /^[+-]?\d+'\d\d[05]$/.test(zn.chg)), 'ZN\'s change in 32nds too (' + (zn && zn.chg) + ')');
  check(await page.$$eval('.ws-panel[data-id="tk"] [data-tk-id="root"] option', os => os.map(o => o.value).join()) === 'MNQ,NQ,MES,ES', 'no order control for a quote-only market (the ticket\'s instruments)');
  await page.screenshot({ path: path.join(out, 'accounts-4-quotes.png') });
  await ctx.close();

  /* ================================================================ 2. every switch off */
  console.log('every v3 switch off');
  await startBridge(OFF_PORT, ['--v3', '--v3-off=accountChecks,orderTypes,strategies,merge,cancelFromList,copier,bot', '--trading', '--test-controls', '--data-037', '--gone-grace-ms=1500', '--test-pin=' + TEST_PIN]);
  const ctx2 = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await ctx2.addInitScript(seed, [{ Acc: { panels: LAYOUT } }]);
  const p2 = await openWs(ctx2, OFF_PORT, 'Acc');
  const f2 = await until(() => p2.evaluate(() => { const f = window.workspace.accountFeed(); return f && f.enabled ? f : null; }), 'signed in (switches off)', 20000);
  check(f2 && Object.values(f2.switches).every(x => x === false), 'every switch named off');
  await until(async () => (await rows(p2, '.apg-acc-g')).length >= 4, 'the Accounts tab rows (read only)');
  await until(() => p2.$(`${AP} .apg-gone-g`), 'EVAL-B Gone', 8000);
  for (const t of ['acc', 'pos', 'ord', 'trd', 'log']) { await tab(p2, t); check(await controlsOnPage(p2) === 0, 'switches off: no new control on the ' + t + ' tab'); }
  check(await p2.$eval(`${AP} .ac-tab[data-tab="cop"]`, e => e.hidden), 'switches off: no Copier tab');
  await tab(p2, 'acc');
  const marks = await rows(p2, '.apg-acc-g');
  check(marks.some(r => r.k === 'Sim101' && /✓/.test(r.text)), 'the checkmark shows read only (gate 2 is tradeAccounts)');
  check(/read only \(accountChecks is off/.test(await p2.$eval(`${AP} .apg-foot`, e => e.textContent)), 'the foot says why');
  await tab(p2, 'ord');
  check((await rows(p2, '.apg-ord-g')).length >= 1 && !(await p2.$(`${AP} button[data-act="cancel"]`)), 'Working orders listed with no Cancel');
  await p2.screenshot({ path: path.join(out, 'accounts-5-switches-off.png') });
  await ctx2.close();

  /* ================================================================ 3. ChartBridge 0.3.8: no v3 */
  console.log('ChartBridge 0.3.8 (no v3)');
  await startBridge(OLD_PORT, ['--trading', '--test-controls', '--data-037', '--version=0.3.8', '--test-pin=' + TEST_PIN]);
  const ctx3 = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await ctx3.addInitScript(seed, [{ Acc: { panels: LAYOUT } }]);
  const p3 = await openWs(ctx3, OLD_PORT, 'Acc');
  await until(async () => /needs ChartBridge 0\.4\.0 or newer/.test(await p3.$eval(AP, e => e.textContent)), 'the Account page says it needs 0.4.0');
  const f3 = await p3.evaluate(() => window.workspace.accountFeed());
  check(f3 && f3.v3 === false && f3.open === false, 'no connection of its own with an older ChartBridge');
  const recv = await control(OLD_PORT, 'received');
  check(!recv.types.client, 'no client message sent to an older ChartBridge');
  const q3 = await quoteRows(p3);
  check(q3.map(r => r.root).join() === 'NQ,ES', 'the Quote board: NQ and ES only');
  await ctx3.close();
} catch (e) {
  fail('smoke threw: ' + (e && e.stack || e));
} finally {
  await browser.close();
  for (const b of bridges) b.kill();
}
console.log(errors.length ? `\n${errors.length} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(errors.length ? 1 : 0);
