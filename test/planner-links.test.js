'use strict';
// The planner's links to ChartBridge's order ids (chart 1.62.0, the delta review of 71444ef): ChartBridge's ids start again after a
// NinjaTrader restart, so a link made before an orders snapshot is never trusted after it, not even for the moment before the
// leader's next tick. The real TradeCore (live/trade.js) and the real planner page (live/planner.js) on a fake connection, a fake
// Desk and a fake clock; the leader's tick is run by hand. Sample values only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { LivePrefs: LP } = require('../live/live.js');
const TC = require('../live/trade.js');
const PC = require('../live/planner-core.js');
const { PlannerPage } = require('../live/planner.js');

const UID = 'pu' + 'a'.repeat(16), CID = PC.entryCid(UID), T0 = 1_800_000_000_000;
const ENTRY = { account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'limit', qty: 1, price: 24990 };
/* the plan's own working entry, and an unrelated protective stop that takes the same id after a restart */
const own = o => Object.assign({ type: 'order', id: 'NT5', cid: CID, state: 'working', filled: 0, role: 'entry' }, ENTRY, o || {});
const unrelated = o => Object.assign({ type: 'order', id: 'NT5', account: 'Sim101', root: 'MNQ', side: 'sell', kind: 'stop', qty: 1, price: 24900, state: 'working', filled: 0, role: 'other' }, o || {});

async function rig() {
  let clock = T0;
  const store = new Map(), plStore = new Map();
  const mem = m => ({ getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) });
  const R = { sent: [], alarms: [], notes: [], desk: [] };
  const core = TC.create({
    LP, prefs: LP.create(mem(store)), fetch: () => Promise.resolve({ ok: true, text: () => Promise.resolve('{"token":"t"}') }),
    send: m => R.sent.push(JSON.parse(JSON.stringify(m))), open: () => true, sock: () => R,
    root: () => 'MNQ', lastPrice: () => 25000, qty: () => 1, pickerAccount: () => core.TR.account, wantedAccount: () => 'Sim101',
    tick: () => 0.25, served: () => true, fmt: p => p.toFixed(2), flash: (t, l) => R.notes.push((l ? l + ': ' : '') + t),
    later: () => 0, changed: () => {}, armed: () => {}, applied: () => {}, lost: () => {}, syncAccounts: () => {}, batch: () => {},
    unsent: () => {}, armBlocked: () => '', destroyed: () => false, now: () => clock, agentOwner: () => '',
  });
  core.hello({ type: 'hello', features: [] });
  core.applyTrading({ enabled: true, accounts: ['Sim101'], maxQty: { '*': 5 } });
  core.message({ type: 'orders', list: [], positions: 0 });
  const plan = extra => ({
    seq: 7, uid: UID, pc: 'PC-A', account: 'Sim101', root: 'MNQ', contract: 'MNQ 12-26', side: 'long', entry_type: 'limit',
    entry: 24990, stop: 24980, target: 25010, qty: 1, tick: 0.25, expiry_min: 30, grade: 'B', status: 'working',
    armed_at_ms: T0 - 60000, expires_at_ms: T0 + 30 * 60000, logged_at_ms: T0 - 120000,
    events: [{ kind: 'arm', logged_at_ms: T0 - 60000, detail: { client: { entry_kind: 'limit', line_above: false } } },
      { kind: 'sent', logged_at_ms: T0 - 59000, detail: { leg: 'entry', cid: CID, at_ms: T0 - 59000 } },
      { kind: 'placed', logged_at_ms: T0 - 58000, detail: { id: 'NT5', state: 'working' } }].concat(extra || []),
  });
  let cancelled = false;
  const reply = (status, body) => Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(body)) });
  const fetch = (url, o) => {
    R.desk.push((o.method || 'GET') + ' ' + url.replace(/^https?:\/\/[^/]+/, ''));
    if (/\/cancel$/.test(url)) { cancelled = true; return reply(200, { plan: plan([{ kind: 'cancel', logged_at_ms: clock, detail: {} }]) }); }
    if (/\/api\/plans\?/.test(url)) return reply(200, { live: true, now_ms: clock, plans: [cancelled ? plan([{ kind: 'cancel', logged_at_ms: clock, detail: {} }]) : plan()] });
    return reply(200, {});
  };
  const timers = [], keep = global.setInterval;
  global.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  let planner;
  try {
    planner = PlannerPage.mount({
      test: true, PC, U: { zoneSeconds: () => 0 }, core, storage: mem(plStore), channel: null, now: () => clock,
      locks: { request: (name, cb) => cb({}) }, fetch, deskBase: () => 'http://desk.example.com', pcName: () => 'PC-A',
      hub: { open: () => ({}) }, charts: () => [], note: (t, l) => R.notes.push(t), alarm: t => R.alarms.push(t),
      tickOf: () => 0.25, contract: () => 'MNQ 12-26', accounts: () => ['Sim101'], ticketAccount: () => 'Sim101', ticketRoot: () => 'MNQ',
      members: a => [a], maxBracketTicks: () => 400, execs: () => [], qty: () => 1, orderTypes: () => true, maxQty: () => 5,
      bracket: () => ({ stop: 40, target: 80 }), holdsTicket: () => false,
    });
  } finally { global.setInterval = keep; }
  for (let i = 0; i < 50 && planner.state().ok !== true; i++) await new Promise(r => setImmediate(r));
  assert.equal(planner.state().ok, true, 'the planner is on (The Desk answered its plan log)');
  /* ChartBridge says the plan's entry is working, by its cid; the leader resumes and links it (by its cid) */
  const say = m => { core.message(m); planner.message(m); };
  say(own());
  planner.test.lead();
  say(own({ cid: undefined }));                                         // a later message without the cid: still the plan's own
  R.sent.length = 0;
  return { R, core, planner, say, tick: ms => { clock += ms; }, cancels: () => R.sent.filter(m => m.type === 'cancel') };
}

/* a NinjaTrader restart: ChartBridge's orders snapshot, where an unrelated protective stop now has the plan's old id NT5. Told to
   TradeCore only (the planner has not seen it yet), the worst case */
const restart = x => x.core.message({ type: 'orders', list: [unrelated()], positions: 0 });

test('before any snapshot, the cid link holds: Cancel cancels NT5 (the check below is not empty)', async () => {
  const x = await rig();
  x.planner.test.cancel(UID);
  assert.deepEqual(x.cancels(), [{ type: 'cancel', id: 'NT5' }]);
  x.planner.destroy();
});

test('before any snapshot, an expiry cancels NT5 on the leader\'s tick (the expiry check below is not empty)', async () => {
  const x = await rig();
  x.tick(31 * 60000);
  x.planner.test.lead();
  assert.deepEqual(x.cancels(), [{ type: 'cancel', id: 'NT5' }]);
  x.planner.destroy();
});

test('an order message right after the snapshot, before any leader tick, never inherits the old link', async () => {
  const x = await rig();
  restart(x);
  x.say(unrelated());
  x.planner.test.cancel(UID);
  x.planner.flattened('MNQ');
  assert.deepEqual(x.cancels(), [], 'nothing cancelled by the old id');
  x.planner.destroy();
});

test('Cancel right after the snapshot never cancels the order that took the old id', async () => {
  const x = await rig();
  restart(x);
  x.planner.test.cancel(UID);
  assert.deepEqual(x.cancels(), []);
  assert.equal(x.core.TR.orders.get('NT5').side, 'sell', 'the protective stop is still there');
  x.planner.destroy();
});

test('Flatten right after the snapshot ends the plan and never cancels the order that took the old id', async () => {
  const x = await rig();
  restart(x);
  x.planner.flattened('MNQ');
  assert.deepEqual(x.cancels(), []);
  x.planner.destroy();
});

test('an expiry on the first leader tick after the snapshot never cancels the order that took the old id', async () => {
  const x = await rig();
  restart(x);
  x.tick(31 * 60000);                                                   // past the plan's expiry
  x.planner.test.lead();
  x.planner.test.lead();
  assert.deepEqual(x.cancels(), []);
  x.planner.destroy();
});

test('a hello or a drop forgets the links at once too', async () => {
  for (const drop of [x => x.core.hello({ type: 'hello', features: [] }), x => x.core.lost('gone')]) {
    const x = await rig();
    drop(x);
    x.core.applyTrading({ enabled: true, accounts: ['Sim101'], maxQty: { '*': 5 } });
    x.core.message({ type: 'orders', list: [unrelated()], positions: 0 });
    x.say(unrelated());
    x.planner.test.cancel(UID);
    assert.deepEqual(x.cancels(), []);
    x.planner.destroy();
  }
});

test('after the snapshot the plan\'s own entry is found again by its cid and cancelled', async () => {
  const x = await rig();
  x.core.message({ type: 'orders', list: [unrelated(), own({ type: undefined, id: 'RN2' })], positions: 0 });
  x.planner.test.cancel(UID);
  assert.deepEqual(x.cancels(), [{ type: 'cancel', id: 'RN2' }]);
  x.planner.destroy();
});
