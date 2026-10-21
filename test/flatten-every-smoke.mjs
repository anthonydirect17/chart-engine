// Chart 1.34.0 and ChartBridge 0.6.6 smoke (Anthony 2026-10-20): Flatten every account, and the risk alert's banner and sound.
// Against the fake bridge (--v3: made-up accounts EVAL-A, EVAL-B, FUNDED-C, SIM-F1, SIM-F2, Sim101, trade accounts Sim101 and
// EVAL-A only; sample data only), at 1366 x 768:
//   npm run smoke:flatten-every       (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
// Checks: the button sits in the top bar beside Flatten all and the bar still fits; with the ticket on None Flatten all stays off
// and sends nothing while Flatten every account is on; one confirm lists every account with something open (FUNDED-C and the
// copier's follower SIM-F1 are not trade accounts), Enter and Cancel send nothing; the click flattens every one of them with Armed
// off, whatever the ticket shows, never more than 10 order actions in any second, and every account ends flat; a riskAlert shows the
// banner once per window (both connections bring it) with one sound, and no dialog. Screenshots test/out/flatten-every-*.png.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.FLATTEN_EVERY_SMOKE_PORT || 8803);
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

  /* the top bar: the button beside Flatten all, everything still inside 1366 */
  const bar = await p.evaluate(() => { const top = document.querySelector('.ws-top'), f = document.getElementById('wsFlat'), e = document.getElementById('wsFlatEvery'), g = document.getElementById('wsSet');
    const r = x => x.getBoundingClientRect(); return { fits: top.scrollWidth <= top.clientWidth + 1, next: r(e).left >= r(f).right && r(e).left - r(f).right < 24, inside: r(e).right <= innerWidth && r(g).right <= innerWidth, text: e.innerText, label: e.getAttribute('aria-label'), flatOff: f.disabled, everyOff: e.disabled }; });
  check(bar.fits && bar.next && bar.inside && bar.text === 'Flatten every' && bar.label === 'Flatten every account', 'the top bar: Flatten every account beside Flatten all (its short label under 1440 wide), the bar fits 1366: ' + JSON.stringify(bar));
  check(bar.flatOff && !bar.everyOff && (await p.evaluate(() => window.workspace.ticket().account)) === '', 'the ticket on None: Flatten all is off (it sends nothing there), Flatten every account is on');

  /* something open on every account but EVAL-B (it goes Gone in the fake): the follower SIM-F1 and FUNDED-C are not trade accounts */
  for (const R of ['MNQ', 'NQ', 'ES']) await control('price', { root: R, p: R === 'ES' ? 6000 : 25000 });
  for (const a of ACCTS) for (const R of ['MNQ', 'NQ']) await control('elsewhere', { account: a, root: R, side: 'buy', kind: 'market', qty: 1, p: 0 });
  for (const a of ['SIM-F2', 'Sim101']) await control('elsewhere', { account: a, root: 'ES', side: 'sell', kind: 'market', qty: 1, p: 0 });   // 12 to flatten: past one second's 10
  const before = await until(async () => { const h = await holding(); return h.length >= 12 ? h : null; }, 'positions on every account', 8000);
  check(before && ACCTS.every(a => before.includes(a + '|MNQ') && before.includes(a + '|NQ')) && before.includes('Sim101|ES'), 'set up: MNQ and NQ held on ' + ACCTS.join(', ') + ', ES on two: ' + JSON.stringify(before));
  await wait(800);

  /* the review: a contract ChartBridge does not serve (made up: FUNDED-C in YM) is named, never sent */
  await control('unserved', { account: 'FUNDED-C', names: 'YM 12-26' }); await wait(600);
  /* one confirm, listing each account and what it holds */
  await clearSent();
  await p.click('#wsFlatEvery');
  await until(() => p.$eval('#wsDialog', d => d.open && !!d.querySelector('.ws-fe')), 'the confirm');
  const rows = await p.$$eval('.ws-fe .fe-list li', ls => ls.map(l => l.textContent));
  check(ACCTS.every(a => rows.some(r => r.startsWith(a + ' ') && /MNQ/.test(r) && /NQ/.test(r))) && (await flattens()).length === 0, 'one confirm, nothing sent yet: every account with something open, FUNDED-C and the follower SIM-F1 too: ' + JSON.stringify(rows));
  const missedLine = await p.$eval('.ws-fe', f => (f.querySelector('.fe-missed') || {}).textContent || '');
  check(missedLine === 'Not covered (not served by ChartBridge): FUNDED-C YM 12-26', 'the confirm names what it cannot reach: ' + missedLine);
  const fit = await p.$eval('.ws-fe', f => { const r = f.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && f.scrollWidth <= f.clientWidth + 1; });
  check(fit, 'the confirm fits 1366 x 768');
  await p.screenshot({ path: path.join(out, 'flatten-every-confirm-1366.png') });
  await p.focus('#feGo'); await p.keyboard.press('Enter'); await wait(400);
  check((await flattens()).length === 0, 'Enter on its button sends nothing (a click only, as every order button)');
  await p.click('.ws-fe [data-act="cancel"]'); await wait(400);
  check((await flattens()).length === 0 && !(await p.$eval('#wsDialog', d => d.open)), 'Cancel: the confirm closes, nothing sent');

  /* the click: every account, Armed off, paced within 10 a second */
  check(!(await p.evaluate(() => window.workspace.ticket().armed)), 'Armed is off');
  await clearSent(); await wait(1200);
  await p.click('#wsFlatEvery');
  await until(() => p.$eval('#wsDialog', d => d.open && !!d.querySelector('.ws-fe')), 'the confirm again');
  await p.click('#feGo');
  const all = await until(async () => { const f = await flattens(); return f.length >= 12 ? f : null; }, 'every flatten sent', 6000);
  await wait(1500);
  const sent = (await flattens()).map(m => m.account + '|' + m.root);
  check(ACCTS.every(a => sent.includes(a + '|MNQ') && sent.includes(a + '|NQ')), 'every account flattened on both instruments, whatever the ticket shows: ' + JSON.stringify(sent.slice().sort()));
  const times = (await flattens()).map(m => m.at).sort((a, b) => a - b);
  let worst = 0;
  for (let i = 0; i < times.length; i++) worst = Math.max(worst, times.filter(t => t >= times[i] && t < times[i] + 1000).length);
  check(all && times.length >= 12 && worst <= 10 && times[times.length - 1] - times[0] >= 900, 'paced (12 to flatten): at most ' + worst + ' order actions in any second (' + times.length + ' flattens)');
  const flat = await until(async () => { const h = await holding(); return h.length === 0 ? true : null; }, 'every account flat', 8000);
  check(!!flat, 'every account ends flat');
  const note = await p.$eval('#wsUnsent', e => e.hidden ? '' : e.textContent).catch(() => '');
  check(!note, 'nothing was left unsent: ' + note);
  await p.screenshot({ path: path.join(out, 'flatten-every-done-1366.png') });

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
  await p.screenshot({ path: path.join(out, 'flatten-every-alert-1366.png') });
  await ctx.close();
} catch (e) { fail('threw: ' + (e && e.stack || e)); }
finally { await browser.close(); bridge.kill(); }
console.log(errors.length ? errors.length + ' FAILED' : 'flatten-every smoke: all passed');
process.exit(errors.length ? 1 : 0);
