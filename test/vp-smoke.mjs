// Volume profile smoke (1.6.0): the live page on NQ Range 40 against the fake bridge (SAMPLE data
// only, never market data), at 13:00 New York time on the most recent weekday with a regular session, so the full
// session (from 18:00 the evening before) and RTH (from 9:30) differ.
//   npm run smoke:vp        (CHROMIUM_PATH=/path/to/chrome for a preinstalled browser; SHOTS=dir for the screenshots)
// Checks: off by default and counted in the Indicators menu; on from the menu draws bars at the right edge of the plot
// (POC row in its color reaching VP_WIDTH of the plot width, value-area rows, nothing in the left half); the profile
// holds exactly the trades the page got (every backfill and live trade counted independently in the page) for the
// session and for RTH; Session and RTH differ and the legend follows; both choices survive a reload; a mounted chart's
// documented API (setIndicatorOption) and a new pane with the profile off; two tabs, where a stale tab's pick is saved
// as it shows it (review S2). Screenshots, labelled as sample data.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CE = require('../src/chart-engine.js'), U = CE.util;
const BB = require('../live/bar-builder.js');
const SHOTS = path.resolve(process.env.SHOTS || path.join(root, 'test', 'out'));
fs.mkdirSync(SHOTS, { recursive: true });
const BASE_PORT = +(process.env.VP_SMOKE_PORT || 8851);
const errors = [];
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { if (!ok) fail(m); else console.log('  ok   ' + m); };
async function until(fn, what, ms) {
  const end = Date.now() + (ms || 8000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) { fail('timed out: ' + what); return null; }
    await new Promise(r => setTimeout(r, 100));
  }
}

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

let port = BASE_PORT;
async function startBridge(offset, extra) {
  for (let tries = 0; tries < 8; tries++, port++) {
    const p = port;
    const b = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(p), '--pin-off', '--test-controls', '--clock-offset=' + offset].concat(extra || []), { stdio: ['ignore', 'pipe', 'pipe'] });
    let errText = '';
    b.stderr.on('data', d => { errText += d; });
    const ok = await new Promise(res => { b.stdout.once('data', () => res(true)); b.once('exit', () => res(false)); });
    if (ok) { port++; return { port: p, kill: () => b.kill() }; }
    if (!/EADDRINUSE/.test(errText)) throw new Error('bridge failed: ' + errText);
  }
  throw new Error('no free port from ' + BASE_PORT);
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
/* The page's clock `offset` seconds off; NQ Range 40 on a first visit; every NQ trade the page receives recorded. */
async function context(offset) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(`(() => {
    const realNow = Date.now; Date.now = () => realNow() + ${offset * 1000};
    try {
      if (!localStorage.getItem('live-settings-v2')) localStorage.setItem('live-settings-v2', JSON.stringify({ root: 'NQ', tf: 'range', glide: 'smooth', rangeMode: 'nt' }));
      if (!localStorage.getItem('live-range-v2')) localStorage.setItem('live-range-v2', JSON.stringify({ NQ: 40 }));
    } catch (e) {}
    const rec = window.__trades = [];
    const d = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
    Object.defineProperty(WebSocket.prototype, 'onmessage', { configurable: true, get() { return d.get.call(this); }, set(fn) {
      d.set.call(this, ev => {
        if (typeof ev.data === 'string') {
          if (ev.data.startsWith('{"type":"ticks"')) { const m = JSON.parse(ev.data); if (m.root === 'NQ') for (const x of m.ticks) rec.push(x); }
          else if (ev.data.startsWith('{"type":"tick"')) { const m = JSON.parse(ev.data); if (m.root === 'NQ') rec.push([m.t, m.p, m.v || 0]); }
          else if (ev.data.startsWith('{"type":"hello"')) rec.length = 0;
        }
        return fn(ev);
      });
    } });
  })();`);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  return ctx;
}
const live = p => p.waitForFunction(() => document.getElementById('connPill') && document.getElementById('connPill').textContent === 'LIVE', null, { timeout: 30000 }).then(() => p.waitForTimeout(800));
async function openPage(ctx, url) {
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fail('console: ' + m.text()); });
  await p.goto(url);
  await live(p);
  return p;
}
/* The profile as the page holds it, and the same sums counted independently from every trade the page received. */
const state = p => p.evaluate(() => {
  const vp = window.liveChart.getProfile(), now = Date.now() / 1000;
  const et = window.ChartEngine.util.zoneSeconds(now), day = Math.floor((et + 86400 - 64800) / 86400);
  const sessionFrom = (day - 1) * 86400 + 64800, rthFrom = day * 86400 + 34200, rthTo = day * 86400 + 57600;
  let session = 0, rth = 0, lo = Infinity, hi = -Infinity;
  for (const [t, , v] of window.__trades) {
    if (t >= sessionFrom && v > 0) session += v;
    if (t >= rthFrom && t < rthTo && v > 0) rth += v;
  }
  for (const [t, pr] of window.__trades) if (t >= rthFrom && t < rthTo) { lo = Math.min(lo, pr); hi = Math.max(hi, pr); }
  const lg = document.getElementById('lgVp');
  return {
    on: window.liveChart.getLayers().vp, has: !!vp, rth: vp ? vp.rth : null, total: vp ? vp.total : null, low: vp ? vp.low : null, high: vp ? vp.high : null,
    poc: vp && vp.poc() ? vp.poc().price : null, va: vp && vp.valueArea() ? [vp.valueArea().val, vp.valueArea().vah] : null,
    expect: { session, rth, rthLow: lo, rthHigh: hi }, legend: lg && !lg.hidden ? lg.textContent : null,
    // the Session / RTH switch in the profile's gear panel (Indicators menu, 1.6.0), when that panel is open
    pressed: (() => { const b = [...document.querySelectorAll('#indBody [data-act="opt"][data-id="vp"]')]; return b.length ? b.filter(x => x.getAttribute('aria-pressed') === 'true').map(x => x.dataset.v) : null; })(),
    note: document.getElementById('vpNote').hidden ? '' : document.getElementById('vpNote').textContent,
    day: vp && vp.day !== null ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(vp.day * 86400000).getUTCDay()] : null,   // the session's trading day (1.6.1)
  };
});
/* Pixels of the profile's colors on the canvas: along the POC row, and in the column just left of the plot's right edge. */
const pixels = p => p.evaluate(() => {
  const chart = window.liveChart, c = document.querySelector('#chart canvas'), x = c.getContext('2d'), dpr = devicePixelRatio;
  const T = chart.colors(), rgb = h => { const m = /^#(..)(..)(..)$/.exec(h); return [1, 2, 3].map(i => parseInt(m[i], 16)); };
  const want = { poc: rgb(T.vpPoc), value: rgb(T.vpValue), row: rgb(T.vpRow) };
  const plotW = c.width / dpr - 78, right = Math.round(plotW * dpr);
  const img = x.getImageData(0, 0, c.width, c.height).data;
  const at = (px, py) => { const i = (py * c.width + px) * 4; return [img[i], img[i + 1], img[i + 2]]; };
  const is = (px, py, col) => { const a = at(px, py); return a[0] === col[0] && a[1] === col[1] && a[2] === col[2]; };
  const vp = chart.getProfile(), out = { right, plotW, maxW: plotW * dpr * window.ChartEngine.VP_WIDTH };
  if (vp && vp.poc()) {
    const y = Math.round(chart.priceToY(vp.poc().price) * dpr);
    let first = null, last = null, n = 0;
    for (let yy = y - 2; yy <= y + 2; yy++) for (let px = 0; px < right; px++) if (is(px, yy, want.poc)) { n++; first = first === null ? px : Math.min(first, px); last = last === null ? px : Math.max(last, px); }
    let tall = 0;                                                     // the POC bar's height at the right edge
    for (let yy = y - 8; yy <= y + 8; yy++) if (is(right - 3, yy, want.poc)) tall++;
    Object.assign(out, { pocFirst: first, pocLast: last, pocN: n, pocH: tall, dpr });
  }
  // the right-edge column: which profile colors appear, top to bottom, and any profile color in the plot's left half
  const col = { poc: 0, value: 0, row: 0 };
  for (let py = 0; py < c.height - 26 * dpr; py++) for (const k of ['poc', 'value', 'row']) if (is(right - 3, py, want[k])) col[k]++;
  let left = 0;
  for (let py = 0; py < c.height - 26 * dpr; py += 3) for (let px = 0; px < right / 2; px += 3) if (is(px, py, want.poc) || is(px, py, want.value)) left++;
  out.column = col; out.left = left;
  return out;
});
/* A sample-data label on the page for screenshots (the fake bridge's prices are not market data). */
const label = (p, text) => p.evaluate(t => {
  let el = document.getElementById('__sample');
  if (!el) { el = document.createElement('div'); el.id = '__sample'; el.style.cssText = 'position:fixed;left:50%;top:118px;transform:translateX(-50%);z-index:50;font:600 13px system-ui,sans-serif;color:#080B10;background:#E0B45A;padding:4px 12px;border-radius:6px'; document.body.appendChild(el); }
  el.textContent = t;
}, text);

try {
  const off = offsetTo(13, 0);
  const br = await startBridge(off);
  const ctx = await context(off);
  const p = await openPage(ctx, `http://localhost:${br.port}/live/`);
  check(await p.textContent('#lgTf') === 'Range 40t' && await p.textContent('#lgName') !== '', 'NQ Range 40 (sample data): ' + await p.textContent('#lgName') + ' ' + await p.textContent('#lgTf'));

  /* off by default, listed in the Indicators menu */
  const s0 = await state(p), px0 = await pixels(p);
  check(s0.on === false && s0.has === false && s0.legend === null, 'volume profile off by default: no layer, no profile, no legend');
  check(await p.textContent('#indCount') === '5/5', 'Indicators count 5/5 (shown / on this chart; the profile is not on it): ' + await p.textContent('#indCount'));
  check(px0.column.poc === 0 && px0.column.value === 0, 'nothing of the profile at the right edge while off: ' + JSON.stringify(px0.column));

  /* on from the menu: the full session */
  await p.click('#indBtn');
  await p.click('#indBody .ind-cat[data-id="volume"]');
  check(await p.isVisible('#indBody [data-f="add:vp"]') && !(await p.$('#indBody .ind-item[data-id="vp"] .ind-tag')) && !(await p.$('#indBody [data-act="pin"][data-id="vp"]')), 'Indicators menu: Volume profile in the Volume group with a +, no "coming" tag, no pin until added');
  await p.click('#indBody [data-act="gear"][data-id="vp"]');
  check(JSON.stringify((await state(p)).pressed) === '["full"]' && /Hours/.test(await p.textContent('#indBody .ind-set[data-id="vp"]')), 'its gear panel: the Session / RTH switch shows Session');
  await p.screenshot({ path: path.join(SHOTS, 'vp-indicators-menu.png') });
  await p.click('#indBody [data-f="add:vp"]'); await p.keyboard.press('Escape');
  check(await p.evaluate(() => [...document.querySelectorAll('#indChips .ind-chip')].map(c => c.dataset.id).join()) === 'volume,vwap,levels,ib,vp,fills', 'added: its chip on the strip (the sixth: full)');
  await p.mouse.move(10, 400); await p.waitForTimeout(600);
  const s1 = await state(p), px1 = await pixels(p);
  check(s1.on === true && s1.has === true && s1.rth === false, 'on: the chart has a session profile');
  check(s1.total === s1.expect.session && s1.total > 0, 'session profile holds every trade from 18:00 ET the page got: ' + s1.total + ' = ' + s1.expect.session);
  check(await p.textContent('#indCount') === '6/6', 'Indicators count 6/6');
  const fmt = v => U.fmtPrice(v, 2);
  const today = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(U.zoneSeconds(Date.now() / 1000 + off) * 1000).getUTCDay()];
  check(s1.legend === 'POC ' + fmt(s1.poc) + ' · VA ' + fmt(s1.va[0]) + ' to ' + fmt(s1.va[1]) + ' (' + today + ')' && s1.day === today, 'legend, with the session\'s day (1.6.1): ' + s1.legend);
  check(s1.va[0] <= s1.poc && s1.poc <= s1.va[1], 'VAL <= POC <= VAH');
  check(px1.pocN > 20 && px1.pocLast >= px1.right - 2 && px1.pocFirst >= px1.right - px1.maxW - 3 && px1.pocFirst <= px1.right - px1.maxW * 0.5,
    'POC row drawn from the right edge, about ' + CE.VP_WIDTH * 100 + '% of the plot wide: device x ' + px1.pocFirst + ' to ' + px1.pocLast + ' (edge ' + px1.right + ', full width ' + Math.round(px1.maxW) + ')');
  check(px1.column.value > 10 && px1.column.row > 10 && px1.column.poc > 0, 'right edge column: value-area rows, other rows and the POC: ' + JSON.stringify(px1.column));
  check(px1.pocH >= Math.round(CE.VP_POC_MIN * px1.dpr), 'the POC bar is at least ' + CE.VP_POC_MIN + ' CSS px tall: ' + px1.pocH + ' device px at dpr ' + px1.dpr);
  check(px1.left === 0, 'nothing of the profile in the left half of the plot');
  check(s1.note === '', 'no note: the Range tick history reaches back to 18:00');
  await label(p, 'SAMPLE DATA (fake bridge), not market data. Volume profile: Session');
  await p.screenshot({ path: path.join(SHOTS, 'vp-session-nq-range40-sample.png') });

  /* RTH */
  await p.click('#indBtn'); await p.click('#indBody [data-act="gear"][data-id="vp"]'); await p.click('#indBody [data-act="opt"][data-id="vp"][data-v="rth"]');
  check(JSON.stringify((await state(p)).pressed) === '["rth"]' && /9:30 to 16:00 ET/.test(await p.textContent('#indBody .ind-set[data-id="vp"]')), 'the switch shows RTH and says what it counts');
  await label(p, 'SAMPLE DATA (fake bridge), not market data. Volume profile: RTH');
  await p.screenshot({ path: path.join(SHOTS, 'vp-menu-settings-rth.png') });
  await p.keyboard.press('Escape'); await p.mouse.move(10, 400); await p.waitForTimeout(600);
  const s2 = await state(p), px2 = await pixels(p);
  check(s2.rth === true && s2.total === s2.expect.rth && s2.total > 0 && s2.total < s1.total, 'RTH profile holds exactly the trades from 9:30 ET: ' + s2.total + ' = ' + s2.expect.rth + ' (session ' + s1.total + ')');
  check(s2.low === s2.expect.rthLow && s2.high === s2.expect.rthHigh, 'RTH low and high are those of the trades from 9:30: ' + s2.low + ' to ' + s2.high);
  check(s2.legend === 'POC ' + fmt(s2.poc) + ' · VA ' + fmt(s2.va[0]) + ' to ' + fmt(s2.va[1]) + ' (' + today + ')' && s2.legend !== s1.legend, 'legend follows: ' + s2.legend);
  check(JSON.stringify(px2.column) !== JSON.stringify(px1.column), 'RTH draws differently at the right edge: ' + JSON.stringify(px2.column));
  check(await p.evaluate(() => JSON.parse(localStorage.getItem('live-indicator-options-v1')).main.vp.session) === 'rth' && await p.evaluate(() => { const x = JSON.parse(localStorage.getItem('live-indicators-v2')).main.ind.vp; return x.on && x.shown; }),
    'both saved for the main pane');
  await label(p, 'SAMPLE DATA (fake bridge), not market data. Volume profile: RTH');
  await p.screenshot({ path: path.join(SHOTS, 'vp-rth-nq-range40-sample.png') });

  /* live trades keep coming: the profile keeps up with the store */
  await p.waitForTimeout(2500);
  const s3 = await state(p);
  check(s3.total === s3.expect.rth && s3.total >= s2.total, 'after 2.5 s of live trades the RTH profile still matches: ' + s3.total);

  /* persistence across a reload */
  await p.reload(); await live(p);
  const s4 = await state(p);
  await p.click('#indBtn'); await p.click('#indBody [data-act="gear"][data-id="vp"]');
  check(s4.on === true && s4.rth === true && s4.total === s4.expect.rth && JSON.stringify((await state(p)).pressed) === '["rth"]' && s4.legend !== null, 'after a reload: on, RTH, rebuilt from the backfill: ' + s4.total);
  await p.click('#indBody [data-act="opt"][data-id="vp"][data-v="full"]'); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  const s5 = await state(p);
  check(s5.rth === false && s5.total === s5.expect.session, 'back to Session: ' + s5.total);
  await p.reload(); await live(p);
  check((await state(p)).rth === false, 'Session kept after a reload');

  /* other views keep the profile (it does not depend on the bars); 1m after a fresh load has no tick history */
  await p.click('#tfSeg >> text="5m"'); await live(p);
  const s6 = await state(p);
  check(s6.total === s6.expect.session, '5m keeps the same profile: ' + s6.total);

  /* a mounted chart: the documented API, per pane, prefix desk: */
  const host = await ctx.newPage();
  host.on('pageerror', e => fail('embed pageerror: ' + e.message));
  await host.goto(`http://localhost:${br.port}/test/embed-host.html`);
  await host.evaluate(pt => {
    window.__a = ChartLive.mount(document.getElementById('paneA'), { wsUrl: 'ws://localhost:' + pt + '/ws', paneId: 'main', storagePrefix: 'desk:' });
    window.__b = ChartLive.mount(document.getElementById('paneB'), { wsUrl: 'ws://localhost:' + pt + '/ws', paneId: 'pane-2', storagePrefix: 'desk:' });
  }, br.port);
  await host.waitForFunction(() => [...document.querySelectorAll('[id$="-connPill"]')].every(x => x.textContent === 'LIVE'), null, { timeout: 30000 });
  await host.waitForTimeout(600);
  check(await host.evaluate(() => !window.__a.chart.getLayers().vp && !window.__b.chart.getLayers().vp && window.__a.indicatorOptions('vp').session === 'full'), 'mounted panes: profile off, Session');
  // review S5: inherited names are not options; the call returns false and throws nothing
  const inherited = await host.evaluate(() => {
    const out = [];
    for (const args of [['vp', 'toString', 'x'], ['vp', 'constructor', 'keys'], ['vp', '__proto__', 'rth'], ['toString', 'session', 'rth'], ['__proto__', 'session', 'rth'], ['vp', 'session', 'toString']]) {
      try { out.push(window.__a.setIndicatorOption(...args)); } catch (e) { out.push('threw ' + e.message); }
    }
    return { out, proto: Object.prototype.vp === undefined && Object.prototype.session === undefined, opts: window.__a.indicatorOptions('toString') };
  });
  check(inherited.out.every(x => x === false) && inherited.proto && JSON.stringify(inherited.opts) === '{}', 'setIndicatorOption with inherited names returns false, pollutes nothing: ' + JSON.stringify(inherited));
  const api = await host.evaluate(() => ({ bad: window.__a.setIndicatorOption('vp', 'session', 'eth'), good: window.__a.setIndicatorOption('vp', 'session', 'rth'), now: window.__a.indicatorOptions('vp'),
    saved: JSON.parse(localStorage.getItem('desk:live-indicator-options-v1')), page: JSON.parse(localStorage.getItem('live-indicator-options-v1')) }));
  check(api.bad === false && api.good === true && api.now.session === 'rth' && api.saved.main.vp.session === 'rth' && api.page.main.vp.session === 'full',
    'setIndicatorOption: refuses an unknown value, saves RTH under desk: only: ' + JSON.stringify(api));
  await host.click('#paneA .ind-btn'); await host.click('#paneA .ind-cat[data-id="volume"]'); await host.click('#paneA [data-f="add:vp"]'); await host.keyboard.press('Escape'); await host.waitForTimeout(400);
  check(await host.evaluate(() => { const vp = window.__a.chart.getProfile(); return !!vp && vp.rth === true && vp.total > 0; }) && await host.evaluate(() => !window.__b.chart.getProfile()),
    'mounted main pane: RTH profile on; pane-2 unaffected');
  await host.close();

  /* two tabs (review S2): a pick is saved as what the tab shows, also when the tab already shows it */
  const pick = async (pg, v) => { await pg.click('#indBtn'); await pg.click('#indBody [data-act="gear"][data-id="vp"]'); await pg.click('#indBody [data-act="opt"][data-id="vp"][data-v="' + v + '"]'); await pg.keyboard.press('Escape'); await pg.waitForTimeout(300); };
  const saved = pg => pg.evaluate(() => ({ opt: JSON.parse(localStorage.getItem('live-indicator-options-v1')), ind: localStorage.getItem('live-indicators-v2'), settings: localStorage.getItem('live-settings-v2') }));
  await pick(p, 'rth');
  const tabB = await openPage(ctx, `http://localhost:${br.port}/live/`);      // opened while RTH is saved
  await pick(p, 'full');                                                        // tab A saves Session
  await p.evaluate(() => { const o = JSON.parse(localStorage.getItem('live-indicator-options-v1')); o['pane-2'] = { vp: { session: 'rth' } }; localStorage.setItem('live-indicator-options-v1', JSON.stringify(o)); });
  const before = await saved(p);
  await tabB.click('#indBtn'); await tabB.click('#indBody [data-act="gear"][data-id="vp"]');
  const b0 = await state(tabB);
  check(before.opt.main.vp.session === 'full' && b0.rth === true && JSON.stringify(b0.pressed) === '["rth"]', 'two tabs: A saved Session; stale tab B still draws RTH, RTH pressed in its gear panel');
  await tabB.click('#indBody [data-act="opt"][data-id="vp"][data-v="rth"]'); await tabB.keyboard.press('Escape'); await tabB.waitForTimeout(300);
  const after = await saved(tabB), b1 = await state(tabB);
  check(after.opt.main.vp.session === 'rth' && b1.rth === true && b1.total === b1.expect.rth, 'tab B clicks RTH, the one it shows: RTH saved and still drawn: ' + JSON.stringify(after.opt));
  check(after.opt['pane-2'].vp.session === 'rth' && Object.keys(after.opt).sort().join() === 'main,pane-2' && after.ind === before.ind && after.settings === before.settings,
    'read, merged, written: another pane\'s option and the other keys kept');
  const tabC = await openPage(ctx, `http://localhost:${br.port}/live/`), c = await state(tabC);
  check(c.on === true && c.rth === true && c.total === c.expect.rth, 'a new load draws what tab B showed: RTH, ' + c.total);
  await tabB.close(); await tabC.close();
  await ctx.close(); br.kill();

  /* a first load on 1m: no tick history, so the profile counts live trades only, and says so */
  {
    const off2 = offsetTo(13, 0);
    const br2 = await startBridge(off2);
    const ctx2 = await context(off2);
    await ctx2.addInitScript(() => {
      try {
        localStorage.setItem('live-settings-v2', JSON.stringify({ root: 'NQ', tf: 'm1', glide: 'smooth', rangeMode: 'nt' }));
        localStorage.setItem('live-indicators-v1', JSON.stringify({ main: { vp: true } }));
      } catch (e) {}
    });
    const q = await openPage(ctx2, `http://localhost:${br2.port}/live/`);
    await q.waitForTimeout(1500);
    const m = await state(q);
    check(m.on && m.has && /loads no tick history/.test(m.note) && await q.isVisible('#vpNote'), '1m first load: a quiet note: ' + m.note);
    check(m.total === m.expect.session, '1m: the profile holds just the live trades since the page went live: ' + m.total);
    await label(q, 'SAMPLE DATA (fake bridge), not market data. 1m: profile from the first live trade');
    await q.screenshot({ path: path.join(SHOTS, 'vp-m1-live-only-sample.png') });
    await ctx2.close(); br2.kill();
  }

  /* ---------------- 1.6.1 (Anthony's ruling 2026-09-30; review B1 and S4): over weekends and NYSE holidays the profile
     keeps the last session until the next session's first trade, and every load, reload and reconnect while the
     market is closed asks for that session's ticks, whatever the view. The fake bridge runs with --market-hours: the
     sample on the real calendar, no trades while CME is closed, tick history counted back from the clock; as
     ChartBridge 0.3.5 (--version=0.3.5 --tick-hours-max=120: the page asks past 48 hours only from 0.3.5 on, by the
     version in hello) or 0.3.4 and older (48). The page's own subscribe, no hook. */
  const NEW_BRIDGE = ['--market-hours', '--version=0.3.5', '--tick-hours-max=120'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], label_ = label;
  const dowOf = bt => new Date(bt * 1000).getUTCDay();
  const trades = pg => pg.evaluate(() => window.__kept.slice());   // what the page received, after the live gate below
  const etNowOf = pg => pg.evaluate(() => window.ChartEngine.util.zoneSeconds(Date.now() / 1000));
  const asked = pg => pg.evaluate(() => window.__asked.slice());
  /* The last session with trades before `cut`, counted by hand from the trades the page received: the full session
     (18:00 to 17:00, the engine's trading day) or RTH (9:30 to 16:00 on a stock market day). */
  function lastSession(list, cut, rth) {
    const inRth = t => U.rthDay(t) && U.tod(t) >= 34200 && U.tod(t) < 57600;
    const day = t => rth ? Math.floor(t / 86400) : U.tradeDay(t, 64800);
    let d = null;
    for (const [t, , v] of list) if (t < cut && v > 0 && (!rth || inRth(t))) d = day(t);
    if (d === null) return { day: null, total: 0 };
    return { day: DOW[dowOf(d * 86400)], dayNo: d, total: list.reduce((a, [t, , v]) => a + (t < cut && v > 0 && (!rth || inRth(t)) && day(t) === d ? v : 0), 0) };
  }
  /* Seconds to add to the real clock to stand at hh:mm:ss New York time on the most recent past day `want` accepts. */
  function offsetAt(hh, mm, ss, want, days) {
    const now = Date.now() / 1000, today = Math.floor(U.zoneSeconds(now) / 86400);
    for (let back = 0; back < (days || 40); back++) {
      const bt = (today - back) * 86400 + hh * 3600 + mm * 60 + ss;
      if (!want(bt)) continue;
      let unix = bt - (U.zoneSeconds(now) - now);
      unix = bt - (U.zoneSeconds(unix) - unix);
      if (unix > now) continue;
      return Math.round(unix - now);
    }
    return null;
  }
  /* A context on that clock that records what the page asks for; `gate` holds live trades until window.__open. */
  async function closedContext(offset, gate) {
    const ctx = await context(offset);
    await ctx.addInitScript(`(() => {
      window.__asked = []; window.__open = ${gate ? 'false' : 'true'}; window.__kept = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (d) { if (typeof d === 'string' && d.startsWith('{"type":"subscribe"')) window.__asked.push(JSON.parse(d).tickHours); return send.call(this, d); };
      const desc = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
      Object.defineProperty(WebSocket.prototype, 'onmessage', { configurable: true, get() { return desc.get.call(this); }, set(fn) {
        desc.set.call(this, ev => {
          if (typeof ev.data === 'string') {
            if (ev.data.startsWith('{"type":"hello"')) window.__kept = [];
            else if (ev.data.startsWith('{"type":"ticks"')) { const m = JSON.parse(ev.data); if (m.root === 'NQ') for (const x of m.ticks) window.__kept.push(x); }
            else if (ev.data.startsWith('{"type":"tick"')) { if (!window.__open) return; const m = JSON.parse(ev.data); if (m.root === 'NQ') window.__kept.push([m.t, m.p, m.v || 0]); }
          }
          return fn(ev);
        });
      } });
    })();`);
    return ctx;
  }
  const TFS = { range: 'Range', s15: '15s', m1: '1m', m15: '15m' };
  /* Load the page on view `tf` with the profile on, Session or RTH (saved choices, then a load). */
  async function loadOn(pg, tf, session) {
    await pg.evaluate(([tf, session]) => {
      localStorage.setItem('live-settings-v2', JSON.stringify({ root: 'NQ', tf, glide: 'smooth', rangeMode: 'nt' }));
      localStorage.setItem('live-indicator-options-v1', JSON.stringify({ main: { vp: { session } } }));
    }, [tf, session]);
    await pg.reload(); await live(pg);
  }
  const vpOn = async ctx => { await ctx.addInitScript(() => { try { if (!localStorage.getItem('live-indicators-v2')) localStorage.setItem('live-indicators-v1', JSON.stringify({ main: { vp: true } })); } catch (e) {} }); };

  /* Saturday 12:00 and Sunday 12:00 ET: Friday's session and Friday's RTH on every view, after a load and a reconnect */
  for (const [label, dow] of [['Saturday', 6], ['Sunday', 0]]) {
    const off = offsetAt(12, 0, 0, bt => dowOf(bt) === dow);
    const br = await startBridge(off, NEW_BRIDGE);
    const ctx = await closedContext(off, false);
    await vpOn(ctx);
    const q = await openPage(ctx, `http://localhost:${br.port}/live/`);
    const now0 = await etNowOf(q);
    check(dowOf(now0) === dow && U.tod(now0) >= 12 * 3600 && U.tod(now0) < 12 * 3600 + 120, label + ' clock: ' + U.fmtFull(now0));
    for (const tf of Object.keys(TFS)) for (const session of ['full', 'rth']) {
      await loadOn(q, tf, session);
      const w = await state(q), got = await trades(q), exp = lastSession(got, Infinity, session === 'rth'), ask = (await asked(q)).pop();
      check(exp.day === 'Fri' && w.on && w.rth === (session === 'rth') && w.day === 'Fri' && w.total === exp.total && w.total > 0 && / \(Fri\)$/.test(w.legend || '') && w.note === '',
        label + ' 12:00, ' + TFS[tf] + ', ' + (session === 'rth' ? 'RTH' : 'Session') + ': Friday\'s profile from the page\'s own load (tickHours ' + ask + '): ' + w.total + ' = ' + exp.total + ', ' + w.legend + (w.note ? ' | ' + w.note : ''));
      if (tf === 'range' && session === 'full') {
        await label_(q, 'SAMPLE DATA (fake bridge, sample calendar), not market data. ' + label + ': Friday\'s profile, loaded on ' + label);
        await q.screenshot({ path: path.join(SHOTS, 'vp-' + label.toLowerCase() + '-friday-sample.png') });
      }
    }
    // a dropped connection, the page kept: the reconnect loads Friday again (1m, Session)
    await loadOn(q, 'm1', 'full');
    const n0 = (await asked(q)).length;
    await fetch(`http://localhost:${br.port}/test/drop`, { method: 'POST' });
    await until(async () => (await asked(q)).length > n0, label + ': the reconnect subscribed again', 15000);
    await live(q);
    const w = await state(q), exp = lastSession(await trades(q), Infinity, false);
    check(w.day === 'Fri' && w.total === exp.total && w.total > 0, label + ', after a reconnect: Friday\'s session again: ' + w.total + ' = ' + exp.total);
    await ctx.close(); br.kill();
  }

  /* ChartBridge 0.3.4 or older (48 hours), Sunday 12:00: the page asks for 48, and the profile says where its ticks
     start and why, with no install advice (review 2 S3, S4) */
  {
    const off = offsetAt(12, 0, 0, bt => dowOf(bt) === 0);
    const br = await startBridge(off, ['--market-hours', '--version=0.3.4', '--tick-hours-max=48']);
    const ctx = await closedContext(off, false);
    await vpOn(ctx);
    const q = await openPage(ctx, `http://localhost:${br.port}/live/`);
    await loadOn(q, 'range', 'full');
    const w = await state(q), ask = (await asked(q)).pop();
    check(ask === 48 && w.day === 'Fri' && / \(Fri from 12:0\d\)$/.test(w.legend || '') && /^Volume profile from 12:0\d ET: the tick history does not reach back to 18:00 ET\. This ChartBridge \(0\.3\.4\) serves 48 hours of ticks\.$/.test(w.note),
      'ChartBridge 0.3.4 on Sunday: asked 48 (' + ask + '), Friday from 12:00 only, and the legend and the note say so, no install advice: ' + w.legend + ' | ' + w.note);
    const n0 = (await asked(q)).length;
    await q.click('#tfSeg button[data-v="m5"]'); await q.waitForTimeout(600);
    check((await asked(q)).length === n0, 'a view switch does not load the same 48 hours again');
    await loadOn(q, 'range', 'rth');
    const r = await state(q);
    check(/ \(Fri from 12:0\d\)$/.test(r.legend || ''), 'and RTH from 12:00 too: ' + r.legend);
    await ctx.close(); br.kill();
  }

  /* Sunday 17:59:45 ET: Friday stays over 18:00 on the clock; the first trade after 18:00 switches to Monday's session */
  {
    const off = offsetAt(17, 59, 45, bt => dowOf(bt) === 0);
    const br = await startBridge(off, NEW_BRIDGE);
    const ctx = await closedContext(off, true);
    await vpOn(ctx);
    const q = await openPage(ctx, `http://localhost:${br.port}/live/`);
    await loadOn(q, 'range', 'full');
    const sunDay = Math.floor((await etNowOf(q)) / 86400) * 86400, open = sunDay + 18 * 3600;
    let w = await state(q);
    const prev = lastSession(await trades(q), open, false);
    check(prev.day === 'Fri' && w.day === 'Fri' && w.total === prev.total && w.total > 0, 'Sunday 17:59: Friday\'s session: ' + w.total + ' = ' + prev.total);
    await until(async () => (await etNowOf(q)) >= open + 2, 'the page clock past Sunday 18:00', 30000);
    w = await state(q);
    check(w.day === 'Fri' && w.total === prev.total && / \(Fri\)$/.test(w.legend || ''), 'Sunday 18:00:02 on the clock, no trade yet: still Friday (1.6.0 emptied it here): ' + w.legend);
    const before = (await trades(q)).length;
    await q.evaluate(() => { window.__open = true; });                                             // the first trades of Monday's session
    await until(async () => (await trades(q)).length > before, 'a live trade after 18:00', 5000);
    await q.waitForTimeout(700);
    await q.evaluate(() => { window.__open = false; }); await q.waitForTimeout(300);                // hold the trades while counting
    w = await state(q);
    const mon = lastSession(await trades(q), Infinity, false);
    check(mon.day === 'Mon' && w.day === 'Mon' && w.total === mon.total && w.total > 0 && / \(Mon\)$/.test(w.legend || ''), 'the first trade after Sunday 18:00 switches to Monday\'s session: ' + w.total + ' = ' + mon.total + ', ' + w.legend);
    await label_(q, 'SAMPLE DATA (fake bridge), not market data. Sunday 18:00: Monday\'s session from its first trade');
    await q.screenshot({ path: path.join(SHOTS, 'vp-sunday-switch-sample.png') });
    await ctx.close(); br.kill();
  }

  /* Weekday overnight (review S4): Monday and Tuesday 08:00, RTH is empty until 9:30 as in 1.6.0, on Range and 15s */
  for (const dow of [1, 2]) {
    const off = offsetAt(8, 0, 0, bt => dowOf(bt) === dow && U.rthDay(bt) && U.rthDay(bt - 86400 * (dow === 1 ? 3 : 1)));
    if (off === null) { console.log('  (no plain ' + DOW[dow] + ' in the last 40 days: skipped)'); continue; }
    const br = await startBridge(off, NEW_BRIDGE);
    const ctx = await closedContext(off, true);   // live trades held: the counts are compared with the page's
    await vpOn(ctx);
    const q = await openPage(ctx, `http://localhost:${br.port}/live/`);
    for (const tf of ['range', 's15']) {
      await loadOn(q, tf, 'rth');
      const w = await state(q), ask = (await asked(q)).pop();
      check(w.has && w.total === 0 && !w.legend && w.note === 'Volume profile (RTH) starts at 9:30 ET.' && ask === (tf === 'range' ? ask : 8),
        DOW[dow] + ' 08:00, ' + TFS[tf] + ', RTH: empty until 9:30, as in 1.6.0 (tickHours ' + ask + '): ' + (w.note || w.legend || JSON.stringify(w)));
    }
    await loadOn(q, 'range', 'full');
    const w = await state(q), exp = lastSession(await trades(q), Infinity, false);
    check(w.day === DOW[dow] && w.total === exp.total, DOW[dow] + ' 08:00, Session: the day\'s own session: ' + w.legend);
    await ctx.close(); br.kill();
  }

  /* An NYSE holiday with Globex trading (the most recent weekday with no stock market session and a Globex session, such
     as Labor Day). At 12:00 ET Globex trades: every view asks for its own ticks only, as 1.6.0 (review 2 S5); RTH says
     it loads after the halt. At 14:00 ET, after the 13:00 halt: RTH keeps the last RTH day, Session shows the
     holiday's own Globex session, on Range and 1m. */
  {
    const hol = bt => dowOf(bt) > 0 && dowOf(bt) < 6 && !U.rthDay(bt) && U.cmeSessionDay(Math.floor(bt / 86400));
    const offOpen = offsetAt(12, 0, 0, hol, 120), offHalt = offsetAt(14, 0, 0, hol, 120);
    if (offOpen === null || offHalt === null) console.log('  (no NYSE holiday with Globex trading in the last 120 days: skipped)');
    else {
      let br = await startBridge(offOpen, NEW_BRIDGE);
      let ctx = await closedContext(offOpen, true);   // live trades held: the counts are compared with the page's
      await vpOn(ctx);
      let q = await openPage(ctx, `http://localhost:${br.port}/live/`);
      const hDay = Math.floor((await etNowOf(q)) / 86400) * 86400;
      for (const tf of ['range', 'm1']) for (const session of ['full', 'rth']) {
        await loadOn(q, tf, session);
        const w = await state(q), ask = (await asked(q)).pop(), now = await etNowOf(q);
        const normal = tf === 'range' ? BB.rangeTickHours(now, 64800) : 0;
        check(ask === normal && (session === 'full' || (w.total === 0 && /^Volume profile \(RTH\): no stock market session today\. The last one loads only while Globex is halted/.test(w.note))),
          'NYSE holiday ' + U.fmtDate(hDay) + ' 12:00, Globex trading, ' + TFS[tf] + ', ' + (session === 'rth' ? 'RTH' : 'Session') + ': asks the view\'s own ' + normal + ' hours (' + ask + ')' + (session === 'rth' ? ', ' + w.note : ''));
      }
      await ctx.close(); br.kill();
      br = await startBridge(offHalt, NEW_BRIDGE);
      ctx = await closedContext(offHalt, true);
      await vpOn(ctx);
      q = await openPage(ctx, `http://localhost:${br.port}/live/`);
      for (const tf of ['range', 'm1']) {
        await loadOn(q, tf, 'rth');
        let w = await state(q);
        const lastRth = lastSession(await trades(q), Infinity, true);
        check(lastRth.day !== null && lastRth.dayNo < hDay / 86400 && w.rth && w.day === lastRth.day && w.total === lastRth.total && w.total > 0 && new RegExp(' \\(' + lastRth.day + '\\)$').test(w.legend || ''),
          'NYSE holiday 14:00 (halted), ' + TFS[tf] + ', RTH: ' + lastRth.day + '\'s RTH kept over the holiday, ' + w.total + ' = ' + lastRth.total + ', ' + w.legend);
        await loadOn(q, tf, 'full');
        w = await state(q);
        const h = lastSession(await trades(q), Infinity, false);
        check(h.day === DOW[dowOf(hDay)] && w.day === h.day && w.total === h.total && w.note === '', 'NYSE holiday 14:00, ' + TFS[tf] + ', Session: the holiday\'s own Globex session (' + w.day + '), ' + w.total + ' = ' + h.total + ', ' + w.legend);
      }
      await loadOn(q, 'range', 'rth');
      await label_(q, 'SAMPLE DATA (fake bridge, sample calendar), not market data. NYSE holiday after the halt: the last RTH kept');
      await q.screenshot({ path: path.join(SHOTS, 'vp-holiday-rth-kept-sample.png') });
      await ctx.close(); br.kill();
    }
  }

  /* A session's first trade stamped a few ms after 18:00:00.000 (--tick-shift-ms=137, as real trades are), where nothing
     traded before it (a holiday halt, the break): the profile is whole, not "from 18:00" (review 2 S4). The Saturday
     after a Thursday NYSE holiday, and a Tuesday 17:30 (the break) after a Monday holiday. */
  for (const [what, hh, mm, want] of [
    ['Saturday after a Thursday holiday', 12, 0, bt => dowOf(bt) === 6 && !U.rthDay(bt - 2 * 86400) && dowOf(bt - 2 * 86400) === 4],
    ['Tuesday 17:30 after a Monday holiday', 17, 30, bt => dowOf(bt) === 2 && !U.rthDay(bt - 86400)],
  ]) {
    const off = offsetAt(hh, mm, 0, want, 400);
    if (off === null) { console.log('  (' + what + ': none in the last 400 days, skipped)'); continue; }
    const br = await startBridge(off, NEW_BRIDGE.concat('--tick-shift-ms=137'));
    const ctx = await closedContext(off, true);
    await vpOn(ctx);
    const q = await openPage(ctx, `http://localhost:${br.port}/live/`);
    await loadOn(q, 'm1', 'full');
    const w = await state(q), got = await trades(q), exp = lastSession(got, Infinity, false), first = got.length ? got[0][0] : null;
    check(first !== null && Math.abs(U.tod(first) - 64800.137) < 0.0005 && w.total === exp.total && w.total > 0 && new RegExp(' \\(' + exp.day + '\\)$').test(w.legend || '') && w.note === '',
      what + ' (' + U.fmtDate(Math.floor((await etNowOf(q)) / 86400) * 86400) + '), first trade ' + (first === null ? 'none' : U.fmtFull(first) + ' +' + Math.round((first % 1) * 1000) + ' ms') + ': the whole session, ' + w.legend + (w.note ? ' | ' + w.note : ''));
    await ctx.close(); br.kill();
  }

  /* The Desk (an embed through a relay that serves 8 hours), Sunday 12:00 with ChartBridge 0.3.4: a neutral note, never
     install advice or a claim about ChartBridge (review 2 S4) */
  {
    const off = offsetAt(12, 0, 0, bt => dowOf(bt) === 0);
    const br = await startBridge(off, ['--market-hours', '--version=0.3.4', '--tick-hours-max=8']);
    const ctx = await context(off);
    await ctx.addInitScript(() => { try { localStorage.setItem('desk:live-indicators-v1', JSON.stringify({ main: { vp: true } })); localStorage.setItem('desk:live-settings-v2', JSON.stringify({ root: 'NQ', tf: 'm1', glide: 'smooth', rangeMode: 'nt' })); } catch (e) {} });
    const q = await ctx.newPage();
    q.on('pageerror', e => fail('pageerror: ' + e.message));
    await q.goto(`http://localhost:${br.port}/test/embed-host.html`);
    await q.evaluate(port => { window.__a = ChartLive.mount(document.getElementById('paneA'), { wsUrl: 'ws://localhost:' + port + '/ws', paneId: 'main', storagePrefix: 'desk:' }); }, br.port);
    await q.waitForFunction(() => { const p = window.__a.element.querySelector('[id$="connPill"]'); return p && p.textContent === 'LIVE'; }, null, { timeout: 30000 });
    await q.waitForTimeout(1200);
    const note = await q.evaluate(() => { const n = window.__a.element.querySelector('[id$="vpNote"]'); return n && !n.hidden ? n.textContent : ''; });
    check(/^Volume profile/.test(note) && !/install|ChartBridge/.test(note), 'The Desk\'s embed on Sunday with a relay serving 8 hours: a neutral note, no install advice: "' + note + '"');
    await ctx.close(); br.kill();
  }
  /* The page itself with ChartBridge 0.3.4 that holds only 8 hours of ticks (a PC with little tick history): neutral too */
  {
    const off = offsetAt(12, 0, 0, bt => dowOf(bt) === 0);
    const br = await startBridge(off, ['--market-hours', '--version=0.3.4', '--tick-hours-max=8']);
    const ctx = await closedContext(off, false);
    await vpOn(ctx);
    const q = await openPage(ctx, `http://localhost:${br.port}/live/`);
    await loadOn(q, 'm1', 'full');
    const w = await state(q);
    check(w.note === 'Volume profile: no trades of the last session in the tick history this view loaded.', 'the page, ChartBridge 0.3.4 serving 8 hours: a neutral note, no claim about why: "' + w.note + '"');
    await ctx.close(); br.kill();
  }
} finally {
  await browser.close();
}

if (errors.length) { console.error('FAIL\n' + errors.join('\n')); process.exit(1); }
console.log('volume profile smoke: ok (screenshots in ' + SHOTS + ')');
