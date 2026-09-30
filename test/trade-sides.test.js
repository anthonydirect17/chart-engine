'use strict';
// ChartBridge 0.3.4 tags every trade with its side: live ticks get "s" and "sm", backfill trades become [t, p, v, s, sm].
// The fields are additive: the current page (live/live.js with live/bar-builder.js) must read the new messages exactly
// as the old ones. These tests feed both formats to the page's own parsing and bar building, check the page reads only
// what it always read, and check the fake bridge speaks the new format (and the old one with --no-sides).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const net = require('node:net');
const BB = require('../live/bar-builder.js');

const et = (h, m, s) => Date.UTC(2026, 8, 29, h, m, 0) / 1000 + (s || 0);

// Made-up trades (not market data): [t, p, v] and the same with side and method as ChartBridge 0.3.4 sends them.
const OLD = [];
for (let i = 0; i < 400; i++) OLD.push([+(et(10, 0) + i * 0.37).toFixed(3), 21440 + ((i * 7) % 23) * 0.25, 1 + (i % 4)]);
const NEW = OLD.map((x, i) => x.concat(i === 0 ? [0, 0] : x[1] > OLD[i - 1][1] ? [1, 2] : x[1] < OLD[i - 1][1] ? [-1, 2] : [1, 3]));

function bars(builder) { return builder.bars.map(b => [b.t, b.o, b.h, b.l, b.c, b.v]); }

test('backfill: [t, p, v, s, sm] fills the TickStore exactly like [t, p, v]', () => {
  const a = new BB.TickStore(), b = new BB.TickStore();
  a.pushAll(OLD); b.pushAll(NEW);
  assert.equal(b.length, a.length);
  for (let i = 0; i < a.length; i++) assert.deepEqual(b.at(i), a.at(i));
  // and the JSON text as ChartBridge writes it parses to the same first three columns
  const msg = JSON.parse('{"type":"ticks","root":"MNQ","sub":3,"ticks":[[1790661570,100,3,-1,2],[1790661600.5,100.5,2,1,2],[1790661601,100.25,1,0,0]],"done":true}');
  const s = new BB.TickStore(); s.pushAll(msg.ticks);
  assert.deepEqual([s.at(0), s.at(1), s.at(2)], [[1790661570, 100, 3], [1790661600.5, 100.5, 2], [1790661601, 100.25, 1]]);
});

test('backfill: time, range and minute bars built from the new arrays are identical', () => {
  for (const opts of [{ mode: 'time', seconds: 15 }, { mode: 'time', seconds: 60 }, { mode: 'range', rangeMode: 'traded', rangeTicks: 8, tick: 0.25 }]) {
    const a = new BB.TickStore(), b = new BB.TickStore();
    a.pushAll(OLD); b.pushAll(NEW);
    const ba = new BB.BarBuilder(opts), bb = new BB.BarBuilder(opts);
    a.feed(ba, 0); b.feed(bb, 0);
    assert.ok(ba.bars.length > 1, JSON.stringify(opts));
    assert.deepEqual(bars(bb), bars(ba), JSON.stringify(opts));
  }
});

test('live: a 0.3.4 tick message gives the page the same trade and delays as a 0.3.3 one', () => {
  // exactly as ChartBridge 0.3.4 formats it (OnMarketData), and as 0.3.3 did
  const newer = JSON.parse('{"type":"tick","root":"MNQ","t":1790661601.6,"u":1790679601600,"rx":1790679601623.5,"p":100.5,"v":1,"s":-1,"sm":2}');
  const older = JSON.parse('{"type":"tick","root":"MNQ","t":1790661601.6,"u":1790679601600,"rx":1790679601623.5,"p":100.5,"v":1}');
  const read = m => ({ t: m.t, p: m.p, v: m.v || 0, feed: m.rx - m.u, type: m.type, root: m.root });   // what live.js onTick reads
  assert.deepEqual(read(newer), read(older));
  const a = new BB.BarBuilder({ mode: 'time', seconds: 60 }), b = new BB.BarBuilder({ mode: 'time', seconds: 60 });
  for (const [m, builder] of [[older, a], [newer, b]]) builder.add(m.t, m.p, m.v || 0);
  assert.deepEqual(bars(b), bars(a));
});

test('the page reads live ticks by name and backfill trades by their first three places only', () => {
  const live = fs.readFileSync(path.join(__dirname, '..', 'live', 'live.js'), 'utf8');
  const bb = fs.readFileSync(path.join(__dirname, '..', 'live', 'bar-builder.js'), 'utf8');
  assert.match(live, /const t = m\.t, p = m\.p, v = m\.v \|\| 0;/, 'onTick reads t, p, v by name');
  assert.match(live, /D\.ticks\.pushAll\(m\.ticks\);/, 'the backfill goes to TickStore.pushAll');
  assert.match(bb, /pushAll\(list\) \{ for \(let i = 0; i < list\.length; i\+\+\) \{ const x = list\[i\]; this\.push\(x\[0\], x\[1\], x\[2\]\); \} \}/,
    'pushAll takes x[0], x[1], x[2] and nothing else');
  assert.ok(!/\.length\s*===?\s*3/.test(live.slice(live.indexOf("case 'ticks'"), live.indexOf("case 'ready'"))), 'no length check on a trade');
});

/* ---------------- the fake bridge speaks the new format (and the old with --no-sides) */
function wsConnect(port) {
  return new Promise((resolve, reject) => {
    // no Origin header: a local program (like The Desk's relay), which ChartBridge lets read without the page's PIN
    const req = http.request({ host: '127.0.0.1', port, path: '/ws', headers: { Host: 'localhost:' + port, Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') } });
    req.on('upgrade', (res, sock, head) => {
      const msgs = []; let buf = Buffer.alloc(0);
      const onData = d => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (buf.length < 2) break;
          let len = buf[1] & 0x7f, p = 2;
          if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); p = 4; }
          else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); p = 10; }
          if (buf.length < p + len) break;
          msgs.push(JSON.parse(buf.slice(p, p + len).toString('utf8'))); buf = buf.slice(p + len);
        }
      };
      sock.on('data', onData);
      if (head && head.length) onData(head);
      const send = obj => {
        const data = Buffer.from(JSON.stringify(obj)), mask = crypto.randomBytes(4);
        sock.write(Buffer.concat([Buffer.from([0x81, 0x80 | data.length]), mask, Buffer.from(data.map((x, i) => x ^ mask[i & 3]))]));
      };
      const until = async (ok, ms) => { const end = Date.now() + (ms || 5000); while (!ok() && Date.now() < end) await new Promise(r => setTimeout(r, 25)); return ok(); };
      resolve({ msgs, send, until, close: () => sock.destroy() });
    });
    req.on('response', res => { res.resume(); reject(new Error('WebSocket refused: ' + res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
}
async function startBridge(port, flags) {
  const child = spawn(process.execPath, [path.join(__dirname, 'fake-bridge.mjs'), String(port)].concat(flags), { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => child.stdout.once('data', r));
  return child;
}

// A port nobody is listening on, from the OS (fake-bridge.test.js picks random ports in 18700 to 19499).
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

async function load(flags) {
  const port = await freePort();
  const child = await startBridge(port, flags);
  try {
    const ws = await wsConnect(port);
    ws.send({ type: 'subscribe', root: 'MNQ', days: 1, tickHours: 2 });
    assert.ok(await ws.until(() => ws.msgs.some(m => m.type === 'ready')), 'ready');
    assert.ok(await ws.until(() => ws.msgs.some(m => m.type === 'tick' && m.root === 'MNQ')), 'a live tick');
    ws.close();
    return { ticks: ws.msgs.filter(m => m.type === 'ticks').flatMap(m => m.ticks), live: ws.msgs.filter(m => m.type === 'tick' && m.root === 'MNQ') };
  } finally { child.kill(); }
}

test('fake bridge: backfill trades are [t, p, v, s, sm] and live ticks carry s and sm; the page\'s TickStore takes them', async () => {
  const { ticks, live } = await load([]);
  assert.ok(ticks.length > 100);
  for (const x of ticks) {
    assert.equal(x.length, 5);
    assert.ok([-1, 0, 1].includes(x[3]) && [0, 2, 3].includes(x[4]), JSON.stringify(x));
    assert.ok((x[3] === 0) === (x[4] === 0), 'side 0 only with method 0: ' + JSON.stringify(x));
  }
  assert.ok(ticks.some(x => x[3] === 1) && ticks.some(x => x[3] === -1) && ticks.some(x => x[4] === 3));
  for (const m of live) assert.ok([-1, 0, 1].includes(m.s) && [0, 2, 3].includes(m.sm), JSON.stringify(m));
  const s = new BB.TickStore(); s.pushAll(ticks);
  assert.deepEqual(s.at(5), ticks[5].slice(0, 3));
});

test('fake bridge --no-sides: the 0.3.3 format ([t, p, v], no s or sm)', async () => {
  const { ticks, live } = await load(['--no-sides']);
  assert.ok(ticks.length > 100 && ticks.every(x => x.length === 3));
  assert.ok(live.every(m => !('s' in m) && !('sm' in m)));
});
