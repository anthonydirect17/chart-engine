// 1.9.0 smoke: color presets and the top bar following the chart, on the live page against the fake bridge (sample data
// only, never market data), trading on so the order bar shows:
//   npm run smoke:presets   (CHROMIUM_PATH=/path/to/chrome for a preinstalled browser; SHOTS=dir for the screenshots)
// Checks: the Colors panel's two preset groups (chart: bull, bear and background; indicator: every indicator color)
// save, replace by name, pick, rename and delete, and survive a reload and a second tab; VWAP is no longer in the
// Colors panel but in its gear, as are the levels', the IB's and the profile's colors, drawn at once; the order bar is
// the 1.5.2 bar on the dark grounds and goes light with a light chart, Buy, Sell and Armed readable; the Armed switch,
// Buy and Flatten still work the same way. Screenshots of each, light and dark, go to SHOTS (default test/out).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CE = require('../src/chart-engine.js'), U = CE.util;
const { LivePrefs: LP } = require('../live/live.js');
const CE_CATS = Object.fromEntries(LP.INDICATORS.map(d => [d.id, d.cat]));
const SHOTS = path.resolve(process.env.SHOTS || path.join(root, 'test', 'out'));
fs.mkdirSync(SHOTS, { recursive: true });
const BASE_PORT = +(process.env.PRESETS_SMOKE_PORT || 8851);
const errors = [];
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { if (!ok) fail(m); else console.log('  ok   ' + m); };

/* Seconds to add to the real clock to stand at hh:mm New York time on the most recent day with a regular session. */
function offsetTo(hh, mm) {
  const now = Date.now() / 1000, today = Math.floor(U.zoneSeconds(now) / 86400);
  for (let back = 0; back < 30; back++) {
    const bt = (today - back) * 86400 + hh * 3600 + mm * 60;
    if (!U.rthDay(bt)) continue;
    let unix = bt - (U.zoneSeconds(now) - now);
    unix = bt - (U.zoneSeconds(unix) - unix);
    if (unix > now) continue;
    return Math.round(unix - now);
  }
  throw new Error('no day found');
}
async function startBridge(offset) {
  for (let port = BASE_PORT; port < BASE_PORT + 6; port++) {
    const b = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(port), '--pin-off', '--test-controls', '--clock-offset=' + offset,
      '--trading', '--trade-accounts=Sim101'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errText = '';
    b.stderr.on('data', d => { errText += d; });
    const ok = await new Promise(res => { b.stdout.once('data', () => res(true)); b.once('exit', () => res(false)); });
    if (ok) return { port, kill: () => b.kill() };
    if (!/EADDRINUSE/.test(errText)) throw new Error('bridge failed: ' + errText);
  }
  throw new Error('no free port from ' + BASE_PORT);
}

const offset = offsetTo(11, 15);
const br = await startBridge(offset);
const URL = `http://localhost:${br.port}/live/`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await ctx.addInitScript(`(() => { const realNow = Date.now; Date.now = () => realNow() + ${offset * 1000}; })();`);
await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
const live = p => p.waitForFunction(() => document.getElementById('connPill') && document.getElementById('connPill').textContent === 'LIVE', null, { timeout: 20000 }).then(() => p.waitForTimeout(600));
async function openPage() {
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fail('console: ' + m.text()); });
  await p.goto(URL); await live(p);
  return p;
}
const shot = (p, name) => p.screenshot({ path: path.join(SHOTS, name + '.png') });
const openColors = async p => { if (await p.isHidden('.ce-theme-panel')) await p.click('.ce-theme-btn'); await p.waitForTimeout(150); };
const closeColors = async p => { if (await p.isVisible('.ce-theme-panel')) { await p.keyboard.press('Escape'); await p.waitForTimeout(100); } };
const group = g => `.pr-group[data-g="${g}"]`;
const names = (p, g) => p.$$eval(group(g) + ' .pr-n', els => els.map(e => e.textContent));
const pressed = (p, g) => p.$$eval(group(g) + ' .pr-pick[aria-pressed="true"] .pr-n', els => els.map(e => e.textContent));
const note = (p, g) => p.textContent(group(g) + ' .pr-note');
const rowBtn = (g, name, act) => `${group(g)} .pr-row:has(.pr-n:text-is("${name}")) [data-act="${act}"]`;
const setBg = (p, hex) => p.evaluate(v => { const h = document.querySelector('.ce-theme-panel input[data-hex="bg"]'); h.value = v; h.dispatchEvent(new Event('input', { bubbles: true })); }, hex);
const theme = p => p.evaluate(() => { const t = window.liveChart.getTheme(); return { up: t.up, down: t.down, bg: t.bg, vwap: t.vwap, vpPoc: t.vpPoc }; });
const levelColor = (p, name) => p.evaluate(n => { const l = window.liveChart.getLevels().find(x => x.name === n); return l ? l.color : null; }, name);
async function openGear(p, id) {
  if (await p.isHidden('#indPanel')) await p.click('#indBtn');
  await p.waitForSelector('#indPanel:not([hidden])');
  if (!(await p.$(`.ind-set[data-id="${id}"]`))) {
    // one off this chart (the profile is off by default) waits in its folded group
    const cat = CE_CATS[id];
    if (!(await p.$(`#indBody [data-act="gear"][data-id="${id}"]`)) && cat) await p.click(`#indBody [data-act="cat"][data-id="${cat}"]`);
    await p.click(`#indBody [data-act="gear"][data-id="${id}"]`);
  }
  await p.waitForSelector(`.ind-set[data-id="${id}"]`);
}
const closeMenu = async p => { if (await p.isVisible('#indPanel')) { await p.keyboard.press('Escape'); await p.waitForTimeout(100); } };
const typeHex = async (p, sel, v) => { await p.fill(sel, v); await p.waitForTimeout(80); };
/* the order bar's colors as drawn: the ground, the bar, Buy and Sell text and their buttons */
const obar = p => p.evaluate(() => {
  const cs = el => getComputedStyle(el);
  const buy = cs(document.getElementById('buyMkt')), sell = cs(document.getElementById('sellMkt')), bar = cs(document.getElementById('obar'));
  const arm = cs(document.getElementById('armBtn'));
  return { ground: cs(document.querySelector('.obar-ground')).backgroundColor, bar: bar.backgroundColor, barText: bar.color,
    buy: buy.color, buyBg: buy.backgroundColor, sell: sell.color, sellBg: sell.backgroundColor, arm: arm.color, armBg: arm.backgroundColor,
    toolbar: cs(document.querySelector('.chart-live')).backgroundColor, scheme: bar.colorScheme };
});
/* an rgb()/rgba() over another rgb(), as it shows */
const px = s => { const m = s.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
const hexOf = s => '#' + ['r', 'g', 'b'].map(k => Math.round(px(s)[k]).toString(16).padStart(2, '0')).join('').toUpperCase();
const overRgb = (top, under) => { const t = px(top), u = px(under); return '#' + ['r', 'g', 'b'].map(k => Math.round(t[k] * t.a + u[k] * (1 - t.a)).toString(16).padStart(2, '0')).join('').toUpperCase(); };

try {
  const a = await openPage();
  await a.waitForFunction(() => !document.getElementById('armBtn').disabled, null, { timeout: 15000 });

  /* ---------------- the Colors panel: two preset groups, VWAP gone from it */
  await openColors(a);
  check(!(await a.$('.ce-theme-panel input[data-k="vwap"]')) && !!(await a.$('.ce-theme-panel input[data-k="up"]')), 'Colors panel: Bull and Bear pickers, no VWAP picker (it is in the VWAP gear)');
  check((await a.$$('.pr-group')).length === 2 && (await a.textContent(group('chart') + ' .ce-lbl')) === 'Chart presets' && (await a.textContent(group('indicator') + ' .ce-lbl')) === 'Indicator presets',
    'two preset groups: Chart presets and Indicator presets');
  check((await a.textContent(group('chart') + ' .pr-empty')) === 'None saved yet.', 'none saved yet');
  check(/saved in this browser only/i.test(await a.textContent('.ce-theme-panel > .ce-note:last-child')), 'the panel says where presets are kept (this browser, until the shared store)');
  const base = await obar(a);
  await shot(a, 'presets-colors-panel-dark-empty');

  /* ---------------- save a white chart look, then a dark one */
  await a.click('.ce-ground[data-bg="light"]');
  await a.fill('.ce-theme-panel input[data-hex="up"]', '#1F6FB2'); await a.waitForTimeout(80);
  await a.fill(group('chart') + ' .pr-name-in', 'White chart');
  check((await a.textContent(group('chart') + ' [data-act="save"]')) === 'Save', 'a new name: Save');
  await a.press(group('chart') + ' .pr-name-in', 'Enter'); await a.waitForTimeout(150);
  check(JSON.stringify(await names(a, 'chart')) === '["White chart"]' && JSON.stringify(await pressed(a, 'chart')) === '["White chart"]', 'Enter saved "White chart", shown as in use: ' + await names(a, 'chart'));
  check((await note(a, 'chart')) === 'Saved White chart.' && (await a.inputValue(group('chart') + ' .pr-name-in')) === '', 'note "Saved White chart.", the box emptied');
  await a.click('.ce-ground[data-bg="dark"]'); await a.fill('.ce-theme-panel input[data-hex="up"]', '#4B9CD3'); await a.waitForTimeout(80);
  await a.fill(group('chart') + ' .pr-name-in', 'Dark desk'); await a.click(group('chart') + ' [data-act="save"]'); await a.waitForTimeout(150);
  check(JSON.stringify(await pressed(a, 'chart')) === '["Dark desk"]', 'the dark look saved and in use; White chart is not');
  // typing an existing name (any case) offers Replace, and replacing keeps one preset of that name
  await a.fill(group('chart') + ' .pr-name-in', 'white CHART');
  check((await a.textContent(group('chart') + ' [data-act="save"]')) === 'Replace', 'an existing name, any case: Replace');
  await a.fill(group('chart') + ' .pr-name-in', '');

  /* ---------------- pick: White chart gives the light chart, the light toolbar and the light order bar */
  await a.click(rowBtn('chart', 'White chart', 'pick')); await a.waitForTimeout(250);
  let t = await theme(a);
  check(t.bg === '#F5F7FA' && t.up === '#1F6FB2' && t.down === '#6D28D9', 'picking White chart: its bull, bear and background: ' + JSON.stringify(t));
  check(JSON.stringify(await pressed(a, 'chart')) === '["White chart"]' && (await note(a, 'chart')) === 'Using White chart.', 'White chart in use');
  await shot(a, 'presets-colors-panel-light');
  await closeColors(a);
  let ob = await obar(a);
  check(ob.ground === 'rgb(245, 247, 250)' && ob.toolbar === 'rgb(245, 247, 250)' && ob.scheme === 'light', 'white chart, white top bar: the order bar ground follows the chart: ' + ob.ground);
  const buyOn = overRgb(ob.buyBg, ob.bar), sellOn = overRgb(ob.sellBg, ob.bar);
  check(U.contrast(hexOf(ob.buy), buyOn) >= 4.5 && U.contrast(hexOf(ob.sell), sellOn) >= 4.5 && U.contrast(hexOf(ob.barText), hexOf(ob.bar)) >= 7,
    'light order bar: Buy ' + hexOf(ob.buy) + ' and Sell ' + hexOf(ob.sell) + ' read 4.5:1 on their buttons, text 7:1 (' + U.contrast(hexOf(ob.buy), buyOn).toFixed(2) + ', ' + U.contrast(hexOf(ob.sell), sellOn).toFixed(2) + ')');
  check(px(ob.buy).g > px(ob.buy).r && px(ob.sell).r > px(ob.sell).g, 'Buy stays green, Sell red');
  await a.mouse.move(700, 600);
  await shot(a, 'presets-light-top-bar');
  // Armed on the light bar: amber, readable, and it still arms and disarms the same way
  await a.click('#armBtn'); await a.waitForTimeout(150);
  ob = await obar(a);
  check((await a.getAttribute('#armBtn', 'aria-checked')) === 'true' && U.contrast(hexOf(ob.arm), hexOf(ob.armBg)) >= 4.5 && await a.isVisible('#armPill'),
    'Armed on the light bar: on, the ARMED pill shown, switch text ' + U.contrast(hexOf(ob.arm), hexOf(ob.armBg)).toFixed(2) + ':1 on ' + hexOf(ob.armBg));
  await shot(a, 'presets-light-top-bar-armed');
  // one market buy and a flatten, exactly as on the dark bar (Sim101 on the fake bridge)
  await a.click('#buyMkt');
  await a.waitForFunction(() => document.getElementById('oPos').textContent.startsWith('LONG 1'), null, { timeout: 8000 }).then(() => check(true, 'Buy MKT on the light bar: long 1'), () => fail('Buy MKT on the light bar did not fill'));
  await a.click('#flattenBtn');
  await a.waitForFunction(() => document.getElementById('oPos').textContent === 'Flat', null, { timeout: 8000 }).then(() => check(true, 'Flatten on the light bar: flat'), () => fail('Flatten on the light bar did not flatten'));
  await a.click('#armBtn'); await a.waitForTimeout(100);

  /* ---------------- the dark grounds: the order bar is exactly the 1.5.2 bar */
  await openColors(a);
  await a.click(rowBtn('chart', 'Dark desk', 'pick')); await a.waitForTimeout(200);
  ob = await obar(a);
  check(ob.ground === 'rgb(8, 11, 16)' && ob.bar === 'rgb(15, 21, 29)' && ob.buy === 'rgb(61, 220, 151)' && ob.sell === 'rgb(255, 122, 122)'
    && ob.buyBg === 'rgba(61, 220, 151, 0.08)' && ob.sellBg === 'rgba(255, 122, 122, 0.08)', 'dark ground: the 1.5.2 order bar (#080B10, #0F151D, Buy #3DDC97, Sell #FF7A7A): ' + JSON.stringify(ob));
  check(JSON.stringify(ob) === JSON.stringify(base), 'dark ground: the order bar exactly as before the presets were used');
  for (const g of ['#000000', '#1B2433', '#888888']) {
    await setBg(a, g); await a.waitForTimeout(60);
    const o = await obar(a);
    check(o.bar === base.bar && o.buy === base.buy && o.sell === base.sell && o.ground === base.ground, g + ': the order bar keeps the 1.5.2 colors (a dark or mid ground)');
  }
  await a.click(rowBtn('chart', 'Dark desk', 'pick')); await a.waitForTimeout(100);

  /* ---------------- rename (Escape keeps the panel open), delete after a second click */
  await a.click(rowBtn('chart', 'White chart', 'rename'));
  check(await a.evaluate(() => document.activeElement.classList.contains('pr-edit')), 'rename: the name box has the focus');
  await a.keyboard.press('Escape'); await a.waitForTimeout(100);
  check(await a.isVisible('.ce-theme-panel') && JSON.stringify(await names(a, 'chart')) === '["White chart","Dark desk"]', 'Escape leaves the rename, the panel stays open');
  await a.click(rowBtn('chart', 'White chart', 'rename'));
  await a.fill(group('chart') + ' .pr-edit', 'Dark desk'); await a.press(group('chart') + ' .pr-edit', 'Enter'); await a.waitForTimeout(120);
  check(/already called Dark desk/.test(await note(a, 'chart')) && await a.isVisible(group('chart') + ' .pr-edit'), 'a name already taken is refused, the box stays: ' + await note(a, 'chart'));
  await a.fill(group('chart') + ' .pr-edit', 'Day'); await a.press(group('chart') + ' .pr-edit', 'Enter'); await a.waitForTimeout(120);
  check(JSON.stringify(await names(a, 'chart')) === '["Day","Dark desk"]' && (await note(a, 'chart')) === 'Renamed to Day.', 'renamed to Day');
  await a.click(rowBtn('chart', 'Day', 'delete'));
  check(/Delete Day\?/.test(await a.textContent(group('chart') + ' .pr-ask')), 'delete asks first');
  await a.keyboard.press('Escape'); await a.waitForTimeout(80);
  check(JSON.stringify(await names(a, 'chart')) === '["Day","Dark desk"]' && await a.isVisible('.ce-theme-panel'), 'Escape keeps it');
  await a.click(rowBtn('chart', 'Day', 'delete')); await a.click(group('chart') + ' [data-act="delete-ok"]'); await a.waitForTimeout(120);
  check(JSON.stringify(await names(a, 'chart')) === '["Dark desk"]' && (await note(a, 'chart')) === 'Deleted Day.', 'Day deleted');
  await closeColors(a);

  /* ---------------- indicator colors in their gears: drawn at once, saved */
  await openGear(a, 'vwap');
  check((await a.$$('.ind-set[data-id="vwap"] .ind-color')).length === 1, 'VWAP gear: its line color');
  await typeHex(a, '.ind-set[data-id="vwap"] input[data-hk="vwap"]', '#ff8800');
  t = await theme(a);
  check(t.vwap === '#FF8800' && (await a.inputValue('.ind-set[data-id="vwap"] input[data-ck="vwap"]')) === '#ff8800', 'VWAP #FF8800 from its hex box: drawn, the picker follows');
  await typeHex(a, '.ind-set[data-id="vwap"] input[data-hk="vwap"]', '#ff88');
  check((await a.getAttribute('.ind-set[data-id="vwap"] input[data-hk="vwap"]', 'aria-invalid')) === 'true' && (await theme(a)).vwap === '#FF8800', 'a half-typed hex is marked, not applied');
  await a.press('.ind-set[data-id="vwap"] input[data-hk="vwap"]', 'Tab');
  check((await a.inputValue('.ind-set[data-id="vwap"] input[data-hk="vwap"]')) === '#FF8800', 'leaving the box puts the color in use back');
  await openGear(a, 'levels');
  check((await a.$$('.ind-set[data-id="levels"] .ind-color')).length === 4, 'Levels gear: prior day, overnight, value area, prior close');
  await typeHex(a, '.ind-set[data-id="levels"] input[data-hk="prior"]', '#00AAFF');
  check((await levelColor(a, 'PDH')) === '#00AAFF' && (await levelColor(a, 'PDL')) === '#00AAFF', 'prior day high and low drawn in #00AAFF at once');
  await openGear(a, 'ib');
  await typeHex(a, '.ind-set[data-id="ib"] input[data-hk="ibHigh"]', '#FFD0F0');
  check((await levelColor(a, 'IBH')) === '#FFD0F0', 'IB high #FFD0F0 at once: ' + await levelColor(a, 'IBH'));
  await openGear(a, 'vp');
  await typeHex(a, '.ind-set[data-id="vp"] input[data-hk="vpPoc"]', '#FFFFFF');
  check((await theme(a)).vpPoc === '#FFFFFF', 'profile POC #FFFFFF');
  await openGear(a, 'vwap');
  await a.mouse.move(700, 600);
  await shot(a, 'presets-gear-colors-dark');
  const savedInd = await a.evaluate(() => JSON.parse(localStorage.getItem('live-indicator-colors-v1')));
  check(savedInd.vwap === '#FF8800' && savedInd.prior === '#00AAFF' && savedInd.ibHigh === '#FFD0F0' && savedInd.vpPoc === '#FFFFFF', 'saved in this browser: ' + JSON.stringify(savedInd));
  await closeMenu(a);

  /* ---------------- indicator presets: save this set, change it, pick it back; Default colors */
  await openColors(a);
  await a.fill(group('indicator') + ' .pr-name-in', 'Dark indicators'); await a.press(group('indicator') + ' .pr-name-in', 'Enter'); await a.waitForTimeout(120);
  check(JSON.stringify(await pressed(a, 'indicator')) === '["Dark indicators"]', 'indicator preset saved and in use');
  await closeColors(a);
  await openGear(a, 'levels');
  await a.click('.ind-set[data-id="levels"] [data-act="coldef"]'); await a.waitForTimeout(100);
  check((await levelColor(a, 'PDH')) === CE.LEVEL_COLORS.prior && (await a.inputValue('.ind-set[data-id="levels"] input[data-hk="prior"]')) === CE.LEVEL_COLORS.prior && (await theme(a)).vwap === '#FF8800',
    'Levels "Default colors": the house level colors back, VWAP untouched');
  await closeMenu(a);
  await openColors(a);
  check(JSON.stringify(await pressed(a, 'indicator')) === '[]', 'the preset is no longer shown as in use');
  await a.click(rowBtn('indicator', 'Dark indicators', 'pick')); await a.waitForTimeout(150);
  check((await levelColor(a, 'PDH')) === '#00AAFF' && (await theme(a)).vwap === '#FF8800' && JSON.stringify(await pressed(a, 'indicator')) === '["Dark indicators"]', 'picking Dark indicators brings every indicator color back');
  // a light chart with its own indicator set
  await a.click('.ce-ground[data-bg="light"]'); await a.waitForTimeout(100);
  await closeColors(a);
  await openGear(a, 'vwap'); await typeHex(a, '.ind-set[data-id="vwap"] input[data-hk="vwap"]', '#6D28D9');
  await a.mouse.move(700, 600);
  await shot(a, 'presets-gear-colors-light');
  await closeMenu(a);
  await openColors(a);
  await a.fill(group('indicator') + ' .pr-name-in', 'Light indicators'); await a.press(group('indicator') + ' .pr-name-in', 'Enter'); await a.waitForTimeout(120);
  check(JSON.stringify(await names(a, 'indicator')) === '["Dark indicators","Light indicators"]', 'a second indicator preset for the light chart');
  await a.fill(group('chart') + ' .pr-name-in', 'White chart'); await a.press(group('chart') + ' .pr-name-in', 'Enter'); await a.waitForTimeout(120);
  await shot(a, 'presets-colors-panel-light-two-groups');
  await closeColors(a);

  /* ---------------- a second tab, then a reload: nothing undone */
  const b = await openPage();
  await openColors(b);
  check(JSON.stringify(await names(b, 'chart')) === '["Dark desk","White chart"]' && JSON.stringify(await names(b, 'indicator')) === '["Dark indicators","Light indicators"]', 'a second tab lists every preset');
  await b.fill(group('chart') + ' .pr-name-in', 'From B'); await b.press(group('chart') + ' .pr-name-in', 'Enter'); await b.waitForTimeout(120);
  await closeColors(b);
  await a.bringToFront();
  await openColors(a); await a.waitForTimeout(100);
  check(JSON.stringify(await names(a, 'chart')) === '["Dark desk","White chart","From B"]', 'tab A sees B\'s preset on opening Colors again');
  await a.fill(group('chart') + ' .pr-name-in', 'From A'); await a.press(group('chart') + ' .pr-name-in', 'Enter'); await a.waitForTimeout(120);
  await closeColors(a);
  await a.reload(); await live(a);
  await openColors(a);
  check(JSON.stringify(await names(a, 'chart')) === '["Dark desk","White chart","From B","From A"]', 'after a reload: every chart preset, none undone');
  t = await theme(a);
  check(t.bg === '#F5F7FA' && t.vwap === '#6D28D9', 'after a reload: the light chart and its VWAP color');
  check((await levelColor(a, 'PDH')) === '#00AAFF', 'after a reload: the level colors in use');
  await closeColors(a);
  await b.close();
} finally {
  await browser.close();
  br.kill();
}
if (errors.length) { console.error('FAIL\n' + errors.join('\n')); process.exit(1); }
console.log('presets smoke: ok');
