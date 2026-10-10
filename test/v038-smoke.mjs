// Chart 1.16.0 against a ChartBridge without protocol v3 (0.3.8 behaviour: hello lists no "v3"), in Chromium, with the
// fake bridge (trading on, sample data, made-up accounts; nothing reaches a broker). The lead's rule: with every 0.4.0 part
// off, the ticket and every order surface behave as chart 1.15.0 with ChartBridge 0.3.8.
//   Part A: no new control anywhere (no Bot tab, strip or ghost choice; no Strategy picker, Merge button, managed or Merge
//     line on the ticket; no Desk, Strategies or entry-type section and no Merge, Accept or Reject key in Settings; the
//     Account page says it needs 0.4.0), no extra connection (one per instrument and the ticket's), not one v3 message on
//     any connection (no client, no account, copier or bot message, no merge, no cancel from the list, no strategy or
//     stop-limit key on an order), The Desk and /bot-library never asked; the hotkeys stay this browser's; an order is
//     the 1.15 order (a bracket).
//   Part B (with V115_ROOT=<a chart 1.15.0 checkout>): the same order scenario on the 1.15.0 page and on this one, against
//     the same fake bridge: every message the ticket's connection sent is the same, in the same order (cids and the
//     session token aside).
//   npm run smoke:v038        (CHROMIUM_PATH=/path/to/chrome; V038_SMOKE_PORT and the next one; V115_ROOT=dir)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.V038_SMOKE_PORT || 8971);
const V115 = process.env.V115_ROOT ? path.resolve(process.env.V115_ROOT) : '';
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms) {
  const end = Date.now() + (ms || 10000);
  for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); }
}
/* v3's page messages (nt8/PROTOCOL.md "Protocol v3"), and the keys v3 adds to the old ones */
const V3_TYPES = ['client', 'accountTrade', 'accountArchive', 'merge', 'copierGet', 'copierSet', 'copierFollower', 'copierRearm', 'botMode', 'botKill', 'botSeen', 'botAnswer', 'botRails', 'botAccount'];
const V3_KEYS = ['from', 'strategy', 'limitOffset', 'limitPrice'];

let bridge = null, port = PORT;
async function startBridge(p, extra) {
  port = p;
  bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(p), '--trading', '--trade-accounts=Sim101', '--max-qty=MNQ:9,NQ:2,MES:2,ES:2', '--test-controls',
    '--version=0.3.8', '--data-037', '--test-pin=' + TEST_PIN].concat(extra || []), { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { bridge.stdout.once('data', res); bridge.once('exit', c => rej(new Error('bridge exited ' + c))); });
}
const stopBridge = () => new Promise(r => { if (!bridge) return r(); bridge.once('exit', r); bridge.kill(); bridge = null; });
const control = async (what, q) => (await fetch(`http://127.0.0.1:${port}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();

/* before any page script: every WebSocket and what it sent, the NO STOP question answered, a fixed layout */
function spies(layouts) {
  const S = window.__spy = { sockets: [] };
  const Real = window.WebSocket;
  function Spy(url, p) {
    const sock = p === undefined ? new Real(url) : new Real(url, p);
    const rec = { url: String(url), sent: [] };
    const send = sock.send.bind(sock);
    sock.send = d => { rec.sent.push(d); try { const t = JSON.parse(d).type; if (t === 'auth') rec.auth = true; if (t === 'subscribe') rec.sub = true; } catch (e) { /* not JSON */ } return send(d); };
    S.sockets.push(rec);
    return sock;
  }
  Spy.prototype = Real.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Spy[k] = Real[k];
  window.WebSocket = Spy;
  setInterval(() => { const b = document.querySelector('.nostop-ask:not([hidden]) .nostop-send'); if (b) b.click(); }, 30);
  try { if (!localStorage.getItem('live-workspace-v1')) localStorage.setItem('live-workspace-v1', JSON.stringify({ v: 1, layouts })); } catch (e) { /* blocked */ }
}
const LAYOUT = (withPage) => ({ Main: { panels: [
  { id: 'c1', type: 'chart', root: 'MNQ', tf: 'm5', x: 0, y: 0, w: 8, h: 6 },
  { id: 'tk', type: 'ticket', x: 8, y: 0, w: 4, h: 3 }, { id: 'ac', type: 'account', x: 8, y: 3, w: 4, h: withPage ? 1 : 3 }]
  .concat(withPage ? [{ id: 'ap', type: 'accounts', x: 8, y: 4, w: 4, h: 2 }] : []) } });

async function openWs(browser, withPage, requests) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(spies, LAYOUT(withPage));
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));
  page.on('request', r => requests.push(r.url()));
  await page.goto(`http://localhost:${port}/live/?layout=Main`);
  await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
  await enterPin(page, TEST_PIN);
  await page.waitForFunction(() => window.workspace && window.workspace.ticket().enabled && window.workspace.ticket().held, null, { timeout: 30000 });
  await wait(1200);
  return { ctx, page };
}
const tk = (p, id) => p.locator(`.ws-panel[data-type="ticket"] [data-tk-id="${id}"]`);
const visible = (p, sel) => p.evaluate(s => [...document.querySelectorAll(s)].some(e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length)), sel);
const allSent = p => p.evaluate(() => window.__spy.sockets.map(k => ({ url: k.url, auth: !!k.auth, sub: !!k.sub, sent: k.sent.map(d => { try { return JSON.parse(d); } catch (e) { return { raw: d }; } }) })));

/* the order scenario: a bracket of 8 / 16, Armed, Buy MKT, the price up 3, B/E, Sell MKT, Buy MKT, Cancel all, Buy MKT, Close */
async function scenario(page) {
  await page.selectOption('.ws-panel[data-type="ticket"] [data-tk-id="oQty"]', '1');
  await tk(page, 'bStop').fill('8'); await tk(page, 'bStop').press('Tab'); await tk(page, 'bTarget').fill('16'); await tk(page, 'bTarget').press('Tab'); await wait(400);
  await tk(page, 'armBtn').click(); await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.evaluate(() => { for (const k of window.__spy.sockets) k.sent.length = 0; });
  const step = async (id, ms) => { await tk(page, id).click(); await wait(ms || 900); };
  await step('buyMkt'); await control('price', { root: 'MNQ', p: 25003 }); await wait(900);
  await step('beBtn'); await step('sellMkt'); await control('price', { root: 'MNQ', p: 25000 }); await wait(600);
  await step('buyMkt'); await step('cancelAllBtn', 1500); await step('buyMkt'); await step('flattenBtn', 1200);
}
/* the ticket's connection: the one that signs in (auth) and subscribes to nothing */
const ticketSent = all => {
  const t = all.filter(k => k.auth && !k.sub);
  return t.length === 1 ? t[0].sent : null;
};
const norm = list => (list || []).map(m => JSON.stringify(Object.assign({}, m, m.cid ? { cid: 'C' } : {}, m.token ? { token: 'T' } : {})));

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  /* ================ Part A: chart 1.16.0 with a ChartBridge that has no v3 ================ */
  console.log('Part A: this page with a ChartBridge 0.3.8 (no v3)');
  await startBridge(PORT);
  const requests = [];
  const { ctx, page } = await openWs(browser, true, requests);
  let all = await allSent(page);
  const authed = all.filter(k => k.auth);
  check(authed.length === 1, 'one signed-in connection, the ticket\'s (no v3 connection opened): ' + authed.length);
  check(all.every(k => !k.sent.some(m => m.type === 'client')), 'nobody said client v3');
  check(!(await page.evaluate(() => window.workspace.accountFeed().open || window.workspace.accountFeed().v3)), 'the window\'s v3 connection stays closed');
  for (const sel of ['#wsBotTab', '#btStrip', '#btView .bt-grid', '.bt-prop', '.bt-note']) check(!(await visible(page, sel)), 'no ' + sel);
  for (const id of ['stratRow', 'stratDesc', 'mergeBtn']) check(!(await visible(page, `.ws-panel[data-type="ticket"] [data-tk-id="${id}"]`)), 'no ' + id + ' on the ticket');
  check((await tk(page, 'managed').textContent()) === '' && (await tk(page, 'mergeLine').textContent()) === '', 'no managed or Merge line on the ticket');
  check(await visible(page, '.ws-panel[data-type="ticket"] .tk-bk'), 'the bracket boxes as in 1.15');
  check(/needs ChartBridge 0\.4\.0/.test(await page.textContent('.ws-panel[data-id="ap"]')), 'the Account page says it needs ChartBridge 0.4.0: ' + (await page.textContent('.ws-panel[data-id="ap"]')).replace(/\s+/g, ' ').slice(0, 120));
  check(!(await visible(page, '.ws-panel[data-id="ap"] input, .ws-panel[data-id="ap"] button[data-act="cancel"], .ws-panel[data-id="ap"] button[data-act="archive"]')), 'the Account page offers no control');
  await page.click('.ws-panel[data-id="c1"] [data-act="more"]'); await wait(200);
  check(!(await visible(page, '#wsMore [data-do="ghost"]')), 'no bot trades choice in a chart\'s menu');
  await page.keyboard.press('Escape');
  await page.click('#wsSet'); await wait(400);
  for (const id of ['wsDeskSec', 'wsStratSec', 'wsTypesSec']) check(!(await visible(page, '#' + id)), 'no ' + id + ' in Settings');
  for (const id of ['merge', 'accept', 'reject']) check(!(await visible(page, `#wsHotkeys .hk-row[data-hk="${id}"]`)), 'no ' + id + ' key in Settings');
  check((await page.textContent('#wsHkWhere')) === 'kept in this browser', 'the hotkeys are this browser\'s, as in 1.15');
  await page.keyboard.press('Escape'); await page.evaluate(() => document.activeElement && document.activeElement.blur()); await wait(200);
  if (await visible(page, '#wsSettings')) { await page.click('#wsSet'); await wait(200); }
  await control('hold', { root: 'MNQ' }); await control('price', { root: 'MNQ', p: 25000 });
  await scenario(page);
  all = await allSent(page);
  const every = all.flatMap(k => k.sent);
  const bad = every.filter(m => V3_TYPES.includes(m.type) || V3_KEYS.some(k => k in m) || (m.type === 'order' && !['market', 'limit', 'stop'].includes(m.kind)));
  check(bad.length === 0, 'not one v3 message or v3 key on any connection: ' + JSON.stringify(bad.slice(0, 3)));
  const orders = every.filter(m => m.type === 'order');
  check(orders.length === 4 && orders.every(m => JSON.stringify(Object.keys(m).sort()) === '["account","bracket","cid","kind","qty","root","side","type"]' || JSON.stringify(Object.keys(m).sort()) === '["account","cid","kind","qty","root","side","type"]'),
    'each order is the 1.15 order (a bracket, or none on an order that reduces): ' + JSON.stringify(orders.map(m => Object.keys(m).join(','))));
  check(requests.every(u => !/\/bot-library|\/api\/chart-(hotkeys|strategies|accounts)|:8800\//.test(u)), 'The Desk and /bot-library never asked: ' + requests.filter(u => /bot-library|\/api\/chart-|8800/.test(u)).join(', '));
  check((await page.evaluate(() => localStorage.getItem('live-desk-sync-v1'))) === null, 'live-desk-sync-v1 is never written (1.21.0: it told the single chart page, gone)');
  const mine = ticketSent(all);
  await ctx.close(); await stopBridge();

  /* ================ Part B: the same order scenario on the 1.15.0 page ================ */
  if (V115 && fs.existsSync(path.join(V115, 'live', 'index.html'))) {
    console.log('Part B: the 1.15.0 page (' + V115 + '), the same scenario, the same ChartBridge 0.3.8');
    await startBridge(PORT + 1, ['--serve-root=' + V115]);
    const rq = [];
    const old = await openWs(browser, false, rq);
    await control('hold', { root: 'MNQ' }); await control('price', { root: 'MNQ', p: 25000 });
    await scenario(old.page);
    const oldAll = await allSent(old.page);
    const theirs = ticketSent(oldAll);
    if (!theirs) console.log('    1.15.0 connections: ' + JSON.stringify(oldAll.map(k => [k.url, k.sent.map(m => m.type)])));
    await old.ctx.close(); await stopBridge();
    /* the same layout without the Account page on this page, so both pages do exactly the same */
    await startBridge(PORT + 1);
    const now = await openWs(browser, false, []);
    await control('hold', { root: 'MNQ' }); await control('price', { root: 'MNQ', p: 25000 });
    await scenario(now.page);
    const ours = ticketSent(await allSent(now.page));
    await now.ctx.close(); await stopBridge();
    const a = norm(theirs), b = norm(ours);
    check(a.length >= 6 && JSON.stringify(a) === JSON.stringify(b), 'the ticket\'s connection sent exactly what 1.15.0 sends (' + a.length + ' messages): ' + (JSON.stringify(a) === JSON.stringify(b) ? a.map(x => JSON.parse(x).type).join(', ') : '\n    1.15.0: ' + a.join('\n            ') + '\n    1.16.0: ' + b.join('\n            ')));
    check(norm(mine).filter(x => !/"type":"(auth|ping)"/.test(x)).length === a.filter(x => !/"type":"(auth|ping)"/.test(x)).length, 'and the same count in Part A (with the Account page in the layout)');
  } else console.log('Part B skipped: set V115_ROOT to a chart 1.15.0 checkout to compare the order messages');
} catch (e) {
  fail('smoke threw: ' + (e && e.stack || e));
} finally {
  await browser.close();
  await stopBridge();
}
console.log(checks + ' checks, ' + errors.length + ' failed');
process.exit(errors.length ? 1 : 0);
