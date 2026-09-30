'use strict';
// Volume profile kept after its session (1.6.1, Anthony's ruling 2026-09-30): the option `keep` holds the last
// session with trades over weekends and NYSE holidays until the next session's first trade; on weekday evenings it
// behaves as 1.6.0 (review S4). VolumeProfile.fromStore builds that profile from the page's TickStore, and
// closedFrom says which ticks it needs while the market is closed. Without `keep` nothing changed (the 1.6.0 tests in
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

test('keep with RTH: Friday\'s RTH stays over the weekend; Sunday 18:00\'s first trade starts Monday, empty until 9:30', () => {
  const vp = new VolumeProfile({ rth: true, keep: true });
  fill(vp, FRI_FROM, FRI_TO);
  const fri = vp.total, ver = vp.version;
  assert.equal(weekday(vp), 'Fri');
  assert.equal(vp.startOfDay(vp.day), et(2026, 9, 25, 9, 30));
  for (const t of [et(2026, 9, 25, 18, 0), et(2026, 9, 26, 12, 0), et(2026, 9, 27, 18, 0, 30)]) assert.equal(vp.advance(t), false, 'kept at ' + U.fmtFull(t));
  assert.equal(vp.total, fri);
  assert.equal(vp.version, ver);
  assert.equal(vp.add(et(2026, 9, 27, 18, 0, 1), 20500, 2), true, 'the first trade of Monday\'s session (outside RTH) starts it');
  assert.equal(weekday(vp), 'Mon');
  assert.equal(vp.total, 0, 'empty overnight, as in 1.6.0 (the ruling covers weekends and holidays only)');
  vp.add(et(2026, 9, 28, 9, 30), 20600, 3);
  assert.equal(vp.total, 3);
});

test('keep on weekday evenings is 1.6.0: advance at 18:00 empties it (Session and RTH), the overnight RTH is empty', () => {
  for (const rth of [false, true]) {
    const vp = fill(new VolumeProfile({ rth, keep: true }), et(2026, 9, 28, 18, 0), et(2026, 9, 29, 17, 0));   // Tuesday
    assert.ok(vp.total > 0);
    assert.equal(vp.advance(et(2026, 9, 29, 17, 59, 59)), false);
    assert.equal(vp.advance(et(2026, 9, 29, 18, 0)), true, (rth ? 'RTH' : 'Session') + ': Wednesday\'s session on the clock');
    assert.equal(vp.empty, true);
    assert.equal(weekday(vp), 'Wed');
  }
  const rth = fill(new VolumeProfile({ rth: true, keep: true }), et(2026, 9, 28, 18, 0), et(2026, 9, 29, 17, 0));
  assert.equal(rth.add(et(2026, 9, 29, 18, 0, 1), 20000, 1), true, 'an overnight trade on a weekday starts the next day');
  assert.equal(rth.total, 0);
});

test('keep with RTH on an NYSE holiday: Thanksgiving keeps Wednesday\'s RTH; Thursday 18:00 starts Friday, empty until 9:30', () => {
  const vp = new VolumeProfile({ rth: true, keep: true });
  fill(vp, et(2026, 11, 24, 18, 0), et(2026, 11, 25, 17, 0));                // Wednesday 25 Nov
  const wed = vp.total;
  assert.equal(weekday(vp), 'Wed');
  assert.equal(U.rthDay(et(2026, 11, 26, 12, 0)), false, 'Thanksgiving: no stock market session');
  assert.equal(vp.advance(et(2026, 11, 25, 18, 0)), false, 'Thanksgiving\'s trading day starts: kept');
  fill(vp, et(2026, 11, 25, 18, 0), et(2026, 11, 26, 13, 0));                // Globex on Thanksgiving to its early halt
  assert.equal(vp.total, wed, 'no RTH trade on the holiday: Wednesday stays');
  assert.equal(weekday(vp), 'Wed');
  assert.equal(vp.advance(et(2026, 11, 26, 18, 0)), false, 'after the holiday, kept until the next session\'s first trade');
  vp.add(et(2026, 11, 26, 18, 0, 1), 20900, 5);                                // Friday's session begins (a weekday)
  assert.equal(weekday(vp), 'Fri');
  assert.equal(vp.total, 0, 'Friday overnight: empty until 9:30, as on any weekday');
  vp.add(et(2026, 11, 27, 9, 30, 1), 20900, 5);
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

test('fromStore: the last session with trades; RTH looks back only over a weekend or a holiday', () => {
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
  assert.equal(VolumeProfile.fromStore(store, opts(true)).empty, true, 'RTH on Monday 3:00 (a weekday overnight): empty until 9:30, as in 1.6.0');
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
  assert.equal(VolumeProfile.fromStore(tg, opts(true)).empty, true);
  assert.equal(weekday(VolumeProfile.fromStore(tg, opts(false))), 'Fri', 'the full session of Friday 27 Nov started Thursday 18:00');
});

test('closedFrom: which ticks a kept profile needs while CME Globex is closed (null while it trades, holidays included)', () => {
  const s = new VolumeProfile({ keep: true }), r = new VolumeProfile({ keep: true, rth: true });
  const cases = [
    // [clock, Session from, RTH from]
    [et(2026, 9, 29, 13, 0), null, null],                                           // Tuesday, open
    [et(2026, 9, 29, 3, 0), null, null],                                            // a weekday overnight
    [et(2026, 9, 29, 17, 30), et(2026, 9, 28, 18, 0), et(2026, 9, 29, 9, 30)],      // the daily break
    [et(2026, 9, 25, 17, 30), et(2026, 9, 24, 18, 0), et(2026, 9, 25, 9, 30)],      // Friday after the close
    [et(2026, 9, 26, 12, 0), et(2026, 9, 24, 18, 0), et(2026, 9, 25, 9, 30)],       // Saturday
    [et(2026, 9, 27, 17, 59), et(2026, 9, 24, 18, 0), et(2026, 9, 25, 9, 30)],      // Sunday before 18:00
    [et(2026, 9, 27, 18, 0), null, null],                                           // Sunday 18:00: Monday's session is open
    // review 2 S5: Globex trades on Labor Day and Thanksgiving until 13:00 ET, so nothing more is asked then
    [et(2026, 9, 7, 10, 0), null, null],                                            // Labor Day morning
    [et(2026, 9, 7, 12, 59), null, null],
    [et(2026, 9, 7, 13, 0), et(2026, 9, 6, 18, 0), et(2026, 9, 4, 9, 30)],          // Labor Day after the halt: the holiday's own session; RTH Friday's
    [et(2026, 9, 7, 17, 59), et(2026, 9, 6, 18, 0), et(2026, 9, 4, 9, 30)],
    [et(2026, 9, 7, 18, 0), null, null],                                            // Tuesday's session is open
    [et(2026, 1, 19, 11, 0), null, null],                                           // Martin Luther King Jr. Day, trading
    [et(2026, 11, 26, 12, 0), null, null],                                          // Thanksgiving, trading
    [et(2026, 11, 26, 15, 0), et(2026, 11, 25, 18, 0), et(2026, 11, 25, 9, 30)],    // Thanksgiving after the halt
    [et(2026, 11, 27, 14, 0), et(2026, 11, 26, 18, 0), et(2026, 11, 27, 9, 30)],    // the day after, past the 13:15 early close
    [et(2026, 11, 27, 13, 0), null, null],                                          // before it
    // the days with no Globex session at all: Good Friday, Christmas, New Year's Day
    [et(2026, 4, 2, 20, 0), et(2026, 4, 1, 18, 0), et(2026, 4, 2, 9, 30)],          // Thursday evening before Good Friday: no session
    [et(2026, 4, 3, 12, 0), et(2026, 4, 1, 18, 0), et(2026, 4, 2, 9, 30)],          // Good Friday
    [et(2026, 12, 25, 12, 0), et(2026, 12, 23, 18, 0), et(2026, 12, 24, 9, 30)],    // Christmas on a Friday
    [et(2026, 12, 27, 17, 59), et(2026, 12, 23, 18, 0), et(2026, 12, 24, 9, 30)],   // Sunday after it
    [et(2026, 12, 27, 18, 0), null, null],
    [et(2026, 1, 1, 12, 0), et(2025, 12, 30, 18, 0), et(2025, 12, 31, 9, 30)],      // New Year's Day
    [et(2026, 1, 1, 18, 0), null, null],                                            // Friday's session is open
  ];
  for (const [t, sf, rf] of cases) {
    assert.equal(s.closedFrom(t), sf, 'Session at ' + U.fmtFull(t));
    assert.equal(r.closedFrom(t), rf, 'RTH at ' + U.fmtFull(t));
  }
  // the longest reach: Sunday 17:59 after a Friday holiday, 96 h less a minute: the page asks ceil + 1 = 97 hours
  assert.equal(Math.ceil((et(2026, 12, 27, 17, 59) - s.closedFrom(et(2026, 12, 27, 17, 59))) / 3600) + 1, 97);
  assert.equal(U.closedDay(Math.floor(et(2026, 9, 26, 12, 0) / 86400)), true);
  assert.equal(U.closedDay(Math.floor(et(2026, 9, 28, 12, 0) / 86400)), false);
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
  // every minute of 2026 and 2027: while Globex trades closedFrom is null (the page asks for the view's ticks only)
  const s = new VolumeProfile({ keep: true }), r = new VolumeProfile({ keep: true, rth: true });
  let max = 0;
  for (let t = et(2026, 1, 1, 0, 0); t < et(2028, 1, 1, 0, 0); t += 60) {
    const a = s.closedFrom(t), b = r.closedFrom(t);
    if (!U.cmeClosed(t)) { assert.equal(a, null); assert.equal(b, null); continue; }
    max = Math.max(max, Math.ceil((t - a) / 3600) + 1, Math.ceil((t - b) / 3600) + 1);
  }
  assert.ok(max <= 97, 'the most asked is ' + max + ' hours');
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

test('the page asks for the last session while CME is closed, as much as ChartBridge serves by its version; nt8/ is unchanged', () => {
  const fs = require('node:fs'), path = require('node:path');
  const cs = fs.readFileSync(path.join(__dirname, '..', 'nt8', 'ChartBridge.cs'), 'utf8');
  assert.match(cs, /int tickHours = hm\.Success \? Math\.Max\(0, Math\.Min\(48, int\.Parse\(hm\.Groups\[1\]\.Value\)\)\) : ChartBridgeConfig\.DefaultTickHours;/, 'review 2 S3: 0.3.4 as on main');
  const js = fs.readFileSync(path.join(__dirname, '..', 'live', 'live.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(js, /const VP_CLOSED_HOURS = 120;/);
  assert.match(js, /return n >= 3005 \? VP_CLOSED_HOURS : 48;/, 'from ChartBridge 0.3.5 on');
  assert.match(js, /const ticksWanted = \(\) => Math\.min\(ticksWantedAll\(\), bridgeTickHours\(\)\);/);
  assert.match(js, /bridgeVersion = typeof m\.version === 'string' \? m\.version : '';\n/);
  assert.doesNotMatch(js, /install\.ps1 again/, 'no install advice on the page (review 2 S4)');
});
