// A stand-in for the ChartBridge NT8 add-on, speaking nt8/PROTOCOL.md with sample data.
// For tests and offline work only; prices are NOT market data and no order reaches a broker.
//   node test/fake-bridge.mjs [port] [flags]      then open http://localhost:<port>/live/
// Flags (the config.txt keys of the real add-on):
//   --trading                       trading = true (off by default, like ChartBridge)
//   --trade-accounts=Sim101,DEMO-EVAL   tradeAccounts
//   --max-qty=MNQ:5,NQ:2            maxQty.MNQ = 5 and so on (default 1)
//   --v1                            behave like ChartBridge 0.2 (protocol v1, read only: no trading, no /session)
//   --test-controls                 POST /test/price?root=MNQ&p=25400.25 sets the price and holds the random walk;
//                                   /test/hold, /test/state, /test/status (broadcast a status line), /test/elsewhere
//   --allow-frames                  drop X-Frame-Options and frame-ancestors (only to test the page's own frame check)
// Order entry itself (gates, matching, brackets) is test/fake-orders.mjs.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { OrderDesk } from './fake-orders.mjs';

const require = createRequire(import.meta.url);
const CE = require('../src/chart-engine.js');
const SampleFeed = require('../demo/sample-feed.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = name => args.find(a => a === '--' + name || a.startsWith('--' + name + '='));
const flagValue = name => { const a = flag(name); return a && a.includes('=') ? a.slice(a.indexOf('=') + 1) : ''; };
const PORT = +(args.find(a => /^\d+$/.test(a)) || process.env.PORT || 8765);
const V1 = !!flag('v1'), TEST_CONTROLS = !!flag('test-controls'), ALLOW_FRAMES = !!flag('allow-frames');
const config = {
  trading: !V1 && !!flag('trading'),
  tradeAccounts: flagValue('trade-accounts').split(',').map(x => x.trim()).filter(Boolean),
  maxQty: Object.fromEntries(flagValue('max-qty').split(',').filter(Boolean).map(x => { const [r, n] = x.split(':'); return [r.trim(), +n]; })),
  port: PORT,
};
const ACCOUNTS = ['DEMO-EVAL', 'DEMO-EMPTY', 'Sim101'];

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

// a new random session token each start, served same-origin at GET /session (gate 4)
const desk = new OrderDesk({
  config, instruments: INSTR, knownAccounts: ACCOUNTS, token: crypto.randomBytes(24).toString('base64url'),
  send, conns: () => clients, barTime: () => etNow(),
});

function onMessage(c, text) {
  let m; try { m = JSON.parse(text); } catch (e) { return; }
  if (V1) { if (m.type === 'subscribe') subscribe(c, m); return; }       // 0.2 ignores everything else
  if (m.type === 'subscribe') subscribe(c, m);
  else if (m.type === 'auth') desk.auth(c, m.token);
  else if (['order', 'change', 'cancel', 'flatten'].includes(m.type)) desk.handle(c, m);
}
function subscribe(c, m) {
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

const last = {}, held = {};
for (const r of Object.keys(INSTR)) { last[r] = data[r][data[r].length - 1].c; desk.tick(r, last[r]); }
function trade(r, p) {
  last[r] = p;
  const now = Date.now();
  const msg = { type: 'tick', root: r, t: +etNow().toFixed(3), u: now - 20 - Math.random() * 30, rx: now, p, v: 1 + Math.floor(Math.random() * 5) };
  for (const c of clients) if (c.ready && c.root === r) send(c, msg);
  desk.tick(r, p);                        // the matching engine sees every trade
}
setInterval(() => {
  for (const r of Object.keys(INSTR)) trade(r, held[r] ? last[r] : rq(last[r] + (Math.random() - 0.5) * 1.5, 0.25));
}, 120);

const fillsSample = () => {
  const b = data.MNQ, n = b.length;
  return [
    { account: 'Sim101', name: 'MNQ 12-26', root: 'MNQ', side: 'buy', qty: 2, p: b[n - 30].l, t: b[n - 30].t + 20, u: 0, id: 'x1', order: 'o1' },
    { account: 'Sim101', name: 'MNQ 12-26', root: 'MNQ', side: 'sell', qty: 2, p: b[n - 22].h, t: b[n - 22].t + 40, u: 0, id: 'x2', order: 'o2' },
    { account: 'DEMO-EVAL', name: 'MNQ 12-26', root: 'MNQ', side: 'sell', qty: 1, p: b[n - 12].h, t: b[n - 12].t + 10, u: 0, id: 'x3', order: 'o3' },
    { account: 'DEMO-EVAL', name: 'MNQ 12-26', root: 'MNQ', side: 'buy', qty: 1, p: b[n - 8].l, t: b[n - 8].t + 30, u: 0, id: 'x4', order: 'o4' },
  ];
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  // clickjacking: ChartBridge's page may never sit in another page's frame (protocol v2)
  if (!V1 && !ALLOW_FRAMES) { res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Content-Security-Policy', "frame-ancestors 'none'"); }
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') { res.writeHead(302, { Location: '/live/' }); return res.end(); }
  if (p === '/session' && !V1) {
    // same-origin only: no CORS headers, and (like HttpListener's localhost prefix) only Host localhost:<port>
    if (req.headers.host !== 'localhost:' + PORT) { res.writeHead(400); return res.end('bad host'); }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ token: desk.token }));
  }
  if (p.startsWith('/test/') && TEST_CONTROLS && req.method === 'POST') {
    const q = new URL(req.url, 'http://x').searchParams, r = q.get('root') || 'MNQ';
    if (p === '/test/price') { held[r] = true; trade(r, rq(+q.get('p'), INSTR[r].tick)); }
    else if (p === '/test/hold') held[r] = q.get('on') !== '0';
    else if (p === '/test/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ last: last[r], orders: [...desk.orders.values()].filter(o => o.state === 'working' || o.state === 'partFilled').map(o => desk.orderMsg(o)),
        positions: Object.fromEntries(desk.positions) }));
    }
    else if (p === '/test/status') { for (const c of clients) send(c, { type: 'status', level: q.get('level') || 'error', text: q.get('text') || '' }); }
    else if (p === '/test/elsewhere') desk.placeElsewhere({ account: q.get('account'), root: r, side: q.get('side'), kind: q.get('kind'), qty: +q.get('qty'), price: +q.get('p') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ root: r, last: last[r], held: !!held[r] }));
  }
  if (p === '/diag') {   // same shape as ChartBridge's /diag, sample values
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ version: 'fake-0.2.0', clockOffsetMs: 0, fillEventsDelivered: 0, fillsFoundByPolling: 0, lastPollUtcMs: Date.now(), clients: clients.size,
      desk: { postFills: false, deskUrl: 'http://localhost:8800', waiting: 0, lastSendFailed: false, lastError: '' },
      accounts: ACCOUNTS.map(name => ({ name, connection: 'Connected', executions: fillsSample().filter(f => f.account === name).length, orders: 0, positions: 0, fillEvents: 0, orderEvents: 0, positionEvents: 0 })) }));
  }
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
  const c = { sock, root: null, ready: false, buf: Buffer.alloc(0), origin: req.headers.origin || null, authed: false, actions: [] };
  clients.add(c);
  const hello = { type: 'hello', version: V1 ? 'fake-0.2.1' : 'fake-0.3.0', now: Date.now(), instruments: Object.entries(INSTR).map(([r, i]) => ({ root: r, name: i.name, tick: i.tick, pointValue: i.pointValue })), accounts: ACCOUNTS };
  if (!V1) hello.trading = desk.helloTrading(c);
  send(c, hello);
  send(c, { type: 'execs', list: fillsSample() });
  sock.on('data', d => {
    const r = parseFrames(Buffer.concat([c.buf, d]), t => onMessage(c, t));
    c.buf = r.rest; if (r.closed) sock.end();
  });
  sock.on('close', () => clients.delete(c));
  sock.on('error', () => clients.delete(c));
});
server.listen(PORT, '127.0.0.1', () => console.log('fake ChartBridge on http://localhost:' + PORT + '/live/' +
  (V1 ? ' (v1, read only)' : config.trading ? ' (trading on: ' + desk.accounts.join(', ') + ')' : ' (trading off)')));
