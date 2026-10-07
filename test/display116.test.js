// Chart 1.16.0, the display round (Anthony's list of 2026-10-07): the pure parts. The auto-fit that keeps every large-order
// bubble in view inside the plot, the delta core's largest trade per bar (the Data Box), the Data Box panel, the panel
// maximize hotkey, the laptop layouts and the stale-feed rule. No browser.
const test = require('node:test');
const assert = require('node:assert');
const CE = require('../src/chart-engine.js');
const U = CE.util;

test('auto-fit: a bubble in view never crosses the top of the plot (radius up to 27 px)', () => {
  const H = 300, tick = 0.25;
  const yOf = (f, p) => (f.hi - p) / (f.hi - f.lo) * H;
  const bare = U.fitRange(100, 110, null, H, tick, false);
  const none = U.fitRange(100, 110, null, H, tick, false, 0, { n: 0, p: [], r: [] });
  assert.deepStrictEqual(none, bare, 'no bubble: as before');
  // a 27 px bubble at the high: its top is at the plot's top or below
  const top = U.fitRange(100, 110, null, H, tick, false, 0, { n: 1, p: [110], r: [U.BUBBLE_R_MAX] });
  assert.ok(Math.abs(yOf(top, 110) - U.BUBBLE_R_MAX) < 1e-9, 'the high 27 px down: ' + yOf(top, 110));
  assert.ok(Math.abs(yOf(top, 100) - (H - H * 0.08)) < 1e-9, 'the bottom margin unchanged');
  // a small one at the high fits in the 8% already (24 px)
  assert.deepStrictEqual(U.fitRange(100, 110, null, H, tick, false, 0, { n: 1, p: [110], r: [U.BUBBLE_R_MIN] }), bare);
  // one lower down needs less room; several: the one that needs most decides
  const mid = U.fitRange(100, 110, null, H, tick, false, 0, { n: 3, p: [109.9, 105, 101], r: [27, 27, 27] });
  for (const p of [109.9, 105, 101]) assert.ok(yOf(mid, p) - 27 >= -1e-9, p + ': inside, ' + yOf(mid, p));
  assert.ok(Math.abs(yOf(mid, 109.9) - 27) < 1e-9, 'the highest one touches the top');
  // the legend's room and the bubbles: the larger wins
  const leg = U.fitRange(100, 110, null, H, tick, false, 60, { n: 1, p: [110], r: [27] });
  assert.ok(Math.abs(yOf(leg, 110) - 60) < 1e-9);
  // never more than 45% of a tiny plot
  const tiny = U.fitRange(100, 110, null, 40, tick, false, 0, { n: 1, p: [110], r: [27] });
  assert.ok(Math.abs((tiny.hi - 110) / (tiny.hi - tiny.lo) - 0.45) < 1e-9);
  // with the volume bars' 20% at the bottom
  const vol = U.fitRange(100, 110, null, H, tick, true, 0, { n: 1, p: [100.5], r: [27] });
  assert.ok(yOf(vol, 100.5) >= 27 - 1e-9);
});

test('the delta core keeps each bar\'s largest single trade (big), counted trades only', () => {
  const cd = new CE.CumulativeDelta({ seconds: 60 });
  const T = 86400 * 3 + 36000;
  cd.add(T + 1, 3, 1); cd.add(T + 2, 12, -1); cd.add(T + 3, 7, 0); cd.add(T + 4, 0, 1);
  cd.add(T + 61, 5, 1);
  assert.deepStrictEqual(cd.bars.map(b => [b.buy, b.sell, b.unknown, b.big]), [[3, 12, 7, 12], [5, 0, 0, 5]]);
});
