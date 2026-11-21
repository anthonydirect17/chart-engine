// Chart 1.61.0 smoke (Anthony 2026-11-20: "flatten all is all we need - this should apply to any account being traded on my charts -
// we do not need a flatten every account option"), and ChartBridge 0.6.6's risk alert banner and sound (1.34.0, kept).
// Against the fake bridge (--v3: made-up accounts EVAL-A, EVAL-B, FUNDED-C, SIM-F1, SIM-F2, Sim101, trade accounts Sim101 and
// EVAL-A only; sample data only), at 1366 x 768:
//   npm run smoke:flatten-all       (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
// Checks: the top bar has Flatten all and no Flatten every account, and still fits; with the ticket on None Flatten all is on; one
// click with Armed off and no confirm flattens every instrument on every trade account (the accounts the charts trade), whatever the
// ticket shows, never more than 10 order actions in any second, and leaves the accounts that are not trade accounts (FUNDED-C and the
// copier's SIM-F1 and SIM-F2: Legion's or the copier's) alone; a contract ChartBridge does not serve is named, never sent; Enter on
// the button sends nothing; a riskAlert shows the banner once per window (both connections bring it) with one sound, and no dialog.
// Screenshots test/out/flatten-all-*.png.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.FLATTEN_ALL_SMOKE_PORT || 8803);
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const errors = [];
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, what, ms) => { const end = Date.now() + (ms || 10000); for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); } };
const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--v3', '--trading', '--test-controls', '--max-qty=MNQ:9,NQ:9', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => bridge.stdout.once('data', r));
const control = async (what, q) => (await fetch(`http://127.0.0.1:${PORT}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ACCTS = ['EVAL-A', 'FUNDED-C', 'SIM-F1', 'SIM-F2', 'Sim101'];
const holding = async () => { const s = await control('state', { root: 'MNQ' }); return Object.entries(s.positions || {}).filter(([, p]) => p && p.qty).map(([k]) => k).sort(); };
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(() => {
    window.__sent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (['order', 'change', 'cancel', 'flatten', 'groupPreview', 'groupOrder'].includes(m.type)) window.__sent.push(Object.assign({ at: Date.now() }, m)); } catch (e) { /* not JSON */ } return send.call(this, d); };
  });
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  await p.goto(`http://localhost:${PORT}/live/?layout=Main`);
  await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
  await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live') && window.workspace.ticket().enabled && window.workspace.accountFeed() && window.workspace.accountFeed().accounts.length > 0, null, { timeout: 40000 });
  const flattens = () => p.evaluate(() => window.__sent.filter(m => m.type === 'flatten'));
  const clearSent = () => p.evaluate(() => { window.__sent.length = 0; });

  /* the top bar: Flatten all only (1.61.0), everything still inside 1366 */
  const bar = await p.evaluate(() => { const top = document.querySelector('.ws-top'), f = document.getElementById('wsFlat'), g = document.getElementById('wsSet');
    const r = x => x.getBoundingClientRect(); return { fits: top.scrollWidth <= top.clientWidth + 1, inside: r(f).right <= innerWidth && r(g).right <= innerWidth, every: !!document.getElementById('wsFlatEvery') || /Flatten every/.test(top.textContent), text: f.innerText, flatOff: f.disabled }; });
  check(bar.fits && bar.inside && !bar.every && bar.text === 'Flatten all', 'the top bar: Flatten all, no Flatten every account, the bar fits 1366: ' + JSON.stringify(bar));
  check(!bar.flatOff && (await p.evaluate(() => window.workspace.ticket().account)) === '', 'the ticket on None: Flatten all is on (it covers every account the charts trade)');

  /* something open on every account but EVAL-B (it goes Gone in the fake): Sim101, EVAL-A and the copier's followers SIM-F1 and
     SIM-F2 are checked for trading (trade accounts); FUNDED-C is not (as an account only Legion or NinjaTrader trades) */
  for (const R of ['MNQ', 'NQ', 'ES', 'MES']) await control('price', { root: R, p: R === 'ES' || R === 'MES' ? 6000 : 25000 });
  for (const a of ACCTS) for (const R of ['MNQ', 'NQ']) await control('elsewhere', { account: a, root: R, side: 'buy', kind: 'market', qty: 1, p: 0 });
  for (const a of ['SIM-F2', 'Sim101', 'EVAL-A']) await control('elsewhere', { account: a, root: 'ES', side: 'sell', kind: 'market', qty: 1, p: 0 });
  for (const a of ['Sim101', 'EVAL-A']) await control('elsewhere', { account: a, root: 'MES', side: 'buy', kind: 'market', qty: 1, p: 0 });
  const before = await until(async () => { const h = await holding(); return h.length >= 15 ? h : null; }, 'positions on every account', 8000);
  check(before && ACCTS.every(a => before.includes(a + '|MNQ') && before.includes(a + '|NQ')) && before.includes('Sim101|ES') && before.includes('EVAL-A|MES'), 'set up: MNQ and NQ held on ' + ACCTS.join(', ') + ', ES and MES on the trade accounts: ' + JSON.stringify(before));
  await wait(800);

  /* the review: a contract ChartBridge does not serve on a trade account (made up: EVAL-A in YM) is named, never sent */
  await control('unserved', { account: 'EVAL-A', names: 'YM 12-26' }); await wait(600);
  await clearSent();
  await p.focus('#wsFlat'); await p.keyboard.press('Enter'); await wait(400);
  check((await flattens()).length === 0, 'Enter on Flatten all sends nothing (a click only, as every order button)');

  /* the click: every trade account, Armed off, the ticket on None, no confirm, paced within 10 a second */
  check(!(await p.evaluate(() => window.workspace.ticket().armed)), 'Armed is off');
  await clearSent(); await wait(1200);
  await p.evaluate(() => {           // every note the ticket shows from here (an order message may replace it within a moment)
    window.__notes = [];
    const el = document.querySelector('.tk-note'), wn = document.getElementById('wsNote');
    for (const e of [el, wn].filter(Boolean)) new MutationObserver(() => window.__notes.push(e.textContent)).observe(e, { childList: true, characterData: true, subtree: true });
  });
  await p.click('#wsFlat');
  check(!(await p.$eval('#wsDialog', d => d.open)), 'no confirm: Flatten all acts on the click');
  const TRADE = ['EVAL-A', 'SIM-F1', 'SIM-F2', 'Sim101'], WANT = before.filter(k => TRADE.includes(k.split('|')[0])).sort();
  await until(async () => { const f = await flattens(); return f.length >= WANT.length ? f : null; }, 'every flatten sent', 6000);
  const note = await until(() => p.evaluate(() => window.__notes.find(t => /^Flatten all sent.*Not covered/.test(t)) || null), 'the note at the end of the run', 4000);
  check(!!note && /Not covered \(not served by ChartBridge\): EVAL-A YM 12-26/.test(note), 'the note names what it could not reach: ' + note);
  await wait(1500);
  const sent = (await flattens()).map(m => m.account + '|' + m.root).sort();
  check(JSON.stringify(sent) === JSON.stringify(WANT), 'every instrument on every trade account flattened (the copier\'s followers checked for trading too), whatever the ticket shows; nothing on FUNDED-C: ' + JSON.stringify(sent));
  const times = (await flattens()).map(m => m.at).sort((a, b) => a - b);
  let worst = 0;
  for (let i = 0; i < times.length; i++) worst = Math.max(worst, times.filter(t => t >= times[i] && t < times[i] + 1000).length);
  check(worst <= 10, 'paced: at most ' + worst + ' order actions in any second (' + times.length + ' flattens)');
  const left = await until(async () => { const h = await holding(); return h.every(k => !TRADE.includes(k.split('|')[0])) ? h : null; }, 'the trade accounts flat', 8000);
  check(!!left && JSON.stringify(left) === JSON.stringify(['FUNDED-C|MNQ', 'FUNDED-C|NQ']), 'the trade accounts end flat; FUNDED-C (not a trade account) keeps its own (Legion\'s Flatten, or NinjaTrader): ' + JSON.stringify(left));
  const unsent = await p.$eval('#wsUnsent', e => e.hidden ? '' : e.textContent).catch(() => '');
  check(!unsent, 'nothing was left unsent: ' + unsent);
  await p.screenshot({ path: path.join(out, 'flatten-all-done-1366.png') });

  /* a risk alert: the banner with one sound, never a dialog */
  const s0 = await p.evaluate(() => window.workspace.riskSounds());
  await control('risk-alert', { kind: 'dailyLoss', account: 'EVAL-A', text: 'Sample: EVAL-A reached its daily loss limit of $1,000.00 (daily room -$12.50): the bot, the agents and the copier send no new entry on it until the next trading day (18:00 ET). Your own orders are not held, and nothing was flattened.' });
  const banner = await until(async () => { const t = await p.$eval('#wsAlert', e => e.hidden ? '' : e.textContent); return /EVAL-A reached its daily loss/.test(t) ? t : null; }, 'the banner');
  await wait(600);
  const s1 = await p.evaluate(() => window.workspace.riskSounds());
  const red = await p.$eval('#wsAlert', e => !e.classList.contains('warn'));
  check(!!banner && s1 - s0 === 1 && red && !(await p.$eval('#wsDialog', d => d.open)), 'riskAlert: the banner (red for a daily loss) and one sound, though both connections bring it; no dialog: ' + (s1 - s0) + ' sound(s)');
  await control('risk-alert', { kind: 'skipped', account: 'SIM-F1', text: 'Sample: Copier: SIM-F1 skipped this copy: over SIM-F1\'s max of 2 micros (made up).' });
  await until(async () => /SIM-F1 skipped this copy/.test(await p.$eval('#wsAlert', e => e.textContent)), 'the second alert in the banner');
  await wait(400);
  check((await p.evaluate(() => window.workspace.riskSounds())) - s1 === 1, 'a held or skipped entry: one more sound, in the same banner');
  await p.screenshot({ path: path.join(out, 'flatten-all-alert-1366.png') });
  await ctx.close();
} catch (e) { fail('threw: ' + (e && e.stack || e)); }
finally { await browser.close(); bridge.kill(); }
console.log(errors.length ? errors.length + ' FAILED' : 'flatten-all smoke: all passed');
process.exit(errors.length ? 1 : 0);
