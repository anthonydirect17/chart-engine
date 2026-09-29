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
  await page.screenshot({ path: path.join(out, 'live-range.png') });

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

  const phone = await browser.newPage({ viewport: { width: 400, height: 820 }, deviceScaleFactor: 2 });
  phone.on('pageerror', e => fail('phone pageerror: ' + e.message));
  await phone.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await phone.goto(`http://localhost:${PORT}/live/`);
  await phone.waitForFunction(() => document.getElementById('connPill').textContent === 'LIVE', null, { timeout: 15000 });
  if (await phone.evaluate(() => document.documentElement.scrollWidth) > 400) fail('phone scrolls sideways');
  await phone.screenshot({ path: path.join(out, 'live-phone.png') });
} finally {
  if (browser) await browser.close();
  bridge.kill();
}
if (errors.length) { console.error('FAIL\n' + errors.join('\n')); process.exit(1); }
console.log('live smoke: ok');
