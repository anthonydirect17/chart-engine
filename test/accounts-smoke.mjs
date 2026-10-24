// Smoke for the Account page and the Quote board's quote-only markets (chart 1.16.0, live/accounts.js; Anthony's spec,
// chart page section 1, items 14, 15 and 20) against the fake bridge's protocol v3 (test/fake-bridge.mjs --v3). Sample data
// and made-up accounts only (Sim101, EVAL-A, EVAL-B, FUNDED-C, SIM-F1, SIM-F2); The Desk's GET /api/chart-accounts is
// answered by the test (a made-up firm's limits and commission).
//
//   1. every switch on: the Accounts tab with the checkmarks (one checked from the page), EVAL-B Gone after the grace and
//      hidden through the in-page confirm (Keep first), shown again from the Hidden list and hidden again; Hide on an active
//      account once flat (FUNDED-C) and Show (ChartBridge 0.5.1); no Hide on the bot's account or a follower, FUNDED-C amber from The Desk's trailing drawdown and the chart's
//      warning on it, Positions, Working orders with Cancel, Today's trades (gross and net), the Copier tab (Re-arm, a
//      follower's quantity), the Log; the Quote board's rows NQ, ES, then YM to ZB with ZN and ZB in 32nds
//   2. every off line written (--v3-off=...; the switches are on by default since 2026-10-07): no checkbox, no Hide or Show, no Cancel, no Copier tab, no box or list at all on the page
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
  { id: 'ma', type: 'multi', x: 3, y: 3, w: 3, h: 3 },   // 1.37.0: the copier is the Multi-Account panel's Copier tab
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
/* 1.35.0: The Desk's floors (made-up numbers, sample data): EVAL-A's, one ChartBridge does not list, and The Desk's own skip */
const FLOORS = { accounts: [
  { account: 'EVAL-A', prop: 'Sample 50K', floor: 49600, source: 'the firm dashboard on 2026-10-13, then 2 tracked round trips (sample)', note: null },
  { account: 'NOPE-X', prop: 'NOPE-X', floor: 48000, source: 'sample' }],
  skipped: [{ account: null, prop: 'Sample 150K', why: 'not linked to a fills account on The Desk\'s Prop screen' }] };
async function openWs(ctx, port, layout) {
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));
  await page.route('http://localhost:8800/api/chart-accounts', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': 'http://localhost:' + port }, body: JSON.stringify(DESK) }));
  await page.route('http://localhost:8800/api/chart-floors', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': 'http://localhost:' + port }, body: JSON.stringify(FLOORS) }));
  await page.goto(`http://localhost:${port}/live/?layout=${layout}`);
  await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
  await enterPin(page, TEST_PIN);
  await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 40000 });
  return page;
}
const AP = '.ws-panel[data-id="ap"]';
const MAC = '.ws-panel[data-id="ma"] .ma-cop';   // 1.37.0: the copier, on the Multi-Account panel
const tab = async (page, id) => { await page.click(`${AP} .ac-tab[data-tab="${id}"]`); await wait(150); };
const rows = (page, sel) => page.$$eval(`${AP} ${sel} .gr-row:not(.gr-h)`, els => els.map(e => ({ k: e.dataset.k, text: e.textContent, cls: e.className })));
const quoteRows = page => page.$$eval('.ws-panel[data-id="qb"] [data-root]', els => els.map(e => ({ root: e.dataset.root, cls: e.className, last: e.querySelector('[data-q="last"]').textContent, chg: e.querySelector('[data-q="chg"]').textContent })));
/* 1.26.0: the Group dropdown and My floor and My daily have no config switch (ChartBridge 0.5.8 has none for groups): not counted here */
const controlsOnPage = page => page.$$eval(`${AP} .ac-list input:not([data-act^="my-"]):not([data-act="label"]), ${AP} .ac-list select:not(.apg-grp), ${AP} .ac-list button[data-act="archive"], ${AP} .ac-list button[data-act="unarchive"], ${AP} .ac-list button[data-act="cancel"], ${AP} .ac-list button[data-act="rearm"], ${AP} .ac-list button[data-act="mode"]`, els => els.length);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  await startBridge(PORT, ['--v3', '--trading', '--test-controls', '--data-037', '--gone-grace-ms=1500', '--max-qty=MNQ:9,NQ:4', '--test-pin=' + TEST_PIN]);
  /* ================================================================ 1. every switch on */
  console.log('every v3 switch on');
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } }).then(async c => { await c.addInitScript(() => { try { if (!localStorage.getItem('live-acc-open-v1')) localStorage.setItem('live-acc-open-v1', JSON.stringify({ sim: true, all: true })); } catch (e) { /* none */ } }); return c; });
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
  // Gone and Hide (the in-page confirm), then Show (ChartBridge 0.5.1)
  await until(() => page.$(`${AP} .apg-gone-g [data-k="g|EVAL-B"]`), 'EVAL-B in the Gone list after the grace', 8000);
  check(!(await rows(page, '.apg-acc-g')).some(r => r.k === 'EVAL-B'), 'a Gone account leaves the active rows');
  const hideButtons = await page.$$eval(`${AP} .apg-acc-g button[data-act="archive"]`, els => els.map(e => e.dataset.id).sort());
  const canHide = (await v3(PORT)).accounts.list.filter(a => a.state === 'active' && a.canHide).map(a => a.name).sort();
  check(hideButtons.join() === canHide.join() && !hideButtons.includes('Sim101') && !hideButtons.includes('EVAL-A') && !hideButtons.includes('SIM-F1'), 'Hide shows only on an active account ChartBridge says may be hidden: not the bot\'s Sim101, a copier follower or one with a position or working order (' + (hideButtons.join(', ') || 'none') + ')');
  await page.click(`${AP} button[data-act="archive"][data-id="EVAL-B"]`);
  const ask = await page.$eval(`${AP} .apg-confirm`, e => e.textContent).catch(() => '');
  check(/Hide EVAL-B\? It leaves every list until you Show it; its history stays\./.test(ask), 'Hide asks in the page first (' + ask + ')');
  check((await page.$('dialog[open]')) === null, 'no browser dialog for it');
  await page.click(`${AP} button[data-act="archive-no"]`);
  check((await v3(PORT)).accounts.archived.length === 0 && (await page.$(`${AP} .apg-confirm`)) === null, 'Keep: nothing sent, the question goes');
  await page.click(`${AP} button[data-act="archive"][data-id="EVAL-B"]`);
  await page.click(`${AP} button[data-act="archive-yes"]`);
  await until(async () => (await v3(PORT)).accounts.archived.some(a => a.name === 'EVAL-B'), 'EVAL-B archived through ChartBridge');
  await until(async () => (await page.$(`${AP} .apg-arch-g [data-k="a|EVAL-B"] button[data-act="unarchive"]`)) && !(await page.$(`${AP} [data-k="g|EVAL-B"]`)), 'EVAL-B out of every list, under Hidden with a Show button');
  check(true, 'Hide after the confirm: accountArchive with confirm true; EVAL-B leaves the lists');
  await page.screenshot({ path: path.join(out, 'accounts-1b-hidden.png') });
  await page.click(`${AP} button[data-act="unarchive"][data-id="EVAL-B"]`);
  await until(async () => { const a = (await v3(PORT)).accounts; return !a.archived.length && a.list.some(x => x.name === 'EVAL-B' && x.trade === false); }, 'Show: EVAL-B back through ChartBridge, unchecked');
  await until(async () => !(await page.$(`${AP} .apg-arch-g`)) && (await page.$(`${AP} [data-k="g|EVAL-B"], ${AP} .apg-acc-g [data-k="EVAL-B"]`)), 'Show: EVAL-B listed again, the Hidden list gone');
  check(true, 'Show: accountUnarchive; EVAL-B back in the list, unchecked');
  await until(() => page.$(`${AP} .apg-gone-g button[data-act="archive"][data-id="EVAL-B"]`), 'EVAL-B Gone again (still disconnected)', 8000);
  await page.click(`${AP} button[data-act="archive"][data-id="EVAL-B"]`);
  await page.click(`${AP} button[data-act="archive-yes"]`);
  await until(async () => (await v3(PORT)).accounts.archived.some(a => a.name === 'EVAL-B'), 'EVAL-B hidden again');
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
  await tab(page, 'acc');
  // Hide on an active, connected account now flat (its order cancelled), then Show; checked again after
  await page.click(`${AP} .apg-acc-g button[data-act="archive"][data-id="FUNDED-C"]`);
  const ask2 = await page.$eval(`${AP} .apg-acc-g .apg-confirm`, e => e.textContent).catch(() => '');
  check(/Hide FUNDED-C\? It leaves every list until you Show it/.test(ask2), 'Hide on an active row asks in the page first (' + ask2 + ')');
  await page.click(`${AP} .apg-acc-g button[data-act="archive-yes"]`);
  await until(async () => (await v3(PORT)).accounts.archived.some(a => a.name === 'FUNDED-C') && !(await rows(page, '.apg-acc-g')).some(r => r.k === 'FUNDED-C'), 'FUNDED-C hidden: out of the active rows');
  await page.click(`${AP} button[data-act="unarchive"][data-id="FUNDED-C"]`);
  await until(async () => (await rows(page, '.apg-acc-g')).some(r => r.k === 'FUNDED-C') && !(await page.$(`${AP} [data-k="a|FUNDED-C"]`)), 'FUNDED-C shown: back in the active rows');
  check(!(await page.$eval(`${AP} input[data-act="trade"][data-id="FUNDED-C"]`, e => e.checked)), 'Show brings FUNDED-C back unchecked');
  await page.click(`${AP} input[data-act="trade"][data-id="FUNDED-C"]`);
  await until(async () => (await v3(PORT)).accounts.list.find(a => a.name === 'FUNDED-C').trade === true, 'FUNDED-C checked again');
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
  // Copier (1.37.0: the Multi-Account panel's Copier tab, exactly as the Account page had it; the Account page has none)
  check(!(await page.$(`${AP} .ac-tab[data-tab="cop"]`)), '1.37.0: the Account page has no Copier tab');
  await page.click('.ws-panel[data-id="ma"] .ma-tabs [data-tab="copier"]');
  await until(() => page.$(`${MAC} .apg-cop-g`), 'the copier in the Multi-Account panel');
  const cop = await page.$$eval(`${MAC} .apg-cop-g .gr-row:not(.gr-h)`, els => els.map(e => ({ k: e.dataset.k, text: e.textContent, cls: e.className })));
  check(cop.map(r => r.k).join() === 'f|EVAL-A|LIVE|,f|FUNDED-C|LIVE|,f|SIM-F1|SIM|s,f|SIM-F2|SIM|s', 'Copier (Anthony 2026-10-07: no Sim lock): a row per account but the leader, Sim or LIVE (' + cop.map(r => r.k).join(', ') + ')');
  /* 1.34.0: a saved follower row also carries a "follower" mark (counted apart) */
  const fmarks = await page.$$eval(`${MAC} .apg-cop-g .apg-fmark`, els => els.length);
  check(fmarks === 2, '1.34.0: the two saved followers (SIM-F1, SIM-F2) are marked "follower": ' + fmarks);
  const marks0 = await page.$$eval(`${MAC} .apg-cop-g .apg-mark:not(.apg-fmark)`, els => els.map(e => e.textContent + (e.classList.contains('live') ? ':' + getComputedStyle(e).backgroundColor : '')));
  check(marks0.join() === 'LIVE:rgb(201, 165, 92),LIVE:rgb(201, 165, 92),SIM,SIM', 'each follower marked SIM or LIVE, LIVE in the house gold (1.39.0, V2; crimson before): ' + marks0.join(', '));
  check(/Sim or LIVE followers/.test(await page.$eval(`${MAC} .apg-sim`, e => e.textContent)), 'the Copier tab no longer says Sim accounts only');
  check(!(await page.$eval(`${MAC} [data-follower="EVAL-A"] input[data-act="f-on"]`, e => e.disabled)), 'a LIVE account can be turned on as a follower');
  check(/STOOD DOWN/.test(await page.$eval(`${MAC} .apg-arm`, e => e.textContent)), 'the copier starts stood down');
  await page.click(`${MAC} button[data-act="rearm"]`);
  await until(async () => (await v3(PORT)).copier.armed === true, 'Re-arm through ChartBridge');
  await until(async () => /ARMED/.test(await page.$eval(`${MAC} .apg-arm`, e => e.textContent)) && !(await page.$(`${MAC} button[data-act="rearm"]`)), 'ARMED, Re-arm gone');
  check(true, 'Re-arm after the stand-down');
  await page.selectOption(`${MAC} [data-follower="SIM-F1"] select[data-act="f-qty"]`, '2');
  await until(async () => (await v3(PORT)).copier.followers.find(x => x.account === 'SIM-F1').qty === 2, 'SIM-F1 quantity 2 through copierFollower');
  check(true, 'a follower\'s quantity set from its dropdown');
  const ll = await page.$eval(`${MAC} [data-follower="SIM-F1"] input[data-act="f-ll-on"]`, e => e.checked);
  check(ll === false, 'the daily loss option is off by default');
  await page.click(`${MAC} [data-follower="SIM-F1"] input[data-act="f-ll-on"]`);
  await page.fill(`${MAC} [data-follower="SIM-F1"] input[data-act="f-ll"]`, '400');
  await page.press(`${MAC} [data-follower="SIM-F1"] input[data-act="f-ll"]`, 'Tab');
  await until(async () => (await v3(PORT)).copier.followers.find(x => x.account === 'SIM-F1').lossLimit === 400, 'SIM-F1 daily loss 400');
  check(true, 'a follower\'s daily loss limit: a flat dollar amount');
  await page.click(`${MAC} [data-follower="EVAL-A"] input[data-act="f-on"]`);
  await until(async () => { const f = (await v3(PORT)).copier.followers.find(x => x.account === 'EVAL-A'); return f && f.on === true && f.sim === false; }, 'EVAL-A (LIVE) on as a follower through copierFollower');
  check(true, 'a LIVE follower turned on from its checkbox (ChartBridge\'s gates decide each copy)');
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
  const ctx2 = await browser.newContext({ viewport: { width: 1600, height: 900 } }).then(async c => { await c.addInitScript(() => { try { if (!localStorage.getItem('live-acc-open-v1')) localStorage.setItem('live-acc-open-v1', JSON.stringify({ sim: true, all: true })); } catch (e) { /* none */ } }); return c; });
  await ctx2.addInitScript(seed, [{ Acc: { panels: LAYOUT } }]);
  const p2 = await openWs(ctx2, OFF_PORT, 'Acc');
  const f2 = await until(() => p2.evaluate(() => { const f = window.workspace.accountFeed(); return f && f.enabled ? f : null; }), 'signed in (switches off)', 20000);
  check(f2 && Object.values(f2.switches).every(x => x === false), 'every switch named off');
  await until(async () => (await rows(p2, '.apg-acc-g')).length >= 4, 'the Accounts tab rows (read only)');
  await until(() => p2.$(`${AP} .apg-gone-g`), 'EVAL-B Gone', 8000);
  for (const t of ['acc', 'pos', 'ord', 'trd', 'log']) { await tab(p2, t); check(await controlsOnPage(p2) === 0, 'switches off: no new control on the ' + t + ' tab'); }
  check(!(await p2.$(`${AP} .ac-tab[data-tab="cop"]`)), 'switches off: no Copier tab (1.37.0: none on the Account page at all)');
  await p2.click('.ws-panel[data-id="ma"] .ma-tabs [data-tab="copier"]');
  check(/The copier is off: config\.txt has copier = false/.test(await until(() => p2.$eval(`${MAC}`, e => e.textContent), 'the Copier tab with the copier off') || '') && !(await p2.$(`${MAC} input, ${MAC} select`)), 'switches off: the Multi-Account panel\'s Copier tab says the copier is off, with no control');
  await tab(p2, 'acc');
  const marks = await rows(p2, '.apg-acc-g');
  check(marks.some(r => r.k === 'Sim101' && /✓/.test(r.text)), 'the checkmark shows read only (gate 2 is tradeAccounts)');
  check(/read only \(accountChecks = off in config\.txt/.test(await p2.$eval(`${AP} .apg-foot`, e => e.textContent)), 'the foot says why');
  await tab(p2, 'ord');
  check((await rows(p2, '.apg-ord-g')).length >= 1 && !(await p2.$(`${AP} button[data-act="cancel"]`)), 'Working orders listed with no Cancel');
  await p2.screenshot({ path: path.join(out, 'accounts-5-switches-off.png') });
  await ctx2.close();

  /* ================================================================ 4. ChartBridge 0.5.8: groups (1.26.0, Anthony 2026-10-14) */
  {   // a block of its own: its names never meet the sections above
  console.log('ChartBridge 0.5.8: groups, at 1366 x 768');
  const GP_PORT = PORT + 3;
  await startBridge(GP_PORT, ['--v3', '--trading', '--test-controls', '--data-037', '--groups', '--test-pin=' + TEST_PIN]);
  const ctx4 = await browser.newContext({ viewport: { width: 1366, height: 768 } }).then(async c => { await c.addInitScript(() => { try { if (!localStorage.getItem('live-acc-open-v1')) localStorage.setItem('live-acc-open-v1', JSON.stringify({ sim: true, all: true })); } catch (e) { /* none */ } }); return c; });
  await ctx4.addInitScript(seed, [{ Acc: { panels: [{ id: 'ap', type: 'accounts', x: 0, y: 0, w: 12, h: 6 }] } }]);
  const p4 = await openWs(ctx4, GP_PORT, 'Acc');
  await until(async () => (await p4.$$(`${AP} select.apg-grp`)).length >= 3, 'the Group dropdowns');
  const heads4 = await p4.$$eval(`${AP} .apg-acc-g .gr-h [role="columnheader"]`, els => els.map(e => e.textContent));
  /* 1.34.0: Group on the row; the dropdown, type and Limits in each account's drawer (open here: "Settings for every account") */
  const dl4 = await p4.$$eval(`${AP} .apg-acc-g .apg-dlbl`, els => [...new Set(els.map(e => e.textContent))]);
  check(heads4.includes('Group') && dl4.includes('Group') && dl4.includes('Limits'), 'the Accounts tab gets Group, and the drawer Group and Limits (' + heads4.join(', ') + ' / ' + dl4.join(', ') + ')');
  const grp = await p4.$eval(`${AP} select.apg-grp[data-id="EVAL-A"]`, e => ({ v: e.value, opts: [...e.options].map(o => o.textContent) }));
  check(grp.v === 'g1' && grp.opts.join() === 'None,Lucid,Apex', 'EVAL-A in Lucid; the dropdown offers None and every group (' + JSON.stringify(grp) + ')');
  /* 1.34.0: the row shows the tightest room in whole dollars with a bar; its tooltip every room (daily, floor, target) */
  const roomA = await p4.$eval(`${AP} .gr-row[data-k="EVAL-A"] .apg-rtext`, e => ({ text: e.textContent, tip: e.title }));
  check(/^\$[\d,]+ (daily|to floor)$/.test(roomA.text) && /daily · .* to floor · .* to target/.test(roomA.tip), 'the room from ChartBridge\'s own numbers: the tightest on the row, daily, to floor, to target in its tooltip (' + JSON.stringify(roomA) + ')');
  check(!!(await p4.$(`${AP} .gr-row[data-k="EVAL-A"] .apg-track .apg-bar`)), '1.34.0: a bar of the room used under it');
  check(await p4.$(`${AP} .gr-row[data-k="dr|Sim101"] input[data-act="my-floor"]`) !== null && await p4.$(`${AP} .gr-row[data-k="dr|EVAL-A"] input[data-act="my-floor"]`) === null, 'My floor and My daily only for an account in no group (in its drawer)');
  // G2 (b): putting SIM-F1 in Lucid asks for its highest close once, prefilled
  await p4.selectOption(`${AP} select.apg-grp[data-id="SIM-F1"]`, 'g1');
  const ask = await until(() => p4.$(`${AP} .apg-join`), 'the highest close question');
  const pre = ask ? await p4.$eval(`${AP} [data-act="join-high"]`, e => e.value) : '';
  check(pre === '50000', 'the highest close so far, prefilled with the larger of the size and the balance (' + pre + ')');
  await p4.screenshot({ path: path.join(out, 'accounts-6-groups-1366.png') });
  await p4.fill(`${AP} [data-act="join-high"]`, '50500');
  await p4.click(`${AP} [data-act="join-yes"]`);
  await until(async () => (await p4.$eval(`${AP} select.apg-grp[data-id="SIM-F1"]`, e => e.value)) === 'g1', 'SIM-F1 in Lucid');
  const r4 = await control(GP_PORT, 'received');
  check(r4.types.accountGroup === 1, 'one accountGroup sent');
  // My floor on a personal account
  await p4.fill(`${AP} input[data-act="my-floor"][data-id="Sim101"]`, '95000');
  await p4.press(`${AP} input[data-act="my-floor"][data-id="Sim101"]`, 'Enter');
  await p4.click(`${AP} .apg-foot`);
  await until(async () => /to floor/.test(await p4.$eval(`${AP} .gr-row[data-k="Sim101"] .apg-room`, e => e.textContent)), 'Sim101\'s room to its own floor');
  // 1.37.0: Settings has no Account groups (1.26.0 to 1.36.0): a group is made, set and deleted on the Multi-Account panel (smoke:multi-account)
  await p4.click('#wsSet');
  check(!(await p4.$('#wsGroupsSec')) && !(await p4.$('#wsGroups')), 'Settings has no Account groups section (the Multi-Account panel has them)');
  /* 1.31.0 (audit C6): ChartBridge drops: the rows stay, dimmed, as of the drop; Conn unknown; the group columns stay */
  await p4.keyboard.press('Escape');   // Settings closed again
  const gpBridge = bridges[bridges.length - 1];
  gpBridge.kill();
  await until(() => p4.$(`${AP} .apg-acc-g.apg-stale`), 'the Accounts rows marked stale after the drop');
  const st = await p4.evaluate(ap => {
    const q = s => document.querySelector(ap + ' ' + s);
    const heads = [...document.querySelectorAll(ap + ' .apg-acc-g .gr-h [role="columnheader"]')].map(e => e.textContent);
    const row = q('.gr-row[data-k="EVAL-A"]'), cells = row ? [...row.querySelectorAll('[role="cell"]')].map(e => e.textContent) : [];
    const dr = q('.gr-row[data-k="dr|EVAL-A"]');
    return { heads, cells, drawer: dr ? dr.textContent : '', unk: !!(row && row.querySelector('.apg-dot.unk')), note: (q('.apg-stalenote') || {}).textContent || '', foot: (q('.apg-foot') || {}).textContent || '', op: row ? getComputedStyle(row).opacity : '' };
  }, AP);
  check(st.heads.includes('Group') && st.cells.includes('not known') && (st.drawer.match(/not known \(not connected\)/g) || []).length >= 2,
    'after the drop the Group column stays ("not known"), and the drawer\'s Group and Limits say "not known (not connected)" (' + JSON.stringify(st.cells) + ' / ' + st.drawer + ')');
  check(st.unk && +st.op < 0.9, '1.34.0: the connection dot says not known and the row is dimmed (opacity ' + st.op + ')');
  check(/^As of \d\d:\d\d:\d\d ET \(not connected\)/.test(st.note) && /As of \d\d:\d\d:\d\d ET \(not connected\): ChartBridge's last balances, positions and orders, not current\./.test(st.foot),
    'the note and the footer say as of when, not connected (' + st.foot + ')');
  await p4.screenshot({ path: path.join(out, 'accounts-9-dropped-1366.png') });
  await ctx4.close();
  }

  /* ================================================================ 5. 1.34.0 (Anthony 2026-10-20): the clean Accounts tab, with
     ChartBridge 0.6.6 (the firm's minimum seeds the floor; NinjaTrader's own figure beside the room). A fresh browser: nothing
     folded open, as Anthony first sees it */
  {
  console.log('1.34.0: the clean Accounts tab, ChartBridge 0.6.6, at 1366 x 768');
  const CL_PORT = PORT + 4;
  await startBridge(CL_PORT, ['--v3', '--trading', '--test-controls', '--data-037', '--groups', '--firm-floor', '--version=0.6.6', '--test-pin=' + TEST_PIN]);
  const ctx5 = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx5.addInitScript(seed, [{ Acc: { panels: [{ id: 'ap', type: 'accounts', x: 0, y: 0, w: 12, h: 6 }] } }]);
  const p5 = await openWs(ctx5, CL_PORT, 'Acc');
  await until(async () => (await rows(p5, '.apg-acc-g')).some(r => r.k === 'EVAL-A'), 'the Accounts rows');
  const heads5 = await p5.$$eval(`${AP} .apg-acc-g .gr-h [role="columnheader"]`, els => els.map(e => e.textContent));
  check(heads5.join('|') === 'Account|Balance|Today|Position|Room|Group|Trade|', 'the row\'s columns: Account, Balance, Today, Position, Room, Group, Trade and ⋯ (no Conn; Position kept): ' + heads5.join(', '));
  const r5 = await rows(p5, '.apg-acc-g');
  check(r5.some(r => r.k === 'sec|g|g1') && r5.some(r => r.k === 'sec|sim') && !r5.some(r => r.k === 'Sim101'), 'rows by group, then the Sim accounts, folded (' + r5.map(r => r.k).join(', ') + ')');
  const inRows = await p5.$$eval(`${AP} .apg-acc-g .gr-row.apg-acc`, els => els.map(e => e.querySelectorAll('select, input:not([data-act="trade"]), button:not([data-act="drawer"])').length));
  check(inRows.length > 0 && inRows.every(n => n === 0), 'no select, box or button on a row but Trade and ⋯ (the settings are in the drawer)');
  await p5.click(`${AP} button[data-act="sim-toggle"]`);
  await until(async () => (await rows(p5, '.apg-acc-g')).some(r => r.k === 'Sim101'), 'Show: the Sim accounts');
  await p5.screenshot({ path: path.join(out, 'accounts-10-clean-1366.png') });
  // the drawer
  await p5.click(`${AP} button[data-act="drawer"][data-id="EVAL-A"]`);
  const dr = await until(() => p5.$eval(`${AP} .gr-row[data-k="dr|EVAL-A"]`, e => [...e.querySelectorAll('.apg-dlbl')].map(x => x.textContent)), 'EVAL-A\'s drawer');
  check(dr && ['Group', 'Limits', 'Firm minimum', 'Label'].every(x => dr.includes(x)) && !!(await p5.$(`${AP} .gr-row[data-k="dr|EVAL-A"] select.apg-grp`)), 'the drawer: Group (its dropdown), Limits, Firm minimum, Label: ' + JSON.stringify(dr));
  check((await p5.$$(`${AP} .apg-drawerrow`)).length === 1, 'one drawer open at a time');
  // a label, kept in this browser
  await p5.fill(`${AP} input[data-act="label"][data-id="EVAL-A"]`, 'e50');
  await p5.press(`${AP} input[data-act="label"][data-id="EVAL-A"]`, 'Enter');
  await p5.click(`${AP} .apg-foot`);
  const lab = await until(async () => { const x = await p5.$eval(`${AP} .gr-row[data-k="EVAL-A"] .apg-name .b`, e => ({ t: e.textContent, tip: e.title })); return x.t === 'e50' ? x : null; }, 'EVAL-A shown as e50');
  check(lab && /^EVAL-A/.test(lab.tip), 'the label on the row, the full name in its tooltip: ' + JSON.stringify(lab));
  // NinjaTrader's own figure differs from the computed room: the amber flag says so
  await control(CL_PORT, 'nt-room', { account: 'EVAL-A', v: '1885.5' });
  const flag = await until(() => p5.$eval(`${AP} .gr-row[data-k="EVAL-A"] .apg-flag:not(.off)`, e => e.title).catch(() => null), 'EVAL-A\'s flag');
  check(/NinjaTrader shows \$1,886 to the floor, ChartBridge \$[\d,]+ \(from the firm's rules\)/.test(flag || ''), 'an amber flag when NinjaTrader\'s figure differs, its words in the tooltip: ' + flag);
  // the firm's minimum seeds the floor
  const before = await control(CL_PORT, 'received');
  await p5.fill(`${AP} input[data-act="firm-min"][data-id="EVAL-A"]`, '49500');
  await p5.click(`${AP} button[data-act="firm-min-set"][data-id="EVAL-A"]`);
  const fl = await until(async () => { const a = (await v3(CL_PORT)).accounts.list.find(x => x.name === 'EVAL-A'); return a && a.floor === 49500 ? a : null; }, 'EVAL-A\'s floor from the firm\'s minimum');
  check(!!fl && fl.src.roomFloor === 'computed', 'firmMinimum: ChartBridge\'s floor is the firm\'s 49,500, the room computed from it (' + JSON.stringify(fl && { floor: fl.floor, roomFloor: fl.roomFloor, nt: fl.roomFloorNt }) + ')');
  const after = await control(CL_PORT, 'received');
  check((after.types.firmMinimum || 0) === (before.types.firmMinimum || 0) + 1, 'one firmMinimum sent');
  /* 1.35.0 (G): once the firm minimum is set, NinjaTrader's figure (it never locks) is no flag; it stays in the Room's hover */
  const gone = await until(async () => { const t = await p5.$eval(`${AP} .gr-row[data-k="EVAL-A"] .apg-flag`, e => e.title).catch(() => ''); return !/NinjaTrader shows/.test(t) ? 'gone' : null; }, 'the NinjaTrader flag goes once the minimum is set', 8000);
  check(gone === 'gone', '1.35.0: no "NinjaTrader shows X to the floor" flag once the firm minimum is set');
  const roomHover = await p5.$eval(`${AP} .gr-row[data-k="EVAL-A"] .apg-rtext`, e => e.title);
  check(/NinjaTrader shows \$1,885\.50 to the floor \(its own trailing figure, which never locks\); the firm minimum \$49,500\.00 was set from this page/.test(roomHover), 'NinjaTrader\'s figure stays in the Room\'s hover: ' + roomHover.split('\n').pop());
  /* 1.35.0 (C): Update floors from The Desk: shown first, nothing sent until Send, then ChartBridge's own firmMinimum */
  const before2 = await control(CL_PORT, 'received');
  await p5.click(`${AP} button[data-act="floors-desk"]`);
  const fpanel = await until(() => p5.$eval(`${AP} .apg-floors`, e => /Send 1 floor to ChartBridge/.test(e.textContent) ? e.textContent : null).catch(() => null), 'the floors from The Desk');
  check(!!fpanel && /e50 EVAL-A · The Desk: Sample 50K: floor \$49,600\.00 ChartBridge now \$49,500\.00/.test(fpanel), 'each floor as The Desk has it, beside ChartBridge\'s: ' + fpanel);
  check(/NOPE-X: skipped, ChartBridge does not list it on this PC/.test(fpanel) && /Sample 150K: skipped, not linked to a fills account/.test(fpanel), 'every skip says why');
  await p5.screenshot({ path: path.join(out, 'accounts-12-floors-desk-1366.png') });
  check(((await control(CL_PORT, 'received')).types.firmMinimum || 0) === (before2.types.firmMinimum || 0), 'nothing sent before the confirm');
  await p5.click(`${AP} button[data-act="floors-send"]`);
  const fl2 = await until(async () => { const a = (await v3(CL_PORT)).accounts.list.find(x => x.name === 'EVAL-A'); return a && a.floor === 49600 ? a : null; }, 'EVAL-A\'s floor from The Desk');
  check(!!fl2, 'Send: ChartBridge\'s floor is The Desk\'s 49,600');
  check(((await control(CL_PORT, 'received')).types.firmMinimum || 0) === (before2.types.firmMinimum || 0) + 1, 'one firmMinimum for the one account');
  const setRow = await until(() => p5.$eval(`${AP} .apg-floors`, e => /\(sample\) set/.test(e.textContent) && /Read again/.test(e.textContent) ? e.textContent : null).catch(() => null), 'the row says set', 8000);
  check(!!setRow, 'the row says set, and Read again repeats it' + (setRow ? '' : ': ' + await p5.$eval(`${AP} .apg-floors`, e => e.textContent).catch(() => 'no panel')));
  await p5.screenshot({ path: path.join(out, 'accounts-13-floors-sent-1366.png') });
  await p5.click(`${AP} button[data-act="floors-close"]`);
  // column widths: drag the Account column 80 px wider; kept after a reload; a double-click gives its default back
  const wOf = () => p5.$eval(`${AP} .apg-acc-g .gr-h [role="columnheader"]:nth-child(1)`, e => Math.round(e.getBoundingClientRect().width));
  // the list re-renders as the firm minimum's accounts come back: the handle is read once it is laid out
  const hb = await until(() => p5.$eval(`${AP} .apg-rs[data-col="0"]`, e => { const r = e.getBoundingClientRect(); return r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; }).catch(() => null), 'the Account column\'s edge laid out');
  const w0 = await until(async () => (await wOf()) || null, 'the Account column laid out');
  await p5.mouse.move(hb.x, hb.y); await p5.mouse.down(); await p5.mouse.move(hb.x + 40, hb.y, { steps: 4 }); await p5.mouse.move(hb.x + 80, hb.y, { steps: 4 }); await p5.mouse.up();
  const w1 = await until(async () => { const w = await wOf(); return Math.abs(w - (w0 + 80)) <= 3 ? w : null; }, 'the Account column 80 px wider');
  check(w1 !== null, 'a column dragged wider at its header\'s edge: ' + w0 + ' to ' + w1 + ' px');
  await p5.reload();
  await p5.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p5, TEST_PIN);
  await until(async () => (await rows(p5, '.apg-acc-g')).some(r => r.k === 'EVAL-A'), 'the rows after a reload');
  const w2 = await wOf();
  check(Math.abs(w2 - w1) <= 3 && (await p5.$eval(`${AP} .gr-row[data-k="EVAL-A"] .apg-name .b`, e => e.textContent)) === 'e50' && (await rows(p5, '.apg-acc-g')).some(r => r.k === 'Sim101'),
    'after a reload: the width, the label and the open Sim section kept in this browser (' + w2 + ' px)');
  await p5.dblclick(`${AP} .apg-rs[data-col="0"]`);
  const w3 = await until(async () => { const w = await wOf(); return Math.abs(w - w0) <= 3 ? w : null; }, 'the default width again');
  check(w3 !== null, 'a double-click on the edge: the default width again (' + w3 + ' px)');
  check(await p5.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll at 1366');
  await p5.screenshot({ path: path.join(out, 'accounts-11-clean-drawer-1366.png') });
  await ctx5.close();
  }

  /* ================================================================ 3. ChartBridge 0.3.8: no v3 */
  console.log('ChartBridge 0.3.8 (no v3)');
  await startBridge(OLD_PORT, ['--trading', '--test-controls', '--data-037', '--version=0.3.8', '--test-pin=' + TEST_PIN]);
  const ctx3 = await browser.newContext({ viewport: { width: 1600, height: 900 } }).then(async c => { await c.addInitScript(() => { try { if (!localStorage.getItem('live-acc-open-v1')) localStorage.setItem('live-acc-open-v1', JSON.stringify({ sim: true, all: true })); } catch (e) { /* none */ } }); return c; });
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
