// Saved settings smoke test (B1: "NQ range set to 40 ticks was back to 20 after a reload"). Drives the live page in
// Chromium against the fake bridge and checks what comes back after a reload. It only uses controls the page has
// had since 1.1, so it can be run against an older checkout to show the old failures:
//   npm run smoke:settings        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
// Found on 1.3.1: (1) a size typed and not committed (no Enter, no click elsewhere) was never saved, and
// (2) a second chart tab wrote its whole in-memory copy of the sizes back, putting NQ back to 20.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.SETTINGS_SMOKE_PORT || 8793);
const errors = [];
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { if (!ok) fail(m); else console.log('  ok   ' + m); };
const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => bridge.stdout.once('data', r));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const live = p => p.waitForFunction(() => document.getElementById('connPill').textContent === 'LIVE', null, { timeout: 20000 });
const URL = `http://localhost:${PORT}/live/`;

async function newPage(ctx) {
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  await p.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await p.goto(URL); await live(p);
  return p;
}
async function pick(p, seg, text) {
  const pressed = await p.getAttribute(`#${seg} >> text="${text}"`, 'aria-pressed');
  if (pressed !== 'true') { await p.click(`#${seg} >> text="${text}"`); await live(p); }
  await p.waitForTimeout(300);
}
async function rangeAfterReload(p, rootSym) {
  await p.reload(); await live(p); await p.waitForTimeout(400);
  await pick(p, 'symSeg', rootSym); await pick(p, 'tfSeg', 'Range');
  return { box: await p.inputValue('#rangeTicks'), legend: (await p.textContent('#lgTf')).trim() };
}

try {
  // 1. type 40 on NQ and reload straight away: no Enter, no click elsewhere
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
    const p = await newPage(ctx);
    await pick(p, 'symSeg', 'NQ'); await pick(p, 'tfSeg', 'Range');
    await p.click('#rangeTicks', { clickCount: 3 }); await p.keyboard.type('40');
    const r = await rangeAfterReload(p, 'NQ');
    check(r.box === '40' && /Range 40t/.test(r.legend), 'typed 40 on NQ, reloaded at once: ' + JSON.stringify(r));
    // MNQ keeps its own size
    const m = await rangeAfterReload(p, 'MNQ');
    check(m.box === '20', 'MNQ still 20 while NQ is 40: ' + JSON.stringify(m));
    await ctx.close();
  }
  // 2. two chart tabs: A (NQ) sets 40 with Enter; B (MNQ, opened earlier) then sets its own size
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
    const a = await newPage(ctx), b = await newPage(ctx);
    await pick(b, 'symSeg', 'MNQ'); await pick(b, 'tfSeg', 'Range');
    await a.bringToFront(); await pick(a, 'symSeg', 'NQ'); await pick(a, 'tfSeg', 'Range');
    await a.fill('#rangeTicks', '40'); await a.press('#rangeTicks', 'Enter'); await a.waitForTimeout(500);
    await b.bringToFront(); await b.fill('#rangeTicks', '16'); await b.press('#rangeTicks', 'Enter'); await b.waitForTimeout(500);
    await a.bringToFront();
    const r = await rangeAfterReload(a, 'NQ');
    check(r.box === '40', 'NQ 40 kept after another tab saved MNQ 16: ' + JSON.stringify(r));
    const m = await rangeAfterReload(a, 'MNQ');
    check(m.box === '16', 'MNQ 16 from the other tab: ' + JSON.stringify(m));
    await ctx.close();
  }
  // 3. arrow keys and Tab also stick
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
    const p = await newPage(ctx);
    await pick(p, 'symSeg', 'ES'); await pick(p, 'tfSeg', 'Range');
    await p.focus('#rangeTicks'); for (let i = 0; i < 4; i++) await p.keyboard.press('ArrowUp');
    const r = await rangeAfterReload(p, 'ES');
    check(r.box === '12', 'ES 8 + four ArrowUp = 12 after reload: ' + JSON.stringify(r));
    await ctx.close();
  }
  // 4. first run after the update: the indicators and size chosen on 1.3 carry over, so the chart looks the same
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
    const p = await newPage(ctx);
    await p.evaluate(() => {
      localStorage.clear();
      localStorage.setItem('live-settings-v1', JSON.stringify({ root: 'NQ', tf: 'range', glide: 'smooth', layers: { volume: false, vwap: true, levels: false, fills: true } }));
      localStorage.setItem('live-range-v1', JSON.stringify({ MNQ: 20, NQ: 40, MES: 8, ES: 8 }));
    });
    await p.reload(); await live(p); await p.waitForTimeout(400);
    const layers = await p.evaluate(() => window.liveChart.getLayers());
    check(layers.volume === false && layers.vwap === true && layers.levels === false, '1.3 indicator choices carried over: ' + JSON.stringify(layers));
    check(await p.inputValue('#rangeTicks') === '40' && /Range 40t/.test(await p.textContent('#lgTf')), '1.3 NQ range 40 carried over');
    if (await p.$('#indCount')) check(await p.textContent('#indCount') === '2/4', 'indicator count 2/4');
    await ctx.close();
  }
} finally {
  await browser.close();
  bridge.kill();
}
if (errors.length) { console.error('FAIL\n' + errors.join('\n')); process.exit(1); }
console.log('settings smoke: ok');
