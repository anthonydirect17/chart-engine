"""Markup Studio: grade NQ liquidity sweeps on the chart-engine charts, to turn reads into bot mechanics.

    py -3 tools\\markup_studio.py            then open http://localhost:8790/live/markup.html (opened for you)

Read only: no orders, no trading of any kind. It serves this repo's live/ and src/ files and speaks the read-only part of
ChartBridge's WebSocket protocol (nt8/PROTOCOL.md: hello, history, ticks, ready, tick, status) so the page mounts the
same charts as the live pages (ChartLive.mount, live/EMBED.md). One day is loaded at a time with a REPLAY CLOCK: every
path to the page (history, ticks, live ticks, the machine read, every endpoint) is cut at the clock by
visible_count() below, the one place that decides how many ticks exist.

Flags (defaults are the HOME PC's folders):
  --tickreplay=E:\\SchwabDesk_bulk\\tickreplay   the canonical loader (load_session)
  --data=E:\\SchwabDesk_bulk\\ticks_packed       its data_root
  --marks=E:\\SchwabDesk_bulk\\marks             grades, marks_log.jsonl, chips.json, candidates_v1.json, marks_export.csv
  --seen=PATH[,PATH]                            CSVs of events already seen (default: tickbench's sweep_blind KEY.csv and
                                                eventstudy_r1 prints, when present)
  --rule=tools/markup_rule_v0.json              the rule draft's thresholds
  --port=8790   --symbol=NQ   --no-browser
  --include-last-only                           blind queue also offers last-only days (volume is all 1 there; off by default)
  --check[=YYYY-MM-DD]                          load one in-sample day through the loader, print what the Studio sees, exit
  --source=npz                                  tests: <data>/<SYMBOL>_<YYYY-MM-DD>.npz with wall_ms, price, volume[, bid, ask]
Holdout: any date from 2026-04-01 on is refused everywhere (listing, loading, candidates, free mode).
Python 3.10+, stdlib + numpy only.
"""
from __future__ import annotations

import base64
import csv
import hashlib
import importlib
import json
import math
import mimetypes
import os
import re
import socket
import sys
import threading
import time
import webbrowser
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import markup_core as core  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION = 'markup-studio-1'
CACHE_VERSION = 3          # 3: ONH/ONL only with overnight ticks; candidates carry their quote type
SETUPS = ('SWEEP', 'RETEST', 'NONE', 'WAIT')
SPEEDS = (1, 5, 20, 60)
MARK_ROLES = ('Level', 'Failed candle', 'Reclaim candle', 'Entry', 'Stop', 'Target')
SPAN_ROLES = ("Volume I'm reading", 'Approach')


def visible_count(day, clock_utc, exclusive=False):
    """NO-FUTURE: the number of ticks the page may have at this clock: at or before it, or (exclusive, blind mode) strictly
    before it, so the next candle's first trade stamped exactly at the cut stays hidden. Every data path cuts here."""
    return int(np.searchsorted(day.utc, clock_utc, 'left' if exclusive else 'right'))


# ------------------------------------------------------------------------------------------------ data sources
class NpzSource:
    """Synthetic days for tests: <folder>/<SYMBOL>_<YYYY-MM-DD>.npz (wall_ms, price, volume, optional bid and ask)."""

    def __init__(self, folder, symbol):
        self.folder, self.symbol = folder, symbol

    def days(self):
        out = []
        for n in sorted(os.listdir(self.folder)) if os.path.isdir(self.folder) else []:
            m = re.fullmatch(re.escape(self.symbol) + r'_(\d{4}-\d{2}-\d{2})\.npz', n)
            if m and core.in_sample(m.group(1)):
                out.append(m.group(1))
        return out

    def load(self, d):
        d = core.check_date(d)
        z = np.load(os.path.join(self.folder, f'{self.symbol}_{d}.npz'))
        bid = z['bid'] if 'bid' in z.files else None
        ask = z['ask'] if 'ask' in z.files else None
        return core.Day(d, z['wall_ms'], z['price'], z['volume'], bid, ask)


class TickReplayError(RuntimeError):
    pass


def _yes(v):
    return str(v).strip().lower() in ('yes', 'true', '1')


class TickReplaySource:
    """The canonical loader on the HOME PC (tickreplay 1f9e04b): `loader.py` in the tickreplay folder,
    loader.load_session(symbol, session_date, data_root=...) -> Session (corrections applied), Session.ticks: Ticks with
    ts_ms (int64 New York wall-clock ms stored as if UTC), last, bid, ask (float64, all NaN on last-only days), vol,
    has_quotes. Days come from <tickreplay>/sessions_index.csv with the research's in-sample filter: the symbol's rows dated
    before 2026-04-01 (the holdout lock), without holiday_close, missing_day or truncated. Days with no morning (first
    RTH tick after noon) are dropped when the scan loads them (Studio._scan)."""

    INDEX_COLS = ('symbol', 'session_date', 'holiday_close', 'missing_day', 'truncated', 'has_quotes', 'n_ticks')
    TICK_FIELDS = ('ts_ms', 'last', 'bid', 'ask', 'vol', 'has_quotes')

    def __init__(self, tickreplay_dir, data_root, symbol):
        self.dir, self.data_root, self.symbol = os.path.abspath(tickreplay_dir), data_root, symbol
        if not os.path.isfile(os.path.join(self.dir, 'loader.py')):
            raise TickReplayError(f'no loader.py in {self.dir} (give the tickreplay folder with --tickreplay=PATH)')
        if self.dir not in sys.path:
            sys.path.insert(0, self.dir)
        sys.modules.pop('loader', None)
        self.mod = importlib.import_module('loader')
        if not callable(getattr(self.mod, 'load_session', None)):
            raise TickReplayError(f'{self.dir}/loader.py has no load_session(symbol, session_date, data_root=...)')
        self.index = os.path.join(self.dir, 'sessions_index.csv')

    def rows(self):
        try:
            with open(self.index, newline='', encoding='utf-8-sig') as f:
                rd = csv.DictReader(f)
                missing = [c for c in self.INDEX_COLS if c not in (rd.fieldnames or [])]
                if missing:
                    raise TickReplayError(f'{self.index} has no column {", ".join(missing)}')
                return list(rd)
        except OSError as e:
            raise TickReplayError(f'cannot read {self.index}: {e}') from e

    def days(self):
        out = set()
        for r in self.rows():
            d = str(r['session_date']).strip()[:10]
            if r['symbol'].strip().upper() != self.symbol.upper() or not core.in_sample(d):
                continue
            if _yes(r['holiday_close']) or _yes(r['missing_day']) or _yes(r['truncated']):
                continue
            out.add(d)
        return sorted(out)

    def load(self, d):
        d = core.check_date(d)                       # the holdout lock, before the loader runs
        s = self.mod.load_session(self.symbol, d, data_root=self.data_root)
        t = getattr(s, 'ticks', None)
        missing = [f for f in self.TICK_FIELDS if not hasattr(t, f)]
        if t is None or missing:
            raise TickReplayError('tickreplay Session.ticks has no ' + ', '.join(missing or ['ticks']) + '; the adapter in tools/markup_studio.py needs updating')
        wall = np.asarray(t.ts_ms, dtype=np.int64)
        if wall.size == 0:
            raise TickReplayError(f'tickreplay has no ticks for {self.symbol} {d} in {self.data_root}')
        q = bool(t.has_quotes)
        bid = np.asarray(t.bid, dtype=np.float64) if q else None
        ask = np.asarray(t.ask, dtype=np.float64) if q else None
        return core.Day(d, wall, np.asarray(t.last, dtype=np.float64), np.asarray(t.vol, dtype=np.int64), bid, ask)


# ------------------------------------------------------------------------------------------------ the studio
class Refused(Exception):
    pass


class Studio:
    def __init__(self, source, marks_dir, rule_path, seen_paths=(), symbol='NQ', include_last_only=False):
        self.source, self.marks, self.rule_path, self.symbol = source, marks_dir, rule_path, symbol
        self.include_last_only = include_last_only     # blind queue: quote days only unless --include-last-only
        self.seen_report = []
        self.seen = core.read_seen([p for p in seen_paths if p and os.path.isfile(p)], self.seen_report)
        self.lock = threading.RLock()
        self.clients = set()
        self.day = None
        self.mode = 'blind'
        self.clock = 0
        self.playing, self.speed, self.anchor = False, 0, (0.0, 0)
        self.steps, self.graded, self.cand, self.cand_no, self.level = 0, False, None, 0, None
        self.scan = {'running': False, 'done': False, 'days': 0, 'total': 0, 'skipped': 0, 'skipped_days': [], 'error': ''}
        self.candidates, self.order, self.by_date, self.passed = [], [], {}, set()
        self.seen_ids = set()
        self.cache_lock, self.frames_key, self.frames, self.load_seq = threading.Lock(), None, [], 0
        os.makedirs(marks_dir, exist_ok=True)
        self.grades = core.list_grades(marks_dir)            # read once; save() appends (state() never reads files)
        self.graded_ids = {g.get('id') for g in self.grades}
        self._queue = None
        for r in self.seen_report:
            if r['rows'] and not r['parsed']:
                log(f'already-seen file {r["path"]}: {r["rows"]} rows but none had a date and a reclaim time; columns: {", ".join(r["columns"])}')

    # ---------------------------------------------------------------- candidates
    def start_scan(self, background=True):
        self.scan['running'] = True
        if background:
            threading.Thread(target=self._scan, daemon=True).start()
        else:
            self._scan()

    def _publish(self, items):
        """Candidates so far (a partial scan can be graded from): shuffled with seed 4 within what is scanned."""
        items = [c for c in items if core.in_sample(c['date'])]
        seen = {c['id'] for c in items if core.is_seen(c, self.seen)}
        order = core.shuffled(items, 4)
        by_date = {}
        for c in items:
            by_date.setdefault(c['date'], []).append(c)
        with self.lock:
            self.candidates, self.order, self.by_date, self.seen_ids = items, order, by_date, seen
            self._queue = None

    def _scan(self):
        """Every in-sample day once, in date order, cached in candidates_v1.json. A day that fails to load is logged and
        skipped (counted in the page) and the PDH/PDL chain goes on from the last day that loaded with RTH ticks."""
        path = os.path.join(self.marks, 'candidates_v1.json')
        try:
            cache = {}
            try:
                with open(path, encoding='utf-8') as f:
                    cache = json.load(f)
            except (OSError, ValueError):
                pass
            ok = cache.get('version') == CACHE_VERSION and cache.get('symbol') == self.symbol
            done = dict(cache.get('days', {})) if ok else {}       # date -> {'prev': hilo used, 'hilo': hilo passed on}
            items = [c for c in cache.get('items', []) if c['date'] in done] if ok else []
            days = self.source.days()
            self.scan['total'] = len(days)
            prev = None
            dirty = 0
            for k, d in enumerate(days):
                rec = done.get(d)
                if rec is not None and rec.get('prev') == prev:
                    prev = rec.get('hilo')
                else:
                    try:
                        day = self.source.load(d)
                        if core.has_morning(day):
                            found = core.find_candidates(day, tuple(prev) if prev else None)
                            hl = core.rth_hilo(day)
                            hilo = list(hl) if hl else prev
                        else:                                  # not a kept day (the research's rule)
                            found, hilo = [], prev
                    except Exception as e:   # noqa: BLE001 - one bad day never stops the scan
                        log(f'scan: skipped {d}: {e}')
                        self.scan['skipped'] += 1
                        self.scan['skipped_days'].append(d)
                        self.scan['days'] = k + 1
                        continue
                    items = [c for c in items if c['date'] != d] + found
                    done[d] = {'prev': prev, 'hilo': hilo}
                    prev = hilo
                    dirty += 1
                    if found:
                        self._publish(items)
                    if dirty % 10 == 0:
                        self._write_cache(path, items, done)
                self.scan['days'] = k + 1
            self._publish(items)
            self._write_cache(path, items, done)
            self.scan.update(done=True, running=False)
        except Exception as e:   # noqa: BLE001 - shown on the page
            log(f'scan failed: {e}')
            self.scan.update(running=False, error=str(e))

    def _write_cache(self, path, items, days):
        try:
            core.write_text(path, json.dumps({'version': CACHE_VERSION, 'symbol': self.symbol, 'days': days, 'items': items}))
        except OSError as e:
            log(f'could not write {path}: {e}')

    def _skip(self, c):
        if not self.include_last_only and not c.get('quotes', True):
            return True                                   # blind grading reads volume: quote days only by default
        return c['id'] in self.graded_ids or c['id'] in self.seen_ids or not core.in_sample(c['date'])

    def queue(self):
        with self.lock:
            if self._queue is None:
                order = self.order
                self._queue = {'total': len(order), 'excluded_seen': sum(1 for c in order if c['id'] in self.seen_ids),
                               'graded': sum(1 for c in order if c['id'] in self.graded_ids),
                               'remaining': sum(1 for c in order if not self._skip(c))}
            return self._queue

    def warnings(self):
        out = []
        for r in self.seen_report:
            name = os.path.basename(r['path'])
            if r['rows'] and not r['parsed']:
                out.append(f'{name} found but 0 rows matched: already-seen not excluded')
        if self.scan['done'] and self.seen and not self.seen_ids and not out:
            out.append(f'{len(self.seen)} already-seen rows read but none matched a candidate: already-seen not excluded')
        if self.scan['skipped']:
            out.append(f'{self.scan["skipped"]} day(s) could not be loaded and were skipped (see the window it runs in)')
        return out

    # ---------------------------------------------------------------- loading and the clock
    @property
    def exclusive(self):
        return self.mode == 'blind'

    def blind_open(self):
        """An ungraded blind candidate is open: nothing may show its future or its date until the grade is saved."""
        return self.mode == 'blind' and self.day is not None and not self.graded

    def _load(self, d, clock_utc, mode):
        day = self.source.load(d)            # refuses the holdout
        with self.lock:
            self._drop_clients()
            self.day, self.mode, self.clock = day, mode, int(clock_utc)
            self.load_seq += 1
            self.playing, self.speed = False, 0
            self.steps, self.graded = 0, False

    def blind_next(self):
        with self.lock:
            order = [c for c in self.order if not self._skip(c)]
            if not order:
                raise Refused('no candidates yet: the scan is still running' if not self.scan['done'] else 'no candidates left to grade')
            fresh = [c for c in order if c['id'] not in self.passed]
            if not fresh:                                     # every one was opened and passed over: start the round again
                self.passed.clear()
                fresh = order
            c = fresh[0]
            self.passed.add(c['id'])
        self._load(c['date'], c['cut_utc_ms'], 'blind')
        with self.lock:
            self.cand, self.level = c, {'type': c['level_type'], 'price': c['level_price']}
            self.cand_no += 1
        return self.state()

    def _free_allowed(self):
        if self.blind_open():
            raise Refused('a blind candidate is open: save its grade first, then use Free mode')

    def free_load(self, d, tod=None, clock_utc=None, level=None):
        with self.lock:
            self._free_allowed()
        d = core.check_date(d)
        if clock_utc is None:
            hh, mm = parse_hhmm(tod or '09:30')
            base = d if hh < 18 else (core.parse_date(d) - timedelta(days=1)).isoformat()
            clock_utc = int(core.wall_to_utc([core.wall_of(base, hh, mm)])[0])
        self._load(d, clock_utc, 'free')
        with self.lock:
            self.cand, self.level = None, level
        return self.state()

    def _need_day(self):
        if self.day is None:
            raise Refused('no day loaded')

    def _blind_locked(self):
        if self.blind_open():
            raise Refused('in blind mode the clock only steps one candle at a time until the grade is saved')

    def step(self):
        with self.lock:
            self._need_day()
            self.playing = False
            self.clock = (self.clock // core.MIN + 1) * core.MIN
            if self.blind_open():
                self.steps += 1
            self._release()
        return self.state()

    def play(self, speed):
        with self.lock:
            self._need_day()
            self._blind_locked()
            if speed not in SPEEDS:
                raise Refused('speed must be one of 1, 5, 20, 60')
            self.playing, self.speed, self.anchor = True, speed, (time.monotonic(), self.clock)
        return self.state()

    def pause(self):
        with self.lock:
            self.playing = False
        return self.state()

    def jump(self, tod=None, minutes=None):
        with self.lock:
            self._need_day()
            self._blind_locked()
            if minutes is not None:
                m = float(minutes)
                if not math.isfinite(m) or m <= 0 or m > 24 * 60:
                    raise Refused('minutes must be a number from 1 to 1440')
                to = self.clock + int(m * core.MIN)
            else:
                hh, mm = parse_hhmm(tod)
                base = self.day.date if hh < 18 else (core.parse_date(self.day.date) - timedelta(days=1)).isoformat()
                to = int(core.wall_to_utc([core.wall_of(base, hh, mm)])[0])
            if to <= self.clock:
                raise Refused('the clock never moves backward: load the day again at an earlier time')
            self.playing = False
            self.clock = to
            self._drop_clients()          # the page mounts its charts again and loads up to the new clock
        return self.state()

    def tick_clock(self):
        """The player: called every few tens of ms."""
        with self.lock:
            if not self.playing or self.day is None:
                return
            t0, c0 = self.anchor
            to = c0 + int((time.monotonic() - t0) * 1000 * self.speed)
            end = int(self.day.utc[-1]) + 1 if len(self.day) else self.clock
            if to >= end:
                to, self.playing = max(end, self.clock), False
            if to > self.clock:
                self.clock = to
                self._release()

    # ---------------------------------------------------------------- what the page may see
    def n_visible(self):
        return visible_count(self.day, self.clock, self.exclusive)

    def vis(self):
        return self.day.upto(self.n_visible())

    def state(self):
        """Polled by the page every 250 ms: no file reads, no scans (the queue counts are cached)."""
        q = self.queue() if self.order or self.scan['done'] else None
        with self.lock:
            s = {'mode': self.mode, 'loaded': self.day is not None, 'playing': self.playing, 'speed': self.speed,
                 'scan': {k: self.scan[k] for k in ('running', 'done', 'days', 'total', 'skipped', 'error')},
                 'queue': q, 'warnings': self.warnings(), 'blind_open': self.blind_open(), 'version': VERSION}
            if self.day is not None:
                s.update(clock_utc_ms=self.clock, clock_tod=core.fmt_tod(core.utc_to_wall(self.clock)), steps=self.steps,
                         graded=self.graded, level=self._level()[0])
                if self.mode == 'free':
                    s['date'] = self.day.date
                elif self.cand:
                    s['candidate'] = {'n': self.cand_no, 'ref': ref_of(self.cand['id'])}
            return s

    def machine(self, level=None):
        with self.lock:
            self._need_day()
            if self.blind_open():
                raise Refused('the machine read stays hidden in blind mode until the grade is saved')
            cross = self.cand['cross_utc_ms'] if self.mode == 'blind' and self.cand else None
            lv = level
            if lv is None:
                cur, cross2 = self._level()
                lv = (cur or {}).get('price')
                cross = cross if cross is not None else cross2
            if lv is None:
                return {'ok': False, 'why': 'mark a Level (or open a candidate) to read it'}
            return core.machine_read(self.vis(), self.clock, float(lv), cross, exclusive=self.exclusive)

    def _level(self):
        """The level in force and its cross: the open candidate's, the one set in free mode, or else (free mode) the day's
        latest candidate whose cross is at or before the clock."""
        if self.level:
            return self.level, (self.cand or {}).get('cross_utc_ms')
        if self.mode == 'free' and self.day is not None:
            past = [c for c in self.by_date.get(self.day.date, ()) if c['cross_utc_ms'] <= self.clock]
            if past:
                c = max(past, key=lambda x: x['cross_utc_ms'])
                return {'type': c['level_type'], 'price': c['level_price']}, c['cross_utc_ms']
        return None, None

    # ---------------------------------------------------------------- grades
    def save(self, p):
        with self.lock:
            self._need_day()
            if self.mode == 'blind' and self.graded:
                raise Refused('this candidate is graded already')
            setup = p.get('setup')
            if setup not in SETUPS:
                raise Refused('pick a setup: SWEEP, RETEST, NONE or WAIT')
            direction = p.get('direction')
            if direction not in ('LONG', 'SHORT', None):
                raise Refused('direction must be LONG or SHORT')
            if setup in ('SWEEP', 'RETEST') and not direction:
                raise Refused('pick a direction (L or S)')
            reason = str(p.get('reason') or '').strip()[:2000]
            chips = [str(c)[:80] for c in (p.get('chips') or [])][:40]
            if setup != 'NONE' and not reason and not chips:
                raise Refused('give a reason: type it or click a chip')

            def to_utc(t):
                t = float(t)
                if not math.isfinite(t):
                    raise Refused('a mark has no time')
                return int(core.wall_to_utc([round(t * 1000)])[0])
            marks = [{'role': m['role'], 'chart': m.get('chart'), 'bar_time_utc_ms': to_utc(m['t']), 'bar_tod': core.fmt_tod(round(float(m['t']) * 1000)),
                      'price': float(m['price'])} for m in (p.get('marks') or []) if m.get('role') in MARK_ROLES]
            spans = []
            for s in p.get('spans') or []:
                if s.get('role') not in SPAN_ROLES:
                    continue
                a, b = sorted((float(s['t0']), float(s['t1'])))
                spans.append({'role': s['role'], 'chart': s.get('chart'), 'from_utc_ms': to_utc(a), 'to_utc_ms': to_utc(b), 'seconds': round(b - a, 3)})
            level, auto_cross = self._level()
            if self.mode == 'free':
                lm = [m for m in marks if m['role'] == 'Level']
                if p.get('level') and p['level'].get('price') is not None:
                    level = {'type': p['level'].get('type') or 'marked', 'price': float(p['level']['price'])}
                elif lm:
                    level = {'type': 'marked', 'price': lm[-1]['price']}
            cross = self.cand['cross_utc_ms'] if self.cand else auto_cross if level is not None and level == self._level()[0] else None
            mr = core.machine_read(self.vis(), self.clock, float(level['price']), cross, exclusive=self.exclusive) if level else {'ok': False, 'why': 'no level'}
            rule = core.load_rule(self.rule_path)
            draft = core.draft_verdict(mr, rule)
            clock_wall = core.utc_to_wall(self.clock)
            blind = self.mode == 'blind'
            gid = self.cand['id'] if blind else 'F' + self.day.date.replace('-', '') + '_' + core.fmt_tod(clock_wall).replace(':', '')
            item = {'id': gid, 'mode': self.mode, 'date': self.day.date, 'symbol': self.symbol, 'setup': setup, 'direction': direction,
                    'reason': reason, 'chips': chips, 'marks': marks, 'spans': spans,
                    'steps_after_cut': self.steps if blind else None, 'cut_exclusive': blind,
                    'clock_utc_ms': self.clock, 'clock_tod': core.fmt_tod(clock_wall),
                    'level_type': (level or {}).get('type'), 'level_price': (level or {}).get('price'),
                    'candidate': self.cand, 'machine_read': mr, 'draft': draft, 'agrees_with_draft': core.agrees(setup, draft['verdict']),
                    'saved_utc': datetime.now(timezone.utc).isoformat(timespec='seconds')}
            path = core.save_grade(self.marks, item)
            self.grades.append(item)
            self.graded_ids.add(gid)
            self._queue = None
            if blind:
                self.graded = True
            return {'ok': True, 'file': os.path.basename(path) if not blind else 'grade ' + ref_of(gid), 'machine_read': mr, 'draft': draft,
                    'agrees_with_draft': item['agrees_with_draft'], 'agreement': self.agreement()}

    def agreement(self):
        """Anthony's SWEEP against the draft's TAKE, over every saved grade with a verdict. Each disagreement carries an
        opaque ref and the time of day; the id and the date only in free mode (never while in blind mode)."""
        with self.lock:
            gs = [g for g in self.grades if (g.get('draft') or {}).get('verdict') in ('TAKE', 'PASS')]
            blind = self.mode == 'blind'
        agree = sum(1 for g in gs if g.get('agrees_with_draft'))
        dis = []
        for g in gs:
            if g.get('agrees_with_draft'):
                continue
            d = {'ref': ref_of(g['id']), 'tod': g.get('clock_tod'), 'setup': g.get('setup'), 'verdict': g['draft']['verdict']}
            if not blind:
                d.update(id=g['id'], date=g.get('date'))
            dis.append(d)
        return {'agree': agree, 'total': len(gs), 'disagreements': dis}

    def list_items(self):
        with self.lock:
            blind = self.mode == 'blind'
            return [{'ref': ref_of(g.get('id')), 'setup': g.get('setup')} if blind else {'id': g.get('id'), 'setup': g.get('setup')}
                    for g in self.grades]

    def open_grade(self, ref):
        with self.lock:
            self._free_allowed()
            g = next((x for x in reversed(self.grades) if ref in (ref_of(x.get('id')), x.get('id'))), None)
        if g is None:
            raise Refused('no grade with that reference')
        lv = {'type': g.get('level_type'), 'price': g.get('level_price')} if g.get('level_price') is not None else None
        return self.free_load(g['date'], clock_utc=g['clock_utc_ms'], level=lv)

    def chips(self):
        try:
            with open(os.path.join(self.marks, 'chips.json'), encoding='utf-8') as f:
                extra = [str(x) for x in json.load(f)]
        except (OSError, ValueError):
            extra = []
        return core.DEFAULT_CHIPS + [x for x in extra if x not in core.DEFAULT_CHIPS]

    def add_chip(self, text):
        text = re.sub(r'\s+', ' ', str(text)).strip()[:60]
        if not text:
            raise Refused('a chip needs some text')
        with self.lock:
            extra = [x for x in self.chips() if x not in core.DEFAULT_CHIPS]
            if text not in extra and text not in core.DEFAULT_CHIPS:
                extra.append(text)
            core.write_text(os.path.join(self.marks, 'chips.json'), json.dumps(extra, indent=1))
        return self.chips()

    # ---------------------------------------------------------------- the charts' WebSocket (read only)
    def _drop_clients(self):
        for c in list(self.clients):
            c.close()
        self.clients.clear()

    def ws_open(self, c):
        with self.lock:
            self.clients.add(c)
            now = self.clock
        c.send({'type': 'hello', 'version': VERSION, 'now': now, 'accounts': [],
                'instruments': [{'root': self.symbol, 'name': self.symbol + ' replay', 'tick': core.TICK, 'pointValue': 20}]})
        c.send({'type': 'execs', 'list': []})

    def ws_message(self, c, m):
        if not isinstance(m, dict) or m.get('type') != 'subscribe':
            return                                   # read only: everything else (orders included) is ignored
        r = self.symbol
        with self.lock:
            if self.day is None or m.get('root') != r:
                c.send({'type': 'status', 'level': 'info', 'text': 'No day loaded' if self.day is None else 'Markup Studio serves ' + r + ' only'})
                return
            day, n, seq = self.day, self.n_visible(), self.load_seq
            c.ready, c.sent = False, n
        c.send_raw(self._load_frames(day, n, seq))         # the heavy part runs outside the lock (the page's polls go on)
        with self.lock:
            if self.day is not day or c.closed:
                return
            c.send({'type': 'ready', 'root': r})
            c.ready = True
            self._release()                           # the trades the clock passed meanwhile

    def _load_frames(self, day, n, seq):
        """The load's history and ticks messages as WebSocket frames, encoded once per day and cut: both charts subscribe to
        the same load, so the second gets the same bytes (a full day is some 30 MB of JSON)."""
        key = (seq, n)
        with self.cache_lock:
            if self.frames_key == key:
                return self.frames
            r, v = self.symbol, day.upto(n)
            bars = core.minute_bars(v)
            out = [ws_frame(json.dumps({'type': 'history', 'root': r, 'name': r + ' replay', 'barSeconds': 60, 'bars': bars[i:i + 4000],
                                        'done': i + 4000 >= len(bars)}, separators=(',', ':'))) for i in range(0, max(1, len(bars)), 4000)]
            out += [ws_frame(json.dumps({'type': 'ticks', 'root': r, 'ticks': tick_rows(v, i, min(n, i + 20000)), 'done': i + 20000 >= n},
                                        separators=(',', ':'))) for i in range(0, max(1, n), 20000)]
            self.frames_key, self.frames = key, out
            return out

    def _release(self):
        """Live ticks up to the clock to every chart that is loaded."""
        if self.day is None:
            return
        n = self.n_visible()
        for c in list(self.clients):
            if c.ready and c.sent < n:
                c.send_many([tick_msg(self.day, i, self.symbol) for i in range(c.sent, n)])
                c.sent = n


def ref_of(gid):
    """An opaque reference for a candidate or grade id (the ids carry the date)."""
    return 'G' + hashlib.sha1(str(gid).encode()).hexdigest()[:10]


def parse_hhmm(text):
    m = re.fullmatch(r'\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*', str(text or ''))
    if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
        raise Refused('give the time as HH:MM')
    return int(m.group(1)), int(m.group(2))


def log(text):
    print(text, file=sys.stderr, flush=True)



def tick_rows(day, a, b):
    """Trades as ChartBridge 0.3.4 sends them: [t, p, v, s, sm]."""
    t = np.round(day.wall[a:b] / 1000, 3).tolist()
    return [list(x) for x in zip(t, day.px[a:b].tolist(), day.vol[a:b].tolist(), day.side[a:b].tolist(), day.sm[a:b].tolist())]


def tick_msg(day, i, root):
    return {'type': 'tick', 'root': root, 't': round(int(day.wall[i]) / 1000, 3), 'p': float(day.px[i]), 'v': int(day.vol[i]),
            's': int(day.side[i]), 'sm': int(day.sm[i])}


# ------------------------------------------------------------------------------------------------ a small WebSocket
def ws_frame(text):
    data = text.encode('utf-8')
    n = len(data)
    head = bytes([0x81, n]) if n < 126 else bytes([0x81, 126]) + n.to_bytes(2, 'big') if n < 65536 else bytes([0x81, 127]) + n.to_bytes(8, 'big')
    return head + data


class WsClient:
    def __init__(self, sock):
        self.sock, self.wlock, self.ready, self.sent, self.closed = sock, threading.Lock(), False, 0, False

    def _write(self, data):
        if self.closed:
            return
        try:
            with self.wlock:
                self.sock.sendall(data)
        except OSError:
            self.closed = True

    def send(self, obj):
        self._write(ws_frame(json.dumps(obj, separators=(',', ':'))))

    def send_raw(self, frames):
        for f in frames:
            self._write(f)

    def send_many(self, objs):
        self._write(b''.join(ws_frame(json.dumps(o, separators=(',', ':'))) for o in objs))

    def close(self):
        if not self.closed:
            self._write(b'\x88\x00')
            self.closed = True
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def frames(self):
        buf = b''
        while not self.closed:
            try:
                chunk = self.sock.recv(65536)
            except OSError:
                return
            if not chunk:
                return
            buf += chunk
            while len(buf) >= 2:
                op, n, p = buf[0] & 0x0F, buf[1] & 0x7F, 2
                if n == 126:
                    if len(buf) < 4:
                        break
                    n, p = int.from_bytes(buf[2:4], 'big'), 4
                elif n == 127:
                    if len(buf) < 10:
                        break
                    n, p = int.from_bytes(buf[2:10], 'big'), 10
                masked = buf[1] & 0x80
                if len(buf) < p + (4 if masked else 0) + n:
                    break
                mask = buf[p:p + 4] if masked else b'\0\0\0\0'
                p += 4 if masked else 0
                data = bytes(b ^ mask[i & 3] for i, b in enumerate(buf[p:p + n]))
                buf = buf[p + n:]
                if op == 8:
                    return
                if op == 9:
                    self._write(bytes([0x8A, len(data)]) + data if len(data) < 126 else b'')
                elif op == 1:
                    yield data.decode('utf-8', 'replace')


# ------------------------------------------------------------------------------------------------ HTTP
TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
         '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png'}


def make_handler(studio, port):
    own = {f'http://localhost:{port}', f'http://127.0.0.1:{port}'}
    hosts = {f'localhost:{port}', f'127.0.0.1:{port}'}

    class H(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *a):
            pass

        def _gate(self):
            if self.client_address[0] not in ('127.0.0.1', '::1', '::ffff:127.0.0.1'):
                return 'this PC only'
            if self.headers.get('Host') not in hosts:
                return 'bad host'
            o = self.headers.get('Origin')
            if o is not None and o not in own:
                return 'other origins are refused'
            return None

        def _json(self, code, obj):
            body = json.dumps(obj).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            why = self._gate()
            if why:
                return self._json(403, {'error': why})
            u = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            if u.path == '/ws' and self.headers.get('Upgrade', '').lower() == 'websocket':
                return self._ws()
            try:
                if u.path == '/':
                    self.send_response(302)
                    self.send_header('Location', '/live/markup.html')
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                if u.path == '/api/state':
                    return self._json(200, studio.state())
                if u.path == '/api/days':
                    return self._json(200, {'days': studio.source.days()})
                if u.path == '/api/machine':
                    return self._json(200, studio.machine(float(q['level']) if q.get('level') else None))
                if u.path == '/api/chips':
                    return self._json(200, {'chips': studio.chips()})
                if u.path == '/api/agreement':
                    return self._json(200, studio.agreement())
                if u.path == '/markup/list':
                    return self._json(200, {'items': studio.list_items()})
            except Refused as e:
                return self._json(409, {'error': str(e)})
            except (ValueError, KeyError, TypeError, OverflowError) as e:
                return self._json(400, {'error': str(e)})
            except OSError as e:
                return self._json(500, {'error': str(e)})
            return self._static(u.path)

        def do_POST(self):
            why = self._gate()
            if why:
                return self._json(403, {'error': why})
            try:
                n = int(self.headers.get('Content-Length') or 0)
            except ValueError:
                self.close_connection = True
                return self._json(400, {'error': 'bad Content-Length'})
            if n < 0 or n > 1_000_000:
                self.close_connection = True
                return self._json(413 if n > 0 else 400, {'error': 'bad Content-Length'})
            try:
                p = json.loads(self.rfile.read(n) or b'{}') if n else {}
            except (ValueError, UnicodeDecodeError):
                return self._json(400, {'error': 'not JSON'})
            if not isinstance(p, dict):
                return self._json(400, {'error': 'send a JSON object'})
            path = urlparse(self.path).path
            try:
                if path == '/api/blind/next':
                    return self._json(200, studio.blind_next())
                if path == '/api/free/load':
                    return self._json(200, studio.free_load(p.get('date'), p.get('time')))
                if path == '/api/free/open':
                    return self._json(200, studio.open_grade(p.get('ref') or p.get('id')))
                if path == '/api/step':
                    return self._json(200, studio.step())
                if path == '/api/play':
                    return self._json(200, studio.play(int(p.get('speed', 1))))
                if path == '/api/pause':
                    return self._json(200, studio.pause())
                if path == '/api/jump':
                    return self._json(200, studio.jump(p.get('time'), p.get('minutes')))
                if path == '/api/reveal':
                    return self._json(200, studio.play(5))
                if path == '/api/chips':
                    return self._json(200, {'chips': studio.add_chip(p.get('text', ''))})
                if path == '/api/export':
                    dest, rows = core.export_csv(studio.marks)
                    return self._json(200, {'file': dest, 'rows': rows})
                if path == '/markup/save':
                    return self._json(200, studio.save(p))
            except core.HoldoutError as e:
                return self._json(403, {'error': str(e)})
            except Refused as e:
                return self._json(409, {'error': str(e)})
            except (ValueError, KeyError, TypeError, OverflowError) as e:
                return self._json(400, {'error': str(e)})
            except OSError as e:
                return self._json(500, {'error': str(e)})
            return self._json(404, {'error': 'no such endpoint'})

        def _static(self, path):
            rel = os.path.normpath(path.lstrip('/'))
            if not (rel.startswith('live' + os.sep) or rel.startswith('src' + os.sep)) or '..' in rel.split(os.sep):
                return self._json(404, {'error': 'not found'})
            full = os.path.join(REPO, rel)
            if not os.path.isfile(full):
                return self._json(404, {'error': 'not found'})
            with open(full, 'rb') as f:
                body = f.read()
            self.send_response(200)
            self.send_header('Content-Type', TYPES.get(os.path.splitext(full)[1], mimetypes.guess_type(full)[0] or 'application/octet-stream'))
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('X-Frame-Options', 'DENY')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _ws(self):
            key = self.headers.get('Sec-WebSocket-Key', '')
            acc = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
            self.send_response(101)
            self.send_header('Upgrade', 'websocket')
            self.send_header('Connection', 'Upgrade')
            self.send_header('Sec-WebSocket-Accept', acc)
            self.end_headers()
            self.wfile.flush()
            self.close_connection = True
            c = WsClient(self.connection)
            studio.ws_open(c)
            try:
                for text in c.frames():
                    try:
                        studio.ws_message(c, json.loads(text))
                    except ValueError:
                        pass
            finally:
                with studio.lock:
                    studio.clients.discard(c)
                c.closed = True

    return H


class Server(ThreadingHTTPServer):
    # Windows lets a second program bind a port that has SO_REUSEADDR; there the Studio must see the port is taken
    allow_reuse_address = os.name != 'nt'


def player(studio, stop):
    while not stop.is_set():
        studio.tick_clock()
        time.sleep(0.04)


def default_seen():
    base = r'E:\SchwabDesk_bulk\tickbench\runs'
    out = [os.path.join(base, 'sweep_blind', 'KEY.csv')]
    prints = os.path.join(base, 'eventstudy_r1', 'prints')
    if os.path.isdir(prints):
        out += [os.path.join(prints, n) for n in sorted(os.listdir(prints)) if n.lower().endswith('.csv')]
    return out


def fmt_ms(ms, wall):
    """A time as 'YYYY-MM-DD HH:MM:SS.mmm' (wall: New York clock ms stored as if UTC; else true UTC ms)."""
    dt = datetime(1970, 1, 1) + timedelta(milliseconds=int(ms))
    return dt.strftime('%Y-%m-%d %H:%M:%S.') + f'{int(ms) % 1000:03d}' + (' New York' if wall else ' UTC')


def check(source, symbol, day=None, out=print):
    """--check: load in-sample days through the loader and print what the Studio sees. Returns 0 when all went well."""
    days = source.days()
    out(f'days found (in sample, before {core.HOLDOUT.isoformat()}): {len(days)}' + (f', {days[0]} to {days[-1]}' if days else ''))
    if not days:
        out('NO DAYS: check --tickreplay (its sessions_index.csv) and --symbol')
        return 1
    if day:
        core.check_date(day)
        if day not in days:
            out(f'{day} is not in the in-sample day list')
            return 1
    pick = day or days[-1]
    k = days.index(pick)
    d = source.load(pick)
    out(f'chosen day: {pick} (session from 18:00 New York the evening before)')
    out(f'ticks: {len(d):,}')
    out(f'first tick: {fmt_ms(d.wall[0], True)} = {fmt_ms(d.utc[0], False)}')
    out(f'last tick:  {fmt_ms(d.wall[-1], True)} = {fmt_ms(d.utc[-1], False)}')
    out('quotes: ' + ('bid and ask (sides from the quote)' if d.has_quotes else 'last only (sides by the tick rule; volume all 1 on last-only days)'))
    out('overnight: ' + ('yes, from 18:00 the evening before (ONH/ONL used)' if core.has_overnight(d) else 'NO overnight ticks on this day (ONH/ONL not used)'))
    for j in range(k, max(-1, k - 10), -1):          # the first candidate, walking back up to 10 days from the chosen one
        cur = d if j == k else source.load(days[j])
        if not core.has_morning(cur):
            out(f'{days[j]}: no morning (first RTH tick after noon), not a kept day')
            continue
        prev = None
        for i in range(j - 1, max(-1, j - 6), -1):
            p = source.load(days[i])
            if core.has_morning(p):
                prev = core.rth_hilo(p)
                break
        cs = core.find_candidates(cur, prev)
        if cs:
            c = cs[0]
            out(f'first candidate: {c["id"]} {c["level_type"]} {c["level_price"]} {c["dir"]}, cross {fmt_ms(core.utc_to_wall(c["cross_utc_ms"]), True)}, '
                f'cut {fmt_ms(core.utc_to_wall(c["cut_utc_ms"]), True)} ({len(cs)} on {days[j]})')
            return 0
        out(f'{days[j]}: no candidate')
    out('no candidate in the last 10 days checked')
    return 0


def main(argv=None):
    args = argv if argv is not None else sys.argv[1:]
    opt = dict(a[2:].split('=', 1) if '=' in a else (a[2:], '1') for a in args if a.startswith('--'))
    port = int(opt.get('port', 8790))
    if port == 8765:
        sys.exit('port 8765 is ChartBridge\'s; pick another')
    symbol = opt.get('symbol', 'NQ')
    data = opt.get('data', r'E:\SchwabDesk_bulk\ticks_packed')
    marks = opt.get('marks', r'E:\SchwabDesk_bulk\marks')
    if opt.get('source') == 'npz':
        source = NpzSource(data, symbol)
    else:
        tr = opt.get('tickreplay', r'E:\SchwabDesk_bulk\tickreplay')
        try:
            source = TickReplaySource(tr, data, symbol)
        except Exception as e:   # noqa: BLE001 - a plain message, not a traceback
            sys.exit(f'Markup Studio could not load tickreplay from {tr}: {e}\nGive its folder with --tickreplay=PATH and the data with --data=PATH.')
    if 'check' in opt:
        try:
            sys.exit(check(source, symbol, None if opt['check'] == '1' else opt['check']))
        except (TickReplayError, ValueError) as e:
            sys.exit(f'CHECK FAILED: {e}')
    seen = opt['seen'].split(',') if opt.get('seen') else default_seen()
    try:
        studio = Studio(source, marks, opt.get('rule', os.path.join(REPO, 'tools', 'markup_rule_v0.json')), seen, symbol,
                        include_last_only='include-last-only' in opt)
    except OSError as e:
        sys.exit(f'cannot use the marks folder {marks}: {e}\nGive another with --marks=PATH.')
    try:
        server = Server(('127.0.0.1', port), make_handler(studio, port))
    except OSError as e:
        sys.exit(f'port {port} is in use (is the Studio already running?): {e}')
    studio.start_scan()
    server.daemon_threads = True
    stop = threading.Event()
    threading.Thread(target=player, args=(studio, stop), daemon=True).start()
    url = f'http://localhost:{port}/live/markup.html'
    print(f'Markup Studio on {url}  (marks in {marks}; Ctrl+C to stop)', flush=True)
    if 'no-browser' not in opt:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.server_close()


if __name__ == '__main__':
    main()
