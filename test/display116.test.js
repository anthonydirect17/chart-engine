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

const { LivePrefs: LP } = require('../live/live.js');
const W = require('../live/workspace.js');
const OT = require('../live/order-ticket.js');

/* bar time (New York wall clock as UTC seconds) of a weekday at hh:mm: 2026-10-05 is a Monday */
const at = (dayOfOct, hh, mm, ss = 0) => Date.UTC(2026, 9, dayOfOct, hh, mm, ss) / 1000;

test('stale feed: 10 s in RTH (09:30 to 16:00 ET), 60 s outside it, never while CME Globex is shut', () => {
  assert.strictEqual(LP.staleSeconds(9999, at(6, 10, 2)), 0, 'Tuesday 10:02: under 10 s is fine');
  assert.strictEqual(LP.staleSeconds(10000, at(6, 10, 2)), 10, 'Tuesday 10:02: 10 s quiet is stale');
  assert.strictEqual(LP.staleSeconds(12500, at(6, 9, 30)), 12, 'from 09:30');
  assert.strictEqual(LP.staleSeconds(30000, at(6, 9, 29, 59)), 0, '09:29:59 is outside RTH: 60 s');
  assert.strictEqual(LP.staleSeconds(30000, at(6, 16, 0)), 0, '16:00 is outside RTH (the stale rule; Time and Sales keeps 16:15)');
  assert.strictEqual(LP.staleSeconds(61000, at(6, 3, 0)), 61, 'overnight: 60 s');
  assert.strictEqual(LP.staleSeconds(600000, at(6, 17, 30)), 0, 'the 17:00 to 18:00 break: nothing is due');
  assert.strictEqual(LP.staleSeconds(61000, at(6, 18, 0)), 61, 'from 18:00 again');
  assert.strictEqual(LP.staleSeconds(600000, at(9, 17, 0)), 0, 'Friday from 17:00: shut');
  assert.strictEqual(LP.staleSeconds(600000, at(10, 12, 0)), 0, 'Saturday: shut');
  assert.strictEqual(LP.staleSeconds(600000, at(11, 17, 59)), 0, 'Sunday before 18:00: shut');
  assert.strictEqual(LP.staleSeconds(61000, at(11, 18, 1)), 61, 'Sunday from 18:00: open, overnight rule');
  assert.strictEqual(LP.staleSeconds(0, at(6, 10, 0)), 0);
  assert.strictEqual(LP.staleSeconds(NaN, at(6, 10, 0)), 0);
  assert.ok(LP.isRthEt(at(5, 10, 0)) && !LP.isRthEt(at(10, 10, 0)), 'RTH on weekdays only');
});

test('the Data Box panel type, its spans, and the Maximize panel hotkey (never a trading key)', () => {
  assert.ok(W.TYPES.includes('databox'));
  assert.deepStrictEqual(W.cleanPanel({ id: 'db1', type: 'databox', x: 10, y: 3, w: 2, h: 3 }), { id: 'db1', type: 'databox', x: 10, y: 3, w: 2, h: 3 }, 'no instrument');
  assert.deepStrictEqual(W.cleanLayout({ panels: [{ id: 'a', type: 'databox', x: 0, y: 0, w: 2, h: 2 }, { id: 'b', type: 'databox', x: 2, y: 0, w: 2, h: 2 }] }).panels.length, 2);
  assert.deepStrictEqual(['', '12 s', '59 s', '1:00', '4:05', '1:02:03', '1d 02h'], [-1, 12.4, 59.4, 60, 245, 3723, 93600].map(W.fmtSpan));
  const trading = { buy: 'Alt+B', sell: '', be: '', close: 'F9', flattenAll: '' };
  assert.deepStrictEqual(W.cleanViewKeys({ maximize: 'Alt+M' }, trading, OT.hotkeyRefused), { maximize: 'Alt+M' });
  assert.deepStrictEqual(W.cleanViewKeys('{"maximize":"Alt+M"}', trading, OT.hotkeyRefused), { maximize: 'Alt+M' }, 'from the stored text');
  assert.deepStrictEqual(W.cleanViewKeys({ maximize: 'Alt+B' }, trading, OT.hotkeyRefused), { maximize: '' }, 'a trading key wins');
  assert.deepStrictEqual(W.cleanViewKeys({ maximize: 'F9' }, trading, OT.hotkeyRefused), { maximize: '' });
  assert.deepStrictEqual(W.cleanViewKeys({ maximize: 'Ctrl+W' }, trading, OT.hotkeyRefused), { maximize: '' }, 'refused by the trading hotkeys\' own rule (the browser keeps it)');
  assert.deepStrictEqual(W.cleanViewKeys({ maximize: 'A' }, trading, OT.hotkeyRefused), { maximize: '' }, 'the chart\'s own key');
  assert.deepStrictEqual(W.cleanViewKeys(null, trading, OT.hotkeyRefused), { maximize: '' }, 'none by default');
  assert.deepStrictEqual(W.cleanViewKeys('{bad', trading, OT.hotkeyRefused), { maximize: '' });
  // setting a trading key in Settings: the trading hotkeys' own capture rule refuses another trading key; the workspace
  // refuses its own Maximize key too (workspace.js saveHotkey); and a Maximize key equal to a trading key is refused
  const e = { code: 'KeyB', key: 'b', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false };
  assert.match(OT.hotkeyFromEvent(e, trading, 'maximize').error, /is already Buy MKT/);
  assert.deepStrictEqual([W.LAPTOP_TABS, W.GAP, W.GAP_TIGHT], [['Main', 'Second'], 6, 2]);
});
