'use strict';
// Chart 1.33.0 (ChartBridge 0.6.5, Anthony 2026-10-19): the order ticket on a group (live/trade.js). The entry asks ChartBridge for
// the sizes and sends them after one confirm (a strategy may go with it); the group's chart lines, one per level labelled with the
// group and its member count, each account in the tooltip; a group stop dragged moves every member's stop to the same price, each
// member's result said. A fake clock and connection; made-up accounts and prices.
const test = require('node:test');
const assert = require('node:assert/strict');
const { LivePrefs: LP } = require('../live/live.js');
const TC = require('../live/trade.js');

function rig(gx) {
  let clock = 5000, timers = [], tid = 0;
  const store = new Map();
  const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const R = { sent: [], notes: [], root: 'NQ', last: 25000, strategy: null, confirm: null };
  const groups = [Object.assign({ id: 'g1', name: 'Lucid', perMember: true, riskPct: 10, members: ['SIM-A', 'SIM-B', 'SIM-C'], tradeOut: [] }, gx || {})];
  R.groups = groups;
  const env = {
    LP, prefs: LP.create(storage), fetch: () => Promise.resolve({ ok: true, text: () => Promise.resolve('{"token":"t"}') }),
    send: m => R.sent.push(JSON.parse(JSON.stringify(m))), open: () => true, sock: () => R,
    root: () => R.root, lastPrice: () => R.last, qty: () => 1, pickerAccount: () => core.TR.account, wantedAccount: () => 'group:g1',
    tick: () => 0.25, served: () => true, fmt: p => p.toFixed(2), flash: (t, l) => R.notes.push((l ? l + ': ' : '') + t),
    later: (fn, ms) => { timers.push({ id: ++tid, at: clock + ms, fn }); return tid; },
    changed: () => {}, armed: () => {}, applied: () => {}, lost: () => {}, syncAccounts: () => {}, batch: () => {}, unsent: () => {}, armBlocked: () => '', destroyed: () => false, now: () => clock,
    groups: () => groups, confirmGroup: (m, send, cancel) => { R.confirm = { m, send, cancel }; return true; }, strategy: () => R.strategy,
  };
  const core = TC.create(env);
  R.core = core;
  R.advance = ms => { const end = clock + ms; for (;;) { timers.sort((a, b) => a.at - b.at || a.id - b.id); const t = timers[0]; if (!t || t.at > end) break; timers.shift(); clock = t.at; t.fn(); } clock = end; };
  core.applyTrading({ enabled: true, accounts: ['SIM-A', 'SIM-B', 'SIM-C', 'SIM-D'], maxQty: { NQ: 9 } });
  return R;
}
const order = (id, account, role, side, kind, price, qty, extra) => Object.assign({ type: 'order', id, account, root: 'NQ', role, side, kind, price, qty, filled: 0, state: 'working' }, extra || {});

test('a group stays the ticket\'s account, and the picker lists it', () => {
  const R = rig();
  assert.equal(R.core.TR.account, 'group:g1');
  assert.deepEqual(R.core.groupChoices(), [{ value: 'group:g1', label: 'Group Lucid (3)' }]);
});

test('the entry: no stop refused; the preview, one confirm, then the sizes shown; a strategy goes in place of the bracket (answer 2)', () => {
  const R = rig();
  R.core.setArmed(true);
  R.core.setBracket('NQ', 'stop', 0, true);
  R.core.sendOrder('buy', 'market', null);
  assert.equal(R.sent.length, 0); assert.match(R.notes.pop(), /a group entry needs a stop/);
  R.core.setBracket('NQ', 'stop', 20, true); R.core.setBracket('NQ', 'target', 40, true);
  R.core.sendOrder('buy', 'market', null);
  const pv = R.sent.pop();
  assert.deepEqual(Object.assign({}, pv, { cid: 'x' }), { type: 'groupPreview', cid: 'x', group: 'g1', root: 'NQ', side: 'buy', kind: 'market', bracket: { stop: 20, target: 40 } });
  R.core.message({ type: 'groupPreview', cid: pv.cid, group: 'g1', name: 'Lucid', root: 'NQ', side: 'buy', kind: 'market', stopTicks: 20, riskPct: 10, members: [
    { account: 'SIM-A', size: 4, risk: 400, budget: 450, out: null }, { account: 'SIM-B', size: 0, risk: 0, budget: 200, out: 'its daily room $80 is less than one contract\'s stop ($100)' }, { account: 'SIM-C', size: 1, risk: 100, budget: 100, out: null }] });
  assert.ok(R.confirm, 'one confirm');
  assert.equal(R.sent.length, 0, 'nothing sent before Send');
  R.confirm.send();
  const go = R.sent.pop();
  assert.equal(go.type, 'groupOrder'); assert.equal(go.sizes, 'SIM-A:4,SIM-B:0,SIM-C:1', 'review 2: the accounts with their sizes'); assert.deepEqual(go.bracket, { stop: 20, target: 40 });
  R.advance(6000);
  R.strategy = { name: 'Scalp', wire: { name: 'Scalp', stop: 16, t1: 32, t1Share: 100 } };
  R.core.setSwitches({ strategies: true });
  R.core.setBracket('NQ', 'stop', 0, true);
  R.core.sendOrder('buy', 'market', null);
  const sp = R.sent.pop();
  assert.equal(sp.type, 'groupPreview'); assert.deepEqual(sp.strategy, { name: 'Scalp', stop: 16, t1: 32, t1Share: 100 }); assert.equal(sp.bracket, undefined, 'the strategy in place of the bracket (its stop sizes)');
});

test('answer 1: one chart line per level, labelled with the group and its count, each account in the tooltip; a drag moves each to the same price', () => {
  const R = rig();
  R.core.setArmed(true);
  R.core.message({ type: 'orders', list: [order('o1', 'SIM-A', 'stop', 'sell', 'stop', 24980, 4), order('o2', 'SIM-B', 'stop', 'sell', 'stop', 24980, 2), order('o3', 'SIM-C', 'stop', 'sell', 'stop', 24980, 1),
    order('o4', 'SIM-A', 'target', 'sell', 'limit', 25040, 4), order('o5', 'SIM-D', 'stop', 'sell', 'stop', 24980, 3)] });
  const lines = R.core.chartOrders('group:g1', 'NQ');
  const stop = lines.find(l => l.role === 'stop');
  assert.equal(lines.length, 2, 'the stops at one level are one line; SIM-D is no member');
  assert.equal(stop.qty, 7); assert.equal(stop.group, 'Lucid ×3'); assert.equal(stop.groupTip, 'Group Lucid: SIM-A SELL STP 4 @ 24980.00\nSIM-B SELL STP 2 @ 24980.00\nSIM-C SELL STP 1 @ 24980.00');
  assert.ok(stop.id.startsWith('G~stop~sell~stop~'));
  R.sent.length = 0;
  R.core.moveOrder(stop.id, 24990);
  assert.deepEqual(R.sent.map(m => [m.type, m.id, m.price]), [['change', 'o1', 24990], ['change', 'o2', 24990], ['change', 'o3', 24990]], 'every member\'s stop to the price dropped at');
  const refused = R.sent[2];
  R.core.message({ type: 'reject', cid: refused.cid, id: 'o3', reason: 'that order is no longer working' });
  R.advance(2000);
  assert.equal(R.notes.pop(), 'warn: Group stops to 24990.00: SIM-A, SIM-B moved; SIM-C: refused (that order is no longer working).', 'each member\'s result said');
  R.sent.length = 0;
  R.core.cancelOrder(lines.find(l => l.role === 'target').id);
  assert.deepEqual(R.sent.map(m => m.type + ' ' + m.id), ['cancel o4'], 'the x on a group line cancels each member\'s order there');
});

test('answer 1: Close, Cancel all and B/E act on each member', () => {
  const R = rig();
  R.core.setArmed(true);
  R.core.message({ type: 'position', account: 'SIM-A', root: 'NQ', qty: 2, avgPrice: 24990 });
  R.core.message({ type: 'position', account: 'SIM-B', root: 'NQ', qty: 1, avgPrice: 24995 });
  R.core.message({ type: 'orders', list: [order('o1', 'SIM-A', 'stop', 'sell', 'stop', 24980, 2), order('o2', 'SIM-B', 'stop', 'sell', 'stop', 24980, 1)] });
  R.sent.length = 0;
  R.core.breakEven();
  assert.deepEqual(R.sent.map(m => m.id + ' ' + m.price), ['o1 24990', 'o2 24995'], 'each member\'s stop to its own break-even');
  R.sent.length = 0;
  R.advance(1000);
  R.core.flattenHere();
  assert.deepEqual(R.sent.filter(m => m.type === 'flatten').map(m => m.account).sort(), ['SIM-A', 'SIM-B', 'SIM-C']);
});

test('review 4: Close, Cancel all, B/E and the lines leave out the members ChartBridge leaves out, and say so', () => {
  const R = rig({ members: ['SIM-A', 'SIM-B', 'SIM-C', 'SIM-D'], tradeOut: [{ account: 'SIM-D', why: 'SIM-D is the bot\'s account' }] });
  R.core.setArmed(true);
  R.core.message({ type: 'orders', list: [order('o1', 'SIM-A', 'stop', 'sell', 'stop', 24980, 1), order('o5', 'SIM-D', 'stop', 'sell', 'stop', 24980, 3)] });
  const line = R.core.chartOrders('group:g1', 'NQ')[0];
  assert.equal(line.qty, 1, 'SIM-D\'s stop is not on the group\'s line');
  assert.match(line.groupTip, /\nleft out: SIM-D \(SIM-D is the bot's account\)$/);
  R.sent.length = 0;
  R.core.flattenHere();
  assert.deepEqual(R.sent.filter(m => m.type === 'flatten').map(m => m.account).sort(), ['SIM-A', 'SIM-B', 'SIM-C'], 'never the bot\'s account');
  assert.match(R.notes.pop(), /Left out: SIM-D \(SIM-D is the bot's account\)\.$/);
});

test('review 7: one id per planned level when the members\' prices differ; a member that left mid trade is said', () => {
  const R = rig();
  R.core.setArmed(true);
  const entry = (id, a, stopTicks) => order(id, a, 'entry', 'buy', 'limit', 24990, 1, { planned: { stopTicks, targetTicks: null } });
  R.core.message({ type: 'orders', list: [entry('e1', 'SIM-A', 8), entry('e2', 'SIM-B', 12)] });
  const lines = R.core.chartOrders('group:g1', 'NQ'), ids = lines.map(l => l.id);
  assert.equal(new Set(ids).size, ids.length, 'every line its own id: ' + ids.join(' '));
  assert.equal(lines.filter(l => l.plan).length, 2, 'two planned stops at two prices');
  R.core.message({ type: 'position', account: 'SIM-C', root: 'NQ', qty: 2, avgPrice: 25000 });
  R.core.groupsChanged();
  R.groups[0].members = ['SIM-A', 'SIM-B'];
  R.core.groupsChanged();
  assert.match(R.notes.pop(), /^warn: SIM-C left group Lucid while it holds a position or orders: its own stops stay on SIM-C\./);
  assert.equal(R.core.groupLeftWords('group:g1'), 'SIM-C left the group: its own stops stay');
});

// 1.34.0 (Anthony 2026-10-20): "this screen should not pop up each time I put in a trade with the group, it should only appear
// with an issue. I am fine with showing the projected size, but it should be shown somewhere that's not interrupting the trade"
const pvAll = (cid, sizes) => ({ type: 'groupPreview', cid, group: 'g1', name: 'Lucid', root: 'NQ', side: 'buy', kind: 'market', stopTicks: 20, riskPct: 10,
  members: sizes.map(([account, size, out]) => ({ account, size, risk: size * 100, budget: 450, out: out || null })) });

test('1.34.0: every account takes it: sent at once, no confirm; one sits out: the confirm, as before', () => {
  const R = rig();
  R.core.setArmed(true);
  R.core.setBracket('NQ', 'stop', 20, true);
  R.core.sendOrder('buy', 'market', null);
  const pv = R.sent.pop();
  R.core.message(pvAll(pv.cid, [['SIM-A', 4], ['SIM-B', 2], ['SIM-C', 1]]));
  assert.equal(R.confirm, null, 'no confirm');
  const go = R.sent.pop();
  assert.equal(go.type, 'groupOrder'); assert.equal(go.sizes, 'SIM-A:4,SIM-B:2,SIM-C:1');
  assert.match(R.notes.pop(), /^Sent the group entry to Lucid: SIM-A 4, SIM-B 2, SIM-C 1\.$/);
  R.advance(6000);
  R.core.sendOrder('sell', 'market', null);
  const pv2 = R.sent.pop();
  R.core.message(pvAll(pv2.cid, [['SIM-A', 4], ['SIM-B', 0, 'refused: hedge'], ['SIM-C', 1]]));
  assert.ok(R.confirm, 'an account sits out: the confirm');
  assert.equal(R.sent.length, 0, 'nothing sent before Send');
});

test('1.34.0: the ticket\'s projected sizes: a quiet preview while Armed (never traded), at most one a second, again after 15 s or a change', () => {
  const R = rig();
  R.core.setBracket('NQ', 'stop', 20, true);
  R.core.groupProjectTick();
  assert.equal(R.sent.length, 0, 'not Armed: nothing asked');
  R.core.setArmed(true);
  R.sent.length = 0;
  R.core.groupProjectTick();
  const q = R.sent.pop();
  assert.equal(q.type, 'groupPreview'); assert.ok(q.cid.startsWith('q'));
  assert.equal(R.core.groupProjection(), '', 'nothing shown before the answer');
  R.core.message(pvAll(q.cid, [['SIM-A', 4], ['SIM-B', 0, 'its daily room is too small'], ['SIM-C', 1]]));
  assert.equal(R.core.groupProjection(), 'Next entry: SIM-A 4, SIM-C 1 NQ · $500 at risk · sits out: SIM-B (its daily room is too small)');
  assert.equal(R.confirm, null, 'a quiet preview never opens the confirm');
  assert.equal(R.sent.filter(m => m.type === 'groupOrder').length, 0, 'and never trades');
  R.advance(1500); R.core.groupProjectTick();
  assert.equal(R.sent.length, 0, 'the same key within 15 s: not asked again');
  R.core.setBracket('NQ', 'stop', 30, true);
  assert.equal(R.core.groupProjection(), '', 'a new stop: the old sizes are not shown');
  R.core.groupProjectTick();
  const q2 = R.sent.pop();
  assert.deepEqual(q2.bracket, { stop: 30, target: 0 });
  R.core.message({ type: 'reject', cid: q2.cid, reason: 'too many actions' });
  assert.equal(R.notes.filter(n => /Refused/.test(n)).length, 0, 'a quiet preview refused says nothing');
  R.advance(16000); R.core.groupProjectTick();
  assert.equal(R.sent.pop().type, 'groupPreview', 'asked again later');
});
