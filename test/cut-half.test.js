'use strict';
// Release 1, Bot-Lab plan step 1.6c (Anthony 2026-11-17): Cut half on the order ticket and the mini ticket (live/trade.js,
// live/order-ticket.js), Close renamed Flatten, and the mini ticket's wiring in the workspace (live/workspace.js, live/live.js).
// ChartBridge's side is nt8/check/OrdersHarness.cs (CutHalfChecks). A fake clock and connection; made-up accounts and prices.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LivePrefs: LP } = require('../live/live.js');
const OT = require('../live/order-ticket.js');
const TC = require('../live/trade.js');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function rig(opts) {
  const o = opts || {};
  let clock = 5000, tid = 0;
  const timers = [];
  const store = new Map();
  const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const R = { sent: [], notes: [], root: 'MNQ', owner: '' };
  const groups = [{ id: 'g1', name: 'Evals', perMember: true, riskPct: 10, members: ['EVAL-A', 'EVAL-B', 'EVAL-C'], tradeOut: o.tradeOut || [] }];
  const env = {
    LP, prefs: LP.create(storage), fetch: () => Promise.resolve({ ok: true, text: () => Promise.resolve('{"token":"t"}') }),
    send: m => R.sent.push(JSON.parse(JSON.stringify(m))), open: () => true, sock: () => R,
    root: () => R.root, lastPrice: () => 21480, qty: () => 1, pickerAccount: () => core.TR.account, wantedAccount: () => o.account || 'SIM-1',
    tick: () => 0.25, served: () => true, fmt: p => p.toFixed(2), flash: (t, l) => R.notes.push((l ? l + ': ' : '') + t),
    later: (fn, ms) => { timers.push({ id: ++tid, at: clock + ms, fn }); return tid; },
    changed: () => {}, armed: () => {}, applied: () => {}, lost: () => {}, syncAccounts: () => {}, batch: () => {}, unsent: () => {}, armBlocked: () => '', destroyed: () => false, now: () => clock,
    groups: () => groups, agentOwner: (a, r) => (R.owner && a === R.owner ? 'manrae' : ''),
  };
  const core = TC.create(env);
  R.core = core;
  R.advance = ms => { const end = clock + ms; for (;;) { timers.sort((a, b) => a.at - b.at || a.id - b.id); const t = timers[0]; if (!t || t.at > end) break; timers.shift(); clock = t.at; t.fn(); } clock = end; };
  core.hello({ type: 'hello', features: o.features || ['liveFirst', 'v3', 'cutHalf'] });
  core.applyTrading({ enabled: true, accounts: ['SIM-1', 'SIM-2', 'EVAL-A', 'EVAL-B', 'EVAL-C'], maxQty: { MNQ: 9 } });
  R.pos = (account, qty) => core.message({ type: 'position', account, root: 'MNQ', qty, avgPrice: 21480 });
  return R;
}

test('cutHalfSize and cutHalfPlan: half, the smaller part on an odd size, nothing under 2', () => {
  assert.deepEqual(OT.cutHalfSize(4), { held: 4, cut: 2, keep: 2 });
  assert.deepEqual(OT.cutHalfSize(3), { held: 3, cut: 1, keep: 2 }, '3 closes 1, keeps 2');
  assert.deepEqual(OT.cutHalfSize(5), { held: 5, cut: 2, keep: 3 }, '5 closes 2, keeps 3');
  assert.deepEqual(OT.cutHalfSize(-6), { held: 6, cut: 3, keep: 3 }, 'a short the same way');
  assert.deepEqual(OT.cutHalfSize(2), { held: 2, cut: 1, keep: 1 });
  for (const q of [1, -1, 0, null, undefined, 'x', NaN]) assert.equal(OT.cutHalfSize(q).cut, 0, String(q));
  const pos = new Map([['A|MNQ', { qty: 4 }], ['B|MNQ', { qty: -3 }], ['C|MNQ', { qty: 1 }], ['E|NQ', { qty: 5 }]]);
  assert.deepEqual(OT.cutHalfPlan(['A', 'B', 'C', 'D', 'E'], pos, 'MNQ'), {
    send: [{ account: 'A', position: 4, cut: 2, keep: 2 }, { account: 'B', position: -3, cut: 1, keep: 2 }], alone: ['C'], flat: ['D', 'E'] });
  assert.deepEqual(OT.cutHalfPlan(null, null, 'MNQ'), { send: [], alone: [], flat: [] });
});

test('Cut half on one account: one cutHalf with the position shown; works with Armed off; greyed at 1 and when flat', () => {
  const R = rig();
  assert.equal(R.core.TR.account, 'SIM-1');
  assert.equal(R.core.TR.armed, false);
  assert.deepEqual(R.core.cutHalfState('MNQ'), { ok: false, title: 'Cut half needs 2 or more contracts' }, 'flat: greyed');
  R.pos('SIM-1', 1);
  assert.equal(R.core.cutHalfState('MNQ').ok, false, '1 contract: greyed');
  R.core.cutHalf();
  assert.equal(R.sent.length, 0); assert.match(R.notes.pop(), /^warn: Cut half needs 2 or more contracts on SIM-1 MNQ: nothing was sent\. Flatten closes the 1\.$/);
  R.pos('SIM-1', 4);
  assert.deepEqual(R.core.cutHalfState('MNQ'), { ok: true, title: 'Cut half: close 2 of 4 at market; the stop and target shrink to 2. Works with Armed off.' });
  R.core.cutHalf();
  assert.equal(R.sent.length, 1);
  const m = R.sent[0];
  assert.deepEqual(Object.assign({}, m, { cid: 'x' }), { type: 'cutHalf', cid: 'x', account: 'SIM-1', root: 'MNQ', position: 4 }, 'Armed off: sent all the same');
  assert.match(m.cid, /^p/);
  assert.equal(R.core.lastCid(), m.cid, 'its cid: a refusal goes back to a window that forwarded it');
  assert.equal(R.notes.pop(), 'Cut half sent for SIM-1 MNQ: close 2 of 4 at market; the stop and target shrink to 2.');
  R.core.cutHalf();
  assert.equal(R.sent.length, 1, 'a repeat click within 0.4 s sends nothing'); assert.match(R.notes.pop(), /repeat click/);
  R.advance(500);
  R.pos('SIM-1', -5);
  R.core.cutHalf();
  assert.deepEqual([R.sent[1].position, R.notes.pop()], [-5, 'Cut half sent for SIM-1 MNQ: close 2 of 5 at market; the stop and target shrink to 3.'], 'a short of 5: closes 2, keeps 3');
});

test('Cut half on a group: each member on its own size, a member at 1 left alone and named; paced within 10 a second', () => {
  const R = rig({ account: 'group:g1' });
  assert.equal(R.core.TR.account, 'group:g1');
  R.pos('EVAL-A', 4); R.pos('EVAL-B', 3); R.pos('EVAL-C', 1);
  const st = R.core.cutHalfState('MNQ');
  assert.equal(st.ok, true);
  assert.equal(st.title, 'Cut half on group Evals: EVAL-A closes 2 of 4, EVAL-B closes 1 of 3 at market, each stop and target shrunk to its size left; left alone (1 contract): EVAL-C. Works with Armed off.');
  R.core.cutHalf();
  assert.deepEqual(R.sent.map(m => [m.type, m.account, m.position]), [['cutHalf', 'EVAL-A', 4], ['cutHalf', 'EVAL-B', 3]], 'one per member, each its own size; EVAL-C (1) never sent');
  assert.equal(R.notes.pop(), 'Cut half sent for group Evals MNQ: EVAL-A closes 2 of 4, EVAL-B closes 1 of 3 at market, each stop and target shrunk to its size left. Left alone (1 contract): EVAL-C.');
  // every member at 1 or flat: nothing sent, the ones at 1 named
  const R2 = rig({ account: 'group:g1' });
  R2.pos('EVAL-A', 1); R2.pos('EVAL-B', -1);
  assert.deepEqual(R2.core.cutHalfState('MNQ'), { ok: false, title: 'Cut half needs 2 or more contracts on a member' });
  R2.core.cutHalf();
  assert.equal(R2.sent.length, 0); assert.equal(R2.notes.pop(), 'warn: Cut half needs 2 or more contracts on group Evals MNQ: nothing was sent. Left alone (1 contract): EVAL-A, EVAL-B.');
  // a member the group entry leaves out (the copier's, the bot's, an agent's) is never cut from the ticket
  const R3 = rig({ account: 'group:g1', tradeOut: [{ account: 'EVAL-B', why: 'a copier follower' }] });
  R3.pos('EVAL-A', 2); R3.pos('EVAL-B', 4);
  R3.core.cutHalf();
  assert.deepEqual(R3.sent.map(m => m.account), ['EVAL-A']);
});

test('Cut half paces a big group within ChartBridge\'s 10 a second, reading each later member again', () => {
  const R = rig({ account: 'group:g1' });
  const members = Array.from({ length: 12 }, (_, i) => 'EVAL-' + (i + 1));
  R.core.groupOf('group:g1').members.splice(0, 3, ...members);
  R.core.applyTrading({ enabled: true, accounts: members, maxQty: { MNQ: 9 } });
  for (const a of members) R.pos(a, 2);
  R.core.cutHalf();
  assert.equal(R.sent.length, 10, '10 now');
  assert.equal(R.core.busy().cutHalf, true);
  R.pos('EVAL-12', 1);                                     // its size changed before its turn
  R.core.cutHalf();
  assert.equal(R.sent.length, 10); assert.match(R.notes.pop(), /^warn: Cut half under way on group Evals: EVAL-11, EVAL-12 left\. Nothing new was sent\.$/);
  R.advance(1200);
  assert.deepEqual(R.sent.slice(10).map(m => m.account), ['EVAL-11'], 'the rest as the rate allows; EVAL-12 read again: under 2 now, not sent');
  assert.equal(R.core.busy().cutHalf, false);
  assert.match(R.notes.pop(), /EVAL-12 not sent \(under 2 contracts now\)/);
});

test('Cut half refuses before sending: an older ChartBridge, an agent\'s pair, trading off, None', () => {
  const R = rig({ features: ['liveFirst', 'v3'] });
  R.pos('SIM-1', 4);
  assert.equal(R.core.cutHalfState('MNQ').ok, false);
  assert.match(R.core.cutHalfState('MNQ').title, /needs ChartBridge 0\.6\.24/);
  R.core.cutHalf();
  assert.equal(R.sent.length, 0); assert.match(R.notes.pop(), /needs ChartBridge 0\.6\.24 or newer: nothing was sent/);
  const A = rig();
  A.owner = 'SIM-1'; A.pos('SIM-1', 4);
  A.core.cutHalf();
  assert.equal(A.sent.length, 0); assert.match(A.notes.pop(), /^error: Not sent: SIM-1 MNQ belongs to agent manrae: use Flatten/);
  const N = rig();
  N.core.pickAccount('');
  N.core.cutHalf();
  assert.equal(N.sent.length, 0); assert.match(N.notes.pop(), /No account \(None\)/);
  const O = rig();
  O.pos('SIM-1', 4);
  O.core.applyTrading({ enabled: false, reason: 'trading is off in config.txt' });
  assert.equal(O.core.cutHalfState('MNQ').ok, false);
  O.core.cutHalf();
  assert.equal(O.sent.length, 0);
});

test('Close is named Flatten (the same action and hotkey id), Cut half has its own hotkey, both on the ticket', () => {
  assert.deepEqual(OT.HOTKEY_ACTIONS.find(a => a.id === 'close'), { id: 'close', name: 'Flatten' });
  assert.deepEqual(OT.HOTKEY_ACTIONS.find(a => a.id === 'cutHalf'), { id: 'cutHalf', name: 'Cut half' });
  assert.ok(TC.ORDER_ACTIONS.includes('cutHalf'), 'counted in the 10 a second');
  const ws = read('live/workspace.js');
  assert.match(ws, /data-tk-id="flattenBtn" title="Flatten: cancel every working order on this account and instrument, then close the position at market\. Works with Armed off\.">Flatten<\/button><button type="button" class="btn" data-tk-id="cutHalfBtn" title="Cut half">Cut half<\/button>/);
  assert.ok(!/>Close<\/button>/.test(ws.slice(ws.indexOf('function mountTicket('), ws.indexOf('function ticketArmedUi('))), 'no Close button left on the ticket');
  assert.match(ws, /cutHalf: underTab\('cutHalf', \(\) => keyAct\('cutHalf'\)\)/, 'the key: to the ticket\'s window, like B/E');
  assert.match(ws, /else if \(a\.kind === 'cutHalf'\) core\.cutHalf\(\);/);
  // the wiring: one handler, the core's own function (no second order path), never dimmed by Armed
  const tr = read('live/trade.js');
  assert.match(tr, /if \(\$\('cutHalfBtn'\)\) \$\('cutHalfBtn'\)\.addEventListener\('click', pointerOnly\(\(\) => core\.cutHalf\(\)\)\);/);
  assert.match(tr, /for \(const id of \['buyMkt', 'sellMkt', 'beBtn', 'cancelAllBtn'\]\) \$\(id\)\.classList\.toggle\('is-off', !TR\.armed\);/, 'Cut half is not in the dimmed list');
});

test('the mini ticket: an indicator only where the host draws it; the host wires the ticket\'s own controls, never a second ticket', () => {
  const d = LP.INDICATORS.find(x => x.id === 'ticket');
  assert.ok(d && d.name === 'Mini ticket' && d.cat === 'trades' && d.nochip === true);
  assert.equal(LP.DEFAULT_INDICATORS.ticket, false); assert.equal(LP.NEW_PANE_INDICATORS.ticket, false);
  const live = read('live/live.js');
  assert.match(live, /const hostOnly = d => d\.id !== 'ticket' \|\| !!\(opt\.trade && typeof opt\.trade\.mini === 'function'\);/);
  assert.match(live, /miniOff = HOST\.mini\(\{ stage: \$\('chart'\)\.parentElement, paneId: PANE, root: \(\) => S\.root \}\)/);
  const ws = read('live/workspace.js');
  assert.match(ws, /mini: o => mountMini\(o\),/);
  const mini = ws.slice(ws.indexOf('function buildMini('), ws.indexOf('function miniAwayText('));
  assert.match(mini, /m\.bar = TC\.wire\(id => map\[id\] \|\| null, core, \{/, 'in the ticket\'s window: the ticket\'s core, wired again');
  assert.ok(!/TC\.create\(/.test(ws.slice(ws.indexOf('/* ======================================================================== the mini ticket'), ws.indexOf('function miniRemote('))), 'no TradeCore of its own');
  assert.match(mini, /const fwd = kind => click\(\(\) => forward\(\{ kind, root: m\.root\(\) \}/, 'another window: forwarded with its chart\'s instrument');
  for (const k of ['buy', 'sell', 'be', 'cutHalf', 'cancelAll', 'merge']) assert.match(mini, new RegExp("fwd\\('" + k + "'\\)"), k);
  assert.match(mini, /e\.stopImmediatePropagation\(\); e\.preventDefault\(\); b\.blur\(\);\s*miniNote\(m, miniAwayText\(m\), 'warn'\);/, 'on another instrument: nothing goes');
  // the forwarded kinds are checked for the instrument in the ticket's window
  assert.match(ws, /\['place', 'placeTyped', 'move', 'cancel', 'planAdd', 'buy', 'sell', 'be', 'merge', 'cutHalf', 'cancelAll'\]\.includes\(a\.kind\)/);
  // the spot per chart
  assert.match(ws, /const MINI_KEY = 'live-mini-ticket-v1';/);
  assert.match(ws, /saveMiniSpot\(m\.paneId, m\.spot\.x, m\.spot\.y\);/);
});
