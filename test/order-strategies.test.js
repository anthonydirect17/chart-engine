'use strict';
// Order Strategies, the shared hotkeys and the entry types (chart 1.16.0, ChartBridge 0.4.0, protocol v3):
// live/order-strategies.js, and TradeCore sending them (live/trade.js). The strategy editor's rules mirror The Desk's
// (DESK_SETTINGS_CONTRACT / TheDesk docs/API.md) and ChartBridge's own check of `order.strategy` (nt8/PROTOCOL.md "Order
// Strategies"; test/fake-v3.mjs checkStrategy is the reference the fake bridge refuses with). Made-up names and sample
// numbers only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const OS = require('../live/order-strategies.js');
const OT = require('../live/order-ticket.js');
const TC = require('../live/trade.js');
const { LivePrefs: LP } = require('../live/live.js');

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'protocol-v3.json'), 'utf8'));
const V3 = import('./fake-v3.mjs');
const clone = v => JSON.parse(JSON.stringify(v));
/* The Desk's example strategy (DESK_SETTINGS_CONTRACT section 1) */
const SCALP = { id: 'scalp-2', name: 'Scalp 2', stop: { ticks: 16, type: 'limit', limitOffsetTicks: 2 },
  targets: [{ ticks: 8, sharePct: 50 }, { ticks: 20, sharePct: 50 }], breakeven: { afterTicks: 8, plusTicks: 1 },
  trail: { startTicks: 12, byTicks: 6, stepTicks: 2 }, hotkey: 'Alt+1' };
const strat = (over) => Object.assign(clone(SCALP), over || {});
const hkDoc = (keys, mods) => { const d = OS.emptyHotkeysDoc(); Object.assign(d.keys, keys || {}); Object.assign(d.modifiers, mods || {}); return d; };

/* ---------------- The Desk's strategy to ChartBridge's flat form (PROTOCOL.md "Shared settings", the table) */
test('toWire: The Desk\'s strategy becomes the flat order.strategy, row by row of the table', () => {
  assert.deepEqual(OS.toWire(SCALP), { name: 'Scalp 2', stop: 16, stopLimit: 2, t1: 8, t1Share: 50, t2: 20, t2Share: 50, beAfter: 8, bePlus: 1, trailAfter: 12, trailBy: 6, trailStep: 2 });
  // a stop market is stopLimit null; no breakeven or trailing leaves their keys out; one target, three targets
  assert.deepEqual(OS.toWire(strat({ stop: { ticks: 12, type: 'market', limitOffsetTicks: 0 }, targets: [{ ticks: 24, sharePct: 100 }], breakeven: null, trail: null, hotkey: null })),
    { name: 'Scalp 2', stop: 12, stopLimit: null, t1: 24, t1Share: 100 });
  const three = OS.toWire(strat({ targets: [{ ticks: 8, sharePct: 34 }, { ticks: 16, sharePct: 33 }, { ticks: 32, sharePct: 33 }], trail: { startTicks: 12, byTicks: 8, stepTicks: 2 }, name: 'Scalp 3T', stop: { ticks: 16, type: 'market', limitOffsetTicks: 0 } }));
  assert.deepEqual(three, FIX.pageToServer['order.strategy'].strategy, 'the fixture\'s order.strategy, from The Desk\'s form');
  // id and hotkey stay on the page; only ChartBridge's keys go
  for (const k of Object.keys(OS.toWire(SCALP))) assert.ok(OS.WIRE_KEYS.includes(k), k);
  assert.ok(!('id' in OS.toWire(SCALP)) && !('hotkey' in OS.toWire(SCALP)));
});

test('toWire: the order message with it passes the fake bridge\'s strict v3 keys (gate 8) and its strategy check', async () => {
  const V = await V3;
  const m = { type: 'order', cid: 'c1', account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'market', qty: 2, strategy: OS.toWire(SCALP) };
  assert.equal(V.checkKeysV3(m, JSON.stringify(m)), null);
  assert.equal(V.checkStrategy(m.strategy, 0), null);
  const sl = { type: 'order', cid: 'c2', account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'stopLimit', qty: 1, price: 25010.25, limitOffset: 0, strategy: OS.toWire(SCALP) };
  assert.equal(V.checkKeysV3(sl, JSON.stringify(sl)), null, 'a stop-limit entry with its limitOffset');
  assert.equal(V.checkKeysV3({ type: 'merge', cid: 'c3', account: 'EVAL-A', root: 'MNQ' }), null, 'merge: exactly cid, account, root');
  assert.equal(V.checkKeysV3({ type: 'client', v: 3 }), null);
});

/* ---------------- ChartBridge's rules for order.strategy, mirrored exactly */
test('checkWire: the same verdict and the same words as ChartBridge\'s check (test/fake-v3.mjs), over many strategies', async () => {
  const V = await V3;
  let seed = 7;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const pick = list => list[rnd(list.length)];
  const nums = [undefined, undefined, -1, 0, 1, 2, 3, 8, 16, 33, 34, 50, 99, 100, 101, 300, 301, 1.5, '8', null, true];
  let ok = 0, bad = 0;
  for (let i = 0; i < 6000; i++) {
    const s = { name: pick(['Scalp', '', ' ', 'x'.repeat(41), 'Swing 3T', 7]) };
    for (const k of ['stop', 'stopLimit', 't1', 't1Share', 't2', 't2Share', 't3', 't3Share', 'beAfter', 'bePlus', 'trailAfter', 'trailBy', 'trailStep']) {
      const v = pick(nums);
      if (v !== undefined) s[k] = v;
    }
    if (rnd(4) === 0) { s.t1 = 8; s.t1Share = 50; s.t2 = 16; s.t2Share = 50; delete s.t3; delete s.t3Share; }
    for (const maxB of [0, 300]) {
      const want = V.checkStrategy(s, maxB), got = OS.checkWire(s, maxB);
      assert.equal(got, want, JSON.stringify(s) + ' max ' + maxB);
      if (want === null) ok++; else bad++;
    }
  }
  assert.ok(ok > 50 && bad > 1000, 'both kinds seen: ' + ok + ' ok, ' + bad + ' refused');
});

test('checkWire: the rules one by one (shares 100, t2 needs t1, bePlus below beAfter, all three trail keys, maxBracketTicks)', () => {
  const w = o => Object.assign({ name: 'Scalp', stop: 16 }, o);
  assert.equal(OS.checkWire(w({}), 0), null, 'a stop alone is a strategy');
  assert.equal(OS.checkWire(w({ stop: 0 }), 0), 'stop must be a whole number of 1 or more.');
  assert.equal(OS.checkWire(w({ t1: 8, t1Share: 60, t2: 16, t2Share: 30 }), 0), 'The target shares add up to 90; they must add up to 100.');
  assert.equal(OS.checkWire(w({ t2: 16, t2Share: 100 }), 0), 't2 needs t1.');
  assert.equal(OS.checkWire(w({ t1: 8, t1Share: 50, t3: 16, t3Share: 50 }), 0), 't3 needs t2.');
  assert.equal(OS.checkWire(w({ t1: 8, t1Share: 0 }), 0), 't1Share must be a whole percent from 1 to 100.');
  assert.equal(OS.checkWire(w({ beAfter: 8 }), 0), 'beAfter and bePlus go together.');
  assert.equal(OS.checkWire(w({ beAfter: 8, bePlus: 8 }), 0), 'bePlus must be below beAfter.');
  assert.equal(OS.checkWire(w({ beAfter: 8, bePlus: 7 }), 0), null);
  assert.equal(OS.checkWire(w({ trailAfter: 12, trailBy: 6 }), 0), 'trailAfter, trailBy and trailStep go together.');
  assert.equal(OS.checkWire(w({ stop: 400 }), 300), 'stop must be at most 300 (maxBracketTicks in config.txt).');
  assert.equal(OS.checkWire(w({ stopLimit: 2.5 }), 0), 'stopLimit must be a whole number of 0 or more.');
  assert.equal(OS.checkWire(w({ hotkey: 'Alt+1' }), 0), 'Unknown key "hotkey" in strategy.');
  assert.equal(OS.checkWire(w({ t1: { ticks: 8 } }), 0), 'A strategy must be one flat object.');
  assert.match(OS.checkWire(w({ name: 'Say "hi"' }), 0), /backslash escape/, 'a name ChartBridge\'s gate 8 would refuse');
  // the fixture's refusal example, word for word
  const r = FIX.refusals.find(x => x.send.strategy);
  assert.equal(OS.checkWire(r.send.strategy, 0), r.reason);
});

/* ---------------- The Desk's rules: the strategy editor's validation */
test('checkStrategy: The Desk\'s example passes; each rule names its box', () => {
  assert.equal(OS.checkStrategy(SCALP, { page: true }), null);
  const why = (s, ctx) => { const r = OS.checkStrategy(s, ctx); return r ? r.field + ': ' + r.text : null; };
  assert.match(why(strat({ name: '  ' })), /^name: Type a name/);
  assert.match(why(strat({ name: 'x'.repeat(41) })), /^name: /);
  assert.match(why(strat({ name: 'Back\\slash' })), /^name: .*ChartBridge refuses/);
  assert.match(why(strat({ stop: { ticks: 0, type: 'market', limitOffsetTicks: 0 } })), /^stop: .*never goes in without a stop/);
  assert.match(why(strat({ stop: { ticks: 1001, type: 'market', limitOffsetTicks: 0 } })), /^stop: .*1 to 1000/);
  assert.match(why(strat({ stop: { ticks: 16, type: 'trail', limitOffsetTicks: 0 } })), /^stopType: /);
  assert.match(why(strat({ stop: { ticks: 16, type: 'market', limitOffsetTicks: 2 } })), /^limitOffset: A stop market has no limit offset/);
  assert.match(why(strat({ stop: { ticks: 16, type: 'limit', limitOffsetTicks: 101 } })), /^limitOffset: .*0 to 100/);
  assert.match(why(strat({ targets: [] })), /^t1: Set 1 to 3 targets/);
  assert.match(why(strat({ targets: [1, 2, 3, 4].map(n => ({ ticks: n * 8, sharePct: 25 })) })), /^t1: Set 1 to 3 targets/);
  assert.match(why(strat({ targets: [{ ticks: 8, sharePct: 60 }, { ticks: 20, sharePct: 30 }] })), /^s2: The target shares add up to 90%; they must add up to 100%\./);
  assert.match(why(strat({ targets: [{ ticks: 20, sharePct: 50 }, { ticks: 8, sharePct: 50 }] })), /^t2: Target 2 must be farther than target 1/);
  assert.match(why(strat({ targets: [{ ticks: 8, sharePct: 50 }, { ticks: 8, sharePct: 50 }] })), /^t2: /, 'strictly increasing');
  assert.match(why(strat({ targets: [{ ticks: 8, sharePct: 0 }, { ticks: 20, sharePct: 100 }] })), /^s1: /);
  assert.match(why(strat({ targets: [{ ticks: 2001, sharePct: 100 }] })), /^t1: .*1 to 2000/);
  assert.match(why(strat({ breakeven: { afterTicks: 8, plusTicks: 8 } })), /^bePlus: Breakeven plus must be below breakeven after/);
  assert.match(why(strat({ breakeven: { afterTicks: 0, plusTicks: 0 } })), /^beAfter: /);
  assert.match(why(strat({ breakeven: { afterTicks: 8, plusTicks: 101 } })), /^bePlus: .*0 to 100/);
  assert.match(why(strat({ trail: { startTicks: 12, byTicks: 0, stepTicks: 2 } })), /^trailBy: /);
  assert.match(why(strat({ trail: { startTicks: 12, byTicks: 6 } })), /^trailAfter: Trailing needs/);
  assert.match(why(strat({ trail: { startTicks: 12, byTicks: 6, stepTicks: 2.5 } })), /^trailStep: /);
  assert.match(why(strat({ stop: { ticks: 16.5, type: 'market', limitOffsetTicks: 0 } })), /^stop: /, 'a fraction');
  assert.match(why(strat({ stop: { ticks: true, type: 'market', limitOffsetTicks: 0 } })), /^stop: /, 'a boolean');
  assert.match(why(Object.assign(strat(), { extra: 1 })), /^: A strategy needs exactly/);
  assert.match(why(strat({ id: 'bad id' })), /^: The id/);
  // a whole strategy is valid once and only once each rule passes
  assert.equal(why(strat({ breakeven: null, trail: null, hotkey: null })), null);
});

test('checkStrategy: unique names (any case) and keys; a key never one of the hotkeys or an entry-type modifier', () => {
  const other = strat({ id: 'swing', name: 'Swing', hotkey: 'Alt+2' });
  const why = (s, ctx) => { const r = OS.checkStrategy(s, ctx); return r ? r.field + ': ' + r.text : null; };
  assert.match(why(strat({ name: 'SWING' }), { others: [other] }), /^name: Another strategy is already called SWING/);
  assert.equal(why(strat({ id: 'swing', name: 'SWING', hotkey: 'Alt+2' }), { others: [other] }), null, 'itself is not another');
  assert.match(why(strat({ hotkey: 'Alt+2' }), { others: [other] }), /^hotkey: Alt\+2 is already the hotkey of strategy Swing\. Clear it there first\./);
  assert.match(why(strat({ hotkey: 'Alt+B' }), { hotkeys: hkDoc({ buy: 'Alt+B' }) }), /^hotkey: Alt\+B is already Buy MKT\. Clear it there first\./);
  assert.match(why(strat({ hotkey: 'Alt+M' }), { hotkeys: hkDoc({ maximize: 'Alt+M' }) }), /already Maximize panel/);
  assert.match(why(strat({ hotkey: 'Alt+G' }), { hotkeys: hkDoc({ merge: 'Alt+G' }) }), /already Merge/);
  assert.match(why(strat({ hotkey: 'Alt+Y' }), { hotkeys: hkDoc({ accept: 'Alt+Y' }) }), /already Accept \(copilot\)/);
  assert.match(why(strat({ hotkey: 'Shift+1' }), { hotkeys: hkDoc({}, { limit: 'Shift' }) }), /uses Shift, the Limit entry modifier/);
  // the page's own list of keys the browser keeps: refused in the editor, while The Desk checks the shape only
  assert.match(why(strat({ hotkey: 'Ctrl+W' }), { page: true }), /^hotkey: Ctrl\+W is kept by the browser/);
  assert.equal(why(strat({ hotkey: 'Ctrl+W' })), null, 'reading The Desk: kept (its shape is fine)');
  assert.match(why(strat({ hotkey: 'Meta+1' })), /^hotkey: /);
});

test('checkStrategiesDoc and cleanStrategiesDoc: at most 24, ids unique, a bad strategy named by its place; reading never throws', () => {
  assert.equal(OS.checkStrategiesDoc({ rev: 3, strategies: [SCALP] }), '');
  assert.equal(OS.checkStrategiesDoc({ rev: 3, strategies: [SCALP, strat({ name: 'Other' })] }), 'strategies[1] id scalp-2 is used twice.');
  assert.equal(OS.checkStrategiesDoc({ rev: 0, strategies: [strat({ targets: [{ ticks: 8, sharePct: 90 }] })] }), 'strategies[0] The target shares add up to 90%; they must add up to 100%.');
  assert.match(OS.checkStrategiesDoc({ rev: 0, strategies: Array.from({ length: 25 }, (_, i) => strat({ id: 's' + i, name: 'S' + i, hotkey: null })) }), /At most 24/);
  assert.match(OS.checkStrategiesDoc({ rev: -1, strategies: [] }), /^rev /);
  assert.match(OS.checkStrategiesDoc({ rev: true, strategies: [] }), /^rev /);
  assert.match(OS.checkStrategiesDoc({ rev: 1, strategies: [], x: 1 }), /exactly rev and strategies/);
  for (const v of [null, 5, 'x', [], { rev: 'a' }, { strategies: 'x' }, { rev: 1, strategies: [null, 1, SCALP, SCALP, strat({ id: 'b', targets: [] })] }])
    assert.doesNotThrow(() => OS.cleanStrategiesDoc(v));
  const c = OS.cleanStrategiesDoc({ rev: 4, strategies: [null, SCALP, SCALP, strat({ id: 'b', name: 'B', targets: [] }), strat({ id: 'c', name: 'C', hotkey: 'Alt+3' })] });
  assert.deepEqual(c.strategies.map(s => s.id), ['scalp-2', 'c'], 'the good ones, once each, in order');
  assert.equal(c.rev, 4);
  assert.deepEqual(OS.cleanStrategiesDoc(null), { rev: 0, strategies: [] });
});

/* ---------------- the hotkeys document and the one conflict check */
test('the hotkeys document: nine keys (The Desk\'s seven, Accept and Reject), two modifiers; read leniently, checked strictly', () => {
  assert.deepEqual(OS.KEY_IDS, ['buy', 'sell', 'be', 'close', 'flattenAll', 'merge', 'maximize', 'accept', 'reject']);
  assert.deepEqual(OS.emptyHotkeysDoc(), { rev: 0, keys: { buy: '', sell: '', be: '', close: '', flattenAll: '', merge: '', maximize: '', accept: '', reject: '' }, modifiers: { limit: '', stop: '' } });
  const c = OS.cleanHotkeysDoc({ rev: 2, keys: { buy: 'Alt+B', sell: 'Alt+B', be: 'Meta+E', merge: 'Ctrl+Alt+G', maximize: 7 }, modifiers: { limit: 'Shift', stop: 'Shift' } });
  assert.equal(c.rev, 2);
  assert.equal(c.keys.buy, 'Alt+B'); assert.equal(c.keys.sell, '', 'a key used twice is kept once');
  assert.equal(c.keys.be, '', 'Meta is refused'); assert.equal(c.keys.merge, 'Ctrl+Alt+G'); assert.equal(c.keys.maximize, '');
  assert.deepEqual(c.modifiers, { limit: 'Shift', stop: '' }, 'the two modifiers differ');
  for (const v of [null, 1, 'x', [], { keys: [] }, { modifiers: 5 }]) assert.doesNotThrow(() => OS.cleanHotkeysDoc(v));
  // the strict check (what The Desk refuses)
  assert.equal(OS.checkHotkeysDoc(hkDoc({ buy: 'Alt+B', merge: 'Alt+G' }, { limit: 'Shift' })), '');
  assert.match(OS.checkHotkeysDoc(hkDoc({ buy: 'Alt+B', sell: 'Alt+B' })), /Alt\+B is already Buy MKT/);
  assert.match(OS.checkHotkeysDoc(hkDoc({ buy: 'Shift+B' }, { limit: 'Shift' })), /uses Shift, an entry modifier/);
  assert.match(OS.checkHotkeysDoc(hkDoc({}, { limit: 'Alt', stop: 'Alt' })), /must differ/);
  assert.match(OS.checkHotkeysDoc(hkDoc({ merge: 'Alt+1' }), [SCALP]), /Alt\+1 is already the hotkey of strategy Scalp 2/);
  const seven = hkDoc(); delete seven.keys.accept; delete seven.keys.reject;
  assert.match(OS.checkHotkeysDoc(seven), /keys needs exactly/);
  assert.match(OS.checkHotkeysDoc(Object.assign(hkDoc(), { x: 1 })), /exactly rev, keys and modifiers/);
});

test('hotkeyConflict: one check for every key (the five, Merge, Maximize, Accept, Reject, strategies, modifiers)', () => {
  const ctx = { keys: hkDoc({ buy: 'Alt+B', merge: 'Alt+G', maximize: 'Alt+M', accept: 'Alt+Y', reject: 'Alt+N' }).keys, modifiers: { limit: 'Shift', stop: '' }, strategies: [SCALP] };
  assert.equal(OS.hotkeyConflict('Alt+K', { key: 'merge' }, ctx), '');
  assert.equal(OS.hotkeyConflict('Alt+G', { key: 'merge' }, ctx), '', 'its own key');
  assert.match(OS.hotkeyConflict('Alt+B', { key: 'merge' }, ctx), /Alt\+B is already Buy MKT/);
  assert.match(OS.hotkeyConflict('Alt+M', { key: 'merge' }, ctx), /already Maximize panel/, 'the Maximize key of the display round is in the check');
  assert.match(OS.hotkeyConflict('Alt+G', { key: 'maximize' }, ctx), /already Merge/);
  assert.match(OS.hotkeyConflict('Alt+Y', { key: 'buy' }, ctx), /already Accept \(copilot\)/);
  assert.match(OS.hotkeyConflict('Alt+N', { strategy: 'x' }, ctx), /already Reject \(copilot\)/);
  assert.match(OS.hotkeyConflict('Alt+1', { key: 'merge' }, ctx), /already the hotkey of strategy Scalp 2/);
  assert.equal(OS.hotkeyConflict('Alt+1', { strategy: 'scalp-2' }, ctx), '', 'the strategy\'s own key');
  assert.match(OS.hotkeyConflict('Shift+F2', { key: 'merge' }, ctx), /uses Shift, the Limit entry modifier/);
  assert.match(OS.hotkeyConflict('Ctrl+W', { key: 'merge' }, ctx), /kept by the browser/, 'the page\'s refused keys first');
  assert.match(OS.hotkeyConflict('F5', { key: 'accept' }, ctx), /kept by the browser/);
  assert.match(OS.hotkeyConflict('A', { key: 'merge' }, ctx), /the chart's/);
  // from a key press, as the Settings boxes read it
  const ev = (code, mods) => Object.assign({ code, key: code.replace(/^Key/, '').toLowerCase(), ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, mods);
  assert.deepEqual(OS.keyFromEvent(ev('KeyK', { altKey: true }), { key: 'merge' }, ctx), { combo: 'Alt+K', error: '', held: false });
  assert.match(OS.keyFromEvent(ev('KeyM', { altKey: true }), { key: 'merge' }, ctx).error, /already Maximize panel/);
  assert.equal(OS.keyFromEvent({ code: 'AltLeft', key: 'Alt', altKey: true }, { key: 'merge' }, ctx).held, true, 'a modifier alone is held');
});

test('modifierConflict: an entry-type modifier never one a key or a strategy\'s key holds, and the two differ', () => {
  const ctx = { keys: hkDoc({ buy: 'Alt+B' }).keys, modifiers: { limit: '', stop: 'Ctrl' }, strategies: [strat({ hotkey: 'Shift+1' })] };
  assert.equal(OS.modifierConflict('limit', '', ctx), '');
  assert.match(OS.modifierConflict('limit', 'Alt', ctx), /Alt is in Buy MKT's key \(Alt\+B\)/);
  assert.match(OS.modifierConflict('limit', 'Shift', ctx), /strategy Scalp 2's key \(Shift\+1\)/);
  assert.match(OS.modifierConflict('limit', 'Ctrl', ctx), /already the Stop entry modifier/);
  assert.equal(OS.modifierConflict('stop', 'Ctrl', ctx), '');
  assert.match(OS.modifierConflict('limit', 'Meta', ctx), /Pick Shift, Ctrl or Alt/);
});

test('resolveKey: Merge, Accept, Reject, a strategy\'s key and Buy/Sell with a modifier, each only while its switch is on', () => {
  const base = { keys: hkDoc({ buy: 'F2', sell: 'Alt+S', merge: 'Alt+G', accept: 'Alt+Y', reject: 'Alt+N' }).keys, modifiers: { limit: 'Shift', stop: 'Ctrl' }, strategies: [SCALP] };
  const on = { merge: true, accept: true, strategies: true, types: true };
  const r = (combo, o) => OS.resolveKey(combo, Object.assign({}, base, { on: Object.assign({}, on, o) }));
  assert.equal(r('Alt+G'), 'merge'); assert.equal(r('Alt+G', { merge: false }), '');
  assert.equal(r('Alt+Y'), 'accept'); assert.equal(r('Alt+N'), 'reject'); assert.equal(r('Alt+Y', { accept: false }), '');
  assert.equal(r('Alt+1'), 'strategy:scalp-2'); assert.equal(r('Alt+1', { strategies: false }), '');
  assert.equal(r('Shift+F2'), 'buy:limit'); assert.equal(r('Ctrl+F2'), 'buy:stop');
  assert.equal(r('Alt+Shift+S'), 'sell:limit'); assert.equal(r('Ctrl+Alt+S'), 'sell:stop');
  assert.equal(r('Shift+F2', { types: false }), '', 'no entry types with orderTypes off');
  assert.equal(r('F2'), '', 'Buy itself is the trading handler\'s');
  assert.equal(r('Ctrl+Shift+F2'), '', 'both modifiers: neither');
  assert.equal(OS.resolveKey('Alt+G', null), '');
});

test('clickFamily: only a modifier beyond the click\'s own Shift or Ctrl picks the entry type (in practice Alt)', () => {
  const m = { limit: 'Alt', stop: '' };
  assert.equal(OS.clickFamily({ shift: true, alt: true }, m, ['Shift']), 'limit');
  assert.equal(OS.clickFamily({ shift: true }, m, ['Shift']), '');
  assert.equal(OS.clickFamily({ ctrl: true, alt: true }, m, ['Ctrl']), 'limit');
  assert.equal(OS.clickFamily({ shift: true }, { limit: 'Shift', stop: '' }, ['Shift']), '', 'Shift is the click itself');
  assert.equal(OS.clickFamily({ shift: true, alt: true }, { limit: '', stop: 'Alt' }, ['Shift']), 'stop');
  assert.equal(OS.clickFamily({ shift: true, alt: true }, { limit: '', stop: '' }, ['Shift']), '');
});

test('entryKind and kindFor: limit and stop-limit, stop-market and MIT, by the side of the market; plain as before', () => {
  const k = (side, price, fam) => { const r = OS.entryKind(side, price, 100, fam); return r.kind || 'error: ' + r.error; };
  // no modifier: Shift+click's 1.10.0 rule, unchanged
  assert.equal(k('buy', 99), OT.placeKind('buy', 99, 100)); assert.equal(k('buy', 101), 'stop'); assert.equal(k('sell', 101), 'limit');
  assert.equal(k('buy', 99, 'limit'), 'limit'); assert.equal(k('buy', 101, 'limit'), 'stopLimit');
  assert.equal(k('sell', 101, 'limit'), 'limit'); assert.equal(k('sell', 99, 'limit'), 'stopLimit');
  assert.equal(k('buy', 101, 'stop'), 'stop'); assert.equal(k('buy', 99, 'stop'), 'mit');
  assert.equal(k('sell', 99, 'stop'), 'stop'); assert.equal(k('sell', 101, 'stop'), 'mit');
  assert.match(k('buy', 100, 'stop'), /^error: .*MIT would trigger at once\. Use Buy MKT/);
  assert.equal(k('buy', 100, 'limit'), 'limit', 'a buy limit at the last price (ChartBridge takes it)');
  assert.match(OS.entryKind('buy', 99, null, 'limit').error, /No price yet/);
  assert.equal(OS.kindFor('limit', 'stop'), 'mit'); assert.equal(OS.kindFor('stop', 'limit'), 'stopLimit'); assert.equal(OS.kindFor('stop', ''), 'stop'); assert.equal(OS.kindFor(null, 'limit'), null);
  assert.equal(OS.baseKind('mit'), 'limit'); assert.equal(OS.baseKind('stopLimit'), 'stop');
  // the fake bridge's sides of the market agree (PROTOCOL.md "Order types")
  assert.equal(OS.KIND_TEXT.stopLimit, 'STL'); assert.equal(OS.KIND_TEXT.mit, 'MIT');
});

test('managedLine and mergeLine: the state in plain words (resumed, NOT MANAGED with its text; merged, restored, failed)', () => {
  const m = FIX.serverToPage.managed;
  assert.deepEqual(OS.managedLine(m), { text: 'Scalp 3T resumed after a restart: 3 pairs, 3 at breakeven (ChartBridge restarted; breakeven and trailing resumed)', level: 'warn' });
  const u = OS.managedLine(Object.assign({}, m, { state: 'unmanaged', text: 'MNQ EVAL-A: breakeven and trailing could not be resumed after the restart; the stop stays at 24,980.25. Manage it by hand' }));
  assert.equal(u.level, 'error');
  assert.equal(u.text, 'Scalp 3T NOT MANAGED: MNQ EVAL-A: breakeven and trailing could not be resumed after the restart; the stop stays at 24,980.25. Manage the stop by hand.');
  assert.equal(OS.managedLine(Object.assign({}, m, { state: 'unmanaged', text: null })).text, 'Scalp 3T NOT MANAGED: breakeven and trailing are off. Manage the stop by hand.');
  assert.equal(OS.managedLine(Object.assign({}, m, { state: 'waiting', pairs: [] })).text, 'Scalp 3T: waiting for the fill');
  assert.equal(OS.managedLine(Object.assign({}, m, { state: 'active', text: null })).text, 'Scalp 3T managing: 3 pairs, 3 at breakeven');
  assert.equal(OS.managedLine(Object.assign({}, m, { state: 'done' })).text, '');
  assert.deepEqual(OS.mergeLine(FIX.serverToPage.merge), { text: 'Merged · EVAL-A MNQ: Merged 5 pairs into one stop for 3 contracts at 24,987.25 and 3 targets', level: '' });
  const r = OS.mergeLine(FIX.serverToPage['merge.restored']);
  assert.equal(r.level, 'warn'); assert.match(r.text, /^Merge undone, brackets restored · EVAL-A MNQ: The merge stopped/);
  assert.equal(OS.mergeLine(Object.assign({}, FIX.serverToPage.merge, { result: 'failed', text: 'ONE STOP at 24,980.25' })).level, 'error');
  assert.match(OS.mergeLine(Object.assign({}, FIX.serverToPage.merge, { result: 'failed' })).text, /^MERGE FAILED/);
});

test('cleanSwitches and deskSyncOn: only true is on; The Desk is used only while a switch needs the shared keys', () => {
  assert.deepEqual(OS.cleanSwitches(FIX.serverToPage['trading.v3'].switches), FIX.serverToPage['trading.v3'].switches);
  assert.deepEqual(Object.values(OS.cleanSwitches({ strategies: 'true', merge: 1 })), [false, false, false, false, false, false, false]);
  assert.equal(OS.deskSyncOn(OS.cleanSwitches(null)), false, 'every switch off: hotkeys stay this browser\'s (1.15)');
  assert.equal(OS.deskSyncOn(OS.cleanSwitches({ copier: true, accountChecks: true, cancelFromList: true })), false);
  for (const k of ['strategies', 'orderTypes', 'merge', 'bot']) assert.equal(OS.deskSyncOn(OS.cleanSwitches({ [k]: true })), true, k);
});

/* ---------------- The Desk: read, save, 409, unreachable; the last copy kept */
function fakeDesk() {
  const docs = { hotkeys: hkDoc({ buy: 'Alt+B' }), strategies: { rev: 3, strategies: [SCALP] } }, calls = [];
  let down = false;
  docs.hotkeys.rev = 2;
  const fetch = async (url, o) => {
    calls.push([o.method, url, o.body ? JSON.parse(o.body) : undefined]);
    if (down) throw new TypeError('Failed to fetch');
    const which = /chart-(hotkeys|strategies)$/.exec(url)[1];
    const res = (status, body) => ({ status, json: async () => body });
    if (o.method === 'GET') return res(200, clone(docs[which]));
    const d = JSON.parse(o.body);
    if (d.bad) return res(400, { detail: 'strategies[0] targets must add up to 100' });
    if (d.rev !== docs[which].rev) return res(409, { detail: 'stale rev ' + d.rev + ': the ' + which + ' are at rev ' + docs[which].rev + '. Read them again.' });
    docs[which] = Object.assign(d, { rev: d.rev + 1 });
    return res(200, clone(docs[which]));
  };
  const mem = new Map(), storage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  return { docs, calls, fetch, storage, mem, setDown: v => { down = v; } };
}
test('createDesk: the address from its one source, a read kept as the last copy, a save with its rev, a 409 read again, 400 and unreachable', async () => {
  // no source (or a bad one): ChartBridge's default address
  const f0 = fakeDesk(), d0 = OS.createDesk({ fetch: f0.fetch, storage: f0.storage, base: () => Promise.resolve('nope') });
  assert.equal(d0.url(), 'http://localhost:8800', 'The Desk\'s default address');
  await d0.read('hotkeys'); assert.equal(f0.calls[0][1], 'http://localhost:8800/api/chart-hotkeys');
  // the page's one source (ChartBridge's deskUrl, read from /diag): nothing kept in this browser for it
  const f = fakeDesk(), desk = OS.createDesk({ fetch: f.fetch, storage: f.storage, base: () => Promise.resolve('http://127.0.0.1:8800/') });
  assert.equal(OS.deskUrl('http://localhost:8800/api'), '', 'no path');
  assert.equal('url' in OS.DESK_KEYS, false, 'no address of its own in this browser');
  assert.equal(desk.cached('hotkeys'), null);
  let r = await desk.read('hotkeys');
  assert.equal(r.ok, true); assert.equal(desk.reach, 'ok'); assert.equal(f.calls[0][1], 'http://127.0.0.1:8800/api/chart-hotkeys');
  assert.equal(desk.url(), 'http://127.0.0.1:8800');
  assert.equal(desk.cached('hotkeys').doc.keys.buy, 'Alt+B');
  // a save sends the whole document with the rev read; the stored one (rev + 1) is kept
  const next = clone(desk.cached('hotkeys').doc); next.keys.merge = 'Alt+G';
  r = await desk.save('hotkeys', next);
  assert.equal(r.ok, true); assert.equal(r.doc.rev, 3); assert.equal(f.calls[1][0], 'PUT'); assert.equal(f.calls[1][2].rev, 2);
  assert.equal(desk.cached('hotkeys').doc.keys.merge, 'Alt+G');
  // another PC saved first: 409, read again, nothing guessed
  f.docs.hotkeys.rev = 7; f.docs.hotkeys.keys.sell = 'Alt+S';
  const stale = clone(desk.cached('hotkeys').doc); stale.keys.be = 'Alt+K';
  r = await desk.save('hotkeys', stale);
  assert.equal(r.ok, false); assert.equal(r.conflict, true); assert.match(r.error, /another PC saved the hotkeys first \(stale rev 3: the hotkeys are at rev 7/);
  assert.equal(desk.cached('hotkeys').doc.rev, 7, 'The Desk\'s copy is loaded'); assert.equal(desk.cached('hotkeys').doc.keys.be, '', 'the edit was not saved');
  // a refusal names The Desk's reason
  r = await desk.save('strategies', { rev: 3, strategies: [], bad: 1 });
  assert.equal(r.status, 400); assert.equal(r.error, 'Not saved: strategies[0] targets must add up to 100');
  // The Desk not reachable: down, the last copy stays
  await desk.read('strategies');
  f.setDown(true);
  r = await desk.read('strategies');
  assert.equal(r.ok, false); assert.equal(desk.reach, 'down'); assert.match(desk.error, /The Desk \(http:\/\/127\.0\.0\.1:8800\) is not reachable\./);
  assert.equal(desk.cached('strategies').doc.strategies[0].id, 'scalp-2', 'the last copy read is still there');
  r = await desk.save('strategies', { rev: 3, strategies: [] });
  assert.equal(r.ok, false); assert.match(r.error, /^Not saved: The Desk .* is not reachable\./);
  // a cache that is not JSON never throws
  f.mem.set(OS.DESK_KEYS.cache, '{oops');
  assert.equal(desk.cached('hotkeys'), null);
});

/* ---------------- TradeCore: what the page sends (strict shapes) with the switches off and on */
function harness(o = {}) {
  const mem = new Map(), prefs = LP.create({ getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) });
  const sent = [], flashes = [], H = { strategy: null, last: 100, qty: 1 };
  const core = TC.create({
    LP, prefs, fetch: () => new Promise(() => {}), send: m => sent.push(m), open: () => true, sock: () => H,
    root: () => 'MNQ', lastPrice: () => H.last, qty: () => H.qty, pickerAccount: () => core.TR.account, wantedAccount: () => 'Sim101', tick: () => 0.25, served: () => true, fmt: p => String(p),
    flash: (t, l) => flashes.push([t, l]), later: () => {}, changed: () => {}, armed: () => {}, applied: () => {}, lost: () => {}, syncAccounts: () => {}, batch: () => {}, unsent: () => {},
    destroyed: () => false, now: (() => { let t = 0; return () => (t += 1000); })(), confirmNoStop: () => true,
    strategy: () => H.strategy,
  });
  return { core, sent, flashes, H, prefs };
}
const trading = () => ({ type: 'trading', enabled: true, accounts: ['Sim101'], maxQty: { '*': 5 } });
/* the switches come from the window's v3 connection (setSwitches); the ticket's own `trading` never carries them */
const withSwitches = (h, sw, extra) => { h.core.setSwitches(sw); h.core.message(Object.assign(trading(), extra || {})); };
const ALL_ON = { accountChecks: true, orderTypes: true, strategies: true, merge: true, cancelFromList: true, copier: true, bot: true };

test('TradeCore: the ticket\'s connection stays a v2 page (never `client`); the switches come from the v3 connection', () => {
  let h = harness();
  h.core.hello({ type: 'hello', version: '0.4.0', features: ['v3'], trading: { enabled: false, reason: 'sign in', accounts: [], maxQty: {} } });
  assert.deepEqual(h.sent, [], 'nothing new on the ticket\'s connection, whatever ChartBridge speaks');
  h = harness();
  h.core.hello({ type: 'hello', version: '0.3.8', features: ['liveFirst'], trading: { enabled: false, accounts: [], maxQty: {} } });
  assert.deepEqual(h.sent, [], 'a 0.3.8 ChartBridge gets nothing new');
  // a `trading` carrying switches on this connection is not believed: only setSwitches (the v3 connection) turns one on
  h = harness();
  h.core.message(Object.assign(trading(), { switches: ALL_ON }));
  assert.deepEqual(h.core.TR.switches, OS.cleanSwitches(null));
  h.core.setSwitches(ALL_ON);
  assert.equal(h.core.switchOn('merge'), true);
  h.core.message(Object.assign(trading(), { enabled: false, reason: 'off' }));
  assert.equal(h.core.switchOn('merge'), false, 'off while this connection\'s trading is off');
  h.core.message(trading());
  assert.equal(h.core.switchOn('merge'), true, 'on again with trading');
  h.core.v3Lost();
  assert.deepEqual(h.core.TR.switches, OS.cleanSwitches(null), 'the v3 connection dropped: every switch off');
});

test('TradeCore: with every switch off nothing new is sent (the bracket as in 1.15, no strategy, no stop-limit, no merge)', async () => {
  const V = await V3;
  const h = harness();
  withSwitches(h, { accountChecks: false, orderTypes: false, strategies: false, merge: false, cancelFromList: false, copier: false, bot: false });
  h.core.TR.armed = true;
  h.H.strategy = { name: 'Scalp 2', wire: OS.toWire(SCALP) };
  h.core.brackets.MNQ = { stop: 8, target: 16 };
  h.core.sendOrder('buy', 'market', null);
  const m = h.sent.pop();
  assert.deepEqual(Object.keys(m).sort(), ['account', 'bracket', 'cid', 'kind', 'qty', 'root', 'side', 'type'], 'the strategy is not sent while strategies is off');
  assert.equal(V.checkKeysV3(m), null);
  h.core.sendOrder('buy', 'stopLimit', 101);
  assert.equal(h.sent.length, 0); assert.match(h.flashes.pop()[0], /stop-limit and MIT orders are off in ChartBridge/);
  h.core.merge();
  assert.equal(h.sent.length, 0); assert.match(h.flashes.pop()[0], /Merge is off in ChartBridge/);
  // no switches from the v3 connection (an older ChartBridge): all off
  const h2 = harness(); h2.core.message(trading()); assert.deepEqual(h2.core.TR.switches, OS.cleanSwitches(null), 'none read: all off');
});

test('TradeCore: the active strategy goes in place of the bracket (strict keys), never on an order that reduces', async () => {
  const V = await V3;
  const h = harness();
  withSwitches(h, ALL_ON);
  h.core.TR.armed = true;
  h.core.brackets.MNQ = { stop: 8, target: 16 };
  h.H.strategy = { name: 'Scalp 2', wire: OS.toWire(SCALP) };
  h.core.sendOrder('buy', 'market', null);
  let m = h.sent.pop();
  assert.deepEqual(m.strategy, OS.toWire(SCALP)); assert.equal(m.bracket, undefined, 'a strategy or a bracket, never both');
  assert.equal(V.checkKeysV3(m, JSON.stringify(m)), null);
  assert.match(h.flashes.pop()[0], /^Sent BUY MKT 1 MNQ with strategy Scalp 2 · Sim101$/);
  // a stop-limit entry (orderTypes): its limit at its stop, the strategy with it
  h.core.sendOrder('buy', 'stopLimit', 101);
  m = h.sent.pop();
  assert.equal(m.kind, 'stopLimit'); assert.equal(m.limitOffset, 0); assert.equal(m.price, 101); assert.ok(m.strategy);
  assert.equal(V.checkKeysV3(m, JSON.stringify(m)), null);
  // an MIT
  h.core.sendOrder('buy', 'mit', 99);
  m = h.sent.pop(); assert.equal(m.kind, 'mit'); assert.equal(m.limitOffset, undefined);
  // reducing a long: no strategy (ChartBridge refuses it there), said so
  h.core.message({ type: 'position', account: 'Sim101', root: 'MNQ', qty: 2, avgPrice: 100 });
  h.core.sendOrder('sell', 'market', null);
  m = h.sent.pop();
  assert.equal(m.strategy, undefined); assert.equal(m.bracket, undefined);
  assert.match(h.flashes.pop()[0], /\(no strategy: it reduces the position\)/);
  // a strategy ChartBridge would refuse (over maxBracketTicks) is not sent
  withSwitches(h, ALL_ON, { maxBracketTicks: 10 });
  h.core.TR.armed = true;
  h.core.message({ type: 'position', account: 'Sim101', root: 'MNQ', qty: 0, avgPrice: null });
  h.core.sendOrder('buy', 'market', null);
  assert.equal(h.sent.length, 0);
  assert.match(h.flashes.pop()[0], /^Not sent: strategy Scalp 2: stop must be at most 10/);
  // no strategy picked: the bracket as before
  withSwitches(h, ALL_ON); h.core.TR.armed = true; h.H.strategy = null;
  h.core.sendOrder('buy', 'market', null);
  assert.deepEqual(h.sent.pop().bracket, { stop: 8, target: 16 });
});

test('TradeCore: a strategy has its stop, so NO STOP is never asked for it; the bracket stop 0 still asks', () => {
  const h = harness();
  withSwitches(h, ALL_ON); h.core.TR.armed = true; h.core.brackets.MNQ = { stop: 0, target: 0 };
  h.H.strategy = { name: 'Scalp 2', wire: OS.toWire(SCALP) };
  h.core.sendOrder('buy', 'market', null);
  assert.equal(h.sent.length, 1, 'sent at once with its strategy');
  h.H.strategy = null;
  h.core.sendOrder('buy', 'market', null);
  assert.equal(h.sent.length, 1, 'stop 0 and no strategy: asked first (nothing sent yet)');
});

test('TradeCore: placeChecked takes a stop-limit or an MIT by the side of the market it rests on', () => {
  const h = harness();
  withSwitches(h, ALL_ON); h.core.TR.armed = true; h.core.brackets.MNQ = { stop: 8, target: 16 };
  h.core.placeChecked('buy', 'stopLimit', 101); assert.equal(h.sent.pop().kind, 'stopLimit');
  h.core.placeChecked('buy', 'mit', 99); assert.equal(h.sent.pop().kind, 'mit');
  h.core.placeChecked('buy', 'stopLimit', 99);
  assert.equal(h.sent.length, 0); assert.match(h.flashes.pop()[0], /the chart: BUY STL, the ticket: LMT by 100/);
  h.core.placeChecked('buy', 'mit', 100);
  assert.equal(h.sent.length, 0); assert.match(h.flashes.pop()[0], /MIT would trigger at once/);
});

test('TradeCore: Merge sends exactly { type, cid, account, root } with Armed and a position; the result and managed states are kept', async () => {
  const V = await V3;
  const h = harness();
  withSwitches(h, ALL_ON);
  h.core.merge();
  assert.equal(h.sent.length, 0, 'not while disarmed');
  h.core.TR.armed = true;
  h.core.merge();
  assert.equal(h.sent.length, 0); assert.match(h.flashes.pop()[0], /^Merge: no open position on Sim101 MNQ/);
  h.core.message({ type: 'position', account: 'Sim101', root: 'MNQ', qty: 3, avgPrice: 100 });
  h.core.merge();
  const m = h.sent.pop();
  assert.deepEqual(Object.keys(m), ['type', 'cid', 'account', 'root']); assert.equal(m.type, 'merge');
  assert.equal(V.checkKeysV3(m, JSON.stringify(m)), null);
  assert.ok(TC.ORDER_ACTIONS.includes('merge'), 'counted in the 10 a second');
  h.core.message(Object.assign({}, FIX.serverToPage['merge.restored'], { account: 'Sim101', cid: m.cid }));
  assert.equal(h.core.TR.merges.get('Sim101|MNQ').result, 'restored');
  assert.deepEqual(h.flashes.pop(), [OS.mergeLine(h.core.TR.merges.get('Sim101|MNQ')).text, 'warn']);
  h.core.message(Object.assign({}, FIX.serverToPage.managed, { account: 'Sim101' }));
  assert.equal(h.core.managedOf('Sim101', 'MNQ')[0].state, 'resumed');
  h.core.message(Object.assign({}, FIX.serverToPage.managed, { account: 'Sim101', state: 'done' }));
  assert.equal(h.core.managedOf('Sim101', 'MNQ').length, 0, 'done: gone');
  h.core.lost('dropped');
  assert.deepEqual(h.core.TR.switches, OS.cleanSwitches(null), 'the switches are off while not connected');
});

test('order-ticket: a stop-limit or MIT entry carries its planned lines (0.4.0 rests them like a limit or stop)', () => {
  const o = { id: 'o12', account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'stopLimit', qty: 1, filled: 0, price: 25010.25, state: 'working', role: 'entry', planned: { stopTicks: 8, targetTicks: 16 } };
  const pl = OT.plannedLines(o, 0.25);
  assert.deepEqual(pl.lines.map(l => [l.id, l.price]), [['o12:sl', 25008.25], ['o12:tp', 25014.25]]);
  assert.equal(OT.plannedLines(Object.assign({}, o, { kind: 'mit', price: 25000 }), 0.25).lines.length, 2);
});

test('the workspace loads order-strategies.js before trade.js, and the install list has it', () => {
  const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  for (const f of ['live/index.html']) {
    const h = read(f), at = s => h.indexOf('src="' + s + '"');
    assert.ok(at('order-ticket.js') < at('order-strategies.js') && at('order-strategies.js') < at('trade.js'), f);
  }
  assert.ok(JSON.parse(read('nt8/install-files.json')).www.some(x => x.from === 'live/order-strategies.js' && x.to === 'order-strategies.js'));
  // no motion on these surfaces (rule R3): the strategies code and its CSS block start no animation or transition
  const css = read('live/workspace.css'), block = css.slice(css.indexOf('1.16.0 (ChartBridge 0.4.0): Order Strategies'));
  assert.doesNotMatch(block, /transition\s*:|animation\s*:|@keyframes/);
  assert.doesNotMatch(read('live/order-strategies.js'), /requestAnimationFrame|transition|animate\(/);
});
