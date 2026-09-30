'use strict';
// Served window and session table (chart 1.8.0, ChartBridge 0.3.5): the page's side. The range-bar sync rule (RangeSync)
// proven against full builds from made-up histories; the session VWAP started from the table (BarBuilder vwapSeed); the
// store's trim that never drops the current session; the volume profile from the table's rows equal to one from every trade
// (session and RTH, an early close, both DST changes); and the fake bridge's protocol (window, served window, profile) against
// its tape. The page itself runs in test/live-first-smoke.mjs. Made-up prices; nothing here is market data.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const BB = require('../live/bar-builder.js');
const CE = require('../src/chart-engine.js');
const U = CE.util;

/* a seeded random walk, one tick at a time with jumps now and then, times that sometimes repeat */
function walk(n, seed, opts) {
  const o = opts || {};
  let s = seed >>> 0 || 1;
  const rnd = () => (s = (s * 48271) % 2147483647) / 2147483647;
  const out = [];
  let t = o.t0 === undefined ? 20 * 3600 : o.t0, P = 80000;   // bar-time seconds; P in ticks
  for (let i = 0; i < n; i++) {
    t += rnd() < 0.2 ? 0 : 0.001 + rnd() * (o.step || 0.8);
    if (o.breakAt && i === o.breakAt) t += 3600 * 1.2;         // crosses the 17:00 to 18:00 ET break when near it
    const r = rnd(), jump = r < 0.004 ? 5 + Math.floor(rnd() * 90) : r < 0.5 ? 0 : 1;
    P += (rnd() < (o.drift || 0.5) ? 1 : -1) * jump;
    out.push([+t.toFixed(3), P * 0.25, 1 + Math.floor(rnd() * 4)]);
  }
  return out;
}

/* the bars a full build gives from `from` (the window's front) on, against the window's own build from its sync point */
function syncCase(all, from, mode, R) {
  const full = new BB.BarBuilder({ mode: 'range', rangeTicks: R, rangeMode: mode, tick: 0.25 });
  for (const x of all) full.add(x[0], x[1], x[2]);
  const w = new BB.BarBuilder({ mode: 'range', rangeTicks: R, rangeMode: mode, tick: 0.25 });
  const rs = new BB.RangeSync(R, 0.25, 18 * 3600);
  let syncBar = -1, syncAt = -1;
  for (let i = from; i < all.length; i++) {
    const n0 = w.bars.length;
    w.add(all[i][0], all[i][1], all[i][2]);
    if (syncBar < 0 && rs.step(all[i][0], all[i][1])) { syncBar = n0; syncAt = i; }
  }
  if (syncBar < 0) return { synced: false };
  const ours = w.bars.slice(syncBar).map(b => [b.t, b.o, b.h, b.l, b.c, b.v]);
  const theirs = full.bars.slice(full.bars.length - ours.length).map(b => [b.t, b.o, b.h, b.l, b.c, b.v]);
  return { synced: true, same: JSON.stringify(ours) === JSON.stringify(theirs), bars: ours.length, after: syncAt - from, ours, theirs };
}

test('RangeSync: from the sync point, range bars built from the window equal a build from the session start (both styles)', () => {
  let cases = 0, synced = 0, afterSum = 0, maxAfter = 0;
  for (const mode of ['nt', 'traded']) for (const R of [4, 12, 40]) for (let k = 0; k < 40; k++) {
    const seed = 1000 + k * 13 + R, drift = [0.5, 0.52, 0.48, 0.6][k % 4];
    const all = walk(6000, seed, { drift, breakAt: k % 5 === 0 ? 3000 : 0, t0: k % 5 === 0 ? 17 * 3600 - 1800 : 20 * 3600 });
    const from = 200 + (seed * 37) % 3000;
    const r = syncCase(all, from, mode, R);
    cases++;
    if (!r.synced) continue;
    synced++; afterSum += r.after; maxAfter = Math.max(maxAfter, r.after);
    assert.ok(r.same, mode + ' R' + R + ' seed ' + seed + ': ' + r.bars + ' bars after the sync differ; first: ' + JSON.stringify(r.ours[0]) + ' vs ' + JSON.stringify(r.theirs[0]));
  }
  assert.ok(synced > cases * 0.8, 'most windows sync (' + synced + ' of ' + cases + ')');
  console.log('# RangeSync: ' + synced + ' of ' + cases + ' windows synced, on average ' + Math.round(afterSum / synced) + ' trades in (at most ' + maxAfter + ')');
});

test('RangeSync: a window that starts inside a bar is not taken as synced before a full swing', () => {
  // A trend: bars built from different starts never meet while the price only rises, so there is no sync.
  const up = []; for (let i = 0; i < 400; i++) up.push([20 * 3600 + i, 20000 + i * 0.25, 1]);
  const rs = new BB.RangeSync(8, 0.25, 18 * 3600);
  assert.equal(up.some(x => rs.step(x[0], x[1])), false, 'no swing, no sync');
  const r = syncCase(up, 3, 'nt', 8);
  assert.equal(r.synced, false);
  // and indeed the two builds differ there (so a rule that synced here would be wrong)
  const a = new BB.BarBuilder({ mode: 'range', rangeTicks: 8, tick: 0.25 }), b = new BB.BarBuilder({ mode: 'range', rangeTicks: 8, tick: 0.25 });
  for (const x of up) a.add(x[0], x[1], x[2]);
  for (const x of up.slice(3)) b.add(x[0], x[1], x[2]);
  assert.notDeepEqual(a.last.o, b.last.o);
  // the first trade of a new session seen in the window is a sync point
  const rs2 = new BB.RangeSync(8, 0.25, 18 * 3600);
  assert.equal(rs2.step(17 * 3600 - 5, 100), false);
  assert.equal(rs2.step(18 * 3600 + 1, 100), true);
});


test('BarBuilder vwapSeed: a window build started from the session\'s totals before it has the full build\'s VWAP; earlier days none', () => {
  for (const [k, from] of [[0, 1500], [1, 4000], [2, 10], [3, 5999]]) {
    const all = walk(6000, 300 + k, { breakAt: k === 1 ? 3000 : 0, t0: k === 1 ? 17 * 3600 - 1800 : 20 * 3600 });
    for (const mode of ['range', 'time']) {
      const opts = mode === 'range' ? { mode, rangeTicks: 12, tick: 0.25 } : { mode, seconds: 15, tick: 0.25 };
      const full = new BB.BarBuilder(opts);
      for (const x of all) full.add(x[0], x[1], x[2]);
      const day = BB.tradeDay(all[all.length - 1][0], 18 * 3600);
      let pv = 0, vol = 0;                                        // in whole ticks, as the page works it out from the table
      for (let i = 0; i < from; i++) if (BB.tradeDay(all[i][0], 18 * 3600) === day) { pv += Math.round(all[i][1] / 0.25) * all[i][2]; vol += all[i][2]; }
      const w = new BB.BarBuilder(Object.assign({ vwapSeed: { day, pv: pv * 0.25, vol } }, opts));
      for (const x of all.slice(from)) w.add(x[0], x[1], x[2]);
      const last = w.last, fl = full.last;
      assert.ok(Math.abs(last.vw - fl.vw) < 1e-9, mode + ' case ' + k + ': ' + last.vw + ' vs ' + fl.vw);
      for (const b of w.bars) {
        const d = BB.tradeDay(b.t, 18 * 3600);
        if (d < day) assert.equal(b.vw, null, 'an earlier day has no VWAP');
        else assert.ok(typeof b.vw === 'number');
      }
      const none = new BB.BarBuilder(Object.assign({ vwapSeed: null }, opts));
      for (const x of all.slice(from)) none.add(x[0], x[1], x[2]);
      assert.ok(none.bars.every(b => b.vw === null), 'seed null: no VWAP');
      assert.deepEqual(none.bars.map(b => [b.t, b.o, b.h, b.l, b.c, b.v]), w.bars.map(b => [b.t, b.o, b.h, b.l, b.c, b.v]), 'the bars themselves are the same');
    }
  }
});

test('trimCount: over the cap only earlier sessions go (but their last trade); the current session stays up to the hard limit', () => {
  const s = new BB.TickStore();
  const day = 20000, S0 = (day - 1) * 86400 + 18 * 3600;           // a session start
  for (let i = 0; i < 1000; i++) s.push(S0 - 5000 + i, 100, 1);    // the session before
  for (let i = 0; i < 3000; i++) s.push(S0 + i, 100, 1);           // this one
  const now = S0 + 4000;
  assert.equal(s.indexAt(S0), 1000);
  assert.equal(BB.trimCount(s, now, 18 * 3600, 5000, 10000, 500), 0, 'under the cap: nothing');
  assert.equal(BB.trimCount(s, now, 18 * 3600, 2000, 10000, 500), 999, 'the earlier session but its last trade');
  s.dropFirst(999);
  assert.equal(s.time(0), S0 - 5000 + 999);
  assert.equal(BB.trimCount(s, now, 18 * 3600, 2000, 10000, 500), 0, 'only the current session left (and one before): kept');
  assert.equal(BB.trimCount(s, now, 18 * 3600, 2000, 2500, 500), 500, 'past the hard limit: the oldest step');
  // a range build from the trimmed store still sees the session start
  const rs = new BB.RangeSync(8, 0.25, 18 * 3600);
  assert.equal(rs.step(s.time(0), 100), false);
  assert.equal(rs.step(s.time(1), 100), true);
});

/* ChartBridge's session table from trades (SessionTable.Key: the half hour of New York time and the price in ticks). */
function tableRows(trades, tick) {
  const m = new Map();
  for (const [t, p, v] of trades) { const k = Math.floor(t / 1800) * 1800 + '|' + Math.round(p / tick); m.set(k, (m.get(k) || 0) + v); }
  return [...m].map(([k, v]) => { const [h, p] = k.split('|'); return [+h, +p, v]; }).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
const profileOf = vp => JSON.stringify({ rows: vp.rows(), total: vp.total, poc: vp.poc(), va: vp.valueArea(), low: vp.low, high: vp.high });

test('volume profile from the table\'s rows equals the profile from every trade: session and RTH, an early close, both DST changes', () => {
  // trade days (bar time: New York wall clock) chosen for: a plain Wednesday, the NYSE early close the day after
  // Thanksgiving, and the Mondays after the March and November clock changes
  const days = [Date.UTC(2026, 8, 30), Date.UTC(2026, 10, 27), Date.UTC(2026, 2, 9), Date.UTC(2026, 10, 2)].map(ms => ms / 86400000);
  for (const day of days) {
    const S0 = (day - 1) * 86400 + 18 * 3600;
    const trades = walk(40000, day, { t0: S0, step: 5.2 }).filter(x => x[0] < S0 + 23 * 3600);
    // trades right on the edges: 18:00, 9:30, 13:00, 16:00 (and a hair before each)
    for (const e of [S0, day * 86400 + 34200, day * 86400 + 46800, day * 86400 + 57600]) trades.push([e - 0.001, 25000, 3], [e, 25000.25, 2]);
    trades.sort((a, b) => a[0] - b[0]);
    const inSession = trades.filter(x => x[0] >= S0);
    for (const rth of [false, true]) {
      const a = new CE.VolumeProfile({ tick: 0.25, sessionStart: 18 * 3600, rth }), b = new CE.VolumeProfile({ tick: 0.25, sessionStart: 18 * 3600, rth });
      for (const x of inSession) a.add(x[0], x[1], x[2]);
      // the page's vpBuild: the rows (time: the half hour's start), then the trades after the table
      const cut = Math.floor(inSession.length * 0.7);
      for (const r of tableRows(inSession.slice(0, cut), 0.25)) b.add(r[0], +(r[1] * 0.25).toFixed(10), r[2]);
      for (const x of inSession.slice(cut)) b.add(x[0], x[1], x[2]);
      assert.ok(a.trades > 5000, 'trades in the profile: ' + a.trades);
      assert.equal(profileOf(b), profileOf(a), new Date(day * 86400000).toISOString().slice(0, 10) + (rth ? ' RTH' : ' session'));
    }
  }
});

/* ---------------- the fake bridge's live-first protocol, trade by trade against its tape */
function wsConnect(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/ws', headers: { Host: 'localhost:' + port, Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') } });
    req.on('upgrade', (res, sock, head) => {
      const msgs = []; let buf = Buffer.alloc(0);
      const ws = { msgs, onMsg: null };
      const onData = d => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (buf.length < 2) break;
          let len = buf[1] & 0x7f, p = 2;
          if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); p = 4; }
          else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); p = 10; }
          if (buf.length < p + len) break;
          const m = JSON.parse(buf.slice(p, p + len).toString('utf8')); buf = buf.slice(p + len);
          msgs.push(m); if (ws.onMsg) ws.onMsg(m);
        }
      };
      sock.on('data', onData);
      if (head && head.length) onData(head);
      ws.send = obj => {
        const data = Buffer.from(JSON.stringify(obj)), mask = crypto.randomBytes(4);
        const headLen = data.length < 126 ? Buffer.from([0x81, 0x80 | data.length]) : Buffer.from([0x81, 0x80 | 126, data.length >> 8, data.length & 255]);
        sock.write(Buffer.concat([headLen, mask, Buffer.from(data.map((x, i) => x ^ mask[i & 3]))]));
      };
      ws.until = async (ok, ms) => { const end = Date.now() + (ms || 8000); while (!ok() && Date.now() < end) await new Promise(r => setTimeout(r, 20)); return ok(); };
      ws.close = () => sock.destroy();
      resolve(ws);
    });
    req.on('response', res => { res.resume(); reject(new Error('WebSocket refused: ' + res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
}
async function startBridge(port, flags) {
  const child = spawn(process.execPath, [path.join(__dirname, 'fake-bridge.mjs'), String(port), '--pin-off', '--test-controls'].concat(flags), { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => child.stdout.once('data', r));
  return child;
}


test('fake bridge --live-first: the served window, the profile before ready, and a second page from the served window', async () => {
  const port = 19600 + Math.floor(Math.random() * 300);
  const child = await startBridge(port, ['--live-first', '--window-ms=300', '--live-rate=300']);
  try {
    const ws = await wsConnect(port);
    assert.ok(await ws.until(() => ws.msgs.some(m => m.type === 'hello')));
    assert.deepEqual(ws.msgs.find(m => m.type === 'hello').features, ['liveFirst', 'profile']);
    ws.send({ type: 'subscribe', root: 'MNQ', days: 1, tickHours: 2, sub: 5, liveFirst: true, profile: true });
    assert.ok(await ws.until(() => ws.msgs.some(m => m.type === 'ready'), 10000));
    await new Promise(r => setTimeout(r, 400));
    const got = ws.msgs.slice();
    ws.close();
    const ready = got.findIndex(m => m.type === 'ready'), prof = got.findIndex(m => m.type === 'profile');
    assert.ok(prof >= 0 && prof === ready - 1 && got[prof].sub === 5 && got[ready].sub === 5, 'the profile right before ready, with the page\'s id');
    const win = got.slice(0, ready).filter(m => m.type === 'ticks').flatMap(m => m.ticks);
    const now = U.zoneSeconds(Date.now() / 1000);
    assert.ok(win.length > 100 && win[0][0] >= now - 2 * 3600 - 5 && win[0][0] < now - 2 * 3600 + 120, 'the window starts 2 h back: ' + (now - win[0][0]));
    const live = got.slice(ready + 1).filter(m => m.type === 'tick').map(m => [m.t, m.p, m.v, m.s, m.sm]);
    const page = win.concat(live);
    const S0 = (U.tradeDay(now, 18 * 3600) - 1) * 86400 + 18 * 3600;
    const tape = await (await fetch(`http://127.0.0.1:${port}/test/tape?root=MNQ&from=${Math.min(S0, page[0][0])}`, { method: 'POST' })).json();
    const off = tape.t.findIndex(t => t >= page[0][0]);
    for (let i = 0; i < page.length; i++) {
      const x = page[i], j = off + i;
      if (x[0] !== tape.t[j] || x[1] !== tape.p[j] || x[2] !== tape.v[j] || x[3] !== tape.s[j] || x[4] !== tape.m[j]) assert.fail('trade ' + i + ': ' + JSON.stringify(x));
    }
    // the table plus the trades after it are exactly the session's trades
    const P = got[prof], sessionTrades = [];
    for (let j = 0; j < off + page.length; j++) if (tape.t[j] >= S0) sessionTrades.push([tape.t[j], tape.p[j], tape.v[j]]);
    const cut = sessionTrades.length - live.length;
    assert.equal(P.session.from, S0); assert.equal(P.session.whole, true);
    assert.deepEqual(P.session.rows, tableRows(sessionTrades.slice(0, cut), 0.25), 'the table is the session up to the window\'s last trade');
    // a second page: from the served window, the same first trade, NinjaTrader not asked again
    const ws2 = await wsConnect(port);
    ws2.send({ type: 'subscribe', root: 'MNQ', days: 1, tickHours: 2, sub: 1, liveFirst: true, profile: true });
    assert.ok(await ws2.until(() => ws2.msgs.some(m => m.type === 'ready'), 10000));
    const w2 = ws2.msgs.filter(m => m.type === 'ticks').flatMap(m => m.ticks);
    assert.deepEqual(w2[0], win[0], 'the same first trade');
    // a minute page: the profile, no trades
    ws2.send({ type: 'subscribe', root: 'MNQ', days: 1, tickHours: 0, sub: 2, profile: true });
    assert.ok(await ws2.until(() => ws2.msgs.some(m => m.type === 'ready' && m.sub === 2), 10000));
    const m2 = ws2.msgs.slice(ws2.msgs.findIndex(m => m.type === 'history' && m.sub === 2));
    assert.equal(m2.filter(m => m.type === 'ticks').length, 0);
    assert.equal(m2.filter(m => m.type === 'profile').length, 1);
    ws2.close();
    const books = await (await fetch(`http://127.0.0.1:${port}/test/books`, { method: 'POST' })).json();
    assert.equal(books.MNQ.asked, 1); assert.equal(books.MNQ.served, 1);
  } finally { child.kill(); }
});

test('fake bridge --live-first --table-building: the table from the fake\'s start, then whole and pushed to live pages (no sub)', async () => {
  const port = 19600 + Math.floor(Math.random() * 300);
  const child = await startBridge(port, ['--live-first', '--table-building=1500', '--live-rate=200']);
  try {
    const ws = await wsConnect(port);
    ws.send({ type: 'subscribe', root: 'MNQ', days: 1, tickHours: 0, sub: 3, profile: true });
    assert.ok(await ws.until(() => ws.msgs.some(m => m.type === 'ready'), 10000));
    const first = ws.msgs.find(m => m.type === 'profile');
    assert.equal(first.session.whole, false);
    assert.ok(first.session.coveredFrom > first.session.from);
    assert.ok(await ws.until(() => ws.msgs.filter(m => m.type === 'profile').length === 2, 5000), 'pushed when whole');
    const pushed = ws.msgs.filter(m => m.type === 'profile')[1];
    assert.equal(pushed.session.whole, true); assert.equal(pushed.sub, undefined);
    ws.close();
  } finally { child.kill(); }
});

test('fake bridge --live-first: a page that does not ask gets a full load from the same tape, and no profile', async () => {
  const port = 19600 + Math.floor(Math.random() * 300);
  const child = await startBridge(port, ['--live-first']);
  try {
    const ws = await wsConnect(port);
    ws.send({ type: 'subscribe', root: 'MNQ', days: 1, tickHours: 2 });
    assert.ok(await ws.until(() => ws.msgs.some(m => m.type === 'ready')));
    assert.equal(ws.msgs.find(m => m.type === 'ready').sub, undefined, 'no sub echoed when the page sent none');
    assert.ok(ws.msgs.filter(m => m.type === 'ticks').flatMap(m => m.ticks).length > 1000);
    assert.equal(ws.msgs.filter(m => m.type === 'profile').length, 0);
    ws.close();
  } finally { child.kill(); }
});
