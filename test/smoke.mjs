// Browser smoke test: loads the demo, drives the chart like a user, and fails on any page error.
// Needs Playwright (`npm i` then `npm run smoke`). Screenshots go to test/out/.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const errors = [];
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

for (const vp of [{ w: 1440, h: 860, name: 'desk' }, { w: 400, h: 820, name: 'phone' }]) {
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 2 });
  page.on('pageerror', e => errors.push(vp.name + ': ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(vp.name + ' console: ' + m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.goto('file://' + path.join(root, 'index.html'));
  await page.waitForTimeout(1200);
  const box = await page.locator('#chart canvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4);
  for (let k = 0; k < 4; k++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(40); }
  await page.mouse.down();
  for (let k = 0; k < 8; k++) { await page.mouse.move(box.x + box.width * 0.5 + k * 25, box.y + box.height * 0.4); await page.waitForTimeout(12); }
  await page.mouse.up();
  await page.waitForTimeout(800);
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.35);
  await page.waitForTimeout(300);
  const legend = (await page.textContent('#legend')).replace(/\s+/g, ' ');
  if (!/O \d/.test(legend)) errors.push(vp.name + ': legend never filled: ' + legend);
  const nonblank = await page.evaluate(() => {
    const c = document.querySelector('#chart canvas'), x = c.getContext('2d');
    const d = x.getImageData(0, 0, c.width, c.height).data; let lit = 0;
    for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i + 1] + d[i + 2] > 120) lit++;
    return lit;
  });
  if (nonblank < 50) errors.push(vp.name + ': canvas looks empty (' + nonblank + ')');
  if (await page.evaluate(() => document.documentElement.scrollWidth) > vp.w) errors.push(vp.name + ': page scrolls sideways');
  await page.screenshot({ path: path.join(out, vp.name + '.png') });
  if (vp.name === 'desk') {
    await page.click('.ce-theme-btn');
    await page.click('.ce-preset[data-id="mint"]');
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(out, 'desk-colors.png') });
    await page.click('.ce-preset[data-id="carolina"]');
    await page.keyboard.press('Escape');
    for (const tf of ['5m', '15m', '1h', '1m']) { await page.click(`#tfSeg >> text=${tf}`); await page.waitForTimeout(250); }
    await page.click('#speedSeg >> text=30x'); await page.waitForTimeout(1500);
    await page.click('#speedSeg >> text=Pause'); await page.waitForTimeout(200);
    for (const k of ['volume', 'vwap', 'levels', 'trades']) { await page.click(`[data-layer="${k}"]`); await page.click(`[data-layer="${k}"]`); }
    const meter = await page.textContent('#meter');
    console.log('meter:', meter);
    await page.screenshot({ path: path.join(out, 'desk-after.png') });
  }
  console.log(vp.name, 'legend:', legend.trim().slice(0, 140));
  await page.close();
}
await browser.close();
if (errors.length) { console.error('FAIL\n' + errors.join('\n')); process.exit(1); }
console.log('smoke: ok');
