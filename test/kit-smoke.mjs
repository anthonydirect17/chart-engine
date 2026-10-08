// Kit smoke test (live/kit.css, live/kit.js, live/kit.html, docs/KIT.md) in Chromium: the gallery loads with no console
// error, never scrolls sideways at 390, 1366 and 1920 px, the light circles only while lit, stands still with reduced
// motion and with motion off, and refuses on the mock ticket, Flatten and the copier. Screenshots in test/out/.
//   npm run smoke:kit        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
// The gallery is served as the PC serves it: nothing from the internet; its three fonts come from live/fonts.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const PORT = +(process.env.KIT_SMOKE_PORT || 8823);
const errors = [];
let checks = 0;
const check = (ok, m) => { checks++; if (!ok) { errors.push(m); console.error('  FAIL ' + m); } else console.log('  ok   ' + m); };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const URL = `http://127.0.0.1:${PORT}/live/kit.html`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

/** A page that records console errors, page errors and every request that left this PC. */
async function open(opts, w = 1440, h = 1000) {
  const page = await browser.newPage(Object.assign({ viewport: { width: w, height: h } }, opts || {}));
  page.consoleErrors = []; page.outside = []; page.warnings = [];
  page.on('console', m => { if (m.type() === 'error') page.consoleErrors.push(m.text()); if (m.type() === 'warning') page.warnings.push(m.text()); });
  page.on('pageerror', e => page.consoleErrors.push('page error: ' + e.message));
  page.on('request', r => { if (!/^http:\/\/127\.0\.0\.1:/.test(r.url()) && !/^data:/.test(r.url())) page.outside.push(r.url()); });
  await page.goto(URL);
  await page.evaluate(() => document.fonts.ready);
  return page;
}
// running kit-orbit animations inside an element (or the whole page)
const orbits = (page, sel) => page.evaluate(s => {
  const host = s ? document.querySelector(s) : document;
  return document.getAnimations().filter(a => a.animationName === 'kit-orbit' && host.contains(a.effect.target) && a.playState === 'running').length;
}, sel || null);

try {
  // ---- loads clean, offline, as the PC serves it
  const page = await open();
  check(page.consoleErrors.length === 0, 'the gallery loads with no console error: ' + JSON.stringify(page.consoleErrors));
  check(page.outside.length === 0, 'nothing loaded from outside this PC: ' + JSON.stringify(page.outside));
  check(await page.evaluate(() => typeof ChartKit === 'object' && ChartKit.VERSION === '1.0.0'), 'a plain script sets window.ChartKit');
  check(await page.evaluate(async () => {
    const keep = window.ChartKit; delete window.ChartKit;
    await import('/live/kit.js?as-module');
    const ok = typeof window.ChartKit.light === 'function'; window.ChartKit = keep; return ok;
  }), 'an ES module import sets window.ChartKit too');
  const tok = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById('kitRoot'));
    return Object.fromEntries(Object.keys(ChartKit.TOKENS).map(k => [k, cs.getPropertyValue('--kit-' + k).trim()]));
  });
  check(await page.evaluate(t => Object.keys(ChartKit.TOKENS).every(k => t[k].toLowerCase().replace(/\s/g, '') === ChartKit.TOKENS[k].toLowerCase()), tok), 'every token in kit.css on the page equals ChartKit.TOKENS');
  const fam = await page.evaluate(() => {
    const f = s => getComputedStyle(document.querySelector(s)).fontFamily;
    const has = (w, fam) => [...document.fonts].some(ff => ff.family.replace(/"/g, '') === fam && String(ff.weight) === String(w) && ff.status === 'loaded');
    return { head: f('#kitRoot .kit-btn'), body: f('#kitRoot'), mono: f('#kitRoot .kit-num'),
      loaded: { plex: has(400, 'IBM Plex Sans'), chakra: has(600, 'Chakra Petch'), jet: has(400, 'JetBrains Mono') && has(600, 'JetBrains Mono') } };
  });
  check(/^"?Chakra Petch"?, "?IBM Plex Sans Condensed"?/.test(fam.head) && /^"?IBM Plex Sans"?/.test(fam.body) && /^"?JetBrains Mono"?, "?IBM Plex Mono"?/.test(fam.mono), 'the hybrid: titles Chakra Petch, body IBM Plex Sans, numbers JetBrains Mono, with Plex fallbacks: ' + JSON.stringify(fam));
  check(fam.loaded.plex && fam.loaded.chakra && fam.loaded.jet, 'all three fonts load from the page folder (live/fonts), nothing from the internet: ' + JSON.stringify(fam.loaded));

  // ---- the light circles only while lit
  const lit = await page.evaluate(() => ({ demo: document.getElementById('lightDemo').classList.contains('kit-lit'), layers: document.querySelectorAll('#lightDemo > .kit-orbit, #lightDemo > .kit-halo > .kit-orbit').length,
    pc: getComputedStyle(document.getElementById('lightDemo')).getPropertyValue('--kit-pc').trim() }));
  check(lit.demo && lit.layers === 2, 'the light demo is lit with its two layers (orbit and halo)');
  check(await orbits(page, '#lightDemo') === 2, 'the lit panel\'s orbit and halo circle (a CSS animation, running)');
  check(await page.evaluate(() => getComputedStyle(document.querySelector('#lightDemo > .kit-orbit')).animationDuration) === '9s', 'a trade laps in 9 s');
  check(await page.evaluate(() => getComputedStyle(document.querySelector('#lightDecide > .kit-orbit')).animationDuration) === '13s', 'deciding laps in 13 s');
  await page.click('[data-trade="flat"]');
  check(await orbits(page, '#lightDemo') === 0, 'flat: the light stops (no running orbit on the panel)');
  check(await page.evaluate(() => !document.getElementById('lightDemo').classList.contains('kit-lit')), 'flat: no light at all');
  await page.click('[data-trade="loss"]');
  await page.waitForTimeout(1800);   // the colour fade
  check(await page.evaluate(() => getComputedStyle(document.querySelector('#lightDemo > .kit-orbit')).getPropertyValue('--kit-pc').trim()) === 'rgb(255, 122, 122)', 'under water: the light fades to the locked loss red');
  await page.locator('#lightTrading').screenshot({ path: path.join(out, 'kit-light-loss.png') });
  await page.click('[data-trade="profit"]');
  await page.waitForTimeout(1800);
  check(await page.evaluate(() => getComputedStyle(document.querySelector('#lightDemo > .kit-orbit')).getPropertyValue('--kit-pc').trim()) === 'rgb(61, 220, 151)', 'in profit: the light fades to the locked profit green');
  await page.locator('#lightTrading').screenshot({ path: path.join(out, 'kit-light-profit.png') });
  // numbers, chips and buttons never move: no transition and no animation on them
  const still = await page.evaluate(() => [...document.querySelectorAll('#kitRoot .kit-num, #kitRoot .kit-big, #kitRoot .kit-chip, #kitRoot .kit-btn, #kitRoot .kit-row, #kitRoot .kit-tag, #kitRoot .kit-tab, #kitRoot .kit-seg > button, #kitRoot .kit-meter > i')]
    .filter(el => { const s = getComputedStyle(el); return !(s.transitionDuration.split(',').every(d => parseFloat(d) === 0) && s.animationName === 'none'); }).map(el => el.className));
  check(still.length === 0, 'R3: no number, chip, button, row, tab or meter has a transition or an animation: ' + JSON.stringify(still.slice(0, 5)));

  // ---- the refusal on the mock ticket, Flatten and the copier
  const ref = await page.evaluate(() => ({
    ticket: galAttempt('ticket'), row: galAttempt('row'), flatten: galAttempt('flatten'), copier: galAttempt('copier'), flat: galAttempt('flat'),
    layers: document.querySelectorAll('#mockTicketPanel .kit-orbit, #mockCopier .kit-orbit, [data-try="flatten"] .kit-orbit').length,
    litInside: document.querySelectorAll('[data-no-light].kit-lit, [data-no-light] .kit-lit, .ws-flat.kit-lit, [data-copier].kit-lit').length,
    chart: galAttempt('chart'),
    log: document.getElementById('refusalLog').textContent,
  }));
  check(!ref.ticket && !ref.row && !ref.flatten && !ref.copier && ref.layers === 0 && ref.litInside === 0, 'the light refuses on the mock ticket, a ticket row, Flatten and the copier, and adds nothing to them');
  check(!ref.flat, 'outside the Agent tab a chart while flat (no trade) refuses');
  check(ref.chart, 'a chart panel in a trade lights');
  check(/Refused: ticket/.test(ref.log), 'the gallery says so in plain words');
  check(page.warnings.some(w => /^ChartKit: no light here/.test(w)), 'the refusal leaves a console note');
  check(page.consoleErrors.length === 0, 'still no console error after every control');

  // ---- motion off stops the light; the glow stays
  await page.click('[data-motion="off"]');
  const off = await page.evaluate(() => ({ cls: document.documentElement.classList.contains('kit-motion-off'), saved: localStorage.getItem('kit-motion-v1'),
    shadow: getComputedStyle(document.querySelector('#lightDemo > .kit-halo')).boxShadow, op: getComputedStyle(document.querySelector('#lightDemo > .kit-orbit')).opacity }));
  check(off.cls && off.saved === 'off', 'motion off: kit-motion-off on <html>, saved as kit-motion-v1 = off');
  check(await orbits(page) === 0, 'motion off: no orbit animation runs anywhere');
  check(off.shadow !== 'none' && off.op === '1', 'motion off: the lit panel keeps its glow and a still arc');
  await page.reload(); await page.evaluate(() => document.fonts.ready);
  check(await page.evaluate(() => document.documentElement.classList.contains('kit-motion-off') && ChartKit.motion() === 'off') && await orbits(page) === 0, 'motion off is remembered after a reload');
  await page.click('[data-motion="full"]');
  check(await orbits(page) > 0 && await page.evaluate(() => localStorage.getItem('kit-motion-v1')) === null, 'motion full: the light circles again and the setting is cleared');
  // the motion kit's Less motion stops it too
  check(await page.evaluate(() => { document.documentElement.classList.add('motion-off'); return ChartKit.reduced(); }) && await orbits(page) === 0, 'the motion kit\'s Less motion (motion-off on <html>) stops the light too');
  await page.evaluate(() => document.documentElement.classList.remove('motion-off'));

  // ---- screenshots
  // no explanatory labelling on a product screen: the three surface mocks have no legend, no sentence, no hint
  const told = await page.evaluate(() => [...document.querySelectorAll('#v-trading, #v-desk, #v-agent')].flatMap(s =>
    [...s.querySelectorAll('.kit-keys, .kit-key, p, .gal-note, .kit-step-sub')].filter(el => !(el.classList.contains('kit-step-sub') && /^[\d.]+ ?(s|ms)$/.test(el.textContent.trim()))).map(el => s.id + ' ' + el.className + ': ' + el.textContent.trim().slice(0, 40))));
  check(told.length === 0, 'the product mocks carry no legend, no explaining sentence and no hint: ' + JSON.stringify(told));
  check(await page.evaluate(() => !/\b(in profit|under water|tap one|tap a row)\b/i.test(['v-trading', 'v-desk', 'v-agent'].map(id => document.getElementById(id).textContent).join(' '))), 'no status words beside the light on the product mocks');
  await page.locator('#v-trading').screenshot({ path: path.join(out, 'kit-trading.png') });
  await page.locator('#v-desk').screenshot({ path: path.join(out, 'kit-desk.png') });
  await page.locator('#v-agent').screenshot({ path: path.join(out, 'kit-agent.png') });
  await page.locator('#armedRow').screenshot({ path: path.join(out, 'kit-armed.png') });
  const armed = await page.evaluate(() => {
    const el = document.getElementById('armedLit'), s = getComputedStyle(el), ring = getComputedStyle(el, '::after'), halo = getComputedStyle(el.querySelector(':scope > .kit-halo'));
    return { border: s.borderTopColor, ring: ring.borderTopColor, glow: halo.boxShadow, lit: el.classList.contains('kit-lit') };
  });
  check(armed.border === 'rgba(155, 123, 255, 0.32)' && armed.ring === 'rgba(155, 123, 255, 0.5)' && armed.lit && /rgb\(61, 220, 151\)/.test(armed.glow), 'armed and lit: the purple outline (a ring over the light) and the light\'s glow show together: ' + JSON.stringify(armed));
  // armed is trading truth: it shows and goes at once, even while lit
  const flip = await page.evaluate(() => {
    const el = document.getElementById('armedLit');
    ChartKit.armed(el, false); const off = { shadow: getComputedStyle(el).boxShadow, border: getComputedStyle(el).borderTopColor, ring: getComputedStyle(el, '::after').content };
    ChartKit.armed(el, true); const on = { shadow: getComputedStyle(el).boxShadow, ring: getComputedStyle(el, '::after').content };
    return { off, on, anims: el.getAnimations().length };
  });
  check(flip.off.shadow === 'none' && flip.off.ring === 'none' && /rgba\(123, 92, 255, 0\.55\)/.test(flip.on.shadow) && flip.on.ring !== 'none' && flip.anims === 0, 'the armed outline comes and goes at once, never fading: ' + JSON.stringify(flip));
  await page.screenshot({ path: path.join(out, 'kit-gallery-1440.png'), fullPage: true });
  await page.close();

  // ---- no sideways scroll at a phone, a laptop and a desktop
  for (const w of [390, 1366, 1920]) {
    const p = await open(null, w, 900);
    const o = await p.evaluate(() => {
      const cw = document.documentElement.clientWidth;
      // an element past the right edge (inside a box that scrolls or clips on its own is fine)
      const past = [...document.querySelectorAll('#kitRoot *')].filter(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.right <= cw + 0.5) return false;
        for (let a = el.parentElement; a; a = a.parentElement) { const s = getComputedStyle(a); if (s.overflowX !== 'visible') return false; }
        return true;
      }).map(el => el.tagName + '.' + el.className + ' ' + Math.round(el.getBoundingClientRect().right));
      return { sw: document.documentElement.scrollWidth, cw, bw: document.body.scrollWidth, past };
    });
    check(o.sw <= o.cw && o.bw <= o.cw && o.past.length === 0, `no horizontal scroll at ${w} px (${o.sw} <= ${o.cw}): ` + JSON.stringify(o.past.slice(0, 4)));
    check(p.consoleErrors.length === 0, `no console error at ${w} px`);
    await p.close();
  }

  // ---- the system's reduced motion: no orbit runs, the glow still shows
  const rm = await open({ reducedMotion: 'reduce' });
  const r = await rm.evaluate(() => ({ reduced: ChartKit.reduced(), lit: document.getElementById('lightDemo').classList.contains('kit-lit'), shadow: getComputedStyle(document.querySelector('#lightDemo > .kit-halo')).boxShadow,
    anim: getComputedStyle(document.querySelector('#lightDemo > .kit-orbit')).animationName }));
  check(r.reduced && r.lit && r.anim === 'none' && await orbits(rm) === 0, 'prefers-reduced-motion: the light is on but no orbit animation runs');
  check(r.shadow !== 'none', 'prefers-reduced-motion: the static glow still shows');
  check(rm.consoleErrors.length === 0, 'no console error with reduced motion');
  await rm.close();
} finally {
  await browser.close();
  server.close();
}
console.log(errors.length ? `\nkit smoke: ${errors.length} of ${checks} checks FAILED` : `\nkit smoke: all ${checks} checks passed`);
process.exit(errors.length ? 1 : 0);
