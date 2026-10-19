// Chart 1.33.0 and ChartBridge 0.6.5 smoke (Anthony 2026-10-19, "Trade the group"): the order ticket picks a group, one entry
// with its bracket stop goes to every member, each sized by ChartBridge from the group's risk percent of its own max loss. Against
// the fake bridge (--mix-groups-full: a made-up Lucid group, risk 10%, SIM-A 150K, SIM-B 50K, SIM-C 25K intraday, SIM-D on the
// group's rules; sample data only), at 1366 x 768:
//   npm run smoke:group-ticket       (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
// Checks: the picker lists the group; no stop: refused before anything is sent; Buy asks ChartBridge (groupPreview) and the one
// confirm shows each account's size, dollar risk and budget; Enter never sends; Cancel sends nothing; Send sends groupOrder with
// the sizes shown and every member gets its own entry; Close flattens every member. Screenshot test/out/group-ticket-confirm-1366.png.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.GROUP_TICKET_SMOKE_PORT || 8801);
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const errors = [];
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, what, ms) => { const end = Date.now() + (ms || 10000); for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); } };
const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--v3', '--trading', '--test-controls', '--mix-groups-full', '--max-qty=MNQ:9,NQ:9', '--trade-accounts=SIM-A,SIM-B,SIM-C,SIM-D', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => bridge.stdout.once('data', r));
const control = async (what, q) => (await fetch(`http://127.0.0.1:${PORT}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
const groupMsgs = async () => ((await control('received')).groupMsgs || []);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const tk = i => `[data-tk-id="${i}"]`;
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(() => {
    window.__sent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (['order', 'change', 'cancel', 'flatten', 'groupPreview', 'groupOrder'].includes(m.type)) window.__sent.push(m); } catch (e) { /* not JSON */ } return send.call(this, d); };
  });
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  await p.goto(`http://localhost:${PORT}/live/?layout=Main`);
  await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
  await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live') && window.workspace.ticket().enabled, null, { timeout: 40000 });
  const sent = types => p.evaluate(t => window.__sent.filter(m => t.includes(m.type)), types);
  const clearSent = () => p.evaluate(() => { window.__sent.length = 0; });
  /* the picker: the group after the accounts */
  const opt = await until(() => p.$eval(tk('oAcct'), s => [...s.options].map(o => o.value + '=' + o.textContent).find(x => x.startsWith('group:'))), 'the group in the ticket\'s picker');
  check(opt === 'group:g1=Group Lucid (4)', 'the ticket\'s picker lists the group: ' + opt);
  await p.selectOption(tk('oAcct'), 'group:g1');
  await p.selectOption(tk('root'), 'NQ'); await wait(600);
  await p.fill(tk('bStop'), '0'); await p.press(tk('bStop'), 'Tab');
  await p.click(tk('armBtn')); await wait(400);
  await clearSent();
  await p.click(tk('buyMkt')); await wait(400);
  const note0 = await p.$eval(tk('note'), e => e.textContent).catch(() => '');
  check((await sent(['groupPreview', 'groupOrder', 'order'])).length === 0 && /a group entry needs a stop/.test(note0), 'no stop: nothing sent, the ticket says why: ' + note0);
  await p.fill(tk('bStop'), '20'); await p.press(tk('bStop'), 'Tab');
  await p.fill(tk('bTarget'), '40'); await p.press(tk('bTarget'), 'Tab');
  if (!(await p.evaluate(() => window.workspace.ticket().armed))) { await p.click(tk('armBtn')); await wait(300); }
  await clearSent();
  await p.click(tk('buyMkt'));
  await until(() => p.$eval('#wsDialog', d => d.open && !!d.querySelector('.ws-gq')), 'the group entry\'s confirm');
  const rows = await p.$$eval('.ws-gq tbody tr', trs => trs.map(t => [...t.children].map(c => c.textContent).join(' | ')));
  check(JSON.stringify(rows) === JSON.stringify(['SIM-A | 4 NQ | $400 | $450 | ', 'SIM-B | 2 NQ | $200 | $200 | ', 'SIM-C | 1 NQ | $100 | $100 | ', 'SIM-D | 2 NQ | $200 | $200 | ']),
    'the confirm: each account\'s size and dollar risk (10% of its own max loss / $100 a contract at 20 ticks): ' + JSON.stringify(rows));
  const pv = (await sent(['groupPreview']))[0];
  check(pv && pv.group === 'g1' && pv.root === 'NQ' && pv.side === 'buy' && pv.kind === 'market' && pv.bracket.stop === 20 && (await sent(['groupOrder', 'order'])).length === 0, 'Buy asked ChartBridge for the sizes (groupPreview) and sent no order: ' + JSON.stringify(pv));
  const fit = await p.$eval('.ws-gq', f => { const r = f.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && f.scrollWidth <= f.clientWidth + 1; });
  check(fit, 'the confirm fits 1366 x 768');
  await p.screenshot({ path: path.join(out, 'group-ticket-confirm-1366.png') });
  await p.focus('#gqSend'); await p.keyboard.press('Enter'); await wait(400);
  check((await sent(['groupOrder'])).length === 0, 'Enter on Send sends nothing (a click only, as every order button)');
  await p.click('.ws-gq [data-act="cancel"]'); await wait(400);
  check((await sent(['groupOrder', 'order'])).length === 0 && !(await p.$eval('#wsDialog', d => d.open)), 'Cancel: the confirm closes, nothing sent');
  /* again, then Send */
  await clearSent();
  await p.click(tk('buyMkt'));
  await until(() => p.$eval('#wsDialog', d => d.open && !!d.querySelector('.ws-gq')), 'the confirm again');
  await p.click('#gqSend');
  const go = await until(async () => (await sent(['groupOrder']))[0], 'groupOrder');
  check(go && go.sizes === '4,2,1,2' && go.bracket.stop === 20 && go.bracket.target === 40, 'Send: groupOrder with the sizes shown: ' + JSON.stringify(go));
  const pos = await until(async () => { const s = await control('state', { root: 'NQ' }); const q = ['SIM-A', 'SIM-B', 'SIM-C', 'SIM-D'].map(a => ((s.positions || {})[a + '|NQ'] || {}).qty || 0); return q.every(x => x > 0) ? q : null; }, 'every member filled', 8000);
  const note1 = await p.$eval(tk('note'), e => e.textContent).catch(() => '');
  check(JSON.stringify(pos) === '[4,2,1,2]' || /placed SIM-A 4, SIM-B 2, SIM-C 1, SIM-D 2/.test(note1), 'every member got its own entry at its own size: ' + JSON.stringify(pos) + ' ' + note1);
  await p.screenshot({ path: path.join(out, 'group-ticket-placed-1366.png') });
  /* answer 1: the group's lines on an MNQ chart: one per level, "STP n · Lucid ×4", each account in the tooltip; a drag moves each */
  await p.click(tk('flattenBtn')); await wait(800);
  await p.selectOption(tk('root'), 'MNQ'); await wait(800);
  await p.fill(tk('bStop'), '20'); await p.press(tk('bStop'), 'Tab'); await p.fill(tk('bTarget'), '40'); await p.press(tk('bTarget'), 'Tab');
  if (!(await p.evaluate(() => window.workspace.ticket().armed))) { await p.click(tk('armBtn')); await wait(300); }
  await clearSent();
  await p.click(tk('buyMkt'));
  await wait(800); console.log('  info: ' + await p.$eval(tk('note'), e => e.textContent).catch(() => ''));
  await until(() => p.$eval('#wsDialog', d => d.open && !!d.querySelector('.ws-gq')), 'the MNQ confirm');
  await p.click('#gqSend');
  const cid = await p.evaluate(() => { const c = window.workspace.panels().find(x => x.type === 'chart' && x.root === 'MNQ' && window.workspace.chart(x.id)); return c ? c.id : null; });
  const stopLine = await until(async () => { const hs = await p.evaluate(i => window.workspace.chart(i).orderHandles(), cid); return hs.find(h => /^G~stop~/.test(h.id)); }, 'the group stop line on the MNQ chart', 10000);
  check(!!stopLine, 'the group\'s stop line is drawn: ' + JSON.stringify(stopLine && stopLine.id));
  if (stopLine) {
    const box = await p.locator('.ws-panel[data-id="' + cid + '"] canvas').first().boundingBox();
    await p.mouse.move(box.x + stopLine.box.x + 8, box.y + stopLine.box.y + stopLine.box.h / 2); await wait(300);
    const tip = await p.$eval('.ws-panel[data-id="' + cid + '"] canvas', c => c.title);
    check(/^Group Lucid: SIM-A SELL STP \d+ @ [0-9.,]+\nSIM-B SELL STP \d+ @ [0-9.,]+\nSIM-C SELL STP \d+ @ [0-9.,]+\nSIM-D SELL STP \d+ @ [0-9.,]+$/.test(tip), 'its tooltip lists each account\'s stop: ' + JSON.stringify(tip));
    await p.screenshot({ path: path.join(out, 'group-ticket-lines-1366.png') });
    await clearSent();
    await p.mouse.down(); await p.mouse.move(box.x + stopLine.box.x + 8, box.y + stopLine.box.y + stopLine.box.h / 2 + 30, { steps: 6 }); await p.mouse.up(); await wait(700);
    const ch = await sent(['change']);
    const prices = [...new Set(ch.map(m => m.price))];
    check(ch.length === 4 && prices.length === 1, 'a drag of the group stop: one change per member, all to the same price: ' + JSON.stringify(ch.map(m => m.id + ' ' + m.price)));
    await wait(2000);
    const note2 = await p.$eval(tk('note'), e => e.textContent).catch(() => '');
    check(/^Group stops to [0-9.,]+: SIM-A, SIM-B, SIM-C, SIM-D moved\.$/.test(note2), 'each member\'s result said: ' + note2);
    await p.screenshot({ path: path.join(out, 'group-ticket-moved-1366.png') });
  }
  /* Close: every member's own position */
  await clearSent();
  await p.click(tk('flattenBtn')); await wait(500);
  const fl = (await sent(['flatten'])).map(m => m.account + ' ' + m.root).sort();
  check(JSON.stringify(fl) === JSON.stringify(['SIM-A MNQ', 'SIM-B MNQ', 'SIM-C MNQ', 'SIM-D MNQ']), 'Close on the group: a Flatten for every member: ' + JSON.stringify(fl));
  await ctx.close();
} catch (e) { fail('threw: ' + (e && e.stack || e)); }
finally { await browser.close(); bridge.kill(); }
console.log(errors.length ? errors.length + ' FAILED' : 'group-ticket smoke: all passed');
process.exit(errors.length ? 1 : 0);
