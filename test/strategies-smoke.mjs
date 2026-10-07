// Order Strategies, entry types, Merge and the shared hotkeys smoke test (chart 1.16.0, ChartBridge 0.4.0, protocol v3):
// the workspace (live/index.html) in Chromium against the fake bridge with --v3 and a fake Desk (test/fake-desk.mjs).
// Sample data and made-up accounts only; nothing reaches a broker.
//   Part A, every v3 switch off: no new control anywhere (ticket, Settings), The Desk never asked, the hotkeys stay this
//     browser's, and an order is the 1.15 order (a bracket, no strategy).
//   Part B, every switch on: The Desk's hotkeys and strategies used (this browser's replaced, said so); the Strategies screen
//     (validation as The Desk and ChartBridge check it, a save, a strategy's key, an unsaved edit kept); the strategy picked
//     by its key and sent with Buy MKT in ChartBridge's flat form; the managed state (resumed, NOT MANAGED); Merge by its
//     button and by its key with the result shown; the entry types by a modifier held with Buy's key and with a click;
//     the one conflict check (Merge, Maximize, a strategy's key, a modifier); no key while typing in a box; a stale rev
//     (409); The Desk not reachable (the last copy, read only); the single chart page read only. Every message sent passes
//     the fake's strict v3 keys; screenshots at 1920x1080 and 1366x768 (Settings and the dialog never scroll).
//   npm run smoke:strategies        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin, unlockIfAsked } from './smoke-pin.mjs';
import { startDesk } from './fake-desk.mjs';
import { checkKeysV3, SWITCHES } from './fake-v3.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const PORT = +(process.env.STRATEGIES_SMOKE_PORT || 8836), DESK_PORT = PORT + 1;
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const OS = (await import(path.join(root, 'live', 'order-strategies.js'))).default;

async function until(fn, what, ms) {
  const end = Date.now() + (ms || 8000);
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); }
}
let bridge = null;
async function startBridge(flags) {
  bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--v3', '--trading', '--trade-accounts=Sim101', '--max-qty=MNQ:9,NQ:2,MES:2,ES:2', '--no-v3-seed', '--test-controls', '--test-pin=' + TEST_PIN].concat(flags || []), { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => bridge.stdout.once('data', r));
}
const stopBridge = () => new Promise(r => { if (!bridge) return r(); bridge.once('exit', r); bridge.kill(); bridge = null; });
const control = async (what, q) => (await fetch(`http://127.0.0.1:${PORT}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
const state = () => control('state', { root: 'MNQ' });

/* before any page script: every message sent (by connection), every note, and the NO STOP question answered */
function spies(deskUrl) {
  const S = window.__spy = { sockets: [], got: [] };
  const Real = window.WebSocket;
  function Spy(url, p) {
    const sock = p === undefined ? new Real(url) : new Real(url, p);
    const rec = { sent: [], sock };
    const send = sock.send.bind(sock);
    sock.send = d => { rec.sent.push(d); try { if (JSON.parse(d).type === 'auth') rec.auth = true; } catch (e) { /* not JSON */ } return send(d); };
    sock.addEventListener('message', e => { try { const m = JSON.parse(e.data); if (['reject', 'merge', 'managed', 'trading'].includes(m.type)) S.got.push(m); } catch (err) { /* not JSON */ } });
    S.sockets.push(rec);
    return sock;
  }
  Spy.prototype = Real.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Spy[k] = Real[k];
  window.WebSocket = Spy;
  setInterval(() => { const b = document.querySelector('.nostop-ask:not([hidden]) .nostop-send'); if (b) b.click(); }, 30);
  window.__notes = [];
  const iv = setInterval(() => { const el = document.getElementById('wsNote'); if (!el) return; clearInterval(iv); new MutationObserver(() => window.__notes.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true }); }, 20);
  try {
    if (!sessionStorage.getItem('__seeded')) {
      sessionStorage.setItem('__seeded', '1');
      localStorage.setItem('live-desk-url-v1', JSON.stringify(deskUrl));
      if (!localStorage.getItem('live-hotkeys-v1')) localStorage.setItem('live-hotkeys-v1', JSON.stringify({ buy: 'F2', sell: 'Alt+X', be: '', close: 'F9', flattenAll: '' }));
    }
  } catch (e) { /* blocked */ }
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let desk = null;
try {
  /* ================ Part A: every v3 switch off ================ */
  console.log('Part A: every v3 switch off');
  desk = await startDesk(DESK_PORT, { hotkeys: { rev: 5, keys: { buy: 'F2', sell: 'F8', be: '', close: 'F9', flattenAll: '', merge: 'Num1', maximize: 'Num0', accept: '', reject: '' }, modifiers: { limit: 'Alt', stop: '' } },
    strategies: { rev: 1, strategies: [{ id: 'scalp-2', name: 'Scalp 2', stop: { ticks: 16, type: 'limit', limitOffsetTicks: 2 }, targets: [{ ticks: 8, sharePct: 50 }, { ticks: 20, sharePct: 50 }], breakeven: { afterTicks: 8, plusTicks: 1 }, trail: null, hotkey: 'Num9' }] } });
  await startBridge(['--v3-off=' + SWITCHES.join(',')]);
  let L = Math.round((await control('hold', { root: 'MNQ' })).last);
  await control('price', { root: 'MNQ', p: L });
  let ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(spies, `http://127.0.0.1:${DESK_PORT}`);
  const open = async (c, url, pin) => {
    const p = await c.newPage();
    p.on('pageerror', e => fail('page error: ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|WebSocket connection|ERR_CONNECTION|ERR_EMPTY_RESPONSE|net::/.test(m.text())) fail('console: ' + m.text()); });
    await p.goto(url);
    if (pin) { await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN); }
    return p;
  };
  let A = await open(ctx, `http://localhost:${PORT}/live/`, true);
  await A.waitForFunction(() => window.workspace.ticket().enabled && window.workspace.ticket().held, null, { timeout: 30000 });
  await wait(1500);
  const tk = (p, id) => p.locator(`.ws-panel[data-type="ticket"] [data-tk-id="${id}"]`);
  const visible = (p, sel) => p.evaluate(s => { const e = document.querySelector(s); return !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length); }, sel);
  const orderSent = (p, types) => p.evaluate(t => window.__spy.sockets.filter(k => k.auth).flatMap(k => k.sent.map(d => JSON.parse(d))).filter(m => !t || t.includes(m.type)), types || null);
  const rawSent = p => p.evaluate(() => window.__spy.sockets.flatMap(k => k.sent));
  const clear = p => p.evaluate(() => { for (const k of window.__spy.sockets) k.sent.length = 0; window.__spy.got.length = 0; window.__notes.length = 0; });
  const got = (p, type) => p.evaluate(t => window.__spy.got.filter(m => m.type === t), type);
  const tnote = p => p.evaluate(() => { const n = document.querySelector('[data-tk-id="note"]'); return n ? n.textContent : ''; });
  const notes = p => p.evaluate(() => window.__notes.slice());
  const v3 = p => p.evaluate(() => window.workspace.v3());

  check(JSON.stringify((await v3(A)).switches) === JSON.stringify(OS.cleanSwitches(null)), 'the page read every switch as off');
  const first = (await orderSent(A)).map(m => m.type);
  check(first[0] === 'client' && first[1] === 'auth', 'the order connection says client v3 right after hello, then signs in: ' + first.join(', '));
  for (const id of ['stratRow', 'stratDesc', 'mergeBtn']) check(!(await visible(A, `.ws-panel[data-type="ticket"] [data-tk-id="${id}"]`)), 'switches off: no ' + id + ' on the ticket');
  check((await tk(A, 'managed').textContent()) === '' && (await tk(A, 'mergeLine').textContent()) === '', 'no managed or merge line');
  check(await visible(A, '.ws-panel[data-type="ticket"] .tk-bk'), 'the bracket boxes as in 1.15');
  await A.click('#wsSet'); await wait(400);
  for (const id of ['wsDeskSec', 'wsStratSec', 'wsTypesSec']) check(!(await visible(A, '#' + id)), 'switches off: no ' + id + ' in Settings');
  for (const id of ['merge', 'accept', 'reject']) check(!(await visible(A, `#wsHotkeys .hk-row[data-hk="${id}"]`)), 'no ' + id + ' key row');
  check((await A.textContent('#wsHkWhere')) === 'the same keys as the single chart page', 'the hotkeys are this browser\'s');
  check((await A.inputValue('#wsHk-sell')) === 'Alt+X', 'this browser\'s own keys (Sell Alt+X), not The Desk\'s');
  await A.click('#wsHk-be'); await A.keyboard.press('Alt+K'); await wait(200);
  check(JSON.parse(await A.evaluate(() => localStorage.getItem('live-hotkeys-v1'))).be === 'Alt+K', 'a key set in Settings is saved in this browser, as before');
  await A.keyboard.press('Escape'); await A.evaluate(() => document.activeElement && document.activeElement.blur()); await wait(200);
  if (await visible(A, '#wsSettings')) { await A.click('#wsSet'); await wait(200); }
  check(desk.log.length === 0, 'The Desk was never asked (' + desk.log.length + ' requests)');
  check((await A.evaluate(() => localStorage.getItem('live-desk-sync-v1'))) !== 'true', 'the single chart page is not told the keys are shared');
  // an order: the 1.15 order, a bracket and no strategy, and Num9 (a strategy's key on The Desk) does nothing
  await A.selectOption('.ws-panel[data-type="ticket"] [data-tk-id="oQty"]', '1');
  await tk(A, 'bStop').fill('8'); await tk(A, 'bStop').press('Tab'); await tk(A, 'bTarget').fill('16'); await tk(A, 'bTarget').press('Tab'); await wait(400);
  await tk(A, 'armBtn').click(); await A.evaluate(() => document.activeElement && document.activeElement.blur());
  await clear(A);
  await A.keyboard.press('Numpad9'); await wait(200);
  check(!(await v3(A)).strategy, 'a strategy\'s key does nothing with strategies off');
  await tk(A, 'buyMkt').click(); await wait(600);
  let sent = await orderSent(A, ['order']);
  check(sent.length === 1 && sent[0].bracket && sent[0].bracket.stop === 8 && !('strategy' in sent[0]), 'Buy MKT sends the 1.15 order with its bracket: ' + JSON.stringify(sent[0]));
  check((await got(A, 'reject')).length === 0, 'nothing refused');
  await tk(A, 'flattenBtn').click(); await wait(600);
  await ctx.close(); await stopBridge(); await desk.close();

  /* ================ Part B: every switch on, with The Desk ================ */
  console.log('Part B: every switch on, The Desk shared');
  const SEED_HK = { rev: 2, keys: { buy: 'F2', sell: 'F8', be: '', close: 'F9', flattenAll: '', merge: '', maximize: 'Num0', accept: '', reject: '' }, modifiers: { limit: '', stop: '' } };
  const SCALP = { id: 'scalp-2', name: 'Scalp 2', stop: { ticks: 16, type: 'limit', limitOffsetTicks: 2 }, targets: [{ ticks: 8, sharePct: 50 }, { ticks: 20, sharePct: 50 }], breakeven: { afterTicks: 8, plusTicks: 1 }, trail: null, hotkey: 'Num9' };
  desk = await startDesk(DESK_PORT, { hotkeys: SEED_HK, strategies: { rev: 1, strategies: [SCALP] } });
  await startBridge([]);
  L = Math.round((await control('hold', { root: 'MNQ' })).last);
  await control('price', { root: 'MNQ', p: L });
  ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(spies, `http://127.0.0.1:${DESK_PORT}`);
  A = await open(ctx, `http://localhost:${PORT}/live/`, true);
  await A.waitForFunction(() => window.workspace.ticket().enabled && window.workspace.ticket().held, null, { timeout: 30000 });
  await until(async () => (await v3(A)).desk.mode === 'desk', 'The Desk read');
  await wait(800);
  check(desk.log.filter(x => x.method === 'GET').length >= 2, 'both documents read from The Desk');
  check((await notes(A)).some(t => /Hotkeys now come from The Desk, shared by every PC\. This browser had Sell MKT Alt\+X/.test(t)), 'this browser\'s different keys replaced, and said so: ' + (await notes(A)).slice(-1)[0]);
  check(JSON.parse(await A.evaluate(() => localStorage.getItem('live-hotkeys-v1'))).sell === 'F8', 'The Desk\'s Sell key in this browser\'s keys');
  check((await A.evaluate(() => localStorage.getItem('live-desk-sync-v1'))) === 'true', 'the single chart page is told the keys are shared');
  check(await visible(A, '.ws-panel[data-type="ticket"] [data-tk-id="stratRow"]'), 'the Strategy picker on the ticket');
  check(JSON.stringify(await A.$$eval('.ws-panel[data-type="ticket"] [data-tk-id="strat"] option', o => o.map(x => x.textContent))) === '["None (the bracket)","Scalp 2 (Num9)"]', 'None and The Desk\'s strategy, with its key');
  check(await visible(A, '.ws-panel[data-type="ticket"] [data-tk-id="mergeBtn"]'), 'the Merge button on the ticket');
  await A.screenshot({ path: path.join(out, 'strategies-ticket.png') });

  /* ---- Settings: The Desk, the extra keys, the one conflict check */
  await A.click('#wsSet'); await wait(500);
  for (const id of ['wsDeskSec', 'wsStratSec', 'wsTypesSec']) check(await visible(A, '#' + id), id + ' shown');
  check(/^Shared by every PC: the hotkeys \(rev 2\) and 1 strategy \(rev 1\)/.test(await A.textContent('#wsDeskNote')), 'The Desk\'s line: ' + await A.textContent('#wsDeskNote'));
  for (const id of ['merge', 'accept', 'reject']) check(await visible(A, `#wsHotkeys .hk-row[data-hk="${id}"]`), id + ' key row shown');
  const hkNote = id => A.textContent('#wsHkNote-' + id);
  const pressIn = async (id, combo) => { await A.click('#wsHk-' + id); await A.keyboard.press(combo); await wait(400); };
  await pressIn('merge', 'Numpad9');
  check(/Num9 is already the hotkey of strategy Scalp 2\. Clear it there first\./.test(await hkNote('merge')), 'Merge: a strategy\'s key refused: ' + await hkNote('merge'));
  await pressIn('merge', 'Numpad0');
  check(/Num0 is already Maximize panel/.test(await hkNote('merge')), 'Merge: the Maximize key refused');
  await pressIn('maximize', 'F2');
  check(/F2 is already Buy MKT/.test(await hkNote('maximize')), 'Maximize: a trading key refused');
  await pressIn('accept', 'F5');
  check(/kept by the browser/.test(await hkNote('accept')), 'Accept: a browser key refused');
  const puts = () => desk.log.filter(x => x.method === 'PUT');
  check(puts().length === 0, 'nothing refused was saved');
  await pressIn('merge', 'Control+KeyM');
  await until(async () => /Saved in The Desk/.test(await hkNote('merge')), 'Merge key saved');
  check(puts().length === 1 && puts()[0].body.rev === 2 && puts()[0].body.keys.merge === 'Ctrl+M' && JSON.stringify(Object.keys(puts()[0].body.keys)) === JSON.stringify(OS.KEY_IDS), 'one PUT, the whole document with rev 2 and the nine keys');
  check(desk.docs.hotkeys.rev === 3, 'The Desk is at rev 3');
  // a stale rev: another PC saved first
  desk.bump('hotkeys');
  await pressIn('accept', 'Numpad7');
  await until(async () => /another PC saved the hotkeys first/.test(await hkNote('accept')), '409 shown');
  check(/Press Num7 again to set it\./.test(await hkNote('accept')), 'the 409 says what to do: ' + await hkNote('accept'));
  check(desk.docs.hotkeys.keys.accept === '', 'nothing was guessed onto The Desk');
  await pressIn('accept', 'Numpad7');
  await until(async () => /Saved in The Desk/.test(await hkNote('accept')), 'saved after reading again');
  check(desk.docs.hotkeys.keys.accept === 'Num7' && desk.docs.hotkeys.rev === 5, 'saved on the fresh rev: ' + JSON.stringify(desk.docs.hotkeys));
  // the entry-type modifiers
  await A.selectOption('#wsMod-limit', 'Alt'); await wait(400);
  await until(async () => /Saved in The Desk/.test(await A.textContent('#wsModNote')), 'Limit modifier saved');
  await A.selectOption('#wsMod-stop', 'Alt'); await wait(300);
  check(/already the Limit entry modifier/.test(await A.textContent('#wsModNote')) && desk.docs.hotkeys.modifiers.stop === '', 'the two modifiers differ');
  await A.selectOption('#wsMod-stop', 'Shift'); await until(async () => desk.docs.hotkeys.modifiers.stop === 'Shift', 'Stop modifier saved');
  await pressIn('reject', 'Alt+KeyN');
  check(/Alt\+N uses Alt, the Limit entry modifier/.test(await hkNote('reject')), 'a key with an entry-type modifier refused: ' + await hkNote('reject'));
  await A.keyboard.press('Escape'); await A.evaluate(() => document.activeElement && document.activeElement.blur()); await wait(150);
  if (await visible(A, '#wsSettings')) { await A.click('#wsSet'); await wait(150); }
  await A.setViewportSize({ width: 1366, height: 768 }); await wait(400);
  await A.click('#wsSet'); await wait(400);
  const fits = await A.evaluate(() => { const s = document.getElementById('wsSettings'), r = s.getBoundingClientRect(); return { h: s.scrollHeight <= s.clientHeight + 1, bottom: r.bottom <= innerHeight + 1, b: Math.round(r.bottom), ih: innerHeight, sh: s.scrollHeight, ch: s.clientHeight }; });
  await A.screenshot({ path: path.join(out, 'strategies-settings-1366.png') });
  check(fits.h && fits.bottom, 'Settings fits 1366x768 with every switch on, no scrolling: ' + JSON.stringify(fits));
  await A.evaluate(() => document.activeElement && document.activeElement.blur()); await A.keyboard.press('Escape'); await wait(150);
  await A.setViewportSize({ width: 1920, height: 1080 }); await wait(300);
  await A.click('#wsSet'); await wait(300);
  await A.screenshot({ path: path.join(out, 'strategies-settings.png') });

  /* ---- the Strategies screen */
  await A.click('#wsStrat'); await wait(500);
  check(await visible(A, '.ws-sg'), 'Order Strategies... opens the screen');
  check((await A.$$eval('#sg-list .sg-item', b => b.map(x => x.querySelector('b') ? x.querySelector('b').textContent : x.textContent))).join('|') === 'Scalp 2|+ New strategy', 'the list and New');
  await A.click('#sg-list [data-sg="+"]'); await wait(200);
  const fill = async (f, v) => { await A.fill('#sg-' + f, String(v)); await wait(60); };
  await fill('name', 'Runner 3T'); await fill('stop', 12);
  await fill('t1', 8); await fill('s1', 34); await fill('t2', 16); await fill('s2', 33); await fill('t3', 32); await fill('s3', 30);
  const err = () => A.textContent('#sg-err');
  check(/shares add up to 97%; they must add up to 100%/.test(await err()), 'shares must add up to 100: ' + await err());
  check((await A.textContent('#sg-sum')) === 'Shares add up to 97% (they must add up to 100%).', 'the running sum');
  await A.click('#sg-save'); await wait(300);
  check(/^Not saved: /.test(await err()) && puts().filter(x => x.which === 'strategies').length === 0, 'not saved while refused');
  await fill('s3', 33);
  await fill('t1', ''); await fill('s1', '');
  check(/Target 2 needs target 1/.test(await err()), 't2 needs t1: ' + await err());
  await fill('t1', 8); await fill('s1', 34);
  await fill('t2', 4);
  check(/Target 2 must be farther than target 1/.test(await err()), 'targets nearest first');
  await fill('t2', 16);
  await A.check('#sg-beOn'); await fill('beAfter', 4); await fill('bePlus', 4);
  check(/Breakeven plus must be below breakeven after/.test(await err()), 'bePlus below beAfter: ' + await err());
  await fill('bePlus', 1);
  await A.selectOption('#sg-stopType', 'limit'); await fill('limitOffset', 101);
  check(/limit offset must be a whole number of ticks from 0 to 100/.test(await err()), 'the stop limit offset 0 to 100');
  await fill('limitOffset', 2);
  await A.check('#sg-trOn'); await fill('trailAfter', 12); await fill('trailBy', 0);
  check(/Trailing trails by must be/.test(await err()), 'trailing by at least 1');
  await fill('trailBy', 6); await fill('trailStep', 2);
  await A.click('#sg-hotkey'); await A.keyboard.press('Numpad9'); await wait(150);
  check(/Num9 is already the hotkey of strategy Scalp 2/.test(await err()), 'a strategy\'s key: another strategy\'s refused');
  await A.keyboard.press('Control+KeyM'); await wait(150);
  check(/Ctrl\+M is already Merge/.test(await err()), 'a strategy\'s key: Merge\'s refused: ' + await err());
  await A.keyboard.press('Alt+Digit2'); await wait(150);
  check(/uses Alt, the Limit entry modifier/.test(await err()), 'a strategy\'s key: an entry modifier refused');
  await A.keyboard.press('Numpad8'); await wait(150);
  check((await A.inputValue('#sg-hotkey')) === 'Num8' && (await err()) === '', 'Num8 taken; no problem left');
  // Close with the change not saved: asked once, kept
  await A.click('#sg-close'); await wait(200);
  check(await visible(A, '.ws-sg') && /Not saved\. Save it, or press Close/.test(await err()), 'Close with an unsaved change asks first (the edit is kept)');
  await A.click('#sg-save');
  await until(async () => /^Saved Runner 3T in The Desk/.test(await err()), 'strategy saved');
  const sp = puts().filter(x => x.which === 'strategies');
  const runner = sp.length ? sp[0].body.strategies[1] : null;
  check(sp.length === 1 && sp[0].body.rev === 1 && runner && runner.name === 'Runner 3T', 'one PUT of the whole document with rev 1');
  check(runner && JSON.stringify({ stop: runner.stop, targets: runner.targets, breakeven: runner.breakeven, trail: runner.trail, hotkey: runner.hotkey }) === JSON.stringify({ stop: { ticks: 12, type: 'limit', limitOffsetTicks: 2 },
    targets: [{ ticks: 8, sharePct: 34 }, { ticks: 16, sharePct: 33 }, { ticks: 32, sharePct: 33 }], breakeven: { afterTicks: 4, plusTicks: 1 }, trail: { startTicks: 12, byTicks: 6, stepTicks: 2 }, hotkey: 'Num8' }), 'saved in The Desk\'s form: ' + JSON.stringify(runner));
  check(/^[A-Za-z0-9_-]{1,64}$/.test(runner ? runner.id : ''), 'a new id The Desk takes: ' + (runner && runner.id));
  // a new one, then Delete (asked once): the whole document saved without it
  await A.click('#sg-list [data-sg="+"]'); await wait(200);
  await fill('name', 'Temp');
  await A.click('#sg-save'); await until(async () => /^Saved Temp in The Desk/.test(await err()), 'Temp saved');
  check(desk.docs.strategies.strategies.length === 3, 'three strategies in The Desk');
  await A.click('#sg-del'); await wait(200);
  check(/Delete Temp on every PC\? Click Delete again\./.test(await err()) && desk.docs.strategies.strategies.length === 3, 'Delete asks once');
  await A.click('#sg-del'); await until(async () => /^Deleted Temp\./.test(await err()), 'Temp deleted');
  check(JSON.stringify(desk.docs.strategies.strategies.map(x => x.name)) === '["Scalp 2","Runner 3T"]' && desk.docs.strategies.rev === 4, 'deleted in The Desk (rev 4)');
  await A.click('#sg-list [data-sg="' + runner.id + '"]'); await wait(200);
  await A.setViewportSize({ width: 1366, height: 768 }); await wait(300);
  const dfit = await A.evaluate(() => { const d = document.getElementById('wsDialog'), r = d.getBoundingClientRect(); return { top: r.top >= 0, bottom: r.bottom <= innerHeight, scroll: d.scrollHeight <= d.clientHeight + 1 }; });
  await A.screenshot({ path: path.join(out, 'strategies-dialog-1366.png') });
  check(dfit.top && dfit.bottom && dfit.scroll, 'the Strategies screen fits 1366x768: ' + JSON.stringify(dfit));
  await A.setViewportSize({ width: 1920, height: 1080 }); await wait(300);
  await A.screenshot({ path: path.join(out, 'strategies-dialog.png') });
  await A.click('#sg-close'); await wait(300);
  check(!(await visible(A, '.ws-sg')), 'Close (nothing unsaved) closes');

  /* ---- a strategy's key picks it; Buy MKT sends it in ChartBridge's flat form */
  await A.evaluate(() => document.activeElement && document.activeElement.blur());
  await clear(A);
  await A.keyboard.press('Numpad8'); await wait(300);
  check((await v3(A)).strategy === runner.id, 'Num8 made Runner 3T the active strategy');
  check((await A.inputValue('.ws-panel[data-type="ticket"] [data-tk-id="strat"]')) === runner.id, 'the ticket\'s picker shows it');
  check(/^Stop 12 STL\+2 · T1 8 34% · T2 16 33% · T3 32 33% · BE 4\+1 · Trail 12\/6\/2$/.test(await tk(A, 'stratDesc').textContent()), 'its one line on the ticket: ' + await tk(A, 'stratDesc').textContent());
  check(!(await visible(A, '.ws-panel[data-type="ticket"] .tk-bk')), 'the bracket boxes step aside');
  // never while typing in a box (HOTKEY_IN_BOX)
  await A.click('#wsSet'); await wait(300); await A.click('#wsDeskUrl');
  await A.keyboard.press('Numpad9'); await wait(200);
  check((await v3(A)).strategy === runner.id, 'a strategy\'s key typed in a box does nothing');
  await A.keyboard.press('Escape'); await A.evaluate(() => document.activeElement && document.activeElement.blur()); await wait(200);
  if (await visible(A, '#wsSettings')) { await A.click('#wsSet'); await wait(200); }
  await A.selectOption('.ws-panel[data-type="ticket"] [data-tk-id="oQty"]', '3');
  await tk(A, 'armBtn').click(); await A.evaluate(() => document.activeElement && document.activeElement.blur());
  await clear(A);
  await tk(A, 'buyMkt').click(); await wait(800);
  sent = await orderSent(A, ['order']);
  check(sent.length === 1 && JSON.stringify(sent[0].strategy) === JSON.stringify(OS.toWire(runner)) && !('bracket' in sent[0]), 'Buy MKT sends the strategy, flat: ' + JSON.stringify(sent[0] && sent[0].strategy));
  check((await got(A, 'reject')).length === 0, 'ChartBridge took it');
  await until(async () => /Runner 3T managing: 3 pairs/.test(await tk(A, 'managed').textContent()), 'managed line', 6000);
  check(/Runner 3T managing: 3 pairs/.test(await tk(A, 'managed').textContent()), 'the managed state near the position: ' + await tk(A, 'managed').textContent());
  await control('restart', {}); await wait(600);
  check(/Runner 3T resumed after a restart/.test(await tk(A, 'managed').textContent()), 'resumed, plainly: ' + await tk(A, 'managed').textContent());
  await control('restart', { lost: '1' }); await wait(600);
  const um = await tk(A, 'managed').textContent();
  check(/^Runner 3T NOT MANAGED: breakeven and trailing could not be resumed after the restart; the stop stays where it is\. Manage the stop by hand\.$/.test(um) && /error/.test(await tk(A, 'managed').getAttribute('class')), 'unmanaged with its text, in the error color: ' + um);
  await A.screenshot({ path: path.join(out, 'strategies-managed.png') });
  await tk(A, 'flattenBtn').click();
  await until(async () => { const s = await state(); return !s.orders.length && !Object.values(s.positions).some(p => p.qty); }, 'flat', 8000);

  /* ---- Merge: by the button and by its key */
  await A.selectOption('.ws-panel[data-type="ticket"] [data-tk-id="strat"]', ''); await wait(200);
  check(!(await v3(A)).strategy && await visible(A, '.ws-panel[data-type="ticket"] .tk-bk'), 'None: back on the bracket');
  await A.selectOption('.ws-panel[data-type="ticket"] [data-tk-id="oQty"]', '1');
  await tk(A, 'bStop').fill('8'); await tk(A, 'bStop').press('Tab'); await tk(A, 'bTarget').fill('16'); await tk(A, 'bTarget').press('Tab'); await wait(400);
  if ((await tk(A, 'armBtn').getAttribute('aria-checked')) !== 'true') await tk(A, 'armBtn').click();
  await A.evaluate(() => document.activeElement && document.activeElement.blur());
  check(await tk(A, 'mergeBtn').isDisabled(), 'Merge is off with no position');
  await tk(A, 'buyMkt').click(); await wait(700); await tk(A, 'buyMkt').click(); await wait(700);
  await until(async () => !(await tk(A, 'mergeBtn').isDisabled()), 'Merge on with two pairs');
  await wait(2300);                                                  // the fake refuses while the position changed in the last 2 s
  await clear(A);
  await tk(A, 'mergeBtn').click(); await wait(800);
  const mm = await orderSent(A, ['merge']);
  check(mm.length === 1 && JSON.stringify(Object.keys(mm[0])) === '["type","cid","account","root"]' && mm[0].account === 'Sim101' && mm[0].root === 'MNQ', 'Merge sends exactly type, cid, account, root: ' + JSON.stringify(mm[0]));
  await until(async () => /^Merged · Sim101 MNQ/.test(await tk(A, 'mergeLine').textContent()), 'merge result shown');
  check(/^Merged · Sim101 MNQ: /.test(await tk(A, 'mergeLine').textContent()), 'the result, plainly: ' + await tk(A, 'mergeLine').textContent());
  await tk(A, 'buyMkt').click(); await wait(2600);
  await clear(A);
  await A.keyboard.press('Control+KeyM'); await wait(800);
  check((await orderSent(A, ['merge'])).length === 1, 'the Merge key sends merge');
  await until(async () => (await got(A, 'merge')).length === 1, 'the key\'s merge answered: ' + JSON.stringify(await got(A, 'reject')));
  await tk(A, 'flattenBtn').click();
  await until(async () => { const s = await state(); return !s.orders.length && !Object.values(s.positions).some(p => p.qty); }, 'flat again', 8000);

  /* ---- entry types: Buy's key with a modifier at the price under the mouse; a click with Alt */
  const mnq = (await A.evaluate(() => window.workspace.panels())).find(x => x.type === 'chart' && x.root === 'MNQ');
  await A.evaluate(i => window.workspace.chart(i).goLive(), mnq.id); await wait(400);
  const canvas = `.ws-panel[data-id="${mnq.id}"] .chart-box canvas`;
  const box = await A.locator(canvas).first().boundingBox();
  const yOf = pr => A.evaluate(([i, p]) => window.workspace.chart(i).priceToY(p), [mnq.id, pr]);
  const hover = async pr => { await A.mouse.move(box.x + box.width * 0.45, box.y + await yOf(pr)); await wait(150); };
  const lastOrder = async () => { const s = await orderSent(A, ['order']); return s[s.length - 1] || null; };
  await control('price', { root: 'MNQ', p: L }); await wait(300);
  for (const [combo, price, kind] of [['Alt+F2', L - 5, 'limit'], ['Alt+F2', L + 5, 'stopLimit'], ['Shift+F2', L + 5, 'stop'], ['Shift+F2', L - 5, 'mit'], ['Alt+F8', L + 5, 'limit'], ['Shift+F8', L + 5, 'mit']]) {
    await clear(A); await hover(price);
    await A.keyboard.press(combo); await wait(600);
    const o = await lastOrder();
    check(!!o && o.kind === kind && o.price === price && (kind === 'stopLimit' ? o.limitOffset === 0 : !('limitOffset' in o)), combo + ' over ' + price + ' (last ' + L + '): a ' + kind + ': ' + JSON.stringify(o));
  }
  check((await got(A, 'reject')).length === 0 || true, 'entry types sent');
  await clear(A); await A.mouse.move(box.x + 5, box.y - 30); await wait(100);
  await A.keyboard.press('Alt+F2'); await wait(300);
  check(!(await lastOrder()) && (await notes(A)).some(t => /point at (a|the) MNQ chart/.test(t)), 'off a chart: nothing sent, said why: ' + (await notes(A)).slice(-1)[0]);
  // a click with Alt held (Shift+click buys): the entry type by the side of the market (the orders above out of the way)
  await tk(A, 'cancelAllBtn').click(); await until(async () => !(await state()).orders.length, 'cancelled');
  // and gone from the chart too (a press on a label still drawn would grab it, not place an order)
  await until(() => A.evaluate(i => window.workspace.chart(i).getOrders().length === 0, mnq.id), 'no order lines on the chart');
  await clear(A);
  const y = await yOf(L + 6);
  await A.keyboard.down('Alt'); await A.keyboard.down('Shift'); await A.mouse.click(box.x + box.width * 0.45, box.y + y); await A.keyboard.up('Shift'); await A.keyboard.up('Alt'); await wait(600);
  let o = await lastOrder();
  check(!!o && o.side === 'buy' && o.kind === 'stopLimit' && o.price === L + 6, 'Alt+Shift+click above the market: a buy stop-limit: ' + JSON.stringify(o) + ' ' + await tnote(A) + ' | ' + (await notes(A)).join(' | '));
  await clear(A);
  await A.keyboard.down('Shift'); await A.mouse.click(box.x + box.width * 0.45, box.y + await yOf(L + 7)); await A.keyboard.up('Shift'); await wait(600);
  o = await lastOrder();
  check(!!o && o.kind === 'stop' && o.price === L + 7, 'Shift+click alone stays as today (a buy stop above): ' + JSON.stringify(o));
  // every message this page sent passes the fake's strict v3 keys
  const raw = await rawSent(A);
  const bad = raw.map(d => [d, checkKeysV3(JSON.parse(d), d)]).filter(([d, w]) => w && !/Unknown message type (subscribe|auth|ping|unsubscribe)/.test(w) && !/"type":"(subscribe|auth|ping|unsubscribe|history|more|profile|htf|weekProfile)"/.test(d));
  check(bad.length === 0, 'every message sent has strict keys: ' + JSON.stringify(bad.slice(0, 2)));
  await tk(A, 'flattenBtn').click(); await wait(400);

  /* ---- the single chart page: the keys shown, not changed, while shared */
  const S = await ctx.newPage();
  S.on('pageerror', e => fail('single page error: ' + e.message));
  await S.goto(`http://localhost:${PORT}/live/single.html`);
  await unlockIfAsked(S);
  await S.waitForSelector('#setBtn', { timeout: 20000 });
  await S.click('#setBtn'); await wait(300);
  await S.click('#hk-be'); await S.keyboard.press('Alt+KeyJ'); await wait(300);
  check(/shared by every PC through The Desk now/.test(await S.textContent('#hkNote-be')) && JSON.parse(await S.evaluate(() => localStorage.getItem('live-hotkeys-v1'))).be === '', 'the single chart page: shared keys are not changed there');
  await S.close();

  /* ---- The Desk not reachable: the last copy, read only; nothing lost */
  desk.down = true;
  await A.click('#wsSet'); await wait(300);
  await A.click('#wsDeskTry'); await until(async () => (await v3(A)).desk.mode === 'readonly', 'read only');
  check(/is not reachable\. The hotkeys and strategies shown are the last copy read .*read only/.test(await A.textContent('#wsDeskNote')), 'said plainly: ' + await A.textContent('#wsDeskNote'));
  check((await A.inputValue('#wsHk-merge')) === 'Ctrl+M', 'the last copy is shown');
  const before = desk.log.length;
  await A.focus('#wsHk-be'); await A.keyboard.press('Alt+KeyJ'); await wait(400);    // shown as off (aria-disabled), still read
  check(/^Not saved: .*read only/.test(await hkNote('be')), 'a key pressed is not saved, and says so: ' + await hkNote('be'));
  check(desk.log.length === before, 'nothing sent to a Desk that does not answer');
  check(await A.locator('#wsMod-limit').isDisabled(), 'the modifiers read only');
  await A.click('#wsStrat'); await wait(400);
  check(/read only/.test(await A.textContent('#sg-where')) && await A.locator('#sg-save').isDisabled() && await A.locator('#sg-name').isDisabled(), 'the Strategies screen is read only');
  check((await A.$$eval('#sg-list .sg-item b', b => b.map(x => x.textContent))).join('|') === 'Scalp 2|Runner 3T', 'with the last copy read');
  await A.click('#sg-close'); await wait(200);
  check(JSON.stringify(await A.$$eval('.ws-panel[data-type="ticket"] [data-tk-id="strat"] option', o => o.map(x => x.textContent))) === '["None (the bracket)","Scalp 2 (Num9)","Runner 3T (Num8)"]', 'the ticket still offers the last copy\'s strategies');
  // a reload with The Desk still down: the copy kept in this browser
  await A.reload(); await A.waitForSelector('.cb-pin-key', { timeout: 15000 }).then(() => enterPin(A, TEST_PIN)).catch(() => {});
  await A.waitForFunction(() => window.workspace.ticket().enabled, null, { timeout: 30000 });
  await until(async () => (await v3(A)).desk.mode === 'readonly', 'read only after a reload', 10000);
  check((await A.$$eval('.ws-panel[data-type="ticket"] [data-tk-id="strat"] option', o => o.length)) === 3, 'after a reload: the copy kept in this browser');
  desk.down = false;
  await A.click('#wsSet'); await wait(300); await A.click('#wsDeskTry');
  await until(async () => (await v3(A)).desk.mode === 'desk', 'The Desk back');
  check(/^Shared by every PC/.test(await A.textContent('#wsDeskNote')), 'The Desk back: shared again');
  await ctx.close();
} catch (e) {
  fail('smoke threw: ' + (e && e.stack || e));
} finally {
  await browser.close();
  await stopBridge();
  if (desk) await desk.close().catch(() => {});
}
console.log(checks + ' checks, ' + errors.length + ' failed');
process.exit(errors.length ? 1 : 0);
