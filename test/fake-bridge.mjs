// A stand-in for the ChartBridge NT8 add-on, speaking nt8/PROTOCOL.md with sample data.
// For tests and offline work only; prices are NOT market data.
//   node test/fake-bridge.mjs [port]      then open http://localhost:<port>/live/
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CE = require('../src/chart-engine.js');
const SampleFeed = require('../demo/sample-feed.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.argv[2] || process.env.PORT || 8765);

const etNow = () => CE.util.zoneSeconds(Date.now() / 1000);
const INSTR = {
  MNQ: { name: 'MNQ 12-26', tick: 0.25, pointValue: 2, scale: 1 },
  NQ: { name: 'NQ 12-26', tick: 0.25, pointValue: 20, scale: 1 },
  MES: { name: 'MES 12-26', tick: 0.25, pointValue: 5, scale: 0.26 },
  ES: { name: 'ES 12-26', tick: 0.25, pointValue: 50, scale: 0.26 },
};
const rq = (p, t) => Math.round(p / t) * t;

// Sample history shifted so its last bar is the current minute.
function makeData(rootSym) {
  const feed = SampleFeed.create({ seed: 20260929 + rootSym.length });
  const k = INSTR[rootSym].scale;
  const base = feed.base.slice(0, -1);
  const shift = Math.floor(etNow() / 60) * 60 - base[base.length - 1].t;
  const bars = base.map(b => ({ t: b.t + shift, o: rq(b.o * k, 0.25), h: rq(b.h * k, 0.25), l: rq(b.l * k, 0.25), c: rq(b.c * k, 0.25), v: b.v }));
  for (const b of bars) { b.h = Math.max(b.h, b.o, b.c); b.l = Math.min(b.l, b.o, b.c); }
  return bars;
}
function ticksFrom(bars, hours) {
  const out = [], from = bars[bars.length - 1].t - hours * 3600;
  for (const b of bars) {
    if (b.t < from) continue;
    // walk open -> low -> high -> close (or the other way) one tick at a time, like real trades
    const way = b.c >= b.o ? [b.o, b.l, b.h, b.c] : [b.o, b.h, b.l, b.c];
    const prices = [way[0]];
    for (let s = 1; s < way.length; s++) {
      let p = prices[prices.length - 1];
      const step = way[s] > p ? 0.25 : -0.25;
      while (Math.abs(way[s] - p) > 1e-9) { p = rq(p + step, 0.25); prices.push(p); }
    }
    const v = Math.max(1, Math.round(b.v / prices.length));
    prices.forEach((p, i) => out.push([+(b.t + i * 59.9 / prices.length).toFixed(3), p, v]));
  }
  return out;
}

const data = {};
for (const r of Object.keys(INSTR)) data[r] = makeData(r);

// ---------------------------------------------------------------- tiny WebSocket server
function frame(text) {
  const payload = Buffer.from(text);
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x81, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}
function parseFrames(buf, onText) {
  let off = 0;
  while (buf.length - off >= 2) {
    const op = buf[off] & 0x0f, masked = buf[off + 1] & 0x80;
    let len = buf[off + 1] & 0x7f, p = off + 2;
    if (len === 126) { if (buf.length < p + 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length < p + 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    const mask = masked ? buf.slice(p, p + 4) : null; if (masked) p += 4;
    if (buf.length < p + len) break;
    const data = Buffer.from(buf.slice(p, p + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    if (op === 1) onText(data.toString('utf8'));
    if (op === 8) return { rest: Buffer.alloc(0), closed: true };
    off = p + len;
  }
  return { rest: buf.slice(off), closed: false };
}

const clients = new Set();
function send(c, obj) { if (!c.sock.destroyed) c.sock.write(frame(JSON.stringify(obj))); }

function onMessage(c, text) {
  let m; try { m = JSON.parse(text); } catch (e) { return; }
  if (m.type !== 'subscribe') return;
  const r = INSTR[m.root] ? m.root : 'MNQ';
  c.root = r; c.ready = false;
  const bars = data[r];
  for (let i = 0; i < bars.length; i += 4000) {
    const chunk = bars.slice(i, i + 4000).map(b => [b.t, b.o, b.h, b.l, b.c, b.v]);
    send(c, { type: 'history', root: r, name: INSTR[r].name, barSeconds: 60, bars: chunk, done: i + 4000 >= bars.length });
  }
  const ticks = ticksFrom(bars, m.tickHours === undefined ? 8 : m.tickHours);
  for (let i = 0; i < ticks.length || i === 0; i += 20000) {
    send(c, { type: 'ticks', root: r, ticks: ticks.slice(i, i + 20000), done: i + 20000 >= ticks.length });
    if (!ticks.length) break;
  }
  send(c, { type: 'ready', root: r });
  c.ready = true;
}

const last = {};
for (const r of Object.keys(INSTR)) last[r] = data[r][data[r].length - 1].c;
setInterval(() => {
  for (const r of Object.keys(INSTR)) {
    last[r] = rq(last[r] + (Math.random() - 0.5) * 1.5, 0.25);
    const now = Date.now();
    const msg = { type: 'tick', root: r, t: +etNow().toFixed(3), u: now - 20 - Math.random() * 30, rx: now, p: last[r], v: 1 + Math.floor(Math.random() * 5) };
    for (const c of clients) if (c.ready && c.root === r) send(c, msg);
  }
}, 120);

const fillsSample = () => {
  const b = data.MNQ, n = b.length;
  return [
    { account: 'Sim101', name: 'MNQ 12-26', root: 'MNQ', side: 'buy', qty: 2, p: b[n - 30].l, t: b[n - 30].t + 20, u: 0, id: 'x1', order: 'o1' },
    { account: 'Sim101', name: 'MNQ 12-26', root: 'MNQ', side: 'sell', qty: 2, p: b[n - 22].h, t: b[n - 22].t + 40, u: 0, id: 'x2', order: 'o2' },
  ];
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') { res.writeHead(302, { Location: '/live/' }); return res.end(); }
  if (p.endsWith('/')) p += 'index.html';
  const full = path.join(root, p);
  if (!full.startsWith(root) || !fs.existsSync(full)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(full).pipe(res);
});
server.on('upgrade', (req, sock) => {
  if (!req.url.startsWith('/ws')) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const c = { sock, root: null, ready: false, buf: Buffer.alloc(0) };
  clients.add(c);
  send(c, { type: 'hello', version: 'fake-0.1.0', now: Date.now(), instruments: Object.entries(INSTR).map(([r, i]) => ({ root: r, name: i.name, tick: i.tick, pointValue: i.pointValue })), accounts: ['Sim101'] });
  send(c, { type: 'execs', list: fillsSample() });
  sock.on('data', d => {
    const r = parseFrames(Buffer.concat([c.buf, d]), t => onMessage(c, t));
    c.buf = r.rest; if (r.closed) sock.end();
  });
  sock.on('close', () => clients.delete(c));
  sock.on('error', () => clients.delete(c));
});
server.listen(PORT, '127.0.0.1', () => console.log('fake ChartBridge on http://localhost:' + PORT + '/live/'));
