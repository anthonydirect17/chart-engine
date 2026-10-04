"""Markup Studio: grade NQ or ES liquidity sweeps on the chart-engine charts, to turn reads into bot mechanics.

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
  --port=8790   --no-browser
  --symbol=NQ                                   NQ or ES (core.INSTRUMENTS: tick, $ per point, round trips); give each symbol
                                                its own --marks folder (the day split records its symbol)
  --include-last-only                           blind queue also offers last-only days (volume is all 1 there; off by default)
  --check[=YYYY-MM-DD]                          load one in-sample day through the loader, print what the Studio sees, exit
  --source=npz                                  tests: <data>/<SYMBOL>_<YYYY-MM-DD>.npz with wall_ms, price, volume[, bid, ask]
  --bot=PATH                                    a bot module (.py, BOT_API 1) for the Bot tab; the Studio knows no rule itself
Days are split once into bot days and grading days (<marks>/bot_split_v1.json, never rewritten): the blind queue offers
grading days only, the Bot tab bot days only. A split made for another symbol is refused (core.check_split).
Holdout: any date from 2026-04-01 on is refused everywhere (listing, loading, candidates, free mode).
Python 3.10+, stdlib + numpy only.
"""
from __future__ import annotations

import base64
import csv
import hashlib
import importlib
import importlib.util
import io
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
PRIOR_TRIES = 10       # in-sample days looked back through for the prior kept day (prior_bars)


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

    def quote_days(self):
        """The days whose npz holds 'bid' (read from the archive's file list; no arrays are loaded)."""
        out = []
        for d in self.days():
            try:
                with np.load(os.path.join(self.folder, f'{self.symbol}_{d}.npz')) as z:
                    if 'bid' in z.files:
                        out.append(d)
            except (OSError, ValueError) as e:
                log(f'quote check: {d}: {e}')
        return out


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

    def quote_days(self):
        """The in-sample days whose sessions_index.csv row says has_quotes yes (no day is loaded)."""
        days = set(self.days())
        return sorted({str(r['session_date']).strip()[:10] for r in self.rows()
                       if r['symbol'].strip().upper() == self.symbol.upper() and _yes(r['has_quotes'])} & days)

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


# ------------------------------------------------------------------------------------------------ the bot module
class BotError(Exception):
    pass


BOT_USAGE = 'No bot loaded. Start the Studio with --bot=PATH (a .py file that speaks BOT_API 1) to use this tab.'


def load_bot(path):
    """Import a bot module from a .py file and check it speaks BOT_API 1. Returns {'module', 'name', 'variants',
    'exit_ids', 'path'}; BotError with a plain message otherwise."""
    p = os.path.abspath(str(path))
    base = os.path.basename(p)
    if not p.endswith('.py') or not os.path.isfile(p):
        raise BotError(f'no bot file at {p} (give a .py file with --bot=PATH)')
    try:
        spec = importlib.util.spec_from_file_location('markup_bot_' + hashlib.sha1(p.encode()).hexdigest()[:8], p)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    except Exception as e:   # noqa: BLE001 - any import failure is a message in the page
        raise BotError(f'could not import {base}: {type(e).__name__}: {e}') from e
    api = getattr(mod, 'BOT_API', None)
    if api != 1:
        raise BotError(f'{base} has BOT_API = {api!r}; this Studio speaks BOT_API 1 only')
    name = getattr(mod, 'NAME', None)
    if not isinstance(name, str) or not name.strip():
        raise BotError(f'{base} has no NAME (a short string)')
    for f in ('variants', 'exit_ids', 'run'):
        if not callable(getattr(mod, f, None)):
            raise BotError(f'{base} has no {f}() function')
    try:
        variants, exits = mod.variants(), mod.exit_ids()
    except Exception as e:   # noqa: BLE001
        raise BotError(f'{base}: variants() or exit_ids() failed: {type(e).__name__}: {e}') from e
    if not isinstance(variants, list) or not variants or not all(
            isinstance(v, dict) and v.get('id') and isinstance(v.get('params', {}), dict) for v in variants):
        raise BotError(f'{base}: variants() must return a non-empty list of {{"id", "label", "params"}}')
    ids = [str(v['id']) for v in variants]
    if len(set(ids)) != len(ids):
        raise BotError(f'{base}: variants() has the same id twice')
    if not isinstance(exits, list) or not exits or not all(isinstance(x, str) and x for x in exits):
        raise BotError(f'{base}: exit_ids() must return a non-empty list of strings')
    variants = [{'id': str(v['id']), 'label': str(v.get('label') or v['id']), 'params': dict(v.get('params') or {})} for v in variants]
    return {'module': mod, 'name': name.strip(), 'variants': variants, 'exit_ids': list(exits), 'path': p}


def check_result(res):
    """A run() result in BOT_API 1's shape (the times the view filter needs), else BotError."""
    if not isinstance(res, dict):
        raise BotError('run() must return a dict with events, orders and trades')
    try:
        for e in res.setdefault('events', []):
            e['t'] = int(e['t'])
        for o in res.setdefault('orders', []):
            o['t_from'], o['t_to'] = int(o['t_from']), int(o['t_to'])
        for t in res.setdefault('trades', []):
            t['entry_t'] = int(t['entry_t'])
            for x in (t.get('exits') or {}).values():
                x['exit_t'] = int(x['exit_t'])
    except (KeyError, TypeError, ValueError, AttributeError) as e:
        raise BotError(f'run() result is not in the BOT_API 1 shape: {type(e).__name__}: {e}') from e
    return json.loads(json.dumps(res))       # a plain JSON copy (refuses what cannot be shown)


# ------------------------------------------------------------------------------------------------ the studio
class Refused(Exception):
    pass


class Forbidden(Refused):
    """Refused with 403: a grading day or a day outside the split asked of a bot endpoint."""


class Studio:
    split, bot_days, grading_days = None, frozenset(), None     # until load_split() (tests build a bare Studio)

    def __init__(self, source, marks_dir, rule_path, seen_paths=(), symbol='NQ', include_last_only=False, bot_path=None):
        self.inst = core.instrument(symbol)                  # an unknown symbol is a ValueError, never NQ by default
        self.source, self.marks, self.rule_path, self.symbol = source, marks_dir, rule_path, self.inst['symbol']
        self.tick = self.inst['tick']
        self.include_last_only = include_last_only     # blind queue: quote days only unless --include-last-only
        self.seen_report = []
        self.seen = core.read_seen([p for p in seen_paths if p and os.path.isfile(p)], self.seen_report)
        self.lock = threading.RLock()
        self.clients = set()
        self.day, self.prior = None, []
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
        self.prior_kept = None
        self.bot, self.bot_error = None, ''
        if bot_path:
            try:
                self.bot = load_bot(bot_path)
                log(f'bot: {self.bot["name"]} from {self.bot["path"]}')
            except BotError as e:
                self.bot_error = str(e)
                log('bot not loaded: ' + self.bot_error)
        self.bot_lock = threading.Lock()
        self.bot_cache, self.bot_runs, self.bot_key = {}, {}, None    # (date, variant id) -> result / run status
        self.runall = {'running': False, 'k': 0, 'n': 0, 'error': '', 'folder': '', 'failed': [], 'rows': None}
        self.load_split()

    # ---------------------------------------------------------------- the day split
    def load_split(self):
        """<marks>/bot_split_v1.json: written on the first start that finds days (core.bot_split, seed 7, with the symbol)
        and only read after that, never rewritten. A split that is not this symbol's is refused (core.check_split: the
        Studio does not start). Days not in it (new data) go to neither list and are logged."""
        path = os.path.join(self.marks, 'bot_split_v1.json')
        try:
            days = self.source.days()
        except Exception as e:   # noqa: BLE001 - the scan reports a bad source on the page
            log(f'day split: cannot list the days: {e}')
            days = None
        if os.path.exists(path):
            try:
                with open(path, encoding='utf-8') as f:
                    sp = json.load(f)
                if sp.get('version') != 1 or not isinstance(sp.get('bot'), list) or not isinstance(sp.get('grading'), list):
                    raise ValueError('not a version 1 split')
            except (OSError, ValueError, AttributeError) as e:
                raise ValueError(f'cannot read {path} ({e}); it is never rewritten: fix or move it by hand') from e
            warn = core.check_split(sp, self.symbol, days, core.marks_symbols(self.marks, self.grades))
            if warn:
                log(warn)
        else:
            if not days:
                return                                   # nothing to split yet: written on a start that finds days
            q = set(self.source.quote_days())
            sp = core.bot_split(q, [d for d in days if d not in q], symbol=self.symbol)
            core.write_text(path, json.dumps(sp, indent=1))
            log(f'day split written to {path}: {len(sp["bot"])} bot days, {len(sp["grading"])} grading days')
        self.split = sp
        self.bot_days, self.grading_days = frozenset(sp['bot']), frozenset(sp['grading'])
        other = [d for d in days or () if d not in self.bot_days and d not in self.grading_days]
        if other:
            log(f'day split: {len(other)} day(s) not in {os.path.basename(path)} go to neither list: {", ".join(other[:10])}' + (' ...' if len(other) > 10 else ''))

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
                            found = core.find_candidates(day, tuple(prev) if prev else None, self.tick)
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
        if self.grading_days is not None and c['date'] not in self.grading_days:
            return True                                   # bot days (and days outside the split) are never graded blind
        return c['id'] in self.graded_ids or c['id'] in self.seen_ids or not core.in_sample(c['date'])

    def queue(self):
        with self.lock:
            if self._queue is None:
                order = self.order
                self._queue = {'total': len(order), 'excluded_seen': sum(1 for c in order if c['id'] in self.seen_ids),
                               'graded': sum(1 for c in order if c['id'] in self.graded_ids),
                               'bot_days': sum(1 for c in order if c['date'] in self.bot_days),
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

    def prior_day(self, d, load=None):
        """The prior kept day (the one the scan takes PDH and PDL from: the last earlier in-sample day that loads with a
        morning), or None."""
        load = load or self.source.load
        days = [x for x in self.source.days() if x < d]
        for x in reversed(days[-PRIOR_TRIES:]):
            try:
                p = load(x)
            except Exception as e:   # noqa: BLE001 - as the scan: a day that does not load is passed over
                log(f'prior day {x} for {d}: skipped: {e}')
                continue
            if core.has_morning(p):
                return p
        return None

    def prior_bars(self, d):
        """The 1-minute bars of the prior kept day, so the page's Levels draw PDH, PDL, the prior close and the prior day's
        value area as on the live charts. That day ends before this day's session starts: nothing after the clock comes
        with it."""
        p = self.prior_day(d)
        return core.minute_bars(p) if p is not None else []

    def _load(self, d, clock_utc, mode):
        day = self.source.load(d)            # refuses the holdout
        pday = self.prior_day(day.date)
        prior = core.minute_bars(pday) if pday is not None else []
        with self.lock:
            self._drop_clients()
            self.day, self.prior, self.prior_kept, self.mode, self.clock = day, prior, pday, mode, int(clock_utc)
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
            clock_utc = clock_of(d, tod or '09:30')
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
                to = clock_of(self.day.date, tod)
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
                if self.mode in ('free', 'bot'):
                    s['date'] = self.day.date
                elif self.cand:
                    s['candidate'] = {'n': self.cand_no, 'ref': ref_of(self.cand['id'])}
            if self.mode == 'bot' and self.bot_key:
                run = self.bot_runs.get(self.bot_key, {})
                s['bot_day'] = {'date': self.bot_key[0], 'variant': self.bot_key[1], 'status': run.get('status', ''),
                                'progress': round(run.get('progress', 0.0), 3), 'error': run.get('error', '')}
            s['bot'] = {'ready': self.bot is not None, 'runall': {k: self.runall[k] for k in ('running', 'k', 'n', 'error')}}
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
            dirn = self.cand.get('dir') if self.mode == 'blind' and self.cand and cross == self.cand.get('cross_utc_ms') else None
            return core.machine_read(self.vis(), self.clock, float(lv), cross, tick=self.tick, exclusive=self.exclusive, direction=dirn)

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
            if self.mode == 'bot':
                raise Refused('the Bot tab saves no grades: grade in Blind or Free')
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
            dirn = self.cand.get('dir') if self.cand and cross == self.cand.get('cross_utc_ms') else None
            mr = core.machine_read(self.vis(), self.clock, float(level['price']), cross, tick=self.tick, exclusive=self.exclusive,
                                   direction=dirn) if level else {'ok': False, 'why': 'no level'}
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

    # ---------------------------------------------------------------- the Bot tab
    def _bot_need(self):
        if self.bot is None:
            raise Refused(self.bot_error or BOT_USAGE)

    def bot_day_ok(self, d):
        """Every bot endpoint: the holdout (HoldoutError, 403), grading days and days outside the split (Forbidden, 403)."""
        d = core.check_date(d)
        if self.grading_days is not None and d in self.grading_days:
            raise Forbidden(f'{d} is a grading day: the Bot tab opens bot days only (bot_split_v1.json)')
        if d not in self.bot_days:
            raise Forbidden(f'{d} is not a bot day (not in bot_split_v1.json)')
        return d

    def bot_info(self):
        b = self.bot
        return {'ok': b is not None, 'error': self.bot_error, 'usage': BOT_USAGE, 'name': b and b['name'],
                'variants': [{'id': v['id'], 'label': v['label']} for v in b['variants']] if b else [],
                'exit_ids': b['exit_ids'] if b else [], **core.contracts(self.symbol)}

    def bot_day_list(self):
        self._bot_need()
        with self.lock:
            if self.blind_open():
                raise Refused('a blind candidate is open: save its grade first, then use the Bot tab')
        return sorted(d for d in self.bot_days if core.in_sample(d))

    def _variant(self, vid):
        vs = self.bot['variants']
        if vid in (None, ''):
            return vs[0]
        for v in vs:
            if v['id'] == str(vid):
                return v
        raise Refused(f'the bot has no variant {vid}')

    def bot_load(self, d, vid=None):
        """Load a bot day like Free mode (clock 09:30) and run the bot once for (day, variant) in the background."""
        self._bot_need()
        with self.lock:
            if self.blind_open():
                raise Refused('a blind candidate is open: save its grade first, then use the Bot tab')
        d = self.bot_day_ok(d)
        v = self._variant(vid)
        self._load(d, clock_of(d, '09:30'), 'bot')
        with self.lock:
            self.cand, self.level = None, None
            self.bot_key = (d, v['id'])
            day, prior = self.day, self.prior_kept
        key = (d, v['id'])
        with self.bot_lock:
            start = key not in self.bot_cache and self.bot_runs.get(key, {}).get('status') != 'running'
            if start:
                self.bot_runs[key] = {'status': 'running', 'progress': 0.0, 'error': ''}
            elif key in self.bot_cache:
                self.bot_runs[key] = {'status': 'done', 'progress': 1.0, 'error': ''}
        if start:
            threading.Thread(target=self._bot_run_one, args=(day, prior, v), daemon=True).start()
        return self.state()

    def _bot_call(self, day, prior, v, progress=None):
        res = self.bot['module'].run(day, prior, dict(v['params']), progress)
        return check_result(res)

    def _bot_run_one(self, day, prior, v):
        key = (day.date, v['id'])
        rec = self.bot_runs[key]

        def progress(f):
            try:
                rec['progress'] = min(1.0, max(0.0, float(f)))
            except (TypeError, ValueError):
                pass
        try:
            res = self._bot_call(day, prior, v, progress)
            with self.bot_lock:
                self.bot_cache[key] = res
            rec.update(status='done', progress=1.0)
        except Exception as e:   # noqa: BLE001 - shown in the Bot tab
            log(f'bot run {day.date} {v["id"]} failed: {type(e).__name__}: {e}')
            rec.update(status='error', error=f'{type(e).__name__}: {e}')

    def bot_view(self):
        """What the Bot tab may show at the clock: the bot's result cut by core.bot_view (the no-future filter)."""
        self._bot_need()
        with self.lock:
            if self.mode != 'bot' or self.day is None or self.bot_key is None:
                raise Refused('load a bot day in the Bot tab first')
            key, clock = self.bot_key, self.clock
        self.bot_day_ok(key[0])
        run = self.bot_runs.get(key, {})
        res = self.bot_cache.get(key)
        v = self._variant(key[1])
        out = {'name': self.bot['name'], 'variant': v['id'], 'variant_label': v['label'], 'exit_ids': self.bot['exit_ids'],
               'status': run.get('status', ''), 'progress': round(run.get('progress', 0.0), 3), 'error': run.get('error', '')}
        out.update(core.bot_view(res, core.utc_to_wall(clock), self.bot['exit_ids'], self.symbol))
        return out

    def bot_runall_start(self):
        self._bot_need()
        with self.lock:
            if self.blind_open():
                raise Refused('a blind candidate is open: save its grade first, then use the Bot tab')
        days = sorted(d for d in self.bot_days if core.in_sample(d))
        with self.bot_lock:
            if self.runall['running']:
                raise Refused('Run all is running already')
            self.runall = {'running': True, 'k': 0, 'n': len(days), 'error': '', 'folder': '', 'failed': [], 'rows': None}
        threading.Thread(target=self._runall, args=(days,), daemon=True).start()
        return self.bot_runall_status()

    def bot_runall_status(self):
        self._bot_need()
        r = dict(self.runall)
        r['variants'] = [{'id': v['id'], 'label': v['label']} for v in self.bot['variants']]
        r['exit_ids'] = self.bot['exit_ids']
        r.update(core.contracts(self.symbol))
        return r

    def _runall(self, days):
        """Every bot day x every variant, each day loaded once (results already cached are reused), then the summary
        and the files in <marks>/botruns/<stamp>/."""
        try:
            variants, exits = self.bot['variants'], self.bot['exit_ids']
            memo = {}

            def load(x):
                if x not in memo:
                    memo[x] = self.source.load(x)
                    while len(memo) > 4:                 # a day's prior is an earlier day: keep the last few
                        del memo[next(iter(memo))]
                return memo[x]
            trades, failed = [], []
            for k, d in enumerate(days):
                self.runall['k'] = k
                try:
                    self.bot_day_ok(d)
                    todo = [v for v in variants if (d, v['id']) not in self.bot_cache]
                    if todo:
                        day, prior = load(d), self.prior_day(d, load)
                        for v in todo:
                            res = self._bot_call(day, prior, v)
                            with self.bot_lock:
                                self.bot_cache[(d, v['id'])] = res
                except Exception as e:   # noqa: BLE001 - one bad day never stops the run
                    log(f'run all: {d} failed: {type(e).__name__}: {e}')
                    failed.append(d)
                    continue
                for v in variants:
                    for t in self.bot_cache[(d, v['id'])]['trades']:
                        trades.append(dict(t, variant=v['id'], date=d))
            self.runall['k'] = len(days)
            rows = core.bot_summary(trades, [v['id'] for v in variants], exits, self.symbol)
            folder = self._write_run(trades, rows, days, failed)
            self.runall.update(running=False, folder=folder, failed=failed, rows=rows)
        except Exception as e:   # noqa: BLE001 - shown in the Bot tab
            log(f'run all failed: {type(e).__name__}: {e}')
            self.runall.update(running=False, error=f'{type(e).__name__}: {e}')

    def _write_run(self, trades, rows, days, failed):
        base = os.path.join(self.marks, 'botruns')
        stamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        folder, k = os.path.join(base, stamp), 1
        while os.path.exists(folder):
            k += 1
            folder = os.path.join(base, f'{stamp}_{k}')
        os.makedirs(folder)
        exits, cs = self.bot['exit_ids'], core.contracts(self.symbol)
        feats = []
        for t in trades:
            for f in (t.get('features') or {}):
                if f not in feats:
                    feats.append(f)
        flat = []
        for t in trades:
            r = {'symbol': cs['contract'], 'micro': cs['micro'], 'variant': t['variant'], 'date': t['date']}
            r.update({k2: t.get(k2) for k2 in ('id', 'level_type', 'level_price', 'dir')})
            r['entry_time'] = core.fmt_tod(t['entry_t'])
            r.update({k2: t.get(k2) for k2 in ('entry_t', 'entry', 'stop', 'target', 'target_kind')})
            for x in exits:
                e = (t.get('exits') or {}).get(x) or {}
                r[f'{x}_exit_time'] = core.fmt_tod(e['exit_t']) if e.get('exit_t') is not None else None
                for k2 in ('exit_t', 'exit', 'reason', 'points', 'r'):
                    r[f'{x}_{k2}'] = e.get(k2)
                for k2, c in (('usd', cs['contract']), ('usd_micro', cs['micro'])):
                    r[f'{x}_net_{k2}'] = round(core.trade_cost(e['points'], c), 2) if e.get('points') is not None else None
            for f in feats:
                r['f_' + f] = (t.get('features') or {}).get(f)
            flat.append(r)
        labels = {v['id']: v['label'] for v in self.bot['variants']}
        core.write_text(os.path.join(folder, 'trades.csv'), csv_text(flat))
        core.write_text(os.path.join(folder, 'summary.csv'), csv_text([dict(r, variant_label=labels.get(r['variant']), symbol=cs['contract'],
                                                                                 micro=cs['micro']) for r in rows]))
        core.write_text(os.path.join(folder, 'summary.json'), json.dumps({
            'version': 1, 'bot': self.bot['name'], 'stamp': os.path.basename(folder), 'days': days, 'failed_days': failed,
            'variants': [{'id': v['id'], 'label': v['label'], 'params': v['params']} for v in self.bot['variants']],
            'exit_ids': exits, **cs,
            'costs': {cs['contract']: {'per_point': cs['point_value'], 'round_trip': cs['rt']},
                      cs['micro']: {'per_point': cs['micro_point_value'], 'round_trip': cs['micro_rt']}},
            'rows': rows}, indent=1))
        return folder

    def bot_export(self):
        self._bot_need()
        if not self.runall.get('folder'):
            raise Refused('nothing to export yet: press Run all bot days first')
        return {'folder': self.runall['folder'], 'files': ['trades.csv', 'summary.csv', 'summary.json']}

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
                'instruments': [self.hello_instrument()]})
        c.send({'type': 'execs', 'list': []})

    def hello_instrument(self):
        """The one instrument the hello announces (the page takes its chart root, header and tick from it)."""
        return {'root': self.symbol, 'name': self.symbol + ' replay', 'tick': self.tick, 'pointValue': self.inst['point_value']}

    def ws_message(self, c, m):
        if not isinstance(m, dict) or m.get('type') != 'subscribe':
            return                                   # read only: everything else (orders included) is ignored
        r = self.symbol
        with self.lock:
            if self.day is None or m.get('root') != r:
                c.send({'type': 'status', 'level': 'info', 'text': 'No day loaded' if self.day is None else 'Markup Studio serves ' + r + ' only'})
                return
            day, prior, n, seq = self.day, self.prior, self.n_visible(), self.load_seq
            c.ready, c.sent = False, n
        c.send_raw(self._load_frames(day, n, seq, prior))         # the heavy part runs outside the lock (the page's polls go on)
        with self.lock:
            if self.day is not day or c.closed:
                return
            c.send({'type': 'ready', 'root': r})
            c.ready = True
            self._release()                           # the trades the clock passed meanwhile

    def _load_frames(self, day, n, seq, prior=()):
        """The load's history and ticks messages as WebSocket frames, encoded once per day and cut: both charts subscribe to
        the same load, so the second gets the same bytes (a full day is some 30 MB of JSON). The history starts with the
        prior kept day's minutes (prior_bars), then this day's up to the clock."""
        key = (seq, n)
        with self.cache_lock:
            if self.frames_key == key:
                return self.frames
            r, v = self.symbol, day.upto(n)
            bars = list(prior) + core.minute_bars(v)
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


def clock_of(d, tod):
    """The replay clock (UTC ms) for HH:MM on a session date (18:00 and later is the evening before)."""
    hh, mm = parse_hhmm(tod)
    base = d if hh < 18 else (core.parse_date(d) - timedelta(days=1)).isoformat()
    return int(core.wall_to_utc([core.wall_of(base, hh, mm)])[0])


def csv_text(rows):
    cols = []
    for r in rows:
        for k in r:
            if k not in cols:
                cols.append(k)
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=cols)
    w.writeheader()
    w.writerows(rows)
    return buf.getvalue()


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
                if u.path == '/api/bot/info':
                    return self._json(200, studio.bot_info())
                if u.path == '/api/bot/days':
                    return self._json(200, {'days': studio.bot_day_list()})
                if u.path == '/api/bot/view':
                    return self._json(200, studio.bot_view())
                if u.path == '/api/bot/runall':
                    return self._json(200, studio.bot_runall_status())
            except core.HoldoutError as e:
                return self._json(403, {'error': str(e)})
            except Forbidden as e:
                return self._json(403, {'error': str(e)})
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
                if path == '/api/bot/load':
                    return self._json(200, studio.bot_load(p.get('date'), p.get('variant')))
                if path == '/api/bot/runall':
                    return self._json(200, studio.bot_runall_start())
                if path == '/api/bot/export':
                    return self._json(200, studio.bot_export())
            except core.HoldoutError as e:
                return self._json(403, {'error': str(e)})
            except Forbidden as e:
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


def default_seen(symbol='NQ'):
    """The research's already-seen NQ events (they match by date, level type and reclaim time, not price): NQ only. Another
    symbol has none by default (--seen gives them)."""
    if symbol != 'NQ':
        return []
    base = r'E:\SchwabDesk_bulk\tickbench\runs'
    out = [os.path.join(base, 'sweep_blind', 'KEY.csv')]
    prints = os.path.join(base, 'eventstudy_r1', 'prints')
    if os.path.isdir(prints):
        out += [os.path.join(prints, n) for n in sorted(os.listdir(prints)) if core.PRINT_NAME.match(n)]   # sweep (E2) prints only
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
        cs = core.find_candidates(cur, prev, core.instrument(symbol)['tick'])
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
    try:
        symbol = core.instrument(opt.get('symbol', 'NQ'))['symbol']
    except ValueError as e:
        sys.exit(f'Markup Studio: {e}')
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
    seen = opt['seen'].split(',') if opt.get('seen') else default_seen(symbol)
    if not opt.get('seen') and symbol != 'NQ':
        log(f'already-seen: the default files are NQ events, not used for {symbol} (give --seen=CSV[,CSV] to exclude {symbol} ones)')
    try:
        studio = Studio(source, marks, opt.get('rule', os.path.join(REPO, 'tools', 'markup_rule_v0.json')), seen, symbol,
                        include_last_only='include-last-only' in opt, bot_path=opt.get('bot'))
    except (OSError, ValueError) as e:
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
