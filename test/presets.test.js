'use strict';
// Color presets (1.9.0): the preset store behind one small interface (this browser's storage today, a store shared by
// every PC later), chart presets linked to an indicator preset, the indicator colors set in their gears, the level and
// IB lines drawn in them, and the order bar matching every chart ground with Buy, Sell and Armed still readable and its
// dimmed controls at least as strong as on the house bar.
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

test('the old VWAP color survives a ground change made first (review R1)', () => {
  // 1.8 kept the VWAP in live-colors-v1; the page starts, and the first change is the ground (the Colors panel, which
  // no longer holds VWAP, writes live-colors-v1 again without it)
  const st = memStorage({ 'live-colors-v1': JSON.stringify({ up: '#4B9CD3', down: '#6D28D9', vwap: '#FFCC00', bg: '#080B10' }) });
  const page = LP.create(st);                                       // page start: copied across once
  assert.deepEqual(JSON.parse(st.getItem('live-indicator-colors-v1')), { vwap: '#FFCC00' });
  st.setItem('live-colors-v1', JSON.stringify({ up: '#4B9CD3', down: '#6D28D9', bg: '#000000' }));   // Black clicked
  assert.equal(page.indicatorColors().vwap, '#FFCC00');
  assert.equal(LP.create(st).indicatorColors().vwap, '#FFCC00', 'after a reload');
  // an indicator key with other colors but no VWAP takes the old VWAP too, and keeps its colors
  const st2 = memStorage({ 'live-colors-v1': JSON.stringify({ vwap: '#abcdef' }), 'live-indicator-colors-v1': JSON.stringify({ prior: '#123456' }) });
  LP.create(st2);
  assert.deepEqual(JSON.parse(st2.getItem('live-indicator-colors-v1')), { prior: '#123456', vwap: '#ABCDEF' });
  // a VWAP set in the gear is never replaced by the old one
  const st3 = memStorage({ 'live-colors-v1': JSON.stringify({ vwap: '#ABCDEF' }), 'live-indicator-colors-v1': JSON.stringify({ vwap: '#111111' }) });
  assert.equal(LP.create(st3).indicatorColors().vwap, '#111111');
  // nothing to carry: nothing written (a fresh page writes no color key)
  const fresh = memStorage();
  LP.create(fresh);
  assert.equal(fresh.getItem('live-indicator-colors-v1'), null);
  const bad = memStorage({ 'live-colors-v1': JSON.stringify({ vwap: 'pink' }) });
  LP.create(bad);
  assert.equal(bad.getItem('live-indicator-colors-v1'), null);
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

/* The grounds of review 1's in-page sweep: the four presets, white, light and mid greys around the light/dark switch,
   tinted lights and three loud colors. */
const REVIEW_GROUNDS = ['#080B10', '#000000', '#1B2433', '#F5F7FA', '#FFFFFF', '#E0E0E0', '#D0D0D0', '#C8C8C8', '#BBBBBB', '#B0B0B0', '#A0A0A0',
  '#808080', '#FFF8E1', '#FFE0E0', '#E8F5E9', '#E3F2FD', '#D0D8E0', '#F0E6FF', '#FFFF00', '#00FF00', '#FF00FF'];
function sweepGrounds(seed, n) {
  let s = seed;
  const rnd = () => (s = (s * 48271) % 2147483647) / 2147483647;
  const out = REVIEW_GROUNDS.slice();
  for (let v = 0; v < 256; v += 3) { const h = v.toString(16).padStart(2, '0'); out.push('#' + h + h + h); }
  while (out.length < n) out.push('#' + [0, 0, 0].map(() => Math.floor(rnd() * 256).toString(16).padStart(2, '0')).join(''));
  return out;
}
const over = (color, under) => {                                  // an rgba() tint as it shows over `under`
  const c = U.parseColor(color), g = U.parseColor(under);
  return '#' + ['r', 'g', 'b'].map(k => Math.round(c[k] * c.a + g[k] * (1 - c.a)).toString(16).padStart(2, '0')).join('');
};

test('the order bar matches every ground: Buy green, Sell red, Armed amber, each reading 4.5:1 where it sits', () => {
  // the default ground: nothing is set, so the bar keeps its 1.5.2 colors (the CSS fallbacks)
  assert.equal(U.chromeColors(U.buildTheme({ bg: '#080B10' })), null);
  const mins = {};
  for (const bg of sweepGrounds(7, 700)) {
    const T = U.buildTheme({ bg }), v = U.chromeColors(T);
    if (T.ground === 'default') continue;
    assert.ok(v, bg);
    for (const k of ['--buy', '--buy-edge', '--buy-tint', '--buy-hover', '--sell', '--sell-edge', '--sell-tint', '--sell-hover', '--warn-tint', '--obar-off', '--obar-disabled']) assert.ok(U.CHROME_VARS.includes(k) && v[k], bg + ' ' + k);
    const armedBar = over(v['--warn-tint'], v['--bg']);
    const need = (what, fg, surface) => {
      const c = U.contrast(fg, surface); mins[what] = Math.min(mins[what] || 99, c);
      assert.ok(c >= F.text - 0.02, bg + ' ' + what + ' ' + fg + ' on ' + surface + ' reads ' + c.toFixed(2));
    };
    for (const side of ['buy', 'sell']) {
      // the button text on its tint and on its hover tint, over the bar (--s2) and over the Armed bar
      for (const tint of [v['--' + side + '-tint'], v['--' + side + '-hover']]) for (const under of [v['--s2'], armedBar]) need(side, v['--' + side], over(tint, under));
    }
    // every other text on the bar at full strength: labels, the Flatten and Cancel all buttons, the boxes, the state row
    for (const under of [v['--bg'], v['--s2'], armedBar]) for (const k of ['--text', '--head', '--text2', '--text3', '--profit', '--loss', '--warn', '--accent-soft']) need(k, v[k], under);
    // still green and still red: the hue is kept (green channel leads for Buy, red for Sell)
    const b = U.parseColor(v['--buy']), r = U.parseColor(v['--sell']);
    assert.ok(b.g > b.r && b.g > b.b, bg + ' Buy stays green: ' + v['--buy']);
    assert.ok(r.r > r.g && r.r > r.b, bg + ' Sell stays red: ' + v['--sell']);
    assert.ok(U.distinct(v['--buy'], v['--sell']), bg + ' Buy and Sell apart');
    // Armed: the switch and the pill are ground-colored text on --warn, the bar tinted amber
    need('armed switch', v['--bg'], v['--warn']);
    need('armed bar text', v['--warn'], armedBar);
  }
  for (const k in mins) assert.ok(mins[k] >= F.text - 0.02, k);
});

test('dimmed order bar controls (disarmed, trading off) read at least as well on every ground as on the house bar (review R2)', () => {
  const H = U.OBAR_DIM.house;
  // the house bar's own numbers, as review 1 measured them in the page (disarmed Buy 2.85, Sell 2.28, Flatten 4.01; trading off Buy 2.51)
  assert.deepEqual(H.off.map(x => +x.toFixed(1)), [2.9, 2.3, 4.0]);
  assert.equal(+H.disabled[0].toFixed(1), 2.5);
  assert.deepEqual(U.OBAR_DIM.alpha, { off: 0.45, disabled: 0.4 });
  const worst = { off: [], disabled: [] };
  for (const bg of sweepGrounds(11, 700)) {
    const T = U.buildTheme({ bg }), v = U.chromeColors(T);
    if (!v) continue;
    const d = U.obarDims(v, 0.08, 0.08);
    for (const k of ['off', 'disabled']) {
      const a = +v['--obar-' + k];
      assert.ok(a >= U.OBAR_DIM.alpha[k] && a <= 1, bg + ' ' + k + ' opacity ' + a);
      d[k].forEach((x, i) => {
        const c = U.fadedContrast(x, a);
        worst[k][i] = Math.min(worst[k][i] === undefined ? 99 : worst[k][i], c - H[k][i]);
        assert.ok(c >= H[k][i], bg + ' ' + k + ' #' + i + ' reads ' + c.toFixed(2) + ' under the house ' + H[k][i].toFixed(2) + ' at ' + a);
      });
    }
  }
  // the opacity is only as strong as it needs to be: the light Light preset gets more, Black about the house's
  assert.ok(+U.chromeColors(U.buildTheme({ bg: '#F5F7FA' }))['--obar-off'] > 0.45);
  assert.ok(+U.chromeColors(U.buildTheme({ bg: '#000000' }))['--obar-off'] <= 0.5);
  for (const k of ['off', 'disabled']) assert.ok(worst[k].every(x => x >= 0), k);
});

test('linked presets: a chart preset keeps its indicator preset\'s id; a link to one deleted since is left alone', async () => {
  const st = memStorage(), s = LP.localPresetStore(st);
  const ind = (await s.save('indicator', 'Light indicators', IND())).preset;
  const a = await s.save('chart', 'White chart', WHITE, ind.id);
  assert.equal(a.preset.ind, ind.id);
  assert.equal((await s.list()).chart[0].ind, ind.id, 'kept in the store');
  // only an indicator preset that is there (else the save is refused, nothing written), and only on a chart preset
  const before = st.getItem('live-color-presets-v1');
  await assert.rejects(s.save('chart', 'Other', DARK, 'p-nope'), /gone/);
  assert.equal(st.getItem('live-color-presets-v1'), before, 'a refused save writes nothing');
  assert.equal((await s.save('indicator', 'Ind 2', IND(), ind.id)).preset.ind, undefined, 'an indicator preset has no link');
  // replacing without the link drops it; with it, it comes back; a rename keeps it
  assert.equal((await s.save('chart', 'white CHART', WHITE)).preset.ind, undefined);
  assert.equal((await s.save('chart', 'White chart', WHITE, ind.id)).preset.ind, ind.id);
  assert.equal((await s.rename('chart', a.preset.id, 'Day')).preset.ind, ind.id);
  // the indicator preset deleted: the chart preset stays, its link simply points at nothing
  await s.remove('indicator', ind.id);
  const after = await s.list();
  assert.deepEqual(after.chart.find(p => p.name === 'Day').colors, WHITE);
  assert.equal(after.indicator.some(p => p.id === ind.id), false);
  // cleanPresets keeps a link of the right shape on chart presets only
  const c = LP.cleanPresets({ chart: [{ id: 'a', name: 'A', colors: DARK, ind: 'p1' }, { id: 'b', name: 'B', colors: DARK, ind: 5 }, { id: 'c', name: 'C', colors: DARK, ind: 'x'.repeat(65) }],
    indicator: [{ id: 'p1', name: 'I', colors: IND(), ind: 'a' }] });
  assert.deepEqual(c.chart.map(p => p.ind), ['p1', undefined, undefined]);
  assert.equal(c.indicator[0].ind, undefined);
});

test('linked presets: a chart save never touches the indicator group; full groups refuse only their own save (review 2 S1, S2)', async () => {
  const st = memStorage(), s = LP.localPresetStore(st);
  const day = (await s.save('indicator', 'Day', IND())).preset;
  for (let i = 1; i < LP.PRESET_MAX; i++) await s.save('indicator', 'I' + i, Object.assign(IND(), { vwap: '#0000' + String(i).padStart(2, '0') }));
  assert.equal((await s.list()).indicator.length, LP.PRESET_MAX, 'the indicator group is full');
  // S2: a linked chart preset re-saved while the indicator group is full keeps its link (the select still says Day)
  const night = (await s.save('chart', 'Night', DARK, day.id)).preset;
  const r = await s.save('chart', 'night', WHITE, day.id);
  assert.equal(r.replaced, true); assert.equal(r.preset.id, night.id); assert.equal(r.preset.ind, day.id, 'the link is kept');
  assert.equal((await s.list()).indicator.length, LP.PRESET_MAX, 'no indicator preset made or dropped');
  // S1: the chart group full: the refused save writes nothing at all, the indicator group untouched
  for (let i = 1; i < LP.PRESET_MAX; i++) await s.save('chart', 'C' + i, DARK, day.id);
  const before = st.getItem('live-color-presets-v1');
  await assert.rejects(s.save('chart', 'One too many', WHITE, day.id), /holds 24/);
  assert.equal(st.getItem('live-color-presets-v1'), before, 'nothing written: no orphan anywhere');
  // the indicator group full refuses only an indicator save, with the same message
  await assert.rejects(s.save('indicator', 'More', IND()), /holds 24/);
  assert.equal((await s.save('chart', 'Night', DARK)).preset.ind, undefined, 'None drops the link, only when asked');
});

test('the Colors panel: VWAP can be left out of it, the house default keeps it', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/chart-engine.js'), 'utf8');
  assert.match(src, /vwap: true, note: 'Saved in this browser only\.'/, 'other hosts keep the 1.8 panel by default');
  const page = require('node:fs').readFileSync(require.resolve('../live/live.js'), 'utf8');
  assert.match(page, /storageKey: PREFIX \+ 'live-colors-v1', vwap: false,/, 'the live page sets VWAP in its gear');
});
