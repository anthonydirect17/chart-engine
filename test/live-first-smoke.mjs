// 1.8.0 smoke: the served window and the session table (ChartBridge 0.3.5) on a mounted chart with its own toolbar
// (test/chart-host.html; the single chart page until chart 1.21.0) against the fake bridge's tape
// (sample data only, never market data). The market trades on during every load (150 trades a second, bursts of 450).
//   npm run smoke:live-first      (CHROMIUM_PATH=/path/to/chrome for a preinstalled browser; SHOTS=dir for the screenshots)
// Checks, on NQ Range 40 at 10:45 ET on a weekday: the subscribe asks for the served window and the profile; the page's
// trades start 2 h back and are the tape's, trade by trade; the range bars shown are exactly those of a build from the
// session's first trade (price, volume and VWAP), from the first proven bar on, and none before it; the volume profile
// equals the tape's volume at every price, for the session and for RTH. A reload and a second page get the same window
// from ChartBridge's memory (NinjaTrader asked once) and draw the same first bar. A 1m page gets the exact profile with no
// tick history. A table still building: the note "building, from HH:MM ET" and no VWAP on range bars, then the pushed
// profile makes both exact. A quiet market: no range bar until one is proven,
// with a note. The Sunday 18:00 open. The 18:00 rollover on an open page, and a reload after it. An old bridge: a full load.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { C as H, hostUrl, waitLive } from './chart-host.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const U = require('../src/chart-engine.js').util;
const SHOTS = path.resolve(process.env.SHOTS || path.join(root, 'test', 'out'));
fs.mkdirSync(SHOTS, { recursive: true });
const BASE_PORT = +(process.env.LIVE_FIRST_SMOKE_PORT || 8851);
const errors = [];
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { if (!ok) fail(m); else console.log('  ok   ' + m); };
const note = m => console.log('       ' + m);

/* Seconds to add to the real clock to stand at hh:mm:ss New York time on the most recent day passing `want(bar time)`. */
function offsetWhere(hh, mm, ss, want) {
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
const weekday = bt => U.rthDay(bt);                                        // a day with a stock market session
const midWeek = bt => U.rthDay(bt) && U.rthDay(bt + 86400) && new Date(bt * 1000).getUTCDay() < 5;   // Mon to Thu: a session follows at 18:00
const sunday = bt => new Date(bt * 1000).getUTCDay() === 0;

let port = BASE_PORT;
async function startBridge(offset, extra) {
  for (let tries = 0; tries < 6; tries++, port++) {
    const p = port;
    const b = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(p), '--pin-off', '--test-controls', '--clock-offset=' + offset].concat(extra), { stdio: ['ignore', 'pipe', 'pipe'] });
    let errText = '';
    b.stderr.on('data', d => { errText += d; });
    const ok = await new Promise(res => { b.stdout.once('data', () => res(true)); b.once('exit', () => res(false)); });
    if (ok) { port++; return { port: p, kill: () => b.kill() }; }
    if (!/EADDRINUSE/.test(errText)) throw new Error('bridge failed: ' + errText);
  }
  throw new Error('no free port from ' + BASE_PORT);
}
const control = (p, what, q) => fetch(`http://localhost:${p}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' }).then(r => r.json());

/* A context on the fake's clock, recording what the page sends and the profile messages it gets. */
async function context(browser, offset, settings, ranges) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
  await ctx.addInitScript(() => { setInterval(() => { const b = document.querySelector('.nostop-ask:not([hidden]) .nostop-send'); if (b) b.click(); }, 30); });   // 1.13.0: answers the one NO STOP question with Send
  await ctx.addInitScript(`(() => {
    const realNow = Date.now; Date.now = () => realNow() + ${offset * 1000};
    try {
      if (!localStorage.getItem('live-settings-v2')) localStorage.setItem('live-settings-v2', ${JSON.stringify(JSON.stringify(settings))});
      if (!localStorage.getItem('live-range-v2')) localStorage.setItem('live-range-v2', ${JSON.stringify(JSON.stringify(ranges || { NQ: 40 }))});
    } catch (e) {}
    const R = window.__rec = { sent: [], profiles: 0 };
    const d = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (x) { try { R.sent.push(JSON.parse(x)); } catch (e) {} return send.apply(this, arguments); };
    Object.defineProperty(WebSocket.prototype, 'onmessage', { configurable: true, get() { return d.get.call(this); }, set(fn) {
      d.set.call(this, ev => { if (typeof ev.data === 'string' && ev.data.startsWith('{"type":"profile"')) R.profiles++; return fn(ev); });
    } });
  })();`);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  return ctx;
}
const live = p => waitLive(p, 30000);
async function openPage(ctx, url) {
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fail('console: ' + m.text()); });
  await p.goto(url);
  await live(p);
  return p;
}
const subscribes = p => p.evaluate(() => window.__rec.sent.filter(m => m.type === 'subscribe'));
async function profileOn(p, rth) {
  await p.click(H('indBtn'));
  if (!(await p.evaluate(() => window.liveChart.getLayers().vp))) { await p.fill(H('indQ'), 'profile'); await p.keyboard.press('Enter'); await p.fill(H('indQ'), ''); }
  await p.click(H('indBody') + ' [data-act="gear"][data-id="vp"]');
  await p.click(`${H('indBody')} [data-act="opt"][data-id="vp"][data-v="${rth ? 'rth' : 'full'}"]`);
  await p.keyboard.press('Escape');
}
/* Hold the market so the page and the tape can be compared at rest. */
async function hold(p, br, on) { await control(br.port, 'hold', { root: 'NQ', on: on ? '1' : '0' }); if (on) await p.waitForTimeout(400); }

/*
 * Everything the page shows against the fake's tape, in the page (the tape can be millions of trades): the store trade by
 * trade from its first; the range bars shown (or the seconds bars) against a build of the tape from the first trade of the
 * session holding the store's first trade, OHLC, volume and VWAP (bars of the current session); the volume profile at every
 * price against the tape's trades from the profile's start.
 */
const exact = (p, br) => p.evaluate(async pt => {
  const D = window.liveData(), BB = window.BarBuilder, CE = window.ChartEngine, U = CE.util, S = D.ticks;
  const now = U.zoneSeconds(Date.now() / 1000), SS = 18 * 3600;
  const sessionOf = t => (U.tradeDay(t, SS) - 1) * 86400 + SS;
  const from = S.length ? Math.min(sessionOf(S.time(0)), sessionOf(now)) : sessionOf(now);
  // what the page shows, taken in one go before any await (live trades can still arrive while the tape is fetched)
  const shown = window.liveChart.bars().map(b => Object.assign({}, b)), vp = window.liveChart.getProfile && window.liveChart.getProfile();
  const vpRows = vp ? vp.rows().filter(r => r.volume > 0) : null, vpStart = vp ? vp.startOf(now) : 0, vpRth = vp ? vp.rth : false, vpTotal = vp ? vp.total : 0;
  const nStore = S.length, cur = D.cur ? { mode: D.cur.mode, rangeTicks: D.cur.rangeTicks, rangeMode: D.cur.rangeMode, tick: D.cur.tick, seconds: D.cur.seconds } : null;
  const tape = await (await fetch(`http://localhost:${pt}/test/tape?root=${D.root}&from=${from}`, { method: 'POST' })).json();
  const out = { n: nStore, first: S.length ? S.time(0) : null, now };
  // the store against the tape
  let off = 0; while (off < tape.n && tape.t[off] < out.first) off++;
  out.storeBad = -1;
  for (let i = 0; i < nStore && out.storeBad < 0; i++) if (S.time(i) !== tape.t[off + i] || S.price(i) !== tape.p[off + i] || S.volume(i) !== tape.v[off + i]) out.storeBad = i;
  const end = off + nStore;                                     // the tape up to the store's last trade
  // bars
  out.bars = shown.length;
  out.firstBar = shown.length ? shown[0].t : null;
  if (cur && shown.length) {
    const b0 = cur;
    const full = b0.mode === 'range' ? new BB.BarBuilder({ mode: 'range', rangeTicks: b0.rangeTicks, rangeMode: b0.rangeMode, tick: b0.tick, sessionStart: SS })
      : new BB.BarBuilder({ mode: 'time', seconds: b0.seconds, tick: b0.tick, sessionStart: SS });
    for (let j = 0; j < end; j++) full.addQuiet(tape.t[j], tape.p[j], tape.v[j]);
    const k = full.bars.findIndex(b => b.t === shown[0].t);
    out.barsBad = k < 0 ? 'no full bar at ' + shown[0].t : null;
    const day = U.tradeDay(now, SS);
    out.vwBars = 0;
    for (let i = 0; i < shown.length && !out.barsBad; i++) {
      const a = shown[i], b = full.bars[k + i];
      if (!b || a.t !== b.t || a.o !== b.o || a.h !== b.h || a.l !== b.l || a.c !== b.c || a.v !== b.v) out.barsBad = 'bar ' + i + ': ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b);
      else if (U.tradeDay(a.t, SS) === day && a.vw !== null && a.vw !== undefined) { out.vwBars++; if (Math.abs(a.vw - b.vw) > 1e-6) out.barsBad = 'VWAP of bar ' + i + ': ' + a.vw + ' vs ' + b.vw; }
    }
    out.fullBars = full.bars.length - k;
    out.vwNull = shown.filter(b => U.tradeDay(b.t, SS) === day && (b.vw === null || b.vw === undefined)).length;
  }
  // the profile
  if (vp) {
    const start = vpStart, want = new Map();
    for (let j = 0; j < end; j++) if (tape.t[j] >= start && (!vpRth || vp.inRth(tape.t[j]))) { const q = Math.round(tape.p[j] / D.tick); want.set(q, (want.get(q) || 0) + tape.v[j]); }
    const got = new Map(vpRows.map(r => [Math.round(r.price / D.tick), r.volume]));
    let bad = got.size === want.size ? null : 'rows ' + got.size + ' vs ' + want.size;
    for (const [q, v] of want) if (!bad && got.get(q) !== v) bad = 'price ' + q * D.tick + ': ' + got.get(q) + ' vs ' + v;
    out.vp = { rth: vpRth, total: vpTotal, rows: got.size, bad };
  }
  out.vpNote = document.querySelector('[id$="-vpNote"]').hidden ? '' : document.querySelector('[id$="-vpNote"]').textContent;
  out.rangeNote = document.querySelector('[id$="-rangeNote"]').hidden ? '' : document.querySelector('[id$="-rangeNote"]').textContent;
  const vwLast = window.liveChart.bars().length ? window.liveChart.vwapAt(window.liveChart.bars().length - 1) : null;
  out.legendVw = vwLast === null ? '-' : U.fmtPrice(vwLast, 2);           // the chart's VWAP at its last bar (the legend's, until 1.16.0)
  return out;
}, br.port);
const books = br => control(br.port, 'books');
const hm = t => U.fmtHM(t);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  /* ---------------- NQ Range 40 at 10:45 ET in a busy market */
  {
    console.log('NQ Range 40 at 10:45 ET, busy market');
    const off = offsetWhere(10, 45, 0, weekday);
    const br = await startBridge(off, ['--live-first', '--tick-rate=4', '--live-rate=150', '--window-ms=300']);
    const ctx = await context(browser, off, { root: 'NQ', tf: 'range', glide: 'smooth', rangeMode: 'nt' });
    const t0 = Date.now();
    const p = await openPage(ctx, hostUrl(br.port));
    note('live ' + (Date.now() - t0) + ' ms after opening the page');
    const sub = (await subscribes(p))[0];
    check(sub.liveFirst === true && sub.profile === true && sub.sub > 0 && sub.tickHours > 0, 'the subscribe asks for the served window and the profile: ' + JSON.stringify(sub));
    await profileOn(p, false);
    await hold(p, br, true);
    const a = await exact(p, br);
    check(a.first >= a.now - 2 * 3600 - 5 && a.first < a.now - 2 * 3600 + 60, 'the trades start 2 h back: ' + hm(a.first) + ' ET (' + a.n.toLocaleString() + ' trades)');
    check(a.storeBad < 0, 'every trade of the tape from there, once and in order (' + a.n + ')');
    check(a.bars > 20 && !a.barsBad && a.vwBars === a.bars, 'the range bars from the first proven one (' + hm(a.firstBar) + ' ET, ' + a.bars + ' bars) are a full build\'s from 18:00, price, volume and VWAP' + (a.barsBad ? ': ' + a.barsBad : ''));
    check(a.vp && !a.vp.rth && !a.vp.bad && a.vp.total > 0 && !a.vpNote, 'the session profile equals the tape at every price (' + (a.vp && a.vp.rows) + ' rows, ' + (a.vp && a.vp.total) + ' contracts)' + (a.vp && a.vp.bad ? ': ' + a.vp.bad : ''));
    await p.screenshot({ path: path.join(SHOTS, 'live-first-range40.png') });
    await hold(p, br, false);
    await profileOn(p, true);
    await p.waitForTimeout(1500);                                  // live trades into the profile
    await hold(p, br, true);
    const r = await exact(p, br);
    check(r.vp && r.vp.rth && !r.vp.bad && r.vp.total > 0 && r.vp.total < a.vp.total + 100000, 'RTH: equal to the tape\'s trades from 9:30 at every price, with live trades added (' + (r.vp && r.vp.total) + ')' + (r.vp && r.vp.bad ? ': ' + r.vp.bad : ''));
    check(!r.barsBad && r.firstBar === a.firstBar, 'the range bars still exact after live trades, from the same first bar');
    await profileOn(p, false);
    let b = await books(br);
    check(b.NQ.asked === 1 && b.NQ.served === 0, 'NinjaTrader asked once for the window (' + JSON.stringify(b.NQ) + ')');
    await hold(p, br, false);
    // the delta pane (1.7.0) counts live trades from the page's open; the served window's trades carry no side
    const d0 = await p.evaluate(() => { const D = window.liveData(); return { on: !!D.delta, by: D.deltaCov && D.deltaCov.by }; });
    check(d0.on && (d0.by === 'live' || d0.by === 'first'), 'the delta pane counts from the page\'s open (' + JSON.stringify(d0) + ')');
    // a reload: from the served window
    await p.reload(); await live(p);
    await hold(p, br, true);
    const c = await exact(p, br);
    b = await books(br);
    check(b.NQ.asked === 1 && b.NQ.served === 1 && c.first === a.first, 'reload: the same window from ChartBridge\'s memory (' + JSON.stringify(b.NQ) + '), first trade ' + hm(c.first) + ' ET');
    check(c.firstBar === a.firstBar && !c.barsBad && c.bars >= a.bars && c.storeBad < 0, 'reload: the bars start where they started (' + hm(c.firstBar) + ' ET) and are exact (' + c.bars + ' bars)');
    check(c.vp && !c.vp.bad, 'reload: the profile is exact');
    await p.waitForFunction(() => { const D = window.liveData(); return !!D.delta; }, null, { timeout: 10000 }).catch(() => {});
    const d1 = await p.evaluate(() => { const D = window.liveData(); return { on: !!D.delta, by: D.deltaCov && D.deltaCov.by }; });
    check(d1.on && (d1.by === 'live' || d1.by === 'first'), 'reload from memory: the delta pane counts again from the reload (a page reload is a new page: ' + JSON.stringify(d1) + ')');
    // a second page
    const p2 = await openPage(ctx, hostUrl(br.port));
    const d = await exact(p2, br);
    b = await books(br);
    check(b.NQ.asked === 1 && b.NQ.served === 2 && d.firstBar === a.firstBar && !d.barsBad, 'a second page: from memory too, the same first bar (' + JSON.stringify(b.NQ) + ')');
    await p2.close();
    // a ChartBridge reconnect: the page subscribes again and is served from ChartBridge's memory; for the delta pane that is
    // a later load of the same instrument, so its count (and "missed N s") carries on
    await control(br.port, 'drop');
    await p.waitForTimeout(300); await live(p);
    await p.waitForFunction(() => { const D = window.liveData(); return !!D.delta && D.deltaCov && D.deltaCov.journal === true; }, null, { timeout: 10000 }).catch(() => {});
    const d2 = await p.evaluate(() => { const D = window.liveData(); return { on: !!D.delta, journal: !!(D.deltaCov && D.deltaCov.journal) }; });
    b = await books(br);
    check(d2.on && d2.journal && b.NQ.asked === 1, 'a reconnect served from memory (NinjaTrader not asked) is a later load for the delta: its count carries on (' + JSON.stringify(d2) + ')');
    // a 15s view from the same window (no load), bars from the first whole one, with VWAP
    const subs0 = (await subscribes(p)).length;
    await p.click(H('tfSeg') + ' [data-v="s15"]');
    await p.waitForTimeout(300);
    const s = await exact(p, br);
    check((await subscribes(p)).length === subs0 && s.bars > 100 && !s.barsBad && s.firstBar > s.first && s.firstBar - s.first <= 15 && s.vwBars === s.bars, '15s: no new load, bars from the first whole one (' + hm(s.firstBar) + ' ET), exact with VWAP' + (s.barsBad ? ': ' + s.barsBad : ''));
    await hold(p, br, false);
    await ctx.close();
    // a 1m page: the profile from the table, no tick history
    const ctx2 = await context(browser, off, { root: 'NQ', tf: 'm1', glide: 'smooth', rangeMode: 'nt' });
    const m = await openPage(ctx2, hostUrl(br.port));
    await profileOn(m, false);
    await hold(m, br, true);
    const e = await exact(m, br);
    const ms = await subscribes(m);
    check(ms.length === 1 && ms[0].tickHours === 0 && !ms[0].liveFirst && ms[0].profile === true && e.n < 5000, '1m: no tick history asked (' + JSON.stringify(ms[0]) + ', ' + e.n + ' live trades held)');
    check(e.vp && !e.vp.bad && e.vp.total > 0 && !e.vpNote, '1m: the session profile equals the tape at every price, no note (' + (e.vp && e.vp.total) + ')' + (e.vp && e.vp.bad ? ': ' + e.vp.bad : ''));
    await m.screenshot({ path: path.join(SHOTS, 'live-first-1m-profile.png') });
    await ctx2.close();
    br.kill();
  }

  /* ---------------- the table still building (ChartBridge started mid-session), and an order during a Range load */
  {
    console.log('A table still building; Range loads');
    const off = offsetWhere(10, 45, 0, weekday);
    const br = await startBridge(off, ['--live-first', '--tick-rate=2', '--live-rate=150', '--window-ms=1500', '--table-building=9000', '--profile-roots=NQ,MNQ', '--trading', '--trade-accounts=Sim101', '--max-qty=NQ:2']);
    const ctx = await context(browser, off, { root: 'NQ', tf: 'm1', glide: 'smooth', rangeMode: 'nt' });
    const p = await openPage(ctx, hostUrl(br.port));
    await profileOn(p, false);
    await hold(p, br, true);
    const a = await exact(p, br);
    check(/^Volume profile building, from \d+:\d\d ET/.test(a.vpNote), 'the note: "' + a.vpNote + '"');
    await hold(p, br, false);
    // Range: a new window load (1.5 s). (Until 1.21.0 a market order on the single chart page's order bar was checked to
    // fill during it; the workspace's ticket never waits on a chart's load.)
    await p.click(H('tfSeg') + ' [data-v="range"]');
    const pill = await p.evaluate(() => document.querySelector('[id$="-badge"]').dataset.conn);
    check(pill === 'loading', 'Range on: a new window load (the badge says ' + pill + ')');
    await live(p);
    await hold(p, br, true);
    const r = await exact(p, br);
    check(r.bars > 0 && !r.barsBad && r.vwBars === 0 && r.legendVw === '-', 'range bars exact, without VWAP while the table builds (the chart\'s VWAP "' + r.legendVw + '")' + (r.barsBad ? ': ' + r.barsBad : ''));
    await hold(p, br, false);
    await p.waitForFunction(() => window.__rec.profiles >= 3, null, { timeout: 15000 }).catch(() => {});
    await hold(p, br, true);
    const w = await exact(p, br);
    check(!w.vpNote && w.vp && !w.vp.bad && w.vp.total > a.vp.total * 3, 'the backfill\'s profile: whole, equal to the tape at every price (' + (w.vp && w.vp.total) + '), the note gone' + (w.vp && w.vp.bad ? ': ' + w.vp.bad : ''));
    check(!w.barsBad && w.vwBars === w.bars && w.bars > 0, 'and the range bars get their VWAP, equal to a full build\'s (' + w.bars + ' bars)' + (w.barsBad ? ': ' + w.barsBad : ''));
    const b = await books(br);
    check(b.NQ.pushed >= 1 && b.NQ.asked === 1, 'pushed to the live page (' + JSON.stringify(b.NQ) + ')');
    await hold(p, br, false);
    // an instrument not in profileRoots: no backfill, the profile counts from the live trades, and says since when
    const ctxE = await context(browser, off, { root: 'MES', tf: 'm1', glide: 'smooth', rangeMode: 'nt' });
    const e = await openPage(ctxE, hostUrl(br.port));
    await profileOn(e, false);
    const en = await e.evaluate(() => document.querySelector('[id$="-vpNote"]').hidden ? '' : document.querySelector('[id$="-vpNote"]').textContent);
    check(/^Volume profile since \d+:\d\d ET: .*not in its profileRoots/.test(en), 'MES, not in profileRoots: "' + en + '"');
    await ctxE.close();
    // a data connection drop: the live page says the profile is missing trades, and so does a reload
    await control(br.port, 'feed-drop');
    await p.waitForTimeout(400);
    const dn = await p.evaluate(() => document.querySelector('[id$="-vpNote"]').textContent);
    await p.reload(); await live(p);
    const dn2 = await p.evaluate(() => document.querySelector('[id$="-vpNote"]').hidden ? '' : document.querySelector('[id$="-vpNote"]').textContent);
    check(/^Volume profile missing trades: the data connection was down at \d+:\d\d ET/.test(dn) && dn2 === dn, 'a feed drop: "' + dn + '", and the same after a reload (never whole again)');
    const vwn = await p.evaluate(() => { const n = document.querySelector('[id$="-rangeNote"]'), c = window.liveChart, v = c.bars().length ? c.vwapAt(c.bars().length - 1) : null;
      return { note: n.hidden ? '' : n.textContent, vw: v === null ? '-' : v.toFixed(2) }; });
    check(/^VWAP and range bars after \d+:\d\d ET miss the trades while the data connection was down/.test(vwn.note) && vwn.vw !== '-', 'review 3 S-C: after the drop the range VWAP stays (' + vwn.vw + ') and says what it misses: "' + vwn.note + '"');
    await ctx.close();
    br.kill();
  }

  /* ---------------- a quiet market: no range bar before one is proven */
  {
    console.log('A quiet market (window of 72 s, Range 200)');
    const off = offsetWhere(10, 45, 0, weekday);
    const br = await startBridge(off, ['--live-first', '--range-hours=0.02', '--window-ms=100']);
    await control(br.port, 'hold', { root: 'NQ' });
    const ctx = await context(browser, off, { root: 'NQ', tf: 'range', glide: 'smooth', rangeMode: 'nt' }, { NQ: 200 });
    const p = await openPage(ctx, hostUrl(br.port));
    await p.waitForTimeout(600);
    const a = await exact(p, br);
    check(a.bars === 0 && /^Range bars start where they are proven/.test(a.rangeNote), 'no range bar yet, and the note: "' + a.rangeNote + '"');
    const last = (await control(br.port, 'state', { root: 'NQ' })).last;
    await control(br.port, 'price', { root: 'NQ', p: last + 60 });
    await control(br.port, 'price', { root: 'NQ', p: last + 5 });
    await p.waitForTimeout(400);
    const c = await exact(p, br);
    check(c.bars > 0 && !c.barsBad && !c.rangeNote, 'after a swing of more than the range each way: ' + c.bars + ' bars, exact, the note gone' + (c.barsBad ? ': ' + c.barsBad : ''));
    await ctx.close();
    br.kill();
  }

  /* ---------------- the Sunday 18:00 open */
  {
    console.log('Sunday 18:05 ET, the open');
    const off = offsetWhere(18, 5, 0, sunday);
    const br = await startBridge(off, ['--live-first', '--calendar', '--live-rate=100']);
    const ctx = await context(browser, off, { root: 'NQ', tf: 'range', glide: 'smooth', rangeMode: 'nt' });
    const p = await openPage(ctx, hostUrl(br.port));
    await profileOn(p, false);
    await hold(p, br, true);
    const a = await exact(p, br);
    const S0 = (U.tradeDay(a.now, 64800) - 1) * 86400 + 64800;
    check(a.first >= S0 && a.first < S0 + 60 && a.firstBar === a.first && !a.barsBad && a.vwBars === a.bars, 'bars from the session\'s first trade (' + hm(a.firstBar) + ' ET), exact with VWAP' + (a.barsBad ? ': ' + a.barsBad : ''));
    check(a.vp && !a.vp.bad && !a.vpNote, 'the profile of the new session equals the tape (' + (a.vp && a.vp.total) + ')');
    await ctx.close();
    br.kill();
  }

  /* ---------------- the 18:00 rollover on an open page, and a reload after it */
  {
    console.log('18:00 ET rollover on an open page');
    const off = offsetWhere(17, 59, 48, midWeek);
    const br = await startBridge(off, ['--live-first', '--calendar', '--live-rate=100']);
    const ctx = await context(browser, off, { root: 'NQ', tf: 'range', glide: 'smooth', rangeMode: 'nt' });
    const p = await openPage(ctx, hostUrl(br.port));
    await profileOn(p, false);
    await p.waitForFunction(() => window.ChartEngine.util.zoneSeconds(Date.now() / 1000) % 86400 > 64803, null, { timeout: 30000, polling: 200 });
    await hold(p, br, true);
    const a = await exact(p, br);
    check(a.vp && !a.vp.bad && a.vp.total > 0 && !a.vpNote, 'after 18:00 the profile is the new session\'s, equal to the tape (' + (a.vp && a.vp.total) + ')');
    check(!a.barsBad && a.bars > 0, 'the range bars across 18:00 are exact (' + a.bars + ' bars)' + (a.barsBad ? ': ' + a.barsBad : ''));
    await hold(p, br, false);
    await p.reload(); await live(p);
    const b = await books(br);
    check(b.NQ.asked === 2, 'a reload after 18:00 asks NinjaTrader again: the served window was dropped at the session change (' + JSON.stringify(b.NQ) + ')');
    await hold(p, br, true);
    const c = await exact(p, br);
    check(!c.barsBad && c.bars > 0 && c.vp && !c.vp.bad, 'and the reloaded page is exact');
    await ctx.close();
    br.kill();
  }

  /* ---------------- an old bridge (no features in hello): the full load of 1.6.0 */
  {
    console.log('An old bridge');
    const off = offsetWhere(10, 45, 0, weekday);
    const br = await startBridge(off, ['--live-first', '--live-rate=100']);
    await control(br.port, 'features', { liveFirst: '0' });
    const ctx = await context(browser, off, { root: 'NQ', tf: 'range', glide: 'smooth', rangeMode: 'nt' });
    const p = await openPage(ctx, hostUrl(br.port));
    await profileOn(p, false);
    await hold(p, br, true);
    const a = await exact(p, br);
    const sub = (await subscribes(p))[0];
    check(sub.liveFirst === undefined && sub.profile === undefined && sub.sub === undefined && sub.tickHours >= 17 && a.first < a.now - 16 * 3600, 'a full load as before (' + JSON.stringify(sub) + ', trades from ' + hm(a.first) + ' ET)');
    check(!a.barsBad && a.vp && !a.vp.bad && (await p.evaluate(() => window.__rec.profiles)) === 0, 'bars and profile exact from the store, no profile message');
    await ctx.close();
    br.kill();
  }
} finally {
  await browser.close();
}
if (errors.length) { console.error('\n' + errors.length + ' failed'); process.exit(1); }
console.log('\nlive-first smoke: all passed');
