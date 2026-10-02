'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const CE = require('../src/chart-engine.js');
const SampleFeed = require('../demo/sample-feed.js');
const U = CE.util;

const et = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi) / 1000;   // wall clock stored as UTC

test('fmtPrice groups thousands and keeps precision', () => {
  assert.equal(U.fmtPrice(25880.5), '25,880.50');
  assert.equal(U.fmtPrice(1234567.25), '1,234,567.25');
  assert.equal(U.fmtPrice(0.1277, 4), '0.1277');
  assert.equal(U.fmtPrice(-12.5), '-12.50');
  assert.equal(U.fmtPrice(42, 0), '42');
});

test('niceStep lands on 1/2/2.5/5 steps that are whole ticks', () => {
  assert.equal(U.niceStep(3, 0.25), 5);
  assert.equal(U.niceStep(0.3, 0.25), 0.5);
  assert.equal(U.niceStep(9, 0.25), 10);
  assert.equal(U.niceStep(0.0007, 0.0001), 0.001);
  for (const raw of [0.13, 0.9, 3.3, 17, 240]) {
    const s = U.niceStep(raw, 0.25);
    assert.ok(s >= raw, raw + ' -> ' + s);
    assert.ok(Math.abs(s / 0.25 - Math.round(s / 0.25)) < 1e-9, 'whole ticks: ' + s);
  }
});

test('tradeDay: the CME session starts 18:00 ET the evening before', () => {
  const S = 18 * 3600;
  assert.equal(U.tradeDay(et(2026, 9, 28, 18, 0), S), U.tradeDay(et(2026, 9, 29, 9, 30), S));
  assert.notEqual(U.tradeDay(et(2026, 9, 28, 16, 59), S), U.tradeDay(et(2026, 9, 28, 18, 0), S));
  assert.equal(U.tradeDay(et(2026, 9, 29, 0, 0), 0), U.tradeDay(et(2026, 9, 29, 23, 59), 0));
});

test('zoneSeconds converts to New York wall clock across DST', () => {
  assert.equal(U.zoneSeconds(Date.UTC(2026, 8, 29, 14, 0) / 1000), et(2026, 9, 29, 10, 0));   // EDT, UTC-4
  assert.equal(U.zoneSeconds(Date.UTC(2026, 11, 1, 15, 0) / 1000), et(2026, 12, 1, 10, 0));  // EST, UTC-5
  assert.equal(U.zoneSeconds(Date.UTC(2026, 8, 29, 14, 0) / 1000, 'UTC'), et(2026, 9, 29, 14, 0));
});

test('aggregate and foldLast agree on the newest bar', () => {
  const feed = SampleFeed.create();
  for (const tf of [300, 900, 3600]) {
    const agg = U.aggregate(feed.base, tf);
    assert.deepEqual(U.foldLast(feed.base, tf), agg[agg.length - 1], 'tf ' + tf);
  }
  const agg5 = U.aggregate(feed.base, 300);
  for (const b of agg5) assert.ok(b.h >= Math.max(b.o, b.c) && b.l <= Math.min(b.o, b.c));
  const total = feed.base.reduce((a, b) => a + b.v, 0);
  assert.equal(agg5.reduce((a, b) => a + b.v, 0), total);
});

test('addSessionVwap restarts at each session', () => {
  const S = 18 * 3600;
  const bars = [
    { t: et(2026, 9, 28, 16, 58), o: 10, h: 10, l: 10, c: 10, v: 100 },
    { t: et(2026, 9, 28, 18, 0), o: 20, h: 20, l: 20, c: 20, v: 1 },
    { t: et(2026, 9, 28, 18, 1), o: 30, h: 30, l: 30, c: 30, v: 1 },
  ];
  U.addSessionVwap(bars, S);
  assert.equal(bars[0].vw, 10);
  assert.equal(bars[1].vw, 20);
  assert.equal(bars[2].vw, 25);
});

test('sessionLevels finds prior-day, overnight and value-area levels', () => {
  const S = 18 * 3600, bars = [];
  const add = (t, o, h, l, c, v) => bars.push({ t, o, h, l, c, v });
  add(et(2026, 9, 28, 9, 30), 100, 110, 99, 105, 50);    // prior regular session (Mon)
  add(et(2026, 9, 28, 12, 0), 105, 106, 95, 100, 500);
  add(et(2026, 9, 28, 15, 59), 100, 102, 98, 101, 50);
  add(et(2026, 9, 28, 18, 0), 101, 104, 100, 103, 10);   // overnight for Tue
  add(et(2026, 9, 29, 3, 0), 103, 107, 96, 97, 10);
  add(et(2026, 9, 29, 9, 30), 97, 120, 90, 118, 99);     // today's regular session: not overnight
  const lv = U.sessionLevels(bars, { sessionStart: S, tick: 0.25 });
  assert.equal(lv.pdh, 110); assert.equal(lv.pdl, 95); assert.equal(lv.pc, 101);
  assert.equal(lv.onh, 107); assert.equal(lv.onl, 96);
  assert.ok(lv.val <= lv.poc && lv.poc <= lv.vah, JSON.stringify(lv));
  assert.ok(lv.val >= 95 && lv.vah <= 111, JSON.stringify(lv));
  const lines = U.levelLines(lv);
  assert.deepEqual(lines.map(l => l.name).filter(n => n !== 'PD POC'), ['PDH', 'PD VAH', 'ONH', 'Prior close', 'ONL', 'PD VAL', 'PDL']);
  const poc = lines.find(l => l.name === 'PD POC');
  assert.ok(poc && poc.price === lv.poc && poc.key === 'poc', 'the prior day POC is drawn and named');
  assert.deepEqual(poc.dash, U.PD_POC_DASH);
});

test('colors: tag text and legend text stay readable on the default candles', () => {
  const T = U.buildTheme();
  assert.equal(T.up, '#4B9CD3');
  assert.equal(T.down, '#6D28D9');
  assert.equal(U.readableOn('#4B9CD3'), '#080B10');
  assert.equal(U.readableOn('#6D28D9'), '#FFFFFF');
  assert.ok(U.contrast(T.upText, T.bg) >= 4.5);
  assert.ok(U.contrast(T.downText, T.bg) >= 4.5);
  assert.equal(U.rgba('#4B9CD3', 0.26), 'rgba(75,156,211,0.26)');
  assert.deepEqual(U.parseColor('rgba(1, 2, 3, 0.5)'), { r: 1, g: 2, b: 3, a: 0.5 });
  const custom = U.buildTheme({ up: '#FFFFFF', down: '#000000' });
  assert.equal(custom.upOnTag, '#080B10');
  assert.equal(custom.downOnTag, '#FFFFFF');
});

test('presets are well-formed', () => {
  assert.ok(CE.PRESETS.length >= 3);
  for (const p of CE.PRESETS) { assert.match(p.up, /^#[0-9A-F]{6}$/); assert.match(p.down, /^#[0-9A-F]{6}$/); }
  assert.deepEqual([CE.PRESETS[0].up, CE.PRESETS[0].down], [CE.DEFAULT_THEME.up, CE.DEFAULT_THEME.down]);
});

test('sample feed is seeded, and ticks keep bars consistent', () => {
  const a = SampleFeed.create(), b = SampleFeed.create();
  assert.equal(a.base.length, b.base.length);
  assert.deepEqual(a.base[a.base.length - 2], b.base[b.base.length - 2]);
  assert.equal(a.levels.length, 8, 'the seven levels and the prior day POC');
  assert.equal(a.trades.length, 4);
  let ticks = 0; a.onTick(() => ticks++);
  a.setSpeed(30);
  for (let now = 1; now < 60000; now += 16) a.step(now);
  assert.ok(ticks > 100, 'ticks: ' + ticks);
  for (const bar of a.base.slice(-50)) {
    assert.ok(bar.h >= Math.max(bar.o, bar.c) && bar.l <= Math.min(bar.o, bar.c));
    assert.ok(Math.abs(bar.c / 0.25 - Math.round(bar.c / 0.25)) < 1e-9);
  }
  for (let i = 1; i < a.base.length; i++) assert.ok(a.base[i].t > a.base[i - 1].t);
});

test('orderLabel: side, kind and the quantity still to fill; bracket legs read TGT and STP', () => {
  assert.equal(U.orderLabel({ side: 'buy', kind: 'limit', qty: 2, filled: 0 }), 'BUY LMT 2');
  assert.equal(U.orderLabel({ side: 'sell', kind: 'stop', qty: 3, filled: 1 }), 'SELL STP 2');
  assert.equal(U.orderLabel({ side: 'sell', kind: 'limit', qty: 1, role: 'target' }), 'SELL TGT 1');
  assert.equal(U.orderLabel({ side: 'buy', kind: 'stop', qty: 1, role: 'stop' }), 'BUY STP 1');
  assert.equal(U.orderLabel({ side: 'buy', kind: 'market', qty: 4 }), 'BUY MKT 4');
});

test('openPnl: points per contract by direction, dollars for the whole position', () => {
  assert.deepEqual(U.openPnl(2, 25410.25, 25413.75, 2), { points: 3.5, dollars: 14 });
  assert.deepEqual(U.openPnl(-3, 100, 101, 50), { points: -1, dollars: -150 });
  assert.deepEqual(U.openPnl(1, 100, 99, 0), { points: -1, dollars: null });   // no point value: points only
  assert.deepEqual(U.openPnl(0, 100, 99, 2), { points: 0, dollars: null });
});

test('fmtMoney and fmtSigned', () => {
  assert.equal(U.fmtMoney(14), '+$14.00');
  assert.equal(U.fmtMoney(0), '$0.00');
  assert.equal(U.fmtMoney(-1250.5), '-$1,250.50');
  assert.equal(U.fmtSigned(3.5, 2), '+3.50');
  assert.equal(U.fmtSigned(-0.25, 2), '-0.25');
  assert.equal(U.fmtSigned(0, 2), '0.00');
});
