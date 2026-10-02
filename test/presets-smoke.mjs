// 1.9.0 smoke: color presets and the top bar following the chart, on the live page against the fake bridge (sample data
// only, never market data), trading on so the order bar shows:
//   npm run smoke:presets   (CHROMIUM_PATH=/path/to/chrome for a preinstalled browser; SHOTS=dir for the screenshots)
// Checks: the Colors panel's two preset groups (chart: bull, bear and background; indicator: every indicator color)
// save, replace by name, pick, rename and delete, and survive a reload and a second tab; VWAP is no longer in the
// Colors panel but in its gear, as are the levels', the IB's and the profile's colors, drawn at once; a VWAP color
// saved before 1.9.0 survives a ground change and a reload (review R1); a chart preset brings its indicator preset
// (the save row's "Indicator colors" select), a save never makes an indicator preset, a refused save writes nothing
// and a full group keeps a link (review 2 S1, S2), and one deleted since is ignored; the order bar is the 1.5.2 bar
// on the default ground and matches every other ground (review 1's 21 grounds: every text at full strength 4.5:1,
// every dimmed control at least as strong as on the house bar, disarmed, armed and trading off); the Armed switch,
// Buy and Flatten still work the same way. Screenshots of each go to SHOTS (default test/out).
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
const URL = `http://localhost:${br.port}/live/single.html`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await ctx.addInitScript(() => { setInterval(() => { const b = document.querySelector('.nostop-ask:not([hidden]) .nostop-send'); if (b) b.click(); }, 30); });   // 1.13.0: answers the one NO STOP question with Send
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
const theme = p => p.evaluate(() => { const t = window.liveChart.getTheme(); return { up: t.up, down: t.down, bg: t.bg, vwap: t.vwap, vpPoc: t.vpPoc, vpRow: t.vpRow, vpValue: t.vpValue }; });
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

/* Every text in the order bar and the status line, per ground and state, as review 1 measured it: the text over its
   own background and what is behind it, faded by its opacity. States: disarmed and armed, each with the state row's
   notes shown, and each with every control disabled (trading off). */
const REVIEW_GROUNDS = ['#080B10', '#000000', '#1B2433', '#F5F7FA', '#FFFFFF', '#E0E0E0', '#D0D0D0', '#C8C8C8', '#BBBBBB', '#B0B0B0', '#A0A0A0',
  '#808080', '#FFF8E1', '#FFE0E0', '#E8F5E9', '#E3F2FD', '#D0D8E0', '#F0E6FF', '#FFFF00', '#00FF00', '#FF00FF'];
const contrastSweep = (p, grounds) => p.evaluate(grounds => {
  const parse = s => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return [0, 0, 0, 0]; const a = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return [a[0], a[1], a[2], a.length > 3 ? a[3] : 1]; };
  const over = (f, b) => { const a = f[3]; return [f[0] * a + b[0] * (1 - a), f[1] * a + b[1] * (1 - a), f[2] * a + b[2] * (1 - a), 1]; };
  const lum = c => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }; return .2126 * f(c[0]) + .7152 * f(c[1]) + .0722 * f(c[2]); };
  const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const backdrop = el => { const chain = []; for (let e = el.parentElement; e; e = e.parentElement) chain.push(e); let b = [255, 255, 255, 1]; for (const e of chain.reverse()) { const bg = parse(getComputedStyle(e).backgroundColor); if (bg[3] > 0) b = over(bg, b); } return b; };
  const ownBg = (el, b) => { const bg = parse(getComputedStyle(el).backgroundColor); return bg[3] > 0 ? over(bg, b) : b; };
  const opac = el => { let o = 1; for (let e = el; e && e !== document.body; e = e.parentElement) o *= +getComputedStyle(e).opacity; return o; };
  const setBg = v => { const hex = document.querySelector('.ce-theme-panel input[data-hex="bg"]'); hex.value = v; hex.dispatchEvent(new Event('input', { bubbles: true })); };
  const $ = id => document.getElementById(id);
  const scan = () => [...document.querySelectorAll('.obar-ground, .obar-ground *, #statusMsg')].filter(e => e.offsetParent !== null || e.id === 'armBtn').flatMap(el => {
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!own && !/^(INPUT|SELECT)$/.test(el.tagName)) return [];
    const fg = parse(getComputedStyle(el).color), bd = backdrop(el), bg = ownBg(el, bd), o = opac(el), fgc = over(fg, bg);
    const final = o < 1 ? over([fgc[0], fgc[1], fgc[2], o], bd) : fgc, bgFinal = o < 1 ? over([bg[0], bg[1], bg[2], o], bd) : bg;
    return [{ id: el.id || (typeof el.className === 'string' && el.className) || el.tagName, text: (el.textContent || el.value || '').trim().slice(0, 24), cr: +cr(final, bgFinal).toFixed(2), o: +o.toFixed(3) }];
  });
  const notes = on => {
    $('oLegs').textContent = on ? 'No stop working' : ''; $('oLegs').classList.toggle('uncovered', on);
    $('oOther').textContent = on ? 'Another account on MNQ: LONG 1' : ''; $('oOther').classList.toggle('live', on);
    $('oAcctNote').textContent = on ? 'Orders go to Sim101' : ''; $('oAcctNote').classList.toggle('warn', on);
    $('oCancel').textContent = on ? 'Cancelling 2 orders' : ''; $('oCancel').classList.toggle('away', on);
    $('oOff').textContent = on ? 'Trading off: reason' : ''; $('oOff').hidden = !on;
    $('oPos').innerHTML = on ? '<span class="long">LONG 1</span> @ 100.00 <span class="profit">+2.00 pt +$4.00</span> <span class="loss">-1.00 pt</span> <span class="short">SHORT</span>' : 'Flat';
  };
  const out = {};
  for (const g of grounds) {
    setBg(g);
    const r = {};
    for (const armed of [false, true]) {
      if (($('armBtn').getAttribute('aria-checked') === 'true') !== armed) $('armBtn').click();
      notes(true);
      r[armed ? 'armed' : 'disarmed'] = scan();
      const dis = [...$('obar').querySelectorAll('button, input, select')].filter(e => e !== $('oAcct'));
      dis.forEach(e => { e.disabled = true; });
      r[armed ? 'armed, trading off' : 'disarmed, trading off'] = scan();
      dis.forEach(e => { e.disabled = false; });
      notes(false);
    }
    if ($('armBtn').getAttribute('aria-checked') === 'true') $('armBtn').click();
    out[g] = r;
  }
  setBg('#080B10');
  return out;
}, grounds);

/* A fresh browser profile at `origin` with only `seed` in its storage, loaded and live. */
async function freshPage(seed) {
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await c.addInitScript(() => { setInterval(() => { const b = document.querySelector('.nostop-ask:not([hidden]) .nostop-send'); if (b) b.click(); }, 30); });   // 1.13.0: answers the one NO STOP question with Send
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
  // Armed on the light bar: deep red (1.13.0; amber before), readable, and it still arms and disarms the same way
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
  // every other ground: the top bar matches it (Anthony: Black a black bar, Blue-grey a blue-grey one), as chromeColors
  const rgbOf = h => { const c = U.parseColor(h); return 'rgb(' + c.r + ', ' + c.g + ', ' + c.b + ')'; };
  for (const g of ['#000000', '#1B2433', '#888888', '#FFF8E1']) {
    await setBg(a, g); await a.waitForTimeout(60);
    const o = await obar(a), v = U.chromeColors(U.buildTheme({ bg: g }));
    check(o.ground === rgbOf(v['--bg']) && o.toolbar === o.ground && o.bar === rgbOf(v['--s2']) && o.buy === rgbOf(v['--buy']) && o.sell === rgbOf(v['--sell']) && o.scheme === v['--scheme'],
      g + ': the toolbar and the order bar match the ground (' + v['--bg'] + ', bar ' + v['--s2'] + ', Buy ' + v['--buy'] + ', Sell ' + v['--sell'] + ')');
  }
  await a.click(rowBtn('chart', 'Dark desk', 'pick')); await a.waitForTimeout(100);
  check(JSON.stringify(await obar(a)) === JSON.stringify(base), 'back on the default ground: the order bar exactly as before');

  /* ---------------- review 1's 21 grounds: every text at full strength 4.5:1, every dimmed control at least as strong
     as on the house bar (disarmed Buy 2.85, Sell 2.28, Flatten 4.01; trading off Buy 2.51), in every state */
  await closeColors(a);
  const sweep = await contrastSweep(a, REVIEW_GROUNDS);
  fs.writeFileSync(path.join(SHOTS, 'presets-contrast.json'), JSON.stringify(sweep));
  const house = sweep['#080B10'], weak = [], dimWeak = [], mins = {};
  for (const g of REVIEW_GROUNDS) for (const st of Object.keys(house)) {
    const els = sweep[g][st];
    if (els.length !== house[st].length) { weak.push(g + ' ' + st + ': ' + els.length + ' texts, ' + house[st].length + ' on the house bar'); continue; }
    els.forEach((e, i) => {
      const h = house[st][i], kind = e.o < 1 ? 'dim' : 'full', key = st + (kind === 'dim' ? ' (dimmed)' : '');
      if (e.id !== h.id || (e.o < 1) !== (h.o < 1)) { weak.push(g + ' ' + st + ' #' + i + ' ' + e.id + ' vs ' + h.id); return; }
      if (kind === 'full' && e.cr < 4.5) weak.push(g + ' ' + st + ' ' + e.id + ' "' + e.text + '" ' + e.cr);
      if (kind === 'dim' && e.cr < h.cr) dimWeak.push(g + ' ' + st + ' ' + e.id + ' ' + e.cr + ' < house ' + h.cr);
      if (!mins[key] || e.cr < mins[key].cr) mins[key] = { cr: e.cr, g, id: e.id };
    });
  }
  check(weak.length === 0, 'full strength: every order bar and status text reads 4.5:1 or more on the 21 grounds in 4 states: ' + weak.slice(0, 6).join('; '));
  check(dimWeak.length === 0, 'dimmed (disarmed, trading off): every control at least as strong as on the house bar on the 21 grounds: ' + dimWeak.slice(0, 6).join('; '));
  const dimHouse = st => Object.fromEntries(house[st].filter(e => e.o < 1).map(e => [e.id + (e.text ? ' ' + e.text : ''), e.cr]));
  console.log('       house bar dimmed, disarmed: ' + JSON.stringify(dimHouse('disarmed')));
  console.log('       house bar dimmed, trading off: ' + JSON.stringify(dimHouse('disarmed, trading off')));
  for (const k of Object.keys(mins)) console.log('       min ' + k + ': ' + mins[k].cr + ' (' + mins[k].g + ', ' + mins[k].id + ')');
  // the top bar on the four grounds and two custom ones, disarmed
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
