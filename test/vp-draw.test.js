'use strict';
// Volume profile, drawing and RTH (unreleased, for 1.6.0): the RTH window (9:30:00.000 in, 16:00:00.000 out, DST
// dates, weekends and NYSE holidays), columns() cached by version, the bar geometry (profileRects: anchored to the
// right edge, VP_WIDTH at the POC, row heights, sub-pixel rows, the POC and value area kinds), the theme colors on
// every ground, and the chart itself on a stand-in canvas (drawn behind the candles and in front of the grid, only
// with the 'vp' layer, paths rebuilt once per change and not per frame).
const test = require('node:test');
const assert = require('node:assert/strict');
const CE = require('../src/chart-engine.js');
const BB = require('../live/bar-builder.js');
const { VolumeProfile } = CE;
const U = CE.util;

const et = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h, mi, s || 0) / 1000;   // New York wall clock stored as UTC

/* ---- RTH */
test('RTH: 9:30:00.000 counts, 9:29:59.999 does not; 15:59:59.999 counts, 16:00:00.000 does not', () => {
  const vp = new VolumeProfile({ rth: true });
  const day = (h, mi, s) => et(2026, 9, 29, h, mi, s);                     // Tuesday 29 Sep 2026
  vp.add(day(9, 29, 59.999), 100, 1);
  vp.add(day(9, 30, 0), 101, 2);
  vp.add(day(15, 59, 59.999), 102, 4);
  vp.add(day(16, 0, 0), 103, 8);
  vp.add(day(17, 0, 0), 104, 16);
  assert.equal(vp.total, 6);
  assert.deepEqual(vp.rows().map(r => [r.price, r.volume]).filter(r => r[1]), [[101, 2], [102, 4]]);
  assert.equal(vp.outside, 3);
  assert.equal(vp.skipped, 0, 'outside the window is not bad input');
  // the full-session profile takes all five
  const full = new VolumeProfile();
  for (const [t, p, v] of [[day(9, 29, 59.999), 100, 1], [day(9, 30, 0), 101, 2], [day(15, 59, 59.999), 102, 4], [day(16, 0, 0), 103, 8], [day(17, 0, 0), 104, 16]]) full.add(t, p, v);
  assert.equal(full.total, 31);
  assert.equal(full.rth, false);
});

test('RTH: the overnight of the same trading day is out, and the profile still empties at 18:00', () => {
  const vp = new VolumeProfile({ rth: true });
  vp.add(et(2026, 9, 28, 18, 0), 100, 5);                                  // Monday 18:00: Tuesday's session, overnight
  vp.add(et(2026, 9, 29, 3, 0), 100, 5);
  assert.equal(vp.total, 0);
  assert.equal(vp.day, U.tradeDay(et(2026, 9, 29, 10, 0), 18 * 3600), 'the session is Tuesday\'s');
  vp.add(et(2026, 9, 29, 10, 0), 101, 3);
  assert.equal(vp.total, 3);
  const v0 = vp.version;
  assert.equal(vp.add(et(2026, 9, 29, 16, 30), 102, 1), false);
  assert.equal(vp.version, v0, 'a trade outside the window does not change the version');
  assert.equal(vp.add(et(2026, 9, 29, 18, 0), 103, 1), true, 'the first trade of the next session starts it');
  assert.equal(vp.total, 0, 'and empties the RTH profile until 9:30');
  assert.ok(vp.version > v0);
});

test('RTH on DST dates: the window is New York wall clock (from UTC through zoneSeconds)', () => {
  // Friday 6 Mar 2026 (EST, UTC-5), Monday 9 Mar (EDT, UTC-4, the day after the change); Friday 30 Oct (EDT),
  // Monday 2 Nov (EST, the day after the change back)
  const days = [[2026, 3, 6, 5], [2026, 3, 9, 4], [2026, 10, 30, 4], [2026, 11, 2, 5]];
  for (const [y, mo, d, off] of days) {
    const utc = (h, mi, s) => Date.UTC(y, mo - 1, d, h + off, mi, 0) / 1000 + s;
    const vp = new VolumeProfile({ rth: true });
    const T = [utc(9, 29, 59.999), utc(9, 30, 0), utc(15, 59, 59.999), utc(16, 0, 0)].map(u => U.zoneSeconds(u));
    assert.equal(U.fmtHM(T[1]), '09:30', y + '-' + mo + '-' + d + ' 9:30 ET');
    T.forEach((t, i) => vp.add(t, 100 + i, 1));
    assert.deepEqual(vp.rows().filter(r => r.volume).map(r => r.price), [101, 102], y + '-' + mo + '-' + d);
    assert.equal(vp.outside, 2);
  }
});

test('RTH: nothing counts on a weekend or an NYSE holiday (the IB rule); early-close days count as usual', () => {
  const sat = new VolumeProfile({ rth: true });
  sat.add(et(2026, 10, 3, 11, 0), 100, 1);                                 // Saturday
  assert.equal(sat.total, 0);
  const labor = new VolumeProfile({ rth: true });
  labor.add(et(2026, 9, 7, 11, 0), 100, 1);                                // Labor Day 2026 (Globex trades, no 9:30 open)
  assert.equal(labor.total, 0);
  const blackFriday = new VolumeProfile({ rth: true });
  blackFriday.add(et(2026, 11, 27, 11, 0), 100, 1);                        // the day after Thanksgiving: an early close
  assert.equal(blackFriday.total, 1);
});

test('startOf(t): 18:00 the evening before for the session, 9:30 of the day for RTH', () => {
  const t = et(2026, 9, 29, 13, 0), eve = et(2026, 9, 29, 20, 0);
  assert.equal(new VolumeProfile().startOf(t), et(2026, 9, 28, 18, 0));
  assert.equal(new VolumeProfile({ rth: true }).startOf(t), et(2026, 9, 29, 9, 30));
  assert.equal(new VolumeProfile().startOf(eve), et(2026, 9, 29, 18, 0));
  assert.equal(new VolumeProfile({ rth: true }).startOf(eve), et(2026, 9, 30, 9, 30), 'after 18:00: the next day\'s 9:30');
});

test('RTH from the TickStore equals the session profile restricted by hand', () => {
  const store = new BB.TickStore();
  let p = 21000, s = 3;
  const rnd = () => (s = (s * 48271) % 2147483647) / 2147483647;
  for (let t = et(2026, 9, 28, 18, 0); t < et(2026, 9, 29, 17, 0); t += 7.3) { p += rnd() < 0.5 ? -0.25 : 0.25; store.push(t, p, 1 + Math.floor(rnd() * 4)); }
  const rth = new VolumeProfile({ rth: true }), hand = new VolumeProfile();
  store.feed(rth, 0);
  for (let i = 0; i < store.length; i++) { const [t, pr, v] = store.at(i); const x = U.tod(t); if (x >= 34200 && x < 57600) hand.add(t, pr, v); }
  assert.deepEqual(rth.rows(), hand.rows());
  assert.deepEqual(rth.valueArea(), hand.valueArea());
  assert.equal(rth.total + [...Array(store.length).keys()].filter(i => { const x = U.tod(store.time(i)); return x < 34200 || x >= 57600; }).reduce((a, i) => a + store.volume(i), 0),
    [...Array(store.length).keys()].reduce((a, i) => a + store.volume(i), 0));
});

/* ---- columns() */
test('columns(): rows from the lowest up, max, POC and value area as indexes; cached by version', () => {
  const vp = new VolumeProfile();
  const T0 = et(2026, 9, 29, 10, 0);
  [[100, 10], [100.25, 20], [100.5, 30], [100.75, 50], [101.25, 5]].forEach(([p, v], i) => vp.add(T0 + i, p, v));
  const c = vp.columns();
  assert.equal(c.low, 100); assert.equal(c.step, 0.25); assert.equal(c.tick, 0.25);
  assert.deepEqual([...c.volumes], [10, 20, 30, 50, 0, 5]);
  assert.equal(c.max, 50);
  assert.equal(c.poc, 3);
  const va = vp.valueArea();
  assert.equal(c.low + c.vaLow * c.step, va.val); assert.equal(c.low + c.vaHigh * c.step, va.vah);
  assert.equal(vp.columns(), c, 'same object until the profile changes');
  vp.add(T0 + 9, 100, 1);
  assert.notEqual(vp.columns(), c);
  assert.equal(vp.columns().volumes[0], 11);
  assert.equal(c.volumes[0], 10, 'a copy: an old snapshot does not change');
  assert.equal(new VolumeProfile().columns(), null);
  // grouped rows: step is rowTicks ticks
  const g = new VolumeProfile({ rowTicks: 4 });
  g.add(T0, 100.75, 1); g.add(T0 + 1, 101, 2);
  assert.deepEqual([g.columns().low, g.columns().step, [...g.columns().volumes]], [100, 1, [1, 2]]);
});

/* ---- geometry */
function rectsOf(cols, view) {
  const out = [];
  const n = U.profileRects(cols, view, (kind, x, y, w, h) => out.push({ kind, x, y, w, h }));
  assert.equal(n, out.length);
  return out;
}
const flat = { plotW: 1000, plotH: 400, dpr: 1 };

test('geometry: bars end at the right edge, the POC is VP_WIDTH of the plot wide, the rest in proportion', () => {
  const c = { low: 100, step: 0.25, tick: 0.25, volumes: Float64Array.from([10, 20, 40, 20, 5]), max: 40, poc: 2, vaLow: 1, vaHigh: 3 };
  // 100 px per point: a 1-tick row is 25 px tall
  const R = rectsOf(c, Object.assign({ lo: 99, hi: 103 }, flat));
  assert.equal(CE.VP_WIDTH, 0.25);
  assert.equal(R.length, 5);
  for (const r of R) assert.equal(r.x + r.w, 1000, 'anchored to the right edge');
  assert.deepEqual(R.map(r => r.w), [31, 125, 250, 125, 63], 'top row first (101), widths by volume, the POC at 25% of 1000');
  assert.deepEqual(R.map(r => r.kind), [0, 1, 2, 1, 0]);
  // row 100.50 (the POC) covers 100.375 to 100.625: y = (103 - 100.625) * 100 = 237.5 -> 238 to 262.5 -> 263, less a 1 px gap
  const poc = R[2];
  assert.deepEqual([poc.y, poc.h], [238, 24]);
  for (let i = 1; i < R.length; i++) assert.equal(R[i].y, R[i - 1].y + R[i - 1].h + 1, 'rows touch but for a 1 px gap');
  // a custom width share and device pixels
  const R2 = rectsOf(c, { lo: 99, hi: 103, plotW: 1000, plotH: 400, dpr: 2, width: 0.1 });
  assert.equal(R2[2].w, 200); assert.equal(R2[2].x + R2[2].w, 2000);
  assert.deepEqual([R2[2].y, R2[2].h], [475, 49]);
});

test('geometry: rows of a pixel or less share it, taking the largest volume and the strongest kind', () => {
  const vol = new Float64Array(400);
  for (let i = 0; i < 400; i++) vol[i] = 1 + (i % 7);
  vol[123] = 100;                                                         // the POC, a lone spike
  const c = { low: 1000, step: 0.25, tick: 0.25, volumes: vol, max: 100, poc: 123, vaLow: 100, vaHigh: 200 };
  // 100 points on 400 px: 1 px a tick
  const R = rectsOf(c, Object.assign({ lo: 1000, hi: 1100 }, flat));
  assert.ok(R.length <= 400 && R.length > 350);
  const poc = R.filter(r => r.kind === 2);
  assert.equal(poc.length, 1, 'the POC shows');
  assert.equal(poc[0].w, 250);
  // 100 points on 40 px: 10 ticks to a pixel; each pixel bar is as long as its largest row
  const S = rectsOf(c, { lo: 1000, hi: 1100, plotW: 1000, plotH: 40, dpr: 1 });
  assert.ok(S.length <= 41, 'about one bar per pixel row: ' + S.length);
  for (let i = 1; i < S.length; i++) assert.ok(S[i].y >= S[i - 1].y + S[i - 1].h, 'no overlap');
  assert.equal(S.filter(r => r.kind === 2).length, 1);
  assert.equal(S.find(r => r.kind === 2).w, 250);
  assert.ok(S.some(r => r.kind === 1) && S.some(r => r.kind === 0));
});

test('geometry: only rows in view, none for volume 0, nothing for an empty or flat view', () => {
  const vol = new Float64Array(1000).fill(3); vol[10] = 0; vol[500] = 9;
  const c = { low: 100, step: 0.25, tick: 0.25, volumes: vol, max: 9, poc: 500, vaLow: 400, vaHigh: 600 };
  let visits = 0;
  const count = U.profileRects(c, Object.assign({ lo: 200, hi: 210 }, flat), () => visits++);
  assert.ok(count >= 41 && count <= 43, 'the 41 rows from 200 to 210, and one past each edge: ' + count);
  assert.equal(visits, count);
  // 400 px for 3 points: the row at 102.50 (volume 0) would be at y 200
  const lowRows = rectsOf(c, Object.assign({ lo: 101, hi: 104 }, flat));
  assert.ok(lowRows.length >= 12 && !lowRows.some(r => r.y <= 200 && r.y + r.h >= 200), 'the row at 102.50 (volume 0) draws nothing');
  assert.equal(U.profileRects(null, Object.assign({ lo: 0, hi: 1 }, flat), () => {}), 0);
  assert.equal(U.profileRects(c, Object.assign({ lo: 5, hi: 5 }, flat), () => {}), 0);
  assert.equal(rectsOf(c, Object.assign({ lo: 500, hi: 600 }, flat)).length, 0, 'the profile below the view');
});

/* ---- colors */
test('theme: on the default ground the profile colors are the chosen ones; on every ground rows are tints and the POC reads', () => {
  const D = U.buildTheme();
  assert.deepEqual([D.vpRow, D.vpValue, D.vpPoc], [CE.DEFAULT_THEME.vpRow, CE.DEFAULT_THEME.vpValue, CE.DEFAULT_THEME.vpPoc]);
  assert.equal(D.vpPoc, CE.LEVEL_COLORS.value, 'the POC in the value-level gold');
  const grounds = CE.BACKGROUNDS.map(b => b.bg).concat(['#FFFFFF', '#777777', '#B0102A', '#123456', '#E8E0C8']);
  for (const bg of grounds) {
    const T = U.buildTheme({ bg });
    const rest = U.contrast(T.vpRow, bg), va = U.contrast(T.vpValue, bg);
    assert.ok(rest > 1.05 && rest < 1.3, bg + ' rest rows a tint of the ground: ' + rest.toFixed(2));
    assert.ok(va > rest * 1.1, bg + ' value area a step stronger than the rest: ' + va.toFixed(2) + ' over ' + rest.toFixed(2));
    assert.ok(U.contrast(T.vpPoc, T.vpValue) >= CE.FLOOR.line - 0.02 || U.contrast(T.vpPoc, T.vpValue) >= Math.max(U.contrast('#FFFFFF', T.vpValue), U.contrast('#000000', T.vpValue)) - 0.02,
      bg + ' POC reads on the value-area rows: ' + U.contrast(T.vpPoc, T.vpValue).toFixed(2));
    // text moves the theme's way (T.to), so on a mid-grey it reads at what that end allows, like the axis text
    assert.ok(U.contrast(T.vpPocText, bg) >= Math.min(4.5, U.contrast(T.to, bg)) - 0.02, bg + ' legend POC text reads: ' + U.contrast(T.vpPocText, bg).toFixed(2));
    assert.ok(U.contrast(T.up, T.vpValue) >= 1.8 && U.contrast(T.down, T.vpValue) >= 1.5 || T.ground !== 'default', bg + ' candles still show on the value area');
  }
  assert.ok(U.contrast(D.down, D.vpValue) >= 1.95 && U.contrast(D.up, D.vpValue) >= 4.5, 'default ground: bear candles about 2:1 on the value area, bull 4.5:1');
});

/* ---- the chart on a stand-in canvas */
function stubChart() {
  const ops = [];
  class Path2D { constructor() { this.rects = []; } rect(x, y, w, h) { this.rects.push([x, y, w, h]); } moveTo() {} lineTo() {} closePath() {} arc() {} }
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return s => ({ width: String(s).length * 7 });
      if (k === 'fill') return p => ops.push({ op: 'fill', color: t.fillStyle, path: p });
      if (k === 'fillRect') return (x, y, w, h) => ops.push({ op: 'rect', color: t.fillStyle, r: [x, y, w, h], transform: t.__tf });
      if (k === 'setTransform') return (a, b, c, d, e, f) => { t.__tf = a; };
      if (k === 'stroke') return () => ops.push({ op: 'stroke', color: t.strokeStyle });
      if (k === 'fillText') return s => ops.push({ op: 'text', s: String(s) });
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  const element = () => ({
    handlers: {}, style: {}, dataset: {}, hidden: false, textContent: '', tabIndex: -1,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, fn) { this.handlers[type] = fn; }, removeEventListener(type) { delete this.handlers[type]; },
    appendChild(c) { return c; }, remove() {}, setAttribute() {}, hasAttribute() { return false; },
    getContext: () => ctx, focus() {}, setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1078, height: 626, right: 1078, bottom: 626 }),
  });
  let frameFn = null;
  global.document = { createElement: element, getElementById: () => null, head: { appendChild() {} } };
  global.window = { devicePixelRatio: 1 };
  global.requestAnimationFrame = fn => { frameFn = fn; return 1; };
  global.cancelAnimationFrame = () => { frameFn = null; };
  global.Path2D = Path2D;
  delete require.cache[require.resolve('../src/chart-engine.js')];
  const E = require('../src/chart-engine.js');
  const bars = [];
  const T0 = et(2026, 9, 29, 10, 0);
  for (let i = 0; i < 200; i++) { const c = 100 + Math.sin(i / 9) * 2; bars.push({ t: T0 + i * 60, o: c - 0.5, h: c + 1, l: c - 1, c, v: 100, vw: c }); }
  const chart = E.create(element(), { clock: () => bars[bars.length - 1].t + 30 });
  chart.setBars(bars);
  let ts = 1000;
  return { E, chart, ops, bars, T0, frame() { ops.length = 0; const f = frameFn; frameFn = null; if (f) f(ts += 16); } };
}

test('chart: the profile draws only with the vp layer, off by default, at the right edge, behind the candles and in front of the grid', () => {
  const { E, chart, ops, T0, frame } = stubChart();
  assert.equal(chart.getLayers().vp, false, 'off by default');
  const vp = new E.VolumeProfile();
  for (let i = 0; i < 400; i++) vp.add(T0 + i, 98 + (i % 17) * 0.25, 1 + (i % 5 === 0 ? 20 : 0));
  chart.setProfile(vp);
  assert.equal(chart.getProfile(), vp);
  frame();
  const T = chart.colors();
  const vpRects = () => ops.filter(o => o.op === 'rect' && [T.vpRow, T.vpValue, T.vpPoc].includes(o.color));
  assert.equal(vpRects().length, 0, 'layer off: nothing drawn');
  chart.setLayers({ vp: true }); frame();
  const rects = vpRects();
  assert.deepEqual([...new Set(rects.map(f => f.color))], [T.vpRow, T.vpValue, T.vpPoc], 'rest, value area, POC, in that order');
  assert.ok(rects.every(r => r.transform === 1), 'in device pixels');
  const all = rects.map(f => f.r);
  const plotW = 1078 - 78;
  assert.ok(all.length > 5);
  for (const [x, , w] of all) assert.equal(x + w, plotW, 'every bar ends at the plot\'s right edge');
  assert.equal(Math.max(...all.map(r => r[2])), plotW * E.VP_WIDTH, 'the POC is VP_WIDTH of the plot wide');
  const pocY = chart.priceToY(vp.poc().price), pocRect = rects.find(r => r.color === T.vpPoc).r;
  assert.ok(pocRect[1] <= pocY + 0.5 && pocRect[1] + pocRect[3] >= pocY - 0.5, 'the POC bar at the POC price');
  // order: grid strokes before, candle fills after
  const idx = ops.indexOf(rects[0]);
  const gridIdx = ops.findIndex(o => o.op === 'stroke' && o.color === T.grid);
  const candleIdx = ops.findIndex((o, i) => i > idx && o.op === 'fill' && (o.color === T.up || o.color === T.down));
  assert.ok(gridIdx >= 0 && gridIdx < idx, 'after the grid');
  assert.ok(candleIdx > idx, 'before the candles');
  const volIdx = ops.findIndex(o => o.op === 'fill' && (o.color === T.upVol || o.color === T.downVol));
  assert.ok(volIdx > idx, 'before the volume bars');
});

test('chart: bars are rebuilt once per change of the profile or the view, never per frame; a trade redraws on its own', () => {
  const { E, chart, T0, frame } = stubChart();
  const vp = new E.VolumeProfile();
  for (let i = 0; i < 50; i++) vp.add(T0 + i, 99 + (i % 9) * 0.25, 2);
  chart.setLayers({ vp: true }); chart.setProfile(vp);
  for (let i = 0; i < 60; i++) frame();                                   // let the view settle
  const n0 = chart.stats().profileBuilds;
  let cols = 0; const orig = vp.columns.bind(vp);
  vp.columns = () => { cols++; return orig(); };
  for (let i = 0; i < 30; i++) { chart.setLayers({}); frame(); }          // redraws with nothing new
  assert.equal(chart.stats().profileBuilds, n0, 'no rebuild when nothing changed');
  assert.equal(cols, 0, 'columns() not asked for again');
  vp.add(T0 + 100, 99.5, 5);                                               // only the profile changes: the chart notices
  frame();
  assert.equal(chart.stats().profileBuilds, n0 + 1, 'one rebuild for the new trade');
  assert.equal(cols, 1);
  frame(); frame();
  assert.equal(chart.stats().profileBuilds, n0 + 1);
  chart.setProfile(null); frame();
  assert.equal(chart.getProfile(), null);
});

test('chart: on a light ground the profile uses the ground-derived colors', () => {
  const { E, chart, ops, T0, frame } = stubChart();
  const vp = new E.VolumeProfile();
  for (let i = 0; i < 50; i++) vp.add(T0 + i, 99 + (i % 9) * 0.25, 1 + (i % 4));
  chart.setLayers({ vp: true }); chart.setProfile(vp);
  chart.setTheme({ bg: '#F5F7FA' }); frame();
  const T = chart.colors();
  assert.notEqual(T.vpRow, E.DEFAULT_THEME.vpRow);
  assert.ok(U.luminance(T.vpRow) < U.luminance('#F5F7FA') && U.luminance(T.vpValue) < U.luminance(T.vpRow), 'darker tints on a light ground');
  const colors = [...new Set(ops.filter(o => o.op === 'rect' && [T.vpRow, T.vpValue, T.vpPoc].includes(o.color)).map(o => o.color))];
  assert.deepEqual(colors, [T.vpRow, T.vpValue, T.vpPoc]);
});
