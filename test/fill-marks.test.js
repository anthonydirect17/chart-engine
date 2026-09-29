'use strict';
// Fill marks (1.3.1): fills on one bar, side and price merge into one mark with the summed qty, and
// labels on one bar stack so each quantity reads.
const test = require('node:test');
const assert = require('node:assert/strict');
const CE = require('../src/chart-engine.js');
const U = CE.util;

const BAR = 60, T0 = 1000 * BAR;
const indexOf = t => Math.floor((t - T0) / BAR);          // bar index for a fill time
const yOf = p => (26000 - p) * 16;                         // 4 px per 0.25 tick
const S = 5, GAP = 10;                                      // triangle half width and label gap, as the chart draws them
const fill = (bar, side, price, qty, sec) => ({ t: T0 + bar * BAR + (sec || 0), side, price, qty });
const label = m => (m.side === 'buy' ? '▲' : '▼') + m.qty;
const noOverlap = rows => {
  const ys = rows.map(r => r.ly).sort((a, b) => a - b);
  for (let k = 1; k < ys.length; k++) assert.ok(ys[k] - ys[k - 1] >= GAP, 'labels ' + ys[k - 1] + ' and ' + ys[k] + ' overlap');
};

test('fill marks: 1 buy of 3 and 3 target fills of 1 at one price draw as ▲3 and ▼3', () => {
  const P = 25880.25;
  const execs = [fill(10, 'buy', P, 3, 5), fill(10, 'sell', P, 1, 20), fill(10, 'sell', P, 1, 21), fill(10, 'sell', P, 1, 22)];
  const marks = U.groupFills(execs, indexOf, 0.25);
  assert.deepEqual(marks.map(label).sort(), ['▲3', '▼3']);
  assert.equal(execs.length, 4, 'the executions themselves are left alone');
  // the same trade with the exits on a later bar
  const later = [fill(10, 'buy', P, 3), fill(14, 'sell', P + 5, 1, 1), fill(14, 'sell', P + 5, 1, 2), fill(14, 'sell', P + 5, 1, 3)];
  assert.deepEqual(U.groupFills(later, indexOf, 0.25).map(m => m.i + ' ' + label(m)), ['10 ▲3', '14 ▼3']);
  // buy label below the price, sell label above, exactly where a single fill's label sits
  const rows = U.stackFillLabels(marks, yOf, S, GAP);
  for (const r of rows) assert.equal(r.ly, r.y + (r.m.side === 'buy' ? S : -S));
  noOverlap(rows);
});

test('fill marks: prices match to the tick', () => {
  const marks = U.groupFills([fill(3, 'sell', 100, 1), fill(3, 'sell', 100 + 1e-9, 2), fill(3, 'sell', 100.25, 1)], indexOf, 0.25);
  assert.deepEqual(marks.map(m => m.price + ':' + m.qty), ['100:3', '100.25:1']);
});

test('fill marks: same bar and side at different prices stay separate and their labels do not overlap', () => {
  const sells = [fill(7, 'sell', 25900, 1), fill(7, 'sell', 25899.75, 2), fill(7, 'sell', 25899.5, 4)];
  const buys = [fill(7, 'buy', 25890, 1), fill(7, 'buy', 25890.25, 6)];
  const marks = U.groupFills(sells.concat(buys), indexOf, 0.25);
  assert.equal(marks.length, 5);
  const rows = U.stackFillLabels(marks, yOf, S, GAP);
  noOverlap(rows);
  for (const r of rows) assert.equal(r.y, yOf(r.m.price), 'the triangle tip stays at the fill price');
  // sells stack up from the price, buys down, in price order (higher price, higher label)
  const s = rows.filter(r => r.m.side === 'sell').sort((a, b) => b.m.price - a.m.price);
  const b = rows.filter(r => r.m.side === 'buy').sort((a, c) => c.m.price - a.m.price);
  for (let k = 1; k < s.length; k++) assert.ok(s[k].ly > s[k - 1].ly);
  for (let k = 1; k < b.length; k++) assert.ok(b[k].ly > b[k - 1].ly);
  for (const r of s) assert.ok(r.ly < r.y, 'sell label above its price');
  for (const r of b) assert.ok(r.ly > r.y, 'buy label below its price');
});

test('fill marks: a buy and a sell close together on one bar stay readable', () => {
  // sold one tick under the buy: sell label goes up, buy label goes down, never on top of each other
  const rows = U.stackFillLabels(U.groupFills([fill(2, 'buy', 100.25, 1), fill(2, 'sell', 100, 2)], indexOf, 0.25), yOf, S, GAP);
  assert.equal(rows.length, 2);
  noOverlap(rows);
});

test('fill marks: buys and sells on different bars are unchanged', () => {
  const execs = [fill(1, 'buy', 25880, 2), fill(4, 'sell', 25886.5, 2), fill(6, 'sell', 25886.5, 1), fill(9, 'buy', 25881, 1)];
  const marks = U.groupFills(execs, indexOf, 0.25);
  assert.deepEqual(marks.map(m => [m.i, m.side, m.price, m.qty]), execs.map(f => [indexOf(f.t), f.side, f.price, f.qty]));
  for (const r of U.stackFillLabels(marks, yOf, S, GAP)) {
    assert.equal(r.y, yOf(r.m.price));
    assert.equal(r.ly, r.y + (r.m.side === 'buy' ? S : -S), 'label where it always was');
  }
});
