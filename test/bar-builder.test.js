'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BarBuilder } = require('../live/bar-builder.js');

const et = (h, m, s) => Date.UTC(2026, 8, 29, h, m, s || 0) / 1000;

test('time bars bucket ticks by start time', () => {
  const b = new BarBuilder({ mode: 'time', seconds: 15 });
  b.add(et(10, 0, 1), 100, 1);
  b.add(et(10, 0, 14), 101, 2);
  const r = b.add(et(10, 0, 15), 99.5, 1);
  assert.equal(r.isNew, true);
  assert.equal(b.bars.length, 2);
  assert.deepEqual([b.bars[0].t, b.bars[0].o, b.bars[0].h, b.bars[0].l, b.bars[0].c, b.bars[0].v], [et(10, 0, 0), 100, 101, 100, 101, 3]);
  assert.equal(b.bars[1].t, et(10, 0, 15));
});

test('late ticks fold into the newest bar, never rewrite an older one', () => {
  const b = new BarBuilder({ mode: 'time', seconds: 60 });
  b.add(et(10, 1, 0), 100, 1);
  b.add(et(10, 0, 59), 102, 1);
  assert.equal(b.bars.length, 1);
  assert.equal(b.bars[0].h, 102);
});

test('range bars close when the span would exceed the range and never invent prices', () => {
  const b = new BarBuilder({ mode: 'range', rangeTicks: 4, tick: 0.25 });   // 1 point
  const prices = [100, 100.25, 100.75, 101, 101.25, 100.5, 99.75, 99.5];
  prices.forEach((p, i) => b.add(et(10, 0, i), p, 1));
  for (const bar of b.bars) {
    assert.ok(bar.h - bar.l <= 1 + 1e-9, 'span ' + (bar.h - bar.l));
    assert.ok(prices.includes(bar.o) && prices.includes(bar.c));
  }
  assert.equal(b.bars[0].h, 101);                 // 100 .. 101 is exactly 4 ticks
  assert.equal(b.bars[1].o, 101.25);               // the breakout tick opens the next bar
  for (let i = 1; i < b.bars.length; i++) assert.ok(b.bars[i].t > b.bars[i - 1].t);
  const left = b.rangeLeft();
  assert.ok(left.up >= 0 && left.down >= 0);
});

test('range bars keep strictly increasing times even inside one second', () => {
  const b = new BarBuilder({ mode: 'range', rangeTicks: 1, tick: 0.25 });
  const t = et(10, 0, 0);
  [100, 100.5, 101, 101.5].forEach(p => b.add(t, p, 1));
  for (let i = 1; i < b.bars.length; i++) assert.ok(b.bars[i].t > b.bars[i - 1].t);
});

test('session VWAP restarts at 18:00 ET and seeds from history', () => {
  const b = new BarBuilder({ mode: 'time', seconds: 60 });
  b.seed([{ t: et(16, 58), o: 10, h: 10, l: 10, c: 10, v: 100 }]);
  b.add(et(18, 0, 5), 20, 1);
  b.add(et(18, 0, 30), 30, 1);
  assert.equal(b.bars[0].vw, 10);
  assert.equal(b.last.vw, 25);
});
