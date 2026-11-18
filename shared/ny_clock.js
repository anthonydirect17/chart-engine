/*
 * The New York clock and the session date (Bot-Lab plan step 1.6): the JS module, the twin of ny_clock.py.
 *
 * Anthony's rule ("Standardize it across all trading code"): a session runs from 18:00 New York the evening
 * before to 17:00 New York on its session date, and a weekend rolls to Monday. The originals live in market-data
 * `shared/`, with the table both modules are proved by (ny_clock_cases.json); every other repo carries exact copies,
 * pinned by a sha256 test. No dependencies. In Node: require('./ny_clock.js'); in a browser: <script> gives the global
 * NyClock.
 *
 * A moment is true UTC epoch ms (a whole number) or a Date, from 2007-01-01T00:00Z (inclusive) to the start of the
 * year 2100 (exclusive); anything else is refused, so seconds or microseconds passed as ms never get an answer. The New York
 * offset comes from the US rules in code (daylight time from 02:00 on the second Sunday of March to 02:00 on the first
 * Sunday of November; they answer from 2006-11-05T06:00Z, so the first session of 2007 opens as in Python), never from
 * the browser's own time zone. Session dates are 'YYYY-MM-DD' from 2007-01-01 to the first day of 2100. A calendar is
 * SharedCalendar's (shared_calendar.js).
 *
 *   utcOffsetMinutes(m)       New York's offset from UTC at m: -240 or -300
 *   toNy(m)                   {date, time, iso, weekday (0 Monday to 6 Sunday), offsetMinutes, wallMs}
 *   nowNy()                   toNy(Date.now())
 *   nyDate(m)                 m's New York calendar date
 *   nyWallMs(m)               m's New York wall clock as ms stored as if UTC (the charts' and tickreplay's wall time)
 *   sessionDate(m, cal)       the New York date, the next day from 17:00, a Saturday or Sunday rolls to Monday; with a
 *                             calendar, a day with no session (a closed row) rolls on as a weekend does
 *   sessionDateWall(wallMs)   the same from a New York wall time in ms stored as if UTC (no calendar)
 *   sessionStart(d)           18:00 New York the evening before session date d, as UTC ms
 *   sessionEnd(d, cal)        17:00 New York on d, or the calendar's close on an early close or a holiday halt (UTC ms)
 *   inSession(m, cal)         sessionStart(d) <= m < sessionEnd(d, cal) for d = sessionDate(m, cal)
 *   isWeekend(m)              from Friday 17:00 to Sunday 18:00 New York
 *
 * In the daily break (17:00 to 18:00) no session runs: sessionDate gives the next session's date and inSession is
 * false. After an early close or a holiday halt and before 17:00, a moment keeps its session's date and inSession is
 * false. A date the calendar does not cover throws its CalendarNotCovered: no holiday is guessed.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NyClock = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MIN = 60000, HOUR = 3600000, DAY = 86400000;
  const END_YEAR = 2100;                                              // the first year refused
  const FIRST_MS = 1167609600000, END_MS = Date.UTC(END_YEAR, 0, 1);   // 2007-01-01T00:00Z, and the start of END_YEAR
  const RULES_FROM_MS = 1162706400000;                                 // 2006-11-05T06:00Z: the US rules answer from here
  const FIRST_DAY = '2007-01-01', LAST_DAY = new Date(END_MS).toISOString().slice(0, 10);
  const OPEN_MIN = 18 * 60, CLOSE_MIN = 17 * 60;
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

  function asMs(m) {
    if (m instanceof Date) m = m.getTime();
    if (typeof m !== 'number' || !Number.isInteger(m)) throw new TypeError('not a whole number of UTC ms: ' + m);
    if (m < FIRST_MS || m >= END_MS) throw new RangeError(m + ' ms is outside 2007-01-01T00:00Z to the start of ' + END_YEAR + ': not UTC ms of a moment');
    return m;
  }

  function dayOf(s) {
    if (typeof s !== 'string' || !ISO.test(s)) throw new TypeError('a session date is YYYY-MM-DD, not ' + s);
    const t = Date.parse(s + 'T00:00:00Z');
    if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== s) throw new TypeError('not a date: ' + s);
    if (s < FIRST_DAY || s > LAST_DAY) throw new RangeError(s + ' is outside the session dates answered, ' + FIRST_DAY + ' to ' + LAST_DAY);
    return t;
  }

  const isoDay = t => new Date(t).toISOString().slice(0, 10);
  const weekdayOf = t => (new Date(t).getUTCDay() + 6) % 7;          // 0 Monday to 6 Sunday

  function nthSunday(year, month, n) {                                 // month 1 to 12, as UTC midnight ms
    const first = Date.UTC(year, month - 1, 1);
    return first + (((6 - weekdayOf(first)) % 7 + 7) % 7 + 7 * (n - 1)) * DAY;
  }

  function usRulesOffsetMinutes(ms) {
    if (typeof ms !== 'number' || !Number.isInteger(ms)) throw new TypeError('not a whole number of UTC ms: ' + ms);
    if (ms < RULES_FROM_MS) throw new RangeError('the US rules in code answer from 2006-11-05T06:00Z, not ' + new Date(ms).toISOString());
    const year = new Date(ms).getUTCFullYear();
    const start = nthSunday(year, 3, 2) + 7 * HOUR, end = nthSunday(year, 11, 1) + 6 * HOUR;
    return start <= ms && ms < end ? -240 : -300;
  }

  function utcOffsetMinutes(m) { return usRulesOffsetMinutes(asMs(m)); }

  function nyWallMs(m) {
    const ms = asMs(m);
    return ms + usRulesOffsetMinutes(ms) * MIN;
  }

  function pad(n, w) { return String(n).padStart(w || 2, '0'); }

  function toNy(m) {
    const ms = asMs(m), off = usRulesOffsetMinutes(ms), w = ms + off * MIN, d = new Date(w);
    const time = pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + '.' + pad(d.getUTCMilliseconds(), 3);
    const a = Math.abs(off);
    const iso = isoDay(w) + 'T' + time + (off < 0 ? '-' : '+') + pad(Math.floor(a / 60)) + ':' + pad(a % 60);
    return { date: isoDay(w), time, iso, weekday: weekdayOf(w), offsetMinutes: off, wallMs: w };
  }

  function nowNy() { return toNy(Date.now()); }
  function nyDate(m) { return toNy(m).date; }

  function hasSession(t, cal) {
    if (weekdayOf(t) >= 5) return false;
    return !cal || cal.isSession(isoDay(t));
  }

  function roll(t, cal) {
    while (!hasSession(t, cal)) t += DAY;
    return isoDay(t);
  }

  function dateOfWall(w) {
    const day = Math.floor(w / DAY) * DAY, minute = Math.floor((w - day) / MIN);
    return minute >= CLOSE_MIN ? day + DAY : day;
  }

  function sessionDate(m, cal) { return roll(dateOfWall(nyWallMs(m)), cal); }

  function sessionDateWall(wallMs) {
    if (typeof wallMs !== 'number' || !Number.isInteger(wallMs)) throw new TypeError('not a whole number of wall ms: ' + wallMs);
    if (wallMs < FIRST_MS || wallMs >= END_MS) throw new RangeError('a wall time outside 2007-01-01 to the start of ' + END_YEAR + ': ' + wallMs);
    return roll(dateOfWall(wallMs), null);
  }

  function wallToUtc(t, minuteOfDay) {                                 // never inside a switch hour (09:15 or later)
    if (minuteOfDay < 3 * 60) throw new RangeError('a time before 03:00 can fall inside a daylight-saving switch');
    const wall = t + minuteOfDay * MIN;
    const guess = wall + 300 * MIN;                                    // the wall time read as standard time
    return wall - usRulesOffsetMinutes(guess) * MIN;
  }

  function checkSession(d, cal) {
    const t = dayOf(d);
    if (!hasSession(t, cal)) throw new RangeError('no session is dated ' + d);
    return t;
  }

  function sessionStart(d) { return wallToUtc(checkSession(d, null) - DAY, OPEN_MIN); }

  function sessionEnd(d, cal) {
    const t = checkSession(d, cal);
    if (!cal) return wallToUtc(t, CLOSE_MIN);
    const c = cal.closeTime(d);
    if (typeof c !== 'string' || !HHMM.test(c)) throw new TypeError('the calendar gave no close for ' + d);
    return wallToUtc(t, Number(c.slice(0, 2)) * 60 + Number(c.slice(3)));
  }

  function inSession(m, cal) {
    const ms = asMs(m), d = sessionDate(ms, cal);
    return sessionStart(d) <= ms && ms < sessionEnd(d, cal);
  }

  function isWeekend(m) {
    const w = nyWallMs(m), wd = weekdayOf(w), minute = Math.floor((w - Math.floor(w / DAY) * DAY) / MIN);
    return (wd === 4 && minute >= CLOSE_MIN) || wd === 5 || (wd === 6 && minute < OPEN_MIN);
  }

  return Object.freeze({
    ZONE_SOURCE: 'us-rules', FIRST_MS, END_MS, END_YEAR, FIRST_DAY, LAST_DAY, RULES_FROM_MS, SESSION_OPEN: '18:00', SESSION_CLOSE: '17:00',
    usRulesOffsetMinutes, utcOffsetMinutes, toNy, nowNy, nyDate, nyWallMs,
    sessionDate, sessionDateWall, sessionStart, sessionEnd, inSession, isWeekend,
  });
}));
