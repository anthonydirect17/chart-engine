'use strict';
// Volume profile kept after its session (1.6.1, Anthony's ruling 2026-09-30): the option `keep` holds the last
// session with trades over weekends and NYSE holidays until the next session's first trade; on weekday evenings it
// behaves as 1.6.0 (review S4). VolumeProfile.fromStore builds that profile from the page's TickStore, and
// Without `keep` nothing changed (the 1.6.0 tests in
// volume-profile.test.js and vp-draw.test.js still hold).
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

test('keep with RTH: Friday\'s RTH stays over the weekend and Sunday night, until Monday 9:30\'s first trade', () => {
  const vp = new VolumeProfile({ rth: true, keep: true });
  fill(vp, FRI_FROM, FRI_TO);
  const fri = vp.total, ver = vp.version;
  assert.equal(weekday(vp), 'Fri');
  assert.equal(vp.startOfDay(vp.day), et(2026, 9, 25, 9, 30));
  for (const t of [et(2026, 9, 25, 18, 0), et(2026, 9, 26, 12, 0), et(2026, 9, 27, 18, 0, 30), et(2026, 9, 28, 9, 30)]) assert.equal(vp.advance(t), false, 'kept at ' + U.fmtFull(t));
  assert.equal(vp.add(et(2026, 9, 27, 18, 0, 1), 20500, 2), false, 'Monday\'s first Globex trade (outside RTH) does not move it');
  assert.equal(vp.total, fri);
  assert.equal(vp.version, ver);
  assert.equal(weekday(vp), 'Fri');
  assert.equal(vp.add(et(2026, 9, 28, 9, 30), 20600, 3), true, 'the first RTH trade starts Monday');
  assert.equal(weekday(vp), 'Mon');
  assert.equal(vp.total, 3);
});
test('keep on weekday evenings: the full session moves at 18:00 as in 1.6.0; RTH stays through the night until 9:30', () => {
  const full = fill(new VolumeProfile({ keep: true }), et(2026, 9, 28, 18, 0), et(2026, 9, 29, 17, 0));   // Tuesday
  assert.ok(full.total > 0);
  assert.equal(full.advance(et(2026, 9, 29, 17, 59, 59)), false);
  assert.equal(full.advance(et(2026, 9, 29, 18, 0)), true, 'Session: Wednesday\'s session on the clock');
  assert.equal(full.empty, true);
  assert.equal(weekday(full), 'Wed');
  // RTH (Anthony 2026-09-30: today's RTH through the weekday night until the next 9:30 open)
  const rth = fill(new VolumeProfile({ rth: true, keep: true }), et(2026, 9, 28, 18, 0), et(2026, 9, 29, 17, 0));
  const tue = rth.total;
  assert.equal(rth.advance(et(2026, 9, 29, 18, 0)), false, 'RTH: the clock moves nothing');
  fill(rth, et(2026, 9, 29, 18, 0), et(2026, 9, 30, 9, 30));                   // Wednesday's Globex night
  assert.equal(weekday(rth), 'Tue');
  assert.equal(rth.total, tue, 'Tuesday\'s RTH all night');
  rth.add(et(2026, 9, 30, 9, 30, 0.2), 20000, 4);
  assert.equal(weekday(rth), 'Wed', 'Wednesday 9:30\'s first trade starts Wednesday');
  assert.equal(rth.total, 4);
});
test('keep with RTH on an NYSE holiday: Thanksgiving keeps Wednesday\'s RTH until Friday 9:30', () => {
  const vp = new VolumeProfile({ rth: true, keep: true });
  fill(vp, et(2026, 11, 24, 18, 0), et(2026, 11, 25, 17, 0));                // Wednesday 25 Nov
  const wed = vp.total;
  assert.equal(weekday(vp), 'Wed');
  assert.equal(U.rthDay(et(2026, 11, 26, 12, 0)), false, 'Thanksgiving: no stock market session');
  assert.equal(vp.advance(et(2026, 11, 25, 18, 0)), false, 'Thanksgiving\'s trading day starts: kept');
  fill(vp, et(2026, 11, 25, 18, 0), et(2026, 11, 26, 13, 0));                // Globex on Thanksgiving to its early halt
  assert.equal(vp.total, wed, 'no RTH trade on the holiday: Wednesday stays');
  assert.equal(vp.advance(et(2026, 11, 26, 18, 0)), false);
  vp.add(et(2026, 11, 26, 18, 0, 1), 20900, 5);                                // Friday's Globex session begins
  assert.equal(weekday(vp), 'Wed', 'still Wednesday\'s RTH through Friday\'s night');
  assert.equal(vp.total, wed);
  vp.add(et(2026, 11, 27, 9, 30, 1), 20900, 5);
  assert.equal(weekday(vp), 'Fri');
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

test('fromStore: the last session with trades; RTH looks back to the last RTH in the store, the full session over a weekend or a holiday', () => {
  const opts = rth => ({ keep: true, rth });
  const store = fill(new BB.TickStore(), FRI_FROM, FRI_TO);                       // Thursday 18:00 to Friday 17:00
  const fri = VolumeProfile.fromStore(store, opts(false)), friRth = VolumeProfile.fromStore(store, opts(true));
  assert.equal(weekday(fri), 'Fri');
  assert.equal(weekday(friRth), 'Fri');
  const hand = new VolumeProfile({ rth: true });
  store.feed(hand, 0);
  assert.equal(friRth.total, hand.total, 'the Friday RTH profile has every Friday RTH trade');
  fill(store, et(2026, 9, 27, 18, 0), et(2026, 9, 28, 3, 0));                     // Sunday 18:00 to Monday 3:00
  const mon = VolumeProfile.fromStore(store, opts(false));
  assert.equal(weekday(mon), 'Mon', 'the full session: Monday\'s, from Sunday 18:00');
  assert.equal(mon.total, fill(new VolumeProfile(), et(2026, 9, 27, 18, 0), et(2026, 9, 28, 3, 0)).total);
  assert.equal(weekday(VolumeProfile.fromStore(store, opts(true))), 'Fri', 'RTH on Monday 3:00: Friday\'s, kept through the night until 9:30');
  // Labor Day 2026 (Monday 7 Sep): Friday's RTH over the weekend and the holiday, and the holiday's Globex session
  const ld = fill(new BB.TickStore(), et(2026, 9, 3, 18, 0), et(2026, 9, 4, 17, 0));
  fill(ld, et(2026, 9, 6, 18, 0), et(2026, 9, 7, 12, 0));
  assert.equal(weekday(VolumeProfile.fromStore(ld, opts(true))), 'Fri', 'Labor Day, RTH: Friday\'s, looked up over the holiday and the weekend');
  assert.equal(weekday(VolumeProfile.fromStore(ld, opts(false))), 'Mon', 'Labor Day, Session: the holiday\'s own Globex session');
  // Thanksgiving: Wednesday's RTH on the holiday; Friday 8:00 (a weekday overnight) empty
  const tg = fill(new BB.TickStore(), et(2026, 11, 24, 18, 0), et(2026, 11, 25, 17, 0));
  fill(tg, et(2026, 11, 25, 18, 0), et(2026, 11, 26, 13, 0));
  assert.equal(weekday(VolumeProfile.fromStore(tg, opts(true))), 'Wed');
  fill(tg, et(2026, 11, 26, 18, 0), et(2026, 11, 27, 8, 0));
  assert.equal(weekday(VolumeProfile.fromStore(tg, opts(true))), 'Wed', 'Friday 8:00: Wednesday\'s RTH until Friday 9:30');
  assert.equal(weekday(VolumeProfile.fromStore(tg, opts(false))), 'Fri', 'the full session of Friday 27 Nov started Thursday 18:00');
});


test('cmeClosed: the CME Globex calendar, not the NYSE one (review 2 S5)', () => {
  const iso = y => [...U.cmeClosures(y)].map(d => new Date(d * 86400000).toISOString().slice(0, 10)).sort();
  assert.deepEqual(iso(2026), ['2026-01-01', '2026-04-03', '2026-12-25']);
  assert.deepEqual(iso(2027), ['2027-01-01', '2027-03-26', '2027-12-24']);   // Christmas on a Saturday: the Friday
  assert.deepEqual(iso(2022), ['2022-04-15', '2022-12-26']);               // New Year's on a Saturday: not moved
  const open = [et(2026, 9, 28, 3, 0), et(2026, 9, 27, 18, 0), et(2026, 9, 25, 16, 59), et(2026, 9, 7, 12, 59), et(2026, 7, 3, 12, 0), et(2026, 6, 19, 9, 30)];
  const shut = [et(2026, 9, 28, 17, 0), et(2026, 9, 25, 17, 0), et(2026, 9, 26, 12, 0), et(2026, 9, 27, 17, 59), et(2026, 9, 7, 13, 0), et(2026, 7, 3, 13, 0),
    et(2026, 12, 24, 13, 15), et(2026, 12, 24, 20, 0), et(2026, 12, 25, 12, 0), et(2026, 4, 3, 9, 30)];
  for (const t of open) assert.equal(U.cmeClosed(t), false, 'open at ' + U.fmtFull(t));
  for (const t of shut) assert.equal(U.cmeClosed(t), true, 'closed at ' + U.fmtFull(t));
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

test('1.6.1 loads no tick history beyond the view\'s: ticksWanted and ticksMissing as in 1.6.0 (1.8.0: with a bridge that has no served window); the tick cap 48', () => {
  const fs = require('node:fs'), path = require('node:path');
  const cs = fs.readFileSync(path.join(__dirname, '..', 'nt8', 'ChartBridge.cs'), 'utf8');
  assert.match(cs, /int tickHours = hm\.Success \? Math\.Max\(0, Math\.Min\(48, int\.Parse\(hm\.Groups\[1\]\.Value\)\)\) : ChartBridgeConfig\.DefaultTickHours;/);
  const js = fs.readFileSync(path.join(__dirname, '..', 'live', 'live.js'), 'utf8').replace(/\r\n/g, '\n');
  // 1.8.0: with ChartBridge 0.3.5 (hello "liveFirst") tick views get the served window; otherwise exactly 1.6.0's rules
  assert.match(js, /\n  const viewTicksWanted = \(\) => LIVE_FIRST \? \(tickView\(\) \? WINDOW_TICK_HOURS : 0\) : TF\[S\.tf\]\.mode === 'range' \? BB\.rangeTickHours\(etNow\(\), SESSION\) : TF\[S\.tf\]\.sec < 60 \? 8 : 0;\n/);
  assert.match(js, /\n    : TF\[S\.tf\]\.mode === 'range' \? BB\.rangeNeedsReload\(D\.tickFrom, etNow\(\), SESSION, D\.trimmed\) : TF\[S\.tf\]\.sec < 60 && D\.tickHours === 0;\n/);
  assert.match(js, /\n  const ticksWanted = \(\) => viewTicksWanted\(\);\n  const ticksMissing = \(\) => viewTicksMissing\(\);\n/);
  assert.doesNotMatch(js, /closedFrom|VP_CLOSED_HOURS|bridgeTickHours|tickCapped|install\.ps1 again/);
  assert.equal(typeof new VolumeProfile({}).closedFrom, 'undefined');
});