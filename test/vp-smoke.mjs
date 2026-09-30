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
const SHOTS = path.resolve(process.env.SHOTS || path.join(root, 'test', 'out'));
fs.mkdirSync(SHOTS, { recursive: true });
const BASE_PORT = +(process.env.VP_SMOKE_PORT || 8851);
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

let port = BASE_PORT;
async function startBridge(offset) {
  for (let tries = 0; tries < 8; tries++, port++) {
    const p = port;
    const b = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(p), '--pin-off', '--test-controls', '--clock-offset=' + offset], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  check(s1.legend === 'POC ' + fmt(s1.poc) + ' · VA ' + fmt(s1.va[0]) + ' to ' + fmt(s1.va[1]), 'legend: ' + s1.legend);
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
  check(s2.legend === 'POC ' + fmt(s2.poc) + ' · VA ' + fmt(s2.va[0]) + ' to ' + fmt(s2.va[1]) && s2.legend !== s1.legend, 'legend follows: ' + s2.legend);
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
} finally {
  await browser.close();
}

if (errors.length) { console.error('FAIL\n' + errors.join('\n')); process.exit(1); }
console.log('volume profile smoke: ok (screenshots in ' + SHOTS + ')');
