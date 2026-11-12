// The brand in a real page (chart 1.44.0), against the fake bridge (sample data; nothing reaches a broker). Anthony
// 2026-11-06: the chart page is AUREUS, the suite IMPERIUM. Checked: the wordmark (a small IMPERIUM above AUREUS, both gold,
// in Cinzel from this PC) fits the 40 px top bar at a desktop and a narrow width, the small line stays legible (its size,
// its drawn cap height, its contrast), nothing else on the page is in Cinzel (every price, time and live value stays IBM
// Plex Mono), no font comes from the internet, and the tab title. Screenshots in test/out/ (brand-*.png).
//   npm run smoke:brand        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, unlockIfAsked } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.BRAND_SMOKE_PORT || 9102);
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => bridge.stdout.once('data', r));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

/* WCAG contrast of two rgb() strings */
const lum = c => { const v = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

try {
  for (const vp of [{ w: 1600, h: 900, name: 'desktop' }, { w: 1000, h: 700, name: 'narrow' }]) {
    console.log(vp.name + ' (' + vp.w + ' px)');
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 2 });
    const outside = [];
    await ctx.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, r => { outside.push(r.request().url()); r.abort(); });
    const p = await ctx.newPage();
    p.on('pageerror', e => fail(vp.name + ' pageerror: ' + e.message));
    await p.goto(`http://localhost:${PORT}/live/`);
    check(await p.title() === 'Aureus · Imperium', 'the tab title while the page loads: ' + await p.title());
    await unlockIfAsked(p, TEST_PIN, 30000);
    await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 });
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(1500);
    check(/^Main · Aureus · Imperium$/.test(await p.title()), 'the tab title once live: ' + await p.title());

    const m = await p.evaluate(() => {
      const box = e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
      const bar = document.querySelector('header.ws-top'), mark = bar.querySelector('.ws-title.ws-mark');
      const suite = mark.querySelector('.ws-mark-suite'), name = mark.querySelector('.ws-mark-name'), conn = document.getElementById('wsConn');
      const cs = e => getComputedStyle(e);
      /* the faces really drawn: the page's Cinzel faces loaded, from this PC */
      const cinzel = [...document.fonts].filter(f => f.family.replace(/"/g, '') === 'Cinzel').map(f => f.weight + ' ' + f.status);
      /* the small line's cap height as drawn, in its own font (Cinzel's capitals) */
      const c = document.createElement('canvas').getContext('2d');
      c.font = cs(suite).fontWeight + ' ' + cs(suite).fontSize + ' ' + cs(suite).fontFamily;
      const capSuite = c.measureText('IMPERIUM').actualBoundingBoxAscent;
      c.font = cs(name).fontWeight + ' ' + cs(name).fontSize + ' ' + cs(name).fontFamily;
      const capName = c.measureText('AUREUS').actualBoundingBoxAscent;
      /* every element whose own text shows in Cinzel */
      const inCinzel = [...document.querySelectorAll('body *')].filter(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && /^"?Cinzel/.test(cs(e).fontFamily))
        .map(e => (e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + String(e.className).replace(/\s+/g, '.')) + ' ' + e.textContent.trim().slice(0, 20));
      /* the live values in the top bar and the panels: IBM Plex Mono, never Cinzel */
      const live = ['#wsClock', '#wsFeed', '#wsLocal', '#wsFps', '.ws-panel .tp-row', '.ws-panel .gr-row', '.ws-panel .ac-sum b'].flatMap(s => [...document.querySelectorAll(s)].slice(0, 3))
        .map(e => cs(e).fontFamily.split(',')[0].replace(/"/g, ''));
      return { bar: box(bar), mark: box(mark), suite: box(suite), name: box(name), conn: box(conn), cinzel, capSuite, capName, inCinzel, live,
        suiteFont: [cs(suite).fontFamily.split(',')[0].replace(/"/g, ''), cs(suite).fontWeight, parseFloat(cs(suite).fontSize)],
        nameFont: [cs(name).fontFamily.split(',')[0].replace(/"/g, ''), cs(name).fontWeight, parseFloat(cs(name).fontSize)],
        colors: [cs(suite).color, cs(name).color], ground: cs(bar).backgroundColor, text: [suite.textContent, name.textContent],
        label: mark.getAttribute('aria-label'),
        /* nothing cuts it: no hidden overflow on the wordmark or the bar, and both lines inside the bar */
        clipped: cs(mark).overflow !== 'visible' || cs(bar).overflow !== 'visible' || [suite, name].some(e => { const r = e.getBoundingClientRect(), q = bar.getBoundingClientRect(); return r.top < q.top || r.bottom > q.bottom; }) };
    });
    check(m.bar.h === 40, 'the top bar stays 40 px: ' + m.bar.h);
    check(m.text[0] === 'IMPERIUM' && m.text[1] === 'AUREUS' && m.label === 'Aureus, Imperium', 'IMPERIUM above AUREUS, read as "Aureus, Imperium"');
    check(m.suite.b <= m.name.t + 0.5 && Math.abs((m.suite.l + m.suite.r) / 2 - (m.name.l + m.name.r) / 2) < 3, 'two lines, stacked and centered on each other');
    check(m.mark.t >= m.bar.t + 3 && m.mark.b <= m.bar.b - 3 && !m.clipped, 'the wordmark fits inside the bar, not cut: ' + Math.round(m.mark.t - m.bar.t) + ' to ' + Math.round(m.mark.b - m.bar.t) + ' px');
    check(m.mark.r < m.conn.l && m.mark.w <= 102, 'no wider than TRADING SCREEN was (102 px), clear of the connection: ' + Math.round(m.mark.w) + ' px');
    check(m.cinzel.includes('600 loaded') && m.cinzel.includes('700 loaded'), 'Cinzel 600 and 700 loaded: ' + m.cinzel.join(', '));
    check(outside.length === 0, 'nothing loaded from the internet: ' + outside.join(', '));
    check(m.suiteFont[0] === 'Cinzel' && m.suiteFont[1] === '600' && m.suiteFont[2] === 10, 'IMPERIUM in Cinzel 600 10px: ' + m.suiteFont.join(' '));
    check(m.nameFont[0] === 'Cinzel' && m.nameFont[1] === '700' && m.nameFont[2] >= 14, 'AUREUS in Cinzel 700, 14px or more: ' + m.nameFont.join(' '));
    check(m.capSuite >= 6.5, 'IMPERIUM legible: capitals ' + m.capSuite.toFixed(2) + ' px tall as drawn (at least 6.5)');
    check(m.capName >= 11, 'AUREUS capitals ' + m.capName.toFixed(2) + ' px tall');
    check(m.colors.every(c => c === 'rgb(226, 198, 135)'), 'both lines in the wordmark gold #E2C687: ' + m.colors.join(', '));
    const k = contrast(m.colors[0], m.ground);
    check(k >= 7, 'the gold on the bar: ' + k.toFixed(2) + ':1 (at least 7:1 for the small line)');
    /* 1.50.0 (house style V2, the kickoff of 2026-11-12: Cinzel for titles only, never a live value): the Colosseum's name is a title */
    const titles = m.inCinzel.filter(t => /^h1\.lg-word Colosseum$/.test(t));
    check(m.inCinzel.length === 2 + titles.length && titles.length <= 1 && m.inCinzel.filter(t => !titles.includes(t)).every(t => /ws-mark-(suite|name)/.test(t)), 'nothing but the wordmark and the Colosseum\'s title is in Cinzel: ' + m.inCinzel.join('; '));
    check(m.live.length >= 4 && m.live.every(f => f === 'IBM Plex Mono'), 'live values stay IBM Plex Mono (' + m.live.length + ' checked): ' + [...new Set(m.live)].join(', '));
    await p.locator('header.ws-top').screenshot({ path: path.join(out, 'brand-topbar-' + vp.w + '.png') });
    await p.screenshot({ path: path.join(out, 'brand-page-' + vp.w + '.png') });
    await p.close(); await ctx.close();
  }
  /* the small line at 1x (no high-density screen): a close crop to look at */
  const ctx1 = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
  const p1 = await ctx1.newPage();
  await p1.goto(`http://localhost:${PORT}/live/`);
  await unlockIfAsked(p1, TEST_PIN, 30000);
  await p1.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 });
  await p1.evaluate(() => document.fonts.ready); await p1.waitForTimeout(800);
  const b = await p1.locator('header.ws-top').boundingBox();
  await p1.screenshot({ path: path.join(out, 'brand-wordmark-1x.png'), clip: { x: 0, y: 0, width: 360, height: b.height } });
  check(true, 'the wordmark at 1x: test/out/brand-wordmark-1x.png');
  await ctx1.close();
} catch (e) {
  fail('smoke error: ' + (e && e.stack || e));
} finally {
  await browser.close();
  bridge.kill();
}
console.log(errors.length ? `\n${errors.length} of ${checks} checks failed` : `\nall ${checks} checks passed`);
process.exit(errors.length ? 1 : 0);
