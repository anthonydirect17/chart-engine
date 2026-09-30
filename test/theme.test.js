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

/* Pairs a trader must tell apart stay apart (review S1): bull and bear, buy and sell, profit and loss when they were
   apart to begin with, and the IB high always the brighter of its pair, by a visible step. */
function apart(bg, T, extra, ib) {
  const src = Object.assign({}, CE.DEFAULT_THEME, extra || {});
  for (const [a, b] of [['up', 'down'], ['profit', 'loss']]) {
    if (!U.distinct(src[a], src[b])) continue;
    assert.ok(U.distinct(T[a], T[b]), bg + ' ' + a + ' ' + T[a] + ' and ' + b + ' ' + T[b] + ' merge (contrast ' + U.contrast(T[a], T[b]).toFixed(2) + ')');
  }
  assert.ok(U.luminance(ib[0]) > U.luminance(ib[1]) && U.contrast(ib[0], ib[1]) >= CE.PAIR.contrast - 0.01, bg + ' IB high ' + ib[0] + ' not brighter than low ' + ib[1]);
}
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
  const best = U.contrast(pole, bg);                                    // neutrals and text move toward this end
  const cw = U.contrast('#FFFFFF', bg), cb = U.contrast('#000000', bg), bestAny = Math.max(cw, cb);
  const need = (color, on, floor, what, cap) => {
    const c = U.contrast(over(color, on), on), want = Math.min(floor, cap === undefined ? best : cap) - 0.02;
    assert.ok(c >= want, bg + ' ' + what + ' ' + color + ' reads ' + c.toFixed(2) + ' < ' + want.toFixed(2));
  };
  // a colored mark moves whichever way reads sooner; a pair (buy and sell, bull and bear, IB high and low) that
  // would merge on a mid-grey ground splits toward white and black, each then reading at least min(floor, 3.5)
  const mark = floor => Math.min(floor, bestAny);
  const pair = floor => Math.min(cw, cb) >= floor ? floor : Math.min(floor, CE.PAIR.split, bestAny);
  need(T.axisText, bg, F.text, 'axis text');
  need(T.axisTextStrong, bg, F.strong, 'day labels');
  need(T.text2, bg, F.text, 'legend text');
  need(T.tagText, T.tagFill, Math.min(F.strong, U.contrast(pole, T.tagFill)), 'crosshair tag text');
  need(T.cross, bg, F.cross, 'crosshair');
  need(T.divider, bg, F.divider, 'session divider');
  need(T.tagBorder, bg, F.divider, 'tag border');
  if (T.ground !== 'default') need(T.grid, bg, F.grid, 'grid');      // the default grid is the locked hairline
  else assert.ok(U.contrast(over(T.grid, bg), bg) > 1.05);
  need(T.up, bg, F.candle, 'bull candle', pair(F.candle)); need(T.down, bg, F.candle, 'bear candle', pair(F.candle));
  need(T.upText, bg, F.text, 'bull text'); need(T.downText, bg, F.text, 'bear text');
  need(T.vwap, bg, F.line, 'VWAP line', mark(F.line)); need(T.vwapText, bg, F.text, 'VWAP text');
  need(T.drawing, bg, F.line, 'drawings', mark(F.line));
  for (const k of ['profit', 'loss']) need(T[k], bg, F.text, k, pair(F.text));
  // buy / long and sell / short keep their chosen color on every ground (review 2, S1); a mark that does not read
  // at 3:1 gets an outline, text under 4.5:1 a halo, in whichever house ink stands out more from the ground
  for (const k of ['long', 'short']) {
    assert.equal(T[k], (extra && extra[k]) || CE.DEFAULT_THEME[k], bg + ' ' + k + ' keeps its color');
    const c = U.contrast(T[k], bg);
    assert.ok(c >= F.line || (T.ring[k] && U.contrast(T.ring[k], bg) >= 3), bg + ' ' + k + ' mark: fill ' + c.toFixed(2) + ', outline ' + T.ring[k]);
    assert.ok(c >= F.text || (T.halo[k] && U.contrast(T.halo[k], bg) >= 3.9), bg + ' ' + k + ' text: ' + c.toFixed(2) + ', halo ' + T.halo[k]);
    if (T.ground === 'default') assert.equal(T.ring[k], null, 'the default ground draws the marks as 1.5.2');
  }
  for (const k of ['exit', 'live']) need(T[k], bg, F.text, k);
  for (const k of ['prior', 'overnight', 'value', 'close']) need(U.markOnGround(CE.LEVEL_COLORS[k], bg, F.text, T.to), bg, F.text, 'level ' + k, mark(F.text));
  const ib = T.ground === 'default' ? [CE.LEVEL_COLORS.ibHigh, CE.LEVEL_COLORS.ibLow] : U.pairOnGround(CE.LEVEL_COLORS.ibHigh, CE.LEVEL_COLORS.ibLow, bg, F.text, T.to, true);
  need(ib[0], bg, F.text, 'IB high', pair(F.text)); need(ib[1], bg, F.text, 'IB low', pair(F.text));
  apart(bg, T, extra, ib);
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

test('the IB pair on the presets: the high the lighter, at least 1.5:1 apart (review 2)', () => {
  for (const b of CE.BACKGROUNDS) {
    const T = U.buildTheme({ bg: b.bg });
    const [hi, lo] = T.ground === 'default' ? [CE.LEVEL_COLORS.ibHigh, CE.LEVEL_COLORS.ibLow] : U.pairOnGround(CE.LEVEL_COLORS.ibHigh, CE.LEVEL_COLORS.ibLow, b.bg, F.text, T.to, true);
    assert.ok(U.luminance(hi) > U.luminance(lo) && U.contrast(hi, lo) >= 1.5, b.name + ': ' + hi + ' / ' + lo + ' at ' + U.contrast(hi, lo).toFixed(2));
    assert.ok(U.contrast(hi, b.bg) >= 4.5 && U.contrast(lo, b.bg) >= 4.5, b.name + ': both read');
  }
});

test('extremes: white, mid-greys, pure black and saturated colors', () => {
  for (const bg of ['#FFFFFF', '#000000', '#777777', '#767676', '#808080', '#7F7F7F', '#959595', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#00FFFF', '#FF00FF', '#4B9CD3', '#6D28D9', '#3DDC97'])
    readable(bg);
  // a ground the same color as the candles: the candles move off it
  const T = U.buildTheme({ bg: '#4B9CD3', up: '#4B9CD3' });
  assert.ok(U.contrast(T.up, '#4B9CD3') >= F.candle);
});

test('all 256 greys: every role readable, and buy/sell, bull/bear and the IB pair stay apart (review S1)', () => {
  for (let v = 0; v < 256; v++) { const h = v.toString(16).padStart(2, '0').toUpperCase(); readable('#' + h + h + h); }
  // the smoke's own mid-grey: buy and sell are now told apart by lightness
  const T = U.buildTheme({ bg: '#767676' });
  assert.ok(T.long === '#3DDC97' && T.short === '#FF7A7A' && U.distinct(T.up, T.down), JSON.stringify([T.long, T.short, T.up, T.down]));
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
  const texts = [], moves = [];
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return s => ({ width: String(s).length * 7 });
      if (k === 'fillText') return (s, x, y) => texts.push({ s: String(s), color: t.fillStyle, font: t.font });
      if (k === 'moveTo') return (x, y) => moves.push({ x, y, color: t.strokeStyle });
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
  return { E, chart, texts, moves, bars, frame() { texts.length = 0; moves.length = 0; const f = frameFn; frameFn = null; f(ts += 16); } };
}

test('chart: IB lines show with their own layer, not with Levels, and are shaded on a light ground', () => {
  const { E, chart, texts, frame } = stubChart();
  const lv = [{ name: 'PDH', price: 104, color: E.LEVEL_COLORS.prior, dash: [6, 4] }];
  const ib = E.util.ibLines({ state: 'forming', high: 102, low: 98 });
  chart.setLevels(lv.concat(ib));
  frame();
  const names = () => texts.map(x => x.s.replace(/^ · /, '')).filter(s => /PDH|IB/.test(s));
  assert.deepEqual(names().sort(), ['IBH', 'IBL', 'PDH']);
  chart.setLayers({ levels: false }); frame();
  assert.deepEqual(names().sort(), ['IBH', 'IBL'], 'Levels off keeps the IB');
  chart.setLayers({ levels: true, ib: false }); frame();
  assert.deepEqual(names(), ['PDH'], 'IB off keeps the levels');
  chart.setLayers({ ib: true });
  const color = name => texts.find(x => x.s.replace(/^ · /, '') === name).color;
  frame();
  assert.equal(color('IBH'), E.LEVEL_COLORS.ibHigh, 'default ground: the IB high in the brighter orchid');
  assert.equal(color('IBL'), E.LEVEL_COLORS.ibLow, 'default ground: the IB low in the base orchid');
  for (const bg of ['#FFFFFF', '#F5F7FA', '#777777', '#1B2433']) {
    chart.setTheme({ bg }); frame();
    assert.ok(E.util.contrast(color('IBH'), bg) >= 3.48 && E.util.contrast(color('IBL'), bg) >= 3.48, bg + ': IB names read');
    assert.ok(E.util.luminance(color('IBH')) > E.util.luminance(color('IBL')), bg + ': IBH brighter than IBL');
  }
  assert.equal(chart.getLevels().find(l => l.name === 'IBH').color, E.LEVEL_COLORS.ibHigh, 'the level itself keeps its color');
  assert.equal(chart.getTheme().bg, '#1B2433');
});

test('the IB high stays the brighter with colors set in the IB gear, on every ground (Anthony, 1.9.0)', () => {
  const { E, chart, texts, frame } = stubChart();
  const U2 = E.util;
  const color = name => { const t = texts.filter(x => x.s.replace(/^ · /, '') === name); return t[t.length - 1].color; };
  const draw = (hi, lo, bg) => { chart.setTheme({ bg }); chart.setLevels(U2.ibLines({ state: 'locked', high: 102, low: 98, start: 1790000000 }, { ibHigh: hi, ibLow: lo })); texts.length = 0; frame(); return [color('IBH'), color('IBL')]; };
  // on the default ground colors the page chose that keep the order are drawn exactly as chosen
  assert.deepEqual(draw('#FFD0F0', '#C040A0', '#080B10'), ['#FFD0F0', '#C040A0']);
  // a high picked darker than its low, or the same color: the high is drawn the brighter, by a visible step
  for (const bg of ['#080B10', '#000000', '#1B2433', '#F5F7FA', '#FFFFFF', '#808080', '#B0B0B0']) {
    for (const [hi, lo] of [['#333333', '#FFFFFF'], ['#E58BD2', '#F7C6EC'], ['#E58BD2', '#E58BD2'], ['#000000', '#FFFFFF'], ['#FFFFFF', '#FFFFFF'], ['#00FF00', '#FF0000']]) {
      const [h, l] = draw(hi, lo, bg);
      assert.ok(U2.luminance(h) > U2.luminance(l) && U2.contrast(h, l) >= CE.PAIR.contrast - 0.01, bg + ': IB high ' + hi + ' / low ' + lo + ' drawn ' + h + ' / ' + l);
    }
  }
  assert.equal(chart.getLevels().find(l => l.name === 'IBH').color, '#00FF00', 'the level itself keeps the color chosen');
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
    const cap = Math.min(U.contrast('#FFFFFF', bg), U.contrast('#000000', bg)) >= 4.5 ? best : Math.min(CE.PAIR.split, best);   // a split pair (IB) on a mid ground
    for (const x of drawnOnGround) assert.ok(U.contrast(x.color, bg) >= Math.min(4.5, cap) - 0.02, bg + ': "' + x.s + '" in ' + x.color + ' reads ' + U.contrast(x.color, bg).toFixed(2));
  }
});

test('chart: the IB lines start at 9:30 (Anthony), the other levels run across the whole plot', () => {
  const { E, chart, moves, bars, frame } = stubChart();
  const t930 = bars[200].t;                                   // a bar well inside the view stands for 9:30
  chart.setLevels([{ name: 'PDH', price: 104, color: E.LEVEL_COLORS.prior, dash: [6, 4] }].concat(E.util.ibLines({ state: 'locked', high: 102, low: 98, start: t930 })));
  frame();                                                    // one frame: the next draws only if something changed
  const cols = [E.LEVEL_COLORS.prior, E.LEVEL_COLORS.ibHigh, E.LEVEL_COLORS.ibLow];
  const lineAt = price => moves.filter(m => cols.includes(m.color) && Math.abs(m.y - chart.priceToY(price)) < 1.5).sort((a, b) => a.x - b.x)[0];
  assert.equal(lineAt(104).x, 0, 'PDH from the left edge');
  const ibh = lineAt(102), ibl = lineAt(98);
  assert.ok(ibh.x > 100 && Math.abs(ibh.x - ibl.x) < 0.01, 'IBH and IBL start at the 9:30 bar: ' + ibh.x);
  // the 9:30 bar's left edge: the next bar's line starts one bar spacing later
  chart.setLevels(E.util.ibLines({ state: 'locked', high: 102, low: 98, start: bars[201].t })); frame();
  assert.ok(lineAt(102).x > ibh.x, 'a later start moves right');
});

test('every ground but the default: the toolbar, menus and status line match it, text at the chart floors (Anthony)', () => {
  assert.equal(U.chromeColors(U.buildTheme()), null, 'default ground: the page keeps its dark style');
  assert.equal(U.chromeColors(U.buildTheme({ bg: '#080b10' })), null, 'the default ground typed in: the same');
  // 1.9.0 (Anthony: the top bar matches every ground): Black a black chrome, Blue-grey a blue-grey one, every grey its own
  for (let v = 0; v < 256; v++) {
    const h = v.toString(16).padStart(2, '0'), bg = '#' + h + h + h, T = U.buildTheme({ bg }), c = U.chromeColors(T);
    if (T.ground === 'default') { assert.equal(c, null); continue; }
    assert.ok(c, bg);
    assert.equal(c['--scheme'], T.ground === 'light' ? 'light' : 'dark', bg + ' scheme');
    const end = T.ground === 'light' ? '#000000' : '#FFFFFF';
    // the chart's own color, or on a mid grey (black or white text under 9:1 on it) that grey moved just far enough
    if (U.contrast(bg, end) >= 9) assert.equal(c['--bg'], T.bg, bg);
    else assert.ok(U.contrast(c['--bg'], end) >= 9 && U.contrast(c['--bg'], end) < 9.3, bg + ' moved to ' + c['--bg']);
  }
  const black = U.chromeColors(U.buildTheme({ bg: '#000000' })), slate = U.chromeColors(U.buildTheme({ bg: '#1B2433' }));
  assert.equal(black['--bg'], '#000000'); assert.equal(slate['--bg'], '#1B2433');
  // a dark ground lifts the house surfaces by the house steps and keeps the house text where it reads
  assert.deepEqual([black['--s2'], black['--text'], black['--text2'], black['--buy'], black['--sell'], black['--warn']], ['#070A0D', '#E6EDF5', '#9AA8B8', '#3DDC97', '#FF7A7A', '#E0B45A']);
  assert.deepEqual([slate['--s2'], slate['--s3'], slate['--line-strong']], ['#222E40', '#273549', '#3D4F68']);
  const house = U.chromeColors(Object.assign(U.buildTheme({ bg: '#000000' }), { bg: '#080B10' }));
  assert.deepEqual([house['--s2'], house['--s3'], house['--line'], house['--line-strong'], house['--panel'], house['--accent-tint'], house['--accent-border']],
    ['#0F151D', '#141C26', '#18212C', '#2A3645', '#0B1016', '#1A1230', '#3B2A6B'], 'the lift of the house ground is the house chrome itself');
  assert.ok(U.chromeColors(U.buildTheme({ bg: '#F5F7FA' })), 'the Light preset takes it light');
  let s = 99;
  const rnd = () => (s = (s * 48271) % 2147483647) / 2147483647;
  const grounds = ['#F5F7FA', '#FFFFFF', '#E8E0C8', '#CFE3FF', '#B0B0B0', '#FFFF00', '#00FF00', '#000000', '#1B2433', '#808080', '#767676', '#737373', '#FF00FF', '#0033FF'];
  while (grounds.length < 600) grounds.push('#' + [0, 0, 0].map(() => Math.floor(rnd() * 256).toString(16).padStart(2, '0')).join(''));
  for (const bg of grounds) {
    const T = U.buildTheme({ bg }), v = U.chromeColors(T);
    if (T.ground === 'default') continue;
    assert.ok(v, bg);
    for (const k of U.CHROME_VARS) assert.ok(k in v, k);
    // a clearly light ground (9:1 against the house near-black, the 1.5.3 rule) keeps its 1.5.3 floors: text 7:1
    const strong = T.ground === 'light' && U.contrast(bg, '#080B10') >= 9 ? F.strong : F.text;
    const armed = U.mix(v['--bg'], '#E0B45A', 0.07);
    const on = (k, floor, surface) => { const c = U.contrast(v[k], surface); assert.ok(c >= floor - 0.02, bg + ' ' + k + ' ' + v[k] + ' on ' + surface + ' reads ' + c.toFixed(2)); };
    for (const surface of [v['--bg'], v['--s2'], v['--s3'], armed]) {
      on('--text', strong, surface); on('--head', strong, surface);
      on('--text2', F.text, surface); on('--text3', F.text, surface);
      for (const k of ['--info', '--warn', '--loss', '--profit']) on(k, F.text, surface);
    }
    on('--crimson-word', F.text, v['--bg']);
    on('--accent-text', F.text, v['--accent-tint']); on('--ce-tint-text', F.text, v['--ce-tint']);
    on('--accent-soft', F.text, v['--s2']); on('--accent-soft', F.text, armed);   // the account note on the order bar
    on('--warn', F.text, v['--bg']);                            // the Armed switch: ground-colored text on warn
  }
});

test('merged level names draw as in 1.5.2: one string in the first (highest) level\'s color, IB included (review 2)', () => {
  const { E, chart, texts, frame } = stubChart();
  chart.setLevels([
    { name: 'PDH', price: 104, color: E.LEVEL_COLORS.prior, dash: [6, 4] },
    { name: 'ONH', price: 104.05, color: E.LEVEL_COLORS.overnight, dash: [6, 4] },
  ].concat(E.util.ibLines({ state: 'forming', high: 97.05, low: 97, start: 1790000000 })));
  frame();
  const merged = texts.filter(x => / · /.test(x.s));
  assert.deepEqual(merged.map(x => [x.s, x.color]).sort(), [['IBH · IBL', E.LEVEL_COLORS.ibHigh], ['ONH · PDH', E.LEVEL_COLORS.overnight]]);
  assert.ok(!texts.some(x => x.s === 'PDH' || x.s === ' · PDH'), 'no name drawn apart in its own color');
});
