// The shared CME calendar and contract values (Bot-Lab plan step 1.5): chart-engine's exact copy of market-data's
// shared/ folder. The four files are copied whole and pinned here by sha256 (the same pins as market-data's
// tests/test_shared_calendar.py); never edit them here.
//
// Nothing in chart-engine reads the copy yet. The page's own calendar (goodFriday, nyseHolidays, nyseEarlyCloses,
// cmeClosures, cmeShortSessions, cmeSessionDay, cmeClosed) is computed by rule plus its list of abbreviated sessions,
// and these tests hold it to the copy on every day the copy covers (2024 to 2027). Good Friday 2026 is CME's
// abbreviated session to 09:15 on both (Anthony's ruling 2026-11-18, "follow CME"). One day differs and is pinned by
// name below, never hidden: 2025-01-09 (KNOWN_PAGE_DIFFERENCES).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const CE = require('../src/chart-engine.js');
const S = require('../shared/shared_calendar.js');

const SHARED = path.join(__dirname, '..', 'shared');
const PINS = {
  'cme_calendar.json': '1a35b18b28c26b0e3139da9de1edbfd799ba2dd2feece3d39fbf2482d0e9eb42',
  'contracts.json': 'ff54367ca6d97568cfaea1236d0c4b3f465eba0148d5020bcd798dd6ee1ac47b',
  'shared_calendar.js': '7853f72528e3ae0732b3817dc33ad0132a518fff3414cb9069fd5a8f93100265',
  'shared_calendar.py': '2652f8c5e70554992bd2e4efa236a2c93f16697671e4955e5a6e0646fadff3a8',
};
const U = CE.util;
const DAY_MS = 86400000;
const sec = hhmm => Number(hhmm.slice(0, 2)) * 3600 + Number(hhmm.slice(3, 5)) * 60;

// The days where the page's CME session close is not the copy's, each pinned by name with both closes (seconds after
// midnight New York). 2025-01-09, the national day of mourning for former President Carter: CME's Globex equity
// session closed at 09:30 New York (the copy's row, kind and time checked by CME); the page's rule knows no such day
// and keeps it a full session to the 17:00 break. A day added here or taken away is a change to review.
const KNOWN_PAGE_DIFFERENCES = { '2025-01-09': { copyClose: 9 * 3600 + 30 * 60, pageClose: 17 * 3600 } };

function eachDay(cal, fn) {
  for (let t = Date.parse(cal.coveredFrom + 'T00:00:00Z'); t <= Date.parse(cal.coveredTo + 'T00:00:00Z'); t += DAY_MS) {
    fn(new Date(t).toISOString().slice(0, 10), t / DAY_MS);
  }
}

test('the four files are market-data\'s byte for byte', () => {
  const got = {};
  for (const name of Object.keys(PINS)) {
    const data = fs.readFileSync(path.join(SHARED, name));
    assert.ok(!data.includes(13), name + ' has a carriage return');
    got[name] = crypto.createHash('sha256').update(data).digest('hex');
  }
  assert.deepStrictEqual(got, PINS);
  const files = fs.readdirSync(SHARED).filter(n => fs.statSync(path.join(SHARED, n)).isFile()).sort();
  const clock = ['ny_clock.js', 'ny_clock.py', 'ny_clock_cases.json'];   // step 1.6, pinned by test/ny-clock.test.js
  assert.deepStrictEqual(files, Object.keys(PINS).concat(clock).sort());
});

test('the loader reads the copy and fails closed outside it', () => {
  const cal = S.loadCalendar();
  assert.strictEqual(cal.coveredFrom, '2024-01-01');
  assert.strictEqual(cal.coveredTo, '2027-12-31');
  assert.strictEqual(cal.closeTime('2026-04-03'), '09:15');
  assert.strictEqual(cal.prevSession('2026-04-06'), '2026-04-03');
  assert.throws(() => cal.isSession('2028-01-03'), S.CalendarNotCovered);
  const broken = JSON.parse(fs.readFileSync(path.join(SHARED, 'cme_calendar.json'), 'utf8'));
  broken.rows[1].close_ny = '17:30';
  assert.throws(() => S.makeCalendar(broken), S.SharedDataError);
  assert.deepStrictEqual(Object.keys(S.loadContracts()), ['NQ', 'MNQ', 'ES', 'MES']);
});

test('the page\'s CME sessions match the copy on every day', () => {
  const cal = S.loadCalendar(), differ = [];
  eachDay(cal, (iso, d) => { if (U.cmeSessionDay(d) !== cal.isSession(iso)) differ.push(iso); });
  assert.deepStrictEqual(differ, []);
});

test('the page\'s halts (13:00) and early closes (13:15) match the copy on every day', () => {
  const cal = S.loadCalendar(), differ = [];
  eachDay(cal, (iso, d) => {
    const wd = new Date(d * DAY_MS).getUTCDay();
    const year = Number(iso.slice(0, 4));
    if (wd === 0 || wd === 6) return;
    const pageHalt = U.nyseHolidays(year).has(d) && U.cmeSessionDay(d) && !U.cmeShortSessions().has(d);
    const pageEarly = U.nyseEarlyCloses(year).has(d) && U.cmeSessionDay(d);
    const sharedHalt = cal.isHolidayHalt(iso);
    const sharedEarly = cal.isEarlyClose(iso) && cal.closeTime(iso) === '13:15';
    if (pageHalt !== sharedHalt || pageEarly !== sharedEarly) differ.push(iso);
    if (sharedHalt) {
      assert.strictEqual(cal.closeTime(iso), '13:00', iso);
      assert.ok(!U.cmeClosed(d * 86400 + 12 * 3600 + 59 * 60) && U.cmeClosed(d * 86400 + 13 * 3600), iso);
    }
    if (sharedEarly) assert.ok(!U.cmeClosed(d * 86400 + 13 * 3600 + 14 * 60) && U.cmeClosed(d * 86400 + 13 * 3600 + 15 * 60), iso);
  });
  assert.deepStrictEqual(differ, []);
});

test('the page\'s abbreviated sessions are the copy\'s rows, close for close', () => {
  const cal = S.loadCalendar(), short = [...U.cmeShortSessions()];
  assert.ok(short.length > 0);
  for (const [d, close] of short) {
    const iso = new Date(d * DAY_MS).toISOString().slice(0, 10);
    assert.ok(cal.covered(iso) && cal.isEarlyClose(iso), iso + ' is an early row of the copy');
    assert.strictEqual(close, sec(cal.closeTime(iso)), iso);
  }
});

test('the page\'s session close matches the copy\'s on every session day but the pinned differences', () => {
  const cal = S.loadCalendar(), differ = {};
  eachDay(cal, (iso, d) => {
    if (!cal.isSession(iso)) return;
    const close = sec(cal.closeTime(iso)), t0 = d * 86400;
    const agrees = !U.cmeClosed(t0 - 6 * 3600) && !U.cmeClosed(t0) && !U.cmeClosed(t0 + close - 60) && U.cmeClosed(t0 + close);
    if (agrees) return;
    let pageClose = null;                                         // the page's own close: its first closed minute
    for (let s = 0; s <= 17 * 3600 && pageClose === null; s += 60) if (U.cmeClosed(t0 + s)) pageClose = s;
    differ[iso] = { copyClose: close, pageClose };
  });
  assert.deepStrictEqual(differ, KNOWN_PAGE_DIFFERENCES);
});

test('nothing in the engine or the live pages reads the copy yet', () => {
  for (const dir of ['src', 'live']) {
    for (const f of fs.readdirSync(path.join(__dirname, '..', dir))) {
      const p = path.join(__dirname, '..', dir, f);
      if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p, 'utf8').includes('shared_calendar'), p);
    }
  }
});
