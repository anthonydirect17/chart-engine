// Chart 1.43.0 smoke (Anthony 2026-11-04, "merge on the chart"): a group MARKET entry fills each account at its own price (the
// fake bridge's made-up --market-slip: SIM-A at the last price, SIM-B 1 tick worse, SIM-C 2, SIM-D 5) and each account's bracket
// sits from its own fill, so the stops are 1 tick apart (SIM-D's 3 ticks from the next). Against the fake bridge (--mix-groups-full:
// the made-up Lucid group, sample data only), at 1366 x 768:
//   npm run smoke:group-merge        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
// Checks: SIM-A, SIM-B and SIM-C's stops (2 ticks in all) draw as ONE line at the stop nearest the entry, its quantity the sum,
// "Lucid ×3", its tooltip the range and each account's own price; SIM-D's stop, 3 ticks away, stays its own line; the same for the
// targets; a drag of the merged stop sends one change per member (SIM-A, SIM-B, SIM-C), every one to the price dropped at, and the
// ticket says each member's result; SIM-D's stop is not moved. Screenshots test/out/group-merge-lines-1366.png (the merged stop and
// target, at rest), group-merge-hover-1366.png (the merged stop's full label) and group-merge-moved-1366.png.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.GROUP_MERGE_SMOKE_PORT || 8802);
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const errors = [];
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, what, ms) => { const end = Date.now() + (ms || 10000); for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); } };
const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--v3', '--trading', '--test-controls', '--mix-groups-full', '--max-qty=MNQ:9,NQ:9',
  '--trade-accounts=SIM-A,SIM-B,SIM-C,SIM-D', '--market-slip=SIM-B:1,SIM-C:2,SIM-D:5', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => bridge.stdout.once('data', r));
const control = async (what, q) => (await fetch(`http://127.0.0.1:${PORT}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json().catch(() => ({}));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const tk = i => `[data-tk-id="${i}"]`;
const T = 0.25;
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(() => {
    window.__sent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (['order', 'change', 'cancel', 'flatten', 'groupPreview', 'groupOrder', 'plan'].includes(m.type)) window.__sent.push(m); } catch (e) { /* not JSON */ } return send.call(this, d); };
  });
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  await p.goto(`http://localhost:${PORT}/live/?layout=Main`);
  await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
  await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live') && window.workspace.ticket().enabled, null, { timeout: 40000 });
  const sent = types => p.evaluate(t => window.__sent.filter(m => t.includes(m.type)), types);
  const clearSent = () => p.evaluate(() => { window.__sent.length = 0; });
  await until(() => p.$eval(tk('oAcct'), s => [...s.options].some(o => o.value === 'group:g1')), 'the group in the ticket\'s picker');
  await p.selectOption(tk('oAcct'), 'group:g1');
  await p.selectOption(tk('root'), 'MNQ'); await wait(800);
  /* the price held, so the fills and the lines stay put (a made-up price near where the sample walk is) */
  const last0 = (await control('state', { root: 'MNQ' })).last;
  const P = Math.round(last0 / T) * T;
  await control('price', { root: 'MNQ', p: String(P) }); await wait(600);
  await p.fill(tk('bStop'), '20'); await p.press(tk('bStop'), 'Tab'); await p.fill(tk('bTarget'), '40'); await p.press(tk('bTarget'), 'Tab');
  if (!(await p.evaluate(() => window.workspace.ticket().armed))) { await p.click(tk('armBtn')); await wait(300); }
  await clearSent();
  await p.click(tk('buyMkt'));
  await until(async () => (await sent(['groupOrder']))[0], 'the MNQ groupOrder (no confirm: every account takes it)');
  const st = await until(async () => { const s = await control('state', { root: 'MNQ' }); const ps = ['SIM-A', 'SIM-B', 'SIM-C', 'SIM-D'].map(a => (s.positions || {})[a + '|MNQ'] || {}); return ps.every(x => x.qty > 0) && s.orders.filter(o => o.role === 'stop').length === 4 ? { s, ps } : null; }, 'every member filled with its bracket', 10000);
  if (!st) throw new Error('no fills');
  const fills = st.ps.map(x => x.avgPrice), qty = st.ps.map(x => x.qty);
  check(fills.map(f => Math.round((f - P) / T)).join(',') === '0,1,2,5', 'each account filled at its own price (made-up slippage 0, 1, 2 and 5 ticks): ' + fills.join(', '));
  const cid = await p.evaluate(() => { const c = window.workspace.panels().find(x => x.type === 'chart' && x.root === 'MNQ' && window.workspace.chart(x.id)); return c ? c.id : null; });
  const lines = await until(async () => { const os = await p.evaluate(i => window.workspace.chart(i).getOrders(), cid); return os.filter(o => o.role === 'stop').length === 2 && os.filter(o => o.role === 'target').length === 2 ? os : null; }, 'two stop lines and two target lines on the MNQ chart', 10000);
  if (!lines) throw new Error('no lines');
  const stops = lines.filter(o => o.role === 'stop').sort((a, b) => a.price - b.price), tgts = lines.filter(o => o.role === 'target').sort((a, b) => a.price - b.price);
  const abc = qty[0] + qty[1] + qty[2];
  check(stops[0].qty === abc && stops[0].group === 'Lucid ×3' && Math.abs(stops[0].price - (P + 2 * T - 20 * T)) < 1e-9,
    'SIM-A, SIM-B and SIM-C\'s stops (1 tick apart, 2 in all) are ONE line at the stop nearest the entry (SIM-C\'s), ' + abc + ' contracts, "Lucid ×3": ' + JSON.stringify(stops[0]));
  check(stops[1].qty === qty[3] && stops[1].group === 'Lucid ×1' && Math.abs(stops[1].price - (P + 5 * T - 20 * T)) < 1e-9, 'SIM-D\'s stop, 3 ticks from the next, stays its own line: ' + JSON.stringify(stops[1]));
  check(tgts[0].qty === abc && tgts[0].group === 'Lucid ×3' && Math.abs(tgts[0].price - (P + 40 * T)) < 1e-9, 'the targets the same: one line at the target nearest the entry (SIM-A\'s): ' + JSON.stringify(tgts[0]));
  check(tgts[1].qty === qty[3] && stops[0].parts && stops[0].parts.length === 3, 'SIM-D\'s target its own line; the merged stop carries each member\'s own order for its risk label');
  /* the risk label: the sum of each member's own risk, every one 20 ticks from its own fill: -20t, $2 a point (MNQ) */
  const want = '-$' + Math.round(abc * 20 * T * 2);
  const short = await p.evaluate(([i, id]) => { const ch = window.workspace.chart(i); const o = ch.getOrders().find(x => x.id === id); const pos = ch.getPosition(); return { o, pos }; }, [cid, stops[0].id]);
  console.log('  info: merged stop ' + stops[0].id + ' at ' + stops[0].price + ', the group position ' + JSON.stringify(short.pos) + ', the label should read "STP ' + abc + ' -20t ' + want + '"');
  /* the tooltip: hover the merged stop's label */
  const hoverOn = async id => {
    for (let k = 0; k < 3; k++) {
      const box = await p.locator('.ws-panel[data-id="' + cid + '"] canvas').first().boundingBox();
      const h = (await p.evaluate(i => window.workspace.chart(i).orderHandles(), cid)).find(x => x.id === id);
      if (!h) return { tip: '', h: null, box };
      await p.mouse.move(box.x + h.box.x + 8, box.y + h.box.y + h.box.h / 2); await wait(300);
      const tip = await p.$eval('.ws-panel[data-id="' + cid + '"] canvas', c => c.title);
      if (tip) return { tip, h, box };
    }
    return { tip: '', h: null, box: null };
  };
  const fp = x => x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  await p.mouse.move(5, 5); await wait(400);
  await p.locator('.ws-panel[data-id="' + cid + '"]').screenshot({ path: path.join(out, 'group-merge-lines-1366.png') });
  const hv = await hoverOn(stops[0].id);
  const range = 'SELL STP ' + fp(P - 20 * T) + ' to ' + fp(P + 2 * T - 20 * T) + ', the line at ' + fp(P + 2 * T - 20 * T) + ' (the nearest the entry)';
  const each = ['SIM-A', 'SIM-B', 'SIM-C'].map((a, k) => a + ' SELL STP ' + qty[k] + ' @ ' + fp(P + k * T - 20 * T)).join('\n');
  check(hv.tip === 'Group Lucid: ' + range + '\n' + each, 'its tooltip: the range, then each account\'s stop at its own price: ' + JSON.stringify(hv.tip));
  await p.locator('.ws-panel[data-id="' + cid + '"]').screenshot({ path: path.join(out, 'group-merge-hover-1366.png') });
  /* the drag: every member of the merged line to the one price dropped at; SIM-D's stop stays */
  await clearSent();
  if (hv.h) {
    const { h, box } = hv;
    await p.mouse.down(); await p.mouse.move(box.x + h.box.x + 8, box.y + h.box.y + h.box.h / 2 + 30, { steps: 6 }); await p.mouse.up(); await wait(700);
  }
  const ch = await sent(['change']);
  const ids = new Set(st.s.orders.filter(o => o.role === 'stop' && o.account !== 'SIM-D').map(o => o.id));
  check(ch.length === 3 && new Set(ch.map(m => m.price)).size === 1 && ch.every(m => ids.has(m.id)), 'a drag of the merged stop: one change per member (SIM-A, SIM-B, SIM-C), all to the price dropped at: ' + JSON.stringify(ch.map(m => m.id + ' ' + m.price)));
  const note = await until(async () => { const t = await p.$eval(tk('note'), e => e.textContent).catch(() => ''); return /^Group stops to [0-9.,]+: /.test(t) ? t : null; }, 'each member\'s result on the ticket', 5000);
  check(/^Group stops to [0-9.,]+: SIM-A, SIM-B, SIM-C moved\.$/.test(note || ''), 'each member\'s result said: ' + note);
  const after = await until(async () => { const s = await control('state', { root: 'MNQ' }); const ss = s.orders.filter(o => o.role === 'stop'); return ss.filter(o => o.account !== 'SIM-D').every(o => o.price === ch[0].price) ? ss : null; }, 'the three stops at the dropped price');
  check(!!after && after.find(o => o.account === 'SIM-D').price === P + 5 * T - 20 * T, 'SIM-D\'s stop was not moved');
  await p.mouse.move(5, 5); await wait(600);
  await p.locator('.ws-panel[data-id="' + cid + '"]').screenshot({ path: path.join(out, 'group-merge-moved-1366.png') });
  await p.click(tk('flattenBtn')); await wait(600);
  await ctx.close();
} catch (e) { fail('threw: ' + (e && e.stack || e)); }
finally { await browser.close(); bridge.kill(); }
console.log(errors.length ? errors.length + ' FAILED' : 'group-merge smoke: all passed');
process.exit(errors.length ? 1 : 0);
