// 1.9.0 smoke: color presets and the top bar following the chart, on a mounted chart with its toolbar (test/chart-host.html;
// the single chart page until chart 1.21.0) against the fake bridge (sample data only, never market data):
//   npm run smoke:presets   (CHROMIUM_PATH=/path/to/chrome for a preinstalled browser; SHOTS=dir for the screenshots)
// Checks: the Colors panel's two preset groups (chart: bull, bear and background; indicator: every indicator color)
// save, replace by name, pick, rename and delete, and survive a reload and a second tab; VWAP is no longer in the
// Colors panel but in its gear, as are the levels', the IB's and the profile's colors, drawn at once; a VWAP color
// saved before 1.9.0 survives a ground change and a reload (review R1); a chart preset brings its indicator preset
// (the save row's "Indicator colors" select), a save never makes an indicator preset, a refused save writes nothing
// and a full group keeps a link (review 2 S1, S2), and one deleted since is ignored; the toolbar follows every ground.
// (1.21.0: the single chart page's order bar and its 21-ground contrast sweep went with that page.) Screenshots of each go
// to SHOTS (default test/out).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { C, hostUrl, waitLive } from './chart-host.mjs';

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
    const b = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(port), '--pin-off', '--test-controls', '--clock-offset=' + offset], { stdio: ['ignore', 'pipe', 'pipe'] });
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
const URL = hostUrl(br.port);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await ctx.addInitScript(`(() => { const realNow = Date.now; Date.now = () => realNow() + ${offset * 1000}; })();`);
await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
const live = p => waitLive(p).then(() => p.waitForTimeout(600));
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
const theme = p => p.evaluate(() => { const t = window.liveChart.getTheme(); return { up: t.up, down: t.down, bg: t.bg, vwap: t.vwap, vpPoc: t.vpPoc, vpRow: t.vpRow, vpValue: t.vpValue }; });
const levelColor = (p, name) => p.evaluate(n => { const l = window.liveChart.getLevels().find(x => x.name === n); return l ? l.color : null; }, name);
async function openGear(p, id) {
  if (await p.isHidden(C('indPanel'))) await p.click(C('indBtn'));
  await p.waitForSelector(C('indPanel') + ':not([hidden])');
  if (!(await p.$(`.ind-set[data-id="${id}"]`))) {
    // one off this chart (the profile is off by default) waits in its folded group
    const cat = CE_CATS[id];
    if (!(await p.$(`${C('indBody')} [data-act="gear"][data-id="${id}"]`)) && cat) await p.click(`${C('indBody')} [data-act="cat"][data-id="${cat}"]`);
    await p.click(`${C('indBody')} [data-act="gear"][data-id="${id}"]`);
  }
  await p.waitForSelector(`.ind-set[data-id="${id}"]`);
}
const closeMenu = async p => { if (await p.isVisible(C('indPanel'))) { await p.keyboard.press('Escape'); await p.waitForTimeout(100); } };
const typeHex = async (p, sel, v) => { await p.fill(sel, v); await p.waitForTimeout(80); };
/* the toolbar as drawn: its ground and color scheme (it follows the chart's ground, 1.9.0) */
const toolbarLook = p => p.evaluate(() => { const cs = getComputedStyle(document.querySelector('.chart-live')); return { toolbar: cs.backgroundColor, scheme: getComputedStyle(document.querySelector('.chart-live .bar')).colorScheme }; });

/* A fresh browser profile at `origin` with only `seed` in its storage, loaded and live. */
async function freshPage(seed) {
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await c.addInitScript(`(() => { const realNow = Date.now; Date.now = () => realNow() + ${offset * 1000}; })();`);
  await c.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const p = await c.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  await p.goto(URL); await live(p);
  await p.evaluate(seed => { localStorage.clear(); for (const k in seed) localStorage.setItem(k, JSON.stringify(seed[k])); }, seed);
  await p.reload(); await live(p);
  return { p, close: () => c.close() };
}

try {
  /* ---------------- review R1: a VWAP color saved before 1.9.0, then a ground change first, then a reload */
  {
    const { p, close } = await freshPage({ 'live-colors-v1': { up: '#4B9CD3', down: '#6D28D9', vwap: '#FFCC00', bg: '#080B10' } });
    check((await theme(p)).vwap === '#FFCC00', 'R1: the 1.8 VWAP color #FFCC00 drawn after the upgrade');
    const ic = await p.evaluate(() => JSON.parse(localStorage.getItem('live-indicator-colors-v1')));
    check(ic && ic.vwap === '#FFCC00', 'R1: copied into live-indicator-colors-v1 on page start: ' + JSON.stringify(ic));
    await openColors(p); await p.click('.ce-ground[data-bg="black"]'); await p.waitForTimeout(150); await closeColors(p);
    const cols = await p.evaluate(() => JSON.parse(localStorage.getItem('live-colors-v1')));
    check(cols.bg === '#000000' && !('vwap' in cols), 'R1: the Black ground written by the Colors panel, which no longer keeps the VWAP: ' + JSON.stringify(cols));
    await p.reload(); await live(p);
    const t1 = await theme(p);
    check(t1.vwap === '#FFCC00' && t1.bg === '#000000', 'R1: after the ground change and a reload the VWAP is still #FFCC00: ' + JSON.stringify(t1));
    await close();
  }

  const a = await openPage();

  /* ---------------- the Colors panel: two preset groups, VWAP gone from it */
  await openColors(a);
  check(!(await a.$('.ce-theme-panel input[data-k="vwap"]')) && !!(await a.$('.ce-theme-panel input[data-k="up"]')), 'Colors panel: Bull and Bear pickers, no VWAP picker (it is in the VWAP gear)');
  check((await a.$$('.pr-group')).length === 2 && (await a.textContent(group('chart') + ' .ce-lbl')) === 'Chart presets' && (await a.textContent(group('indicator') + ' .ce-lbl')) === 'Indicator presets',
    'two preset groups: Chart presets and Indicator presets');
  check((await a.textContent(group('chart') + ' .pr-empty')) === 'None saved yet.', 'none saved yet');
  check(/saved in this browser only/i.test(await a.textContent('.ce-theme-panel > .ce-note:last-child')), 'the panel says where presets are kept (this browser, until the shared store)');
  const base = await toolbarLook(a);
  await shot(a, 'presets-colors-panel-dark-empty');

  /* ---------------- save a white chart look, then a dark one */
  await a.click('.ce-ground[data-bg="light"]');
  await a.fill('.ce-theme-panel input[data-hex="up"]', '#1F6FB2'); await a.waitForTimeout(80);
  const indSel = () => a.$$eval(group('chart') + ' .pr-ind option', (os, v) => ({ value: document.querySelector(v).value, options: os.map(o => o.textContent) }), group('chart') + ' .pr-ind');
  let sel = await indSel();
  check((await a.textContent(group('chart') + ' .pr-inc')).startsWith('Indicator colors') && sel.value === '' && JSON.stringify(sel.options) === '["None"]' && !(await a.$(group('indicator') + ' .pr-ind')),
    'Q4: the chart group\'s save row has "Indicator colors: None" while there is no indicator preset; the indicator group has none: ' + JSON.stringify(sel));
  await a.fill(group('chart') + ' .pr-name-in', 'White chart');
  check((await a.textContent(group('chart') + ' [data-act="save"]')) === 'Save', 'a new name: Save');
  await a.press(group('chart') + ' .pr-name-in', 'Enter'); await a.waitForTimeout(150);
  check(JSON.stringify(await names(a, 'chart')) === '["White chart"]' && JSON.stringify(await pressed(a, 'chart')) === '["White chart"]', 'Enter saved "White chart", shown as in use: ' + await names(a, 'chart'));
  check((await note(a, 'chart')) === 'Saved White chart.' && (await a.inputValue(group('chart') + ' .pr-name-in')) === '', 'note "Saved White chart.", the box emptied');
  check(JSON.stringify(await names(a, 'indicator')) === '[]' && !('ind' in (await a.evaluate(() => JSON.parse(localStorage.getItem('live-color-presets-v1')))).chart[0]), 'saved with None: no link kept, no indicator preset made');
  await a.click('.ce-ground[data-bg="dark"]'); await a.fill('.ce-theme-panel input[data-hex="up"]', '#4B9CD3'); await a.waitForTimeout(80);
  await a.fill(group('chart') + ' .pr-name-in', 'Dark desk'); await a.click(group('chart') + ' [data-act="save"]'); await a.waitForTimeout(150);
  check(JSON.stringify(await pressed(a, 'chart')) === '["Dark desk"]', 'the dark look saved and in use; White chart is not');
  // typing an existing name (any case) offers Replace, and replacing keeps one preset of that name
  await a.fill(group('chart') + ' .pr-name-in', 'white CHART');
  check((await a.textContent(group('chart') + ' [data-act="save"]')) === 'Replace', 'an existing name, any case: Replace');
  await a.fill(group('chart') + ' .pr-name-in', '');

  /* ---------------- pick: White chart gives the light chart and the light toolbar */
  await a.click(rowBtn('chart', 'White chart', 'pick')); await a.waitForTimeout(250);
  let t = await theme(a);
  check(t.bg === '#F5F7FA' && t.up === '#1F6FB2' && t.down === '#6D28D9', 'picking White chart: its bull, bear and background: ' + JSON.stringify(t));
  check(JSON.stringify(await pressed(a, 'chart')) === '["White chart"]' && (await note(a, 'chart')) === 'Using White chart.', 'White chart in use');
  await shot(a, 'presets-colors-panel-light');
  await closeColors(a);
  let ob = await toolbarLook(a);
  check(ob.toolbar === 'rgb(245, 247, 250)' && ob.scheme === 'light', 'white chart, white top bar: the toolbar follows the chart: ' + JSON.stringify(ob));
  await a.mouse.move(700, 600);
  await shot(a, 'presets-light-top-bar');

  /* ---------------- the dark grounds: the toolbar as before the presets were used */
  await openColors(a);
  await a.click(rowBtn('chart', 'Dark desk', 'pick')); await a.waitForTimeout(200);
  ob = await toolbarLook(a);
  check(ob.toolbar === 'rgb(8, 11, 16)' && JSON.stringify(ob) === JSON.stringify(base), 'dark ground: the toolbar exactly as before the presets were used: ' + JSON.stringify(ob));
  // every other ground: the top bar matches it (Anthony: Black a black bar, Blue-grey a blue-grey one), as chromeColors
  const rgbOf = h => { const c = U.parseColor(h); return 'rgb(' + c.r + ', ' + c.g + ', ' + c.b + ')'; };
  for (const g of ['#000000', '#1B2433', '#888888', '#FFF8E1']) {
    await setBg(a, g); await a.waitForTimeout(60);
    const o = await toolbarLook(a), v = U.chromeColors(U.buildTheme({ bg: g }));
    check(o.toolbar === rgbOf(v['--bg']) && o.scheme === v['--scheme'], g + ': the toolbar matches the ground (' + v['--bg'] + ', ' + v['--scheme'] + ')');
  }
  await a.click(rowBtn('chart', 'Dark desk', 'pick')); await a.waitForTimeout(100);
  check(JSON.stringify(await toolbarLook(a)) === JSON.stringify(base), 'back on the default ground: the toolbar exactly as before');

  await closeColors(a);
  // the top bar on the four grounds and two custom ones
  for (const [g, name] of [['#080B10', 'dark'], ['#000000', 'black'], ['#1B2433', 'blue-grey'], ['#F5F7FA', 'light'], ['#808080', 'custom-808080'], ['#FFF8E1', 'custom-FFF8E1']]) {
    await setBg(a, g); await a.mouse.move(700, 600); await a.waitForTimeout(200);
    await a.screenshot({ path: path.join(SHOTS, 'presets-top-bar-' + name + '.png'), clip: { x: 0, y: 0, width: 1440, height: 330 } });
  }
  await setBg(a, '#080B10'); await a.waitForTimeout(60);
  await openColors(a);
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
  check((await a.$$('.ind-set[data-id="levels"] .ind-color')).length === 6, 'Levels gear: prior day, overnight, value area, prior close and the IB high and low (1.14.0)');
  await typeHex(a, '.ind-set[data-id="levels"] input[data-hk="prior"]', '#00AAFF');
  check((await levelColor(a, 'PDH')) === '#00AAFF' && (await levelColor(a, 'PDL')) === '#00AAFF', 'prior day high and low drawn in #00AAFF at once');
  await typeHex(a, '.ind-set[data-id="levels"] input[data-hk="ibHigh"]', '#FFD0F0');
  check((await levelColor(a, 'IBH')) === '#FFD0F0', 'IB high #FFD0F0 at once: ' + await levelColor(a, 'IBH'));
  await openGear(a, 'vp');
  await typeHex(a, '.ind-set[data-id="vp"] input[data-hk="vpPoc"]', '#FFFFFF');
  check((await theme(a)).vpPoc === '#FFFFFF', 'profile POC #FFFFFF');
  // 1.14.0 (Anthony): the profile's rows and value area in its gear too
  check((await a.$$('.ind-set[data-id="vp"] .ind-color')).length === 3, 'Profile gear: rows, value area rows, point of control');
  await typeHex(a, '.ind-set[data-id="vp"] input[data-hk="vpRow"]', '#334455');
  await typeHex(a, '.ind-set[data-id="vp"] input[data-hk="vpValue"]', '#556677');
  t = await theme(a);
  check(t.vpRow === '#334455' && t.vpValue === '#556677', 'profile rows #334455 and value area #556677 drawn at once: ' + t.vpRow + ' ' + t.vpValue);
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
  sel = await indSel();
  check(sel.value && JSON.stringify(sel.options) === '["None","Dark indicators","Light indicators"]' && (await a.$eval(group('chart') + ' .pr-ind', e => e.selectedOptions[0].textContent)) === 'Light indicators',
    'Q4: the select lists None and every indicator preset, set to the one holding the colors in use: ' + JSON.stringify(sel));
  await a.fill(group('chart') + ' .pr-name-in', 'White chart'); await a.press(group('chart') + ' .pr-name-in', 'Enter'); await a.waitForTimeout(120);
  check((await note(a, 'chart')) === 'Saved White chart, with the indicator preset Light indicators.', 'Q4: White chart saved, linked to the indicator preset holding the colors in use: ' + await note(a, 'chart'));
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

  /* ---------------- Q4: a chart preset brings its indicator preset; a save never makes one; review 2 S1 and S2; a
     deleted one is ignored */
  const stored = () => a.evaluate(() => JSON.parse(localStorage.getItem('live-color-presets-v1')));
  const writeStored = v => a.evaluate(v => localStorage.setItem('live-color-presets-v1', JSON.stringify(v)), v);
  const reopen = async () => { await closeColors(a); await openColors(a); await a.waitForTimeout(120); };   // the panel reads the store again
  const rows = gr => a.$$eval(group(gr) + ' .pr-row', r => r.length);
  let all = await stored();
  const lightInd = all.indicator.find(x => x.name === 'Light indicators'), darkInd = all.indicator.find(x => x.name === 'Dark indicators');
  check(all.chart.find(x => x.name === 'White chart').ind === lightInd.id && !('ind' in all.chart.find(x => x.name === 'Dark desk')), 'Q4: White chart keeps the id of Light indicators; Dark desk (saved with None) has none');
  await a.click(rowBtn('indicator', 'Dark indicators', 'pick')); await a.waitForTimeout(120);
  check((await theme(a)).vwap === '#FF8800', 'Dark indicators in use (VWAP #FF8800)');
  await a.click(rowBtn('chart', 'White chart', 'pick')); await a.waitForTimeout(150);
  t = await theme(a);
  check(t.bg === '#F5F7FA' && t.vwap === '#6D28D9' && JSON.stringify(await pressed(a, 'indicator')) === '["Light indicators"]' && (await note(a, 'chart')) === 'Using White chart, with Light indicators.',
    'Q4: picking White chart also applies Light indicators: ' + JSON.stringify(t) + ' ' + await note(a, 'chart'));
  // indicator colors no preset holds: the select says None, the save makes no indicator preset and links nothing
  await closeColors(a);
  await openGear(a, 'vwap'); await typeHex(a, '.ind-set[data-id="vwap"] input[data-hk="vwap"]', '#12AB34'); await closeMenu(a);
  await openColors(a);
  const nInd = (await stored()).indicator.length;
  check((await indSel()).value === '', 'Q4: colors no indicator preset holds: the select says None');
  await a.fill(group('chart') + ' .pr-name-in', 'Linked new'); await a.press(group('chart') + ' .pr-name-in', 'Enter'); await a.waitForTimeout(150);
  all = await stored();
  check(all.indicator.length === nInd && !('ind' in all.chart.find(x => x.name === 'Linked new')) && (await note(a, 'chart')) === 'Saved Linked new.',
    'Q4: a chart save never makes an indicator preset: ' + all.indicator.length + ' indicator presets, note ' + await note(a, 'chart'));
  // picked by hand: re-saving links exactly what the select says
  await a.selectOption(group('chart') + ' .pr-ind', darkInd.id);
  await a.fill(group('chart') + ' .pr-name-in', 'Linked new'); await a.press(group('chart') + ' .pr-name-in', 'Enter'); await a.waitForTimeout(150);
  all = await stored();
  check(all.chart.find(x => x.name === 'Linked new').ind === darkInd.id && (await note(a, 'chart')) === 'Replaced Linked new, with the indicator preset Dark indicators.' && (await indSel()).value === '',
    'Q4: re-saved with Dark indicators picked by hand: linked to it; the select follows the colors in use again: ' + await note(a, 'chart'));
  // review 2 S2: the indicator group full, White chart re-saved with its link picked: the link stays, nothing made
  const full = await stored();
  for (let i = full.indicator.length; i < LP.PRESET_MAX; i++) full.indicator.push({ id: 'pfill' + i, name: 'Fill ' + i, colors: Object.assign({}, lightInd.colors, { vwap: '#0000' + String(i).padStart(2, '0') }) });
  await writeStored(full); await reopen();
  await a.selectOption(group('chart') + ' .pr-ind', lightInd.id);
  await a.fill(group('chart') + ' .pr-name-in', 'White chart'); await a.press(group('chart') + ' .pr-name-in', 'Enter'); await a.waitForTimeout(150);
  all = await stored();
  check(all.indicator.length === LP.PRESET_MAX && all.chart.find(x => x.name === 'White chart').ind === lightInd.id && /^Replaced White chart, with the indicator preset Light indicators\.$/.test(await note(a, 'chart')),
    'S2: indicator group full, White chart re-saved: its link to Light indicators kept, no indicator preset made: ' + await note(a, 'chart'));
  // review 2 S1: the chart group full: the refused save writes nothing, and the panel lists what the store holds
  const fullC = await stored();
  for (let i = fullC.chart.length; i < LP.PRESET_MAX; i++) fullC.chart.push({ id: 'cfill' + i, name: 'Chart ' + i, colors: { up: '#4B9CD3', down: '#6D28D9', bg: '#080B10' } });
  await writeStored(fullC);                                         // as another window would: the panel still lists the old ones
  check((await rows('chart')) < LP.PRESET_MAX, 'S1: the panel does not know of the presets written meanwhile');
  const raw0 = await a.evaluate(() => localStorage.getItem('live-color-presets-v1'));
  await a.selectOption(group('chart') + ' .pr-ind', lightInd.id);
  await a.fill(group('chart') + ' .pr-name-in', 'One too many'); await a.press(group('chart') + ' .pr-name-in', 'Enter'); await a.waitForTimeout(150);
  const raw1 = await a.evaluate(() => localStorage.getItem('live-color-presets-v1'));
  check(raw1 === raw0 && /holds 24 presets/.test(await note(a, 'chart')) && (await rows('chart')) === LP.PRESET_MAX && (await rows('indicator')) === LP.PRESET_MAX,
    'S1: chart group full: refused with the message, nothing written (no orphan), and the panel lists the store again on the refusal: ' + await note(a, 'chart'));
  await writeStored(all); await reopen();                           // back to the presets before the fill
  // the linked indicator preset deleted: the chart preset still works, no link, no error
  await a.click(rowBtn('indicator', 'Light indicators', 'delete')); await a.click(group('indicator') + ' [data-act="delete-ok"]'); await a.waitForTimeout(120);
  await a.click(rowBtn('chart', 'Dark desk', 'pick')); await a.waitForTimeout(120);
  await a.click(rowBtn('chart', 'White chart', 'pick')); await a.waitForTimeout(150);
  t = await theme(a);
  check(t.bg === '#F5F7FA' && t.vwap === '#12AB34' && (await note(a, 'chart')) === 'Using White chart.', 'Q4: White chart after Light indicators was deleted: its chart colors, the indicator colors left as they were, no error: ' + JSON.stringify(t));
  await closeColors(a);
  await b.close();
} finally {
  await browser.close();
  br.kill();
}
if (errors.length) { console.error('FAIL\n' + errors.join('\n')); process.exit(1); }
console.log('presets smoke: ok');
