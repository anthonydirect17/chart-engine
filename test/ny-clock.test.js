// The New York clock and session date (Bot-Lab plan step 1.6): chart-engine's exact copy of market-data's shared/
// ny_clock files. The three files are copied whole and pinned here by sha256 (the same pins as market-data's
// tests/test_ny_clock.py); never edit them here.
//
// The table, shared/ny_clock_cases.json, is checked twice: every expected value is computed again here by a method that
// does not use the module (the runtime's own America/New_York zone through Intl, and session windows), then the module
// must give exactly the table. Nothing in the engine, the live pages or Legion reads the module yet. The last tests pin
// where the page's own helpers stand: the league's sessionToday and sessionOfBar agree on every row; tradeDay(t, 18:00)
// and the bot's tradeDay (18:00, no weekend roll) differ only in the 17:00 to 18:00 break and at weekends; cmeClosed
// agrees with the calendar's in-session answer on every row the calendar covers, Good Friday 2026 included (CME's
// abbreviated session to 09:15, Anthony's ruling 2026-11-18).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../shared/ny_clock.js');
const S = require('../shared/shared_calendar.js');

const SHARED = path.join(__dirname, '..', 'shared');
const PINS = {   // market-data shared/ (tests/test_ny_clock.py there holds the same pins)
  'ny_clock.js': 'a17906c43de2476445f7b66c9d17e8c5de1cf8535404430c664b536c903f3f54',
  'ny_clock.py': '94d718be50d0890fd495c114d8cdcb98cc5113c6e9297eefe6df4db141845dee',
  'ny_clock_cases.json': 'b72626d8e74c572b30c1f2e149a45af740dcb7afaa94edeb4b77f9d8b15c2e38',
};
const T = JSON.parse(fs.readFileSync(path.join(SHARED, 'ny_clock_cases.json'), 'utf8'));
const cal = S.loadCalendar();
const DAY_MS = 86400000, MIN = 60000;

// ---------------------------------------------------------------- the independent method (Intl, never the module)
const FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function wallOf(ms) {
  const p = {};
  for (const x of FMT.formatToParts(new Date(ms))) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) + (((ms % 1000) + 1000) % 1000);
}
const offsetOf = ms => Math.round((wallOf(ms) - ms) / MIN);
function atNy(day, hh, mm) {          // UTC ms of a New York wall time away from a switch hour
  const wall = Date.parse(day + 'T00:00:00Z') + (hh * 60 + mm) * MIN;
  let u = wall + 300 * MIN;
  u = wall - offsetOf(u) * MIN;
  assert.strictEqual(wallOf(u), wall);
  return u;
}
const isoDay = t => new Date(t).toISOString().slice(0, 10);
const addDays = (d, n) => isoDay(Date.parse(d + 'T00:00:00Z') + n * DAY_MS);
const weekday = d => (new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7;

function oSessionDate(u, withCal) {
  let d = addDays(isoDay(wallOf(u)), -1);
  for (let i = 0; i < 14; i++, d = addDays(d, 1)) {
    if (weekday(d) < 5 && u < atNy(d, 17, 0) && (!withCal || cal.isSession(d))) return d;
  }
  throw new Error('no session within two weeks');
}
function oInSession(u, withCal) {
  const d = oSessionDate(u, withCal), c = withCal ? cal.closeTime(d) : '17:00';
  return atNy(addDays(d, -1), 18, 0) <= u && u < atNy(d, +c.slice(0, 2), +c.slice(3));
}
function oWeekend(u) {
  const d = isoDay(wallOf(u)), fri = addDays(d, 4 - weekday(d));
  return atNy(fri, 17, 0) <= u && u < atNy(addDays(fri, 2), 18, 0);
}
const pad = n => String(n).padStart(2, '0');
function oCase(c) {
  const u = Date.parse(c.utc), w = wallOf(u), off = offsetOf(u), a = Math.abs(off);
  const want = { label: c.label, utc: c.utc, utc_ms: u,
    ny: new Date(w).toISOString().slice(0, 23) + (off < 0 ? '-' : '+') + pad(Math.floor(a / 60)) + ':' + pad(a % 60),
    ny_date: isoDay(w), offset_minutes: off, ny_wall_ms: w, session_date: oSessionDate(u, false),
    in_session: oInSession(u, false), weekend: oWeekend(u) };
  try { want.calendar = { session_date: oSessionDate(u, true), in_session: oInSession(u, true) }; } catch (e) {
    if (!(e instanceof S.CalendarNotCovered)) throw e;
    want.calendar = 'not covered';
  }
  return want;
}
function oBounds(b) {
  const d = b.session_date, want = { label: b.label, session_date: d };
  if (weekday(d) >= 5) { want.start_utc = 'no session'; want.end_utc = 'no session'; } else {
    want.start_utc = new Date(atNy(addDays(d, -1), 18, 0)).toISOString();
    want.end_utc = new Date(atNy(d, 17, 0)).toISOString();
  }
  try {
    const c = cal.closeTime(d);
    want.calendar_end_utc = c === null ? 'no session' : new Date(atNy(d, +c.slice(0, 2), +c.slice(3))).toISOString();
  } catch (e) {
    if (!(e instanceof S.CalendarNotCovered)) throw e;
    want.calendar_end_utc = 'not covered';
  }
  return want;
}
const shut = c => c.weekend || (() => { const s = (c.ny_wall_ms / 1000) % 86400, wd = weekday(c.ny_date); return wd < 5 && s >= 61200 && s < 64800; })();

// ---------------------------------------------------------------- the files
test('the three files are market-data\'s byte for byte', () => {
  const got = {};
  for (const name of Object.keys(PINS)) {
    const data = fs.readFileSync(path.join(SHARED, name));
    assert.ok(!data.includes(13), name + ' has a carriage return');
    got[name] = crypto.createHash('sha256').update(data).digest('hex');
  }
  assert.deepStrictEqual(got, PINS);
});

test('every expected value is the independent method\'s', () => {
  assert.deepStrictEqual(T.cases.map(oCase), T.cases);
  assert.deepStrictEqual(T.bounds.map(oBounds), T.bounds);
});

// ---------------------------------------------------------------- the module gives the table
test('the module gives the table, for a number and for a Date', () => {
  for (const c of T.cases) {
    for (const m of [c.utc_ms, new Date(c.utc_ms)]) {
      const n = C.toNy(m);
      assert.deepStrictEqual([n.iso, n.date, n.offsetMinutes, n.wallMs], [c.ny, c.ny_date, c.offset_minutes, c.ny_wall_ms], c.label);
      assert.strictEqual(C.nyDate(m), c.ny_date, c.label);
      assert.strictEqual(C.utcOffsetMinutes(m), c.offset_minutes, c.label);
      assert.strictEqual(C.sessionDate(m), c.session_date, c.label);
      assert.strictEqual(C.inSession(m), c.in_session, c.label);
      assert.strictEqual(C.isWeekend(m), c.weekend, c.label);
      if (c.calendar === 'not covered') assert.throws(() => C.sessionDate(m, cal), S.CalendarNotCovered, c.label);
      else {
        assert.strictEqual(C.sessionDate(m, cal), c.calendar.session_date, c.label);
        assert.strictEqual(C.inSession(m, cal), c.calendar.in_session, c.label);
      }
    }
    assert.strictEqual(C.sessionDateWall(c.ny_wall_ms), c.session_date, c.label);
  }
  for (const b of T.bounds) {
    const d = b.session_date, iso = ms => new Date(ms).toISOString();
    if (b.start_utc === 'no session') { assert.throws(() => C.sessionStart(d), RangeError); assert.throws(() => C.sessionEnd(d), RangeError); } else {
      assert.strictEqual(iso(C.sessionStart(d)), b.start_utc, b.label);
      assert.strictEqual(iso(C.sessionEnd(d)), b.end_utc, b.label);
    }
    if (b.calendar_end_utc === 'not covered') assert.throws(() => C.sessionEnd(d, cal), S.CalendarNotCovered, b.label);
    else if (b.calendar_end_utc === 'no session') assert.throws(() => C.sessionEnd(d, cal), RangeError, b.label);
    else assert.strictEqual(iso(C.sessionEnd(d, cal)), b.calendar_end_utc, b.label);
  }
});

test('the US rules in code match the runtime\'s zone on every hour from 2007 to 2040', () => {
  const bad = [];
  for (let t = Date.UTC(2007, 0, 1); new Date(t).getUTCFullYear() <= 2040; t += 3600000) if (C.utcOffsetMinutes(t) !== offsetOf(t)) bad.push(t);
  assert.deepStrictEqual(bad, []);
});

test('refusals and the edges of the range', () => {
  assert.throws(() => C.sessionDate('a moment'), TypeError);
  assert.throws(() => C.sessionDate(NaN), TypeError);
  assert.throws(() => C.nyWallMs(1763500000001.5), TypeError);          // part of a millisecond
  assert.throws(() => C.sessionDate(1763500000), RangeError);           // seconds passed as ms
  assert.throws(() => C.nyWallMs(1763500000000000), RangeError);        // microseconds passed as ms
  assert.throws(() => C.toNy(C.FIRST_MS - 1), RangeError);
  assert.throws(() => C.toNy(C.END_MS), RangeError);
  assert.throws(() => C.toNy(new Date(C.END_MS)), RangeError);
  assert.throws(() => C.sessionStart('not-a-date'), TypeError);
  assert.throws(() => C.sessionStart(T.bounds[0].session_date.slice(0, 8) + '32'), TypeError);
  assert.throws(() => C.sessionStart(new Date(C.FIRST_MS - 3 * DAY_MS).toISOString().slice(0, 10)), RangeError);
  assert.throws(() => C.sessionStart(new Date(C.END_MS + 3 * DAY_MS).toISOString().slice(0, 10)), RangeError);
  assert.throws(() => C.usRulesOffsetMinutes(C.RULES_FROM_MS - 1), RangeError);
  // the first moment is inside the first session of 2007, which opened the evening before, as the runtime's zone says
  assert.ok(C.inSession(C.FIRST_MS));
  assert.strictEqual(C.sessionStart(C.FIRST_DAY), atNy(addDays(C.FIRST_DAY, -1), 18, 0));
  assert.strictEqual(C.sessionEnd(C.LAST_DAY), atNy(C.LAST_DAY, 17, 0));
  assert.strictEqual(C.nyWallMs(C.END_MS - 1), wallOf(C.END_MS - 1));
  const n = C.nowNy();
  assert.ok(Math.abs(n.wallMs - n.offsetMinutes * MIN - Date.now()) < 60000);
});

// ---------------------------------------------------------------- where the page's own helpers stand
test('nothing in the engine, the live pages or Legion reads the clock yet', () => {
  for (const dir of ['src', 'live', 'nt8']) {
    for (const f of fs.readdirSync(path.join(__dirname, '..', dir))) {
      const p = path.join(__dirname, '..', dir, f);
      if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p, 'utf8').includes('ny_clock'), p);
    }
  }
});

test('the page\'s helpers: the league agrees, the 18:00 rules differ only when no session runs', () => {
  const U = require('../src/chart-engine.js').util;
  const L = require('../live/league.js');
  const B = require('../live/bot-core.js');
  for (const c of T.cases) {
    assert.strictEqual(L.sessionToday(c.utc_ms), c.session_date, c.label);
    assert.strictEqual(L.sessionOfBar(c.ny_wall_ms / 1000), c.session_date, c.label);
    const trade = isoDay(U.tradeDay(c.ny_wall_ms / 1000, 64800) * DAY_MS);
    assert.strictEqual(trade === c.session_date, !shut(c), 'tradeDay ' + c.label);
    assert.strictEqual(B.tradeDay(c.utc_ms) === c.session_date, !shut(c), 'bot tradeDay ' + c.label);
    if (c.calendar !== 'not covered') {
      assert.strictEqual(!U.cmeClosed(c.ny_wall_ms / 1000), c.calendar.in_session, 'cmeClosed ' + c.label);
    }
  }
});
