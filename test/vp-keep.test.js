'use strict';
// Volume profile kept after its session (1.6.1, Anthony's ruling 2026-09-30): the option `keep` holds the last
// session with trades over the 17:00 ET close, the 18:00 start, weekends and NYSE holidays, until the first trade
// counted in a later session (with RTH: the next RTH trade, so the overnight never empties it), and
// VolumeProfile.fromStore builds that profile from the page's TickStore. Without `keep` nothing changed (the 1.6.0
// tests in volume-profile.test.js and vp-draw.test.js still hold).
const test = require('node:test');
const assert = require('node:assert/strict');
const CE = require('../src/chart-engine.js');
const BB = require('../live/bar-builder.js');
const { VolumeProfile } = CE;
const U = CE.util;

const et = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h, mi, s || 0) / 1000;   // New York wall clock stored as UTC
const dayOf = t => Math.floor(t / 86400);
const weekday = vp => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(vp.day * 86400 * 1000).getUTCDay()];

/* Every minute of a session from `from` to `to` (a trade at 21000 + minute % 40 ticks, volume 1 + minute % 3). */
function fill(target, from, to, step) {
  let n = 0;
  for (let t = from; t < to; t += step || 60, n++) {
    const p = 21000 + (n % 40) * 0.25, v = 1 + (n % 3);
    if (target.push) target.push(t, p, v); else target.add(t, p, v);
  }
  return target;
}
/* Fri 25 Sep 2026: the session from Thu 18:00 to Fri 17:00 (a 1-hour pause 17:00 to 18:00 on Thu is before it). */
const FRI_FROM = et(2026, 9, 24, 18, 0), FRI_TO = et(2026, 9, 25, 17, 0);

test('keep: a Friday profile stays over the weekend, the clock moves nothing (advance does nothing)', () => {
  const vp = fill(new VolumeProfile({ keep: true }), FRI_FROM, FRI_TO);
  const total = vp.total, ver = vp.version, poc = vp.poc();
  assert.equal(vp.day, dayOf(et(2026, 9, 25, 12, 0)));
  assert.equal(weekday(vp), 'Fri');
  for (const t of [et(2026, 9, 25, 17, 0), et(2026, 9, 25, 18, 0), et(2026, 9, 26, 12, 0), et(2026, 9, 27, 17, 59, 59), et(2026, 9, 27, 18, 0), et(2026, 9, 28, 9, 30)]) {
    assert.equal(vp.advance(t), false, 'advance at ' + U.fmtFull(t));
  }
  assert.equal(vp.total, total);
  assert.equal(vp.version, ver, 'nothing changed');
  assert.deepEqual(vp.poc(), poc);
  assert.equal(vp.startOfDay(vp.day), FRI_FROM, 'the session held started Thu 18:00');
});

test('keep: the next session\'s first trade (Sun 18:00, Monday\'s session) switches it', () => {
  const vp = fill(new VolumeProfile({ keep: true }), FRI_FROM, FRI_TO);
  const fridayTotal = vp.total;
  assert.equal(vp.add(et(2026, 9, 27, 18, 0, 0.25), 20000, 3), true, 'a new session');
  assert.equal(weekday(vp), 'Mon');
  assert.equal(vp.total, 3);
  assert.equal(vp.poc().price, 20000);
  assert.ok(fridayTotal > 3);
  assert.equal(vp.add(et(2026, 9, 25, 16, 59), 21000, 1), false, 'a late Friday trade after the switch is left out');
  assert.equal(vp.skipped, 1);
  assert.equal(vp.total, 3);
});

test('keep with RTH: the day\'s RTH stays through the overnight and the weekend until the next 9:30 trade', () => {
  const vp = new VolumeProfile({ rth: true, keep: true });
  fill(vp, FRI_FROM, FRI_TO);
  const fri = vp.total, ver = vp.version;
  assert.equal(weekday(vp), 'Fri');
  assert.equal(vp.startOfDay(vp.day), et(2026, 9, 25, 9, 30));
  fill(vp, et(2026, 9, 27, 18, 0), et(2026, 9, 28, 9, 30));                  // Sunday evening to Monday 9:29
  assert.equal(vp.total, fri, 'overnight trades never empty it');
  assert.equal(vp.version, ver);
  assert.ok(vp.outside > 0);
  assert.equal(vp.add(et(2026, 9, 28, 9, 30), 20500, 2), true, 'Monday 9:30: the first RTH trade switches');
  assert.equal(weekday(vp), 'Mon');
  assert.equal(vp.total, 2);
  fill(vp, et(2026, 9, 28, 16, 0), et(2026, 9, 29, 9, 30));                  // after the close and overnight
  assert.equal(vp.total, 2, 'Monday RTH kept after 16:00 and over 18:00');
});

test('keep with RTH on an NYSE holiday: Thanksgiving keeps Wednesday until Friday 9:30 (an early close)', () => {
  const vp = new VolumeProfile({ rth: true, keep: true });
  fill(vp, et(2026, 11, 24, 18, 0), et(2026, 11, 25, 17, 0));                // Wednesday 25 Nov
  const wed = vp.total;
  assert.equal(weekday(vp), 'Wed');
  assert.equal(U.rthDay(et(2026, 11, 26, 12, 0)), false, 'Thanksgiving: no stock market session');
  fill(vp, et(2026, 11, 25, 18, 0), et(2026, 11, 26, 13, 0));                // Globex on Thanksgiving to its early halt
  fill(vp, et(2026, 11, 26, 18, 0), et(2026, 11, 27, 9, 30));
  assert.equal(vp.total, wed, 'no RTH trade on the holiday: Wednesday stays');
  assert.equal(weekday(vp), 'Wed');
  vp.add(et(2026, 11, 27, 9, 30, 1), 20900, 5);
  assert.equal(weekday(vp), 'Fri');
  assert.equal(vp.total, 5);
  vp.add(et(2026, 11, 27, 13, 5), 20901, 5);                                   // after the 13:00 early close: outside
  assert.equal(vp.total, 5);
});

test('keep, full session, on a CME holiday: Christmas Eve\'s session stays through Christmas and the weekend', () => {
  const vp = new VolumeProfile({ keep: true });
  fill(vp, et(2026, 12, 23, 18, 0), et(2026, 12, 24, 13, 15));               // Thu 24 Dec, early halt
  const eve = vp.total;
  assert.equal(weekday(vp), 'Thu');
  for (const t of [et(2026, 12, 25, 12, 0), et(2026, 12, 26, 12, 0), et(2026, 12, 27, 17, 59)]) assert.equal(vp.advance(t), false);
  assert.equal(vp.total, eve);
  vp.add(et(2026, 12, 27, 18, 0), 21100, 1);
  assert.equal(weekday(vp), 'Mon');
  assert.equal(vp.total, 1);
});

test('without keep nothing changed: advance at 18:00 empties, an overnight RTH trade starts the next day', () => {
  const vp = fill(new VolumeProfile(), FRI_FROM, FRI_TO);
  assert.equal(vp.advance(et(2026, 9, 25, 18, 0)), true);
  assert.equal(vp.empty, true);
  const rth = fill(new VolumeProfile({ rth: true }), FRI_FROM, FRI_TO);
  assert.equal(rth.add(et(2026, 9, 27, 18, 0), 20000, 1), true, '1.6.0: the overnight trade moves the RTH profile on');
  assert.equal(rth.total, 0);
});

test('fromStore: the last session with trades; RTH before 9:30, over a weekend and a holiday looks back', () => {
  const opts = keepRth => ({ keep: true, rth: keepRth });
  // Thursday 18:00 to Friday 17:00, then Sunday 18:00 to Monday 3:00 (the page loaded early Monday)
  const store = fill(new BB.TickStore(), FRI_FROM, FRI_TO);
  const fri = VolumeProfile.fromStore(store, opts(false));
  assert.equal(weekday(fri), 'Fri');
  const friRth = VolumeProfile.fromStore(store, opts(true));
  assert.equal(weekday(friRth), 'Fri');
  const hand = new VolumeProfile({ rth: true });
  store.feed(hand, 0);
  assert.equal(friRth.total, hand.total, 'the Friday RTH profile has every Friday RTH trade');
  fill(store, et(2026, 9, 27, 18, 0), et(2026, 9, 28, 3, 0));
  const mon = VolumeProfile.fromStore(store, opts(false));
  assert.equal(weekday(mon), 'Mon', 'the full session: Monday\'s, from Sunday 18:00');
  assert.equal(mon.total, fill(new VolumeProfile(), et(2026, 9, 27, 18, 0), et(2026, 9, 28, 3, 0)).total);
  const rth = VolumeProfile.fromStore(store, opts(true));
  assert.equal(weekday(rth), 'Fri', 'RTH before Monday 9:30: Friday\'s RTH, looked up over the weekend');
  assert.equal(rth.total, friRth.total);
  // Thanksgiving: Wednesday's RTH, Globex on the holiday, the page loaded Friday 8:00
  const tg = fill(new BB.TickStore(), et(2026, 11, 24, 18, 0), et(2026, 11, 25, 17, 0));
  fill(tg, et(2026, 11, 25, 18, 0), et(2026, 11, 26, 13, 0));
  fill(tg, et(2026, 11, 26, 18, 0), et(2026, 11, 27, 8, 0));
  assert.equal(weekday(VolumeProfile.fromStore(tg, opts(true))), 'Wed');
  assert.equal(weekday(VolumeProfile.fromStore(tg, opts(false))), 'Fri', 'the full session of Friday 27 Nov started Thursday 18:00');
});

test('fromStore: nothing that counts gives an empty profile, never an error', () => {
  assert.equal(VolumeProfile.fromStore(new BB.TickStore(), { keep: true }).empty, true);
  assert.equal(VolumeProfile.fromStore(null, { keep: true }).empty, true);
  // only overnight trades, and no RTH anywhere in the store
  const night = fill(new BB.TickStore(), et(2026, 9, 27, 18, 0), et(2026, 9, 28, 3, 0));
  const vp = VolumeProfile.fromStore(night, { keep: true, rth: true });
  assert.equal(vp.empty, true);
  assert.equal(vp.day, null);
});
