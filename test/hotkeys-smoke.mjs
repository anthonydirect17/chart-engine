// Trading hotkeys smoke test (chart 1.11.0): drives the live page in Chromium against the fake bridge (protocol v2).
// Sample data only; nothing reaches a broker. Keys are set in Settings the way Anthony would (click a box, press
// the keys), and every hotkey must send exactly what its button sends. Screenshots in test/out/.
//   npm run smoke:hotkeys        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, unlockIfAsked } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const PORT = +(process.env.HOTKEYS_SMOKE_PORT || 8812);
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const bridges = [];
async function startBridge(port, flags) {
  const child = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(port)].concat(flags), { stdio: ['ignore', 'pipe', 'inherit'] });
  bridges.push(child);
  await new Promise(r => child.stdout.once('data', r));
}
const control = async (port, what, q) => (await fetch(`http://127.0.0.1:${port}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
async function until(fn, what, ms) {
  const end = Date.now() + (ms || 6000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) { fail('timed out: ' + what); return null; }
    await new Promise(r => setTimeout(r, 100));
  }
}
const wait = ms => new Promise(r => setTimeout(r, ms));
/* every message the page sends, and every status line it shows */
const spies = () => {
  window.__sent = []; window.__statusSeen = [];
  const iv = setInterval(() => { const el = document.getElementById('statusMsg'); if (!el) return; clearInterval(iv); new MutationObserver(() => window.__statusSeen.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true }); }, 20);
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) { try { window.__sent.push(Object.defineProperty(JSON.parse(d), '__at', { value: performance.now() })); } catch (e) { /* not JSON */ } return send.call(this, d); };
};
/* 1.13.0: the first order with no stop after each load asks "No stop: send anyway?" (Anthony); this smoke answers Send
   (test/nostop-smoke.mjs checks the question itself) */
const answerNoStop = () => { setInterval(() => { const b = document.querySelector('.nostop-ask:not([hidden]) .nostop-send'); if (b) b.click(); }, 30); };
const ORDER_TYPES = ['order', 'change', 'cancel', 'flatten'];
const KEYS = { buy: 'Alt+KeyB', sell: 'Alt+KeyS', be: 'Alt+KeyK', close: 'Alt+KeyC', flattenAll: 'Shift+F9' };
const SHOWN = { buy: 'Alt+B', sell: 'Alt+S', be: 'Alt+K', close: 'Alt+C', flattenAll: 'Shift+F9' };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  await startBridge(PORT, ['--trading', '--trade-accounts=Sim101', '--max-qty=MNQ:9,NQ:2,MES:2,ES:2', '--test-controls', '--test-pin=' + TEST_PIN]);
  const L = Math.round((await control(PORT, 'hold', { root: 'MNQ' })).last);
  await control(PORT, 'price', { root: 'MNQ', p: L });
  const state = () => control(PORT, 'state', { root: 'MNQ' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 1 });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(spies);
  await ctx.addInitScript(answerNoStop);
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|WebSocket connection/.test(m.text())) fail('console: ' + m.text()); });
  const tradingOn = () => until(() => page.evaluate(() => !document.getElementById('buyMkt').disabled && document.getElementById('connPill').textContent === 'LIVE'), 'trading on', 20000);
  await page.goto(`http://localhost:${PORT}/live/single.html`);
  await unlockIfAsked(page); await tradingOn();
  await page.waitForTimeout(500);

  const sent = (types) => page.evaluate(t => window.__sent.filter(m => t.includes(m.type)).map(m => { const c = Object.assign({}, m); delete c.cid; return c; }), types || ORDER_TYPES);
  const clearSent = () => page.evaluate(() => { window.__sent.length = 0; window.__statusSeen.length = 0; });
  const statusSeen = () => page.evaluate(() => window.__statusSeen.slice());
  const statusNow = () => page.textContent('#statusMsg');
  const unfocus = () => page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  const press = async combo => { await unfocus(); await page.keyboard.press(combo); await page.waitForTimeout(150); };
  const pos = async () => (await page.textContent('#oPos')).trim();
  const flatAll = () => until(async () => { const s = await state(); return !s.orders.length && !Object.values(s.positions).some(p => p.qty); }, 'everything flat', 8000);

  /* ---------------- Settings: no default keys; set each by pressing it; refused combos are never saved */
  check(await page.isVisible('#setBtn'), 'a Settings button on the trading page');
  await page.click('#setBtn');
  check(await page.isVisible('#setPanel'), 'Settings opens');
  const fields = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#setPanel .hk-in')].map(i => [i.dataset.hk, i.value])));
  const stored = () => page.evaluate(() => localStorage.getItem('live-hotkeys-v1'));
  check(JSON.stringify(await fields()) === JSON.stringify({ buy: '', sell: '', be: '', close: '', flattenAll: '' }) && await stored() === null, 'no default keys: every box empty, nothing stored');
  check(JSON.stringify(await page.$$eval('#setPanel .hk-name', els => els.map(e => e.textContent))) === '["Buy MKT","Sell MKT","B/E","Close","Flatten all"]', 'one row per action');
  const note = id => page.textContent('#hkNote-' + id);
  const setKey = async (id, combo) => { await page.click('#hk-' + id); await page.keyboard.press(combo); await page.waitForTimeout(80); };
  const refusals = [
    ['Control+KeyW', /Ctrl\+W is kept by the browser/], ['Control+KeyT', /Ctrl\+T is kept by the browser/], ['F5', /F5 is kept by the browser/],
    ['Alt+KeyF', /Alt\+F is kept by the browser/], ['Escape', /Escape is kept/], ['KeyA', /A is the chart's/], ['Control+KeyA', /Ctrl\+A is the chart's/],
    ['Shift+Equal', /Shift\+= is the chart's/], ['Minus', /- is the chart's/], ['Slash', /\/ is the chart's/], ['End', /End is kept/],
    ['Meta+KeyB', /Windows key/], ['Shift', /Shift alone is not a hotkey/], ['Space', /cannot be a hotkey/],
  ];
  for (const [combo, re] of refusals) {
    await setKey('buy', combo);
    const n = await note('buy');
    check(re.test(n) && (await fields()).buy === '' && await stored() === null, 'refused ' + combo + ', not saved: ' + n);
  }
  check(await page.isVisible('#setPanel'), 'Escape in a key box does not close Settings');
  for (const id of Object.keys(KEYS)) { await setKey(id, KEYS[id]); check((await note(id)) === 'Saved.', 'set ' + id + ' to ' + SHOWN[id]); }
  check(JSON.stringify(await fields()) === JSON.stringify(SHOWN), 'the boxes show the combos: ' + JSON.stringify(await fields()));
  check(await stored() === JSON.stringify(SHOWN), 'saved under live-hotkeys-v1: ' + await stored());
  await setKey('sell', KEYS.buy);
  check(/Alt\+B is already Buy MKT/.test(await note('sell')) && (await fields()).sell === 'Alt+S' && await stored() === JSON.stringify(SHOWN), 'a combo given to another action is refused: ' + await note('sell'));
  // Clear, then set again
  await page.click('#setPanel button[data-hk-clear="close"]');
  check((await fields()).close === '' && JSON.parse(await stored()).close === '', 'Clear empties and saves');
  await setKey('close', KEYS.close);
  await page.screenshot({ path: path.join(out, 'hotkeys-1440-settings.png') });
  // while Settings is open, a hotkey does nothing (the box takes it, and outside it the panel is a dialog)
  await clearSent();
  await page.click('#setPanel .hk-foot');
  await page.keyboard.press(KEYS.flattenAll); await page.waitForTimeout(200);
  check((await sent()).length === 0 && (await statusSeen()).length === 0, 'nothing fires while Settings is open');
  await page.keyboard.press('Escape');
  check(await page.isHidden('#setPanel'), 'Escape closes Settings');

  /* ---------------- disarmed: Buy, Sell and B/E send nothing and say why (they need Armed, as their buttons do); Close
     and Flatten all work while disarmed, as the Flatten button does (Anthony 2026-10-01: Flatten is never blocked) */
  check(await page.getAttribute('#armBtn', 'aria-checked') === 'false', 'Armed off');
  for (const id of ['buy', 'sell', 'be']) {
    await clearSent();
    await press(KEYS[id]);
    check((await sent()).length === 0 && (await statusNow()) === 'Armed is off: nothing was sent. Turn Armed on to trade.', 'disarmed ' + id + ' hotkey: nothing sent, the note says why');
    await page.waitForTimeout(300);
  }
  // the buttons say the same
  for (const b of ['#buyMkt', '#sellMkt']) {
    await clearSent(); await page.click(b);
    check((await sent()).length === 0 && (await statusNow()) === 'Armed is off: nothing was sent. Turn Armed on to trade.', 'the ' + b + ' button disarmed: nothing sent, the same note');
    await page.waitForTimeout(450);
  }
  await clearSent(); await press(KEYS.close);
  check(JSON.stringify(await sent()) === JSON.stringify([{ type: 'flatten', account: 'Sim101', root: 'MNQ' }]) && (await statusNow()) === 'Flatten sent for Sim101 MNQ: cancel its orders, close the position at market.', 'disarmed Close hotkey: the flatten goes');
  await page.waitForTimeout(450);
  await clearSent(); await page.click('#flattenBtn');
  check(JSON.stringify(await sent()) === JSON.stringify([{ type: 'flatten', account: 'Sim101', root: 'MNQ' }]), 'disarmed Flatten button: the flatten goes');
  await clearSent(); await press(KEYS.flattenAll);
  check((await sent()).length === 0 && (await statusNow()) === 'Flatten all: no position or working order on Sim101. Nothing was sent.', 'disarmed Flatten all with nothing open: not refused for Armed, nothing to send');

  /* ---------------- armed: each hotkey sends exactly what its button sends */
  await page.click('#armBtn');
  check(await page.getAttribute('#armBtn', 'aria-checked') === 'true', 'armed');
  const commit = async (sel, v) => { await page.fill(sel, v); await page.press(sel, 'Tab'); };
  await commit('#bStop', '40'); await commit('#bTarget', '80');
  await page.selectOption('#oQty', '2');
  await clearSent();
  await page.click('#buyMkt');
  await until(async () => (await pos()).startsWith('LONG 2'), 'long 2 by the button');
  await page.waitForTimeout(450);
  await press(KEYS.buy);
  await until(async () => (await pos()).startsWith('LONG 4'), 'long 4 by the hotkey');
  let m = await sent(['order']);
  check(m.length === 2 && JSON.stringify(m[0]) === JSON.stringify(m[1]) && m[0].side === 'buy' && m[0].kind === 'market' && m[0].qty === 2 && m[0].bracket && m[0].bracket.stop === 40 && m[0].bracket.target === 80 && m[0].account === 'Sim101' && m[0].root === 'MNQ',
    'Buy MKT hotkey = the button (market, qty 2, bracket 40 / 80): ' + JSON.stringify(m));
  const seen = await statusSeen();
  check(seen.filter(t => /^Sent BUY MKT 2 MNQ with bracket 40 \/ 80 ticks · Sim101$/.test(t)).length === 2, 'the same note for both: ' + JSON.stringify(seen.slice(0, 4)));
  await page.waitForTimeout(450);
  await clearSent();
  await page.click('#sellMkt');
  await until(async () => (await pos()).startsWith('LONG 2'), 'long 2 after the Sell button');
  await page.waitForTimeout(450);
  await press(KEYS.sell);
  await until(async () => (await pos()) === 'Flat', 'flat after the Sell hotkey');
  m = await sent(['order']);
  check(m.length === 2 && JSON.stringify(m[0]) === JSON.stringify(m[1]) && m[0].side === 'sell' && m[0].qty === 2 && !m[0].bracket, 'Sell MKT hotkey = the button (reduces: no bracket): ' + JSON.stringify(m));
  await flatAll();
  // the 0.4 s repeat guard, and a held key's repeats
  await page.waitForTimeout(450);
  await clearSent();
  await press(KEYS.buy); await press(KEYS.buy);
  check((await sent(['order'])).length === 1 && (await statusNow()) === 'Ignored a repeat click within 0.4 s.', 'a second press within 0.4 s is ignored, with the note');
  await until(async () => (await pos()).startsWith('LONG 2'), 'long 2');
  await page.waitForTimeout(450);
  await clearSent();
  await unfocus();
  await page.keyboard.down('Alt'); await page.keyboard.down('KeyS');
  for (let k = 0; k < 3; k++) { await page.waitForTimeout(500); await page.keyboard.down('KeyS'); }   // auto-repeat, each past the 0.4 s guard
  await page.keyboard.up('KeyS'); await page.keyboard.up('Alt');
  await page.waitForTimeout(300);
  const reps = await page.evaluate(() => window.__sent.filter(m => m.type === 'order').length);
  check(reps === 1, 'a held key fires once, its repeats never: ' + reps + ' order(s)');
  await until(async () => (await pos()) === 'Flat', 'flat');
  await flatAll();

  // focus return (Anthony 2026-10-01): after a pick in an order bar select or Enter in a bracket box, a hotkey fires at once
  await page.waitForTimeout(450);
  await page.focus('#oQty'); await page.selectOption('#oQty', '1');
  const actQ = await page.evaluate(() => document.activeElement.id || document.activeElement.tagName);
  await clearSent(); await page.keyboard.press(KEYS.buy); await page.waitForTimeout(200);
  m = await sent(['order']);
  check(actQ !== 'oQty' && m.length === 1 && m[0].qty === 1 && m[0].side === 'buy', 'picked Qty 1, then the Buy hotkey fired at once: ' + JSON.stringify({ focus: actQ, m }));
  await until(async () => (await pos()).startsWith('LONG 1'), 'long 1 after the Qty pick');
  await page.focus('#bPreset'); await page.selectOption('#bPreset', '1:2');
  const actP = await page.evaluate(() => document.activeElement.id || document.activeElement.tagName);
  await page.click('#bStop', { clickCount: 3 }); await page.keyboard.type('30'); await page.keyboard.press('Enter');
  const actS = await page.evaluate(() => ({ f: document.activeElement.id || document.activeElement.tagName, stop: JSON.parse(localStorage.getItem('live-bracket-v1')).MNQ.stop }));
  await page.waitForTimeout(450);
  await clearSent(); await page.keyboard.press(KEYS.sell); await page.waitForTimeout(200);
  check(actP !== 'bPreset' && actS.f !== 'bStop' && actS.stop === 30 && (await sent(['order'])).length === 1, 'bracket preset pick and Enter in the stop box hand the focus back (stop 30 kept), the Sell hotkey fires: ' + JSON.stringify({ actP, actS }));
  await until(async () => (await pos()) === 'Flat', 'flat after the focus checks');
  await flatAll();

  // B/E: no position says why; with a position the hotkey sends what the button sends
  await page.waitForTimeout(450);
  await clearSent();
  await press(KEYS.be);
  check((await sent()).length === 0 && (await statusNow()) === 'B/E: no open position on Sim101 MNQ. Nothing was sent.', 'B/E hotkey while flat: nothing sent, the note says why');
  await commit('#bStop', '40'); await commit('#bTarget', '0');
  await page.selectOption('#oQty', '1');
  const beRound = async how => {
    await control(PORT, 'price', { root: 'MNQ', p: L });
    await page.waitForTimeout(450);
    await page.click('#buyMkt');
    await until(async () => (await pos()).startsWith('LONG 1') && (await state()).orders.filter(o => o.role === 'stop').length === 1, 'long 1 with a stop (' + how + ')');
    await control(PORT, 'price', { root: 'MNQ', p: L + 2 });
    await page.waitForTimeout(450);
    if (how === 'hotkey') {                                     // disarmed with a position: neither B/E sends anything
      await page.click('#armBtn');
      await clearSent(); await press(KEYS.be);
      check((await sent()).length === 0 && (await statusNow()) === 'Armed is off: nothing was sent. Turn Armed on to trade.', 'disarmed B/E hotkey with a position: nothing sent');
      await page.waitForTimeout(450);
      await clearSent(); await page.click('#beBtn');
      check((await sent()).length === 0 && (await statusNow()) === 'Armed is off: nothing was sent. Turn Armed on to trade.', 'disarmed B/E button with a position: nothing sent');
      await page.click('#armBtn'); await page.waitForTimeout(450);
    }
    await clearSent();
    if (how === 'button') await page.click('#beBtn'); else await press(KEYS.be);
    await until(async () => (await state()).orders.some(o => o.role === 'stop' && o.price === L), 'stop at break-even (' + how + ')');
    const r = { msgs: (await sent()).map(x => x.type + ' ' + x.price), note: (await statusSeen()).find(t => /break-even/.test(t)) };
    await page.waitForTimeout(450);
    await page.click('#flattenBtn');
    await flatAll();
    return r;
  };
  const beB = await beRound('button'), beK = await beRound('hotkey');
  check(JSON.stringify(beB) === JSON.stringify(beK) && beK.msgs.length === 1 && beK.msgs[0] === 'change ' + L, 'B/E hotkey = the button: ' + JSON.stringify([beB, beK]));

  // Close: the Flatten button on this account and instrument
  const closeRound = async how => {
    await page.waitForTimeout(450);
    await page.click('#buyMkt');
    await until(async () => (await pos()).startsWith('LONG 1') && (await state()).orders.length === 1, 'long 1 with a stop (' + how + ')');
    await page.waitForTimeout(450);
    if (how === 'hotkey') await page.click('#armBtn');         // Close works while disarmed
    await clearSent();
    if (how === 'button') await page.click('#flattenBtn'); else await press(KEYS.close);
    await flatAll();
    if (how === 'hotkey') await page.click('#armBtn');
    return { msgs: await sent(), note: (await statusSeen()).find(t => /^Flatten sent/.test(t)) };
  };
  const clB = await closeRound('button'), clK = await closeRound('hotkey');
  check(JSON.stringify(clB) === JSON.stringify(clK) && clK.note === 'Flatten sent for Sim101 MNQ: cancel its orders, close the position at market.' && JSON.stringify(clK.msgs) === JSON.stringify([{ type: 'flatten', account: 'Sim101', root: 'MNQ' }]), 'Close hotkey (disarmed) = the Flatten button (armed): ' + JSON.stringify([clB, clK]));

  // Flatten all: one flatten per instrument with a position or a working order on the account, whatever is shown
  await page.waitForTimeout(450);
  await clearSent();
  await press(KEYS.flattenAll);
  check((await sent()).length === 0 && (await statusNow()) === 'Flatten all: no position or working order on Sim101. Nothing was sent.', 'Flatten all with nothing open: nothing sent, the note says so');
  await page.click('#buyMkt');                                                    // MNQ: long 1 and its stop
  await until(async () => (await pos()).startsWith('LONG 1'), 'MNQ long 1');
  await page.click('#symSeg >> text="ES"');
  await tradingOn(); await page.waitForTimeout(600);
  const armAgain = async () => { if (await page.getAttribute('#armBtn', 'aria-checked') !== 'true') await page.click('#armBtn'); };
  await armAgain();                                                               // a new instrument turns Armed off
  await page.click('#buyMkt');                                                    // ES: long 1 and its stop
  await until(async () => (await pos()).startsWith('LONG 1'), 'ES long 1');
  const esLast = (await control(PORT, 'state', { root: 'ES' })).last;
  await control(PORT, 'elsewhere', { account: 'Sim101', root: 'NQ', side: 'buy', kind: 'limit', qty: 1, p: Math.round((await control(PORT, 'state', { root: 'NQ' })).last) - 20 });   // NQ: a working order only
  await page.click('#symSeg >> text="MNQ"');
  await tradingOn(); await page.waitForTimeout(600);
  await until(async () => { const s = await state(); return s.orders.some(o => o.root === 'NQ') && Object.entries(s.positions).filter(([, p]) => p.qty).map(([k]) => k).sort().join() === 'Sim101|ES,Sim101|MNQ'; }, 'MNQ and ES long, an NQ order working');
  check(await page.getAttribute('#armBtn', 'aria-checked') === 'false', 'disarmed (the instrument changed) before Flatten all');
  await clearSent();
  await press(KEYS.flattenAll);                                                   // works while disarmed
  await flatAll();
  await armAgain();
  m = await sent();
  check(JSON.stringify(m) === JSON.stringify(['MNQ', 'NQ', 'ES'].map(r => ({ type: 'flatten', account: 'Sim101', root: r }))), 'Flatten all (disarmed): one flatten per instrument with a position or an order: ' + JSON.stringify(m) + ' (ES last ' + esLast + ')');
  const faNote = (await statusSeen()).filter(t => /^Flatten all/.test(t));
  check(JSON.stringify(faNote) === JSON.stringify(['Flatten all sent for Sim101: MNQ, NQ, ES (cancel their orders, close their positions at market).']), 'Flatten all note: ' + JSON.stringify(faNote));

  // paced: right after 8 order actions only 2 of ChartBridge's 10 a second are left, so ES goes about a second later
  {
    const setup = async () => {
      await page.waitForTimeout(450);
      await page.click('#buyMkt');
      await until(async () => (await pos()).startsWith('LONG 1'), 'MNQ long 1 (paced)');
      await page.click('#symSeg >> text="ES"'); await tradingOn(); await page.waitForTimeout(600); await armAgain();
      await page.click('#buyMkt');
      await until(async () => (await pos()).startsWith('LONG 1'), 'ES long 1 (paced)');
      await control(PORT, 'elsewhere', { account: 'Sim101', root: 'NQ', side: 'buy', kind: 'limit', qty: 1, p: Math.round((await control(PORT, 'state', { root: 'NQ' })).last) - 20 });
      await page.click('#symSeg >> text="MNQ"'); await tradingOn(); await page.waitForTimeout(600); await armAgain();
    };
    await setup();
    await control(PORT, 'price', { root: 'MNQ', p: L });
    await page.evaluate(() => window.liveChart.goLive()); await page.waitForTimeout(1500);
    const b = await page.locator('#chart canvas').boundingBox();
    const ys = await page.evaluate(l => [2, 3, 4, 5, 6, 7, 8, 9].map(k => window.liveChart.priceToY(l - k)), L);
    await clearSent();
    await page.keyboard.down('Shift');
    for (const y of ys) await page.mouse.click(b.x + b.width * 0.45, b.y + y);
    await page.keyboard.up('Shift');
    await unfocus(); await page.keyboard.press(KEYS.flattenAll);
    await flatAll();
    await page.waitForTimeout(300);
    const all = await page.evaluate(() => window.__sent.filter(m => ['order', 'flatten'].includes(m.type)).map(m => ({ t: m.type, r: m.root, at: m.__at })));
    const orders = all.filter(x => x.t === 'order'), fl = all.filter(x => x.t === 'flatten');
    const inWin = (x, list) => list.filter(y => y.at > x.at - 1000 && y.at <= x.at).length;
    check(orders.length === 8 && fl.map(x => x.r).join() === 'MNQ,NQ,ES' && fl[2].at - fl[1].at > 500 && all.every(x => inWin(x, all) <= 10),
      'Flatten all paced within 10 a second: ' + JSON.stringify(all.map(x => x.t + ' ' + (x.r || '') + ' ' + Math.round(x.at - all[0].at))));
    const notes = (await statusSeen()).filter(t => /^Flatten all/.test(t));
    check(JSON.stringify(notes) === JSON.stringify(['Flatten all sent for Sim101: MNQ, NQ (cancel their orders, close their positions at market). ES as ChartBridge\'s 10 a second allows.',
      'Flatten all sent for Sim101: MNQ, NQ, ES (cancel their orders, close their positions at market).']), 'paced Flatten all notes: ' + JSON.stringify(notes));
    check(await page.evaluate(() => window.__statusSeen.every(t => !/Refused/.test(t))), 'nothing refused by ChartBridge');
  }

  /* ---------------- never while typing, or with a menu open */
  await page.waitForTimeout(450);
  for (const [sel, what] of [['#bStop', 'the bracket box (input)'], ['#oQty', 'the Qty select'], ['#oAcct', 'the account select']]) {
    await clearSent();
    await page.focus(sel);
    await page.keyboard.press(KEYS.buy); await page.waitForTimeout(250);
    check((await sent()).length === 0, 'nothing fires while the focus is in ' + what);
  }
  await page.click('#indBtn');
  check(await page.isVisible('#indPanel'), 'the Indicators menu is open');
  await clearSent();
  await page.click('#indPanel .ind-head');
  await page.keyboard.press(KEYS.buy); await page.waitForTimeout(250);
  check((await sent()).length === 0, 'nothing fires while the Indicators menu is open');
  await page.keyboard.press('Escape');
  await page.click('.ce-theme-btn');
  await clearSent();
  await page.keyboard.press(KEYS.buy); await page.waitForTimeout(250);
  check((await sent()).length === 0, 'nothing fires while the Colors panel is open');
  await page.click('.ce-theme-btn');
  // a hotkey's preventDefault: the browser does not also act on it
  await unfocus();
  const prevented = await page.evaluate(() => new Promise(res => { const f = e => { document.removeEventListener('keydown', f); setTimeout(() => res(e.defaultPrevented), 0); }; document.addEventListener('keydown', f); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F9', code: 'F9', shiftKey: true, bubbles: true, cancelable: true })); }));
  check(prevented === true, 'a hotkey that fires calls preventDefault');
  await page.waitForTimeout(450);
  const other = await page.evaluate(() => new Promise(res => { const f = e => { document.removeEventListener('keydown', f); setTimeout(() => res(e.defaultPrevented), 0); }; document.addEventListener('keydown', f); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ', altKey: true, bubbles: true, cancelable: true })); }));
  check(other === false, 'a key that is no hotkey is left alone');

  /* ---------------- reload keeps the keys (Armed off again); damaged storage is cleaned, never throws */
  await page.reload(); await unlockIfAsked(page); await tradingOn();
  await page.click('#setBtn');
  check(JSON.stringify(await fields()) === JSON.stringify(SHOWN), 'reload keeps the keys: ' + JSON.stringify(await fields()));
  await page.click('#setBtn');
  await clearSent();
  await press(KEYS.buy);
  check((await sent()).length === 0 && (await statusNow()) === 'Armed is off: nothing was sent. Turn Armed on to trade.', 'after the reload the keys work and Armed is off');
  await page.evaluate(() => localStorage.setItem('live-hotkeys-v1', '{"buy":"Ctrl+W","sell":"Alt+S","be":"Alt+S","close":7,"flattenAll":"A","x":"Alt+X"}'));
  await page.reload(); await unlockIfAsked(page); await tradingOn();
  await page.click('#setBtn');
  check(JSON.stringify(await fields()) === JSON.stringify({ buy: '', sell: 'Alt+S', be: '', close: '', flattenAll: '' }), 'damaged keys cleaned on read: ' + JSON.stringify(await fields()));
  await page.evaluate(() => localStorage.setItem('live-hotkeys-v1', '{not json'));
  await page.click('#setBtn'); await page.click('#setBtn');
  check(JSON.stringify(await fields()) === JSON.stringify({ buy: '', sell: '', be: '', close: '', flattenAll: '' }), 'unreadable storage: no keys, no error');
  await page.screenshot({ path: path.join(out, 'hotkeys-1440-settings-empty.png') });
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(300);
  const pb = await page.evaluate(() => { const r = document.getElementById('setPanel').getBoundingClientRect(); return { l: r.left, r: r.right, w: innerWidth, sw: document.documentElement.scrollWidth }; });
  check(pb.l >= 0 && pb.r <= pb.w && pb.sw <= pb.w, 'phone: Settings inside the screen, no sideways scroll: ' + JSON.stringify(pb));
  await page.screenshot({ path: path.join(out, 'hotkeys-390-settings.png') });
  await page.close();

  /* ---------------- a mounted (read-only) chart has no Settings and ignores the keys entirely */
  const P2 = PORT + 1;
  await startBridge(P2, ['--trading', '--trade-accounts=Sim101', '--test-controls', '--tickets', '--test-pin=' + TEST_PIN]);
  const host = await ctx.newPage();
  host.on('pageerror', e => fail('embed pageerror: ' + e.message));
  await host.goto(`http://localhost:${P2}/test/embed-host.html`);
  await host.evaluate(keys => { localStorage.setItem('live-hotkeys-v1', keys); localStorage.setItem('desk:live-hotkeys-v1', keys); localStorage.setItem('embed:live-hotkeys-v1', keys); }, JSON.stringify(SHOWN));
  await host.evaluate(port => {
    let n = 0;
    window.__a = ChartLive.mount(document.getElementById('paneA'), { wsUrl: () => 'ws://localhost:' + port + '/ws?ticket=A' + (++n) + '-' + Math.random().toString(36).slice(2), paneId: 'main', storagePrefix: 'desk:' });
  }, P2);
  await until(() => host.evaluate(() => { const el = document.querySelector('#paneA .pill[id$="-connPill"]'); return !!el && el.textContent === 'LIVE'; }), 'mounted chart live', 20000);
  check(await host.evaluate(() => !document.querySelector('#paneA .set-wrap, #paneA .obar')), 'a mounted chart has no Settings and no order bar');
  await host.evaluate(() => { window.__sent.length = 0; });
  await host.click('#paneA canvas');
  for (const k of Object.values(KEYS)) { await host.keyboard.press(k); await wait(450); }
  await host.evaluate(() => document.activeElement && document.activeElement.blur());
  for (const k of Object.values(KEYS)) { await host.keyboard.press(k); await wait(100); }
  const hs = await host.evaluate(t => window.__sent.filter(m => t.includes(m.type) || m.type === 'auth').length, ORDER_TYPES);
  const prevented2 = await host.evaluate(() => new Promise(res => { const f = e => { document.removeEventListener('keydown', f); setTimeout(() => res(e.defaultPrevented), 0); }; document.addEventListener('keydown', f); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', altKey: true, bubbles: true, cancelable: true })); }));
  check(hs === 0 && prevented2 === false, 'a mounted chart ignores the hotkeys: nothing sent, the keys left to the host');
  await host.close();
  await ctx.close();
} catch (e) {
  fail('exception: ' + (e && e.stack || e));
} finally {
  await browser.close();
  for (const b of bridges) b.kill();
}
console.log(errors.length ? `hotkeys smoke: ${errors.length} of ${checks} checks FAILED` : `hotkeys smoke: all ${checks} checks passed`);
process.exit(errors.length ? 1 : 0);
