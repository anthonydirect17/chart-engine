// Cumulative delta pane smoke (1.7.0): the live page and mounted panes against the fake bridge (SAMPLE data only, never
// market data), which sends trade sides like ChartBridge 0.3.4, or none like 0.3.3 (--no-sides).
//   npm run smoke:delta        (CHROMIUM_PATH=/path/to/chrome for a preinstalled browser; SHOTS=dir for the screenshots)
// Checks: the pane is on by default under the main chart, sharing its bars, and draws candles; its totals equal every
// trade the page received (counted independently here), also after live trades; a new core only on a reload or a bar
// type change, never per trade; the Show option (Cumulative or Bar delta) from the gear and back, both after a reload;
// the divider dragged and keyed, the height saved per pane; the chip and Hide all / Restore; ChartBridge 0.3.3 (no
// sides): nothing drawn and the note; a history that starts after 18:00 labelled; a second pane off by default and
// added from the menu, with setIndicatorOption under its prefix; the 18:00 ET rollover on a clock set to 17:59:35.
// Review round 1: a backfill cut short after 18:00 (The Desk's relay capping tickHours at 8, and NinjaTrader sending
// less) is labelled with its exact start, never taken as the whole session (B1); a minute view opened before 18:00
// counts the session whole from 18:00 (S1); showing the hidden pane reuses the delta kept meanwhile (S5).
// Screenshots on the dark and black grounds, cumulative and bar, and the old-bridge note, labelled as sample data.
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
const BASE_PORT = +(process.env.DELTA_SMOKE_PORT || 8871);
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const S18 = 18 * 3600;

/* Seconds to add to the real clock to stand at hh:mm:ss New York time on the most recent day `want` accepts. */
function offsetTo(hh, mm, ss, want) {
  const now = Date.now() / 1000, today = Math.floor(U.zoneSeconds(now) / 86400);
  for (let back = 0; back < 30; back++) {
    const bt = (today - back) * 86400 + hh * 3600 + mm * 60 + ss;
    if (!want(bt)) continue;
    let unix = bt - (U.zoneSeconds(now) - now);
    unix = bt - (U.zoneSeconds(unix) - unix);
    if (unix > now) continue;
    return Math.round(unix - now);
  }
  throw new Error('no day found');
}
const weekday = bt => U.rthDay(bt);
const monToThu = bt => { const d = new Date(bt * 1000).getUTCDay(); return d >= 1 && d <= 4; };

let port = BASE_PORT;
const bridges = [];
async function startBridge(offset, extra) {
  for (let tries = 0; tries < 8; tries++, port++) {
    const p = port;
    const b = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(p), '--pin-off', '--test-controls', '--clock-offset=' + offset].concat(extra || []), { stdio: ['ignore', 'pipe', 'pipe'] });
    let errText = '';
    b.stderr.on('data', d => { errText += d; });
    const ok = await new Promise(res => { b.stdout.once('data', () => res(true)); b.once('exit', () => res(false)); });
    if (ok) { port++; bridges.push(b); return { port: p, kill: () => b.kill() }; }
    if (!/EADDRINUSE/.test(errText)) throw new Error('bridge failed: ' + errText);
  }
  throw new Error('no free port from ' + BASE_PORT);
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
/* The page's clock `offset` seconds off; NQ on `tf` on a first visit; every NQ trade the page receives recorded with its
   side (the backfill again after each new subscribe); every CumulativeDelta the page makes counted. `opts.relayHours`
   caps the subscribe's tickHours on its way out, as The Desk's relay does (THEDESK_LIVE_RELAY_TICK_HOURS, default 8);
   `opts.cmeBreak` drops the tick backfill and every trade stamped 17:00 to 18:00 ET, as a minute view on CME gets it. */
async function context(offset, tf, extra, opts) {
  const o = opts || {};
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(`(() => {
    const realNow = Date.now; Date.now = () => realNow() + ${offset * 1000};
    try {
      if (!localStorage.getItem('live-settings-v2')) localStorage.setItem('live-settings-v2', JSON.stringify({ root: 'NQ', tf: '${tf}', glide: 'smooth', rangeMode: 'nt' }));
      if (!localStorage.getItem('live-range-v2')) localStorage.setItem('live-range-v2', JSON.stringify({ NQ: 40 }));
      ${extra || ''}
    } catch (e) {}
    const relayHours = ${o.relayHours || 0}, cmeBreak = ${!!o.cmeBreak};
    window.__asked = [];
    if (relayHours) {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (x) {
        try { const m = JSON.parse(x); if (m.type === 'subscribe') { window.__asked.push(m.tickHours); if (m.tickHours > relayHours) { m.tickHours = relayHours; x = JSON.stringify(m); } } } catch (e) {}
        return send.call(this, x);
      };
    }
    const inBreak = t => { const s = ((t % 86400) + 86400) % 86400; return s >= 61200 && s < 64800; };
    const rec = window.__trades = [];
    let fresh = false;
    const d = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
    Object.defineProperty(WebSocket.prototype, 'onmessage', { configurable: true, get() { return d.get.call(this); }, set(fn) {
      d.set.call(this, ev => {
        if (cmeBreak && typeof ev.data === 'string') {
          if (ev.data.startsWith('{"type":"ticks"')) { const m = JSON.parse(ev.data); m.ticks = []; ev = { data: JSON.stringify(m) }; }
          else if (ev.data.startsWith('{"type":"tick"') && inBreak(JSON.parse(ev.data).t)) return;
        }
        if (typeof ev.data === 'string') {
          if (ev.data.startsWith('{"type":"history"')) fresh = true;
          else if (ev.data.startsWith('{"type":"ticks"')) { const m = JSON.parse(ev.data); if (m.root === 'NQ') { if (fresh) { rec.length = 0; fresh = false; } for (const x of m.ticks) rec.push(x); } }
          else if (ev.data.startsWith('{"type":"tick"')) { const m = JSON.parse(ev.data); if (m.root === 'NQ') rec.push([m.t, m.p, m.v || 0, m.s, m.sm]); }
        }
        return fn(ev);
      });
    } });
    window.__cores = 0;
    let CEv;
    Object.defineProperty(window, 'ChartEngine', { configurable: true, get() { return CEv; }, set(v) {
      const Orig = v.CumulativeDelta;
      if (Orig) v.CumulativeDelta = class extends Orig { constructor(o) { super(o); window.__cores++; } };
      CEv = v;
    } });
  })();`);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  return ctx;
}
/* LIVE, and the delta built (it is built in slices after a load or a bar type change, review S5) or known absent. */
const live = p => p.waitForFunction(() => document.getElementById('connPill') && document.getElementById('connPill').textContent === 'LIVE', null, { timeout: 30000 })
  .then(() => p.waitForFunction(() => { const c = window.liveChart; return !c || !c.getLayers().delta || !!c.getDelta() || !!c.deltaPane().note; }, null, { timeout: 20000 }))
  .then(() => p.waitForTimeout(800));
async function openPage(ctx, url) {
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fail('console: ' + m.text()); });
  await p.goto(url);
  await live(p);
  return p;
}
/* The pane and its delta as the page holds them, and the same sums counted here from every trade the page received. */
const state = (p, handle) => p.evaluate(h => {
  const chart = h ? window[h].chart : window.liveChart, cd = chart.getDelta(), pane = chart.deltaPane(), S18 = 64800;
  const day = t => Math.floor((t + 86400 - S18) / 86400);
  const sums = {};
  for (const [t, , v, s] of (window.__trades || [])) { const k = day(t), x = sums[k] || (sums[k] = { buy: 0, sell: 0, unknown: 0, n: 0 }); if (s === 1) x.buy += v; else if (s === -1) x.sell += v; else x.unknown += v; x.n++; }
  const root = h ? document.querySelector('#' + (h === '__a' ? 'paneA' : 'paneB')) : document;
  const q = id => root.querySelector(h ? '[id$="-' + id + '"]' : '#' + id);
  return {
    layer: chart.getLayers().delta, pane, cores: window.__cores,
    delta: cd && { bars: cd.bars.length, trades: cd.trades, uncovered: cd.uncovered, covered: cd.coveredFrom,
      sessions: cd.sessions.map(s => ({ day: s.day, start: s.start, from: s.from, partial: s.partial, buy: s.buy, sell: s.sell, unknown: s.unknown, n: s.trades, firstOpen: cd.bars[s.first].o, lastClose: cd.bars[s.last].c })) },
    sums, legend: q('lgDelta') && !q('lgDelta').hidden ? q('lgDelta').textContent.trim() : null,
    chips: [...root.querySelectorAll(h ? '.ind-chips .ind-chip' : '#indChips .ind-chip')].map(c => c.dataset.id + (c.getAttribute('aria-pressed') === 'true' ? '+' : '-')).join(),
    count: (h ? root.querySelector('.ind-count') : document.getElementById('indCount')).textContent,
  };
}, handle || null);
/* Candle-colored pixels in the pane (left of the axis) and in the plot, from the canvas. */
const pixels = (p, handle) => p.evaluate(h => {
  const chart = h ? window[h].chart : window.liveChart, c = h ? document.querySelector('#' + (h === '__a' ? 'paneA' : 'paneB') + ' canvas') : document.querySelector('#chart canvas');
  const x = c.getContext('2d'), dpr = devicePixelRatio, T = chart.colors(), pane = chart.deltaPane(), plotW = c.width / dpr - 78;
  const rgb = hex => { const m = /^#(..)(..)(..)$/.exec(hex); return [1, 2, 3].map(i => parseInt(m[i], 16)); };
  const up = rgb(T.up), dn = rgb(T.down);
  const img = x.getImageData(0, 0, c.width, c.height).data;
  const count = (y0, y1) => {
    let u = 0, d = 0;
    for (let py = Math.max(0, Math.round(y0 * dpr)); py < Math.min(c.height, Math.round(y1 * dpr)); py++) for (let px = 0; px < Math.round(plotW * dpr); px++) {
      const i = (py * c.width + px) * 4;
      if (img[i] === up[0] && img[i + 1] === up[1] && img[i + 2] === up[2]) u++;
      else if (img[i] === dn[0] && img[i + 1] === dn[1] && img[i + 2] === dn[2]) d++;
    }
    return { up: u, down: d };
  };
  return { pane: pane.on ? count(pane.top, pane.top + pane.height) : null, plot: count(0, pane.on ? pane.plotHeight : c.height / dpr - 26) };
}, handle || null);
/* A sample-data label on the page for screenshots (the fake bridge's prices are not market data). */
const label = (p, text) => p.evaluate(t => {
  let el = document.getElementById('__sample');
  if (!el) { el = document.createElement('div'); el.id = '__sample'; el.style.cssText = 'position:fixed;left:50%;top:118px;transform:translateX(-50%);z-index:50;font:600 13px system-ui,sans-serif;color:#080B10;background:#E0B45A;padding:4px 12px;border-radius:6px'; document.body.appendChild(el); }
  el.textContent = t;
}, text);
const shot = async (p, name, text) => { await label(p, 'SAMPLE DATA (fake bridge), not market data. ' + text); await p.mouse.move(8, 8); await p.waitForTimeout(400); await p.screenshot({ path: path.join(SHOTS, name) }); };
/* Every session the page has in full (from 18:00: a partial one counts only its complete bars) equals the trades
   received in it: buys, sells, unknown, the number of trades, and its last close is its buys minus sells. */
const sameSums = st => { const full = st.delta ? st.delta.sessions.filter(s => !s.partial) : []; return full.length > 0 && full.every(s => { const x = st.sums[s.day]; return x && x.buy === s.buy && x.sell === s.sell && x.unknown === s.unknown && x.n === s.n && s.lastClose === s.buy - s.sell; }); };
const menu = async (p, id) => { await p.click('#indBtn'); if (id) await p.click(`#indBody [data-act="gear"][data-id="${id}"]`); };
const pickShow = async (p, v) => { await menu(p, 'delta'); await p.click(`#indBody [data-act="opt"][data-id="delta"][data-v="${v}"]`); await p.keyboard.press('Escape'); await p.waitForTimeout(400); };
const saved = (p, key) => p.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), key);

try {
  /* ---------------- ChartBridge 0.3.4 (sides), NQ Range 40 at 13:00 ET: the whole session in the backfill */
  const off = offsetTo(13, 0, 0, weekday);
  const br = await startBridge(off);
  const ctx = await context(off, 'range');
  const p = await openPage(ctx, `http://localhost:${br.port}/live/`);
  await p.waitForTimeout(800);
  let s = await state(p), px = await pixels(p);
  check(await p.textContent('#lgTf') === 'Range 40t' && /fake-0\.3\.4/.test(await p.textContent('#lgSrc')), 'NQ Range 40 on a fake ChartBridge 0.3.4 (sample data): ' + await p.textContent('#lgSrc'));
  check(s.layer === true && s.pane.on && s.pane.top > s.pane.plotHeight && s.pane.height > 100, 'on by default on the main pane: a pane under the chart, ' + s.pane.height + ' px from y ' + s.pane.top + ' (the chart above ends at ' + s.pane.plotHeight + ')');
  const box = await p.locator('#chart canvas').boundingBox(), area = box.height - 26;
  check(Math.abs(s.pane.height / area - 0.2) < 0.01, 'about 20% of the chart area: ' + (s.pane.height / area * 100).toFixed(1) + '%');
  check(s.count === '6/6' && s.chips === 'volume+,vwap+,levels+,ib+,fills+', 'in the Indicators count, with no chip (review N5: the strip keeps the 1.6.0 five, room for a sixth): ' + s.count + ' ' + s.chips);
  check(px.pane.up + px.pane.down > 200 && px.pane.up > 0 && px.pane.down > 0 && px.plot.up + px.plot.down > 1000, 'candles drawn in the pane in both candle colors: ' + JSON.stringify(px));
  check(sameSums(s), 'the delta equals every trade the page received, per session (buys, sells, unknown, trades, last close): ' + JSON.stringify(s.delta.sessions.map(x => [x.buy, x.sell, x.unknown, x.n, x.lastClose])));
  check(s.delta.sessions.every(x => !x.partial && x.firstOpen === 0), 'each session from 18:00 ET, opening at 0');
  const barsTimes = await p.evaluate(() => { const b = new Set(window.liveChart.bars().map(x => x.t)); return window.liveChart.getDelta().bars.every(d => b.has(d.t)); });
  check(barsTimes, 'every delta candle sits on one of the chart\'s range bars');
  const fmt = v => U.fmtSigned(v, 0), last = s.delta.sessions[s.delta.sessions.length - 1];
  check(s.legend === 'Delta ' + fmt(last.lastClose) && s.pane.title === 'Cumulative delta ' + fmt(last.lastClose), 'legend "' + s.legend + '", pane title "' + s.pane.title + '"');
  await shot(p, 'delta-cumulative-dark.png', 'Cumulative delta, dark ground');

  /* live trades: the store and the delta keep step, with no new core */
  const cores0 = s.cores;
  await p.waitForTimeout(3000);
  s = await state(p);
  check(sameSums(s) && s.delta.sessions[s.delta.sessions.length - 1].n > last.n, 'after 3 s of live trades the totals still equal every trade received: ' + JSON.stringify(s.delta.sessions.map(x => [x.buy, x.sell, x.n])));
  check(s.cores === cores0, 'no new delta core during live trades (' + s.cores + ' made in all)');
  // the crosshair over the pane: the same bar in the legend and the pane
  const pb = s.pane;
  await p.mouse.move(box.x + box.width * 0.5, box.y + pb.top + pb.height / 2);
  await p.waitForTimeout(300);
  const hov = await p.evaluate(() => ({ time: document.getElementById('lgTime').textContent, title: window.liveChart.deltaPane().title, legend: document.getElementById('lgDelta').textContent.trim() }));
  check(!/forming/.test(hov.time) && hov.title !== s.pane.title && hov.legend.replace(/^Delta /, '') === hov.title.replace(/^Cumulative delta /, ''), 'the pointer over the pane picks a bar: legend ' + hov.time + ' "' + hov.legend + '", pane "' + hov.title + '"');
  await p.mouse.move(8, 8);

  /* Bar delta from the gear, and back */
  await menu(p, 'delta');
  check(/Show/.test(await p.textContent('#indBody .ind-set[data-id="delta"]')) && await p.getAttribute('#indBody [data-act="opt"][data-id="delta"][data-v="cum"]', 'aria-pressed') === 'true', 'the gear panel: Show, Cumulative pressed');
  await p.keyboard.press('Escape');
  await pickShow(p, 'bar');
  s = await state(p); px = await pixels(p);
  // the title and the legend come from the same drawn frame; a trade may have come in since, so the newest bar's own
  // delta is compared with a trade's worth of room
  const lb = await p.evaluate(() => { const cd = window.liveChart.getDelta(), b = cd.at(window.liveChart.bars()[window.liveChart.bars().length - 1].t); return b.c - b.o; });
  const shownBar = +s.pane.title.replace('Bar delta ', '').replace(/,/g, '');
  check(s.pane.mode === 'bar' && s.pane.lo <= 0 && s.pane.hi >= 0 && /^Bar delta [+-]?\d/.test(s.pane.title) && s.legend === s.pane.title && Math.abs(shownBar - lb) <= 30,
    'Bar delta: zero in view (' + [s.pane.lo, s.pane.hi].map(Math.round) + '), "' + s.pane.title + '", legend "' + s.legend + '" (the newest bar now ' + fmt(lb) + ')');
  check(px.pane.up + px.pane.down > 100, 'bars drawn: ' + JSON.stringify(px.pane));
  check((await saved(p, 'live-indicator-options-v1')).main.delta.show === 'bar', 'saved for the main pane');
  check(s.cores === cores0, 'the same delta drawn the other way: no new core');
  await shot(p, 'delta-bar-dark.png', 'Bar delta, dark ground');
  await p.reload(); await live(p);
  s = await state(p);
  check(s.pane.mode === 'bar' && s.layer && sameSums(s), 'Bar delta after a reload, rebuilt from the backfill');
  await pickShow(p, 'cum');
  await p.reload(); await live(p);
  check((await state(p)).pane.mode === 'cum', 'Cumulative after a reload');

  /* the black ground */
  await p.click('.ce-theme-btn'); await p.click('.ce-ground[data-bg="black"]'); await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  px = await pixels(p);
  check(px.pane.up + px.pane.down > 200, 'on the black ground: candles drawn: ' + JSON.stringify(px.pane));
  await shot(p, 'delta-cumulative-black.png', 'Cumulative delta, black ground');
  await pickShow(p, 'bar');
  await shot(p, 'delta-bar-black.png', 'Bar delta, black ground');
  await pickShow(p, 'cum');
  await p.click('.ce-theme-btn'); await p.click('.ce-ground[data-bg="dark"]'); await p.keyboard.press('Escape');

  /* a bar type change rebuilds once from the store; 5m and 15s */
  s = await state(p);
  const coresA = s.cores;
  await p.click('#tfSeg >> text="5m"'); await live(p);
  s = await state(p);
  check(s.cores === coresA + 1 && sameSums(s) && s.delta.bars <= await p.evaluate(() => window.liveChart.bars().length), '5m: one rebuild from the store (' + (s.cores - coresA) + '), the same totals for the session held in full; the one before counts from ' +
    s.delta.sessions.filter(x => x.partial).map(x => U.fmtExact(x.from)).join() + ' (the ticks kept start there)');
  await p.click('#tfSeg >> text="15s"'); await live(p);
  s = await state(p);
  const barMatch = await p.evaluate(() => { const b = new Set(window.liveChart.bars().map(x => x.t)); return window.liveChart.getDelta().bars.every(d => b.has(d.t)); });
  check(s.delta && barMatch, '15s: rebuilt, every candle on a 15 s bar (' + s.delta.bars + ' candles)');
  await p.click('#tfSeg >> text="Range"'); await live(p);

  /* the divider: a drag, then the keys; saved per pane, kept after a reload */
  s = await state(p);
  const div = await p.locator('#chart .ce-divider').boundingBox();
  check(!!div && Math.abs(div.y - (box.y + s.pane.plotHeight)) <= 1 && div.y + div.height <= box.y + s.pane.top + 6.5 && div.x + div.width <= box.x + box.width - 78 + 1,
    'the divider\'s band: from where the plot ends, into the pane by at most 6 px, not over the price axis (review N2): ' + JSON.stringify(div));
  check(await p.evaluate(() => { const b = document.querySelector('#chart .ce-live'); return getComputedStyle(b).bottom; }) === Math.round(box.height - s.pane.plotHeight + 12) + 'px', '"Jump to live" sits above the pane (review N3)');
  await p.mouse.move(div.x + 300, div.y + div.height / 2); await p.mouse.down();
  await p.mouse.move(div.x + 300, div.y + div.height / 2 - 120, { steps: 6 }); await p.mouse.up();
  await p.waitForTimeout(300);
  const dragged = await state(p), h1 = await saved(p, 'live-pane-heights-v1');
  check(dragged.pane.height > s.pane.height + 100 && Math.abs(h1.main.delta - dragged.pane.ratio) < 0.001, 'dragged up 120 px: the pane ' + s.pane.height + ' -> ' + dragged.pane.height + ' px, saved ' + h1.main.delta);
  await p.focus('#chart .ce-divider'); await p.keyboard.press('ArrowDown'); await p.waitForTimeout(200);
  const keyed = await state(p), h2 = await saved(p, 'live-pane-heights-v1');
  check(Math.abs(keyed.pane.ratio - (dragged.pane.ratio - 0.02)) < 0.002 && h2.main.delta === keyed.pane.ratio && (await p.evaluate(() => window.liveChart.isLive())), 'ArrowDown on the focused divider: 2% smaller, saved, the chart still on live: ' + keyed.pane.ratio);
  await p.keyboard.press('End'); await p.waitForTimeout(150);
  check((await state(p)).pane.ratio === CE.PANE_RATIO_MIN && (await state(p)).pane.height >= CE.PANE_MIN, 'End: the smallest pane, still ' + (await state(p)).pane.height + ' px');
  await p.keyboard.press('Home'); await p.waitForTimeout(150);
  check((await state(p)).pane.ratio === CE.PANE_RATIO_MAX && (await state(p)).pane.plotHeight >= CE.PRICE_MIN, 'Home: the largest pane, the chart above still ' + (await state(p)).pane.plotHeight + ' px');
  await p.mouse.move(div.x + 300, box.y + (await state(p)).pane.plotHeight + 2); await p.mouse.down();
  await p.mouse.move(div.x + 300, box.y + box.height - 60, { steps: 4 }); await p.mouse.move(div.x + 300, box.y + area * 0.7, { steps: 4 }); await p.mouse.up();
  await p.waitForTimeout(300);
  const set = await state(p);
  await p.reload(); await live(p);
  const back = await state(p);
  check(Math.abs(back.pane.ratio - set.pane.ratio) < 0.001 && Math.abs(back.pane.height - set.pane.height) <= 1, 'the height kept after a reload: ' + back.pane.ratio + ' (' + back.pane.height + ' px)');
  check(JSON.stringify(Object.keys(await saved(p, 'live-pane-heights-v1'))) === '["main"]', 'saved under the main pane only');

  /* the chip (pinned first: none by default, review N5), and Hide all / Restore */
  await menu(p); await p.click('#indBody [data-act="pin"][data-id="delta"]'); await p.keyboard.press('Escape');
  check((await state(p)).chips === 'volume+,vwap+,levels+,ib+,delta+,fills+', 'pinned from the menu: its chip, the sixth');
  const coresShown = (await state(p)).cores;
  await p.click('#indChips .ind-chip[data-id="delta"]'); await p.waitForTimeout(300);
  s = await state(p);
  check(!s.layer && !s.pane.on && s.pane.plotHeight === area && s.chips.includes('delta-') && s.legend === null, 'the chip hides it: no pane, the chart takes the height back, the chip dashed');
  check((await saved(p, 'live-indicators-v2')).main.ind.delta.shown === false, 'hidden and saved, still on the chart');
  await p.waitForTimeout(1500);                                                  // live trades meanwhile: the hidden delta keeps them
  const shownAt = await p.evaluate(() => { document.querySelector('#indChips .ind-chip[data-id="delta"]').click(); return !!window.liveChart.getDelta() && window.liveChart.getLayers().delta; });
  await p.waitForTimeout(400);
  s = await state(p);
  check(shownAt && s.cores === coresShown && s.layer && s.pane.on && sameSums(s) && Math.abs(s.pane.ratio - set.pane.ratio) < 0.001,
    'the chip shows it again at once: the same delta, kept while hidden (no new one: ' + coresShown + ' then ' + s.cores + '), still equal to every trade received, the same height (review S5)');
  await menu(p); await p.click('#indHideAll');
  s = await state(p);
  check(!s.layer && !s.pane.on && s.count === '0/6', 'Hide all hides the pane too: ' + s.count);
  await p.click('#indHideAll'); await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  s = await state(p);
  check(s.layer && s.pane.on && s.count === '6/6', 'Restore brings it back');
  // search finds it; the x takes it off, the + adds it back with its chip
  await menu(p); await p.fill('#indQ', 'order flow');
  check(JSON.stringify(await p.$$eval('#indBody .ind-item', els => els.map(e => e.dataset.id))) === '["delta"]', 'search "order flow" finds Cumulative delta');
  await p.fill('#indQ', 'cvd');
  check(JSON.stringify(await p.$$eval('#indBody .ind-item', els => els.map(e => e.dataset.id))) === '["delta"]', 'and "cvd"');
  await p.fill('#indQ', '');
  await p.click('#indBody [data-act="remove"][data-id="delta"]');
  check(!(await state(p)).pane.on && (await state(p)).count === '5/5', 'the x takes it off the chart');
  await p.click('#indBody .ind-cat[data-id="volume"]'); await p.click('#indBody [data-f="add:delta"]'); await p.keyboard.press('Escape');
  s = await state(p);
  check(s.pane.on && s.chips.includes('delta+') && s.count === '6/6', '+ in the Volume group adds it back, with its chip');
  await ctx.close(); br.kill();

  /* ---------------- ChartBridge 0.3.3 (no sides): nothing drawn, a note */
  {
    const o = offsetTo(13, 0, 0, weekday);
    const b3 = await startBridge(o, ['--no-sides']);
    const c3 = await context(o, 'range');
    const q = await openPage(c3, `http://localhost:${b3.port}/live/`);
    const st = await state(q), pxl = await pixels(q);
    check(/fake-0\.3\.3/.test(await q.textContent('#lgSrc')) && st.layer && st.pane.on, 'ChartBridge 0.3.3: the pane is there (the layout as with sides)');
    check(st.delta === null && pxl.pane.up + pxl.pane.down === 0 && pxl.plot.up + pxl.plot.down > 1000, 'and draws nothing: no delta, no candle pixels in it: ' + JSON.stringify(pxl));
    check(st.pane.note === 'Delta needs ChartBridge 0.3.4 on this PC' && st.legend === 'Delta needs ChartBridge 0.3.4 on this PC', 'the note, in the pane and the legend: "' + st.legend + '"');
    check(await q.textContent('#lgDv') === '' && !/[+-]\d|\d,\d/.test(st.pane.title), 'no delta number anywhere: "' + st.pane.title + '"');
    await shot(q, 'delta-old-bridge-note.png', 'ChartBridge 0.3.3: no sides, no delta');
    await q.click('#tfSeg >> text="1m"'); await live(q);
    const m1 = await state(q);
    check(m1.delta === null && m1.pane.note !== '', '1m on 0.3.3 (no backfill, live trades without sides): still nothing, still the note');
    await c3.close(); b3.kill();
  }

  /* ---------------- a history that starts after 18:00: labelled, not started at 0 from a later time silently */
  {
    const o = offsetTo(13, 0, 0, weekday);
    const b4 = await startBridge(o, ['--tick-hours-max=2']);
    const c4 = await context(o, 's15');
    const q = await openPage(c4, `http://localhost:${b4.port}/live/`);
    const st = await state(q), ses = st.delta && st.delta.sessions[st.delta.sessions.length - 1];
    check(!!ses && ses.partial && ses.from > ses.start + 3600 && ses.firstOpen === 0, '15s with 2 hours of ticks: the session counts from ' + (ses && U.fmtExact(ses.from)) + ', flagged as partial');
    check(st.pane.title.endsWith('from ' + U.fmtExact(ses.from) + ' ET, not 18:00: the tick history starts later') && st.legend.startsWith('Delta from ' + U.fmtExact(ses.from)), 'said in the pane ("' + st.pane.title + '") and the legend ("' + st.legend + '")');
    check(st.delta.covered > ses.start && ses.from >= st.delta.covered && ses.from - st.delta.covered <= 15, 'it counts from the first 15 s bar that starts once the page has every trade (from ' + U.fmtExact(st.delta.covered) + ')');
    await shot(q, 'delta-partial-history-15s.png', 'Delta from a later start, labelled');
    await q.click('#tfSeg >> text="1m"'); await live(q);
    const m1 = await state(q);
    check(m1.delta && /the tick history starts later|starts with the next full bar/.test(m1.pane.title), '1m after 15s (the ticks kept): labelled: "' + m1.pane.title + '"');
    await c4.close(); b4.kill();
  }
  {
    const o = offsetTo(13, 0, 0, weekday);
    const b5 = await startBridge(o);
    const c5 = await context(o, 'm1');
    const q = await openPage(c5, `http://localhost:${b5.port}/live/`);
    const st = await state(q);
    check(st.delta && st.delta.sessions.every(x => x.partial) && /this view loads no tick history/.test(st.pane.title), '1m first load (no tick history): no cumulative from 18:00; "' + st.pane.title + '"');
    await shot(q, 'delta-1m-no-tick-history.png', '1m: no tick history, labelled');
    await c5.close(); b5.kill();
  }

  /* ---------------- mounted panes: the second pane off by default, added from its menu; the option under the prefix */
  {
    const o = offsetTo(13, 0, 0, weekday);
    const b6 = await startBridge(o);
    const c6 = await context(o, 'range');
    const host = await c6.newPage();
    host.on('pageerror', e => fail('embed pageerror: ' + e.message));
    await host.goto(`http://localhost:${b6.port}/test/embed-host.html`);
    await host.evaluate(pt => {
      localStorage.clear();
      localStorage.setItem('desk:live-settings-v2', JSON.stringify({ root: 'NQ', tf: 'range', glide: 'smooth', rangeMode: 'nt' }));
      window.__a = ChartLive.mount(document.getElementById('paneA'), { wsUrl: 'ws://localhost:' + pt + '/ws', paneId: 'main', storagePrefix: 'desk:' });
      window.__b = ChartLive.mount(document.getElementById('paneB'), { wsUrl: 'ws://localhost:' + pt + '/ws', paneId: 'pane-2', storagePrefix: 'desk:' });
    }, b6.port);
    await host.waitForFunction(() => [...document.querySelectorAll('[id$="-connPill"]')].every(x => x.textContent === 'LIVE'), null, { timeout: 30000 });
    await host.waitForTimeout(1000);
    let a = await state(host, '__a'), b = await state(host, '__b');
    check(a.layer && a.pane.on && a.delta && b.layer === false && !b.pane.on && b.count === '0/0', 'mounted: the main pane has the delta pane, pane-2 starts without it');
    await host.click('#paneB .ind-btn'); await host.click('#paneB .ind-cat[data-id="volume"]'); await host.click('#paneB [data-f="add:delta"]'); await host.keyboard.press('Escape');
    await host.waitForTimeout(500);
    b = await state(host, '__b');
    check(b.layer && b.pane.on && b.delta && b.count === '1/1' && b.chips === 'delta+', 'pane-2: added from its menu, with a chip: ' + b.chips);
    const api = await host.evaluate(() => ({ bad: window.__b.setIndicatorOption('delta', 'show', 'bars'), inherited: window.__b.setIndicatorOption('delta', 'toString', 'bar'), good: window.__b.setIndicatorOption('delta', 'show', 'bar'),
      now: window.__b.indicatorOptions('delta'), a: window.__a.indicatorOptions('delta'), mode: window.__b.chart.deltaPane().mode, saved: JSON.parse(localStorage.getItem('desk:live-indicator-options-v1')), page: localStorage.getItem('live-indicator-options-v1') }));
    check(api.bad === false && api.inherited === false && api.good === true && api.now.show === 'bar' && api.a.show === 'cum' && api.mode === 'bar' && api.saved['pane-2'].delta.show === 'bar' && api.page === null,
      'setIndicatorOption(\'delta\', \'show\', \'bar\') on the mounted pane: drawn, saved under desk: for pane-2 only: ' + JSON.stringify(api));
    const pxa = await pixels(host, '__a'), pxb = await pixels(host, '__b');
    check(pxa.pane.up + pxa.pane.down > 100 && pxb.pane.up + pxb.pane.down > 100, 'both panes draw: ' + JSON.stringify([pxa, pxb, a.pane, b.pane]));
    await label(host, 'SAMPLE DATA (fake bridge), not market data. Two mounted panes: main (cumulative) and pane-2 (bar delta)');
    await host.screenshot({ path: path.join(SHOTS, 'delta-embed-two-panes.png') });
    // the divider of pane-2: its height saved under its own pane id and prefix
    const dv = await host.locator('#paneB .ce-divider').boundingBox();
    await host.mouse.move(dv.x + 100, dv.y + dv.height / 2); await host.mouse.down(); await host.mouse.move(dv.x + 100, dv.y - 60, { steps: 4 }); await host.mouse.up();
    await host.waitForTimeout(200);
    const hs = await host.evaluate(() => ({ desk: JSON.parse(localStorage.getItem('desk:live-pane-heights-v1')), page: localStorage.getItem('live-pane-heights-v1'), ratio: window.__b.chart.deltaPane().ratio }));
    check(hs.desk && Object.keys(hs.desk).join() === 'pane-2' && hs.desk['pane-2'].delta === hs.ratio && hs.page === null, 'pane-2\'s height saved under desk: for pane-2: ' + JSON.stringify(hs));
    await host.evaluate(() => { window.__a.destroy(); window.__b.destroy(); });
    await c6.close(); b6.kill();
  }

  /* ---------------- a backfill cut short after 18:00 (review B1): labelled with its exact start, never the whole session */
  {
    const tueToFri = bt => { const d = new Date(bt * 1000).getUTCDay(); return d >= 2 && d <= 5; };
    const partialFrom = async (label, bridgeFlags, opts) => {
      const o = offsetTo(2, 5, 0, tueToFri);                       // 02:05 ET: Range asks 11 hours, a cap of 8 starts at 18:05
      const bc = await startBridge(o, bridgeFlags);
      const cc = await context(o, 'range', '', opts);
      const q = await openPage(cc, `http://localhost:${bc.port}/live/`);
      const st = await state(q), ses = st.delta && st.delta.sessions[st.delta.sessions.length - 1];
      const r = await q.evaluate(() => ({ first: window.__trades.length ? window.__trades[0][0] : null, asked: window.__asked }));
      const late = r.first - (ses ? ses.start : 0);                 // 8 hours before the request: 18:05, give or take the page's load time
      check(!!ses && ses.partial && ses.from > r.first && late >= 180 && late < 420 && ses.firstOpen === 0,
        label + ': the first trade at ' + U.fmtExact(r.first) + ' ET (asked ' + (r.asked.length ? r.asked.join() + ' hours, sent on as 8' : 'more than was sent') + '): the session counts from ' + (ses && U.fmtExact(ses.from)) + ', flagged partial');
      check(st.pane.title.endsWith('from ' + U.fmtExact(ses.from) + ' ET, not 18:00: the tick history starts later') && st.legend.startsWith('Delta from ' + U.fmtExact(ses.from)),
        label + ': said in the pane ("' + st.pane.title + '") and the legend ("' + st.legend + '"), never a plain "Cumulative delta"');
      // the trades received and the delta read in one task, so a live trade cannot land between them
      const [inFrom, got] = await q.evaluate(f => {
        let b = 0, s = 0; for (const [t, , v, sd] of window.__trades) if (t >= f) { if (sd === 1) b += v; else if (sd === -1) s += v; }
        const x = window.liveChart.getDelta().sessions.at(-1); return [[b, s], [x.buy, x.sell]];
      }, ses.from);
      check(inFrom[0] === got[0] && inFrom[1] === got[1], label + ': what it counts is every trade from that start: ' + JSON.stringify([inFrom, got]));
      await shot(q, 'delta-cut-short-' + (opts ? 'relay' : 'ninjatrader') + '.png', label + ': labelled from ' + U.fmtExact(ses.from));
      await cc.close(); bc.kill();
    };
    await partialFrom('The Desk\'s relay capping tickHours at 8', [], { relayHours: 8 });
    await partialFrom('NinjaTrader sending 8 hours of the 11 asked', ['--tick-hours-max=8'], null);
  }

  /* ---------------- a minute view opened before 18:00 (review S1): the session is whole from 18:00 */
  {
    const o = offsetTo(17, 59, 20, monToThu);
    const b8 = await startBridge(o);
    const c8 = await context(o, 'm1', '', { cmeBreak: true });      // no tick backfill (minute view), nothing trades 17:00 to 18:00
    const q = await openPage(c8, `http://localhost:${b8.port}/live/`);
    const endAt = Date.now() + 50000;
    let st = await state(q);
    while (Date.now() < endAt) {
      await q.waitForTimeout(1000);
      st = await state(q);
      const x = st.delta && st.delta.sessions[st.delta.sessions.length - 1];
      if (x && x.n > 20 && x.start % 86400 === S18 && (await q.evaluate(() => Date.now() / 1000)) % 60 > 5) break;
    }
    const ses = st.delta && st.delta.sessions[st.delta.sessions.length - 1];
    // the trades received and the delta read in one task, so a live trade cannot land between them
    const r = await q.evaluate(() => { let b = 0, s = 0, n = 0, first = null; for (const [t, , v, sd] of window.__trades) { if (first === null) first = t; n++; if (sd === 1) b += v; else if (sd === -1) s += v; }
      const x = window.liveChart.getDelta().sessions.at(-1); return { b, s, n, first, buy: x.buy, sell: x.sell, trades: x.trades }; });
    check(!!ses && !ses.partial && ses.from - ses.start < 60 && ses.firstOpen === 0 && U.fmtHM(r.first) === '18:00', '1m opened at 17:59:20 (first trade the 18:00 open, ' + U.fmtExact(r.first) + '): the session is whole, from its first bar at ' + (ses && U.fmtExact(ses.from)) + ', opening at 0');
    check(ses && r.buy === r.b && r.sell === r.s && r.trades === r.n && !/not 18:00/.test(st.pane.title), 'every trade received counted, the open\'s bar too (' + r.n + ' trades); "' + st.pane.title + '"');
    await shot(q, 'delta-1m-opened-before-1800.png', '1m opened at 17:59:20: whole from 18:00');
    await c8.close(); b8.kill();
  }

  /* ---------------- 18:00 ET: a new session starts at 0 (the clock set to 17:59:35 on a Monday to Thursday) */
  {
    const o = offsetTo(17, 59, 35, monToThu);
    const b7 = await startBridge(o);
    const c7 = await context(o, 's15');
    const q = await openPage(c7, `http://localhost:${b7.port}/live/`);
    const before = await state(q);
    const endAt = Date.now() + 45000;
    let after = before;
    while (Date.now() < endAt) {
      await q.waitForTimeout(1000);
      after = await state(q);
      if (after.delta && after.delta.sessions.length > before.delta.sessions.length && after.delta.sessions[after.delta.sessions.length - 1].n > 20) break;
    }
    const s0 = before.delta.sessions[before.delta.sessions.length - 1], sN = after.delta.sessions[after.delta.sessions.length - 1], sP = after.delta.sessions[after.delta.sessions.length - 2];
    check(after.delta.sessions.length === before.delta.sessions.length + 1 && sN.start % 86400 === S18 && sN.start === s0.start + 86400, 'at 18:00 ET a new session: ' + U.fmtHM(sN.start) + ' (the one before from ' + U.fmtHM(s0.start) + ')');
    check(sN.firstOpen === 0 && sN.lastClose === sN.buy - sN.sell && sP.lastClose === sP.buy - sP.sell, 'it opens at 0; each session\'s last close is its own buys minus sells: ' + JSON.stringify([sP.lastClose, sN.firstOpen, sN.lastClose]));
    check(sameSums(after) && !sN.partial && after.cores === before.cores, 'the new session\'s totals equal the trades received, with no rebuild at the rollover (' + before.cores + ' then ' + after.cores + ' cores)');
    const t = await q.evaluate(() => window.liveChart.deltaPane().title);
    check(t === 'Cumulative delta ' + U.fmtSigned(sN.lastClose, 0), 'the pane shows the new session\'s value: "' + t + '"');
    await shot(q, 'delta-rollover-1800.png', 'The 18:00 ET session start (clock set to 17:59:35)');
    await c7.close(); b7.kill();
  }
} finally {
  await browser.close();
  for (const b of bridges) b.kill();
}

if (errors.length) { console.error('FAIL (' + errors.length + ' of ' + checks + ' checks)\n' + errors.join('\n')); process.exit(1); }
console.log('delta smoke: ok (' + checks + ' checks; screenshots in ' + SHOTS + ')');
