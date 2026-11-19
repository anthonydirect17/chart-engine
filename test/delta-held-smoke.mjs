// The delta held by ChartBridge (ChartBridge 0.6.25's delta table, nt8/PROTOCOL.md "The delta table"; Anthony 2026-11-19: "When I
// switch between chart timeframes or tickers, my Cum Delta resets. That should not be: once the data is in there, it should be
// there."). A mounted chart (test/chart-host.html) against the fake bridge with --live-first --delta-table, SAMPLE data only,
// never market data. The fake's live trades are paused (/test/pause), so the session's cumulative delta is one number, worked
// out here from the fake's tape (every NQ trade from 18:00 ET with its side), and every load must show it:
//   1m, then range, 15s and 5m (timeframe switches); MNQ and back (a ticker switch); a reload; the chart torn down and mounted
//   again on the window's shared feed (live/feed.js), as the workspace's layout or laptop-tab switch does; a table pushed after
//   ready (ChartBridge reading the session's saved table back). Each is labelled "since 18:00 ET". The Data Box's largest print on
//   a bar built from the table is the bar's largest trade; from an older saved file (no largest trade kept) it shows "-".
// Then: ChartBridge started after 18:00 ("since HH:MM ET (ChartBridge started)", the count from then); the seconds ChartBridge
// missed ("missed 8 s"); an older ChartBridge (no deltaTable in hello): the page counts from its opening as before, and its
// subscribe asks for no table. Screenshots in test/out (SHOTS=dir), labelled as sample data.
//   npm run smoke:delta-held        (CHROMIUM_PATH=/path/to/chrome for a preinstalled browser)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { hostUrl, waitLive } from './chart-host.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CE = require('../src/chart-engine.js'), U = CE.util;
const SHOTS = path.resolve(process.env.SHOTS || path.join(root, 'test', 'out'));
fs.mkdirSync(SHOTS, { recursive: true });
let port = +(process.env.DELTA_HELD_PORT || 8891);
const errors = [];
let checks = 0;
const check = (ok, m) => { checks++; if (!ok) { errors.push(m); console.error('  FAIL ' + m); } else console.log('  ok   ' + m); };

/* Seconds to add to the real clock to stand at hh:mm New York time on the most recent Tuesday to Thursday before now. */
function offsetTo(hh, mm) {
  const now = Date.now() / 1000, today = Math.floor(U.zoneSeconds(now) / 86400);
  for (let back = 1; back < 30; back++) {
    const bt = (today - back) * 86400 + hh * 3600 + mm * 60, d = new Date(bt * 1000).getUTCDay();
    if (d < 2 || d > 4) continue;
    let unix = bt - (U.zoneSeconds(now) - now);
    unix = bt - (U.zoneSeconds(unix) - unix);
    return Math.round(unix - now);
  }
  throw new Error('no day found');
}
const bridges = [];
async function startBridge(offset, extra) {
  for (let tries = 0; tries < 8; tries++, port++) {
    const p = port;
    const b = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(p), '--pin-off', '--test-controls', '--live-first', '--clock-offset=' + offset].concat(extra || []), { stdio: ['ignore', 'pipe', 'pipe'] });
    let errText = '';
    b.stderr.on('data', d => { errText += d; });
    const ok = await new Promise(res => { b.stdout.once('data', () => res(true)); b.once('exit', () => res(false)); });
    if (ok) { port++; bridges.push(b); return { port: p, kill: () => b.kill() }; }
    if (!/EADDRINUSE/.test(errText)) throw new Error('bridge failed: ' + errText);
  }
  throw new Error('no free port');
}
const post = (p, url) => fetch(`http://localhost:${p}${url}`, { method: 'POST' }).then(r => r.text());
/* The session's net delta and from when, from the fake's tape (its trades of the session of the last trade, from `fromT`). */
async function tapeNet(p, rootSym, fromT) {
  const k = await (await fetch(`http://localhost:${p}/test/tape?root=${rootSym}&from=0`, { method: 'POST' })).json();
  const last = k.t[k.n - 1], s0 = (U.tradeDay(last, 18 * 3600) - 1) * 86400 + 18 * 3600, from = fromT === undefined ? s0 : fromT;
  let net = 0, n = 0;
  for (let i = 0; i < k.n; i++) if (k.t[i] >= from && k.t[i] >= s0) { net += k.s[i] === 1 ? k.v[i] : k.s[i] === -1 ? -k.v[i] : 0; n++; }
  return { net, n, s0, last };
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
async function context(offset, tf) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(`(() => {
    const realNow = Date.now; Date.now = () => realNow() + ${offset * 1000};
    try { if (!localStorage.getItem('live-settings-v2')) localStorage.setItem('live-settings-v2', JSON.stringify({ root: 'NQ', tf: '${tf}', glide: 'smooth', rangeMode: 'nt' })); localStorage.setItem('live-range-v2', JSON.stringify({ NQ: 40, MNQ: 40 })); } catch (e) {}
    window.__subs = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (x) { try { const m = JSON.parse(x); if (m.type === 'subscribe') window.__subs.push(m); } catch (e) {} return send.call(this, x); };
  })();`);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  return ctx;
}
/* The delta pane once built: the newest bar's close (the session's count), its title, and how it was counted. */
const deltaNow = p => p.evaluate(() => {
  const m = window.liveMount, D = m.data(), cd = D.delta;
  return { built: !!cd, c: cd && cd.last ? cd.last.c : null, title: m.chart.deltaPane().title, by: D.deltaCov ? D.deltaCov.by : '', tf: m.view().tf, root: m.view().root };
});
async function settled(p, want, ms = 20000) {
  const end = Date.now() + ms;
  let d = null;
  while (Date.now() < end) {
    d = await deltaNow(p);
    if (d.built && (want === undefined || (want instanceof RegExp ? want.test(d.title) : d.c === want)) && d.title) return d;
    await p.waitForTimeout(100);
  }
  return d;
}
const label = (p, text) => p.evaluate(t => { let el = document.getElementById('sampleLabel'); if (!el) { el = document.createElement('div'); el.id = 'sampleLabel'; el.style.cssText = 'position:fixed;left:50%;top:6px;transform:translateX(-50%);z-index:99;background:#000c;color:#ffd166;font:12px IBM Plex Sans,sans-serif;padding:3px 10px;border-radius:4px'; document.body.appendChild(el); } el.textContent = t; }, text);
const shot = async (p, name, text) => { await label(p, 'SAMPLE DATA (fake bridge), not market data. ' + text); await p.waitForTimeout(300); await p.screenshot({ path: path.join(SHOTS, name) }); };

try {
  // ------------------------------------------------------------ a whole session, every switch
  const OFF = offsetTo(13, 40);
  const b = await startBridge(OFF, ['--delta-table']);
  const ctx = await context(OFF, 'm1');
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('page error: ' + e.message));
  await p.goto(hostUrl(b.port));
  await waitLive(p);
  await post(b.port, '/test/pause');
  await p.waitForTimeout(300);
  const truth = await tapeNet(b.port, 'NQ');
  let d = await settled(p, truth.net);
  check(d.built && d.c === truth.net && d.by === 'table', '1m: the cumulative delta is the whole session\'s from 18:00 ET (' + truth.n.toLocaleString() + ' sample trades, net ' + truth.net + '; the page shows ' + d.c + ')');
  check(/since 18:00 ET/.test(d.title) && !/page opened/.test(d.title), '1m: labelled "since 18:00 ET": ' + d.title);
  check((await p.evaluate(() => window.__subs.every(m => m.deltaTable === true))), 'every subscribe asks for the delta table (hello lists deltaTable)');
  // the Data Box's largest print on a bar built from the table (Anthony 2026-11-19: "Yes, add it"): the bar's largest single trade
  const bigNow = async (p0, rootSym) => {
    const info = await p0.evaluate(() => { const b = window.liveMount.barInfo(); return b ? { t: b.t, big: b.delta ? b.delta.big : null } : null; });
    const k = await (await fetch(`http://localhost:${b.port}/test/tape?root=${rootSym}&from=${info.t}`, { method: 'POST' })).json();
    let want = 0; for (let i = 0; i < k.n; i++) if (k.t[i] < info.t + 60 && k.v[i] > want) want = k.v[i];
    return { got: info.big, want };
  };
  let bg = await bigNow(p, 'NQ');
  check(bg.got > 0 && bg.got === bg.want, '1m: the Data Box\'s largest print on a bar built from the table is that minute\'s largest trade (' + bg.got + ' against ' + bg.want + ')');
  await shot(p, 'delta-held-1m.png', 'Cum Delta from ChartBridge\'s delta table, since 18:00 ET.');
  for (const tf of ['range', 's15', 'm5', 'm1']) {
    await p.evaluate(v => window.liveMount.setView({ tf: v }), tf);
    await waitLive(p);
    d = await settled(p, truth.net);
    check(d.tf === tf && d.c === truth.net && /since 18:00 ET/.test(d.title), 'timeframe switch to ' + tf + ': the same count (' + d.c + '), "since 18:00 ET"');
    if (tf === 'range') await shot(p, 'delta-held-range.png', 'Range bars: the same Cum Delta after a timeframe switch.');
  }
  const mnq = await tapeNet(b.port, 'MNQ');
  await p.evaluate(() => window.liveMount.setView({ root: 'MNQ' }));
  await waitLive(p);
  d = await settled(p, mnq.net);
  check(d.root === 'MNQ' && d.c === mnq.net, 'ticker switch to MNQ: MNQ\'s own session count (' + d.c + ')');
  await p.evaluate(() => window.liveMount.setView({ root: 'NQ' }));
  await waitLive(p);
  d = await settled(p, truth.net);
  check(d.root === 'NQ' && d.c === truth.net && /since 18:00 ET/.test(d.title), 'and back to NQ: the same count as before (' + d.c + '), not reset');
  await p.reload();
  await waitLive(p);
  d = await settled(p, truth.net);
  check(d.c === truth.net && /since 18:00 ET/.test(d.title), 'reload: the same count (' + d.c + ')');
  // the workspace's layout or laptop-tab switch: every chart is torn down and mounted again on the window's shared feed
  await p.addScriptTag({ path: path.join(root, 'live', 'feed.js') });
  await p.evaluate(() => {
    const host = document.getElementById('host');
    window.liveMount.destroy(); host.textContent = '';
    window.__hub = window.ChartFeed.create({ wsUrl: 'ws://' + location.host + '/ws' });
    window.liveMount = window.ChartLive.mount(host, { feed: window.__hub, storagePrefix: '', paneId: 'main' });
  });
  await waitLive(p);
  d = await settled(p, truth.net);
  check(d.c === truth.net && /since 18:00 ET/.test(d.title), 'layout switch (torn down, mounted again on the shared feed): the same count (' + d.c + ')');
  // a second chart joining the same line (another panel of the layout) gets the table from the line's record
  await p.evaluate(() => { const el = document.createElement('div'); el.id = 'host2'; el.style.cssText = 'position:fixed;right:0;bottom:0;width:600px;height:400px'; document.body.appendChild(el); window.__m2 = window.ChartLive.mount(el, { feed: window.__hub, storagePrefix: 'p2:', paneId: 'main', view: { root: 'NQ', tf: 'm5' } }); });
  const second = await p.waitForFunction(() => { const D = window.__m2.data(); return D.delta && D.delta.last ? D.delta.last.c : null; }, null, { timeout: 20000 }).then(h => h.jsonValue());
  check(second === truth.net, 'a second chart on the same shared line (5m) shows the same count (' + second + ')');
  await p.evaluate(() => { window.__m2.destroy(); document.getElementById('host2').remove(); });
  // a table pushed after ready (ChartBridge read the session's saved table back): built again, the same count
  await post(b.port, '/test/delta-missed?s=8');
  await post(b.port, '/test/delta-push');
  await p.waitForTimeout(800);
  d = await settled(p, truth.net);
  check(d.c === truth.net && /missed 8 s/.test(d.title), 'a table pushed after ready (saved table read back) builds the same count, and the seconds ChartBridge missed show: ' + d.title);
  await shot(p, 'delta-held-missed.png', 'A pushed table that says ChartBridge missed 8 s.');
  // a table read back from a file saved before ChartBridge kept the largest trade: the same count, the largest print '-'
  await post(b.port, '/test/delta-old-file');
  await post(b.port, '/test/delta-push');
  await p.waitForTimeout(800);
  d = await settled(p, truth.net);
  const oldBig = await p.evaluate(() => { const b = window.liveMount.barInfo(); return b && b.delta ? b.delta.big : null; });
  check(d.c === truth.net && oldBig === 0, 'a table from an older saved file (no largest trade): the same count, and the Data Box\'s largest print shows "-" (' + oldBig + ')');
  await post(b.port, '/test/delta-old-file?on=0');
  await post(b.port, '/test/delta-push');
  await p.waitForTimeout(800);
  bg = await bigNow(p, 'NQ');
  check(bg.got === bg.want, 'and with the largest trade again, it shows (' + bg.got + ')');
  // live again: the count goes on from the table
  await post(b.port, '/test/delta-missed?s=0');
  await post(b.port, '/test/pause?on=0');
  await p.waitForTimeout(1500);
  await post(b.port, '/test/pause');
  await p.waitForTimeout(400);
  const later = await tapeNet(b.port, 'NQ');
  d = await settled(p, later.net);
  check(d.c === later.net && later.n > truth.n, 'live trades after the table: the count follows them to the trade (' + (later.n - truth.n) + ' more, net ' + later.net + ')');
  await ctx.close(); b.kill();

  // ------------------------------------------------------------ ChartBridge started after 18:00
  const b2 = await startBridge(OFF, ['--delta-table', '--delta-started']);
  const ctx2 = await context(OFF, 'm1');
  const p2 = await ctx2.newPage();
  await p2.goto(hostUrl(b2.port));
  await waitLive(p2);
  await p2.waitForTimeout(2500);                          // some trades after the fake's start
  await post(b2.port, '/test/pause');
  await p2.waitForTimeout(300);
  const k2 = await (await fetch(`http://localhost:${b2.port}/test/tape?root=NQ&from=0`, { method: 'POST' })).json();
  await p2.evaluate(() => window.liveMount.setView({ tf: 'm5' }));
  await waitLive(p2);
  // this load's table (the first load may have come before the fake's first live trade: then it had none, as ChartBridge)
  const startedAt = await p2.waitForFunction(() => { const T = window.liveMount.data().dtab; return T ? T.coveredFrom : null; }, null, { timeout: 20000 }).then(h => h.jsonValue());
  const t2 = await tapeNet(b2.port, 'NQ', startedAt);
  d = await settled(p2, t2.net);
  check(startedAt > t2.s0 && d.c === t2.net && /since \d\d:\d\d(:\d\d(\.\d+)?)? ET \(ChartBridge started\)/.test(d.title), 'ChartBridge started after 18:00: the count from its start, labelled: ' + d.title + ' (net ' + t2.net + ', ' + k2.n + ' sample trades in the tape)');
  await shot(p2, 'delta-held-started.png', 'ChartBridge started mid-session: "since HH:MM ET (ChartBridge started)".');
  await ctx2.close(); b2.kill();

  // ------------------------------------------------------------ an older ChartBridge: as before
  const b3 = await startBridge(OFF, []);
  const ctx3 = await context(OFF, 's15');
  const p3 = await ctx3.newPage();
  await p3.goto(hostUrl(b3.port));
  await waitLive(p3);
  d = await settled(p3, /page opened/, 45000);       // from the first whole 15 s bar after the page opened
  const asked = await p3.evaluate(() => window.__subs.some(m => 'deltaTable' in m));
  check(!asked && d.by !== 'table' && /page opened/.test(d.title), 'an older ChartBridge (no deltaTable in hello): no table asked, the count from the page\'s opening as before: ' + d.title);
  await ctx3.close(); b3.kill();
} catch (e) {
  errors.push('smoke error: ' + (e && e.stack || e));
} finally {
  await browser.close();
  for (const x of bridges) try { x.kill(); } catch (e) { /* gone */ }
}
console.log(checks + ' checks, ' + errors.length + ' failed');
if (errors.length) { for (const e of errors) console.error(e); process.exit(1); }
