'use strict';
// Unreleased (Anthony 2026-11-18, the floor fix): ChartBridge keeps every prop account's end-of-day high at every close, in a
// group or not, and its accounts entry carries it (highEod); the page's join prefills the highest close never below it, and warns
// once when a join must start the highs at the account size. Made-up names and money only (Lucid 50K, LUCID-1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const GC = require('../live/groups.js');
const AC = require('../live/accounts.js');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const lucid = { id: 'g1', name: 'Lucid 50K', drawdown: 2000, drawdownType: 'eod', size: 50000 };

test('floor fix: the prefill is never below the end-of-day high ChartBridge keeps', () => {
  assert.equal(GC.keptHigh({ highEod: 50200 }), 50200);
  assert.equal(GC.keptHigh({ highEod: null }), 0, 'none kept');
  assert.equal(GC.keptHigh({}), 0, 'an older ChartBridge sends no highEod');
  // a close of 50,200, then a join at a balance of 49,900: 50200 (floor 48,200), not 50000 (48,000)
  assert.equal(GC.highCloseDefault(lucid, { balance: 49900, highEod: 50200 }), 50200);
  assert.equal(GC.highCloseDefault(lucid, { balance: 50000, highEod: 50200 }), 50200);
  assert.equal(GC.highCloseDefault(lucid, { balance: 50400, highEod: 50200 }), 50400, 'the balance when higher, as before');
  assert.equal(GC.highCloseDefault(lucid, { balance: 49900 }), 50000, 'nothing kept: the size, as before');
  const seed = { value: 50100, date: '2026-10-17', words: 'x' };
  assert.deepEqual(GC.seedOrKept(seed, { highEod: 50200 }), { value: 50200, kept: true }, 'The Desk\'s seed below the kept close (a close since the seed): the kept one');
  assert.deepEqual(GC.seedOrKept(seed, { highEod: 50000 }), { value: 50100, kept: false }, 'the seed when it is the higher');
  assert.deepEqual(GC.seedOrKept(seed, {}), { value: 50100, kept: false });
});

test('floor fix: the one warning when a join must start at the account size (the same $25 gap as the floor flag)', () => {
  assert.equal(AC.FLOOR_GAP, 25);
  const a = { name: 'LUCID-1', balance: 49900, unrealized: 0 };
  const w = AC.sizeStartWarn(a, lucid, '50000');
  assert.match(w, /^No close above the account size is known for LUCID-1 \(none from The Desk, none kept by ChartBridge\): its floor starts at \$48,000\.00, the account size less the drawdown\. If the firm's dashboard shows a higher minimum balance, type its highest close here \(that minimum plus \$2,000\.00\)\.$/);
  assert.ok(!/[\u2013\u2014]/.test(w), 'no en or em dashes');
  assert.equal(AC.sizeStartWarn(a, lucid, '50200'), '', 'a start above the size: no warning');
  assert.equal(AC.sizeStartWarn(a, Object.assign({}, lucid, { drawdownType: 'static' }), '50000'), '', 'a static floor never trails');
  assert.equal(AC.sizeStartWarn(Object.assign({}, a, { roomFloorNt: 1910 }), lucid, '50000'), '', 'NinjaTrader puts the floor within $25 (47,990): quiet');
  assert.match(AC.sizeStartWarn(Object.assign({}, a, { roomFloorNt: 1700 }), lucid, '50000'), /and NinjaTrader puts it at \$48,200\.00\./, 'NinjaTrader more than $25 away: said with its figure');
  assert.equal(AC.sizeStartWarn(null, lucid, '50000'), '');
  assert.equal(AC.sizeStartWarn(a, null, '50000'), '');
});

test('floor fix: both join steps use the kept high and show the warning; ChartBridge sends highEod', () => {
  const src = read('live/accounts.js'), ma = read('live/multi-account.js'), cs = read('nt8/ChartBridgeGroups.cs'), proto = read('nt8/PROTOCOL.md');
  assert.match(src, /const warned = \(p, rules\) => \{ const k = GC\.keptHigh\(acc\); return Object\.assign\(p, \{ kept: k > 0 && \+p\.prefill <= k \+ 0\.004, warn: AC\.sizeStartWarn\(acc, rules, p\.prefill\) \}\); \};/);
  assert.match(src, /const seed = GC\.seedHigh\(row, dr\.rules\), sk = seed \? GC\.seedOrKept\(seed, acc\) : null;/, 'The Desk\'s seed never below the kept close');
  assert.match(src, /\(j\.warn \? ` <span class="apg-twarn apg-jwarn">\$\{esc\(j\.warn\)\}<\/span>` : ''\)/, 'the Accounts tab\'s join row shows it');
  assert.match(ma, /\(j\.plan\.warn \? `<span class="ma-jwarn">\$\{esc\(j\.plan\.warn\)\}<\/span>` : ''\)/, 'the Multi-Account panel\'s join step too');
  assert.match(cs, /b\.Append\(",\\"highEod\\":"\)\.Append\(kept > 0 \? Num\(kept\) : "null"\);/, 'ChartBridge\'s accounts entry carries highEod');
  assert.match(proto, /`highEod`/);
});
