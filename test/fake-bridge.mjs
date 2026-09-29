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
//   --allow-origins=https://desk.example,http://host:8800   allowOrigins: other web pages that may open the
//                                   read-only WebSocket (ChartBridge 0.3.1 rule; never trade)
//   --tick-hours-max=3              serve at most this many hours of tick history, whatever the page asks
//                                   (like a PC with little local tick data)
//   --tick-gaps                     tick history skips prices now and then (1 to 3 ticks, sometimes a fast 8 to 16),
//                                   like a fast market, so the two range bar modes differ (sample data, seeded)
//   --tickets                       like The Desk's relay: /ws needs ?ticket=<t>, and each ticket works once
//                                   (a missing or reused one is refused), so every reconnect needs a fresh URL.
//                                   A ticketed connection stands for the relay, which reaches ChartBridge with no
//                                   Origin, so ChartBridge's PIN does not apply to it (the relay has its own gate)
//   --pin-file=path                 where the PIN hash lives (ChartBridge 0.3.2 keeps pin.txt in its folder), so a
//                                   restarted fake keeps the PIN and an open page's unlock; default: memory only
//   --test-pin=2468                 start with this made-up PIN set (tests only), unless the pin file has one
//   --pin-off                       behave like ChartBridge 0.3.1 for the PIN only (no /pin/, nothing gated), to
//                                   measure a page from a checkout older than the PIN (perf-live --root)
// ChartBridge 0.3.2's PIN (test/fake-pin.mjs): the page's WebSocket needs ?unlock=<token> and GET /session the
// X-ChartBridge-Unlock header; POST /pin/status, /pin/set, /pin/unlock, /pin/change. --v1 has no PIN.
// With --test-controls, also: /test/drop closes every WebSocket (a dropped connection); /test/received lists
// what the pages sent (message types, GET /session count, WebSocket URLs, ticketsRefused).
// Load and performance testing (test/perf-live.mjs); sample data, seeded, never market data:
//   --tick-rate=15                  tick history this dense: 15 trades a second on average (weighted by each
//                                   minute's volume), so 33 hours of NQ come to about 1.8 million ticks
//   --live-rate=100                 live trades per second on average, with a burst of 3 times that for 1.5 s in
//                                   every 10 s (a busy market), instead of one trade every 120 ms
//   --serve-root=DIR                serve the page files from another checkout (to compare versions)
//   --clock-offset=-45000           run the exchange clock this many seconds off the PC's (a chosen time of day)
// Order entry itself (gates, matching, brackets) is test/fake-orders.mjs.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { OrderDesk } from './fake-orders.mjs';
import { PinLock, HEADER as PIN_HEADER } from './fake-pin.mjs';

const require = createRequire(import.meta.url);
const CE = require('../src/chart-engine.js');
const SampleFeed = require('../demo/sample-feed.js');
const root = flagValueEarly('serve-root') ? path.resolve(flagValueEarly('serve-root')) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function flagValueEarly(name) { const a = process.argv.slice(2).find(x => x.startsWith('--' + name + '=')); return a ? a.slice(a.indexOf('=') + 1) : ''; }
const args = process.argv.slice(2);
const flag = name => args.find(a => a === '--' + name || a.startsWith('--' + name + '='));
const flagValue = name => { const a = flag(name); return a && a.includes('=') ? a.slice(a.indexOf('=') + 1) : ''; };
const PORT = +(args.find(a => /^\d+$/.test(a)) || process.env.PORT || 8765);
const PIN_OFF = !!flag('pin-off');
const V1 = !!flag('v1'), TEST_CONTROLS = !!flag('test-controls'), ALLOW_FRAMES = !!flag('allow-frames'), TICK_GAPS = !!flag('tick-gaps'), TICKETS = !!flag('tickets');
const TICK_HOURS_MAX = flagValue('tick-hours-max') ? +flagValue('tick-hours-max') : Infinity;
const TICK_RATE = +flagValue('tick-rate') || 0, LIVE_RATE = +flagValue('live-rate') || 0;
const config = {
  trading: !V1 && !!flag('trading'),
  tradeAccounts: flagValue('trade-accounts').split(',').map(x => x.trim()).filter(Boolean),
  maxQty: Object.fromEntries(flagValue('max-qty').split(',').filter(Boolean).map(x => { const [r, n] = x.split(':'); return [r.trim(), +n]; })),
  port: PORT,
  // ChartBridge 0.3.1: exact scheme://host[:port], lower-cased (the real parser also drops a default port and
  // a trailing slash, and skips wildcards; the fake takes the list as given)
  allowOrigins: flagValue('allow-origins').split(',').map(x => x.trim().toLowerCase().replace(/\/$/, '')).filter(Boolean),
};
const ACCOUNTS = ['DEMO-EVAL', 'DEMO-EMPTY', 'Sim101'];
const pin = new PinLock({ file: flagValue('pin-file') || null });
const pinReady = flagValue('test-pin') && !pin.isSet() ? pin.set(flagValue('test-pin')) : Promise.resolve();
const OWN = 'http://localhost:' + PORT;

const CLOCK_OFFSET = +flagValue('clock-offset') || 0;
const etNow = () => CE.util.zoneSeconds(Date.now() / 1000 + CLOCK_OFFSET);
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
  let seed = 7;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const stepTicks = () => { if (!TICK_GAPS) return 1; const r = rnd(); return r < 0.8 ? 1 : r < 0.97 ? 2 + Math.floor(rnd() * 2) : 8 + Math.floor(rnd() * 9); };
  for (const b of bars) {
    if (b.t < from) continue;
    // walk open -> low -> high -> close (or the other way) one tick at a time, like real trades
    const way = b.c >= b.o ? [b.o, b.l, b.h, b.c] : [b.o, b.h, b.l, b.c];
    const prices = [way[0]];
    for (let s = 1; s < way.length; s++) {
      let p = prices[prices.length - 1];
      const dir = way[s] > p ? 1 : -1;
      while (Math.abs(way[s] - p) > 1e-9) { const left = Math.round(Math.abs(way[s] - p) / 0.25); p = rq(p + dir * 0.25 * Math.min(left, stepTicks()), 0.25); prices.push(p); }
    }
    if (TICK_RATE) pad(prices, b, Math.round(TICK_RATE * 60 * b.v / avgVol(bars)), rnd);
    const v = Math.max(1, Math.round(b.v / prices.length));
    prices.forEach((p, i) => out.push([+(b.t + i * 59.9 / prices.length).toFixed(3), p, v]));
  }
  return out;
}
/* --tick-rate: fill a minute's walk up to n trades with trades at the same price or one tick away, inside the bar */
function pad(prices, b, n, rnd) {
  const extra = n - prices.length;
  if (extra <= 0) return;
  const out = [];
  const every = extra / prices.length;
  let owe = 0;
  for (const p of prices) {
    out.push(p);
    for (owe += every; owe >= 1; owe--) {
      const r = rnd(), q = r < 0.6 ? p : r < 0.8 ? p + 0.25 : p - 0.25;
      out.push(q > b.h || q < b.l ? p : q);
    }
  }
  prices.splice(0, prices.length, ...out);
}
let avgVolCache = new WeakMap();
function avgVol(bars) {
  let a = avgVolCache.get(bars);
  if (a === undefined) { a = bars.reduce((s, b) => s + b.v, 0) / bars.length || 1; avgVolCache.set(bars, a); }
  return a;
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

// ChartBridge 0.3.1 network rules (nt8/PROTOCOL.md, "Network access"): only this PC, and a browser WebSocket
// only from ChartBridge's own page or allowOrigins. No Origin header (a local program) is allowed.
const isLoopback = a => /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(String(a || ''));
function wsOriginAllowed(origin) {
  if (origin === undefined) return true;
  const o = String(origin).trim().toLowerCase();
  if (!o || o === 'null') return false;
  return o === 'http://localhost:' + PORT || config.allowOrigins.includes(o);
}
const refused = { notThisPc: 0, origin: 0 };

const clients = new Set();
const received = { types: {}, sessionRequests: 0, urls: [], ticketsRefused: 0, pinRefused: 0 };   // for /test/received (no PIN or token ever in it)
const ticketsUsed = new Set();
function send(c, obj) { if (!c.sock.destroyed) c.sock.write(frame(JSON.stringify(obj))); }

// a new random session token each start, served same-origin at GET /session (gate 4)
const desk = new OrderDesk({
  config, instruments: INSTR, knownAccounts: ACCOUNTS, token: crypto.randomBytes(24).toString('base64url'),
  send, conns: () => clients, barTime: () => etNow(),
});

function onMessage(c, text) {
  let m; try { m = JSON.parse(text); } catch (e) { return; }
  const type = m && typeof m.type === 'string' ? m.type : '?';
  received.types[type] = (received.types[type] || 0) + 1;
  if (V1) { if (m.type === 'subscribe') subscribe(c, m); return; }       // 0.2 ignores everything else
  if (m.type === 'subscribe') subscribe(c, m);
  else if (m.type === 'auth') desk.auth(c, m.token);
  else if (['order', 'change', 'cancel', 'flatten'].includes(m.type)) desk.handle(c, m);
}
const tickCache = new Map();             // --tick-rate: millions of ticks, made once per root and hours
function subscribe(c, m) {
  const r = INSTR[m.root] ? m.root : 'MNQ';
  c.root = r; c.ready = false;
  const bars = data[r];
  for (let i = 0; i < bars.length; i += 4000) {
    const chunk = bars.slice(i, i + 4000).map(b => [b.t, b.o, b.h, b.l, b.c, b.v]);
    send(c, { type: 'history', root: r, name: INSTR[r].name, barSeconds: 60, bars: chunk, done: i + 4000 >= bars.length });
  }
  const hours = Math.min(TICK_HOURS_MAX, m.tickHours === undefined ? 8 : m.tickHours), key = r + '|' + hours;
  const ticks = TICK_RATE ? (tickCache.get(key) || tickCache.set(key, ticksFrom(bars, hours)).get(key)) : ticksFrom(bars, hours);
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
if (!LIVE_RATE) setInterval(() => {
  for (const r of Object.keys(INSTR)) trade(r, held[r] ? last[r] : rq(last[r] + (Math.random() - 0.5) * 1.5, 0.25));
}, 120);
else {
  // --live-rate: a busy market. Every 10 ms a Poisson number of trades; mostly 0 or 1 tick apart, and a fast jump of
  // 8 to 16 ticks now and then (NinjaTrader-style range bars then add phantom bars). Seeded, so runs compare.
  let seed = 424242;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const poisson = mean => { let k = 0, p = Math.exp(-mean), s = p; const u = rnd(); while (u > s && k < 200) { k++; p *= mean / k; s += p; } return k; };
  const t0 = Date.now();
  setInterval(() => {
    const burst = ((Date.now() - t0) % 10000) < 1500 ? 3 : 1;
    for (const r of Object.keys(INSTR)) {
      if (held[r] || ![...clients].some(c => c.ready && c.root === r)) continue;
      const n = poisson(LIVE_RATE * burst / 100);
      for (let k = 0; k < n; k++) {
        const u = rnd(), steps = u < 0.0005 ? 8 + Math.floor(rnd() * 9) : u < 0.5 ? 0 : 1;
        trade(r, rq(last[r] + (rnd() < 0.5 ? -1 : 1) * steps * INSTR[r].tick, INSTR[r].tick));
      }
    }
  }, 10);
}

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
  if (!V1 && !isLoopback(req.socket.remoteAddress)) { refused.notThisPc++; res.writeHead(403); return res.end(); }   // first, before any routing
  // clickjacking: ChartBridge's page may never sit in another page's frame (protocol v2)
  if (!V1 && !ALLOW_FRAMES) { res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Content-Security-Policy', "frame-ancestors 'none'"); }
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') { res.writeHead(302, { Location: '/live/' }); return res.end(); }
  if (p === '/session') received.sessionRequests++;
  if (p === '/session' && !V1) {
    // same-origin only: no CORS headers, and (like HttpListener's localhost prefix) only Host localhost:<port>
    if (req.headers.host !== 'localhost:' + PORT) { res.writeHead(400); return res.end('bad host'); }
    if (!PIN_OFF && !pin.tokenValid(req.headers[PIN_HEADER])) { res.writeHead(403); return res.end(); }   // 0.3.2: only for a page unlocked with the PIN
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ token: desk.token }));
  }
  if (p.startsWith('/pin/') && !V1 && !PIN_OFF) return pin.handle(req, res, PORT);
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
    else if (p === '/test/drop') { for (const c of clients) c.sock.destroy(); }
    else if (p === '/test/received') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(received)); }
    else if (p === '/test/elsewhere') desk.placeElsewhere({ account: q.get('account'), root: r, side: q.get('side'), kind: q.get('kind'), qty: +q.get('qty'), price: +q.get('p') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ root: r, last: last[r], held: !!held[r] }));
  }
  if (p === '/diag') {   // same shape as ChartBridge's /diag, sample values
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ version: 'fake-0.2.0', clockOffsetMs: 0, fillEventsDelivered: 0, fillsFoundByPolling: 0, lastPollUtcMs: Date.now(), clients: clients.size,
      desk: { postFills: false, deskUrl: 'http://localhost:8800', waiting: 0, lastSendFailed: false, lastError: '' },
      ...(V1 ? {} : { network: { loopbackOnly: true, allowOrigins: ['http://localhost:' + PORT].concat(config.allowOrigins), refusedNotThisPc: refused.notThisPc, refusedOrigin: refused.origin },
        pin: { set: pin.isSet() } }),
      accounts: ACCOUNTS.map(name => ({ name, connection: 'Connected', executions: fillsSample().filter(f => f.account === name).length, orders: 0, positions: 0, fillEvents: 0, orderEvents: 0, positionEvents: 0 })) }));
  }
  if (p.endsWith('/')) p += 'index.html';
  const full = path.join(root, p);
  if (!full.startsWith(root) || !fs.existsSync(full)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(full).pipe(res);
});
server.on('upgrade', (req, sock) => {
  if (!V1 && !isLoopback(req.socket.remoteAddress)) { refused.notThisPc++; sock.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return; }
  if (!req.url.startsWith('/ws')) { sock.destroy(); return; }
  if (!V1 && !wsOriginAllowed(req.headers.origin)) { refused.origin++; sock.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return; }
  if (TICKETS) {
    const ticket = new URL(req.url, 'http://x').searchParams.get('ticket');
    if (!ticket || ticketsUsed.has(ticket)) { received.ticketsRefused++; sock.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return; }
    ticketsUsed.add(ticket);
  }
  const unlock = new URL(req.url, 'http://x').searchParams.get('unlock');
  if (!V1 && !TICKETS && !PIN_OFF && !pin.wsUnlocked(req.headers.origin, unlock, OWN)) { received.pinRefused++; sock.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return; }
  received.urls.push(req.url.replace(/([?&]unlock=)[^&]*/, '$1(hidden)'));
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const c = { sock, root: null, ready: false, buf: Buffer.alloc(0), origin: req.headers.origin || null, authed: false, actions: [] };
  clients.add(c);
  const hello = { type: 'hello', version: V1 ? 'fake-0.2.1' : 'fake-0.3.2', now: Date.now(), instruments: Object.entries(INSTR).map(([r, i]) => ({ root: r, name: i.name, tick: i.tick, pointValue: i.pointValue })), accounts: ACCOUNTS };
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
pinReady.then(() => server.listen(PORT, '127.0.0.1', () => console.log('fake ChartBridge on http://localhost:' + PORT + '/live/' +
  (V1 ? ' (v1, read only)' : (config.trading ? ' (trading on: ' + desk.accounts.join(', ') + ')' : ' (trading off)') + (pin.isSet() ? ' (PIN set)' : ' (no PIN set)')))));
