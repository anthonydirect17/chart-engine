'use strict';
// One order ticket across windows (chart 1.12.0, live/ticket-link.js): claim, the tie-break, move, forwards and their
// timeout, a window closing or vanishing, no auto-claim. A fake clock, a fake BroadcastChannel and a fake Web Locks.
const test = require('node:test');
const assert = require('node:assert/strict');
const TL = require('../live/ticket-link.js');

/* a fake world: one clock, timers, a bus with a delivery delay, and a lock manager like navigator.locks */
function world() {
  let clock = 1000000, timers = [], tid = 0;
  const W = { delay: 1, now: () => clock };
  W.later = (fn, ms) => { const id = ++tid; timers.push({ id, at: clock + Math.max(0, ms), fn }); return id; };
  W.unlater = id => { timers = timers.filter(t => t.id !== id); };
  const flushMicro = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  W.run = async ms => {
    const end = clock + ms;
    for (;;) {
      await flushMicro();
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift(); clock = Math.max(clock, t.at); t.fn();
    }
    clock = end; await flushMicro();
  };
  const chans = [];
  W.channel = () => {
    const ch = { onmessage: null, dead: false, post: m => { const copy = JSON.parse(JSON.stringify(m)); for (const c of chans) if (c !== ch && !c.dead) W.later(() => { if (!c.dead && c.onmessage) c.onmessage(copy); }, W.delay); } };
    chans.push(ch); return ch;
  };
  let owner = null;
  W.locks = {
    request(name, opts, cb) {
      return Promise.resolve().then(() => {
        if (owner && opts.ifAvailable) return cb(null);
        const me = {};
        owner = me;
        return Promise.resolve(cb({ name })).then(() => { if (owner === me) owner = null; });
      });
    },
    query() { return Promise.resolve({ held: owner ? [{ name: TL.LOCK }] : [] }); },
    crash() { owner = null; },
  };
  W.win = (extra) => {
    const ch = W.channel();
    const log = { states: [], released: 0, late: [], forwards: [] };
    const link = TL.create(Object.assign({ channel: ch, locks: W.locks, now: W.now, setTimeout: W.later, clearTimeout: W.unlater,
      onState: s => log.states.push(s), onRelease: () => { log.released++; }, onLate: a => log.late.push(a),
      onForward: a => { log.forwards.push(a); return { sent: 1, note: 'Sent ' + a.kind }; } }, extra || {}));
    return { link, ch, log };
  };
  return W;
}

test('claim: the first window to add the ticket holds it; another is told it is busy and learns who holds it', async () => {
  const W = world(), A = W.win({ wid: 'A' }), B = W.win({ wid: 'B' });
  const a = A.link.take();
  await W.run(5);
  assert.equal(await a, 'held');
  A.link.publish({ root: 'MNQ', account: 'Sim101', armed: false, qty: 2 });
  await W.run(5);
  assert.equal(await B.link.take(), 'busy');
  assert.deepEqual(B.link.info().holder, { root: 'MNQ', account: 'Sim101', armed: false, qty: 2, wid: 'A' });
  assert.equal(B.link.held(), false);
  // a window opened later learns the holder by asking (hello)
  const C = W.win({ wid: 'C' });
  await W.run(5);
  assert.equal(C.link.info().holder.wid, 'A');
});

test('tie-break: two windows adding the ticket at the same moment, exactly one holds it (the lock), every time', async () => {
  for (let k = 0; k < 20; k++) {
    const W = world(), A = W.win({ wid: 'A' + k }), B = W.win({ wid: 'B' + k });
    const both = Promise.all(k % 2 ? [A.link.take(), B.link.take()] : [B.link.take(), A.link.take()]);
    await W.run(5);
    const r = await both;
    assert.deepEqual(r.slice().sort(), ['busy', 'held'], 'round ' + k + ': ' + r);
    assert.equal(A.link.held() + B.link.held(), 1);
  }
});

test('move: the holder lets go (its host turns the ticket off first), the asking window holds it; never both at once', async () => {
  const W = world(), A = W.win({ wid: 'A' }), B = W.win({ wid: 'B' });
  const seen = [];
  const watch = () => seen.push(A.link.held() + B.link.held());
  const a = A.link.take(); await W.run(5); await a;
  A.link.publish({ root: 'MNQ', account: 'Sim101', armed: true });
  await W.run(5);
  const m = B.link.move();
  for (let i = 0; i < 40; i++) { await W.run(10); watch(); }
  assert.equal(await m, 'held');
  assert.equal(A.log.released, 1, 'the old holder was told (Armed goes off there)');
  assert.equal(A.link.held(), false);
  assert.equal(B.link.held(), true);
  assert.ok(seen.every(n => n <= 1), 'never two holders: ' + seen.join(''));
  B.link.publish({ root: 'NQ', account: 'Sim101', armed: false });
  await W.run(5);
  assert.equal(A.link.info().holder.wid, 'B');
});

test('forward: a click in another window is acted on by the holder, with its answer', async () => {
  const W = world(), A = W.win({ wid: 'A' }), B = W.win({ wid: 'B' });
  const a = A.link.take(); await W.run(5); await a;
  A.link.publish({ root: 'MNQ' }); await W.run(5);
  const f = B.link.forward({ kind: 'place', side: 'buy', price: 100, root: 'MNQ' });
  await W.run(20);
  assert.deepEqual(await f, { answered: true, sent: 1, note: 'Sent place' });
  assert.deepEqual(A.log.forwards, [{ kind: 'place', side: 'buy', price: 100, root: 'MNQ' }]);
  // the holder never forwards to itself
  assert.equal((await A.link.forward({ kind: 'buy' })).answered, false);
});

test('timeout: no answer within 300 ms says nothing was sent, and the holder does not act on it later', async () => {
  const W = world(), A = W.win({ wid: 'A' }), B = W.win({ wid: 'B' });
  const a = A.link.take(); await W.run(5); await a;
  A.link.publish({ root: 'MNQ' }); await W.run(5);
  W.delay = 400;                                         // a stalled holder window
  const f = B.link.forward({ kind: 'buy' });
  await W.run(301);
  assert.deepEqual(await f, { answered: false, sent: 0, note: TL.NO_ANSWER });
  await W.run(1000);
  assert.equal(A.log.forwards.length, 0, 'the holder got it 400 ms late and sent nothing');
  assert.equal(B.log.late.length, 0, 'and no late "sent" answer');
  // a holder just under the act window still acts, and answers in time
  W.delay = 120;
  const g = B.link.forward({ kind: 'sell' });
  await W.run(400);
  assert.equal((await g).answered, true);
  assert.equal(A.log.forwards.length, 1);
});

test('the holder window closes or reloads: no window holds the ticket until one adds it (no auto-claim)', async () => {
  const W = world(), A = W.win({ wid: 'A' }), B = W.win({ wid: 'B' });
  const a = A.link.take(); await W.run(5); await a;
  A.link.publish({ root: 'MNQ' }); await W.run(5);
  A.link.close(); A.ch.dead = true;
  await W.run(50);
  assert.equal(B.link.info().holder, null);
  assert.equal(B.link.held(), false, 'B did not take it by itself');
  assert.deepEqual(await B.link.forward({ kind: 'buy' }), { answered: false, sent: 0, note: TL.NO_TICKET });
  const b = B.link.take(); await W.run(5);
  assert.equal(await b, 'held', 'B adds it: B holds it');
});

test('a holder that vanished without a word (crash): forwards get the note; check() drops it once the lock is free', async () => {
  const W = world(), A = W.win({ wid: 'A' }), B = W.win({ wid: 'B' });
  const a = A.link.take(); await W.run(5); await a;
  A.link.publish({ root: 'MNQ' }); await W.run(5);
  A.ch.dead = true; W.locks.crash();
  const f = B.link.forward({ kind: 'be' });
  await W.run(400);
  assert.equal((await f).note, TL.NO_ANSWER);
  const c = B.link.check(); await W.run(5); await c;
  assert.equal(B.link.info().holder, null);
});

test('without Web Locks the ticket is never held (one ticket cannot be kept safely)', async () => {
  const W = world(), A = W.win({ wid: 'A', locks: null });
  assert.equal(await A.link.take(), 'unsupported');
  assert.equal(A.link.held(), false);
  assert.equal(A.link.info().supported, false);
});

test('review fixes: a forward for another window is not acted on; one stamped in the future is refused; later notes reach the asker', async () => {
  const W = world(), A = W.win({ wid: 'A' });
  const notes = [];
  const B = W.win({ wid: 'B', onNote: t => notes.push(t) });
  const raw = W.channel(), acks = [];
  raw.onmessage = m => { if (m.t === 'ack') acks.push(m); };
  const a = A.link.take(); await W.run(5); await a;
  A.link.publish({ root: 'MNQ' }); await W.run(5);
  raw.post({ t: 'fwd', id: 'x1', from: 'R', to: 'Z', at: W.now(), action: { kind: 'buy' } });   // addressed to a window that is not A
  await W.run(20);
  assert.equal(A.log.forwards.length, 0, 'not for A: not acted on');
  assert.equal(acks.length, 0, 'and not answered');
  raw.post({ t: 'fwd', id: 'x2', from: 'R', to: 'A', at: W.now() + 500, action: { kind: 'buy' } });   // 0.5 s in the future
  await W.run(20);
  assert.equal(A.log.forwards.length, 0, 'a stamp from the future: nothing done');
  assert.deepEqual(acks.map(m => [m.id, m.sent, m.note]), [['x2', 0, TL.BAD_CLOCK]]);
  raw.post({ t: 'fwd', id: 'x3', from: 'R', to: 'A', at: W.now() + 30, action: { kind: 'buy' } });    // within the 50 ms slack
  await W.run(20);
  assert.equal(A.log.forwards.length, 1, 'a few ms ahead is fine');
  A.link.tell('B', 'Refused by ChartBridge: too far');
  await W.run(5);
  assert.deepEqual(notes, ['Refused by ChartBridge: too far']);
  B.link.tell('A', 'x'); await W.run(5);                 // only the holder tells
  assert.equal(A.log.late.length, 0);
});
