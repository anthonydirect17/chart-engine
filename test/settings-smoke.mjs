// Saved settings smoke test (B1: "NQ range set to 40 ticks was back to 20 after a reload"). Drives a mounted chart with its
// toolbar (test/chart-host.html; the single chart page until chart 1.21.0) in Chromium against the fake bridge and checks
// what comes back after a reload:
//   npm run smoke:settings        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
// Found on 1.3.1: (1) a size typed and not committed (no Enter, no click elsewhere) was never saved, and
// (2) a second chart tab wrote its whole in-memory copy of the sizes back, putting NQ back to 20.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { C, hostUrl, waitLive, view } from './chart-host.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.SETTINGS_SMOKE_PORT || 8793);
const errors = [];
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { if (!ok) fail(m); else console.log('  ok   ' + m); };
const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--pin-off'], { stdio: ['ignore', 'pipe', 'inherit'] });   // a mounted chart never has the PIN
await new Promise(r => bridge.stdout.once('data', r));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const live = p => waitLive(p);
const URL = hostUrl(PORT);

async function newPage(ctx) {
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  await p.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await p.goto(URL); await live(p);
  return p;
}
async function pick(p, seg, text) {
  const pressed = await p.getAttribute(`${C(seg)} >> text="${text}"`, 'aria-pressed');
  if (pressed !== 'true') { await p.click(`${C(seg)} >> text="${text}"`); await live(p); }
  await p.waitForTimeout(300);
}
async function rangeAfterReload(p, rootSym) {
  await p.reload(); await live(p); await p.waitForTimeout(400);
  await pick(p, 'symSeg', rootSym); await pick(p, 'tfSeg', 'Range');
  return { box: await p.inputValue(C('rangeTicks')), range: (await view(p)).range };
}

try {
  // 1. type 40 on NQ and reload straight away: no Enter, no click elsewhere
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
    const p = await newPage(ctx);
    await pick(p, 'symSeg', 'NQ'); await pick(p, 'tfSeg', 'Range');
    await p.click(C('rangeTicks'), { clickCount: 3 }); await p.keyboard.type('40');
    const r = await rangeAfterReload(p, 'NQ');
    check(r.box === '40' && r.range === 40, 'typed 40 on NQ, reloaded at once: ' + JSON.stringify(r));
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
    await a.fill(C('rangeTicks'), '40'); await a.press(C('rangeTicks'), 'Enter'); await a.waitForTimeout(500);
    await b.bringToFront(); await b.fill(C('rangeTicks'), '16'); await b.press(C('rangeTicks'), 'Enter'); await b.waitForTimeout(500);
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
    await p.focus(C('rangeTicks')); for (let i = 0; i < 4; i++) await p.keyboard.press('ArrowUp');
    const r = await rangeAfterReload(p, 'ES');
    check(r.box === '12', 'ES 8 + four ArrowUp = 12 after reload: ' + JSON.stringify(r));
    await ctx.close();
  }
  // 5. half-typed sizes (review S1): never saved as a stale prefix, never rebuilt while typing
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
    const p = await newPage(ctx);
    await pick(p, 'symSeg', 'NQ'); await pick(p, 'tfSeg', 'Range');
    const storedNQ = () => p.evaluate(() => (JSON.parse(localStorage.getItem('live-range-v2') || '{}') || {}).NQ);
    // count chart rebuilds (setBars) from here on
    await p.evaluate(() => { const c = window.liveChart, f = c.setBars; window.__rebuilds = 0; c.setBars = function () { window.__rebuilds++; return f.apply(this, arguments); }; });
    const rebuilds = () => p.evaluate(() => window.__rebuilds);
    // a slow "12": no rebuild at 1, none at 12 until Enter
    await p.click(C('rangeTicks'), { clickCount: 3 }); await p.keyboard.type('1'); await p.waitForTimeout(700);
    check(await rebuilds() === 0 && (await view(p)).range === 20, 'slow "1": no rebuild at 1 tick (' + await rebuilds() + ' rebuilds)');
    await p.keyboard.type('2'); await p.waitForTimeout(700);
    check(await rebuilds() === 0, 'typed "12": still no rebuild before Enter');
    check(await storedNQ() === 12, 'typed "12" is saved for a reload: ' + await storedNQ());
    await p.keyboard.press('Enter'); await p.waitForTimeout(400);
    check(await rebuilds() === 1 && (await view(p)).range === 12, 'Enter: one rebuild at 12 (' + await rebuilds() + ')');
    // "450": the "45" on the way is dropped when the "0" makes it invalid; a reload commits it like Enter (400)
    await p.click(C('rangeTicks'), { clickCount: 3 }); await p.keyboard.type('45'); await p.waitForTimeout(700);
    check(await storedNQ() === 45, '"45" typed and waiting is saved: ' + await storedNQ());
    await p.keyboard.type('0'); await p.waitForTimeout(700);
    check(await storedNQ() === 12, '"450" drops the saved 45, keeps the committed 12: ' + await storedNQ());
    let r = await rangeAfterReload(p, 'NQ');
    check(r.box === '400', '"450" then reload: 400, as Enter would give, never 45: ' + JSON.stringify(r));
    // reload mid-typing: "7" saved after a pause, then "5" and an immediate reload gives 75, not the stale 7
    await p.click(C('rangeTicks'), { clickCount: 3 }); await p.keyboard.type('7'); await p.waitForTimeout(700);
    await p.keyboard.type('5');
    r = await rangeAfterReload(p, 'NQ');
    check(r.box === '75' && r.range === 75, 'reload mid-typing keeps what was in the box: ' + JSON.stringify(r));
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
    check(layers.volume === false && layers.vwap === true && layers.levels === true && layers.ib === true, '1.3 indicator choices carried over (Levels on with only the IB lines, as 1.13 drew the IB on by default): ' + JSON.stringify(layers));
    check(await p.inputValue(C('rangeTicks')) === '40' && (await view(p)).range === 40, '1.3 NQ range 40 carried over');
    // 1.3 had no IB: the main pane gets the Initial balance default (on, 1.5.3), so 2 of the 1.3 four plus IB; since 1.6.0 the two
    // that were off stay on the main pane's chart, hidden; since 1.7.0 the delta pane is on too (shown/on: 4/6)
    check(await p.textContent(C('indCount')) === '4/5' && layers.delta === true, 'indicator count 4/5 (the IB in Levels and the delta pane on by default)');
    const lvNames = await p.evaluate(() => window.liveChart.getLevels().filter(l => l.layer !== 'ib').map(l => l.name));
    check(lvNames.length === 0, 'only the IB lines of Levels drawn: ' + JSON.stringify(lvNames));
    await ctx.close();
  }
} finally {
  await browser.close();
  bridge.kill();
}
if (errors.length) { console.error('FAIL\n' + errors.join('\n')); process.exit(1); }
console.log('settings smoke: ok');
