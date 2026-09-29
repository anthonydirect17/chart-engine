'use strict';
// The fake bridge's order entry (test/fake-orders.mjs) is the reference for ChartBridge protocol v2:
// every safety gate refused with its reason, the matching engine, brackets, flatten, and (through the
// real fake server) the Origin and session token checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const INSTR = { MNQ: { name: 'MNQ 12-26', tick: 0.25, pointValue: 2 }, ES: { name: 'ES 12-26', tick: 0.25, pointValue: 50 } };
const KNOWN = ['Sim101', 'DEMO-EVAL', 'DEMO-OTHER', 'Playback101', 'Backtest'];

async function makeDesk(cfg) {
  const { OrderDesk } = await import('./fake-orders.mjs');
  let clock = 1000000;
  const out = [];
  const conn = { origin: 'http://localhost:8765', authed: false, actions: [] };
  const desk = new OrderDesk({
    config: Object.assign({ trading: true, tradeAccounts: ['Sim101', 'DEMO-EVAL'], maxQty: { MNQ: 5 }, port: 8765 }, cfg || {}),
    instruments: INSTR, knownAccounts: KNOWN, token: 'tok-123',
    send: (c, m) => out.push(m), conns: () => [conn], now: () => clock, barTime: () => clock / 1000,
  });
  desk.tick('MNQ', 25400); desk.tick('ES', 6500);
  const d = {
    desk, conn, out,
    advance(ms) { clock += ms; },
    take(type) { const r = out.filter(m => !type || m.type === type); out.length = 0; return r; },
    auth() { desk.auth(conn, 'tok-123'); return d.take(); },
    act(m) { clock += 150; desk.handle(conn, m); return d.take(); },   // 150 ms apart: under the rate limit
    order(f) { return d.act(Object.assign({ type: 'order', cid: 'c' + Math.random().toString(36).slice(2, 7), account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'market', qty: 1 }, f)); },
    working() { return [...desk.orders.values()].filter(o => o.state === 'working' || o.state === 'partFilled'); },
    pos(account, root) { return desk.pos(account || 'Sim101', root || 'MNQ'); },
    tick(p, root) { desk.tick(root || 'MNQ', p); return d.take(); },
  };
  return d;
}
const reasonOf = msgs => { const r = msgs.find(m => m.type === 'reject'); return r ? r.reason : null; };

test('gate 1: trading off in config.txt refuses auth and every order', async () => {
  const d = await makeDesk({ trading: false });
  const t = d.auth().find(m => m.type === 'trading');
  assert.equal(t.enabled, false);
  assert.match(t.reason, /Trading is off/);
  assert.deepEqual(t.accounts, []);
  assert.match(reasonOf(d.order({})), /Trading is off/);
  assert.equal(d.desk.orders.size, 0);
});

test('hello carries trading disabled until auth; auth answers trading, orders and positions', async () => {
  const d = await makeDesk();
  const h = d.desk.helloTrading(d.conn);
  assert.equal(h.enabled, false); assert.match(h.reason, /not signed in/);
  assert.match(reasonOf(d.order({})), /not signed in/);           // an order before auth
  const msgs = d.auth();
  assert.deepEqual(msgs.map(m => m.type), ['trading', 'orders']);
  assert.deepEqual(msgs[0], { type: 'trading', enabled: true, accounts: ['Sim101', 'DEMO-EVAL'], maxQty: { '*': 1, MNQ: 5 } });
});

test('gate 4: a wrong token or another page (Origin) cannot trade', async () => {
  const d = await makeDesk();
  d.desk.auth(d.conn, 'nope');
  assert.match(d.take('trading')[0].reason, /session token does not match/);
  assert.match(reasonOf(d.order({})), /not signed in/);
  const other = await makeDesk();
  other.conn.origin = 'http://evil.example';
  const t = other.auth()[0];
  assert.equal(t.enabled, false); assert.match(t.reason, /ChartBridge's own page \(http:\/\/localhost:8765\)/);
  other.conn.authed = true;                                           // even if something marked it signed in
  assert.match(reasonOf(other.order({})), /own page/);
});

test('gate 2: account allow-list, never Backtest or Playback, no wildcard', async () => {
  const { allowedAccounts } = await import('./fake-orders.mjs');
  assert.deepEqual(allowedAccounts(['Sim101', 'Playback101', 'Backtest', 'DEMO-*', '*', 'NotThere', ' DEMO-EVAL '], KNOWN), ['Sim101', 'DEMO-EVAL']);
  const d = await makeDesk(); d.auth();
  assert.match(reasonOf(d.order({ account: 'DEMO-OTHER' })), /Account DEMO-OTHER is not allowed/);
  assert.match(reasonOf(d.order({ account: 'Playback101' })), /not allowed/);
  assert.match(reasonOf(d.act({ type: 'flatten', account: 'DEMO-OTHER', root: 'MNQ' })), /not allowed/);
  const none = await makeDesk({ tradeAccounts: ['Backtest'] });
  assert.match(none.auth()[0].reason, /No account is allowed/);
});

test('gate 3: qty cap per root (default 1), and the cap also limits the position a new order could build', async () => {
  const d = await makeDesk(); d.auth();
  assert.match(reasonOf(d.order({ qty: 6 })), /^Qty 6 is over the MNQ cap of 5 \(maxQty\.MNQ in config\.txt\)\.$/);
  assert.match(reasonOf(d.order({ root: 'ES', qty: 2 })), /over the ES cap of 1/);
  assert.match(reasonOf(d.order({ qty: 0 })), /whole number/);
  assert.match(reasonOf(d.order({ qty: 1.5 })), /whole number/);
  assert.equal(reasonOf(d.order({ qty: 3 })), null);                   // long 3
  assert.match(reasonOf(d.order({ qty: 3 })), /could take the MNQ position on Sim101 to 6/);
  assert.equal(reasonOf(d.order({ qty: 2, kind: 'limit', price: 25390 })), null);   // 3 + 2 working = 5
  assert.match(reasonOf(d.order({ qty: 1, kind: 'limit', price: 25380 })), /to 6/);
  assert.equal(reasonOf(d.order({ side: 'sell', qty: 5 })), null);    // selling reduces: allowed
});

test('gate 5: tick grid, 200 ticks from the last price, stops on the right side (orders and changes)', async () => {
  const d = await makeDesk(); d.auth();
  assert.match(reasonOf(d.order({ kind: 'limit', price: 25390.1 })), /not on the MNQ tick grid/);
  assert.match(reasonOf(d.order({ kind: 'limit', price: 25349.75 })), /201 ticks from the last price 25,400.00; the limit is 200/);
  assert.equal(reasonOf(d.order({ kind: 'limit', price: 25350 })), null);           // exactly 200
  assert.match(reasonOf(d.order({ kind: 'stop', price: 25399.75 })), /buy stop must be above/);
  assert.match(reasonOf(d.order({ kind: 'stop', price: 25400 })), /buy stop must be above/);
  assert.match(reasonOf(d.order({ kind: 'stop', side: 'sell', price: 25400.25 })), /sell stop must be below/);
  assert.match(reasonOf(d.order({ kind: 'limit' })), /needs a price/);
  const id = [...d.desk.orders.values()].find(o => o.kind === 'limit').id;
  assert.match(reasonOf(d.act({ type: 'change', id, price: 25300 })), /400 ticks/);
  assert.match(reasonOf(d.act({ type: 'change', id: 'NT999', price: 25390 })), /No working order NT999/);
  const rej = d.act({ type: 'change', id: 'NT999', price: 25390 }).find(m => m.type === 'reject');
  assert.equal(rej.id, 'NT999');
});

test('gate 6: only the roots ChartBridge serves', async () => {
  const d = await makeDesk(); d.auth();
  assert.match(reasonOf(d.order({ root: 'CL' })), /CL is not an instrument ChartBridge serves/);
});

test('gate 7: more than 10 order actions in one second are refused, and the reject carries the cid', async () => {
  const d = await makeDesk({ maxQty: { MNQ: 50 } }); d.auth();
  const res = [];
  for (let i = 0; i < 12; i++) { d.advance(50); d.desk.handle(d.conn, { type: 'order', cid: 'r' + i, account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'limit', qty: 1, price: 25390 }); res.push(d.take('reject')[0] || null); }
  assert.equal(res.slice(0, 10).filter(Boolean).length, 0);
  assert.deepEqual(res[10], { type: 'reject', cid: 'r10', reason: 'More than 10 order actions in one second. Slow down.' });
  d.advance(1100);
  assert.equal(reasonOf(d.order({ kind: 'limit', price: 25390 })), null);
});

test('market order fills at the last price: order, exec and position messages', async () => {
  const d = await makeDesk(); d.auth();
  const msgs = d.order({ cid: 'm1', qty: 2 });
  assert.deepEqual(msgs.map(m => m.type), ['order', 'exec', 'order', 'position']);
  assert.equal(msgs[0].state, 'working'); assert.equal(msgs[0].cid, 'm1'); assert.equal(msgs[0].price, null);
  assert.equal(msgs[1].side, 'buy'); assert.equal(msgs[1].qty, 2); assert.equal(msgs[1].p, 25400); assert.equal(msgs[1].name, 'MNQ 12-26');
  assert.equal(msgs[2].state, 'filled'); assert.equal(msgs[2].avgFill, 25400); assert.equal(msgs[2].role, 'entry');
  assert.deepEqual(msgs[3], { type: 'position', account: 'Sim101', root: 'MNQ', qty: 2, avgPrice: 25400 });
});

test('limit and stop fill when price crosses; a touch fills one contract', async () => {
  const d = await makeDesk(); d.auth();
  d.order({ kind: 'limit', price: 25390, qty: 3 });
  const lim = d.working()[0];
  assert.equal(d.tick(25391).length, 0);
  d.tick(25390);                                                   // touch: 1 of 3
  assert.equal(lim.state, 'partFilled'); assert.equal(lim.filled, 1);
  d.tick(25389.75);                                                // through: the rest, at the limit price
  assert.equal(lim.state, 'filled'); assert.equal(lim.avgFill, 25390);
  assert.deepEqual(d.pos(), { qty: 3, avgPrice: 25390 });
  d.order({ kind: 'stop', side: 'sell', price: 25380, qty: 1 });
  d.tick(25380.25);
  assert.equal(d.working().length, 1);
  const msgs = d.tick(25379.5);                                    // stop triggers: fills at the trade price
  assert.equal(msgs.find(m => m.type === 'exec').p, 25379.5);
  assert.deepEqual(d.pos(), { qty: 2, avgPrice: 25390 });
});

test('bracket: an OCO pair around the fill; target fill cancels the stop', async () => {
  const d = await makeDesk(); d.auth();
  const msgs = d.order({ qty: 2, bracket: { stop: 40, target: 80 } });
  const legs = msgs.filter(m => m.type === 'order' && m.role !== 'entry');
  assert.equal(legs.length, 2);
  const stop = legs.find(m => m.role === 'stop'), target = legs.find(m => m.role === 'target');
  assert.deepEqual([stop.side, stop.kind, stop.qty, stop.price, stop.cid], ['sell', 'stop', 2, 25390, null]);
  assert.deepEqual([target.side, target.kind, target.qty, target.price], ['sell', 'limit', 2, 25420]);
  assert.ok(stop.oco && stop.oco === target.oco);
  const out = d.tick(25420.25);                                    // target traded through
  const last = new Map(out.filter(m => m.type === 'order').map(m => [m.id, m]));
  assert.equal(last.get(target.id).state, 'filled');
  assert.equal(last.get(stop.id).state, 'cancelled');
  assert.deepEqual(out.filter(m => m.type === 'position').pop(), { type: 'position', account: 'Sim101', root: 'MNQ', qty: 0, avgPrice: 0 });
  assert.equal(d.working().length, 0);
});

test('bracket follows partial fills: each fill increment gets its own OCO pair; OCO partners shrink together', async () => {
  const d = await makeDesk(); d.auth();
  d.order({ kind: 'limit', price: 25390, qty: 3, bracket: { stop: 8, target: 8 } });
  const entry = d.working()[0];
  d.tick(25390);                                                   // 1 filled: a pair for 1
  let legs = d.working().filter(o => o.role !== 'entry');
  assert.deepEqual(legs.map(o => [o.role, o.qty, o.price]).sort(), [['stop', 1, 25388], ['target', 1, 25392]]);
  d.tick(25390.25); d.tick(25390);                                 // 2 filled: a second pair for 1, its own OCO id
  legs = d.working().filter(o => o.role !== 'entry');
  assert.equal(legs.length, 4);
  assert.equal(new Set(legs.map(o => o.oco)).size, 2);
  d.tick(25389.75);                                                // through: the last contract, a third pair
  assert.equal(entry.state, 'filled');
  legs = d.working().filter(o => o.role !== 'entry');
  assert.equal(legs.length, 6);
  assert.deepEqual(d.pos(), { qty: 3, avgPrice: 25390 });
  d.tick(25392);                                                   // all three targets touched (1 each): flat, every stop cancelled
  assert.equal(d.pos().qty, 0);
  assert.equal(d.working().length, 0);
});

test('an OCO partner shrinks with a partial fill of its leg', async () => {
  const d = await makeDesk(); d.auth();
  d.order({ qty: 3, bracket: { stop: 8, target: 8 } });           // market: one fill of 3, one pair of 3
  const stop = d.working().find(o => o.role === 'stop'), target = d.working().find(o => o.role === 'target');
  d.tick(25402);                                                   // target touched: 1 of 3
  assert.equal(target.filled, 1); assert.equal(stop.qty - stop.filled, 2);
  d.tick(25397.75);                                                // stop through: the other 2
  assert.equal(stop.state, 'filled'); assert.equal(target.state, 'cancelled'); assert.equal(d.pos().qty, 0);
});

test('flat position cancels leftover legs; after Flatten a late entry fill gets no legs', async () => {
  const d = await makeDesk(); d.auth();
  d.order({ qty: 1, bracket: { stop: 8, target: 8 } });
  d.order({ side: 'sell', qty: 1 });                               // closed by hand: the legs are left over, then cancelled
  assert.equal(d.pos().qty, 0);
  assert.equal(d.working().length, 0);
  d.order({ kind: 'limit', price: 25390, qty: 2, bracket: { stop: 8, target: 8 } });
  const entry = d.working()[0];
  d.act({ type: 'flatten', account: 'Sim101', root: 'MNQ' });
  entry.state = 'working';                                         // a fill that raced the cancel
  d.desk.fill(entry, 1, 25390);
  assert.equal(d.pos().qty, 1);
  assert.equal(d.working().filter(o => o.role !== 'entry').length, 0, 'no legs after flatten');
});

test('brackets: JSON whole numbers only, and only on an order that opens or adds', async () => {
  const d = await makeDesk(); d.auth();
  assert.match(reasonOf(d.order({ bracket: { stop: '8', target: 8 } })), /Bracket stop must be a whole number/);
  assert.match(reasonOf(d.order({ bracket: { stop: 8, target: null } })), /Bracket target must be a whole number/);
  assert.match(reasonOf(d.order({ bracket: { stop: 8 } })), /Bracket target/);
  assert.match(reasonOf(d.order({ bracket: { stop: 201, target: 0 } })), /0 to 200/);
  assert.match(reasonOf(d.order({ bracket: null })), /must be \{/);
  assert.equal(reasonOf(d.order({ bracket: { stop: 0, target: 0 } })), null);   // long 1, no legs
  assert.equal(d.working().length, 0);
  assert.equal(reasonOf(d.order({ bracket: { stop: 8, target: 8 } })), null);   // adds: long 2
  assert.equal(reasonOf(d.order({ side: 'sell', bracket: { stop: 0, target: 0 } })), null);   // reduces, no bracket: fine
  assert.match(reasonOf(d.order({ side: 'sell', bracket: { stop: 8, target: 8 } })), /^A bracket can only go on an order that opens or adds to a position\.$/);
});

test('stale last price refuses limit and stop prices, not market; stop-limits cannot move', async () => {
  const d = await makeDesk(); d.auth();
  d.advance(299000);
  assert.equal(reasonOf(d.order({ kind: 'limit', price: 25390 })), null);
  d.advance(2000);
  assert.match(reasonOf(d.order({ kind: 'limit', price: 25390 })), /last price for MNQ is stale/);
  const id = d.working()[0].id;
  assert.match(reasonOf(d.act({ type: 'change', id, price: 25391 })), /stale/);
  assert.equal(reasonOf(d.order({ side: 'sell', qty: 1 })), null);
  d.tick(25400);
  const sl = d.desk.placeElsewhere({ account: 'Sim101', root: 'MNQ', side: 'sell', kind: 'stopLimit', qty: 1, price: 25380 });
  assert.match(reasonOf(d.act({ type: 'change', id: sl.id, price: 25381 })), /Only limit and stop market orders can be moved/);
  d.desk.placeElsewhere({ account: 'Sim101', root: 'CL', side: 'sell', kind: 'limit', qty: 1, price: 80 });
  assert.equal(d.take('order').length, 0, 'no order messages for roots ChartBridge does not serve');
});

test('cancel: one bracket leg cancels its pair; change moves a leg; stop side still checked', async () => {
  const d = await makeDesk(); d.auth();
  d.order({ qty: 1, bracket: { stop: 20, target: 40 } });
  const [stop, target] = ['stop', 'target'].map(r => d.working().find(o => o.role === r));
  assert.equal(reasonOf(d.act({ type: 'change', id: target.id, price: 25415 })), null);
  assert.equal(target.price, 25415);
  assert.match(reasonOf(d.act({ type: 'change', id: stop.id, price: 25401 })), /sell stop must be below/);
  const out = d.act({ type: 'cancel', id: stop.id });
  assert.deepEqual(out.map(m => [m.id, m.state]), [[stop.id, 'cancelled'], [target.id, 'cancelled']]);
  assert.match(reasonOf(d.act({ type: 'cancel', id: stop.id })), /No working order/);
});

test('flatten: cancels every working order for the account and root, then closes at market', async () => {
  const d = await makeDesk(); d.auth();
  d.order({ qty: 2, bracket: { stop: 20, target: 40 } });
  d.order({ side: 'sell', kind: 'limit', price: 25450, qty: 1 });
  d.order({ account: 'DEMO-EVAL', kind: 'limit', price: 25390, qty: 1 });    // other account: untouched
  d.order({ root: 'ES', kind: 'limit', price: 6490, qty: 1 });               // other root: untouched
  const out = d.act({ type: 'flatten', account: 'Sim101', root: 'MNQ' });
  const cancelled = out.filter(m => m.type === 'order' && m.state === 'cancelled');
  assert.equal(cancelled.length, 3);
  const close = out.find(m => m.type === 'order' && m.state === 'filled');
  assert.deepEqual([close.side, close.qty, close.role, close.kind], ['sell', 2, 'other', 'market']);
  assert.equal(d.pos().qty, 0);
  assert.deepEqual(d.working().map(o => o.account + ' ' + o.root).sort(), ['DEMO-EVAL MNQ', 'Sim101 ES']);
  assert.equal(reasonOf(d.act({ type: 'flatten', account: 'Sim101', root: 'MNQ' })), null);   // nothing left: no error
});

test('orders placed in NinjaTrader show with role other and can be moved and cancelled', async () => {
  const d = await makeDesk(); d.auth();
  const o = d.desk.placeElsewhere({ account: 'DEMO-EVAL', root: 'MNQ', side: 'sell', kind: 'limit', qty: 1, price: 25420 });
  assert.equal(d.take('order')[0].role, 'other');
  assert.equal(reasonOf(d.act({ type: 'change', id: o.id, price: 25425 })), null);
  assert.equal(reasonOf(d.act({ type: 'cancel', id: o.id })), null);
  assert.equal(o.state, 'cancelled');
  const hidden = d.desk.placeElsewhere({ account: 'DEMO-OTHER', root: 'MNQ', side: 'sell', kind: 'limit', qty: 1, price: 25420 });
  assert.equal(d.take('order').length, 0, 'orders on accounts not allowed are never sent');
  assert.match(reasonOf(d.act({ type: 'cancel', id: hidden.id })), /No working order/);
});

test('a second page signing in gets the working orders and open positions', async () => {
  const d = await makeDesk(); d.auth();
  d.order({ qty: 1, bracket: { stop: 20, target: 0 } });
  const msgs = d.auth();
  const list = msgs.find(m => m.type === 'orders').list;
  assert.deepEqual(list.map(o => [o.role, o.oco]), [['stop', null]]);           // a single leg has no OCO partner
  assert.deepEqual(msgs.find(m => m.type === 'position'), { type: 'position', account: 'Sim101', root: 'MNQ', qty: 1, avgPrice: 25400 });
});

/* ---------------- through the real fake server: GET /session and the WebSocket Origin check */
function wsConnect(port, origin) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/ws', headers: Object.assign({
      Host: 'localhost:' + port, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') }, origin ? { Origin: origin } : {}) });
    req.on('upgrade', (res, sock, head) => {
      const msgs = [], waiters = []; let buf = Buffer.alloc(0);
      const onData = d => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (buf.length < 2) break;
          let len = buf[1] & 0x7f, p = 2;
          if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); p = 4; }
          else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); p = 10; }
          if (buf.length < p + len) break;
          const m = JSON.parse(buf.slice(p, p + len).toString('utf8')); buf = buf.slice(p + len);
          msgs.push(m); for (const w of waiters.splice(0)) w();
        }
      };
      sock.on('data', onData);
      if (head && head.length) onData(head);                 // bytes that arrived with the 101 response
      const send = obj => {
        const data = Buffer.from(JSON.stringify(obj)), mask = crypto.randomBytes(4);
        const head = data.length < 126 ? Buffer.from([0x81, 0x80 | data.length]) : Buffer.from([0x81, 0x80 | 126, data.length >> 8, data.length & 255]);
        const body = Buffer.from(data.map((b, i) => b ^ mask[i & 3]));
        sock.write(Buffer.concat([head, mask, body]));
      };
      const next = async (type, ms) => {
        const end = Date.now() + (ms || 3000);
        for (;;) {
          const i = msgs.findIndex(m => m.type === type);
          if (i >= 0) return msgs.splice(i, 1)[0];
          if (Date.now() > end) return null;
          await new Promise(r => { waiters.push(r); setTimeout(r, 50); });
        }
      };
      resolve({ send, next, close: () => sock.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}
function get(port, p, host) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { Host: host || 'localhost:' + port } }, res => {
      let body = ''; res.on('data', d => body += d); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}
async function startBridge(port, flags) {
  const child = spawn(process.execPath, [path.join(__dirname, 'fake-bridge.mjs'), String(port)].concat(flags), { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => child.stdout.once('data', r));
  return child;
}

test('server: /session is same-origin only, the token is checked, and only ChartBridge\'s own page may trade', async () => {
  const port = 18700 + Math.floor(Math.random() * 200);
  const child = await startBridge(port, ['--trading', '--trade-accounts=Sim101,DEMO-EVAL', '--max-qty=MNQ:5']);
  try {
    const pg = await get(port, '/live/');
    assert.equal(pg.headers['x-frame-options'], 'DENY');
    assert.equal(pg.headers['content-security-policy'], "frame-ancestors 'none'");
    const s = await get(port, '/session');
    assert.equal(s.status, 200);
    assert.equal(s.headers['access-control-allow-origin'], undefined, 'no CORS headers');
    assert.equal(s.headers['cache-control'], 'no-store');
    const token = JSON.parse(s.body).token;
    assert.ok(token.length >= 24);
    assert.equal((await get(port, '/session', 'evil.example')).status, 400, 'a rebound host name gets no token');

    const own = 'http://localhost:' + port;
    const a = await wsConnect(port, own);
    const hello = await a.next('hello');
    assert.equal(hello.trading.enabled, false);
    a.send({ type: 'auth', token: 'wrong' });
    assert.match((await a.next('trading')).reason, /does not match/);
    a.send({ type: 'order', cid: 'a1', account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'market', qty: 1 });
    assert.match((await a.next('reject')).reason, /not signed in/);
    a.send({ type: 'auth', token });
    const t = await a.next('trading');
    assert.equal(t.enabled, true); assert.deepEqual(t.accounts, ['Sim101', 'DEMO-EVAL']); assert.equal(t.maxQty.MNQ, 5);
    assert.ok(await a.next('orders'));
    a.send({ type: 'order', cid: 'a2', account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'market', qty: 1 });
    const filled = await a.next('exec');
    assert.equal(filled.account, 'Sim101');
    a.close();

    for (const origin of ['http://evil.example', 'http://127.0.0.1:' + port, null]) {
      const b = await wsConnect(port, origin);
      await b.next('hello');
      b.send({ type: 'auth', token });                       // even with the right token
      const tb = await b.next('trading');
      assert.equal(tb.enabled, false, 'origin ' + origin);
      assert.match(tb.reason, /own page/);
      b.send({ type: 'flatten', account: 'Sim101', root: 'MNQ' });
      assert.match((await b.next('reject')).reason, /own page/);
      b.close();
    }
  } finally { child.kill(); }
});

test('server: trading off by default; --v1 behaves like ChartBridge 0.2 (no trading field, no /session)', async () => {
  const port = 18900 + Math.floor(Math.random() * 90);
  let child = await startBridge(port, []);
  try {
    const a = await wsConnect(port, 'http://localhost:' + port);
    const hello = await a.next('hello');
    assert.equal(hello.trading.enabled, false); assert.match(hello.trading.reason, /Trading is off/);
    a.close();
  } finally { child.kill(); }
  await new Promise(r => setTimeout(r, 200));
  child = await startBridge(port + 1, ['--v1', '--trading']);
  try {
    assert.equal((await get(port + 1, '/session')).status, 404);
    const a = await wsConnect(port + 1, 'http://localhost:' + (port + 1));
    const hello = await a.next('hello');
    assert.equal(hello.trading, undefined);
    a.send({ type: 'auth', token: 'x' });
    assert.equal(await a.next('trading', 500), null);
    a.close();
  } finally { child.kill(); }
});
