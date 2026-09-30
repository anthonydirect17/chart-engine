// 1.8.0 smoke: live first (ChartBridge 0.3.5) on the real page against the fake bridge's tape (sample data only, never
// market data). The fake answers the recent window after 300 ms and the whole window 1.2 s after ready, while the market
// trades on (150 trades a second, bursts of 450), so live trades arrive during the load and during the older history.
//   npm run smoke:live-first      (CHROMIUM_PATH=/path/to/chrome for a preinstalled browser; SHOTS=dir for the screenshots)
// Checks, on NQ Range 40 at 10:45 ET on a weekday: time to live against a full load of the same tape; orders work at
// ready, before the history is in; the progress line in the status bar, clear of the order bar; range bars shown only
// from their proven point (or 1m bars until then), and none of them moves when the whole history is in; every trade of the
// tape once and in order (the page's store against the tape), with the tape's sides; the live trades' delay while the
// history comes; range, 15s and 1m bars, VWAP and the Initial balance equal a full load's (a second tab, the feature off).
// Then a 1m view with the volume profile on: it asks for ticks back to 18:00 (RTH: 9:30), the profile fills in and equals
// the tape's volume. Then a resubscribe in the middle of the history (15s to Range): nothing of the older load mixes in.
// Then an old bridge (no liveFirst in hello): a full load as before.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

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

/* Seconds to add to the real clock to stand at hh:mm New York time on the most recent weekday with a session. */
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
const bridges = [];
async function startBridge(offset, extra) {
  for (let tries = 0; tries < 6; tries++, port++) {
    const p = port;
    const b = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(p), '--pin-off', '--test-controls', '--clock-offset=' + offset].concat(extra), { stdio: ['ignore', 'pipe', 'pipe'] });
    let errText = '';
    b.stderr.on('data', d => { errText += d; });
    const ok = await new Promise(res => { b.stdout.once('data', () => res(true)); b.once('exit', () => res(false)); });
    if (ok) { port++; bridges.push(b); return { port: p, kill: () => b.kill() }; }
    if (!/EADDRINUSE/.test(errText)) throw new Error('bridge failed: ' + errText);
  }
  throw new Error('no free port from ' + BASE_PORT);
}
const control = (p, what, q) => fetch(`http://localhost:${p}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' }).then(r => r.json());

/* A context on the fake's clock. Records every trade the page receives for `rec` (with sides), what it sends, and times. */
async function context(browser, offset, settings, extra) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
  await ctx.addInitScript(`(() => {
    const realNow = Date.now; Date.now = () => realNow() + ${offset * 1000};
    try {
      if (!localStorage.getItem('live-settings-v2')) localStorage.setItem('live-settings-v2', ${JSON.stringify(JSON.stringify(settings))});
      if (!localStorage.getItem('live-range-v2')) localStorage.setItem('live-range-v2', JSON.stringify({ NQ: 40 }));
      ${extra || ''}
    } catch (e) {}
    const R = window.__rec = { trades: [], sent: [], subscribeAt: null, readyAt: null, doneAt: null, lagFill: [], lagQuiet: [], chunks: 0, chunkMs: [] };
    const d = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (x) { try { const m = JSON.parse(x); R.sent.push(m); if (m.type === 'subscribe') { R.subscribeAt = performance.now(); R.readyAt = null; R.doneAt = null; } } catch (e) {} return send.apply(this, arguments); };
    Object.defineProperty(WebSocket.prototype, 'onmessage', { configurable: true, get() { return d.get.call(this); }, set(fn) {
      d.set.call(this, ev => {
        if (typeof ev.data === 'string') {
          const m = ev.data.startsWith('{"type":"hello"') || ev.data.startsWith('{"type":"ready"') || ev.data.startsWith('{"type":"tick"') || ev.data.startsWith('{"type":"olderTicks"') ? JSON.parse(ev.data) : null;
          if (m && m.type === 'hello') R.trades.length = 0;
          if (m && m.type === 'ready') R.readyAt = performance.now();
          if (m && m.type === 'olderTicks') { R.chunks++; if (m.done) R.doneAt = performance.now(); const t0 = performance.now(); const r = fn(ev); R.chunkMs.push(performance.now() - t0); return r; }
          if (m && m.type === 'tick') { const lag = (performance.timeOrigin + performance.now()) - m.rx; (R.readyAt && !R.doneAt ? R.lagFill : R.lagQuiet).push(lag); }
        }
        return fn(ev);
      });
    } });
  })();`);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  return ctx;
}
const live = p => p.waitForFunction(() => document.getElementById('connPill') && document.getElementById('connPill').textContent === 'LIVE', null, { timeout: 30000 });
async function openPage(ctx, url) {
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fail('console: ' + m.text()); });
  await p.goto(url);
  await live(p);
  return p;
}
const fillDone = p => p.waitForFunction(() => { const D = window.liveData(); return D.fill && D.fill.done && !D.fill.rebuilding && !D.sync; }, null, { timeout: 60000, polling: 50 });
/* The page's store against the fake's tape, trade by trade (in the page, so millions stay there). */
const storeVsTape = (p, bridgePort, root) => p.evaluate(async ([pt, r]) => {
  const D = window.liveData(), s = D.ticks;
  const tape = await (await fetch(`http://localhost:${pt}/test/tape?root=${r}&from=${s.time(0)}`, { method: 'POST' })).json();
  let bad = -1;
  for (let i = 0; i < s.length && bad < 0; i++) if (s.time(i) !== tape.t[i] || s.price(i) !== tape.p[i] || s.volume(i) !== tape.v[i]) bad = i;
  return { n: s.length, tape: tape.n, bad, first: s.time(0) };
}, [bridgePort, root]);
const bars = p => p.evaluate(() => window.liveChart.bars().map(b => [b.t, b.o, b.h, b.l, b.c, b.v, b.vw === undefined ? null : Math.round(b.vw * 100) / 100]));
const q = (a, f) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  /* ---------------- NQ Range 40 at 10:45 ET: the WORK case, in a busy market */
  {
    const off = offsetTo(10, 45);
    const br = await startBridge(off, ['--live-first', '--tick-rate=4', '--live-rate=150', '--recent-ticks=30000', '--recent-ms=300', '--older-ms=1200', '--older-chunk=10000',
      '--trading', '--trade-accounts=Sim101', '--max-qty=NQ:2']);
    const ctx = await context(browser, off, { root: 'NQ', tf: 'range', glide: 'smooth', rangeMode: 'nt' }, '');
    const t0 = Date.now();
    const p = await openPage(ctx, `http://localhost:${br.port}/live/`);
    const liveMs = Date.now() - t0;
    const snap = await p.evaluate(() => ({ bars: window.liveChart.bars().map(b => [b.t, b.o, b.h, b.l, b.c, b.v]), vw: window.liveChart.bars().map(b => b.vw), fallback: window.liveData().fallback, done: window.liveData().fill.done }));
    const early = await p.evaluate(() => { const D = window.liveData(), R = window.__rec; return { fill: !!D.fill, done: D.fill && D.fill.done, n: D.ticks.length, ttl: R.readyAt - R.subscribeAt, sub: R.sent.find(m => m.type === 'subscribe'), sync: D.sync && D.sync.bar, fallback: D.fallback, note: document.getElementById('fillNote').textContent }; });
    check(early.fill && !early.done && early.sub.liveFirst === true && early.sub.sub > 0 && early.sub.tickHours >= 17, 'live first: subscribe asks for it (' + JSON.stringify(early.sub) + '), LIVE with the older history still to come (' + early.n + ' trades in)');
    note('time to live: ' + Math.round(early.ttl) + ' ms from subscribe to ready (' + liveMs + ' ms from opening the page)');
    check(/^History: loading /.test(early.note), 'the progress line: "' + early.note + '"');
    const layout = await p.evaluate(() => {
      const r = id => document.getElementById(id).getBoundingClientRect(), n = r('fillNote'), o = r('obar'), f = document.querySelector('footer.status').getBoundingClientRect(), c = r('chart');
      return { inFooter: n.top >= f.top - 1 && n.bottom <= f.bottom + 1, clearOfBar: n.bottom <= o.top || n.top >= o.bottom, clearOfChart: n.top >= c.bottom - 1 };
    });
    check(layout.inFooter && layout.clearOfBar && layout.clearOfChart, 'the progress line sits in the status bar, clear of the order bar and the chart (' + JSON.stringify(layout) + ')');
    check(early.fallback ? /\(1m until loaded\)/.test(await p.textContent('#lgTf')) : early.sync >= 0, early.fallback ? 'range bars not proven yet: 1m bars, and the legend says so' : 'range bars shown from their proven point (bar ' + early.sync + ' of the window\'s build)');
    await p.screenshot({ path: path.join(SHOTS, 'live-first-loading.png') });
    // orders at ready, before the history is in
    await p.waitForFunction(() => !document.getElementById('obar').hidden && !document.getElementById('buyMkt').disabled, null, { timeout: 10000 });
    await p.click('#armBtn');
    await p.click('#buyMkt');
    await p.waitForFunction(() => document.getElementById('oPos').textContent.startsWith('LONG 1'), null, { timeout: 5000 }).catch(() => {});
    const midFill = await p.evaluate(() => !window.liveData().fill.done);
    check((await p.textContent('#oPos')).startsWith('LONG 1'), 'orders work at ready: a market buy filled' + (midFill ? ' while the older history was still coming' : ''));
    await p.click('#flattenBtn');
    await p.waitForFunction(() => document.getElementById('oPos').textContent === 'Flat', null, { timeout: 5000 }).catch(() => {});
    check(await p.textContent('#oPos') === 'Flat', 'and flattened');
    await p.click('#armBtn');
    await fillDone(p);
    const R = await p.evaluate(() => { const r = window.__rec; return { ready: r.readyAt - r.subscribeAt, done: r.doneAt - r.subscribeAt, chunks: r.chunks, lagFill: r.lagFill, lagQuiet: r.lagQuiet, chunkMs: r.chunkMs }; });
    note('the page\'s own time per 10,000-trade chunk (parse, put in front, count): median ' + q(R.chunkMs, 0.5).toFixed(1) + ' ms, max ' + Math.max(0, ...R.chunkMs).toFixed(1) + ' ms');
    note('the older history: ' + R.chunks + ' chunks, all in ' + Math.round(R.done) + ' ms after the subscribe (the fake answers it 1.2 s after ready)');
    note('live trades while it came: ' + R.lagFill.length + ', delay to the page median ' + q(R.lagFill, 0.5).toFixed(1) + ' ms, p99 ' + q(R.lagFill, 0.99).toFixed(1) + ' ms, max ' + Math.max(0, ...R.lagFill).toFixed(1) + ' ms (otherwise p99 ' + q(R.lagQuiet, 0.99).toFixed(1) + ' ms)');
    check(R.lagFill.length > 20 && Math.max(...R.lagFill) < 1000, 'live trades keep coming during the older history, none held back a second (the 5 s rule is far off)');
    const after = await p.evaluate(() => window.liveChart.bars().map(b => [b.t, b.o, b.h, b.l, b.c, b.v]));
    const afterVw = new Map(await p.evaluate(() => window.liveChart.bars().map(b => [b.t, b.vw])));
    check(snap.vw.every(v => v === null) && [...afterVw.values()].every(v => typeof v === 'number'), 'no VWAP on the range bars until the history is in (so no VWAP line can jump), then every bar has it');
    if (!snap.fallback) {
      const byT = new Map(after.map(b => [b[0], b]));
      const moved = snap.bars.slice(0, -1).filter(b => JSON.stringify(byT.get(b[0])) !== JSON.stringify(b));
      check(!snap.done && snap.bars.length > 1 && moved.length === 0, 'no bar moved when the whole history came in: ' + (snap.bars.length - 1) + ' finished range bars shown before it, all the same after (' + after.length + ' bars now)' +
        (moved.length ? '; moved: ' + moved.slice(0, 3).map(b => JSON.stringify(b) + ' now ' + JSON.stringify(byT.get(b[0]))).join(' | ') : ''));
    } else note('the early view was 1m bars (no full swing yet), so there were no range bars to compare');
    check(!(await p.textContent('#fillNote')) && await p.isHidden('#fillNote'), 'the progress line is gone once the history is in');
    await p.screenshot({ path: path.join(SHOTS, 'live-first-loaded.png') });
    // stop the market, then every trade against the tape
    await control(br.port, 'hold', { root: 'NQ' });
    await p.waitForTimeout(600);
    const st = await storeVsTape(p, br.port, 'NQ');
    check(st.bad < 0 && st.n === st.tape, 'every trade of the tape once and in order: the page holds ' + st.n.toLocaleString() + ', the tape ' + st.tape.toLocaleString() + (st.bad >= 0 ? ' (first wrong at ' + st.bad + ')' : ''));
    // a full load of the same tape in a second tab (the feature off), and the two compared
    await control(br.port, 'features', { liveFirst: '0' });
    const t1 = Date.now();
    const pB = await openPage(ctx, `http://localhost:${br.port}/live/`);
    const fullMs = Date.now() - t1;
    const fullTtl = await pB.evaluate(() => window.__rec.readyAt - window.__rec.subscribeAt);
    check(await pB.evaluate(() => !window.liveData().fill && !window.__rec.sent.find(m => m.type === 'subscribe').liveFirst), 'the second tab: a full load (hello without the feature)');
    note('time to live of the full load of the same tape: ' + Math.round(fullTtl) + ' ms from subscribe to ready (' + fullMs + ' ms from opening), against ' + Math.round(early.ttl) + ' ms live first');
    const compare = async (tf, label) => {
      for (const pg of [p, pB]) { await pg.click(`#tfSeg [data-v="${tf}"]`); await pg.waitForTimeout(300); }
      const a = await bars(p), b = await bars(pB), from = Math.max(a[0][0], b[0][0]) + (tf === 'range' ? 0 : 60);
      const A = a.filter(x => x[0] >= from), B = b.filter(x => x[0] >= from);
      const vw = tf === 'range' || tf === 'm1';
      const strip = x => vw ? x : x.slice(0, 6);
      const same = A.length === B.length && A.every((x, i) => JSON.stringify(strip(x)) === JSON.stringify(strip(B[i])));
      check(same && A.length > 10, label + ': ' + A.length + ' bars identical to the full load\'s' + (vw ? ' (VWAP too)' : ' (OHLC and volume; each tab\'s seconds VWAP starts where its 8 hours start)') + (same ? '' : ' (' + A.length + ' vs ' + B.length + ')'));
    };
    await compare('range', 'Range 40 after the fill');
    await compare('s15', '15s');
    await compare('m1', '1m');
    const ib = pg => pg.evaluate(() => window.liveChart.getLevels().filter(l => /IB/.test(l.name)).map(l => l.name + ' ' + l.price).join(', '));
    const ibA = await ib(p), ibB = await ib(pB);
    check(!!ibA && ibA === ibB, 'the Initial balance is the full load\'s: ' + ibA);
    await pB.close();
    await p.close();
    await ctx.close();
    br.kill();
  }

  /* ---------------- sides: what the page receives, live first and full, against the tape */
  {
    const off = offsetTo(11, 10);
    const br = await startBridge(off, ['--live-first', '--tick-rate=2', '--live-rate=150', '--recent-ticks=20000', '--older-ms=800']);
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await ctx.addInitScript(`(() => {
      const realNow = Date.now; Date.now = () => realNow() + ${off * 1000};
      localStorage.setItem('live-settings-v2', JSON.stringify({ root: 'NQ', tf: 'range', glide: 'smooth', rangeMode: 'nt' }));
      const got = window.__sides = [];
      const d = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
      Object.defineProperty(WebSocket.prototype, 'onmessage', { configurable: true, get() { return d.get.call(this); }, set(fn) {
        d.set.call(this, ev => {
          if (typeof ev.data === 'string' && (ev.data.startsWith('{"type":"ticks"') || ev.data.startsWith('{"type":"olderTicks"') || ev.data.startsWith('{"type":"tick"'))) {
            const m = JSON.parse(ev.data);
            if (m.root === 'NQ') { if (m.type === 'tick') got.push([m.t, m.p, m.v, m.s, m.sm]); else got.push(...m.ticks.map(x => x.concat(m.type === 'olderTicks' ? ['o'] : []))); }
          }
          return fn(ev);
        });
      } });
    })();`);
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    const p = await openPage(ctx, `http://localhost:${br.port}/live/`);
    await fillDone(p);
    await control(br.port, 'hold', { root: 'NQ' });
    await p.waitForTimeout(500);
    const res = await p.evaluate(async pt => {
      const tape = await (await fetch(`http://localhost:${pt}/test/tape?root=NQ&from=0`, { method: 'POST' })).json();
      const at = new Map();                                   // tape index by (t, p, v, occurrence)
      const key = (t, p, v) => t + '|' + p + '|' + v;
      const idx = new Map();
      for (let i = 0; i < tape.n; i++) { const k = key(tape.t[i], tape.p[i], tape.v[i]); if (!idx.has(k)) idx.set(k, []); idx.get(k).push(i); }
      const used = new Map();
      let bad = 0, n = 0, first = null;
      for (const x of window.__sides) {
        const k = key(x[0], x[1], x[2]), list = idx.get(k) || [], u = used.get(k) || 0;
        used.set(k, u + 1);
        const i = list[u];
        n++;
        if (i === undefined || tape.s[i] !== x[3] || tape.m[i] !== x[4]) { bad++; if (!first) first = JSON.stringify(x); }
      }
      return { n, bad, first };
    }, br.port);
    check(res.bad === 0 && res.n > 10000, 'trade sides: all ' + res.n.toLocaleString() + ' trades the page received (recent, older, live) carry the tape\'s side and method' + (res.first ? ' (first wrong ' + res.first + ')' : ''));
    await ctx.close();
    br.kill();
  }

  /* ---------------- 1m with the volume profile: ticks back to 18:00 (RTH: 9:30) in the background */
  {
    const off = offsetTo(13, 30);
    const br = await startBridge(off, ['--live-first', '--tick-rate=3', '--live-rate=100', '--recent-ticks=20000', '--older-ms=2000']);
    const vpOn = `localStorage.setItem('live-indicators-v1', JSON.stringify({ main: { vp: true } }));`;
    const ctx = await context(browser, off, { root: 'NQ', tf: 'm1', glide: 'smooth', rangeMode: 'nt' }, vpOn);
    const p = await openPage(ctx, `http://localhost:${br.port}/live/`);
    const sub = await p.evaluate(() => window.__rec.sent.find(m => m.type === 'subscribe'));
    check(sub.liveFirst === true && sub.tickHours === 21, '1m with the profile on asks for ticks back to 18:00 ET, live first (tickHours ' + sub.tickHours + ' at 13:30)');
    const during = await p.evaluate(() => ({ note: document.getElementById('vpNote').textContent, total: window.liveChart.getProfile() && window.liveChart.getProfile().total }));
    check(/is still loading/.test(during.note), 'while it loads the profile says so: "' + during.note + '"');
    await fillDone(p);
    await control(br.port, 'hold', { root: 'NQ' });
    await p.waitForTimeout(500);
    const vpCheck = () => p.evaluate(async pt => {
      const vp = window.liveChart.getProfile(), now = Date.now() / 1000, et = window.ChartEngine.util.zoneSeconds(now);
      const from = vp.startOf(et);
      const tape = await (await fetch(`http://localhost:${pt}/test/tape?root=NQ&from=${from}`, { method: 'POST' })).json();
      let vol = 0;
      for (let i = 0; i < tape.n; i++) if (!vp.rth || vp.inRth(tape.t[i])) vol += tape.v[i];
      return { total: vp.total, vol, rth: vp.rth, note: document.getElementById('vpNote').textContent, from };
    }, br.port);
    let v = await vpCheck();
    check(v.total === v.vol && v.total > 0 && !v.note, 'the profile holds every contract of the session since 18:00 ET: ' + v.total.toLocaleString() + ' (the tape: ' + v.vol.toLocaleString() + '), and no note');
    // RTH, from the profile's gear: the same store covers 9:30, so nothing is reloaded
    const subs0 = await p.evaluate(() => window.__rec.sent.filter(m => m.type === 'subscribe').length);
    await p.click('#indBtn'); await p.click('#indBody [data-act="gear"][data-id="vp"]'); await p.click('#indBody [data-act="opt"][data-id="vp"][data-v="rth"]'); await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    v = await vpCheck();
    const subs1 = await p.evaluate(() => window.__rec.sent.filter(m => m.type === 'subscribe').length);
    check(v.rth && v.total === v.vol && v.total > 0 && subs1 === subs0, 'RTH: the profile holds every contract since 9:30 ET (' + v.total.toLocaleString() + '), from the same history (no reload)');
    await p.screenshot({ path: path.join(SHOTS, 'live-first-1m-profile.png') });
    await ctx.close();
    // the profile switched on in a 1m view that has no ticks: the page asks for them (live first)
    const ctx2 = await context(browser, off, { root: 'NQ', tf: 'm1', glide: 'smooth', rangeMode: 'nt' }, '');
    const p2 = await openPage(ctx2, `http://localhost:${br.port}/live/`);
    const first = await p2.evaluate(() => window.__rec.sent.find(m => m.type === 'subscribe'));
    check(first.tickHours === 0 && !first.liveFirst, '1m with the profile off: no tick history, as before');
    await p2.click('#indBtn');
    await p2.fill('#indQ', 'profile');
    await p2.keyboard.press('Enter');
    await p2.waitForFunction(() => window.__rec.sent.filter(m => m.type === 'subscribe').length === 2, null, { timeout: 5000 }).catch(() => {});
    const second = await p2.evaluate(() => window.__rec.sent.filter(m => m.type === 'subscribe')[1]);
    check(second && second.tickHours === 21 && second.liveFirst === true, 'switching the profile on asks for the session\'s ticks, live first (' + JSON.stringify(second) + ')');
    await p2.keyboard.press('Escape');
    await live(p2);
    await fillDone(p2);
    check(await p2.evaluate(() => { const vp = window.liveChart.getProfile(); return !!vp && vp.total > 0 && !document.getElementById('vpNote').textContent; }), 'and the profile fills in, with no note');
    await ctx2.close();
    br.kill();
  }

  /* ---------------- a resubscribe in the middle of the older history (15s, then Range needs more hours) */
  {
    const off = offsetTo(10, 15);
    const br = await startBridge(off, ['--live-first', '--tick-rate=4', '--live-rate=150', '--recent-ticks=20000', '--older-ms=400', '--older-chunk=3000']);
    const ctx = await context(browser, off, { root: 'NQ', tf: 's15', glide: 'smooth', rangeMode: 'nt' }, '');
    const p = await openPage(ctx, `http://localhost:${br.port}/live/`);
    await p.waitForFunction(() => window.__rec.chunks >= 2, null, { timeout: 20000 });
    const mid = await p.evaluate(() => ({ done: window.liveData().fill.done, sub: window.liveData().sub }));
    await p.click('#tfSeg [data-v="range"]');
    await live(p);
    await fillDone(p);
    const subs = await p.evaluate(() => window.__rec.sent.filter(m => m.type === 'subscribe').map(m => m.sub + ':' + m.tickHours));
    check(!mid.done && subs.length === 2, 'switched to Range in the middle of the 15s history: a new load (' + subs.join(', ') + ')');
    await control(br.port, 'hold', { root: 'NQ' });
    await p.waitForTimeout(600);
    const st = await storeVsTape(p, br.port, 'NQ');
    check(st.bad < 0 && st.n === st.tape, 'nothing of the older load mixed in: the page holds the tape exactly (' + st.n.toLocaleString() + ' trades)');
    await ctx.close();
    br.kill();
  }

  /* ---------------- an old bridge (ChartBridge 0.3.4): a full load, as before */
  {
    const off = offsetTo(10, 45);
    const br = await startBridge(off, ['--tick-rate=2']);
    const ctx = await context(browser, off, { root: 'NQ', tf: 'range', glide: 'smooth', rangeMode: 'nt' }, `localStorage.setItem('live-indicators-v1', JSON.stringify({ main: { vp: true } }));`);
    const p = await openPage(ctx, `http://localhost:${br.port}/live/`);
    const r = await p.evaluate(() => ({ sub: window.__rec.sent.find(m => m.type === 'subscribe'), fill: window.liveData().fill, n: window.liveData().ticks.length, bars: window.liveChart.bars().length, more: window.__rec.sent.filter(m => m.type === 'more').length }));
    check(r.sub.liveFirst === undefined && r.sub.sub === undefined && r.fill === null && r.more === 0 && r.n > 10000 && r.bars > 10,
      'old bridge: the subscribe of 1.6.0 (no liveFirst, no sub), a full load (' + r.n.toLocaleString() + ' trades, ' + r.bars + ' range bars), nothing pulled');
    await p.click('#tfSeg [data-v="m1"]');
    await p.waitForTimeout(300);
    const subs = await p.evaluate(() => window.__rec.sent.filter(m => m.type === 'subscribe').length);
    check(subs === 1, 'old bridge: 1m with the profile on loads no more ticks (as 1.6.0)');
    await ctx.close();
    br.kill();
  }
} finally {
  await browser.close();
  for (const b of bridges) b.kill();
}
if (errors.length) { console.error('\nlive-first smoke FAILED: ' + errors.length); process.exit(1); }
console.log('\nlive-first smoke ok');
