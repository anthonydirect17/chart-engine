// The shared CME calendar and contract values (Bot-Lab plan step 1.5): chart-engine's exact copy of market-data's
// shared/ folder. The four files are copied whole and pinned here by sha256 (the same pins as market-data's
// tests/test_shared_calendar.py); never edit them here.
//
// Nothing in chart-engine reads the copy yet. The page's own calendar (goodFriday, nyseHolidays, nyseEarlyCloses,
// cmeClosures, cmeSessionDay, cmeClosed) is computed by rule and differs from CME's own notice on exactly one day of
// 2026 and 2027: Good Friday 2026, which CME ran as an abbreviated session with its own trade date. Switching the page
// (and ChartBridge, its C# twin) changes that day, so it waits for Anthony's ruling. These tests pin the agreement on
// every other day.
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

test('the page\'s CME sessions differ from the copy only on Good Friday 2026', () => {
  const cal = S.loadCalendar(), differ = [];
  eachDay(cal, (iso, d) => { if (U.cmeSessionDay(d) !== cal.isSession(iso)) differ.push(iso); });
  assert.deepStrictEqual(differ, ['2026-04-03']);
});

test('the page\'s halts (13:00) and early closes (13:15) match the copy on every day', () => {
  const cal = S.loadCalendar(), differ = [];
  eachDay(cal, (iso, d) => {
    const wd = new Date(d * DAY_MS).getUTCDay();
    const year = Number(iso.slice(0, 4));
    if (wd === 0 || wd === 6) return;
    const pageHalt = U.nyseHolidays(year).has(d) && U.cmeSessionDay(d);
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

test('nothing in the engine or the live pages reads the copy yet', () => {
  for (const dir of ['src', 'live']) {
    for (const f of fs.readdirSync(path.join(__dirname, '..', dir))) {
      const p = path.join(__dirname, '..', dir, f);
      if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p, 'utf8').includes('shared_calendar'), p);
    }
  }
});
