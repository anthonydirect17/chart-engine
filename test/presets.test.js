'use strict';
// Color presets (1.9.0): the preset store behind one small interface (this browser's storage today, a store shared by
// every PC later), the indicator colors set in their gears, the level and IB lines drawn in them, and the order bar
// following a light chart ground with Buy, Sell and Armed still readable.
const test = require('node:test');
const assert = require('node:assert/strict');
const CE = require('../src/chart-engine.js');
const { LivePrefs: LP } = require('../live/live.js');
const U = CE.util, F = CE.FLOOR;

function memStorage(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, map: m };
}
const DARK = { up: '#4B9CD3', down: '#6D28D9', bg: '#080B10' };
const WHITE = { up: '#1F6FB2', down: '#6D28D9', bg: '#FFFFFF' };
const IND = () => Object.fromEntries(LP.INDICATOR_COLORS.map(c => [c.key, c.def]));

test('presets: save, list, pick by name, rename, delete', async () => {
  const st = memStorage(), s = LP.localPresetStore(st);
  assert.equal(s.shared, false);
  assert.deepEqual(await s.list(), { chart: [], indicator: [] });
  const a = await s.save('chart', '  Dark   desk ', DARK);
  assert.equal(a.replaced, false);
  assert.equal(a.preset.name, 'Dark desk', 'trimmed, inner spaces as one');
  assert.deepEqual(a.preset.colors, DARK);
  await s.save('chart', 'White chart', { up: '#1f6fb2', down: '#6d28d9', bg: '#ffffff' });
  const w = (await s.list()).chart.find(p => p.name === 'White chart');
  assert.deepEqual(w.colors, WHITE, 'colors kept upper case');
  // the same name, any case, replaces that preset and keeps its id
  const r = await s.save('chart', 'dark DESK', WHITE);
  assert.equal(r.replaced, true);
  assert.equal(r.preset.id, a.preset.id);
  assert.equal(r.lists.chart.length, 2);
  assert.deepEqual(r.lists.chart.find(p => p.id === a.preset.id).colors, WHITE);
  // rename
  const n = await s.rename('chart', a.preset.id, 'Night');
  assert.equal(n.preset.name, 'Night');
  await assert.rejects(s.rename('chart', a.preset.id, 'white CHART'), /already called/);
  await assert.rejects(s.rename('chart', a.preset.id, '   '), /name/);
  await assert.rejects(s.rename('chart', 'nope', 'X'), /gone/);
  // delete
  const d = await s.remove('chart', a.preset.id);
  assert.deepEqual(d.lists.chart.map(p => p.name), ['White chart']);
  // the groups are apart: an indicator preset of the same name is its own
  await s.save('indicator', 'White chart', IND());
  const all = await s.list();
  assert.equal(all.chart.length, 1); assert.equal(all.indicator.length, 1);
  assert.deepEqual(all.indicator[0].colors, IND());
});

test('presets: refused calls say why and change nothing', async () => {
  const st = memStorage(), s = LP.localPresetStore(st);
  await assert.rejects(s.save('chart', '', DARK), /name/);
  await assert.rejects(s.save('chart', 'X', { up: '#123456', down: '#654321' }), /missing/, 'a chart preset needs up, down and bg');
  await assert.rejects(s.save('chart', 'X', { up: 'red', down: '#654321', bg: '#000000' }), /missing/);
  await assert.rejects(s.save('indicator', 'X', { vwap: '#B69CFF' }), /missing/, 'an indicator preset holds every indicator color');
  await assert.rejects(s.save('layout', 'X', DARK), /group/);
  await assert.rejects(s.save('__proto__', 'X', DARK), /group/);
  for (let i = 0; i < LP.PRESET_MAX; i++) await s.save('chart', 'P' + i, DARK);
  await assert.rejects(s.save('chart', 'One more', DARK), /holds 24/);
  const r = await s.save('chart', 'p3', WHITE);
  assert.equal(r.replaced, true, 'a full group still replaces by name');
  assert.equal((await s.list()).chart.length, LP.PRESET_MAX);
  // a name longer than 40 characters is cut to 40
  const long = await LP.localPresetStore(memStorage()).save('chart', 'x'.repeat(60), DARK);
  assert.equal(long.preset.name.length, LP.PRESET_NAME_MAX);
});

test('presets: every call reads the store fresh, so two tabs never undo each other', async () => {
  const st = memStorage(), a = LP.localPresetStore(st), b = LP.localPresetStore(st);
  await a.list(); await b.list();                                  // both "open"
  await a.save('chart', 'From A', DARK);
  await b.save('chart', 'From B', WHITE);
  await b.save('indicator', 'Ind B', IND());
  const x = await a.save('chart', 'From A again', WHITE);
  assert.deepEqual(x.lists.chart.map(p => p.name), ['From A', 'From B', 'From A again']);
  assert.deepEqual(x.lists.indicator.map(p => p.name), ['Ind B']);
});

test('presets: a damaged or blocked store never breaks the page', async () => {
  const bad = memStorage({ 'live-color-presets-v1': '{not json' });
  assert.deepEqual(await LP.localPresetStore(bad).list(), { chart: [], indicator: [] });
  const junk = { chart: [null, 5, { id: 'a', name: 'Ok', colors: DARK }, { id: 'a', name: 'Same id', colors: DARK }, { id: 'b', name: 'ok', colors: DARK },
    { id: 'c', name: '', colors: DARK }, { id: 'd', name: 'No bg', colors: { up: '#111111', down: '#222222' } }, { id: 'e', name: 'Bad hex', colors: { up: 'blue', down: '#222222', bg: '#000000' } },
    { id: 'f', name: 'Extra', colors: Object.assign({ vwap: '#FFFFFF', '__proto__': 1 }, DARK) }], indicator: 'nope', other: [1] };
  const clean = LP.cleanPresets(junk);
  assert.deepEqual(clean.chart.map(p => p.name), ['Ok', 'Extra'], 'bad, duplicate and partial presets are left out');
  assert.deepEqual(clean.chart[1].colors, DARK, 'only the group\'s own keys are kept');
  assert.deepEqual(clean.indicator, []);
  const blocked = { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); } };
  await assert.rejects(LP.localPresetStore(blocked).save('chart', 'X', DARK), /blocks site storage/);
  await assert.rejects(LP.localPresetStore(null).save('chart', 'X', DARK), /blocks site storage/);
  assert.deepEqual(await LP.localPresetStore(null).list(), { chart: [], indicator: [] });
});

test('presets: the storage prefix keeps a host\'s presets apart from the page\'s', async () => {
  const st = memStorage();
  const prefixed = { getItem: k => st.getItem('desk:' + k), setItem: (k, v) => st.setItem('desk:' + k, v) };
  await LP.localPresetStore(prefixed).save('chart', 'Desk', DARK);
  assert.deepEqual((await LP.localPresetStore(st).list()).chart, []);
  assert.ok(st.map.has('desk:live-color-presets-v1'));
});

test('indicator colors: the house defaults, set by hand one change at a time, and the old VWAP color carried over', () => {
  // the defaults are exactly the engine's house colors
  assert.deepEqual(LP.IND_COLOR_KEYS, ['vwap', 'prior', 'overnight', 'value', 'close', 'ibHigh', 'ibLow', 'vpPoc']);
  const def = LP.create(memStorage()).indicatorColors();
  assert.equal(def.vwap, CE.DEFAULT_THEME.vwap); assert.equal(def.vpPoc, CE.DEFAULT_THEME.vpPoc);
  for (const k of ['prior', 'overnight', 'value', 'close', 'ibHigh', 'ibLow']) assert.equal(def[k], CE.LEVEL_COLORS[k], k);
  // every indicator color belongs to an indicator that has a gear
  for (const c of LP.INDICATOR_COLORS) assert.ok(LP.INDICATORS.some(d => d.id === c.id), c.key);
  // the VWAP the Colors panel kept in live-colors-v1 up to 1.8 is read while the new key is missing
  const st = memStorage({ 'live-colors-v1': JSON.stringify({ up: '#4FD1A5', vwap: '#ffcc00' }) });
  const a = LP.create(st), b = LP.create(st);
  assert.equal(a.indicatorColors().vwap, '#FFCC00');
  // one change at a time, read fresh: a second tab's change is kept, and the carried-over VWAP with it
  assert.equal(a.setIndicatorColors({ prior: '#123abc' }), true);
  assert.equal(b.setIndicatorColors({ ibHigh: '#FFFFFF', bogus: '#000000', ibLow: 'pink' }), true);
  assert.deepEqual(JSON.parse(st.getItem('live-indicator-colors-v1')), { vwap: '#FFCC00', prior: '#123ABC', ibHigh: '#FFFFFF' });
  const c = LP.create(st).indicatorColors();
  assert.equal(c.prior, '#123ABC'); assert.equal(c.ibHigh, '#FFFFFF'); assert.equal(c.ibLow, CE.LEVEL_COLORS.ibLow);
  assert.equal(a.setIndicatorColors({ nothing: '#FFFFFF' }), false, 'nothing allowed: nothing written');
  // once the new key exists the old VWAP is no longer read
  st.setItem('live-colors-v1', JSON.stringify({ vwap: '#00FF00' }));
  assert.equal(LP.create(st).indicatorColors().vwap, '#FFCC00');
});

test('level and IB lines take the indicator colors; without them, the house colors as before', () => {
  const lv = { pdh: 110, pdl: 90, pc: 100, onh: 105, onl: 95, vah: 104, val: 96 };
  const house = U.levelLines(lv);
  assert.deepEqual(house.map(L => L.color), [CE.LEVEL_COLORS.prior, CE.LEVEL_COLORS.value, CE.LEVEL_COLORS.overnight, CE.LEVEL_COLORS.close,
    CE.LEVEL_COLORS.overnight, CE.LEVEL_COLORS.value, CE.LEVEL_COLORS.prior]);
  const mine = U.levelLines(lv, { prior: '#111111', overnight: '#222222', value: '#333333', close: '#444444', vwap: '#FFFFFF' });
  assert.deepEqual(mine.map(L => [L.name, L.color]), [['PDH', '#111111'], ['VAH', '#333333'], ['ONH', '#222222'], ['Prior close', '#444444'], ['ONL', '#222222'], ['VAL', '#333333'], ['PDL', '#111111']]);
  assert.deepEqual(U.levelLines(lv, { prior: 'red' }).map(L => L.color), house.map(L => L.color), 'a color that is not #RRGGBB is ignored');
  const ib = { state: 'locked', high: 102, low: 98, start: 1000 };
  assert.deepEqual(U.ibLines(ib).map(L => L.color), [CE.LEVEL_COLORS.ibHigh, CE.LEVEL_COLORS.ibLow]);
  assert.deepEqual(U.ibLines(ib, { ibHigh: '#abcdef', ibLow: '#012345' }).map(L => L.color), ['#ABCDEF', '#012345']);
  assert.deepEqual(U.ibLines(null, { ibHigh: '#abcdef' }), []);
});

test('the order bar follows a light ground: Buy green, Sell red, Armed amber, each reading 4.5:1 where it sits', () => {
  // dark, black, blue-grey and mid greys: nothing is set, so the bar keeps its 1.5.2 colors (the CSS fallbacks)
  for (const bg of ['#080B10', '#000000', '#1B2433', '#333333', '#888888']) assert.equal(U.chromeColors(U.buildTheme({ bg })), null, bg);
  let s = 7;
  const rnd = () => (s = (s * 48271) % 2147483647) / 2147483647;
  const grounds = ['#F5F7FA', '#FFFFFF', '#E8E0C8', '#CFE3FF', '#B0B0B0', '#FFFF00', '#00FF00', '#FFE4EA'];
  while (grounds.length < 300) { const h = '#' + [0, 0, 0].map(() => Math.floor(150 + rnd() * 106).toString(16).padStart(2, '0')).join(''); if (U.chromeColors(U.buildTheme({ bg: h }))) grounds.push(h); }
  const over = (color, under) => {                                  // an rgba() tint as it shows over `under`
    const c = U.parseColor(color), g = U.parseColor(under);
    return '#' + ['r', 'g', 'b'].map(k => Math.round(c[k] * c.a + g[k] * (1 - c.a)).toString(16).padStart(2, '0')).join('');
  };
  for (const bg of grounds) {
    const v = U.chromeColors(U.buildTheme({ bg }));
    assert.ok(v, bg);
    for (const k of ['--buy', '--buy-edge', '--buy-tint', '--buy-hover', '--sell', '--sell-edge', '--sell-tint', '--sell-hover', '--warn-tint']) assert.ok(U.CHROME_VARS.includes(k) && v[k], bg + ' ' + k);
    for (const side of ['buy', 'sell']) {
      // the button text on its tint and on its hover tint, over the bar (--s2)
      for (const tint of [v['--' + side + '-tint'], v['--' + side + '-hover']]) {
        const c = U.contrast(v['--' + side], over(tint, v['--s2']));
        assert.ok(c >= F.text - 0.02, bg + ' ' + side + ' ' + v['--' + side] + ' on ' + tint + ' reads ' + c.toFixed(2));
      }
    }
    // still green and still red: the hue is kept (green channel leads for Buy, red for Sell)
    const b = U.parseColor(v['--buy']), r = U.parseColor(v['--sell']);
    assert.ok(b.g > b.r && b.g > b.b, bg + ' Buy stays green: ' + v['--buy']);
    assert.ok(r.r > r.g && r.r > r.b, bg + ' Sell stays red: ' + v['--sell']);
    assert.ok(U.distinct(v['--buy'], v['--sell']), bg + ' Buy and Sell apart');
    // Armed: the switch and the pill are ground-colored text on --warn, the bar tinted amber
    assert.ok(U.contrast(v['--bg'], v['--warn']) >= F.text - 0.02, bg + ' Armed text on ' + v['--warn']);
    assert.ok(U.contrast(v['--warn'], over(v['--warn-tint'], v['--bg'])) >= F.text - 0.02, bg + ' Armed bar text');
  }
});

test('the Colors panel: VWAP can be left out of it, the house default keeps it', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/chart-engine.js'), 'utf8');
  assert.match(src, /vwap: true, note: 'Saved in this browser only\.'/, 'other hosts keep the 1.8 panel by default');
  const page = require('node:fs').readFileSync(require.resolve('../live/live.js'), 'utf8');
  assert.match(page, /storageKey: PREFIX \+ 'live-colors-v1', vwap: false,/, 'the live page sets VWAP in its gear');
});
