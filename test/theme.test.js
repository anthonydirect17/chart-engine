'use strict';
// The chart background (1.5.3): the default ground keeps the locked palette to the letter, and every other ground
// (the presets, a sweep of random colors, the extremes) keeps text, lines, candles, levels and marks readable.
// The theme is built once per change, never per frame.
const test = require('node:test');
const assert = require('node:assert/strict');
const CE = require('../src/chart-engine.js');
const U = CE.util, F = CE.FLOOR;

/* buildTheme() of 1.5.2, key for key (fonts aside): the look Anthony locked. */
const LOCKED = {"bg":"#080B10","rth":"#0B1016","grid":"rgba(42,54,69,0.30)","axisLine":"#18212C","divider":"#2A3645","cross":"#5B6B80","axisText":"#8392A5","axisTextStrong":"#E6EDF5","tagFill":"#141C26","tagBorder":"#2A3645","tagText":"#F2F6FA","up":"#4B9CD3","down":"#6D28D9","volumeAlpha":0.26,"vwap":"#B69CFF","long":"#3DDC97","short":"#FF7A7A","profit":"#3DDC97","loss":"#FF7A7A","exit":"#F2F6FA","live":"#F2F6FA","drawing":"#D8CCFF","upVol":"rgba(75,156,211,0.26)","downVol":"rgba(109,40,217,0.26)","upOnTag":"#080B10","downOnTag":"#FFFFFF","upText":"#4B9CD3","downText":"#925EE3","vwapText":"#B69CFF"};

test('the default ground is exactly the locked palette (and the legend colors the page had)', () => {
  for (const T of [U.buildTheme(), U.buildTheme({ bg: '#080b10' }), U.buildTheme({ bg: CE.BACKGROUNDS[0].bg })]) {
    for (const k in LOCKED) if (k !== 'bg') assert.equal(T[k], LOCKED[k], k);
    assert.equal(T.bg.toUpperCase(), LOCKED.bg);
    assert.equal(T.ground, 'default');
    assert.equal(T.text2, '#9AA8B8');
    assert.equal(T.legendBg, 'rgba(8,11,16,0.78)');
  }
  // candle presets on the default ground: only the candle colors and what follows from them change
  for (const p of CE.PRESETS) {
    const T = U.buildTheme({ up: p.up, down: p.down });
    assert.equal(T.up, p.up); assert.equal(T.down, p.down); assert.equal(T.axisText, LOCKED.axisText);
  }
});

test('background presets: the current dark (default), pure black, dark blue-grey and a light one', () => {
  assert.deepEqual(CE.BACKGROUNDS.map(b => b.id), ['dark', 'black', 'slate', 'light']);
  assert.equal(CE.BACKGROUNDS[0].bg, CE.DEFAULT_THEME.bg);
  assert.equal(CE.BACKGROUNDS[1].bg, '#000000');
  for (const b of CE.BACKGROUNDS) assert.match(b.bg, /^#[0-9A-F]{6}$/);
  assert.equal(U.buildTheme({ bg: '#000000' }).ground, 'dark');
  assert.equal(U.buildTheme({ bg: '#1B2433' }).ground, 'dark');
  assert.equal(U.buildTheme({ bg: '#F5F7FA' }).ground, 'light');
});

/* A color with alpha as it shows over the ground. */
function over(color, bg) {
  const c = U.parseColor(color), g = U.parseColor(bg);
  return c.a === 1 ? color : '#' + ['r', 'g', 'b'].map(k => Math.round(c[k] * c.a + g[k] * (1 - c.a)).toString(16).padStart(2, '0')).join('');
}
/* Every role at its floor, or at the best white or black can do on this ground (a mid-grey caps text near 4.5).
   0.02 of slack: legible() rounds the color it finds to whole RGB steps. */
function readable(bg, extra) {
  const T = U.buildTheme(Object.assign({ bg }, extra || {}));
  const pole = U.readableOn(bg) === '#FFFFFF' ? '#FFFFFF' : '#000000';
  const best = U.contrast(pole, bg);
  const need = (color, on, floor, what) => {
    const c = U.contrast(over(color, on), on), want = Math.min(floor, best) - 0.02;
    assert.ok(c >= want, bg + ' ' + what + ' ' + color + ' reads ' + c.toFixed(2) + ' < ' + want.toFixed(2));
  };
  need(T.axisText, bg, F.text, 'axis text');
  need(T.axisTextStrong, bg, F.strong, 'day labels');
  need(T.text2, bg, F.text, 'legend text');
  need(T.tagText, T.tagFill, Math.min(F.strong, U.contrast(pole, T.tagFill)), 'crosshair tag text');
  need(T.cross, bg, F.cross, 'crosshair');
  need(T.divider, bg, F.divider, 'session divider');
  need(T.tagBorder, bg, F.divider, 'tag border');
  if (T.ground !== 'default') need(T.grid, bg, F.grid, 'grid');      // the default grid is the locked hairline
  else assert.ok(U.contrast(over(T.grid, bg), bg) > 1.05);
  need(T.up, bg, F.candle, 'bull candle'); need(T.down, bg, F.candle, 'bear candle');
  need(T.upText, bg, F.text, 'bull text'); need(T.downText, bg, F.text, 'bear text');
  need(T.vwap, bg, F.line, 'VWAP line'); need(T.vwapText, bg, F.text, 'VWAP text');
  need(T.drawing, bg, F.line, 'drawings');
  for (const k of ['long', 'short', 'profit', 'loss', 'exit', 'live']) need(T[k], bg, F.text, k);
  for (const k in CE.LEVEL_COLORS) need(U.onGround(CE.LEVEL_COLORS[k], bg, F.text, T.to), bg, F.text, 'level ' + k);
  // the last price tag: dark or white text on the candle color
  assert.ok(U.contrast(T.upOnTag, T.up) >= 3 && U.contrast(T.downOnTag, T.down) >= 3, bg + ' last price tag text');
  // the grid and the regular-hours ground stay subtle (a hairline, not a bar)
  assert.ok(U.contrast(over(T.grid, bg), bg) < 1.6 && U.contrast(T.rth, bg) < 1.2, bg + ' grid and RTH ground stay subtle');
  return T;
}

test('presets: every role readable on black, blue-grey and light', () => {
  for (const b of CE.BACKGROUNDS) readable(b.bg);
  for (const b of CE.BACKGROUNDS) for (const p of CE.PRESETS) readable(b.bg, { up: p.up, down: p.down });
});

test('extremes: white, mid-greys, pure black and saturated colors', () => {
  for (const bg of ['#FFFFFF', '#000000', '#777777', '#767676', '#808080', '#7F7F7F', '#959595', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#00FFFF', '#FF00FF', '#4B9CD3', '#6D28D9', '#3DDC97'])
    readable(bg);
  // a ground the same color as the candles: the candles move off it
  const T = U.buildTheme({ bg: '#4B9CD3', up: '#4B9CD3' });
  assert.ok(U.contrast(T.up, '#4B9CD3') >= F.candle);
});

test('a sweep of 2,000 random grounds (seeded): every role readable', () => {
  let s = 20260929;
  const rnd = () => (s = (s * 48271) % 2147483647) / 2147483647;
  const hex = () => '#' + [0, 0, 0].map(() => Math.floor(rnd() * 256).toString(16).padStart(2, '0')).join('').toUpperCase();
  for (let i = 0; i < 2000; i++) readable(hex(), i % 3 ? null : { up: hex(), down: hex(), vwap: hex() });
});

test('legible lightens on dark grounds (as before) and darkens on light ones', () => {
  assert.equal(U.legible('#6D28D9', '#080B10'), '#925EE3');
  const onLight = U.legible('#3DDC97', '#FFFFFF');
  assert.ok(U.contrast(onLight, '#FFFFFF') >= 4.5);
  assert.ok(U.luminance(onLight) < U.luminance('#3DDC97'), 'darker, not lighter');
  assert.equal(U.onGround('#3DDC97', '#080B10', 4.5), '#3DDC97', 'kept when it already reads');
  assert.equal(U.mix('#000000', '#FFFFFF', 0.5), '#808080');
});

test('buildTheme leaves its input alone, and chosen colors stay chosen (getTheme) while the drawn ones move', () => {
  const input = { bg: '#FFFFFF', up: '#3DDC97' };
  const T = U.buildTheme(input);
  assert.deepEqual(input, { bg: '#FFFFFF', up: '#3DDC97' });
  assert.notEqual(T.up, '#3DDC97');
  // back on the default ground the chosen color comes back unchanged (no drift from one ground to the next)
  assert.equal(U.buildTheme({ bg: CE.DEFAULT_THEME.bg, up: '#3DDC97' }).up, '#3DDC97');
});

/* ---- the chart itself, on a stand-in canvas (as test/perf.test.js) */
function stubChart(opts) {
  const texts = [];
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return s => ({ width: String(s).length * 7 });
      if (k === 'fillText') return (s, x, y) => texts.push({ s: String(s), color: t.fillStyle, font: t.font });
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
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1400, height: 800, right: 1400, bottom: 800 }),
  });
  let frameFn = null;
  global.document = { createElement: element, getElementById: () => null, head: { appendChild() {} } };
  global.window = { devicePixelRatio: 1 };
  global.requestAnimationFrame = fn => { frameFn = fn; return 1; };
  global.cancelAnimationFrame = () => { frameFn = null; };
  global.Path2D = class { moveTo() {} lineTo() {} rect() {} closePath() {} arc() {} };
  delete require.cache[require.resolve('../src/chart-engine.js')];
  const E = require('../src/chart-engine.js');
  const bars = [];
  for (let i = 0; i < 300; i++) { const c = 100 + Math.sin(i / 9) * 5; bars.push({ t: 1790000000 + i * 60, o: c - 0.5, h: c + 1, l: c - 1, c, v: 100, vw: c }); }
  const chart = E.create(element(), Object.assign({ clock: () => bars[bars.length - 1].t + 30 }, opts || {}));
  chart.setBars(bars);
  let ts = 1000;
  return { E, chart, texts, frame() { texts.length = 0; const f = frameFn; frameFn = null; f(ts += 16); } };
}

test('chart: IB lines show with their own layer, not with Levels, and are shaded on a light ground', () => {
  const { E, chart, texts, frame } = stubChart();
  const lv = [{ name: 'PDH', price: 104, color: E.LEVEL_COLORS.prior, dash: [6, 4] }];
  const ib = E.util.ibLines({ state: 'forming', high: 102, low: 98 });
  chart.setLevels(lv.concat(ib));
  frame();
  const names = () => texts.map(x => x.s).filter(s => /PDH|IB/.test(s));
  assert.deepEqual(names().sort(), ['IBH (forming)', 'IBL (forming)', 'PDH']);
  chart.setLayers({ levels: false }); frame();
  assert.deepEqual(names().sort(), ['IBH (forming)', 'IBL (forming)'], 'Levels off keeps the IB');
  chart.setLayers({ levels: true, ib: false }); frame();
  assert.deepEqual(names(), ['PDH'], 'IB off keeps the levels');
  chart.setLayers({ ib: true });
  const ibColor = () => texts.find(x => x.s === 'IBH (forming)').color;
  frame();
  assert.equal(ibColor(), E.LEVEL_COLORS.ib, 'default ground: the level color as is');
  chart.setTheme({ bg: '#FFFFFF' }); frame();
  assert.ok(E.util.contrast(ibColor(), '#FFFFFF') >= 4.5, 'light ground: the IB name reads: ' + ibColor());
  assert.equal(chart.getLevels().find(l => l.name === 'IBH (forming)').color, E.LEVEL_COLORS.ib, 'the level itself keeps its color');
  assert.equal(chart.getTheme().bg, '#FFFFFF');
});

test('chart: the theme is built once per change, never per frame', () => {
  const { chart, frame } = stubChart();
  const n0 = chart.stats().themeBuilds;
  chart.setTheme({ bg: '#F5F7FA' });
  for (let i = 0; i < 120; i++) { chart.update(Object.assign({}, chart.bars()[chart.bars().length - 1], { c: 100 + (i % 7) * 0.25 })); frame(); }
  assert.equal(chart.stats().themeBuilds, n0 + 1);
  chart.setTheme({ bg: '#000000' }); chart.setTheme({ up: '#FFFFFF' });
  for (let i = 0; i < 30; i++) frame();
  assert.equal(chart.stats().themeBuilds, n0 + 3);
});

test('chart: every text drawn on a light ground reads on it (axis labels, level names, tags)', () => {
  const { E, chart, texts, frame } = stubChart();
  chart.setLevels(E.util.levelLines({ pdh: 104, pdl: 96, pc: 100.5, onh: 103, onl: 97, vah: 102.5, val: 97.5 }).concat(E.util.ibLines({ state: 'locked', high: 101.5, low: 98.5 })));
  for (const bg of ['#F5F7FA', '#FFFFFF', '#000000', '#1B2433', '#777777', '#FF0000']) {
    chart.setTheme({ bg }); frame();
    const T = chart.colors();
    const pole = U.readableOn(bg) === '#FFFFFF' ? '#FFFFFF' : '#000000', best = U.contrast(pole, bg) - 0.01;
    const last = chart.bars()[chart.bars().length - 1];
    const drawnOnGround = texts.filter(x => x.s !== U.fmtPrice(last.c, 2) && !/^\d+:\d\d$/.test(x.s));   // not the last price tag and its countdown
    assert.ok(drawnOnGround.length > 10, 'texts drawn on ' + bg);
    for (const x of drawnOnGround) assert.ok(U.contrast(x.color, bg) >= Math.min(4.5, best) - 0.02, bg + ': "' + x.s + '" in ' + x.color + ' reads ' + U.contrast(x.color, bg).toFixed(2));
  }
});
