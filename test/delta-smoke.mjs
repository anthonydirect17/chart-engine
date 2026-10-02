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
// Round 4 (Anthony: delta is a tool used while trading): only trades with a measured side count, so with ChartBridge
// 0.3.4.1's quoteHours 0 (--quote-hours=0: every backfill side by the tick rule) a 15s view counts from the page's opening,
// labelled "since HH:MM ET (page opened)", and with quoteHours 1 from its quote window, "since HH:MM ET"; a 1m view asks no
// ticks; the pane switched on in a 1m view never reloads; review 2's scenario C (the PC clock 10 s behind the exchange, a
// 1m view going live seconds before 18:00 with nothing traded in the break) is labelled, never a count from 18:00.
// Round 5 (review 4): a 1h view counts at once from the page's opening; a reload for more ticks (5m to 15s) and a ChartBridge
// reconnect keep the count and its "(page opened)"; another instrument starts a new count. Round 6 (review 5): the seconds a
// reload (ChartBridge holding trades 3 s) and a ChartBridge restart missed are in the label ("missed 8 s").
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

/* A fake bridge on a given port (a restart after a kill: the port may take a moment to free). */
async function bridgeOn(p, offset, extra) {
  for (let tries = 0; tries < 40; tries++) {
    const b = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(p), '--pin-off', '--test-controls', '--clock-offset=' + offset].concat(extra || []), { stdio: ['ignore', 'pipe', 'pipe'] });
    const ok = await new Promise(res => { b.stdout.once('data', () => res(true)); b.once('exit', () => res(false)); });
    if (ok) { bridges.push(b); return { port: p, kill: () => b.kill() }; }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('no bridge on port ' + p);
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
    window.__asked = []; window.__subAt = [];
    {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (x) {
        try { const m = JSON.parse(x); if (m.type === 'subscribe') { window.__asked.push(m.tickHours); window.__subAt.push(performance.now()); if (relayHours && m.tickHours > relayHours) { m.tickHours = relayHours; x = JSON.stringify(m); } } } catch (e) {}
        return send.call(this, x);
      };
    }
    const inBreak = t => { const s = ((t % 86400) + 86400) % 86400; return s >= 61200 && s < 64800; };
    const rec = window.__trades = [], liveRec = window.__live = [];   // __live: every NQ live trade, never reset (round 5)
    let fresh = false;
    const d = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
    Object.defineProperty(WebSocket.prototype, 'onmessage', { configurable: true, get() { return d.get.call(this); }, set(fn) {
      d.set.call(this, ev => {
        if (cmeBreak && typeof ev.data === 'string') {
          if (ev.data.startsWith('{"type":"ticks"')) { const m = JSON.parse(ev.data); m.ticks = []; ev = { data: JSON.stringify(m) }; }
          else if (ev.data.startsWith('{"type":"tick"') && inBreak(JSON.parse(ev.data).t)) return;
        }
        if (typeof ev.data === 'string') {
          if (ev.data.startsWith('{"type":"ready"')) window.__readyAt = Date.now() / 1000;   // the page's clock when it goes live
          if (ev.data.startsWith('{"type":"history"')) fresh = true;
          else if (ev.data.startsWith('{"type":"ticks"')) { const m = JSON.parse(ev.data); if (m.root === 'NQ') { if (fresh) { rec.length = 0; fresh = false; } for (const x of m.ticks) rec.push(x); if (m.ticks.length) window.__backfillEnd = m.ticks[m.ticks.length - 1][0]; } }
          else if (ev.data.startsWith('{"type":"tick"')) { const m = JSON.parse(ev.data); if (m.root === 'NQ') { rec.push([m.t, m.p, m.v || 0, m.s, m.sm]); liveRec.push([m.t, m.p, m.v || 0, m.s, m.sm]); } }
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
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_CONNECTION_REFUSED/.test(m.text())) fail('console: ' + m.text()); });   // refused: the restart test's bridge is down
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
  const p = await openPage(ctx, `http://localhost:${br.port}/live/single.html`);
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
  // read together after a drawn frame, in one task (a live trade between two reads made this flaky, as review 2 N1)
  const lt = await p.evaluate(() => new Promise(res => requestAnimationFrame(() => res({ legend: document.getElementById('lgDelta').textContent.trim(), title: window.liveChart.deltaPane().title, close: window.liveChart.getDelta().last.c }))));
  check(lt.legend === 'Delta ' + fmt(lt.close) && lt.title === 'Cumulative delta ' + fmt(lt.close), 'legend "' + lt.legend + '", pane title "' + lt.title + '"');
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
  // the ratio saved is the pane's whole pixels over the chart's height, so it can sit 0.001 off the limit at some heights
  // (1.14.0: the single chart page's one-line toolbar made the chart taller)
  check(Math.abs((await state(p)).pane.ratio - CE.PANE_RATIO_MIN) <= 0.002 && (await state(p)).pane.height >= CE.PANE_MIN, 'End: the smallest pane, still ' + (await state(p)).pane.height + ' px');
  await p.keyboard.press('Home'); await p.waitForTimeout(150);
  check(Math.abs((await state(p)).pane.ratio - CE.PANE_RATIO_MAX) <= 0.002 && (await state(p)).pane.plotHeight >= CE.PRICE_MIN, 'Home: the largest pane, the chart above still ' + (await state(p)).pane.plotHeight + ' px');
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
    const q = await openPage(c3, `http://localhost:${b3.port}/live/single.html`);
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
    const q = await openPage(c4, `http://localhost:${b4.port}/live/single.html`);
    const st = await state(q), ses = st.delta && st.delta.sessions[st.delta.sessions.length - 1];
    check(!!ses && ses.partial && ses.from > ses.start + 3600 && ses.firstOpen === 0, '15s with 2 hours of ticks: the session counts from ' + (ses && U.fmtExact(ses.from)) + ', flagged as partial');
    check(st.pane.title.endsWith(' since ' + U.fmtExact(ses.from) + ' ET') && st.legend.startsWith('Delta since ' + U.fmtExact(ses.from)), 'said in the pane ("' + st.pane.title + '") and the legend ("' + st.legend + '")');
    check(st.delta.covered > ses.start && ses.from >= st.delta.covered && ses.from - st.delta.covered <= 15, 'it counts from the first 15 s bar that starts once the page has every trade (from ' + U.fmtExact(st.delta.covered) + ')');
    await shot(q, 'delta-partial-history-15s.png', 'Delta from a later start, labelled');
    await q.click('#tfSeg >> text="1m"'); await live(q);
    const m1 = await state(q);
    check(m1.delta && / since 1[01]:\d\d ET$|starts with the next full bar$/.test(m1.pane.title), '1m after 15s (the ticks kept): labelled: "' + m1.pane.title + '"');
    await c4.close(); b4.kill();
  }
  {
    const o = offsetTo(13, 0, 0, weekday);
    const b5 = await startBridge(o);
    const c5 = await context(o, 'm1');
    const q = await openPage(c5, `http://localhost:${b5.port}/live/single.html`);
    const st = await state(q), asked = await q.evaluate(() => window.__asked);
    check(JSON.stringify(asked) === '[0]' && st.delta && st.delta.sessions.every(x => x.partial) && / since 13:0\d ET \(page opened\)$|starts with the next full bar$/.test(st.pane.title),
      '1m first load at 13:00: asks no ticks (' + asked + ', as before 1.7.0), the delta from the page\'s opening: "' + st.pane.title + '"');
    await shot(q, 'delta-1m-first-load.png', '1m first load: delta from the page opening');
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
      const q = await openPage(cc, `http://localhost:${bc.port}/live/single.html`);
      const st = await state(q), ses = st.delta && st.delta.sessions[st.delta.sessions.length - 1];
      const r = await q.evaluate(() => ({ first: window.__trades.length ? window.__trades[0][0] : null, asked: window.__asked }));
      const late = r.first - (ses ? ses.start : 0);                 // 8 hours before the request: 18:05, give or take the page's load time
      check(!!ses && ses.partial && ses.from > r.first && late >= 180 && late < 420 && ses.firstOpen === 0,
        label + ': the first trade at ' + U.fmtExact(r.first) + ' ET (asked ' + (r.asked.length ? r.asked.join() + ' hours, sent on as 8' : 'more than was sent') + '): the session counts from ' + (ses && U.fmtExact(ses.from)) + ', flagged partial');
      check(st.pane.title.endsWith(' since ' + U.fmtExact(ses.from) + ' ET') && st.legend.startsWith('Delta since ' + U.fmtExact(ses.from)),
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
    const q = await openPage(c8, `http://localhost:${b8.port}/live/single.html`);
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

  /* ---------------- round 4 (Anthony: delta while trading): only measured sides count; nothing extra is loaded */
  // The newest session as the page holds it and every trade received from `from` on, read in one task after a drawn frame
  // (so the title is the frame's and no live trade lands between the reads).
  const newest = (q, from) => q.evaluate(f => new Promise(res => requestAnimationFrame(() => {
    const cd = window.liveChart.getDelta(), x = cd && cd.sessions.at(-1), fromT = f === null ? (x ? x.from : 0) : f;
    let b = 0, sl = 0, n = 0, first = null;
    for (const [t, , v, sd] of window.__trades) { if (first === null) first = t; if (t >= fromT) { n++; if (sd === 1) b += v; else if (sd === -1) sl += v; } }
    res({ title: window.liveChart.deltaPane().title, ses: x && { start: x.start, from: x.from, partial: x.partial, buy: x.buy, sell: x.sell, n: x.trades, firstOpen: cd.bars[x.first].o, close: cd.bars[x.last].c },
      got: { b, s: sl, n }, first, asked: window.__asked.slice(), readyAt: window.__readyAt, backfillEnd: window.__backfillEnd });
  })), from === undefined ? null : from);
  const weekdayEve = bt => { const d = new Date(bt * 1000).getUTCDay(); return d >= 1 && d <= 4; };
  /* 15s at 13:00 with ChartBridge 0.3.4.1: quoteHours 0 (its default: every backfill side by the tick rule) and 1 */
  for (const qh of [0, 1]) {
    const o = offsetTo(13, 0, 0, weekday);
    const b = await startBridge(o, ['--quote-hours=' + qh]);
    const c = await context(o, 's15');
    const q = await openPage(c, `http://localhost:${b.port}/live/single.html`);
    let r = await newest(q);
    const endAt = Date.now() + 40000;
    while (Date.now() < endAt && !(r.ses && r.ses.n > 5)) { await q.waitForTimeout(1000); r = await newest(q); }
    const measuredFrom = await q.evaluate(() => { let t = null; for (const x of window.__trades) if (x[4] === 1 || x[4] === 2) { t = x[0]; break; } return t; });
    if (qh === 0) {
      check(!!r.ses && r.ses.partial && r.ses.from > r.backfillEnd && r.ses.firstOpen === 0 && r.ses.buy === r.got.b && r.ses.sell === r.got.s && r.ses.n === r.got.n,
        'quoteHours 0: none of the ' + '8 hours of backfill counts (its sides are all by the tick rule); from ' + U.fmtExact(r.ses && r.ses.from) + ', after the backfill\'s last trade at ' + U.fmtExact(r.backfillEnd) + ', every live trade from then: ' + JSON.stringify([r.ses, r.got]));
      check(r.title.endsWith(' since ' + U.fmtExact(r.ses.from) + ' ET (page opened)') && (await q.textContent('#lgDelta')).trim().startsWith('Delta since ' + U.fmtExact(r.ses.from)), 'quoteHours 0: "' + r.title + '"');
      await shot(q, 'delta-quote-hours-0.png', 'quoteHours 0: delta since the page opened');
    } else {
      check(!!r.ses && r.ses.partial && measuredFrom !== null && r.ses.from > measuredFrom && r.ses.from - measuredFrom <= 15 && r.ses.from < r.backfillEnd && r.ses.buy === r.got.b && r.ses.sell === r.got.s && r.ses.n === r.got.n,
        'quoteHours 1: counts from the first 15 s bar after the backfill\'s first measured side (' + U.fmtExact(measuredFrom) + '): ' + U.fmtExact(r.ses && r.ses.from) + ', every trade from then: ' + JSON.stringify([r.ses, r.got]));
      check(r.title.endsWith(' since ' + U.fmtExact(r.ses.from) + ' ET') && !/page opened/.test(r.title), 'quoteHours 1: "' + r.title + '"');
    }
    await c.close(); b.kill();
  }
  {
    /* the pane switched on in a 1m view loaded without it: built from the store, no reload, orders never wait for it */
    const o = offsetTo(13, 0, 0, weekday);
    const b = await startBridge(o);
    const c = await context(o, 'm1', `if (!localStorage.getItem('live-indicators-v2')) localStorage.setItem('live-indicators-v2', JSON.stringify({ main: { ind: { delta: { on: false, shown: true, pin: false } } } }));`);
    const q = await openPage(c, `http://localhost:${b.port}/live/single.html`);
    const before = await q.evaluate(() => ({ asked: window.__asked.slice(), delta: !!window.liveChart.getDelta(), layer: window.liveChart.getLayers().delta }));
    check(JSON.stringify(before.asked) === '[0]' && !before.delta && !before.layer, '1m with the delta pane off: asks no ticks (' + before.asked + '), no delta');
    await q.evaluate(() => {
      window.__pill = []; const el = document.getElementById('connPill');
      new MutationObserver(() => window.__pill.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
    });
    await menu(q); await q.click('#indBody .ind-cat[data-id="volume"]');
    await q.click('#indBody [data-f="add:delta"]'); await q.keyboard.press('Escape');
    await q.waitForTimeout(800);
    const r = await q.evaluate(() => ({ asked: window.__asked.slice(), pill: window.__pill.slice(), now: document.getElementById('connPill').textContent, title: window.liveChart.deltaPane().title, delta: !!window.liveChart.getDelta() }));
    check(JSON.stringify(r.asked) === '[0]' && r.pill.length === 0 && r.now === 'LIVE' && r.delta && /starts with the next full bar$| since 13:0\d ET \(page opened\)$/.test(r.title),
      'switched on: no new subscribe (' + r.asked + '), never LOADING (so no "Still loading" for orders), the delta from the page\'s opening: "' + r.title + '"');
    await c.close(); b.kill();
  }
  {
    /* round 5 (review 4 S1): 1h, no tick backfill: the page-open bar counts its trades from the start, by their own time */
    const o = offsetTo(13, 0, 0, weekday);
    const b = await startBridge(o);
    const c = await context(o, 'h1');
    const q = await openPage(c, `http://localhost:${b.port}/live/single.html`);
    await q.waitForTimeout(3000);
    const r = await newest(q);
    check(!!r.ses && r.ses.partial && r.ses.n > 5 && r.ses.firstOpen === 0 && r.ses.buy === r.got.b && r.ses.sell === r.got.s && r.ses.n === r.got.n && r.ses.from - r.ses.start > 19 * 3600 - 1,
      '1h: counting at once from ' + U.fmtExact(r.ses && r.ses.from) + ', not from the next full bar at 14:00; every live trade from then: ' + JSON.stringify([r.ses, r.got]));
    check(r.title.endsWith(' since ' + U.fmtExact(r.ses.from) + ' ET (page opened)'), '1h: "' + r.title + '"');
    await c.close(); b.kill();
  }
  {
    /* round 5 (review 4 B1): a reload for more ticks, and a ChartBridge reconnect, keep the count; another instrument starts a new one */
    const o = offsetTo(13, 0, 0, weekday);
    const b = await startBridge(o, ['--quote-hours=0']);
    const c = await context(o, 'm5');
    const q = await openPage(c, `http://localhost:${b.port}/live/single.html`);
    await q.waitForTimeout(3000);
    // the count as drawn, and every live trade received from its start (the recorder here is never reset)
    const kept = () => q.evaluate(() => new Promise(res => requestAnimationFrame(() => {
      const cd = window.liveChart.getDelta(), x = cd && cd.sessions.at(-1);
      let bb = 0, ss = 0, n = 0; if (x) for (const [t, , v, sd] of window.__live) if (t >= x.from) { n++; if (sd === 1) bb += v; else if (sd === -1) ss += v; }
      res({ title: window.liveChart.deltaPane().title, asked: window.__asked.slice(), ses: x && { from: x.from, partial: x.partial, buy: x.buy, sell: x.sell, n: x.trades }, got: { b: bb, s: ss, n } });
    })));
    const a = await kept();
    check(!!a.ses && a.ses.n > 5 && a.ses.buy === a.got.b && a.ses.sell === a.got.s && / \(page opened\)$/.test(a.title), '5m: counting since the page opened: "' + a.title + '", ' + a.ses.n + ' trades');
    await q.click('#tfSeg >> text="15s"'); await live(q);
    let r1 = await kept();                                         // 15 s bars: the count shows from its first full 15 s bar
    for (const until = Date.now() + 40000; Date.now() < until && !(r1.ses && r1.ses.n > a.ses.n); ) { await q.waitForTimeout(1000); r1 = await kept(); }
    check(JSON.stringify(r1.asked) === '[0,8]' && !!r1.ses && r1.ses.from >= a.ses.from && r1.ses.from - a.ses.from <= 15 && r1.ses.n > a.ses.n && r1.ses.buy === r1.got.b && r1.ses.sell === r1.got.s && r1.ses.n === r1.got.n && / \(page opened\)$/.test(r1.title),
      'to 15s, a reload for 8 hours of ticks: the same count (from ' + U.fmtExact(r1.ses.from) + ', the first full 15 s bar of it), every live trade of both loads, still "(page opened)": "' + r1.title + '"');
    await fetch(`http://localhost:${b.port}/test/drop`, { method: 'POST' });
    await q.waitForFunction(() => document.getElementById('connPill').textContent !== 'LIVE', null, { timeout: 10000 }).catch(() => {});
    await live(q); await q.waitForTimeout(1500);
    const r2 = await kept();
    check(!!r2.ses && r2.ses.from === r1.ses.from && r2.ses.n > r1.ses.n && r2.ses.buy === r2.got.b && r2.ses.sell === r2.got.s && r2.ses.n === r2.got.n && / \(page opened\)$/.test(r2.title),
      'a ChartBridge reconnect: the same count, every live trade received before and after it: "' + r2.title + '" ' + JSON.stringify([r2.ses, r2.got]));
    await q.click('#symSeg >> text="ES"'); await live(q); await q.waitForTimeout(2500);
    const es = await q.evaluate(() => window.liveChart.deltaPane().title);
    check(/ since \d\d:\d\d(:\d\d(\.\d)?)? ET$|starts with the next full bar$/.test(es) && !/page opened/.test(es), 'another instrument: a new count, "since" with no "(page opened)": "' + es + '"');
    await c.close(); b.kill();
  }
  {
    /* round 5: a count that began in the backfill's quote window (quoteHours 1) keeps it across a reconnect */
    const o = offsetTo(13, 0, 0, weekday);
    const b = await startBridge(o, ['--quote-hours=1']);
    const c = await context(o, 's15');
    const q = await openPage(c, `http://localhost:${b.port}/live/single.html`);
    await q.click('#tfSeg >> text="1m"'); await live(q);
    const seen = () => q.evaluate(() => new Promise(res => requestAnimationFrame(() => { const x = window.liveChart.getDelta().sessions.at(-1); res({ title: window.liveChart.deltaPane().title, from: x.from, n: x.trades, buy: x.buy, sell: x.sell }); })));
    const before = await seen();
    await fetch(`http://localhost:${b.port}/test/drop`, { method: 'POST' });
    await q.waitForFunction(() => document.getElementById('connPill').textContent !== 'LIVE', null, { timeout: 10000 }).catch(() => {});
    await live(q); await q.waitForTimeout(1000);
    const after = await seen();
    check(before.n > 1000 && after.from === before.from && after.n >= before.n && after.buy >= before.buy && after.sell >= before.sell && after.title.endsWith(' since ' + U.fmtExact(before.from) + ' ET'),
      'quoteHours 1, 15s then 1m, then a reconnect: the count from the quote window is kept (' + before.n + ' then ' + after.n + ' trades): "' + before.title + '" then "' + after.title + '"');
    await c.close(); b.kill();
  }
  {
    /* round 6 (review 5 B1): the seconds a reload for more ticks misses are in the label (ChartBridge holds a page's trades
       while NinjaTrader answers, here 3 s: --load-delay-ms) */
    const o = offsetTo(13, 0, 0, weekday);
    const b = await startBridge(o, ['--quote-hours=0', '--load-delay-ms=3000']);
    const c = await context(o, 'm5');
    const q = await openPage(c, `http://localhost:${b.port}/live/single.html`);
    await q.waitForTimeout(2000);
    const t0 = await q.evaluate(() => window.liveChart.deltaPane().title);
    check(/ \(page opened\)$/.test(t0), '5m before the reload: nothing missed, "' + t0 + '"');
    await q.click('#tfSeg >> text="15s"'); await live(q);
    let tt = '';
    for (const until = Date.now() + 40000; Date.now() < until; ) { await q.waitForTimeout(1000); tt = await q.evaluate(() => window.liveChart.deltaPane().title); if (/ since /.test(tt)) break; }
    const mm = / \(page opened\), missed (\d+) s$/.exec(tt), lg = (await q.textContent('#lgDelta')).trim();
    check(!!mm && +mm[1] >= 3 && +mm[1] <= 5 && / missed \d+ s /.test(lg + ' '), 'to 15s with ChartBridge holding the trades 3 s: "' + tt + '", legend "' + lg + '"');
    await c.close(); b.kill();
  }
  {
    /* round 6 (review 5 B1): a ChartBridge restart; the count goes on, and the label says how long it missed */
    const o = offsetTo(13, 0, 0, weekday);
    const b1 = await startBridge(o, ['--quote-hours=0']);
    const c = await context(o, 'm5');
    const q = await openPage(c, `http://localhost:${b1.port}/live/single.html`);
    await q.waitForTimeout(3000);
    const before = await q.evaluate(() => { const x = window.liveChart.getDelta().sessions.at(-1); return { title: window.liveChart.deltaPane().title, from: x.from, n: x.trades }; });
    const downAt = Date.now();
    b1.kill();
    await q.waitForTimeout(8000);
    const b2 = await bridgeOn(b1.port, o, ['--quote-hours=0']);
    await live(q); await q.waitForTimeout(2000);
    const down = (Date.now() - downAt) / 1000;
    const after = await q.evaluate(() => new Promise(res => requestAnimationFrame(() => {
      const x = window.liveChart.getDelta().sessions.at(-1);
      let bb = 0, ss = 0, n = 0; for (const [t, , v, sd] of window.__live) if (t >= x.from) { n++; if (sd === 1) bb += v; else if (sd === -1) ss += v; }
      res({ title: window.liveChart.deltaPane().title, from: x.from, n: x.trades, buy: x.buy, sell: x.sell, got: [bb, ss, n] });
    })));
    const mm = / \(page opened\), missed (\d+) s$/.exec(after.title);
    check(after.from === before.from && after.n > before.n && after.buy === after.got[0] && after.sell === after.got[1] && after.n === after.got[2],
      'a ChartBridge restart: the same count from ' + U.fmtExact(after.from) + ', every live trade before and after it (' + before.n + ' then ' + after.n + ')');
    check(!!mm && +mm[1] >= 8 && +mm[1] <= down + 2, 'and the label says what it missed (down about ' + Math.round(down) + ' s): "' + after.title + '"');
    await c.close(); b2.kill();
  }
  {
    /* scenario C (review 2 S1): the PC's clock 10 s behind the exchange; a 1m view with no tick backfill goes live at
       about 17:59:52 by the PC's clock, 18:00:02 by the exchange's: the trades of 18:00:00 to then never come */
    let done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      const o = offsetTo(17, 59, 52, weekdayEve);
      const b = await startBridge(o + 10, ['--cme-hours', '--pc-clock-offset=' + o]);
      const c = await context(o, 'm1', '', { cmeBreak: true });
      const q = await openPage(c, `http://localhost:${b.port}/live/single.html`);
      const liveAt = U.zoneSeconds((await q.evaluate(() => window.__readyAt)));
      const s18 = Math.ceil(liveAt / 86400) * 86400 - 6 * 3600;
      if (!(liveAt >= s18 - 10 && liveAt + 5 <= s18)) { console.log('  info C: live at ' + U.fmtExact(liveAt) + ' by the PC clock, outside 17:59:50 to 17:59:55; again'); await c.close(); b.kill(); continue; }
      done = true;
      const early = await newest(q);
      check(!/^Cumulative delta [+-]?\d[\d,]*$/.test(early.title), 'C: live at ' + U.fmtExact(liveAt) + ' by the PC clock (the old rule took it as live before 18:00): at once "' + early.title + '"');
      const endAt = Date.now() + 90000;
      let r = early;
      while (Date.now() < endAt) { await q.waitForTimeout(1000); r = await newest(q); if (r.ses && r.ses.n > 20 && r.ses.start === s18) break; }
      check(r.first > s18 + 0.5 && !!r.ses && r.ses.partial && r.ses.from === s18 + 60 && r.ses.firstOpen === 0 && r.ses.buy === r.got.b && r.ses.sell === r.got.s && r.ses.n === r.got.n,
        'C: the first trade received at ' + U.fmtExact(r.first) + ' (the open\'s first seconds never came): counts from ' + U.fmtExact(r.ses && r.ses.from) + ', the first complete bar, every trade from it: ' + JSON.stringify([r.ses, r.got]));
      check(r.title.endsWith(' since 18:01 ET (page opened)'), 'C: labelled, never a count from 18:00: "' + r.title + '"');
      await shot(q, 'delta-clock-behind.png', 'The PC clock 10 s behind: labelled');
      await c.close(); b.kill();
    }
    check(done, 'C: the page went live in the window where the clock matters');
  }

  /* ---------------- 18:00 ET: a new session starts at 0 (the clock set to 17:59:35 on a Monday to Thursday) */
  {
    const o = offsetTo(17, 59, 35, monToThu);
    const b7 = await startBridge(o);
    const c7 = await context(o, 's15');
    const q = await openPage(c7, `http://localhost:${b7.port}/live/single.html`);
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
    // the title and the value read together after a drawn frame, in one task, so no live trade lands between (review 2 N1)
    const tv = await q.evaluate(() => new Promise(res => requestAnimationFrame(() => res({ title: window.liveChart.deltaPane().title, last: window.liveChart.getDelta().sessions.at(-1), close: window.liveChart.getDelta().last.c }))));
    check(tv.title === 'Cumulative delta ' + U.fmtSigned(tv.close, 0) && tv.last.start === sN.start, 'the pane shows the new session\'s value: "' + tv.title + '" (' + tv.close + ')');
    await shot(q, 'delta-rollover-1800.png', 'The 18:00 ET session start (clock set to 17:59:35)');
    await c7.close(); b7.kill();
  }
} finally {
  await browser.close();
  for (const b of bridges) b.kill();
}

if (errors.length) { console.error('FAIL (' + errors.length + ' of ' + checks + ' checks)\n' + errors.join('\n')); process.exit(1); }
console.log('delta smoke: ok (' + checks + ' checks; screenshots in ' + SHOTS + ')');
