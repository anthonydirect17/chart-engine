'use strict';
// The planner's order path in TradeCore (chart 1.62.0, section 1 of the plan): ready() stays byte for byte and every manual
// action still calls it, so with Armed off every existing entry point still says "Armed is off" and sends nothing; Flatten,
// Flatten all and Cut half still go with Armed off; sendPlanOrder sends exactly one message, built from the plan alone, even
// when the ticket shows another instrument, account, qty and bracket, never twice; cancelPlanOrder sends { type, id }.
// A fake connection and clock; sample values only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LivePrefs: LP } = require('../live/live.js');
const TC = require('../live/trade.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'live', 'trade.js'), 'utf8');

/* ready() as chart 1.61.0 has it, byte for byte (live/trade.js on claude/update-chart-fixes) */
const READY_161 = [
  '  function ready(armed) {',
  '    if (FRAMED) { flash(FRAMED_REASON, \'error\'); return false; }',
  '    if (!TR.enabled) { flash(TR.reason || \'Trading is not enabled.\', \'error\'); return false; }',
  '    if (!TR.armed && armed !== false) { flash(\'Armed is off: nothing was sent. Turn Armed on to trade.\', \'warn\'); return false; }',
  '    if (!open()) { flash(\'Not connected to ChartBridge: nothing was sent.\', \'error\'); return false; }',
  '    if (!TR.account) { flash(\'No account (None): nothing was sent. Pick an account to trade.\', \'warn\'); return false; }   // 1.8.0: never blocked by a view loading; DECISION 2026-10-14e: None sends nothing',
  '    if (env.pickerAccount() !== TR.account) { env.syncAccounts(); flash(\'Nothing was sent: the account shown was not the order account. The picker is back on \' + TR.account + \'; click again to act on \' + TR.account + \'.\', \'error\'); return false; }',
  '    return true;',
  '  }',
].join('\n');
const fnBody = name => { const i = SRC.indexOf('  function ' + name + '('); assert.ok(i >= 0, name); const j = SRC.indexOf('\n  }\n', i); return SRC.slice(i, j + 4); };

function rig() {
  let clock = 5000; const timers = [];
  const store = new Map();
  const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const R = { sent: [], notes: [], root: 'NQ', last: 25000, qty: 3, owner: '' };
  const env = {
    LP, prefs: LP.create(storage), fetch: () => Promise.resolve({ ok: true, text: () => Promise.resolve('{"token":"t"}') }),
    send: m => R.sent.push(JSON.parse(JSON.stringify(m))), open: () => true, sock: () => R,
    root: () => R.root, lastPrice: () => R.last, qty: () => R.qty, pickerAccount: () => core.TR.account, wantedAccount: () => 'EVAL-1',
    tick: () => 0.25, served: () => true, fmt: p => p.toFixed(2), flash: (t, l) => R.notes.push((l ? l + ': ' : '') + t),
    later: (fn, ms) => { timers.push({ at: clock + ms, fn }); return timers.length; },
    changed: () => {}, armed: () => {}, applied: () => {}, lost: () => {}, syncAccounts: () => {}, batch: () => {}, unsent: () => {},
    armBlocked: () => '', destroyed: () => false, now: () => clock, agentOwner: () => R.owner,
  };
  const core = TC.create(env);
  R.core = core;
  R.tick = ms => { clock += ms; };
  core.hello({ type: 'hello', features: ['cutHalf'] });
  core.applyTrading({ enabled: true, accounts: ['Sim101', 'EVAL-1'], maxQty: { MNQ: 5, NQ: 3, '*': 2 } });
  core.setSwitches({ orderTypes: true, merge: true });
  core.message({ type: 'orders', list: [], positions: 0 });
  return R;
}
const UID = 'pu' + 'c'.repeat(16);
const plan = o => Object.assign({ uid: UID, account: 'Sim101', root: 'MNQ', side: 'long', kind: 'limit', qty: 2, price: 24990.25, bracket: { stop: 16, target: 32 } }, o || {});

test('ready() is byte for byte chart 1.61.0\'s, and every manual path still calls it (Flatten and Cut half: ready(false))', () => {
  assert.equal(fnBody('ready'), READY_161);
  for (const f of ['sendOrder', 'placeChecked', 'breakEven', 'cancelAll', 'moveOrder', 'cancelOrder', 'groupCancel', 'planTarget', 'groupPlan', 'groupMove', 'merge'])
    assert.match(fnBody(f), /if \(!ready\(\)\)/, f + ' calls ready()');
  for (const f of ['flattenHere', 'cutHalf']) assert.match(fnBody(f), /if \(!ready\(false\)\) return;/, f + ' calls ready(false)');
  assert.ok(!/\bready\(/.test(fnBody('flattenAll')), 'Flatten all calls no ready() at all (1.61.0)');
  for (const f of ['sendPlanOrder', 'cancelPlanOrder']) { assert.ok(!/[^a-zA-Z]ready\(/.test(fnBody(f)), f + ' never calls ready()'); assert.match(fnBody(f), /readyPlan\(p\)/); }
  assert.ok(!/sentCid|noStopOk|qtyNow\(|brackets\[|env\.strategy|TR\.account\b|TR\.armed|pickerAccount/.test(fnBody('readyPlan') + fnBody('sendPlanOrder') + fnBody('cancelPlanOrder')), 'the plan path reads nothing of the ticket');
});

test('with Armed off every existing entry point says "Armed is off" and sends nothing', () => {
  const R = rig();
  R.core.message({ type: 'position', account: 'EVAL-1', root: 'NQ', qty: 2, avgPrice: 24990 });
  R.core.message({ type: 'order', id: 'o5', account: 'EVAL-1', root: 'NQ', side: 'sell', kind: 'stop', qty: 2, filled: 0, price: 24980, state: 'working', role: 'stop' });
  R.core.message({ type: 'order', id: 'o6', account: 'EVAL-1', root: 'NQ', side: 'buy', kind: 'limit', qty: 1, filled: 0, price: 24970, state: 'working', role: 'entry', planned: { stopTicks: 8, targetTicks: 16 } });
  R.sent.length = 0;
  assert.equal(R.core.TR.armed, false);
  const table = [
    ['Buy MKT', () => R.core.sendOrder('buy', 'market', null)],
    ['Sell MKT', () => R.core.sendOrder('sell', 'market', null)],
    ['a chart click', () => R.core.placeAt('buy', 24950)],
    ['a forwarded chart click', () => R.core.placeChecked('buy', 'limit', 24950)],
    ['B/E', () => R.core.breakEven()],
    ['Cancel all', () => R.core.cancelAll()],
    ['a drag', () => R.core.moveOrder('o5', 24985)],
    ['an x', () => R.core.cancelOrder('o5')],
    ['a group line\'s x', () => R.core.cancelOrder('G~x')],
    ['a planned line\'s drag', () => R.core.planMove('o6:sl', 24960, 24970)],
    ['a planned line\'s x', () => R.core.planRemove('o6:sl')],
    ['+SL', () => R.core.planAdd('o6', 'stop')],
    ['a group line\'s drag', () => R.core.moveOrder('G~x', 24985)],
    ['Merge', () => R.core.merge()],
  ];
  for (const [name, act] of table) {
    R.notes.length = 0; R.tick(1000);
    act();
    assert.equal(R.sent.length, 0, name + ' sent nothing');
    assert.ok(R.notes.some(n => /Armed is off: nothing was sent/.test(n)), name + ' says Armed is off: ' + R.notes.join(' | '));
  }
  // Flatten, Flatten all and Cut half are never blocked by Armed
  R.tick(1000); R.core.flattenHere();
  assert.deepEqual(R.sent.map(m => m.type + ' ' + m.account + ' ' + m.root), ['flatten EVAL-1 NQ']);
  R.sent.length = 0; R.tick(1000); R.core.cutHalf();
  assert.deepEqual(R.sent.map(m => m.type + ' ' + m.account + ' ' + m.position), ['cutHalf EVAL-1 2']);
  R.sent.length = 0; R.tick(1000); R.core.flattenAll();
  assert.ok(R.sent.length >= 1 && R.sent.every(m => m.type === 'flatten'), 'Flatten all goes');
});

test('sendPlanOrder: exactly one message, from the plan alone, whatever the ticket shows; never twice; Armed untouched', () => {
  const R = rig();
  R.core.setBracket('NQ', 'stop', 8, true); R.core.setBracket('NQ', 'target', 12, true);
  assert.deepEqual([R.core.TR.account, R.root, R.qty, R.core.TR.armed], ['EVAL-1', 'NQ', 3, false], 'the ticket shows another account, instrument, qty and bracket, Armed off');
  const r = R.core.sendPlanOrder(plan(), 'entry');
  assert.deepEqual(r, { sent: true, cid: 'pl' + UID + '-e', why: '' });
  assert.deepEqual(R.sent, [{ type: 'order', cid: 'pl' + UID + '-e', account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'limit', qty: 2, price: 24990.25, bracket: { stop: 16, target: 32 } }]);
  assert.equal(R.core.lastCid(), '', 'the ticket\'s last cid is untouched');
  assert.equal(R.core.TR.armed, false);
  const again = R.core.sendPlanOrder(plan(), 'entry');
  assert.equal(again.sent, false); assert.match(again.why, /never twice/);
  assert.equal(R.sent.length, 1, 'never a second entry');
  // the kinds: an MIT, a stop-market, a market (no price)
  for (const [k, u] of [['mit', 'd'], ['stop', 'e'], ['market', 'f']]) {
    const id = 'pu' + u.repeat(16), x = R.core.sendPlanOrder(plan({ uid: id, kind: k, side: 'short' }), 'entry');
    assert.equal(x.sent, true, k);
    const m = R.sent.pop();
    assert.deepEqual([m.kind, m.side, m.price, m.cid], [k, 'sell', k === 'market' ? undefined : 24990.25, 'pl' + id + '-e']);
  }
  assert.equal(R.notes.filter(n => /Armed/.test(n)).length, 0, 'nothing said about Armed');
});

test('readyPlan and the plan\'s own checks', () => {
  const R = rig(), id = n => 'pu' + n.repeat(16);
  const why = o => R.core.sendPlanOrder(plan(Object.assign({ uid: id('g') }, o)), 'entry').why;
  assert.match(why({ account: 'group:g1' }), /never a group/);
  assert.match(why({ account: 'EVAL-9' }), /not a trade account/);
  assert.match(why({ qty: 6 }), /not allowed on MNQ/);
  assert.match(why({ bracket: { stop: 0, target: 8 } }), /always goes with its stop and target/);
  assert.match(why({ price: 24990.3 }), /not on the tick/);
  R.owner = 'manrae';
  assert.match(why({}), /belongs to agent manrae/);
  R.owner = '';
  R.core.setSwitches({ orderTypes: false });
  assert.match(why({ kind: 'mit' }), /MIT is off/);
  R.core.message({ type: 'orders', list: [], positions: 1 });
  assert.match(why({}), /whole list of orders and positions/, 'a resume waits for the whole snapshot');
  assert.equal(R.sent.length, 0);
  R.core.lost('Not connected to ChartBridge.');
  assert.match(why({}), /Not connected|not enabled/i);
});

test('cancelPlanOrder: { type: cancel, id } after the plan\'s checks, Armed off', () => {
  const R = rig();
  assert.deepEqual(R.core.cancelPlanOrder('o9', plan()), { sent: true, why: '' });
  assert.deepEqual(R.sent, [{ type: 'cancel', id: 'o9' }]);
  assert.equal(R.core.cancelPlanOrder('', plan()).sent, false);
  assert.equal(R.core.cancelPlanOrder('o9', plan({ account: 'group:g' })).sent, false);
  assert.equal(R.sent.length, 1);
});
