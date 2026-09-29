// Live page smoke test against the fake bridge (test/fake-bridge.mjs) acting as ChartBridge 0.2 (protocol v1,
// read only), so the page is checked to work exactly as before. Order entry: test/orders-smoke.mjs.
// Screenshots in test/out/.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const PORT = 8799;
const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--v1'], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => bridge.stdout.once('data', r));
const errors = [];
const fail = m => errors.push(m);
let browser = null;
try {
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
  page.on('pageerror', e => fail('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fail('console: ' + m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.goto(`http://localhost:${PORT}/live/`);
  await page.waitForFunction(() => document.getElementById('connPill').textContent === 'LIVE', null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  if (!(await page.isHidden('#obar'))) fail('order bar shown with a read-only ChartBridge');
  const legend = (await page.textContent('#legend')).replace(/\s+/g, ' ');
  if (!/MNQ 12-26/.test(legend)) fail('legend missing contract: ' + legend);
  if (!/Last fill (BUY|SELL)/.test(legend)) fail('legend missing last fill: ' + legend);
  await page.screenshot({ path: path.join(out, 'live-1m.png') });

  // account dropdown: accounts with fills first, then the rest; picking one filters the fill marks and is remembered
  const opts = await page.$$eval('#fillAcct option', os => os.map(o => o.value + '=' + o.textContent));
  if (JSON.stringify(opts) !== JSON.stringify(['=All accounts', 'DEMO-EVAL=DEMO-EVAL', 'Sim101=Sim101', 'DEMO-EMPTY=DEMO-EMPTY (no fills yet)'])) fail('account options: ' + JSON.stringify(opts));
  await page.selectOption('#fillAcct', 'DEMO-EVAL'); await page.waitForTimeout(300);
  let fillText = await page.textContent('#lgFill');
  if (!/DEMO-EVAL/.test(fillText)) fail('last fill not from the chosen account: ' + fillText);
  await page.selectOption('#fillAcct', 'DEMO-EMPTY'); await page.waitForTimeout(300);
  fillText = await page.textContent('#lgFill');
  if (fillText.trim() !== '') fail('fills shown for an account with none: ' + fillText);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('connPill').textContent === 'LIVE', null, { timeout: 15000 });
  await page.waitForTimeout(500);
  if (await page.inputValue('#fillAcct') !== 'DEMO-EMPTY') fail('account choice not remembered');
  await page.selectOption('#fillAcct', ''); await page.waitForTimeout(300);
  const diag = await page.evaluate(async () => (await fetch('/diag')).json());
  if (!Array.isArray(diag.accounts) || diag.accounts.length !== 3 || typeof diag.clockOffsetMs !== 'number') fail('diag shape: ' + JSON.stringify(diag).slice(0, 200));

  for (const tf of ['15s', '30s', '5m', '1h', 'Range']) {
    await page.click(`#tfSeg >> text="${tf}"`);
    await page.waitForTimeout(400);
  }
  if (await page.isHidden('#rangeBox')) fail('range size box hidden in Range mode');
  await page.fill('#rangeTicks', '12'); await page.press('#rangeTicks', 'Enter'); await page.waitForTimeout(500);
  const tfText = await page.textContent('#lgTf');
  if (!/Range 12t/.test(tfText)) fail('range label: ' + tfText);
  if (await page.inputValue('#rangeMode') !== 'nt') fail('range mode is not NinjaTrader by default');
  await page.waitForTimeout(2500);                     // live ticks jump up to 3 ticks: some break past the range
  // NinjaTrader style: every finished bar is exactly 12 ticks (the last bar of a session can be short)
  const spans = await page.evaluate(() => {
    const b = window.liveChart.bars(), day = t => Math.floor((t + 86400 - 64800) / 86400), bad = [];
    for (let i = 0; i < b.length - 1; i++) if (day(b[i].t) === day(b[i + 1].t) && Math.round((b[i].h - b[i].l) / 0.25) !== 12) bad.push(i + ':' + b[i].l + '-' + b[i].h);
    return { n: b.length, bad };
  });
  if (spans.n < 20 || spans.bad.length) fail('NinjaTrader range bars not exact: ' + JSON.stringify(spans).slice(0, 300));
  const lateMain = await page.evaluate(() => { const b = window.liveChart.bars()[0], s = 18 * 3600, start = (Math.floor((b.t + 86400 - s) / 86400) - 1) * 86400 + s; return b.t - start > 600; });
  if (lateMain !== /less tick history than asked/.test(await page.textContent('#statusMsg'))) fail('partial history note wrong with the full backfill: ' + lateMain + ' "' + await page.textContent('#statusMsg') + '"');
  console.log('full history: first range bar mid-session ' + lateMain);
  await page.screenshot({ path: path.join(out, 'live-range.png') });
  await page.selectOption('#rangeMode', 'traded'); await page.waitForTimeout(400);
  if (!/Range 12t traded/.test(await page.textContent('#lgTf'))) fail('traded mode label: ' + await page.textContent('#lgTf'));
  await page.screenshot({ path: path.join(out, 'live-range-traded.png') });
  await page.reload();
  await page.waitForFunction(() => document.getElementById('connPill').textContent === 'LIVE', null, { timeout: 15000 });
  await page.waitForTimeout(400);
  if (await page.inputValue('#rangeMode') !== 'traded' || await page.inputValue('#rangeTicks') !== '12') fail('range mode or size not remembered: ' + await page.inputValue('#rangeMode') + ' ' + await page.inputValue('#rangeTicks'));
  await page.selectOption('#rangeMode', 'nt'); await page.waitForTimeout(300);

  // indicator menu: one control, keyboard and pointer, saved for the pane
  if (await page.textContent('#indCount') !== '5/5') fail('indicators on at first run (the 1.3 four and IB 1h, 1.5.3): ' + await page.textContent('#indCount'));
  if (!(await page.isHidden('#indPanel'))) fail('indicator menu open at load');
  await page.focus('#indBtn'); await page.keyboard.press('Enter');
  if (await page.isHidden('#indPanel') || await page.getAttribute('#indBtn', 'aria-expanded') !== 'true') fail('Enter did not open the indicator menu');
  if (await page.evaluate(() => document.activeElement.dataset.layer) !== 'volume') fail('focus not on the first indicator');
  await page.keyboard.press('Space');
  if (await page.evaluate(() => window.liveChart.getLayers().volume) !== false) fail('Space did not turn volume off');
  await page.keyboard.press('Tab'); await page.keyboard.press('Space'); await page.waitForTimeout(400);   // VWAP off
  if (!(await page.isHidden('#lgVwWrap'))) fail('VWAP legend still shown with VWAP off');
  await page.screenshot({ path: path.join(out, 'live-indicators-open.png') });
  await page.keyboard.press('Escape');
  if (!(await page.isHidden('#indPanel'))) fail('Escape did not close the indicator menu');
  if (await page.evaluate(() => document.activeElement.id) !== 'indBtn') fail('focus not back on the Indicators button');
  if (await page.textContent('#indCount') !== '3/5') fail('count after two off: ' + await page.textContent('#indCount'));
  await page.click('#indBtn');
  await page.click('#indPanel input[data-layer="fills"]');
  if ((await page.textContent('#lgFill')).trim() !== '') fail('fills still marked with Fills off');
  await page.mouse.click(700, 600);                                                     // outside: closes
  if (!(await page.isHidden('#indPanel'))) fail('outside click did not close the indicator menu');
  await page.reload();
  await page.waitForFunction(() => document.getElementById('connPill').textContent === 'LIVE', null, { timeout: 15000 });
  await page.waitForTimeout(400);
  const layers = await page.evaluate(() => window.liveChart.getLayers());
  if (layers.volume !== false || layers.vwap !== false || layers.levels !== true) fail('indicators not remembered: ' + JSON.stringify(layers));
  const savedInd = await page.evaluate(() => JSON.parse(localStorage.getItem('live-indicators-v1')));
  if (!savedInd || !savedInd.main || savedInd.main.fills !== false) fail('indicators not saved under the pane id: ' + JSON.stringify(savedInd));
  await page.click('#indBtn');
  for (const k of ['volume', 'vwap', 'fills']) await page.click(`#indPanel input[data-layer="${k}"]`);
  await page.keyboard.press('Escape');
  if (await page.textContent('#indCount') !== '5/5') fail('indicators back on: ' + await page.textContent('#indCount'));

  await page.click('#tfSeg >> text="1m"'); await page.waitForTimeout(400);
  const box = await page.locator('#chart canvas').boundingBox();
  await page.click('#toolHline');
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3);
  await page.click('#toolTrend');
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.6);
  await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(300);
  let saved = await page.evaluate(() => JSON.parse(localStorage.getItem('live-drawings-v1-MNQ') || '[]'));
  if (saved.length !== 2) fail('expected 2 saved drawings, got ' + saved.length);
  await page.screenshot({ path: path.join(out, 'live-drawings.png') });
  await page.reload();
  await page.waitForFunction(() => document.getElementById('connPill').textContent === 'LIVE', null, { timeout: 15000 });
  saved = await page.evaluate(() => JSON.parse(localStorage.getItem('live-drawings-v1-MNQ') || '[]'));
  if (saved.length !== 2) fail('drawings lost on reload: ' + saved.length);

  await page.click('#symSeg >> text="ES"');
  await page.waitForFunction(() => document.getElementById('connPill').textContent === 'LIVE', null, { timeout: 15000 });
  await page.waitForTimeout(1200);
  const esName = await page.textContent('#lgName');
  if (!/ES 12-26/.test(esName)) fail('ES name: ' + esName);
  const status = (await page.textContent('.status')).replace(/\s+/g, ' ');
  if (!/feed \d+ ms/.test(status)) fail('delay readout missing: ' + status);
  for (const g of ['Fast', 'Off', 'Smooth']) await page.click(`#glideSeg >> text="${g}"`);
  await page.screenshot({ path: path.join(out, 'live-es.png') });
  console.log('status:', status.slice(0, 160));

  // less tick history than asked (review N5): a quiet note says range bars start mid-session, exactly when they do
  {
    const short = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT + 1), '--v1', '--tick-hours-max=2'], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise(r => short.stdout.once('data', r));
    try {
      const p2 = await browser.newPage({ viewport: { width: 1440, height: 860 } });
      p2.on('pageerror', e => fail('short history pageerror: ' + e.message));
      await p2.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
      await p2.goto(`http://localhost:${PORT + 1}/live/`);
      await p2.waitForFunction(() => document.getElementById('connPill').textContent === 'LIVE', null, { timeout: 15000 });
      if (await p2.getAttribute('#tfSeg >> text="Range"', 'aria-pressed') !== 'true') { await p2.click('#tfSeg >> text="Range"'); await p2.waitForFunction(() => document.getElementById('connPill').textContent === 'LIVE', null, { timeout: 15000 }); }
      await p2.waitForTimeout(500);
      const late = await p2.evaluate(() => { const b = window.liveChart.bars()[0]; if (!b) return null; const s = 18 * 3600, start = (Math.floor((b.t + 86400 - s) / 86400) - 1) * 86400 + s; return b.t - start > 600; });
      const msg = await p2.textContent('#statusMsg');
      if (late === null) fail('short history: no range bars');
      else if (late !== /less tick history than asked/.test(msg)) fail('short history note (' + (late ? 'expected' : 'not expected') + '): "' + msg + '"');
      else console.log('short history: first bar mid-session ' + late + ', note: ' + (msg || '(none)'));
      await p2.close();
    } finally { short.kill(); }
  }

  const phone = await browser.newPage({ viewport: { width: 400, height: 820 }, deviceScaleFactor: 2 });
  phone.on('pageerror', e => fail('phone pageerror: ' + e.message));
  await phone.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await phone.goto(`http://localhost:${PORT}/live/`);
  await phone.waitForFunction(() => document.getElementById('connPill').textContent === 'LIVE', null, { timeout: 15000 });
  if (await phone.evaluate(() => document.documentElement.scrollWidth) > 400) fail('phone scrolls sideways');
  await phone.screenshot({ path: path.join(out, 'live-phone.png') });
  await phone.click('#indBtn');
  const pb = await phone.locator('#indPanel').boundingBox();
  if (!pb || pb.x < 0 || pb.x + pb.width > 400) fail('phone: indicator menu off screen ' + JSON.stringify(pb));
  if (await phone.evaluate(() => document.documentElement.scrollWidth) > 400) fail('phone scrolls sideways with the menu open');
  await phone.screenshot({ path: path.join(out, 'live-phone-indicators.png') });
} finally {
  if (browser) await browser.close();
  bridge.kill();
}
if (errors.length) { console.error('FAIL\n' + errors.join('\n')); process.exit(1); }
console.log('live smoke: ok');
