'use strict';
// TradeCore (live/trade.js, 1.12.0): the order logic shared by the single chart page's order bar and the workspace's
// order ticket. The ticket's state (instrument, account, Armed only where the ticket is), what each action sends, and
// Flatten all's per-root retry after a rate refusal (the 1.11.0 review). A fake clock and connection; sample values.
const test = require('node:test');
const assert = require('node:assert/strict');
const { LivePrefs: LP } = require('../live/live.js');
const TC = require('../live/trade.js');

function rig(opts) {
  const o = opts || {};
  let clock = 5000, timers = [], tid = 0;
  const store = new Map();
  const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const R = { sent: [], notes: [], root: o.root || 'MNQ', last: 100, qty: 1, picker: null, armedBlocked: '', open: true, renders: 0, unsent: 0 };
  const env = {
    LP, prefs: LP.create(storage), fetch: () => Promise.resolve({ ok: true, text: () => Promise.resolve('{"token":"t"}') }),
    send: m => R.sent.push(JSON.parse(JSON.stringify(m))), open: () => R.open, sock: () => R,
    root: () => R.root, lastPrice: () => R.last, qty: () => R.qty, pickerAccount: () => (R.picker === null ? core.TR.account : R.picker),
    wantedAccount: () => (o.wanted === undefined ? 'Sim101' : o.wanted),   // picked on this PC (DECISION 2026-10-14e: '' is None, no Sim101 fallback)
    tick: () => 0.25, served: () => true, fmt: p => p.toFixed(2),
    flash: (t, l) => R.notes.push((l ? l + ': ' : '') + t),
    later: (fn, ms) => { timers.push({ id: ++tid, at: clock + ms, fn }); return tid; },
    changed: () => { R.renders++; }, armed: () => {}, applied: () => {}, lost: () => {}, syncAccounts: () => {},
    batch: () => {}, unsent: () => { R.unsent++; }, armBlocked: () => R.armedBlocked, destroyed: () => false, now: () => clock,
    framed: !!o.framed,
  };
  const core = TC.create(env);
  R.core = core;
  R.advance = ms => {
    const end = clock + ms;
    for (;;) { timers.sort((a, b) => a.at - b.at || a.id - b.id); const t = timers[0]; if (!t || t.at > end) break; timers.shift(); clock = t.at; t.fn(); }
    clock = end;
  };
  R.on = () => core.applyTrading({ enabled: true, accounts: ['Sim101', 'EVAL-1'], maxQty: { MNQ: 5, '*': 2 } });
  R.pos = (account, root, qty) => core.message({ type: 'position', account, root, qty, avgPrice: 100 });
  R.flattens = () => R.sent.filter(m => m.type === 'flatten').map(m => m.account + ' ' + m.root);
  R.rate = () => core.message({ type: 'reject', reason: 'More than 10 order actions in one second. Slow down.' });
  return R;
}

test('the ticket: orders go to its instrument and account, with its qty and bracket; Armed only where allowed', () => {
  const R = rig({ wanted: 'EVAL-1' });
  R.on();
  assert.equal(R.core.TR.account, 'EVAL-1', 'the account it was on, when ChartBridge allows it');
  R.core.sendOrder('buy', 'market', null);
  assert.equal(R.sent.length, 0);
  assert.match(R.notes.pop(), /Armed is off: nothing was sent/);
  R.armedBlocked = 'The order ticket is in another window.';
  R.core.setArmed(true);
  assert.equal(R.core.TR.armed, false, 'a window without the ticket never arms');
  R.armedBlocked = '';
  R.core.setArmed(true);
  assert.equal(R.core.TR.armed, true);
  R.core.setBracket('NQ', 'stop', 8, true); R.core.setBracket('NQ', 'target', 16, true);
  R.root = 'NQ'; R.qty = 2;
  R.core.sendOrder('buy', 'market', null);
  const m = R.sent.pop(); delete m.cid;
  assert.deepEqual(m, { type: 'order', account: 'EVAL-1', root: 'NQ', side: 'buy', kind: 'market', qty: 2, bracket: { stop: 8, target: 16 } });
  R.advance(500);
  R.core.placeAt('sell', 101);                    // a chart click above the last price sells with a limit
  const p = R.sent.pop(); delete p.cid;
  assert.deepEqual(p, { type: 'order', account: 'EVAL-1', root: 'NQ', side: 'sell', kind: 'limit', qty: 2, price: 101, bracket: { stop: 8, target: 16 } });
  R.advance(500);
  R.qty = 3;
  R.core.sendOrder('buy', 'market', null);
  assert.match(R.notes.pop(), /Qty 3 is over the NQ cap of 2/);
  // the picker showing another account than the order account: nothing goes
  R.picker = 'Sim101'; R.qty = 1; R.advance(500);
  R.core.sendOrder('buy', 'market', null);
  assert.match(R.notes.pop(), /the account shown was not the order account/);
  R.picker = null;
  // a new account picked: Armed off
  R.core.pickAccount('Sim101');
  assert.equal(R.core.TR.armed, false);
  assert.equal(R.core.TR.account, 'Sim101');
});

test('Close for another instrument (the ticket\'s "Also open" line), and Flatten while disarmed', () => {
  const R = rig();
  R.on();
  R.pos('Sim101', 'ES', 2);
  R.core.flattenHere('ES');
  assert.deepEqual(R.flattens(), ['Sim101 ES']);
  assert.equal(R.notes.pop(), 'Flatten sent for Sim101 ES: cancel its orders, close the position at market.');
  R.core.flattenHere();
  assert.deepEqual(R.flattens(), ['Sim101 ES', 'Sim101 MNQ'], 'a Close on the instrument shown right after is not a repeat of the other');
});

test('a Flatten refused for the rate goes again once 1.1 s later, with the 1.11.0 notes', () => {
  const R = rig();
  R.on();
  R.core.flattenHere();
  assert.equal(R.rate(), true);
  assert.equal(R.notes.pop(), 'warn: ChartBridge refused Flatten for Sim101 MNQ (more than 10 order actions a second): sending it again in 1 s.');
  R.advance(1100);
  assert.deepEqual(R.flattens(), ['Sim101 MNQ', 'Sim101 MNQ']);
  assert.equal(R.notes.pop(), 'warn: Flatten sent again for Sim101 MNQ.');
  // refused again: shown as ChartBridge said, not sent a third time
  R.rate();
  assert.match(R.notes.pop(), /^error: Refused by ChartBridge: More than 10 order actions/);
  R.advance(2000);
  assert.equal(R.flattens().length, 2);
  // the instrument shown changed before the retry: not sent, the note stays
  R.advance(5000);
  R.core.flattenHere(); R.rate(); R.root = 'ES'; R.advance(1100);
  assert.equal(R.flattens().length, 3);
  assert.equal(R.core.unsentNote().text, 'Flatten for Sim101 MNQ was refused by ChartBridge (more than 10 order actions a second) and not sent again: the account or instrument shown changed. The position may still be open. Flatten again.');
});

test('Flatten all: every refused root is kept and sent again (not only the last), and the note names them all', () => {
  const R = rig();
  R.on();
  R.pos('Sim101', 'MNQ', 1); R.pos('Sim101', 'NQ', -2); R.pos('Sim101', 'ES', 1);
  R.root = 'ES';                                   // whatever is shown
  R.core.flattenAll();
  assert.deepEqual(R.flattens(), ['Sim101 MNQ', 'Sim101 NQ', 'Sim101 ES']);
  // ChartBridge refused two of them (the latest: NQ and ES)
  R.rate(); R.rate();
  assert.equal(R.notes.pop(), 'warn: ChartBridge refused Flatten for Sim101 ES, NQ (more than 10 order actions a second): sending them again in 1 s.');
  R.root = 'MNQ';                                  // Flatten all's retry does not depend on the instrument shown
  R.advance(1100);
  assert.deepEqual(R.flattens().slice(3), ['Sim101 ES', 'Sim101 NQ']);
  assert.equal(R.notes.pop(), 'warn: Flatten sent again for Sim101 ES, NQ.');
  // trading off before a retry: every root it could not send is named
  R.advance(5000);
  R.core.flattenAll(); R.rate(); R.rate(); R.rate();
  R.core.applyTrading({ enabled: false, reason: 'Trading is off.' });
  R.advance(1100);
  assert.equal(R.flattens().length, 8, 'nothing sent again while trading is off');
  assert.equal(R.core.unsentNote().text, 'Flatten for Sim101 ES, NQ, MNQ were refused by ChartBridge (more than 10 order actions a second) and not sent again: trading went off. Those positions may still be open. Flatten again.');
});

test('Flatten all paced within ChartBridge\'s 10 a second, and a run finishes on the account named at the press', () => {
  const R = rig();
  R.on(); R.core.setArmed(true);
  for (const r of ['MNQ', 'NQ', 'ES', 'MES']) R.pos('Sim101', r, 1);
  for (let i = 0; i < 8; i++) { R.advance(10); R.core.placeAt('buy', 90 - i); }
  const before = R.sent.length;
  R.advance(10);
  R.core.flattenAll();
  assert.equal(R.sent.length - before, 2, 'room for 2 now');
  R.core.pickAccount('EVAL-1');                    // the picker moves on: the run still goes to Sim101
  R.advance(1200);
  assert.deepEqual(R.flattens(), ['Sim101 MNQ', 'Sim101 NQ', 'Sim101 MES', 'Sim101 ES']);
  assert.equal(R.core.busy().flattenAll, false);
});

test('a chart click from another window: sent with the chart\'s kind only when the ticket\'s own recent price agrees (review S)', () => {
  const R = rig();
  R.on(); R.core.setArmed(true);
  R.last = 100;
  // the chart (fresh) says a buy at 98 is a limit; the ticket agrees: sent as a limit, the cid returned
  const cid = R.core.placeChecked('buy', 'limit', 98);
  const m = R.sent.pop();
  assert.equal(m.kind, 'limit'); assert.equal(m.price, 98); assert.equal(cid, m.cid);
  R.advance(500);
  // the chart saw the market fall to 90 (a buy at 95 is a STOP there); the ticket still has 100 (a limit): refused, not flipped
  assert.equal(R.core.placeChecked('buy', 'stop', 95), '');
  assert.equal(R.sent.length, 0);
  assert.equal(R.notes.pop(), 'warn: Not sent: the chart and the order ticket see MNQ differently (the chart: BUY STP, the ticket: LMT by 100.00). Click again.');
  // no recent price on the ticket's side: refused
  R.last = null; R.advance(500);
  assert.equal(R.core.placeChecked('buy', 'limit', 95), '');
  assert.match(R.notes.pop(), /^warn: Not sent: the order ticket has no recent MNQ price/);
  // the chart had no price (no kind): refused, as a click with no price is on one page
  R.last = 100;
  assert.equal(R.core.placeChecked('buy', null, 95), '');
  assert.equal(R.sent.length, 0);
  // disarmed: the Armed note first, as every order action
  R.core.setArmed(false);
  R.core.placeChecked('buy', 'limit', 95);
  assert.match(R.notes.pop(), /^warn: Armed is off/);
});

test('1.17.0: on a pair an AI agent owns, only a market exit that reduces is sent; a resting order is refused before sending', () => {
  let owner = 'demo';
  const sent = [], notes = [], store = new Map();
  let clock = 9000;
  // a TradeCore with the workspace's agentOwner hook (the Agent tab answers it)
  const core = TC.create({ LP, prefs: LP.create({ getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) }),
    fetch: () => Promise.resolve({ ok: true, text: () => Promise.resolve('{"token":"t"}') }), send: m => sent.push(m), open: () => true, sock: () => ({}),
    root: () => 'MNQ', lastPrice: () => 100, qty: () => 1, pickerAccount: () => core.TR.account, wantedAccount: () => 'Sim101', tick: () => 0.25, served: () => true, fmt: p => p.toFixed(2),
    flash: (t, l) => notes.push((l ? l + ': ' : '') + t), later: () => 0, changed: () => {}, armed: () => {}, applied: () => {}, lost: () => {}, syncAccounts: () => {},
    batch: () => {}, unsent: () => {}, armBlocked: () => '', destroyed: () => false, now: () => (clock += 500),
    agentOwner: (account, root) => (account === 'Sim101' && root === 'MNQ' ? owner : '') });
  core.applyTrading({ enabled: true, accounts: ['Sim101'], maxQty: { MNQ: 5 } });
  core.setArmed(true);
  core.message({ type: 'position', account: 'Sim101', root: 'MNQ', qty: 2, avgPrice: 100 });
  core.setBracket('MNQ', 'stop', 8, true); core.setBracket('MNQ', 'target', 8, true);
  const words = /^error: Not sent: Sim101 MNQ belongs to agent demo: use Flatten, or move its stop or target\.$/;
  core.placeAt('sell', 101);                                   // a resting sell limit above: an exit that could outlive the position
  assert.equal(sent.length, 0); assert.match(notes.pop(), words);
  core.placeAt('sell', 99);                                    // a resting sell stop below
  assert.equal(sent.length, 0); assert.match(notes.pop(), words);
  core.sendOrder('buy', 'market', null);                       // adding: an entry
  assert.equal(sent.length, 0); assert.match(notes.pop(), words);
  core.sendOrder('sell', 'market', null);                      // a market exit that only reduces: sent, no bracket
  assert.equal(sent.length, 1); assert.equal(sent[0].kind, 'market'); assert.equal(sent[0].bracket, undefined);
  owner = '';                                                  // not owned: as before
  core.placeAt('sell', 101);
  assert.equal(sent.length, 2); assert.equal(sent[1].kind, 'limit');
});

test('ChartBridge 0.5.1: a finished order sent again after a snapshot flashes once (one fill note, one rejected note)', () => {
  const R = rig();
  R.on();
  const o = { type: 'order', id: 'o7', account: 'Sim101', root: 'MNQ', name: 'MNQ 12-26', side: 'buy', kind: 'limit', qty: 1, price: 100, state: 'working', filled: 0 };
  R.core.message(o);
  R.notes.length = 0;
  const filled = Object.assign({}, o, { state: 'filled', filled: 1, avgFill: 100 });
  R.core.message(filled);
  R.core.message(Object.assign({}, filled, { again: true }));
  assert.equal(R.notes.filter(n => /Filled/.test(n)).length, 1, R.notes.join(' / '));
  const r = { type: 'order', id: 'o8', account: 'Sim101', root: 'MNQ', name: 'MNQ 12-26', side: 'sell', kind: 'stop', qty: 1, price: 95, state: 'rejected', filled: 0, text: 'NinjaTrader: OrderRejected' };
  R.core.message(r);
  R.core.message(Object.assign({}, r, { again: true }));
  assert.equal(R.notes.filter(n => /Rejected/.test(n)).length, 1, R.notes.join(' / '));
  // a working order sent again merges, quietly
  R.notes.length = 0;
  R.core.message(Object.assign({}, o, { id: 'o9', again: true }));
  assert.equal(R.notes.length, 0);
  assert.ok(R.core.TR.orders.has('o9'));
});

test('ChartBridge 0.5.1: a re-send (again) that reads ahead of NinjaTrader\'s own message never swallows its note', () => {
  const R = rig();
  R.on();
  const q = { type: 'order', id: 'q1', account: 'Sim101', root: 'MNQ', name: 'MNQ 12-26', side: 'buy', kind: 'limit', qty: 2, price: 100, state: 'working', filled: 0 };
  R.core.message(q);
  R.notes.length = 0;
  const part = Object.assign({}, q, { state: 'partFilled', filled: 1, avgFill: 100 });
  R.core.message(Object.assign({}, part, { again: true }));   // the snapshot's fresh read, ahead of the event
  R.core.message(part);                                        // NinjaTrader's own message for the part fill
  assert.equal(R.notes.filter(n => /Part filled/.test(n)).length, 1, 'part fill: ' + R.notes.join(' / '));
  assert.equal(R.core.TR.orders.get('q1').filled, 1);
});

test('ChartBridge 0.5.1: a moved order re-sent (again) ahead of NinjaTrader\'s own message: the move is said once', () => {
  const R = rig();
  R.on();
  const q = { type: 'order', id: 'q1', account: 'Sim101', root: 'MNQ', name: 'MNQ 12-26', side: 'buy', kind: 'limit', qty: 2, price: 100, state: 'working', filled: 0 };
  const q2 = Object.assign({}, q, { id: 'q2' });
  R.core.message(q2);
  R.notes.length = 0;
  const moved = Object.assign({}, q2, { price: 99 });
  R.core.message(Object.assign({}, moved, { again: true }));
  R.core.message(moved);
  assert.equal(R.notes.filter(n => /Moved/.test(n)).length, 1, 'move: ' + R.notes.join(' / '));
  assert.equal(R.core.TR.orders.get('q2').price, 99);
  // finished, a new orders list or a dropped connection leave nothing behind (both maps agree)
  R.core.message(Object.assign({}, moved, { state: 'cancelled' }));
  R.core.message({ type: 'orders', list: [Object.assign({}, q, { id: 'q3' })] });
  R.notes.length = 0;
  R.core.message(Object.assign({}, q, { id: 'q3', price: 98 }));
  assert.equal(R.notes.filter(n => /Moved/.test(n)).length, 1, 'an order from the orders list: its move is said once: ' + R.notes.join(' / '));
});

test('ChartBridge 0.5.1: a stop placed while the sign-in list was built, left out of it and re-sent (again): its next move reads Moved', () => {
  const R = rig();
  R.on();
  const y = { type: 'order', id: 'y1', account: 'Sim101', root: 'MNQ', name: 'MNQ 12-26', side: 'sell', kind: 'stop', qty: 1, price: 95, state: 'working', filled: 0 };
  R.core.message(y);                                           // its own message: "Working SELL STP 1 @ 95.00"
  R.core.message({ type: 'orders', list: [] });                // the sign-in list, built just before it, arrives without it
  R.core.message(Object.assign({}, y, { again: true }));       // the snapshot's re-send
  assert.ok(R.core.TR.orders.has('y1'));
  R.notes.length = 0;
  R.core.message(Object.assign({}, y, { price: 94 }));         // Anthony moves it
  assert.equal(R.notes.length, 1, R.notes.join(' / '));
  assert.match(R.notes[0], /^Moved SELL STP 1 @ 94\.00/);
});

test('1.22.0 (F2 again): a moved entry is drawn at the price asked for until ChartBridge answers, its planned lines with it', () => {
  const R = rig();
  R.on(); R.core.setArmed(true);
  const e = { type: 'order', id: 'e1', account: 'Sim101', root: 'MNQ', name: 'MNQ 12-26', side: 'buy', kind: 'limit', qty: 1, price: 98, state: 'working', filled: 0, role: 'entry', planned: { stopTicks: 16, targetTicks: 24 } };
  R.core.message(e);
  const entryOf = () => R.core.chartOrders('Sim101', 'MNQ').find(x => x.id === 'e1');
  assert.equal(entryOf().movePending, undefined, 'nothing waits yet');
  R.core.moveOrder('e1', 98.25);
  const ch = R.sent.pop();
  assert.ok(typeof ch.cid === 'string' && ch.cid && R.core.lastCid() === ch.cid, 'the change carries a cid (its refusal is matched by it, and a forwarded drag is told)');
  delete ch.cid;
  assert.deepEqual(ch, { type: 'change', id: 'e1', price: 98.25 });
  assert.equal(entryOf().movePending, 98.25, 'drawn where it was dropped while the move waits');
  assert.equal(entryOf().price, 98, 'the order itself stays as ChartBridge last said');
  // the answer to a plan sent meanwhile still carries the old price: the move still waits
  R.core.message(Object.assign({}, e, { planned: { stopTicks: 20, targetTicks: 24 } }));
  assert.equal(entryOf().movePending, 98.25, 'an order message at the old price (after a plan) does not end the wait');
  // ChartBridge's answer at the new price: drawn as it says
  R.core.message(Object.assign({}, e, { price: 98.25, planned: { stopTicks: 20, targetTicks: 24 } }));
  assert.equal(entryOf().movePending, undefined, 'answered: no longer waiting');
  assert.equal(entryOf().price, 98.25);
  // a refused plan names the entry too: the move still waits; a reject with another cid does not end it either
  R.advance(500);
  R.core.moveOrder('e1', 97.5);
  const cid = R.sent.pop().cid;
  assert.equal(entryOf().movePending, 97.5);
  R.core.message({ type: 'reject', cid: 'p-plan-1', id: 'e1', reason: 'stopTicks must be at most 200' });
  assert.equal(entryOf().movePending, 97.5, 'a refused plan (its own cid) does not end the move\'s wait');
  R.core.message({ type: 'reject', id: 'e1', reason: 'no cid' });
  assert.equal(entryOf().movePending, 97.5, 'a reject without the change\'s cid does not end it');
  // the move refused (its change's cid): the line goes back at once
  R.notes.length = 0;
  R.core.message({ type: 'reject', cid, id: 'e1', reason: 'price too far' });
  assert.equal(entryOf().movePending, undefined, 'refused: drawn at the confirmed price again');
  assert.deepEqual(R.notes, ['error: Refused by ChartBridge: price too far'], 'no planned line was dragged meanwhile: the usual line only');
  // a planned stop dragged while the move waits, then the move refused: one line says where the stop really is
  R.advance(500);
  R.core.moveOrder('e1', 97.5);                                   // the entry is at 98.25; dropped at 97.50
  const cid2 = R.sent.pop().cid;
  R.advance(500);
  R.core.planMove('e1:sl', 92.5, 97.5);                           // 20 ticks under the dropped entry
  const pm = R.sent.pop(); delete pm.cid;
  assert.deepEqual(pm, { type: 'plan', id: 'e1', stopTicks: 20 }, 'the stop goes as 20 ticks, from where the entry was dropped');
  R.notes.length = 0;
  assert.equal(R.core.moveRefusal({ type: 'reject', cid: cid2, id: 'e1', reason: 'price too far' }), 'Order e1 stays at 98.25: its planned stop is 20 ticks from it, at 93.25 (dropped at 92.50).');
  assert.equal(R.core.moveRefusal({ type: 'reject', cid: 'other', id: 'e1', reason: 'x' }), '', 'only for the move\'s own refusal');
  R.core.message({ type: 'reject', cid: cid2, id: 'e1', reason: 'price too far' });
  assert.deepEqual(R.notes, ['error: Refused by ChartBridge: price too far Order e1 stays at 98.25: its planned stop is 20 ticks from it, at 93.25 (dropped at 92.50).'], 'one line in the notes');
  assert.equal(entryOf().movePending, undefined);
  // another workspace window that forwarded the drag keeps the same wait (no cid): its own order messages or 5 s end it
  R.core.noteMoving('e1', 99);
  assert.equal(entryOf().movePending, 99);
  R.core.message(Object.assign({}, e, { price: 99, planned: { stopTicks: 20, targetTicks: 24 } }));
  assert.equal(entryOf().movePending, undefined, 'its own order message at that price ends it');
  // no answer at all: drawn as ChartBridge last said after 5 s, and the charts are redrawn then
  R.advance(500);
  R.core.moveOrder('e1', 97.75);
  assert.equal(entryOf().movePending, 97.75);
  const renders = R.renders;
  R.advance(4900);
  assert.equal(entryOf().movePending, 97.75, 'still waiting at 4.9 s');
  R.advance(200);
  assert.equal(entryOf().movePending, undefined, 'given up after 5 s');
  assert.ok(R.renders > renders, 'the charts are redrawn when the wait ends');
  // a move that is not sent (Armed off) never waits; a dropped connection or a new orders list ends every wait
  R.core.setArmed(false);
  R.core.moveOrder('e1', 97);
  assert.equal(entryOf().movePending, undefined, 'not sent: nothing waits');
  R.core.setArmed(true); R.advance(500);
  R.core.moveOrder('e1', 97);
  R.core.message({ type: 'orders', list: [Object.assign({}, e, { price: 98.25 })] });
  assert.equal(entryOf().movePending, undefined, 'a new orders list: nothing waits');
});

test('a framed TradeCore never arms and never sends an order action, even if trading came on', () => {
  const R = rig({ framed: true });
  assert.equal(R.core.framed, true);
  R.core.hello({ trading: { enabled: true, accounts: ['Sim101'], maxQty: { MNQ: 5 } } });
  assert.equal(R.core.TR.enabled, false, 'trading stays off in a frame');
  assert.match(R.core.TR.reason, /inside another page/);
  R.core.setArmed(true);
  assert.equal(R.core.TR.armed, false, 'never arms');
  R.core.sendOrder('buy', 'market', null);
  assert.match(R.notes.pop(), /inside another page/);
  // the frame guard holds on its own: with trading forced on, Armed and an account, still nothing goes
  Object.assign(R.core.TR, { enabled: true, armed: true, account: 'Sim101' });
  R.core.message({ type: 'order', id: 'f1', account: 'Sim101', root: 'MNQ', name: 'MNQ 12-26', side: 'buy', kind: 'limit', qty: 1, price: 98, state: 'working', filled: 0, role: 'entry' });
  R.core.sendOrder('buy', 'market', null); R.advance(500);
  R.core.placeAt('sell', 101); R.advance(500);
  R.core.moveOrder('f1', 97); R.advance(500);
  R.core.cancelOrder('f1'); R.advance(500);
  R.core.flattenHere(); R.advance(500);
  R.core.flattenAll(); R.advance(500);
  assert.equal(R.core.flattenAgent('Sim101', 'MNQ'), false);
  assert.deepEqual(R.sent.filter(m => m.type !== 'auth'), [], 'no order action sent: ' + JSON.stringify(R.sent));
  assert.ok(!R.sent.some(m => m.type === 'auth'), 'no sign-in from a frame');
  assert.ok(R.notes.filter(n => /inside another page/.test(n)).length >= 6, R.notes.join(' / '));
});

test('DECISION 2026-10-14e: the ticket on None (nothing picked, or None picked) sends nothing and says pick an account', () => {
  const R = rig({ wanted: '' });
  R.on();
  assert.equal(R.core.TR.account, '', 'no Sim101 fallback: None');
  R.core.setArmed(true);
  R.core.sendOrder('buy', 'market', null);
  assert.equal(R.sent.length, 0);
  assert.match(R.notes.pop(), /No account \(None\): nothing was sent\. Pick an account to trade\./);
  R.core.pickAccount('Sim101');
  assert.equal(R.core.TR.account, 'Sim101');
  const R2 = rig({ wanted: 'EVAL-9' });
  R2.on();
  assert.equal(R2.core.TR.account, '', 'a last pick ChartBridge does not allow now: None, never Sim101');
});

test('review of #47: the sign-in snapshot is whole only once the orders list and the positions it counts are in; a drop starts over', () => {
  const R = rig({});
  R.on();
  assert.equal(R.core.TR.snapReady, false, 'trading on is not enough');
  R.core.message({ type: 'orders', list: [], positions: 2 });
  assert.equal(R.core.TR.snapReady, false, 'the list, with 2 positions to come');
  R.pos('Sim101', 'MNQ', 1);
  assert.equal(R.core.TR.snapReady, false);
  R.pos('EVAL-1', 'NQ', -1);
  assert.equal(R.core.TR.snapReady, true, 'both positions in');
  R.core.message({ type: 'orders', list: [] });
  assert.equal(R.core.TR.snapReady, false, 'a list with no count (a ChartBridge before 0.5.7): never whole');
  R.core.message({ type: 'orders', list: [], positions: 0 });
  assert.equal(R.core.TR.snapReady, true, 'no position to come: whole at the list');
  R.core.lost('the connection dropped');
  assert.equal(R.core.TR.snapReady, false, 'a drop: not whole until the next sign-in snapshot');
});

test('review of #47: on None the ticket\'s Flatten all sends nothing and says to pick an account, as every ticket action', () => {
  const R = rig({ wanted: '' });
  R.on();
  assert.equal(R.core.TR.account, '');
  R.pos('Sim101', 'MNQ', 1); R.pos('EVAL-1', 'NQ', -2);
  R.core.flattenAll();
  assert.deepEqual(R.flattens(), [], 'nothing sent');
  assert.match(R.notes.pop(), /No account \(None\): nothing was sent\. Pick an account to trade\./);
  R.core.pickAccount('Sim101');
  R.core.flattenAll();
  assert.deepEqual(R.flattens(), ['Sim101 MNQ'], 'with an account picked: that account only');
});
