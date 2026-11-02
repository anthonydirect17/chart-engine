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
    if (rnd(5) === 0) { for (const k of ['barTrail', 'barTrailOffset']) { const v = pick(nums); if (v !== undefined) s[k] = v; } }   // next release: the bar trail
    if (rnd(6) === 0) { const ty = pick(['minute', 'range', 'tick', 5, undefined]); if (ty !== undefined) s.barTrailType = ty; for (const k of ['barTrailSize', 'barTrailStart']) { const v = pick(nums); if (v !== undefined) s[k] = v; } }   // 2026-11-01: kind and start
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
  // the bracket itself was cut to that maxBracketTicks (1.21.0: the cap is maxBracketTicks whatever the version; before it
  // a hello with no version kept the 200-tick cap)
  assert.deepEqual(h.core.brackets.MNQ, { stop: 8, target: 10 });
  // no strategy picked: the bracket as before
  withSwitches(h, ALL_ON); h.core.TR.armed = true; h.H.strategy = null;
  h.core.brackets.MNQ = { stop: 8, target: 16 };
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

/* ---------------- next release: the bar trail (Anthony's task "Strategy creator: bar trail option") */
test('the bar trail: an optional barTrail { bars, offsetTicks }, never null, never with the tick trail; to ChartBridge as barTrail and barTrailOffset', () => {
  const bt = strat({ trail: null, barTrail: { bars: 3, offsetTicks: 2 } });
  assert.equal(OS.checkStrategy(bt, {}), null);
  assert.deepEqual(OS.toWire(bt), { name: 'Scalp 2', stop: 16, stopLimit: 2, t1: 8, t1Share: 50, t2: 20, t2Share: 50, beAfter: 8, bePlus: 1, barTrail: 3, barTrailOffset: 2, barTrailType: 'minute', barTrailSize: 1 },
    'backward compatible: a bar trail with no kind (the first build\'s document) is 1 minute bars');
  assert.equal(OS.checkWire(OS.toWire(bt), 0), null);
  assert.equal(OS.describe(bt), 'Stop 16 STL+2 · T1 8 50% · T2 20 50% · BE 8+1 · Bar trail 3 x 1 min +2');
  assert.equal(OS.describe(strat({ trail: null, barTrail: { bars: 1, offsetTicks: 0 } })), 'Stop 16 STL+2 · T1 8 50% · T2 20 50% · BE 8+1 · Bar trail 1 x 1 min');
  assert.ok(!('barTrail' in OS.toWire(SCALP)) && !('barTrailOffset' in OS.toWire(SCALP)), 'a strategy without it sends neither key');
  const why = (over) => OS.checkStrategy(strat(Object.assign({ trail: null }, over)), {});
  const needs = 'The bar trail needs bars and offset ticks (and may have a bar type and size, and a start).';
  assert.deepEqual(why({ barTrail: null }), { field: 'barTrail', text: needs }, 'null is refused: no key means no bar trail');
  assert.deepEqual(why({ barTrail: { bars: 2 } }), { field: 'barTrail', text: needs });
  assert.equal(why({ barTrail: { bars: 0, offsetTicks: 1 } }).field, 'barTrail');
  assert.equal(why({ barTrail: { bars: 51, offsetTicks: 1 } }).text, 'The bar trail must be a whole number of bars from 1 to 50.');
  assert.equal(why({ barTrail: { bars: 2.5, offsetTicks: 1 } }).field, 'barTrail');
  assert.deepEqual(why({ barTrail: { bars: 2, offsetTicks: 101 } }), { field: 'barOffset', text: 'The bar trail\'s offset must be a whole number of ticks from 0 to 100.' });
  assert.equal(why({ barTrail: { bars: 2, offsetTicks: -1 } }).field, 'barOffset');
  assert.deepEqual(OS.checkStrategy(strat({ barTrail: { bars: 2, offsetTicks: 1 } }), {}), { field: 'barTrail', text: 'One trail per strategy: Trailing or Bar trail, not both.' });
  assert.match(OS.checkStrategy(strat({ barTrail: { bars: 2, offsetTicks: 1 }, extra: 1 }), {}).text, /needs exactly/);
  // a document read with one keeps it; a document without any is as before
  const doc = OS.cleanStrategiesDoc({ rev: 3, strategies: [bt, strat({ id: 'b', name: 'B', hotkey: null })] });
  assert.equal(doc.strategies.length, 2);
  assert.equal(OS.checkStrategiesDoc(doc, null), '');
  // ChartBridge's words: both or neither, never with trailAfter, maxBracketTicks on the offset
  assert.equal(OS.checkWire({ name: 'S', stop: 8, barTrail: 2 }, 0), 'barTrail and barTrailOffset go together.');
  assert.equal(OS.checkWire({ name: 'S', stop: 8, barTrail: 2, barTrailOffset: 1, trailAfter: 8, trailBy: 4, trailStep: 1 }, 0), 'barTrail and trailAfter are refused together: one trail per strategy.');
  assert.equal(OS.checkWire({ name: 'S', stop: 8, barTrail: 2, barTrailOffset: 40 }, 30), 'barTrailOffset must be at most 30 (maxBracketTicks in config.txt).');
});

test('the bar trail: the C# reads and refuses it with the same rules (ChartBridgeStrategies.cs)', () => {
  const cs = fs.readFileSync(path.join(__dirname, '..', 'nt8', 'ChartBridgeStrategies.cs'), 'utf8');
  assert.match(cs, /"trailStep", "barTrail", "barTrailOffset", "barTrailType", "barTrailSize", "barTrailStart" \};/);
  assert.match(cs, /public const int BarTrailMax = 50, BarTrailOffsetMax = 100,/);
  assert.match(cs, /barTrail and trailAfter are refused together: one trail per strategy/);
  assert.match(cs, /if \(s\.BarTrail > 0 && p\.BarLevel > 0 && Tighter\(m\.Buy, p\.BarLevel, stopNow\)/, 'sent by MoveDue, under every rule of a move');
  const ws = fs.readFileSync(path.join(__dirname, '..', 'live', 'workspace.js'), 'utf8');
  assert.match(ws, /s\.barTrail = \{ bars: n\('barTrail'\), offsetTicks: n\('barOffset'\), type: sgEl\('barType'\)\.value === 'range' \? 'range' : 'minute', size: n\('barSize'\) \};/);
  assert.match(ws, /if \(n\('barStart'\) !== 0\) s\.barTrail\.startTicks = n\('barStart'\);/);
});

/* ---------------- Anthony 2026-11-01: any bar kind (minute or NinjaTrader's range) and an optional start */
test('the bar trail\'s kind and start: in The Desk\'s document, to ChartBridge, in one line; the same refusals as ChartBridge', async () => {
  const V = await V3;
  const bt = (b) => strat({ trail: null, barTrail: b });
  const r40 = bt({ bars: 3, offsetTicks: 2, type: 'range', size: 40 });
  assert.equal(OS.checkStrategy(r40, {}), null);
  assert.equal(OS.describe(r40), 'Stop 16 STL+2 · T1 8 50% · T2 20 50% · BE 8+1 · Bar trail 3 x 40-range +2');
  assert.deepEqual(OS.toWire(r40), { name: 'Scalp 2', stop: 16, stopLimit: 2, t1: 8, t1Share: 50, t2: 20, t2Share: 50, beAfter: 8, bePlus: 1, barTrail: 3, barTrailOffset: 2, barTrailType: 'range', barTrailSize: 40 });
  const m5 = bt({ bars: 2, offsetTicks: 0, type: 'minute', size: 5, startTicks: 8 });
  assert.equal(OS.checkStrategy(m5, {}), null);
  assert.equal(OS.describe(m5), 'Stop 16 STL+2 · T1 8 50% · T2 20 50% · BE 8+1 · Bar trail 2 x 5 min from 8');
  assert.equal(OS.toWire(m5).barTrailStart, 8);
  assert.ok(!('barTrailStart' in OS.toWire(bt({ bars: 2, offsetTicks: 0, type: 'minute', size: 5, startTicks: 0 }))), 'a start of 0 is at once: no key');
  for (const s of [r40, m5]) { assert.equal(OS.checkWire(OS.toWire(s), 0), null); assert.equal(V.checkStrategy(OS.toWire(s), 0), null, 'the fake bridge takes it'); }
  const why = b => OS.checkStrategy(bt(b), {});
  assert.deepEqual(why({ bars: 2, offsetTicks: 1, type: 'range' }), { field: 'barType', text: 'The bar trail\'s bar type and size go together.' });
  assert.deepEqual(why({ bars: 2, offsetTicks: 1, size: 40 }), { field: 'barType', text: 'The bar trail\'s bar type and size go together.' });
  assert.deepEqual(why({ bars: 2, offsetTicks: 1, type: 'tick', size: 40 }), { field: 'barType', text: 'The bar trail\'s bars are minute or range bars: tick bars are not supported.' });
  assert.deepEqual(why({ bars: 2, offsetTicks: 1, type: 'minute', size: 7 }), { field: 'barSize', text: 'Minute bars for the bar trail are 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30 or 60 minutes.' });
  assert.deepEqual(why({ bars: 2, offsetTicks: 1, type: 'range', size: 401 }), { field: 'barSize', text: 'Range bars for the bar trail are a whole number of ticks from 1 to 400.' });
  assert.equal(why({ bars: 2, offsetTicks: 1, type: 'range', size: 0 }).field, 'barSize');
  assert.deepEqual(why({ bars: 2, offsetTicks: 1, startTicks: 2001 }), { field: 'barStart', text: 'The bar trail\'s start must be a whole number of ticks from 0 to 2000 (0: at once).' });
  assert.equal(why({ bars: 2, offsetTicks: 1, startTicks: -1 }).field, 'barStart');
  assert.equal(why({ bars: 2, offsetTicks: 1, extra: 1 }).field, 'barTrail');
  /* the first build's document (no kind, no start) still loads, and reads as 1 minute bars */
  const old = OS.cleanStrategiesDoc({ rev: 2, strategies: [bt({ bars: 3, offsetTicks: 2 })] });
  assert.equal(old.strategies.length, 1);
  assert.deepEqual(OS.barKind(old.strategies[0].barTrail), { type: 'minute', size: 1, supported: true });
  /* ChartBridge's words for the wire keys */
  const W = o => OS.checkWire(Object.assign({ name: 'S', stop: 8 }, o), 0);
  assert.equal(W({ barTrailType: 'range', barTrailSize: 40 }), 'barTrailType, barTrailSize and barTrailStart need barTrail.');
  assert.equal(W({ barTrail: 2, barTrailOffset: 1, barTrailType: 'hour', barTrailSize: 1 }), 'barTrailType must be "minute" or "range".');
  assert.equal(W({ barTrail: 2, barTrailOffset: 1, barTrailType: 'range' }), 'barTrailType and barTrailSize go together.');
  assert.equal(W({ barTrail: 2, barTrailOffset: 1, barTrailType: 'range', barTrailSize: '40' }), 'barTrailSize must be a whole number.');
  assert.equal(W({ barTrail: 2, barTrailOffset: 1, barTrailType: 'minute', barTrailSize: 7 }), 'barTrailSize for minute bars must be 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30 or 60.');
  assert.equal(W({ barTrail: 2, barTrailOffset: 1, barTrailType: 'range', barTrailSize: 401 }), 'barTrailSize for range bars must be a whole number of ticks from 1 to 400.');
  assert.equal(W({ barTrail: 2, barTrailOffset: 1, barTrailStart: 2001 }), 'barTrailStart must be a whole number of ticks from 0 to 2000.');
  assert.equal(OS.checkWire({ name: 'S', stop: 8, barTrail: 2, barTrailOffset: 1, barTrailStart: 40 }, 30), 'barTrailStart must be at most 30 (maxBracketTicks in config.txt).');
  /* the C# has the same keys and limits */
  const cs = fs.readFileSync(path.join(__dirname, '..', 'nt8', 'ChartBridgeStrategies.cs'), 'utf8');
  assert.match(cs, /"barTrail", "barTrailOffset", "barTrailType", "barTrailSize", "barTrailStart" \};/);
  assert.match(cs, /BarRangeMax = 400, BarStartMax = 2000;/);
  assert.match(cs, /BarMinuteSizes = \{ 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60 \};/);
  assert.deepEqual(OS.BAR_MINUTES, [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60]);
});

/* ---------------- Anthony 2026-11-01: phantom bars, the session, "not proven yet", and nothing unsupported in silence */
test('the bar trail\'s state from ChartBridge is said on the ticket: not proven yet and ended in the warning colour', () => {
  const m = { type: 'managed', id: 'o1', name: 'Bars R40', state: 'active', pairs: [{ bucket: 1, qty: 1, fill: 25000, be: false, trailing: false }], text: null };
  assert.deepEqual(OS.managedLine(m), { text: 'Bars R40 managing: 1 pair', level: '' }, 'no barTrail key (a strategy without one, an older ChartBridge): as before');
  const NP = 'not proven yet: ChartBridge has not seen these 40 tick range bars from the session open (or a swing that proves them NinjaTrader\'s), so the stop stays where it is';
  assert.deepEqual(OS.managedLine(Object.assign({}, m, { barTrail: { state: 'notProven', text: NP } })), { text: 'Bars R40 managing: 1 pair · Bar trail not proven yet', level: 'warn', tip: 'Bars R40 managing: 1 pair · Bar trail ' + NP },
    '1.42: the ticket says ChartBridge\'s words up to their first colon, the whole in the tooltip');
  assert.deepEqual(OS.managedLine(Object.assign({}, m, { barTrail: { state: 'notProven', text: null } })), { text: 'Bars R40 managing: 1 pair · Bar trail not proven yet', level: 'warn' }, 'never silent, even without ChartBridge\'s words');
  const EN = 'ended at the session close: it no longer moves the stop, which stays where it is', NR = 'not running: no room for 15 minute bars on MNQ (at most 16 bar kinds at once); the stop stays where it is';
  assert.deepEqual(OS.managedLine(Object.assign({}, m, { barTrail: { state: 'ended', text: EN } })), { text: 'Bars R40 managing: 1 pair · Bar trail ended', level: 'warn', tip: 'Bars R40 managing: 1 pair · Bar trail ' + EN },
    '1.42.1 (Anthony 2026-11-02): ended says just "Bar trail ended", the whole reason in the tooltip');
  assert.deepEqual(OS.managedLine(Object.assign({}, m, { barTrail: { state: 'ended', text: 'ended at the session close' } })), { text: 'Bars R40 managing: 1 pair · Bar trail ended', level: 'warn', tip: 'Bars R40 managing: 1 pair · Bar trail ended at the session close' }, 'ChartBridge\'s words without a colon: still short, the whole in the tooltip');
  assert.deepEqual(OS.managedLine(Object.assign({}, m, { barTrail: { state: 'ended', text: null } })), { text: 'Bars R40 managing: 1 pair · Bar trail ended', level: 'warn' }, 'without ChartBridge\'s words: ended, in the warning colour, no tooltip');
  assert.deepEqual(OS.managedLine(Object.assign({}, m, { barTrail: { state: 'none', text: NR } })), { text: 'Bars R40 managing: 1 pair · Bar trail not running', level: 'warn', tip: 'Bars R40 managing: 1 pair · Bar trail ' + NR });
  assert.deepEqual(OS.managedLine(Object.assign({}, m, { barTrail: { state: 'building', text: 'waiting for 3 whole 5 minute bars' } })), { text: 'Bars R40 managing: 1 pair · Bar trail waiting for bars', level: '', tip: 'Bars R40 managing: 1 pair · Bar trail waiting for 3 whole 5 minute bars' },
    '1.42.1 (Anthony 2026-11-02): waiting says just "Bar trail waiting for bars", ChartBridge\'s words in the tooltip, the plain colour');
  assert.deepEqual(OS.managedLine(Object.assign({}, m, { barTrail: { state: 'building', text: 'waiting for bars' } })), { text: 'Bars R40 managing: 1 pair · Bar trail waiting for bars', level: '' }, 'the short words already: no tooltip');
  assert.deepEqual(OS.managedLine(Object.assign({}, m, { barTrail: { state: 'building', text: 'building 2 of 3 bars: from the session open' } })), { text: 'Bars R40 managing: 1 pair · Bar trail building 2 of 3 bars', level: '', tip: 'Bars R40 managing: 1 pair · Bar trail building 2 of 3 bars: from the session open' }, 'ChartBridge\'s words without "waiting": as before');
  assert.deepEqual(OS.managedLine(Object.assign({}, m, { barTrail: { state: 'building', text: null } })), { text: 'Bars R40 managing: 1 pair · Bar trail building', level: '' }, 'without ChartBridge\'s words: as before');
  assert.deepEqual(OS.managedLine(Object.assign({}, m, { barTrail: { state: 'on', text: null } })), { text: 'Bars R40 managing: 1 pair', level: '' });
  assert.deepEqual(OS.managedLine(Object.assign({}, m, { state: 'waiting', barTrail: { state: 'notProven', text: NP } })), { text: 'Bars R40: waiting for the fill · Bar trail not proven yet', level: 'warn', tip: 'Bars R40: waiting for the fill · Bar trail ' + NP });
  const rs = OS.managedLine(Object.assign({}, m, { state: 'resumed', text: 'ChartBridge restarted', barTrail: { state: 'ended', text: EN } }));
  assert.deepEqual(rs, { text: 'Bars R40 resumed after a restart: 1 pair (ChartBridge restarted) · Bar trail ended', level: 'warn', tip: 'Bars R40 resumed after a restart: 1 pair (ChartBridge restarted) · Bar trail ' + EN });
  assert.equal(OS.managedLine(Object.assign({}, m, { state: 'resumed', text: 'ChartBridge restarted', barTrail: { state: 'building', text: 'waiting for 1 whole 1 minute bar' } })).level, 'warn');
});

test('a bar kind the chart does not support is said plainly: never read as minute bars, never dropped in silence', () => {
  assert.deepEqual(OS.barKind({ bars: 2, offsetTicks: 1, type: 'tick', size: 500 }), { type: 'tick', size: 500, supported: false }, 'tick bars are not read as 1 minute bars');
  assert.deepEqual(OS.barKind({ bars: 2, offsetTicks: 1, type: 'minute', size: 7 }), { type: 'minute', size: 7, supported: false });
  assert.deepEqual(OS.barKind({ bars: 2, offsetTicks: 1, type: 'range', size: 40 }), { type: 'range', size: 40, supported: true });
  assert.deepEqual(OS.barKind(null), { type: 'minute', size: 1, supported: true });
  assert.equal(OS.checkStrategy(strat({ trail: null, barTrail: { bars: 2, offsetTicks: 1, type: 'volume', size: 1000 } }), {}).text, 'The bar trail\'s bars are minute or range bars: volume bars are not supported.');
  const raw = { rev: 4, strategies: [strat({ id: 'a', hotkey: null }), strat({ id: 't', name: 'Ticks 500', hotkey: null, trail: null, barTrail: { bars: 2, offsetTicks: 1, type: 'tick', size: 500 } }),
    strat({ id: 'm7', name: 'Seven', hotkey: null, trail: null, barTrail: { bars: 2, offsetTicks: 1, type: 'minute', size: 7 } })] };
  assert.deepEqual(OS.cleanStrategiesDoc(raw).strategies.map(x => x.id), ['a']);
  assert.deepEqual(OS.strategiesLeftOut(raw), [
    { name: 'Ticks 500', text: 'The bar trail\'s bars are minute or range bars: tick bars are not supported.' },
    { name: 'Seven', text: 'Minute bars for the bar trail are 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30 or 60 minutes.' }]);
  assert.deepEqual(OS.strategiesLeftOut({ rev: 1, strategies: [strat({ id: 'a', hotkey: null })] }), []);
  assert.deepEqual(OS.strategiesLeftOut(null), []);
  /* ChartBridge's own check names it too (the page refuses what ChartBridge would) */
  assert.equal(OS.checkWire({ name: 'S', stop: 8, barTrail: 2, barTrailOffset: 1, barTrailType: 'tick', barTrailSize: 500 }, 0), 'barTrailType must be "minute" or "range".');
});

test('createDesk: a read or a save keeps the strategies it left out, for the Strategies screen to name', async () => {
  const raw = { rev: 2, strategies: [strat({ id: 'a', hotkey: null }), strat({ id: 't', name: 'Ticks 500', hotkey: null, trail: null, barTrail: { bars: 2, offsetTicks: 1, type: 'tick', size: 500 } })] };
  const mem = new Map();
  const storage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  const fetch = async (url, o) => ({ status: 200, json: async () => (o.method === 'PUT' ? Object.assign(JSON.parse(o.body), { rev: 3, strategies: raw.strategies }) : raw) });
  const desk = OS.createDesk({ fetch, storage, base: () => 'http://127.0.0.1:8800' });
  assert.deepEqual(desk.leftOut.strategies, []);
  const r = await desk.read('strategies');
  assert.equal(r.ok, true);
  assert.deepEqual(r.doc.strategies.map(x => x.id), ['a']);
  assert.deepEqual(desk.leftOut.strategies, [{ name: 'Ticks 500', text: 'The bar trail\'s bars are minute or range bars: tick bars are not supported.' }]);
  await desk.save('strategies', { rev: 2, strategies: [strat({ id: 'a', hotkey: null })] });
  assert.equal(desk.leftOut.strategies.length, 1, 'a save that comes back with it says so again');
  const ws = fs.readFileSync(path.join(__dirname, '..', 'live', 'workspace.js'), 'utf8');
  assert.match(ws, /<p class="ws-help" id="sg-left" role="status"><\/p>/);
  assert.match(ws, /'Not shown, this chart cannot use ' \+/);
});

test('the C# bar trail: the phantom rule, the session close, not proven yet and the 17th kind (ChartBridgeStrategies.cs)', () => {
  const cs = fs.readFileSync(path.join(__dirname, '..', 'nt8', 'ChartBridgeStrategies.cs'), 'utf8');
  assert.match(cs, /THE PHANTOM RULE: a phantom bar is a range bar\s+\/\/\s+no trade was in/);
  assert.match(cs, /Phantoms\+\+;   \/\/ a phantom bar: no trade was in it, never used/);
  assert.match(cs, /if \(exact\) \{ Push\(th \* Tick, tl \* Tick\); done = true; \}/, 'a used bar keeps its traded high and low');
  assert.match(cs, /if \(open \|\| !had\) \{ if \(EndBarTrailsLocked\(root, d\)\) ended = true; \}/, 'the session open (and the first trade seen after a start) ends the bar trail of entries filled in an earlier session');
  // review of PR #75: HIGH 1, the session across a restart; HIGH 2, the gap rule; LOW 4, the flat rule
  assert.match(cs, /if \(m\.Session > 0 && m\.Session >= d\) continue;   \/\/ filled in this session: it trails on/);
  assert.match(cs, /\(\\tmerged\)\{0,1\}\(\\tsession:\[0-9\]\{1,9\}\)\{0,1\}\(\\tbarEnded\)\{0,1\}\$"\);/, 'managed.txt: optional session and barEnded after merged');
  assert.match(cs, /line\.BarEnded \|\| \(savedSession > 0 \? nowSession == 0 \|\| savedSession < nowSession : filled \|\| legs\.Any/, 'a restart keeps an earlier session\'s bar trail ended (and one with no saved session)');
  assert.match(cs, /if \(gap\) \{ foreach \(TrailBars tb in list\) tb\.Reset\(\); BarGapSince\.Remove\(root\); \}\s+else foreach \(TrailBars tb in list\) tb\.SessionOpen\(d\);/, 'a gap across the open: the kinds start over as after a drop');
  assert.match(cs, /string notOpen = PositionNotOpen\(stop\);/, 'never a stop move while the position is not open');
  const cb = fs.readFileSync(path.join(__dirname, '..', 'nt8', 'ChartBridge.cs'), 'utf8');
  const drop = cb.slice(cb.indexOf('private static void FeedDropped(string root, string why)'));
  assert.ok(drop.indexOf('ChartBridgeOrders.BarTrailFeedDropped(root);') > 0 && drop.indexOf('ChartBridgeOrders.BarTrailFeedDropped(root);') < drop.indexOf('if (MarketClosedNow())'), 'a drop while the market is closed reaches the bar trail too');
  assert.match(cs, /return "notProven";/);
  assert.match(cs, /return "ended";/);
  assert.match(cs, /",\\"barTrail\\":\{\\"state\\":"/);
  const orders = fs.readFileSync(path.join(__dirname, '..', 'nt8', 'ChartBridgeOrders.cs'), 'utf8');
  assert.match(orders, /bad = BarTrailPlaceProblem\(root, strat, tick\);/, 'placement refuses a bar kind it cannot build, with the reason');
  assert.doesNotMatch(cs, /past that an entry's bar trail never moves/);
});
