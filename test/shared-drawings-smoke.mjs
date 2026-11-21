// Chart 1.61.0 smoke (Anthony 2026-11-20: "I would like the lines that I draw to have the OPTION to be shared across charts, maybe an
// option on each chart to have drawings on / off or something like that. I would like to see that daily level I marked on my execution
// chart (when needed) not all the time"; he chose the per-chart switch). In the workspace against the fake bridge (sample data only),
// three MNQ charts and an NQ chart, at 1366 x 768:
//   - every chart's "Shared drawings" switch (its menu, the chart header's More) starts off: a line drawn on one chart shows on no other;
//   - switched on, a chart also shows the lines of every other MNQ chart (never the NQ chart's), and the switch is kept after a reload;
//   - a line drawn on a chart with the switch on is its own (a chart with the switch off does not show it);
//   - a line of another chart deleted there (select it, Delete) is gone from the chart that drew it too;
//   - "Clear this chart" (the drawing ring) on a chart with the switch on clears its own lines only;
//   - switched off again, the chart shows its own lines only.
// Screenshots test/out/shared-drawings-*.png.
//   npm run smoke:shared-drawings      (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser; SHARED_DRAWINGS_SMOKE_PORT)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const PORT = +(process.env.SHARED_DRAWINGS_SMOKE_PORT || 8871);
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms) {
  const end = Date.now() + (ms || 10000);
  for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); }
}
const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--test-controls', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => bridge.stdout.once('data', r));
const LAYOUT = [
  { id: 'a1', type: 'chart', root: 'MNQ', tf: 'm5', x: 0, y: 0, w: 6, h: 3 },
  { id: 'a2', type: 'chart', root: 'MNQ', tf: 'm1', x: 6, y: 0, w: 6, h: 3 },
  { id: 'a3', type: 'chart', root: 'MNQ', tf: 'range', range: 40, x: 0, y: 3, w: 6, h: 3 },
  { id: 'n1', type: 'chart', root: 'NQ', tf: 'm1', x: 6, y: 3, w: 6, h: 3 },
];
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(([layouts]) => { try { if (!localStorage.getItem('live-workspace-v1')) localStorage.setItem('live-workspace-v1', JSON.stringify({ v: 1, layouts })); } catch (e) { /* blocked */ } }, [{ Main: { panels: LAYOUT } }]);
  const open = async () => {
    const p = await ctx.newPage();
    p.on('pageerror', e => fail('pageerror: ' + e.message));
    await p.goto(`http://localhost:${PORT}/live/?layout=Main`);
    await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
    await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live') && ['a1', 'a2', 'a3', 'n1'].every(i => window.workspace.chart(i) && window.workspace.chart(i).bars().length > 5), null, { timeout: 40000 });
    await wait(800);
    return p;
  };
  let p = await open();
  const ids = id => p.evaluate(i => window.workspace.chart(i).getDrawings().map(d => d.type + (d.type === 'hline' ? ':' + d.price : '')), id);
  const box = async id => p.locator(`.ws-panel[data-id="${id}"] canvas`).first().boundingBox();
  const priceLine = async (id, fy) => {
    const b = await box(id);
    await p.evaluate(i => window.workspace.chart(i).setTool('hline'), id);
    await p.mouse.click(b.x + b.width * 0.4, b.y + b.height * fy);
    await wait(250);
  };
  const menu = async (id, act) => {
    await p.click(`.ws-panel[data-id="${id}"] [data-act="more"]`);
    await until(() => p.$eval('#wsMore', m => !m.hidden), 'the chart\'s menu');
    const text = await p.$eval('#wsMore [data-do="shared"]', b => b.textContent);
    if (act) await p.click('#wsMore [data-do="shared"]'); else await p.keyboard.press('Escape');
    await wait(300);
    return text;
  };

  /* off by default: a line on a1 shows on no other chart */
  check((await menu('a2')) === 'Shared drawings: off' && (await menu('a1')) === 'Shared drawings: off', 'every chart starts with Shared drawings off (its menu says so)');
  await priceLine('a1', 0.3);
  const line = (await ids('a1'))[0];
  check(/^hline:/.test(line || ''), 'a price line drawn on a1: ' + line);
  check((await ids('a2')).length === 0 && (await ids('a3')).length === 0 && (await ids('n1')).length === 0, 'with the switch off no other chart shows it');

  /* a2 on: a1's line shows there; a3 (off) and the NQ chart still none */
  check((await menu('a2', true)) === 'Shared drawings: off', 'a2: switched on from its menu');
  const on2 = await until(async () => { const d = await ids('a2'); return d.includes(line) ? d : null; }, 'a1\'s line on a2');
  check(!!on2 && on2.length === 1, 'a2 (switch on) shows a1\'s line: ' + JSON.stringify(on2));
  check((await ids('a3')).length === 0 && (await ids('n1')).length === 0, 'a3 (switch off) and the NQ chart do not');
  check((await menu('a2')) === 'Shared drawings: on', 'a2\'s menu says on');
  await p.screenshot({ path: path.join(out, 'shared-drawings-on-1366.png') });

  /* a line drawn on a2 (switch on) is a2's own: a1 (off) does not show it; a3 switched on shows both */
  await priceLine('a2', 0.7);
  const mine = (await ids('a2')).find(x => x !== line);
  check(!!mine && (await ids('a1')).length === 1, 'a line drawn on a2 is a2\'s own: a1 (off) still shows only its own: ' + mine);
  await menu('a3', true);
  const on3 = await until(async () => { const d = await ids('a3'); return d.length === 2 ? d : null; }, 'both lines on a3');
  check(!!on3 && on3.includes(line) && on3.includes(mine), 'a3 switched on shows a1\'s and a2\'s lines: ' + JSON.stringify(on3));

  /* kept after a reload */
  await p.close();
  p = await open();
  check((await ids('a2')).length === 2 && (await ids('a3')).length === 2 && (await ids('a1')).length === 1 && (await ids('n1')).length === 0, 'after a reload: a2 and a3 still on (both lines), a1 off (its own), NQ none');

  /* a1's line deleted on a3: select it, Delete; gone from a1 too, and from a2 */
  const b3 = await box('a3');
  const y = await p.evaluate(([i, pr]) => window.workspace.chart(i).priceToY(pr), ['a3', +line.split(':')[1]]);
  await p.mouse.click(b3.x + b3.width * 0.3, b3.y + y);
  await wait(150);
  await p.keyboard.press('Delete');
  const gone = await until(async () => (await ids('a1')).length === 0 && !(await ids('a2')).includes(line) && !(await ids('a3')).includes(line), 'a1\'s line deleted everywhere');
  check(!!gone, 'a1\'s line deleted on a3: gone from a1, a2 and a3');
  check((await ids('a2')).includes(mine) && (await ids('a3')).includes(mine), 'a2\'s line stays');

  /* Clear this chart (the ring) on a3 clears a3's own only */
  await priceLine('a3', 0.5);
  const own3 = (await ids('a3')).find(x => x !== mine);
  check(!!own3 && (await ids('a2')).includes(own3), 'a line drawn on a3 shows on a2 (on): ' + own3);
  await p.mouse.move(b3.x + b3.width * 0.4, b3.y + b3.height * 0.4);
  await p.mouse.down({ button: 'middle' }); await p.mouse.up({ button: 'middle' }); await wait(200);
  await p.click('#wsRing [data-ring="clear"]');
  const cleared = await until(async () => { const d = await ids('a3'); return d.length === 1 && d[0] === mine ? d : null; }, 'a3 cleared of its own');
  check(!!cleared && (await ids('a2')).includes(mine) && !(await ids('a2')).includes(own3), 'Clear this chart on a3: its own line gone (from a2 too), a2\'s line stays on both');
  const note = await p.$eval('#wsNote', e => e.textContent);
  check(/Drawings cleared on MNQ Range 40\. The other charts' lines stay\./.test(note), 'the note says the other charts\' lines stay: ' + note);

  /* off again: its own lines only */
  await menu('a3', true);
  const off3 = await until(async () => (await ids('a3')).length === 0 ? true : null, 'a3 off: none of its own');
  check(!!off3 && (await menu('a3')) === 'Shared drawings: off', 'a3 switched off: it shows its own lines only (none left)');
  check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll at 1366');
  await p.screenshot({ path: path.join(out, 'shared-drawings-off-1366.png') });
  await ctx.close();
} catch (e) { fail('threw: ' + (e && e.stack || e)); }
finally { await browser.close(); bridge.kill(); }
console.log(errors.length ? errors.length + ' FAILED' : 'shared-drawings smoke: all ' + checks + ' checks passed');
process.exit(errors.length ? 1 : 0);
