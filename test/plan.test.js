'use strict';
// Planned stop and target on a resting entry (chart 1.13.0, ChartBridge 0.3.8, Anthony's ATM rule 2026-10-01): the tick
// math of the planned lines, the drag rules, the cap by ChartBridge's version, and the plan messages TradeCore sends.
const test = require('node:test');
const assert = require('node:assert/strict');
const OT = require('../live/order-ticket.js');
const TC = require('../live/trade.js');
const { LivePrefs: LP } = require('../live/live.js');

const entry = (o) => Object.assign({ id: 'o5', account: 'Sim101', root: 'MNQ', role: 'entry', kind: 'limit', side: 'buy', price: 25000, qty: 2, filled: 0, state: 'working', planned: { stopTicks: 12, targetTicks: 24 } }, o || {});

test('plannedLines: stop and target at the entry price minus and plus the ticks; a sell the other way; ids :sl and :tp', () => {
  const b = OT.plannedLines(entry(), 0.25);
  assert.deepEqual(b.lines.map(l => [l.id, l.side, l.kind, l.price, l.plan.offset, l.plan.role, l.qty]), [['o5:sl', 'sell', 'stop', 24997, -12, 'stop', 2], ['o5:tp', 'sell', 'limit', 25006, 24, 'target', 2]]);
  assert.deepEqual(b.adds, []);
  const s = OT.plannedLines(entry({ side: 'sell', kind: 'stop', price: 25010.25, filled: 1, planned: { stopTicks: 8, targetTicks: null } }), 0.25);
  assert.deepEqual(s.lines.map(l => [l.id, l.side, l.price, l.plan.offset, l.qty]), [['o5:sl', 'buy', 25012.25, 8, 1]]);
  assert.deepEqual(s.adds, ['target'], 'a target can be added back');
  assert.deepEqual(OT.plannedLines(entry({ planned: { stopTicks: null, targetTicks: null } }), 0.25), { lines: [], adds: ['stop', 'target'] });
});

test('plannedLines: nothing without `planned` (an older ChartBridge), on a market entry, a leg, an order placed elsewhere, or a finished one', () => {
  for (const o of [entry({ planned: undefined }), entry({ kind: 'market', price: null }), entry({ role: 'stop' }), entry({ role: 'other' }), entry({ state: 'filled' }), entry({ state: 'cancelled' })])
    assert.deepEqual(OT.plannedLines(o, 0.25), { lines: [], adds: [] }, JSON.stringify(o));
  assert.deepEqual(OT.plannedLines(entry(), 0), { lines: [], adds: [] }, 'no tick: nothing');
});

test('planDrag: the new distance in whole ticks, snapped, at least 1; a stop at or past the entry, or a target, refused', () => {
  const b = entry();
  assert.deepEqual(OT.planDrag(b, 'stop', 24996, 0.25), { ticks: 16 });
  assert.deepEqual(OT.planDrag(b, 'stop', 24999.9, 0.25), { error: OT.planDrag(b, 'stop', 25000, 0.25).error }, 'snaps to the entry: refused');
  assert.deepEqual(OT.planDrag(b, 'stop', 24999.75, 0.25), { ticks: 1 }, 'one tick is the least');
  assert.deepEqual(OT.planDrag(b, 'stop', 24999.8, 0.25), { ticks: 1 }, 'snapped to the grid');
  assert.match(OT.planDrag(b, 'stop', 25001, 0.25).error, /^Not sent: a stop goes on the loss side of the entry \(below it\)/);
  assert.deepEqual(OT.planDrag(b, 'target', 25010, 0.25), { ticks: 40 });
  assert.match(OT.planDrag(b, 'target', 25000, 0.25).error, /^Not sent: a target goes on the profit side of the entry \(above it\)/);
  const s = entry({ side: 'sell' });
  assert.deepEqual(OT.planDrag(s, 'stop', 25003, 0.25), { ticks: 12 });
  assert.match(OT.planDrag(s, 'stop', 24999, 0.25).error, /\(above it\)/);
  assert.deepEqual(OT.planDrag(s, 'target', 24990, 0.25), { ticks: 40 });
  assert.match(OT.planDrag(null, 'stop', 1, 0.25).error, /no longer working/);
});

test('the bracket cap: 200 before ChartBridge 0.3.7, none after unless maxBracketTicks is set', () => {
  assert.equal(OT.bracketCap('fake-0.3.4'), 200);
  assert.equal(OT.bracketCap('0.3.6'), 200);
  assert.equal(OT.bracketCap(''), 200, 'unknown: the safe cap');
  assert.equal(OT.bracketCap('0.3.7'), OT.NO_CAP);
  assert.equal(OT.bracketCap('fake-0.3.8', 300), 300);
  assert.equal(OT.bracketCap('1.0.0', 0), OT.NO_CAP);
  assert.equal(OT.versionAtLeast('0.3.10', '0.3.7'), true);
  assert.equal(OT.versionAtLeast('0.2.9', '0.3.7'), false);
  assert.deepEqual(OT.cleanBracket({ stop: 500, target: 1000 }), { stop: 200, target: 200 });
  assert.deepEqual(OT.cleanBracket({ stop: 500, target: 1000 }, OT.NO_CAP), { stop: 500, target: 1000 });
  assert.deepEqual(OT.planIdOf('o5:sl'), { entry: 'o5', which: 'stop' });
  assert.deepEqual(OT.planIdOf('NT7:tp'), { entry: 'NT7', which: 'target' });
  assert.equal(OT.planIdOf('o5'), null);
});

/* TradeCore with a fake connection: what a planned-line drag, its x and "+SL" send */
function rig(version) {
  const store = new Map(), sent = [], notes = [];
  let clock = 1000;
  const prefs = LP.create({ getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) });
  const core = TC.create({ LP, prefs, fetch: () => new Promise(() => {}), send: m => sent.push(JSON.parse(JSON.stringify(m))), open: () => true, sock: () => 1, root: () => 'MNQ', lastPrice: () => 25010,
    qty: () => 1, pickerAccount: () => core.TR.account, wantedAccount: () => 'Sim101', tick: () => 0.25, served: () => true, fmt: p => p.toFixed(2), flash: (t, l) => notes.push((l ? l + ': ' : '') + t),
    later: () => 0, changed: () => {}, armed: () => {}, applied: () => {}, lost: () => {}, syncAccounts: () => {}, batch: () => {}, unsent: () => {}, destroyed: () => false, now: () => (clock += 500) });
  core.hello({ type: 'hello', version: version || 'fake-0.3.8' });
  core.applyTrading({ enabled: true, accounts: ['Sim101'], maxQty: { MNQ: 5 } });
  core.message({ type: 'order', ...entry() });
  return { core, sent, notes, strip: () => sent.map(m => { const c = Object.assign({}, m); delete c.cid; return c; }) };
}

test('TradeCore: a planned line\'s drag sends plan with the ticks; its x sends null; +SL adds at the bracket stop; Armed and the side checked', () => {
  const r = rig();
  r.core.planMove('o5:sl', 24996);
  assert.equal(r.sent.length, 0, 'disarmed: nothing');
  assert.match(r.notes.pop(), /Armed is off/);
  r.core.setArmed(true);
  r.core.planMove('o5:sl', 24996);
  r.core.planMove('o5:tp', 25012.5);
  r.core.planMove('o5:sl', 25001);                     // across the entry: refused on the page
  assert.match(r.notes.pop(), /a stop goes on the loss side/);
  r.core.planRemove('o5:tp');
  r.core.message({ type: 'order', ...entry({ planned: { stopTicks: 16, targetTicks: null } }) });
  const lines = r.core.chartOrders('Sim101', 'MNQ');
  assert.deepEqual(lines.map(o => o.id + (o.adds ? '+' + o.adds : '')), ['o5+target', 'o5:sl'], 'the entry offers +TP; its stop line');
  r.core.planAdd('o5', 'target');
  assert.match(r.notes.pop(), /bracket target for MNQ is 0/, 'no target in the boxes: nothing to add');
  r.core.setBracket('MNQ', 'target', 30, true);
  r.core.planAdd('o5', 'target');
  assert.deepEqual(r.strip(), [{ type: 'plan', id: 'o5', stopTicks: 16 }, { type: 'plan', id: 'o5', targetTicks: 50 }, { type: 'plan', id: 'o5', targetTicks: null }, { type: 'plan', id: 'o5', targetTicks: 30 }]);
  // an order with no `planned` (an older ChartBridge): no lines, and a plan is never sent for it
  r.core.message({ type: 'order', ...entry({ id: 'o6', planned: undefined }) });
  assert.deepEqual(r.core.chartOrders('Sim101', 'MNQ').filter(o => o.id.startsWith('o6')).map(o => o.id), ['o6']);
  r.core.planMove('o6:sl', 24990);
  assert.match(r.notes.pop(), /has no planned stop and target/);
  assert.equal(r.sent.length, 4);
});

test('TradeCore: the cap follows the version; plan counts toward ChartBridge\'s 10 a second', () => {
  assert.equal(rig('fake-0.3.4').core.cap(), 200);
  assert.equal(rig('0.3.8').core.cap(), OT.NO_CAP);
  assert.ok(TC.ORDER_ACTIONS.includes('plan'));
  const r = rig('0.3.6');
  r.core.setBracket('MNQ', 'stop', 450, true);
  assert.equal(r.core.brackets.MNQ.stop, 200, 'an older ChartBridge: capped at 200 as before');
  const n = rig('0.3.8');
  n.core.setBracket('MNQ', 'stop', 450, true);
  assert.equal(n.core.brackets.MNQ.stop, 450, '0.3.7 and newer: no page cap');
});

test('NO STOP (Anthony): the first order with no stop after a load asks; Send sends it and no later one asks; Flatten never asks', () => {
  const store = new Map(), sent = [], notes = [], asks = [];
  let clock = 1000, canAsk = true;
  const prefs = LP.create({ getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) });
  const core = TC.create({ LP, prefs, fetch: () => new Promise(() => {}), send: m => sent.push(m.type + (m.bracket ? '+b' : '')), open: () => true, sock: () => 1, root: () => 'MNQ', lastPrice: () => 100,
    qty: () => 1, pickerAccount: () => core.TR.account, wantedAccount: () => 'Sim101', tick: () => 0.25, served: () => true, fmt: p => String(p), flash: (t, l) => notes.push((l ? l + ': ' : '') + t),
    later: () => 0, changed: () => {}, armed: () => {}, applied: () => {}, lost: () => {}, syncAccounts: () => {}, batch: () => {}, unsent: () => {}, destroyed: () => false, now: () => (clock += 500),
    confirmNoStop: (root, go) => { if (!canAsk) return false; asks.push({ root, go }); return true; } });
  core.hello({ version: '0.3.8' });
  core.applyTrading({ enabled: true, accounts: ['Sim101'], maxQty: { MNQ: 5 } });
  core.flattenHere(); core.flattenAll();
  assert.deepEqual(sent, ['flatten'], 'Close goes at once, disarmed and with no stop; Flatten all had nothing more to send');
  core.setArmed(true);
  // a forwarded click cannot be asked about here: refused with a note
  canAsk = false;
  core.sendOrder('buy', 'market', null);
  assert.match(notes.pop(), /^warn: No stop on MNQ: nothing was sent/);
  canAsk = true;
  core.sendOrder('buy', 'market', null);
  assert.equal(asks.length, 1); assert.equal(sent.length, 1, 'asked, nothing sent yet');
  asks[0].go();
  assert.deepEqual(sent, ['flatten', 'order'], 'Send: it goes');
  core.placeAt('buy', 99);
  assert.equal(asks.length, 1, 'no second question this page load');
  assert.deepEqual(sent.slice(-1), ['order']);
  // a fresh load with a stop set asks nothing; and an order that reduces the position never asks
  const c2 = TC.create(Object.assign({}, { LP, prefs, fetch: () => new Promise(() => {}), send: m => sent.push(m.type + (m.bracket ? '+b' : '')), open: () => true, sock: () => 1, root: () => 'MNQ', lastPrice: () => 100,
    qty: () => 1, pickerAccount: () => c2.TR.account, wantedAccount: () => 'Sim101', tick: () => 0.25, served: () => true, fmt: p => String(p), flash: () => {}, later: () => 0, changed: () => {}, armed: () => {},
    applied: () => {}, lost: () => {}, syncAccounts: () => {}, batch: () => {}, unsent: () => {}, destroyed: () => false, now: () => (clock += 500), confirmNoStop: (root, go) => { asks.push(go); return true; } }));
  c2.applyTrading({ enabled: true, accounts: ['Sim101'], maxQty: { MNQ: 5 } }); c2.setArmed(true);
  c2.message({ type: 'position', account: 'Sim101', root: 'MNQ', qty: 1, avgPrice: 100 });
  c2.sendOrder('sell', 'market', null);
  assert.equal(asks.length, 1, 'a sell that reduces a long: no question');
  c2.setBracket('MNQ', 'stop', 8, true);
  c2.sendOrder('buy', 'market', null);
  assert.equal(asks.length, 1, 'a stop in the box: no question');
  assert.deepEqual(sent.slice(-2), ['order', 'order+b']);
});

/* ---------------- the F2 review */
test('planDrag from the entry price the chart drew (a move of the entry waits for its answer): the distance shown', () => {
  const b = entry();                                   // ChartBridge last confirmed 25000
  assert.deepEqual(OT.planDrag(b, 'stop', 24996, 0.25), { ticks: 16 }, 'no `from`: from the confirmed price');
  assert.deepEqual(OT.planDrag(b, 'stop', 24996, 0.25, 25001), { ticks: 20 }, 'from the moved entry the chart shows');
  assert.match(OT.planDrag(b, 'stop', 25000.5, 0.25, 25000.25).error, /loss side/, 'across the moved entry: refused');
  assert.deepEqual(OT.planDrag(b, 'target', 25010, 0.25, 25001.1), { ticks: 36 }, '`from` snapped to the grid');
  assert.deepEqual(OT.planDrag(b, 'stop', 24996, 0.25, NaN), { ticks: 16 }, 'a bad `from`: the confirmed price');
  const r = rig();
  r.core.setArmed(true);
  r.core.planMove('o5:sl', 24996, 25001);
  assert.deepEqual(r.strip(), [{ type: 'plan', id: 'o5', stopTicks: 20 }]);
});

test('opensPosition: flat, adding, or a reversal opens a position; a reduce or a close does not', () => {
  assert.equal(OT.opensPosition('buy', 0, 1), true);
  assert.equal(OT.opensPosition('buy', 2, 1), true, 'adding');
  assert.equal(OT.opensPosition('sell', 1, 1), false, 'closing');
  assert.equal(OT.opensPosition('sell', 3, 2), false, 'reducing');
  assert.equal(OT.opensPosition('sell', 1, 3), true, 'long 1, sell 3: opens short 2');
  assert.equal(OT.opensPosition('buy', -2, 5), true, 'short 2, buy 5: opens long 3');
  assert.equal(OT.bracketAllowed('sell', 1), false, 'the bracket rule is unchanged: a reversal takes no bracket');
});

test('NO STOP: a reversal is asked as an entry and goes with no bracket; Close and Flatten all close an open question', () => {
  const store = new Map(), sent = [], asks = []; let clock = 1000, qty = 3, drops = 0;
  const prefs = LP.create({ getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) });
  const core = TC.create({ LP, prefs, fetch: () => new Promise(() => {}), send: m => sent.push(m), open: () => true, sock: () => 1, root: () => 'MNQ', lastPrice: () => 100,
    qty: () => qty, pickerAccount: () => core.TR.account, wantedAccount: () => 'Sim101', tick: () => 0.25, served: () => true, fmt: p => String(p), flash: () => {},
    later: () => 0, changed: () => {}, armed: () => {}, applied: () => {}, lost: () => {}, syncAccounts: () => {}, batch: () => {}, unsent: () => {}, destroyed: () => false, now: () => (clock += 500),
    confirmNoStop: (root, go) => { asks.push(go); return true; }, dropNoStop: () => { drops++; } });
  core.hello({ version: '0.3.8' });
  core.applyTrading({ enabled: true, accounts: ['Sim101'], maxQty: { MNQ: 5 } }); core.setArmed(true);
  core.message({ type: 'position', account: 'Sim101', root: 'MNQ', qty: 1, avgPrice: 100 });
  core.sendOrder('sell', 'market', null);
  assert.equal(asks.length, 1, 'long 1, sell 3: asked');
  asks[0]();
  assert.equal(sent.length, 1); assert.equal(sent[0].qty, 3); assert.equal(sent[0].bracket, undefined, 'the reversal goes with no bracket (1.12.0 rule)');
  drops = 0;
  core.flattenHere(); core.flattenAll();
  assert.equal(drops, 2, 'Close and Flatten all each close an open question first');
  core.setArmed(false);
  assert.equal(drops, 3, 'Armed off closes it too');
});

test('NO STOP (the F2 re-review): an answer is for the instrument, account and Armed it was asked in; else nothing is sent', () => {
  const store = new Map(), sent = [], notes = [], asks = []; let clock = 1000, R = 'MNQ';
  const prefs = LP.create({ getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) });
  const core = TC.create({ LP, prefs, fetch: () => new Promise(() => {}), send: m => sent.push(m), open: () => true, sock: () => 1, root: () => R, lastPrice: () => 100,
    qty: () => 1, pickerAccount: () => core.TR.account, wantedAccount: () => 'Sim101', tick: () => 0.25, served: () => true, fmt: p => String(p), flash: (t, l) => notes.push(t),
    later: () => 0, changed: () => {}, armed: () => {}, applied: () => {}, lost: () => {}, syncAccounts: () => {}, batch: () => {}, unsent: () => {}, destroyed: () => false, now: () => (clock += 500),
    confirmNoStop: (root, go) => { asks.push(go); return true; } });
  core.hello({ version: '0.3.8' });
  core.applyTrading({ enabled: true, accounts: ['Sim101', 'Sim102'], maxQty: { MNQ: 5, NQ: 2 } }); core.setArmed(true);
  core.sendOrder('buy', 'market', null);                       // asked for MNQ
  R = 'NQ'; core.setArmed(false); core.setArmed(true);         // the instrument changed, armed again
  asks[0]();
  assert.equal(sent.length, 0, 'Send after the instrument changed: nothing');
  assert.match(notes.pop(), /^Not sent: that question was for MNQ on Sim101/);
  R = 'MNQ';
  core.sendOrder('buy', 'market', null);
  core.setArmed(false); core.setArmed(true);                   // Armed off and on again
  asks[1]();
  assert.equal(sent.length, 0, 'Send after Armed went off: nothing');
  core.sendOrder('buy', 'market', null);
  core.pickAccount('Sim102'); core.setArmed(true);             // another account
  asks[2]();
  assert.equal(sent.length, 0, 'Send after the account changed: nothing');
  core.pickAccount('Sim101'); core.setArmed(true);
  core.sendOrder('buy', 'market', null);
  asks[3]();
  assert.deepEqual(sent.map(m => m.type + ' ' + m.root), ['order MNQ'], 'as asked: it goes');
});
