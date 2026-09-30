'use strict';
// Live first (chart 1.8.0, ChartBridge 0.3.5): the page's side of the older history. The tick store taking the older
// trades in front (TickStore.prependAll), the range-bar sync rule (RangeSync) proven against full builds from made-up
// histories, and the fake bridge's live-first protocol (every trade of its tape once, in order). The page itself runs in
// test/live-first-smoke.mjs. Made-up prices; nothing here is market data.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const BB = require('../live/bar-builder.js');

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

test('TickStore.prependAll: older trades in front, across blocks, with pushes and trims after, the same as one load', () => {
  const all = walk(300000, 7);
  for (const cut of [[0, 150000], [250000, 1], [65536, 131072], [199999, 200000], [70000, 70001]]) {
    const whole = new BB.TickStore(); whole.pushAll(all);
    const s = new BB.TickStore();
    s.pushAll(all.slice(cut[1]));                               // the recent trades first
    for (let b = cut[1]; b > 0;) {                              // then older chunks, newest first, of odd sizes
      const a = Math.max(0, b - (1 + (b * 7919) % 70000));
      s.prependAll(all.slice(a, b));
      b = a;
    }
    assert.equal(s.length, all.length);
    assert.equal(s.prepended, cut[1]);
    for (const i of [0, 1, 65535, 65536, cut[1] - 1, cut[1], all.length - 1]) if (i >= 0 && i < all.length) assert.deepEqual(s.at(i), whole.at(i), 'trade ' + i);
    const b1 = new BB.BarBuilder({ mode: 'range', rangeTicks: 40, tick: 0.25 }), b2 = new BB.BarBuilder({ mode: 'range', rangeTicks: 40, tick: 0.25 });
    s.feed(b1, 0); whole.feed(b2, 0);
    assert.deepEqual(b1.bars, b2.bars, 'range bars from the prepended store');
    s.push(1e9, 1, 1); s.dropFirst(100000);
    assert.equal(s.length, all.length - 100000 + 1);
    assert.deepEqual(s.at(0), all[100000]);
    assert.deepEqual(s.at(s.length - 1), [1e9, 1, 1]);
  }
  const e = new BB.TickStore();
  e.prependAll([[1, 2, 3]]); e.push(2, 3, 4); e.prependAll([[0, 1, 1]]);
  assert.deepEqual([e.at(0), e.at(1), e.at(2)], [[0, 1, 1], [1, 2, 3], [2, 3, 4]], 'into an empty store');
  const f = new BB.TickStore(); f.pushAll(all.slice(0, 1000));
  const seen = []; f.feed({ addQuiet: (t) => seen.push(t) }, 10, undefined, 20);
  assert.equal(seen.length, 10, 'feed stops at `to`');
});

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

test('fake bridge --live-first: recent window, ready, older history on request; every tape trade once and in order, in a busy market', async () => {
  const port = 19600 + Math.floor(Math.random() * 300);
  const child = await startBridge(port, ['--live-first', '--recent-ticks=3000', '--recent-ms=400', '--older-ms=300', '--older-chunk=2000', '--live-rate=400']);
  try {
    const ws = await wsConnect(port);
    assert.ok(await ws.until(() => ws.msgs.some(m => m.type === 'hello')));
    assert.deepEqual(ws.msgs.find(m => m.type === 'hello').features, ['liveFirst']);
    ws.onMsg = m => { if (m.type === 'ready' && m.older) { ws.send({ type: 'more', sub: 5 }); ws.send({ type: 'more', sub: 5 }); } else if (m.type === 'olderTicks' && !m.done) ws.send({ type: 'more', sub: 5 }); };
    ws.send({ type: 'subscribe', root: 'MNQ', days: 1, tickHours: 3, sub: 5, liveFirst: true });
    assert.ok(await ws.until(() => ws.msgs.some(m => m.type === 'olderTicks' && m.done), 20000), 'the older history ends');
    await new Promise(r => setTimeout(r, 300));
    const got = ws.msgs.slice();
    ws.close();
    const ready = got.findIndex(m => m.type === 'ready');
    assert.equal(got[ready].sub, 5); assert.equal(got[ready].older, true);
    const recent = got.slice(0, ready).filter(m => m.type === 'ticks').flatMap(m => m.ticks);
    assert.ok(recent.length > 0 && recent.length <= 3000);
    const older = got.filter(m => m.type === 'olderTicks');
    assert.ok(older.every(m => m.sub === 5) && older.length > 3);
    const page = older.slice().reverse().flatMap(m => m.ticks).concat(recent, got.slice(ready + 1).filter(m => m.type === 'tick' && m.root === 'MNQ').map(m => [m.t, m.p, m.v, m.s, m.sm]));
    const tape = await (await fetch(`http://127.0.0.1:${port}/test/tape?root=MNQ&from=${page[0][0]}`, { method: 'POST' })).json();
    assert.ok(tape.n >= page.length);
    for (let i = 0; i < page.length; i++) {
      const x = page[i];
      if (x[0] !== tape.t[i] || x[1] !== tape.p[i] || x[2] !== tape.v[i] || x[3] !== tape.s[i] || x[4] !== tape.m[i]) assert.fail('trade ' + i + ' of ' + page.length + ': ' + JSON.stringify(x) + ' against the tape ' + JSON.stringify([tape.t[i], tape.p[i], tape.v[i], tape.s[i], tape.m[i]]));
    }
    const live = got.slice(ready + 1).filter(m => m.type === 'tick').length;
    assert.ok(live > 50, 'live trades during and after the load: ' + live);
  } finally { child.kill(); }
});

test('fake bridge --live-first: a page that does not ask gets a full load from the same tape', async () => {
  const port = 19600 + Math.floor(Math.random() * 300);
  const child = await startBridge(port, ['--live-first']);
  try {
    const ws = await wsConnect(port);
    ws.send({ type: 'subscribe', root: 'MNQ', days: 1, tickHours: 2 });
    assert.ok(await ws.until(() => ws.msgs.some(m => m.type === 'ready')));
    const ready = ws.msgs.find(m => m.type === 'ready');
    assert.equal(ready.older, undefined);
    assert.equal(ready.sub, undefined, 'no sub echoed when the page sent none');
    assert.ok(ws.msgs.filter(m => m.type === 'ticks').flatMap(m => m.ticks).length > 1000);
    ws.close();
    await fetch(`http://127.0.0.1:${port}/test/features?liveFirst=0`, { method: 'POST' });
    const ws2 = await wsConnect(port);
    assert.ok(await ws2.until(() => ws2.msgs.some(m => m.type === 'hello')));
    assert.equal(ws2.msgs.find(m => m.type === 'hello').features, undefined, 'features off: hello as 0.3.4');
    ws2.close();
  } finally { child.kill(); }
});
