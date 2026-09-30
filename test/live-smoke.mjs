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
const isLive = () => document.getElementById('connPill')?.textContent === 'LIVE';
/* One account picker (1.6.0, Anthony): with no order bar (ChartBridge 0.2 here) it sits in the toolbar. */
async function pickFillAccount(page, value) { await page.selectOption('#acctPick', value); }
/* The fills marked are always the picker's account's, and nobody else's (review B1). */
async function fillsMatchPicker(page) {
  const r = await page.evaluate(() => ({ pick: document.getElementById('acctPick').value, visible: !document.getElementById('acctWrap').hidden,
    accounts: [...new Set(window.liveChart.getMarkers().map(m => m.account))] }));
  if (!r.visible || r.accounts.some(a => a !== r.pick)) fail('fills marked are not the visible picker\'s account: ' + JSON.stringify(r));
  return r;
}
let browser = null;
try {
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
  page.on('pageerror', e => fail('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fail('console: ' + m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.goto(`http://localhost:${PORT}/live/`);
  await page.waitForFunction(() => document.getElementById('connPill')?.textContent === 'LIVE', null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  if (!(await page.isHidden('#obar'))) fail('order bar shown with a read-only ChartBridge');
  const legend = (await page.textContent('#legend')).replace(/\s+/g, ' ');
  if (!/MNQ 12-26/.test(legend)) fail('legend missing contract: ' + legend);
  if (!/Last fill (BUY|SELL)/.test(legend)) fail('legend missing last fill: ' + legend);
  await page.screenshot({ path: path.join(out, 'live-1m.png') });

  // the account picker (toolbar, no order bar): accounts with fills first, no "All accounts"; the fills follow it
  const opts = await page.$$eval('#acctPick option', os => os.map(o => o.value + '=' + o.textContent));
  if (JSON.stringify(opts) !== JSON.stringify(['DEMO-EVAL=DEMO-EVAL', 'Sim101=Sim101', 'DEMO-EMPTY=DEMO-EMPTY (no fills yet)'])) fail('account options: ' + JSON.stringify(opts));
  if (await page.inputValue('#acctPick') !== 'Sim101' || (await fillsMatchPicker(page)).accounts.join() !== 'Sim101') fail('first run: Sim101 and its fills');
  await pickFillAccount(page, 'DEMO-EVAL'); await page.waitForTimeout(300);
  let fillText = await page.textContent('#lgFill');
  if (!/DEMO-EVAL/.test(fillText) || (await fillsMatchPicker(page)).accounts.join() !== 'DEMO-EVAL') fail('fills not from the chosen account: ' + fillText);
  await page.screenshot({ path: path.join(out, 'live-account-picker.png'), clip: { x: 0, y: 0, width: 1440, height: 200 } });
  await pickFillAccount(page, 'DEMO-EMPTY'); await page.waitForTimeout(300);
  fillText = await page.textContent('#lgFill');
  if (fillText.trim() !== '' || (await fillsMatchPicker(page)).accounts.length) fail('fills shown for an account with none: ' + fillText);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('connPill')?.textContent === 'LIVE', null, { timeout: 15000 });
  await page.waitForTimeout(500);
  if (await page.inputValue('#acctPick') !== 'DEMO-EMPTY') fail('account choice not remembered');
  await pickFillAccount(page, 'Sim101'); await page.waitForTimeout(300);
  await fillsMatchPicker(page);
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
  await page.waitForFunction(() => document.getElementById('connPill')?.textContent === 'LIVE', null, { timeout: 15000 });
  await page.waitForTimeout(400);
  if (await page.inputValue('#rangeMode') !== 'traded' || await page.inputValue('#rangeTicks') !== '12') fail('range mode or size not remembered: ' + await page.inputValue('#rangeMode') + ' ' + await page.inputValue('#rangeTicks'));
  await page.selectOption('#rangeMode', 'nt'); await page.waitForTimeout(300);

  // Indicators menu (1.6.0, Anthony's "E2"): search, switch, pin, chips, Hide all and Restore, remove and add, "/" key
  const L = () => page.evaluate(() => window.liveChart.getLayers());
  const count = () => page.textContent('#indCount');
  const chips = () => page.$$eval('#indChips .ind-chip', bs => bs.map(b => b.dataset.id + (b.getAttribute('aria-pressed') === 'true' ? '+' : '-')));
  if (await count() !== '6/6') fail('indicators on at first run (the 1.3 four, IB 1.5.3 and the delta pane 1.7.0): ' + await count());
  if (!(await page.isHidden('#indPanel'))) fail('indicator menu open at load');
  if (JSON.stringify(await chips()) !== JSON.stringify(['volume+', 'vwap+', 'levels+', 'ib+', 'delta+', 'fills+'])) fail('chip strip at first run: ' + JSON.stringify(await chips()));
  // ChartBridge 0.2 sends no trade sides: the delta pane is there, draws nothing, and says why (1.7.0)
  const dp = await page.evaluate(() => ({ pane: window.liveChart.deltaPane(), delta: window.liveChart.getDelta(), legend: document.getElementById('lgDelta').textContent.trim() }));
  if (!dp.pane.on || dp.delta !== null || dp.pane.note !== 'Delta needs ChartBridge 0.3.4 on this PC' || dp.legend !== dp.pane.note) fail('delta pane on ChartBridge 0.2: ' + JSON.stringify(dp));
  await page.focus('#indBtn'); await page.keyboard.press('Enter');
  if (await page.isHidden('#indPanel') || await page.getAttribute('#indBtn', 'aria-expanded') !== 'true') fail('Enter did not open the indicator menu');
  if (await page.evaluate(() => document.activeElement.id) !== 'indQ') fail('focus not on the search box when the menu opens');
  const onRows = await page.$$eval('#indBody .ind-item', els => els.map(e => e.dataset.id));
  if (JSON.stringify(onRows) !== JSON.stringify(['volume', 'vwap', 'levels', 'ib', 'delta', 'fills'])) fail('On this chart rows: ' + JSON.stringify(onRows));
  if (await page.$$eval('#indBody .ind-cat', els => els.map(e => e.textContent.replace(/\d+$/, '').trim()).join(',')) !== 'Price,Volume,Trades') fail('groups');
  if (!/Coming: time and sales/.test(await page.textContent('#indBody'))) fail('coming line missing');
  // search: short names, then Enter acts on the first match
  await page.keyboard.type('pdh');
  let found = await page.$$eval('#indBody .ind-item', els => els.map(e => e.dataset.id));
  if (JSON.stringify(found) !== '["levels"]') fail('search "pdh": ' + JSON.stringify(found));
  await page.keyboard.press('Enter');
  if ((await L()).levels !== true || await count() !== '6/6') fail('Enter on a shown match must not hide it: ' + await count());
  await page.click('#indBody [data-f="sw:levels"]');
  if ((await L()).levels !== false || await count() !== '5/6') fail('the Levels switch did not hide Levels: ' + await count());
  await page.focus('#indQ'); await page.keyboard.press('Enter');
  if ((await L()).levels !== true) fail('Enter on a hidden match shows it');
  await page.click('#indBody [data-f="sw:levels"]');
  await page.fill('#indQ', 'ibh');
  if (JSON.stringify(await page.$$eval('#indBody .ind-item', els => els.map(e => e.dataset.id))) !== '["ib"]') fail('search "ibh"');
  await page.fill('#indQ', 'profile');
  if (!(await page.isVisible('#indBody [data-f="add:vp"]')) || await page.$('#indBody .ind-tag')) fail('volume profile (1.6.0): found by "profile", with a + to add it, no "coming" tag');
  await page.fill('#indQ', 'zzz');
  if (!/No match/.test(await page.textContent('#indBody'))) fail('no match label');
  await page.fill('#indQ', '');
  // the switch by keyboard: Space hides Volume, focus stays on the switch
  await page.focus('#indBody [data-f="sw:volume"]'); await page.keyboard.press('Space');
  if ((await L()).volume !== false || await page.evaluate(() => document.activeElement.dataset.f) !== 'sw:volume') fail('Space on the Volume switch');
  if (await page.getAttribute('#indBody [data-f="sw:volume"]', 'aria-pressed') !== 'false' || await page.getAttribute('#indBody [data-f="sw:volume"]', 'aria-label') !== 'Show Volume bars') fail('switch aria-pressed and label after hiding');
  const recent = await page.$$eval('#indBody .ind-rec', bs => bs.map(b => b.textContent));
  if (JSON.stringify(recent) !== '["VOL","LEVELS"]') fail('Recent: ' + JSON.stringify(recent));
  // one settings panel at a time
  await page.click('#indBody [data-act="gear"][data-id="ib"]');
  await page.click('#indBody [data-act="gear"][data-id="vwap"]');
  if (await page.$$eval('#indBody .ind-set', els => els.map(e => e.dataset.id).join()) !== 'vwap') fail('more than one settings panel open');
  await page.click('#indBody [data-act="gear"][data-id="ib"]');
  if (!/1 hour, locks 10:30 ET/.test(await page.textContent('#indBody .ind-set[data-id="ib"]'))) fail('IB settings text');
  await page.screenshot({ path: path.join(out, 'live-indicators-open.png') });
  await page.keyboard.press('Escape');
  if (!(await page.isHidden('#indPanel'))) fail('Escape did not close the indicator menu');
  if (await page.evaluate(() => document.activeElement.id) !== 'indBtn') fail('focus not back on the Indicators button');
  if (await count() !== '4/6') fail('count after two hidden: ' + await count());
  if (JSON.stringify(await chips()) !== JSON.stringify(['volume-', 'vwap+', 'levels-', 'ib+', 'delta+', 'fills+'])) fail('chips after two hidden: ' + JSON.stringify(await chips()));
  const chipLook = await page.evaluate(() => [...document.querySelectorAll('#indChips .ind-chip')].map(b => getComputedStyle(b).borderTopStyle + ' ' + getComputedStyle(b.querySelector('.sw')).backgroundColor));
  if (!/^dashed/.test(chipLook[0]) || !/^solid/.test(chipLook[1]) || chipLook[0].split(' ').slice(1).join(' ') === chipLook[1].split(' ').slice(1).join(' ')) fail('hidden and shown chips must differ by more than color: ' + JSON.stringify(chipLook));
  // a chip: one click shows or hides
  await page.click('#indChips .ind-chip[data-id="vwap"]'); await page.waitForTimeout(300);
  if ((await L()).vwap !== false || !(await page.isHidden('#lgVwWrap'))) fail('VWAP chip did not hide VWAP (and its legend)');
  await page.click('#indChips .ind-chip[data-id="volume"]');
  if ((await L()).volume !== true) fail('Volume chip did not show Volume');
  // Hide all, then Restore brings back the same mix (not everything)
  await page.click('#indBtn');
  if (await page.textContent('#indHideAll') !== 'Hide all (4)') fail('hide all label: ' + await page.textContent('#indHideAll'));
  await page.click('#indHideAll');
  let lay = await L();
  if (lay.volume || lay.vwap || lay.levels || lay.ib || lay.delta || await count() !== '0/6' || await page.textContent('#indHideAll') !== 'Restore') fail('Hide all: ' + JSON.stringify(lay) + ' ' + await count());
  if (await page.evaluate(() => window.liveChart.deltaPane().on)) fail('Hide all left the delta pane');
  if ((await page.textContent('#lgFill')).trim() !== '') fail('fills still marked after Hide all');
  await page.screenshot({ path: path.join(out, 'live-indicators-hidden-all.png') });
  await page.click('#indHideAll');
  lay = await L();
  if (!lay.volume || lay.vwap || lay.levels || !lay.ib || !lay.delta || await count() !== '4/6') fail('Restore did not bring back the same mix: ' + JSON.stringify(lay) + ' ' + await count());
  // pin: off takes the chip away; x takes Fills off the chart; + in its group adds it back
  await page.click('#indBody [data-act="pin"][data-id="levels"]');
  if (await page.$('#indChips .ind-chip[data-id="levels"]')) fail('unpinned Levels still on the chip strip');
  await page.click('#indBody [data-act="remove"][data-id="fills"]');
  if (await count() !== '3/5' || await page.$('#indBody [data-f="sw:fills"]') || (await page.textContent('#lgFill')).trim() !== '') fail('x did not take Fills off: ' + await count());
  await page.click('#indBody .ind-cat[data-id="trades"]');
  await page.click('#indBody .ind-cat[data-id="price"]');
  if (await page.getAttribute('#indBody .ind-cat[data-id="trades"]', 'aria-expanded') !== 'false') fail('two groups open at once');
  await page.click('#indBody .ind-cat[data-id="trades"]');
  await page.click('#indBody [data-f="add:fills"]');
  if (await count() !== '4/6' || (await page.textContent('#lgFill')).trim() === '' || await page.evaluate(() => document.activeElement.dataset.f) !== 'sw:fills') fail('+ did not add Fills back (focus on its switch): ' + await count() + ' ' + await page.evaluate(() => document.activeElement.outerHTML.slice(0, 80)));
  await page.mouse.click(700, 600);                                                     // outside: closes
  if (!(await page.isHidden('#indPanel'))) fail('outside click did not close the indicator menu');
  // "/" opens the menu of the chart under the mouse, never while typing in a box
  await page.mouse.move(500, 500); await page.focus('#chart'); await page.keyboard.press('/');
  if (await page.isHidden('#indPanel') || await page.evaluate(() => document.activeElement.id) !== 'indQ') fail('"/" did not open the menu with focus in search');
  await page.keyboard.type('fills');
  await page.keyboard.press('Escape');
  if (await page.evaluate(() => document.activeElement.id) !== 'chart') fail('Escape after "/" did not return focus to the chart');
  await page.click('#indBtn');
  if (await page.inputValue('#indQ') !== '' || !/On this chart/i.test(await page.textContent('#indBody'))) fail('the menu reopened filtered to the last search');
  await page.keyboard.press('Escape');
  await page.focus('#rangeTicks'); await page.keyboard.press('/');
  if (!(await page.isHidden('#indPanel'))) fail('"/" typed in the range box opened the menu');
  await page.focus('#chart');
  // saved for the pane: everything comes back after a reload
  const before = await page.evaluate(() => localStorage.getItem('live-indicators-v2'));
  await page.reload();
  await page.waitForFunction(isLive, null, { timeout: 15000 });
  await page.waitForTimeout(400);
  const layers = await L();
  if (!layers.volume || layers.vwap || layers.levels || !layers.ib || !layers.delta) fail('indicators not remembered: ' + JSON.stringify(layers));
  if (JSON.stringify(await chips()) !== JSON.stringify(['volume+', 'vwap-', 'ib+', 'delta+', 'fills+'])) fail('chips after a reload: ' + JSON.stringify(await chips()));
  const savedInd = await page.evaluate(() => JSON.parse(localStorage.getItem('live-indicators-v2')));
  if (!savedInd || !savedInd.main || savedInd.main.ind.vwap.shown !== false || savedInd.main.ind.levels.pin !== false || JSON.stringify(await page.evaluate(() => localStorage.getItem('live-indicators-v2'))) !== JSON.stringify(before)) fail('indicators not saved under the pane id: ' + JSON.stringify(savedInd));
  if (await page.evaluate(() => localStorage.getItem('live-indicators-v1')) !== null) fail('live-indicators-v1 written by 1.6.0');
  await page.click('#indBtn');
  for (const k of ['vwap', 'levels']) await page.click(`#indBody [data-f="sw:${k}"]`);
  await page.click('#indBody [data-act="pin"][data-id="levels"]');
  await page.keyboard.press('Escape');
  if (await count() !== '6/6' || (await chips()).length !== 6) fail('indicators back on: ' + await count());
  // the chip strip holds 6 (Anthony); the cap is lowered to 5 here to show the rule from a strip of six chips
  await page.evaluate(() => { window.LivePrefs.PIN_MAX = 5; });
  await page.click('#indBtn');
  await page.click('#indBody [data-act="pin"][data-id="vwap"]');                 // unpin: 5 chips, the strip is full
  await page.click('#indBody [data-act="pin"][data-id="vwap"]');                 // pin again: refused, with a note
  if (!/holds 5/.test(await page.textContent('#indBody .ind-note')) || await page.$('#indChips .ind-chip[data-id="vwap"]') || await page.getAttribute('#indBody [data-act="pin"][data-id="vwap"]', 'aria-pressed') !== 'false') fail('pinning onto a full strip was not refused with a note');
  if (!/holds 5/.test(await page.textContent('#indLive'))) fail('the note is not announced');
  await page.click('#indBody [data-act="remove"][data-id="fills"]');                // 4 chips: room for VWAP again
  await page.click('#indBody [data-act="pin"][data-id="vwap"]');                 // 5: full
  await page.click('#indBody .ind-cat[data-id="trades"]'); await page.click('#indBody [data-f="add:fills"]');
  if (!/Fills added without a chip/.test(await page.textContent('#indBody .ind-note')) || await page.$('#indChips .ind-chip[data-id="fills"]')) fail('an indicator added to a full strip got a chip');
  await page.screenshot({ path: path.join(out, 'live-indicators-strip-full.png') });
  await page.evaluate(() => { window.LivePrefs.PIN_MAX = 6; });
  await page.click('#indBody [data-act="pin"][data-id="fills"]');
  if (await page.$('#indBody [data-act="pin"][data-id="profile"]') || await page.$$eval('#indBody .ind-cat ~ .ind-item [data-act="pin"]', b => b.length)) fail('a pin on a row that is not on the chart');
  await page.keyboard.press('Escape');
  if ((await chips()).length !== 6) fail('six chips again: ' + JSON.stringify(await chips()));

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
  await page.waitForFunction(() => document.getElementById('connPill')?.textContent === 'LIVE', null, { timeout: 15000 });
  saved = await page.evaluate(() => JSON.parse(localStorage.getItem('live-drawings-v1-MNQ') || '[]'));
  if (saved.length !== 2) fail('drawings lost on reload: ' + saved.length);

  await page.click('#symSeg >> text="ES"');
  await page.waitForFunction(() => document.getElementById('connPill')?.textContent === 'LIVE', null, { timeout: 15000 });
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
      await p2.waitForFunction(() => document.getElementById('connPill')?.textContent === 'LIVE', null, { timeout: 15000 });
      if (await p2.getAttribute('#tfSeg >> text="Range"', 'aria-pressed') !== 'true') { await p2.click('#tfSeg >> text="Range"'); await p2.waitForFunction(() => document.getElementById('connPill')?.textContent === 'LIVE', null, { timeout: 15000 }); }
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
  await phone.waitForFunction(() => document.getElementById('connPill')?.textContent === 'LIVE', null, { timeout: 15000 });
  if (await phone.evaluate(() => document.documentElement.scrollWidth) > 400) fail('phone scrolls sideways');
  await phone.screenshot({ path: path.join(out, 'live-phone.png') });
  const phoneChips = await phone.evaluate(() => { const s = document.getElementById('indChips'), cs = [...s.querySelectorAll('.ind-chip')];
    return { narrow: s.classList.contains('is-narrow'), tops: [...new Set(cs.map(c => Math.round(c.getBoundingClientRect().top)))].length, text: cs.map(c => c.innerText.trim()).join(''), fits: s.scrollWidth <= s.clientWidth + 1, n: cs.length }; });
  if (!phoneChips.narrow || phoneChips.tops !== 1 || phoneChips.text !== 'VWLIDF' || !phoneChips.fits || phoneChips.n !== 6) fail('phone: chips should be one letter each, on one line: ' + JSON.stringify(phoneChips));
  await phone.click('#indChips .ind-chip[data-id="levels"]');
  if (await phone.evaluate(() => window.liveChart.getLayers().levels) !== false) fail('phone: letter chip did not hide Levels');
  await phone.screenshot({ path: path.join(out, 'live-phone-chips.png') });
  await phone.click('#indChips .ind-chip[data-id="levels"]');
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
