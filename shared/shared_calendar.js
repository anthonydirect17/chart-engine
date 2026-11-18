/*
 * The shared CME calendar and contract values (Bot-Lab plan step 1.5): the JS loader, the twin of shared_calendar.py.
 *
 * The originals live in market-data `shared/`; every other repo carries exact copies, pinned by a sha256 test. No
 * dependencies. In Node: require('./shared_calendar.js'); in a browser: <script> gives the global SharedCalendar.
 *
 *   makeCalendar(data)          a calendar from the parsed cme_calendar.json
 *   makeContracts(data)         {root: contract} from the parsed contracts.json
 *   loadCalendar(path)          Node only: reads the file (default: cme_calendar.json next to this file)
 *   loadContracts(path)         Node only: reads the file (default: contracts.json next to this file)
 *
 * Dates are 'YYYY-MM-DD' strings (session dates: the New York day a session ends). Times are 'HH:MM' New York.
 * A calendar answers covered, ensureCovered, isSession, closeTime ('HH:MM' or null), isHolidayHalt, isEarlyClose,
 * holiday, entry, verified, watch, rows, sessionsBetween, nextSession and prevSession, exactly as the Python loader.
 * A date outside the table throws CalendarNotCovered: no holiday is guessed.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SharedCalendar = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const KINDS = ['closed', 'halt', 'early'];
  const CHECKS = ['cme', 'unverified'];
  const CME_PREFIX = 'https://www.cmegroup.com/';
  const ROOTS = ['NQ', 'MNQ', 'ES', 'MES'];
  const DAY_MS = 86400000;
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

  class CalendarNotCovered extends Error {
    constructor(msg) { super(msg); this.name = 'CalendarNotCovered'; }
  }
  class SharedDataError extends Error {
    constructor(msg) { super(msg); this.name = 'SharedDataError'; }
  }

  function dayNumber(s) {
    if (typeof s !== 'string' || !ISO.test(s.slice(0, 10))) throw new TypeError('not a date: ' + s);
    const t = Date.parse(s.slice(0, 10) + 'T00:00:00Z');
    if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s.slice(0, 10)) throw new TypeError('not a date: ' + s);
    return t / DAY_MS;
  }
  function isoOf(n) { return new Date(n * DAY_MS).toISOString().slice(0, 10); }
  function weekday(n) { return (n + 4) % 7; }     // 0 Sunday ... 6 Saturday (1970-01-01 was a Thursday)
  function hhmm(s, what) {
    if (typeof s !== 'string' || !HHMM.test(s)) throw new SharedDataError(what + ': ' + JSON.stringify(s) + ' is not HH:MM');
    return s;
  }
  function isCme(u) { return typeof u === 'string' && u.startsWith(CME_PREFIX); }

  function makeCalendar(data) {
    if (!data || data.schema !== 1) throw new SharedDataError('cme_calendar: schema must be 1');
    const normalClose = hhmm(data.normal_close, 'normal_close');
    const sessionOpen = hhmm(data.session_open, 'session_open');
    const from = dayNumber(data.covered_from), to = dayNumber(data.covered_to);
    if (from > to) throw new SharedDataError('cme_calendar: covered_from is after covered_to');
    const rows = new Map();
    let last = null;
    for (const r of data.rows) {
      const ds = r.date;
      if (typeof ds !== 'string' || ds.length !== 10) throw new SharedDataError('cme_calendar: ' + JSON.stringify(ds) + ' is not YYYY-MM-DD');
      const d = dayNumber(ds);
      if (last !== null && d <= last) throw new SharedDataError('cme_calendar: ' + ds + ' is out of order or twice');
      last = d;
      const wd = weekday(d);
      if (wd === 0 || wd === 6 || d < from || d > to) throw new SharedDataError('cme_calendar: ' + ds + ' is a weekend or outside the table');
      if (!KINDS.includes(r.kind)) throw new SharedDataError('cme_calendar: ' + ds + ' has an unknown kind ' + JSON.stringify(r.kind));
      if (!CHECKS.includes(r.kind_check)) throw new SharedDataError('cme_calendar: ' + ds + ' kind_check must be one of cme, unverified');
      if (r.kind === 'closed') {
        if (r.close_ny !== null || r.time_check !== null) throw new SharedDataError('cme_calendar: ' + ds + ' is closed, so close_ny and time_check are null');
      } else {
        hhmm(r.close_ny, 'cme_calendar: ' + ds + ' close_ny');
        if (r.close_ny >= normalClose) throw new SharedDataError('cme_calendar: ' + ds + ' closes at or after the normal close');
        if (!CHECKS.includes(r.time_check)) throw new SharedDataError('cme_calendar: ' + ds + ' time_check must be one of cme, unverified');
      }
      if (r.kind === 'halt' && !r.holiday) throw new SharedDataError('cme_calendar: ' + ds + ' is a holiday halt with no holiday name');
      const srcs = r.cme_sources || [];
      if (!srcs.length || !srcs.every(isCme)) throw new SharedDataError('cme_calendar: ' + ds + ' needs at least one CME source, and only CME pages there');
      if ((r.leads || []).some(u => typeof u !== 'string' || !u.startsWith('https://') || isCme(u))) throw new SharedDataError('cme_calendar: ' + ds + ' leads are non-CME https pages');
      rows.set(d, r);
    }
    const watch = new Map();
    for (const w of data.watch || []) {
      const d = dayNumber(w.date);
      if (rows.has(d) || d < from || d > to || !w.note) throw new SharedDataError('cme_calendar: watch date ' + w.date + ' has a row, is outside the table or has no note');
      watch.set(d, w.note);
    }

    function covered(s) { const d = dayNumber(s); return d >= from && d <= to; }
    function ensure(s) {
      const d = dayNumber(s);
      if (d < from || d > to) throw new CalendarNotCovered('the shared CME calendar covers ' + data.covered_from + ' to ' + data.covered_to + ', not ' + s.slice(0, 10) + ': no holiday is guessed');
      return d;
    }
    function copy(r) { return Object.assign({}, r, { cme_sources: (r.cme_sources || []).slice(), leads: (r.leads || []).slice() }); }
    function sessionN(d) {
      const wd = weekday(d);
      if (wd === 0 || wd === 6) return false;
      const r = rows.get(d);
      return !(r && r.kind === 'closed');
    }
    const cal = {
      normalClose, sessionOpen, coveredFrom: data.covered_from, coveredTo: data.covered_to,
      covered,
      ensureCovered(s) { return isoOf(ensure(s)); },
      entry(s) { const r = rows.get(ensure(s)); return r ? copy(r) : null; },
      isSession(s) { return sessionN(ensure(s)); },
      closeTime(s) {
        const d = ensure(s);
        if (!sessionN(d)) return null;
        const r = rows.get(d);
        return r ? r.close_ny : normalClose;
      },
      isHolidayHalt(s) { const r = rows.get(ensure(s)); return !!(r && r.kind === 'halt'); },
      isEarlyClose(s) { const r = rows.get(ensure(s)); return !!(r && r.kind === 'early'); },
      holiday(s) { const r = rows.get(ensure(s)); return r ? (r.holiday || null) : null; },
      verified(s) {
        const d = ensure(s), r = rows.get(d);
        if (!r) return !watch.has(d);
        return r.kind_check === 'cme' && (r.time_check === 'cme' || r.time_check === null);
      },
      watch() { const o = {}; for (const [d, n] of watch) o[isoOf(d)] = n; return o; },
      rows() { return [...rows.keys()].sort((a, b) => a - b).map(d => copy(rows.get(d))); },
      sessionsBetween(a, b) {
        const out = [];
        for (let d = ensure(a), e = ensure(b); d <= e; d++) if (sessionN(d)) out.push(isoOf(d));
        return out;
      },
      nextSession(s) {
        let d = ensure(s) + 1;
        while (!sessionN(ensure(isoOf(d)))) d++;
        return isoOf(d);
      },
      prevSession(s) {
        let d = ensure(s) - 1;
        while (!sessionN(ensure(isoOf(d)))) d--;
        return isoOf(d);
      },
    };
    return Object.freeze(cal);
  }

  function makeContracts(data) {
    if (!data || data.schema !== 1) throw new SharedDataError('contracts: schema must be 1');
    const out = {};
    for (const c of data.contracts) {
      if (Object.prototype.hasOwnProperty.call(out, c.root)) throw new SharedDataError('contracts: ' + c.root + ' twice');
      const nums = [c.point_value, c.tick_size, c.tick_value];
      if (!nums.every(x => typeof x === 'number' && x > 0)) throw new SharedDataError('contracts: ' + c.root + ' needs positive numbers');
      if (Math.abs(c.point_value * c.tick_size - c.tick_value) > 1e-9) throw new SharedDataError('contracts: ' + c.root + ' tick_value is not point_value times tick_size');
      if (!(c.cme_sources || []).length || !c.cme_sources.every(isCme)) throw new SharedDataError('contracts: ' + c.root + ' needs CME sources');
      out[c.root] = Object.freeze({ root: c.root, name: c.name, pointValue: c.point_value, tickSize: c.tick_size, tickValue: c.tick_value, micro: c.micro === undefined ? null : c.micro });
    }
    for (const c of Object.values(out)) if (c.micro !== null && !out[c.micro]) throw new SharedDataError('contracts: ' + c.root + ' names an unknown micro ' + c.micro);
    if (Object.keys(out).join(',') !== ROOTS.join(',')) throw new SharedDataError('contracts: the roots must be ' + ROOTS.join(', ') + ' in that order');
    return Object.freeze(out);
  }

  function readJson(path, name) {
    if (typeof require !== 'function') throw new Error('loading a file needs Node: pass the parsed JSON to make' + name);
    const fs = require('fs'), p = require('path');
    return JSON.parse(fs.readFileSync(path || p.join(__dirname, name === 'Calendar' ? 'cme_calendar.json' : 'contracts.json'), 'utf8'));
  }

  return {
    CalendarNotCovered, SharedDataError, KINDS, ROOTS,
    makeCalendar, makeContracts,
    loadCalendar(path) { return makeCalendar(readJson(path, 'Calendar')); },
    loadContracts(path) { return makeContracts(readJson(path, 'Contracts')); },
  };
}));
