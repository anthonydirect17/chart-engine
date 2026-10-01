// The window's shared data feed (live/feed.js, ChartFeed): one WebSocket and one subscribe per instrument, every panel fed
// from it (fan-out), a panel added or closed mid-stream, a panel that needs more, reconnect, moving to another instrument,
// read only. A stand-in WebSocket; no browser.
const test = require('node:test');
const assert = require('node:assert');
const F = require('../live/feed.js');

class FakeWS {
  constructor(url) { this.url = url; this.sent = []; this.readyState = 0; this.closed = false; FakeWS.all.push(this); }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; if (this.onopen) this.onopen({}); }
  msg(m) { if (this.onmessage) this.onmessage({ data: JSON.stringify(m) }); }
  drop() { this.readyState = 3; if (this.onclose) this.onclose({}); }
}
FakeWS.all = [];
const wait = (ms = 5) => new Promise(r => setTimeout(r, ms));
const HELLO = { type: 'hello', version: '0.3.5', instruments: [{ root: 'MNQ', tick: 0.25 }, { root: 'NQ', tick: 0.25 }], accounts: ['Sim101'], features: ['liveFirst', 'profile'] };
const OLD_HELLO = { type: 'hello', version: '0.3.2', instruments: [{ root: 'MNQ', tick: 0.25 }], accounts: [] };

function hub(opts) { FakeWS.all = []; return F.create(Object.assign({ wsUrl: () => 'ws://x/ws', WebSocket: FakeWS }, opts)); }
/* A panel as ChartLive.mount and the tape use it: answers hello with its subscribe, records everything. */
function panel(h, root, need) {
  const p = { got: [], opened: 0, closed: 0, sock: null, need: Object.assign({ days: 5, tickHours: 0 }, need), root };
  const connect = () => {
    const s = h.open(p.root); p.sock = s;
    s.onopen = () => { p.opened++; };
    s.onmessage = ev => { const m = ev.message; p.got.push(m); if (m.type === 'hello') s.send(JSON.stringify(Object.assign({ type: 'subscribe', root: p.root }, p.need))); };
    s.onclose = () => { p.closed++; };
  };
  p.connect = connect;
  connect();
  return p;
}
const types = p => p.got.map(m => m.type);

test('needOf, merge, covers: the least one load that holds what every panel asks', () => {
  assert.deepStrictEqual(F.needOf({ root: 'MNQ' }), { days: 5, tickHours: 8, liveFirst: false, profile: false }, "ChartBridge's defaults");
  assert.deepStrictEqual(F.needOf({ days: 1, tickHours: 0, profile: true }), { days: 1, tickHours: 0, liveFirst: false, profile: true });
  const m = F.merge(F.needOf({ days: 1, tickHours: 0 }), F.needOf({ days: 5, tickHours: 2, liveFirst: true, profile: true }));
  assert.deepStrictEqual(m, { days: 5, tickHours: 2, liveFirst: true, profile: true });
  assert.ok(F.covers(m, F.needOf({ days: 1, tickHours: 0 }), true));
  assert.ok(!F.covers(F.needOf({ days: 1, tickHours: 0 }), F.needOf({ days: 5, tickHours: 0 }), true), 'more days');
  assert.ok(!F.covers(F.needOf({ days: 5, tickHours: 0 }), F.needOf({ days: 5, tickHours: 2 }), true), 'ticks wanted, none loaded');
  assert.ok(F.covers(F.needOf({ days: 5, tickHours: 2 }), F.needOf({ days: 5, tickHours: 16 }), true), 'any served window holds any tick view (0.3.5)');
  assert.ok(!F.covers(F.needOf({ days: 5, tickHours: 2 }), F.needOf({ days: 5, tickHours: 16 }), false), 'before 0.3.5 the hours count');
  assert.ok(!F.covers(F.needOf({ days: 5, tickHours: 0 }), F.needOf({ days: 5, tickHours: 0, profile: true }), true), 'the session table');
});

test('one socket and one subscribe per instrument, whatever the number of panels', async () => {
  const h = hub();
  const a = panel(h, 'MNQ', { tickHours: 2, liveFirst: true, profile: true, sub: 11 });
  const b = panel(h, 'MNQ', { tickHours: 0, profile: true, sub: 7 });
  const t = panel(h, 'MNQ', { days: 1, tickHours: 0 });
  const n = panel(h, 'NQ', { profile: true, sub: 3 });
  await wait();
  assert.strictEqual(FakeWS.all.length, 2, 'MNQ and NQ: two sockets');
  const [mnq, nq] = FakeWS.all;
  mnq.open(); nq.open();
  assert.deepStrictEqual([a.opened, b.opened, t.opened, n.opened], [1, 1, 1, 1]);
  mnq.msg(HELLO); nq.msg(HELLO);
  assert.deepStrictEqual([types(a), types(b), types(t)], [['hello'], ['hello'], ['hello']], 'hello to every panel');
  assert.strictEqual(mnq.sent.length, 0, 'the subscribes of one task go out together');
  await wait();
  assert.strictEqual(mnq.sent.length, 1);
  const s = mnq.sent[0];
  assert.deepStrictEqual({ root: s.root, days: s.days, tickHours: s.tickHours, liveFirst: s.liveFirst, profile: s.profile }, { root: 'MNQ', days: 5, tickHours: 2, liveFirst: true, profile: true });
  assert.ok(Number.isInteger(s.sub) && s.sub > 0, 'its own subscribe id');
  assert.strictEqual(nq.sent.length, 1);
  assert.strictEqual(nq.sent[0].root, 'NQ');
  assert.strictEqual(nq.sent[0].liveFirst, undefined, 'no window asked when no panel wants ticks');
  const st = h.stats();
  assert.strictEqual(st.sockets, 2); assert.strictEqual(st.subscribes, 2);
});

test('fan-out: each panel gets the load with its own subscribe id, and every live trade parsed once', async () => {
  const h = hub();
  const a = panel(h, 'MNQ', { tickHours: 2, liveFirst: true, profile: true, sub: 11 });
  const b = panel(h, 'MNQ', { tickHours: 0, profile: true, sub: 7 });
  await wait();
  const ws = FakeWS.all[0]; ws.open(); ws.msg(HELLO); await wait();
  const sub = ws.sent[0].sub;
  ws.msg({ type: 'history', root: 'MNQ', sub, bars: [[60, 1, 2, 0.5, 1.5, 10]], done: true });
  ws.msg({ type: 'history', root: 'MNQ', sub: sub - 1, bars: [[0, 9, 9, 9, 9, 9]], done: true });   // an older load's: dropped
  ws.msg({ type: 'ticks', root: 'MNQ', sub, ticks: [[61, 1.25, 1]], done: true });
  ws.msg({ type: 'ready', root: 'MNQ', sub });
  ws.msg({ type: 'tick', root: 'MNQ', t: 62, p: 1.5, v: 2, s: 1, sm: 1, u: 1, rx: 2 });
  assert.deepStrictEqual(types(a), ['hello', 'history', 'ticks', 'ready', 'tick']);
  assert.deepStrictEqual(types(b), ['hello', 'history', 'ready', 'tick'], 'a panel that asked for no ticks gets none (a minute chart loads as on its own)');
  for (const [p, mine, th] of [[a, 11, 2], [b, 7, 0]]) {
    const hist = p.got[1], ready = p.got.find(m => m.type === 'ready');
    assert.ok(hist.sub === mine && ready.sub === mine, 'the panel\'s own id');
    assert.deepStrictEqual({ tickHours: hist.load.tickHours, window: hist.load.window }, { tickHours: th, window: th > 0 }, 'what the load holds for it');
    assert.ok(typeof ready.readyAt === 'number' && ready.readyAt > 0);
  }
  assert.strictEqual(a.got[1].sub, 11); assert.strictEqual(a.got[2].sub, 11);
  assert.strictEqual(a.got[4], b.got[3], 'the same trade object for both (one parse)');
  assert.ok(a.got[1].bars === b.got[1].bars, 'the history bars are not copied either');
});

test('a panel added mid-stream gets the load and the trades since, in order, without a new subscribe', async () => {
  const h = hub();
  const a = panel(h, 'MNQ', { tickHours: 2, liveFirst: true, profile: true, sub: 1 });
  await wait();
  const ws = FakeWS.all[0]; ws.open(); ws.msg(HELLO); await wait();
  const sub = ws.sent[0].sub;
  ws.msg({ type: 'execs', list: [{ id: 'e1', account: 'Sim101', root: 'MNQ', p: 1 }] });
  ws.msg({ type: 'history', root: 'MNQ', sub, bars: [[60, 1, 2, 0.5, 1.5, 10]], done: true });
  ws.msg({ type: 'ticks', root: 'MNQ', sub, ticks: [[61, 1.25, 1, 1, 1]], done: true });
  ws.msg({ type: 'profile', root: 'MNQ', sub, session: null, last: null });
  ws.msg({ type: 'ready', root: 'MNQ', sub });
  const N = F.SLICE * 2 + 17;                                       // more than one replay slice
  for (let i = 0; i < N; i++) {
    ws.msg({ type: 'tick', root: 'MNQ', t: 100 + i, p: 1 + i / 4, v: 1 + (i % 3), s: i % 2 ? 1 : -1, sm: 1, u: 5, rx: 6 });
    if (i === 10) ws.msg({ type: 'profile', root: 'MNQ', session: { whole: true }, last: null });   // the table made whole, after ready
    if (i === 20) ws.msg({ type: 'exec', id: 'e2', account: 'Sim101', root: 'MNQ', p: 2 });
  }
  const c = panel(h, 'MNQ', { tickHours: 2, liveFirst: true, profile: true, sub: 9 });
  const d = panel(h, 'MNQ', { days: 1, tickHours: 0 });
  assert.strictEqual(c.got.length, 0, 'it opens on the next turn, as a socket does');
  await wait(1);
  // the trades that come while it catches up are kept in order
  ws.msg({ type: 'tick', root: 'MNQ', t: 100 + N, p: 9, v: 1, s: 1, sm: 1 });
  await wait(50);
  ws.msg({ type: 'tick', root: 'MNQ', t: 101 + N, p: 9, v: 1, s: 1, sm: 1 });
  assert.strictEqual(ws.sent.length, 1, 'no second subscribe');
  assert.strictEqual(c.opened, 1);
  assert.deepStrictEqual(types(c).slice(0, 7), ['hello', 'execs', 'history', 'ticks', 'profile', 'ready', 'tick']);
  assert.deepStrictEqual(c.got[1].list.map(f => f.id), ['e1', 'e2'], "the day's fills so far");
  assert.deepStrictEqual(c.got[3].ticks, [[61, 1.25, 1, 1, 1]], 'the backfill, made again from the record');
  assert.deepStrictEqual(types(d).slice(0, 4), ['hello', 'execs', 'history', 'profile'], 'a tape: no backfill ticks');
  assert.strictEqual(d.got.filter(m => m.type === 'tick').length, N + 2, 'but every trade since ready');
  const ready = c.got[5];
  assert.strictEqual(ready.sub, 9);
  assert.strictEqual(ready.readyAt, a.got.find(m => m.type === 'ready').readyAt, 'the time the load went live, not now');
  const ticks = c.got.filter(m => m.type === 'tick');
  assert.strictEqual(ticks.length, N + 2);
  assert.ok(ticks.every((m, i) => m.t === 100 + i), 'every trade once, in order');
  assert.deepStrictEqual(ticks[1], { type: 'tick', root: 'MNQ', t: 101, p: 1.25, v: 2, s: 1, sm: 1 }, 'a replayed trade: no u or rx (never counted as a delay)');
  const late = c.got.findIndex(m => m.type === 'profile' && m.session && m.session.whole);
  assert.strictEqual(c.got[late - 1].t, 110, 'the late profile where it came, after trade 10');
  // and from now on live, the same object as the first panel
  ws.msg({ type: 'tick', root: 'MNQ', t: 999999, p: 1, v: 1 });
  assert.strictEqual(c.got[c.got.length - 1], a.got[a.got.length - 1]);
});

test('a panel joining while the load is under way gets what came so far, then the rest', async () => {
  const h = hub();
  panel(h, 'MNQ', { tickHours: 0, sub: 1 });
  await wait();
  const ws = FakeWS.all[0]; ws.open(); ws.msg(OLD_HELLO); await wait();
  assert.strictEqual(ws.sent[0].sub, undefined, 'no subscribe id for a ChartBridge without features (as the page)');
  ws.msg({ type: 'history', root: 'MNQ', bars: [[60, 1, 2, 0.5, 1.5, 10]], done: false });
  const b = panel(h, 'MNQ', { tickHours: 0 });
  await wait();
  ws.msg({ type: 'history', root: 'MNQ', bars: [[120, 1, 2, 0.5, 1.5, 10]], done: true });
  ws.msg({ type: 'ready', root: 'MNQ' });
  assert.deepStrictEqual(types(b), ['hello', 'history', 'history', 'ready']);
  assert.strictEqual(ws.sent.length, 1);
});

test('a panel that needs more: one new subscribe for the most, the others load again from it', async () => {
  const h = hub();
  const a = panel(h, 'MNQ', { tickHours: 0, profile: true, sub: 1 });
  const t = panel(h, 'MNQ', { days: 1, tickHours: 0 });
  await wait();
  const ws = FakeWS.all[0]; ws.open(); ws.msg(HELLO); await wait();
  const s1 = ws.sent[0].sub;
  ws.msg({ type: 'history', root: 'MNQ', sub: s1, bars: [], done: true });
  ws.msg({ type: 'ready', root: 'MNQ', sub: s1 });
  // the chart switches to Range bars: it asks for the served window
  a.got.length = 0; t.got.length = 0;
  a.need = { days: 5, tickHours: 2, liveFirst: true, profile: true, sub: 2 };
  a.sock.send(JSON.stringify(Object.assign({ type: 'subscribe', root: 'MNQ' }, a.need)));
  await wait();
  assert.strictEqual(ws.sent.length, 2);
  const s2 = ws.sent[1].sub;
  assert.ok(s2 !== s1 && ws.sent[1].tickHours === 2 && ws.sent[1].liveFirst && ws.sent[1].profile && ws.sent[1].days === 5);
  assert.deepStrictEqual(types(t), ['hello'], 'the tape on the old load is told to start over');
  ws.msg({ type: 'history', root: 'MNQ', sub: s1, bars: [], done: true });  // the old load's, still on its way
  ws.msg({ type: 'history', root: 'MNQ', sub: s2, bars: [[60, 1, 1, 1, 1, 1]], done: true });
  ws.msg({ type: 'ready', root: 'MNQ', sub: s2 });
  assert.deepStrictEqual(types(a), ['history', 'ready']);
  assert.deepStrictEqual(types(t), ['hello', 'history', 'ready'], 'and joins the new one');
  assert.strictEqual(ws.sent.length, 2, 'its subscribe is held by the new load');
  assert.strictEqual(a.got[0].sub, 2);
});

test('a panel closed mid-stream gets nothing more; the last one closes the socket', async () => {
  const h = hub();
  const a = panel(h, 'MNQ', { sub: 1 }), b = panel(h, 'MNQ', { sub: 2 });
  await wait();
  const ws = FakeWS.all[0]; ws.open(); ws.msg(HELLO); await wait();
  const sub = ws.sent[0].sub;
  ws.msg({ type: 'ready', root: 'MNQ', sub });
  b.sock.close();
  ws.msg({ type: 'tick', root: 'MNQ', t: 1, p: 1, v: 1 });
  assert.strictEqual(b.got.filter(m => m.type === 'tick').length, 0);
  assert.strictEqual(a.got.filter(m => m.type === 'tick').length, 1);
  assert.ok(!ws.closed, 'still one panel on it');
  a.sock.onclose = null; a.sock.close();
  assert.ok(ws.closed, 'no panel left: the socket closes');
  assert.strictEqual(h.stats().sockets, 0);
  await wait();
  assert.strictEqual(b.closed, 1, "close() reports onclose later, like a socket");
});

test('reconnect: the socket drops, every panel is told, the first one back opens it again', async () => {
  const h = hub();
  const a = panel(h, 'MNQ', { sub: 1 }), b = panel(h, 'MNQ', { sub: 2 });
  await wait();
  const ws = FakeWS.all[0]; ws.open(); ws.msg(HELLO); await wait();
  ws.drop();
  assert.deepStrictEqual([a.closed, b.closed], [1, 1]);
  assert.strictEqual(a.sock.readyState, 3);
  a.connect();
  await wait();
  assert.strictEqual(FakeWS.all.length, 2, 'a new socket');
  b.connect();
  await wait();
  assert.strictEqual(FakeWS.all.length, 2, 'the second panel back joins it');
  const ws2 = FakeWS.all[1]; ws2.open(); ws2.msg(HELLO); await wait();
  assert.strictEqual(ws2.sent.length, 1, 'one subscribe again');
  assert.deepStrictEqual([a.opened, b.opened], [2, 2]);
});

test('a socket that never opens closes the panels waiting on it', async () => {
  const h = hub({ wsUrl: () => Promise.reject(new Error('no PIN yet')) });
  const a = panel(h, 'MNQ', {});
  await wait();
  assert.strictEqual(a.closed, 1);
  assert.strictEqual(FakeWS.all.length, 0);
});

test('another instrument: the panel moves to that line; a line left empty closes', async () => {
  const h = hub();
  const a = panel(h, 'MNQ', { sub: 1 });
  await wait();
  const mnq = FakeWS.all[0]; mnq.open(); mnq.msg(HELLO); await wait();
  a.got.length = 0;
  a.root = 'NQ';
  a.sock.send({ type: 'subscribe', root: 'NQ', days: 5, tickHours: 0, sub: 2 });
  assert.ok(mnq.closed, 'MNQ had only this panel');
  await wait();
  const nq = FakeWS.all[1];
  assert.ok(nq && !nq.closed);
  nq.open(); nq.msg(HELLO); await wait();
  assert.deepStrictEqual(types(a), [], 'no second hello: the panel is already past it');
  assert.strictEqual(nq.sent.length, 1);
  assert.strictEqual(nq.sent[0].root, 'NQ');
  nq.msg({ type: 'ready', root: 'NQ', sub: nq.sent[0].sub });
  assert.deepStrictEqual(types(a), ['ready']);
  assert.strictEqual(a.got[0].sub, 2);
});

test('read only: a panel sends nothing but subscribe and ping', async () => {
  const h = hub();
  const a = panel(h, 'MNQ', { sub: 1 });
  await wait();
  const ws = FakeWS.all[0]; ws.open(); ws.msg(HELLO); await wait();
  for (const type of ['order', 'change', 'cancel', 'flatten', 'auth']) a.sock.send(JSON.stringify({ type, root: 'MNQ' }));
  a.sock.send(JSON.stringify({ type: 'ping', c: 1 }));
  a.sock.send('not json');
  assert.deepStrictEqual(ws.sent.map(m => m.type), ['subscribe', 'ping']);
});

test('one panel throwing never stops the others', async () => {
  const h = hub();
  const a = panel(h, 'MNQ', { sub: 1 }), b = panel(h, 'MNQ', { sub: 2 });
  await wait();
  const ws = FakeWS.all[0]; ws.open(); ws.msg(HELLO); await wait();
  ws.msg({ type: 'ready', root: 'MNQ', sub: ws.sent[0].sub });
  const thrown = [];
  const keep = process.listeners('uncaughtException');
  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', e => thrown.push(e.message));
  const on = a.sock.onmessage;
  a.sock.onmessage = () => { throw new Error('panel a'); };
  ws.msg({ type: 'tick', root: 'MNQ', t: 1, p: 1, v: 1 });
  await wait();
  process.removeAllListeners('uncaughtException');
  for (const l of keep) process.on('uncaughtException', l);
  a.sock.onmessage = on;
  assert.deepStrictEqual(thrown, ['panel a']);
  assert.strictEqual(b.got.filter(m => m.type === 'tick').length, 1);
});
