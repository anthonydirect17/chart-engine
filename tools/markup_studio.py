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
  --source=npz                                  tests: <data>/<SYMBOL>_<YYYY-MM-DD>.npz with wall_ms, price, volume[, bid, ask]
Holdout: any date from 2026-04-01 on is refused everywhere (listing, loading, candidates, free mode).
Python 3.10+, stdlib + numpy only.
"""
from __future__ import annotations

import base64
import hashlib
import importlib
import json
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
SETUPS = ('SWEEP', 'RETEST', 'NONE', 'WAIT')
SPEEDS = (1, 5, 20, 60)
MARK_ROLES = ('Level', 'Failed candle', 'Reclaim candle', 'Entry', 'Stop', 'Target')
SPAN_ROLES = ("Volume I'm reading", 'Approach')


def visible_count(day, clock_utc):
    """NO-FUTURE: the number of ticks at or before the clock. Every data path cuts the day here and nowhere else."""
    return int(np.searchsorted(day.utc, clock_utc, 'right'))


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


TIME_COLS = ('ts_wall_ms', 'ts_ms', 'time_ms', 'timestamp_ms', 'ts', 'timestamp', 'time', 't')
PRICE_COLS = ('price', 'last', 'last_price', 'px', 'p')
VOL_COLS = ('volume', 'vol', 'size', 'qty', 'v')


def _columns(obj):
    """Columns of whatever load_session returns: a dict of arrays, a pandas DataFrame, a numpy structured array, or an
    object with array attributes (or a tuple whose first item is one of those)."""
    if isinstance(obj, tuple) and obj:
        obj = obj[0]
    if hasattr(obj, 'columns') and hasattr(obj, '__getitem__'):          # pandas
        return {str(c).lower(): np.asarray(obj[c]) for c in obj.columns}
    if isinstance(obj, np.ndarray) and obj.dtype.names:
        return {n.lower(): obj[n] for n in obj.dtype.names}
    if isinstance(obj, dict):
        return {str(k).lower(): np.asarray(v) for k, v in obj.items() if hasattr(v, '__len__')}
    return {k.lower(): np.asarray(v) for k, v in vars(obj).items() if isinstance(v, (np.ndarray, list))}


def _pick(cols, names, what):
    for n in names:
        if n in cols:
            return cols[n]
    raise RuntimeError(f'tickreplay.load_session gave no {what} column (looked for {", ".join(names)}; found {", ".join(sorted(cols))}). '
                       'Tell the coordinator: the adapter in tools/markup_studio.py needs the real column name.')


def _wall_ms(a):
    a = np.asarray(a)
    if np.issubdtype(a.dtype, np.datetime64):
        return a.astype('datetime64[ms]').astype(np.int64)
    a = a.astype(np.float64)
    if a.size and np.nanmax(a) < 1e11:          # seconds
        a = a * 1000
    return np.round(a).astype(np.int64)


class TickReplaySource:
    """The canonical loader on the HOME PC: tickreplay.load_session(symbol, session_date, data_root=...), corrections
    applied, timestamps New York wall-clock ms."""

    def __init__(self, tickreplay_dir, data_root, symbol):
        self.data_root, self.symbol = data_root, symbol
        d = os.path.abspath(tickreplay_dir)
        if os.path.isfile(os.path.join(d, '__init__.py')):
            sys.path.insert(0, os.path.dirname(d))
            name = os.path.basename(d)
        else:
            sys.path.insert(0, d)
            name = 'tickreplay'
        mod = importlib.import_module(name)
        fn = getattr(mod, 'load_session', None)
        if fn is None:
            fn = getattr(importlib.import_module(name + '.loader'), 'load_session')
        self.mod, self._load = mod, fn

    def days(self):
        for attr in ('list_sessions', 'available_sessions', 'list_days', 'sessions'):
            f = getattr(self.mod, attr, None)
            if callable(f):
                try:
                    got = f(self.symbol, data_root=self.data_root)
                    out = sorted({str(x)[:10] for x in got})
                    return [x for x in out if re.fullmatch(r'\d{4}-\d{2}-\d{2}', x) and core.in_sample(x)]
                except Exception:   # noqa: BLE001 - fall back to the folder scan
                    pass
        found = set()
        for dirpath, dirnames, files in os.walk(self.data_root):
            if dirpath[len(self.data_root):].count(os.sep) > 3:
                dirnames[:] = []
                continue
            for n in files + dirnames:
                full = os.path.join(dirpath, n)
                if self.symbol.lower() not in full.lower():
                    continue
                for m in re.finditer(r'(20\d{2})-?(\d{2})-?(\d{2})', n):
                    found.add(f'{m.group(1)}-{m.group(2)}-{m.group(3)}')
        return sorted(x for x in found if core.in_sample(x))

    def load(self, d):
        d = core.check_date(d)
        raw = self._load(self.symbol, d, data_root=self.data_root)
        cols = _columns(raw)
        wall = _wall_ms(_pick(cols, TIME_COLS, 'time'))
        px = _pick(cols, PRICE_COLS, 'price').astype(np.float64)
        vol = _pick(cols, VOL_COLS, 'volume').astype(np.int64)
        bid = cols.get('bid', cols.get('bid_price'))
        ask = cols.get('ask', cols.get('ask_price'))
        order = np.argsort(wall, kind='stable')
        f = lambda a: None if a is None else np.asarray(a, dtype=np.float64)[order]
        return core.Day(d, wall[order], px[order], vol[order], f(bid), f(ask))


# ------------------------------------------------------------------------------------------------ the studio
class Refused(Exception):
    pass


class Studio:
    def __init__(self, source, marks_dir, rule_path, seen_paths=(), symbol='NQ'):
        self.source, self.marks, self.rule_path, self.symbol = source, marks_dir, rule_path, symbol
        self.seen = core.read_seen([p for p in seen_paths if p and os.path.isfile(p)])
        self.lock = threading.RLock()
        self.clients = set()
        self.day = None
        self.mode = 'blind'
        self.clock = 0
        self.playing, self.speed, self.anchor = False, 0, (0.0, 0)
        self.steps, self.graded, self.cand, self.cand_no, self.level = 0, False, None, 0, None
        self.scan = {'running': False, 'done': False, 'days': 0, 'total': 0, 'error': ''}
        self.candidates, self.order, self.pos = [], [], -1
        os.makedirs(marks_dir, exist_ok=True)

    # ---------------------------------------------------------------- candidates
    def start_scan(self, background=True):
        t = threading.Thread(target=self._scan, daemon=True)
        self.scan['running'] = True
        if background:
            t.start()
        else:
            self._scan()

    def _scan(self):
        path = os.path.join(self.marks, 'candidates_v1.json')
        try:
            cache = {}
            try:
                with open(path, encoding='utf-8') as f:
                    cache = json.load(f)
            except (OSError, ValueError):
                pass
            done_days = set(cache.get('days_scanned', [])) if cache.get('version') == 1 and cache.get('symbol') == self.symbol else set()
            items = [c for c in cache.get('items', []) if c['date'] in done_days] if done_days else []
            rth = dict(cache.get('rth', {})) if done_days else {}
            days = self.source.days()
            self.scan['total'] = len(days)
            prev = None
            for k, d in enumerate(days):
                if d in done_days and d in rth:
                    prev = rth[d]
                    self.scan['days'] = k + 1
                    continue
                day = self.source.load(d)
                items = [c for c in items if c['date'] != d] + core.find_candidates(day, prev)
                hl = core.rth_hilo(day)
                rth[d] = list(hl) if hl else None
                prev = rth[d]
                done_days.add(d)
                self.scan['days'] = k + 1
                if k % 10 == 9 or k == len(days) - 1:
                    self._write_cache(path, items, done_days, rth)
            items = [c for c in items if core.in_sample(c['date'])]
            self._write_cache(path, items, done_days, rth)
            with self.lock:
                self.candidates = items
                self.order = core.shuffled(items, 4)
                self.scan.update(done=True, running=False)
        except Exception as e:   # noqa: BLE001 - shown on the page
            self.scan.update(running=False, error=str(e))

    def _write_cache(self, path, items, days, rth):
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump({'version': 1, 'symbol': self.symbol, 'days_scanned': sorted(days), 'rth': rth, 'items': items}, f)
        os.replace(tmp, path)

    def graded_ids(self):
        return {g.get('id') for g in core.list_grades(self.marks)}

    def queue(self):
        graded = self.graded_ids()
        seen = [c for c in self.order if core.is_seen(c, self.seen)]
        left = [c for c in self.order if c['id'] not in graded and not core.is_seen(c, self.seen)]
        return {'total': len(self.order), 'excluded_seen': len(seen), 'graded': len([c for c in self.order if c['id'] in graded]),
                'remaining': len(left)}

    # ---------------------------------------------------------------- loading and the clock
    def _load(self, d, clock_utc, mode):
        day = self.source.load(d)            # refuses the holdout
        with self.lock:
            self._drop_clients()
            self.day, self.mode, self.clock = day, mode, int(clock_utc)
            self.playing, self.speed = False, 0
            self.steps, self.graded = 0, False

    def blind_next(self):
        with self.lock:
            if not self.scan['done']:
                raise Refused('the candidate scan is still running')
            graded = self.graded_ids()
            n = len(self.order)
            for k in range(1, n + 1):
                c = self.order[(self.pos + k) % n]
                if c['id'] in graded or core.is_seen(c, self.seen) or not core.in_sample(c['date']):
                    continue
                self.pos = (self.pos + k) % n
                self._load(c['date'], c['cut_utc_ms'], 'blind')
                self.cand, self.level = c, {'type': c['level_type'], 'price': c['level_price']}
                self.cand_no += 1
                return self.state()
            raise Refused('no candidates left to grade')

    def free_load(self, d, tod=None, clock_utc=None, level=None):
        d = core.check_date(d)
        if clock_utc is None:
            hh, mm = (int(x) for x in (tod or '09:30').split(':')[:2])
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
        if self.mode == 'blind' and not self.graded:
            raise Refused('in blind mode the clock only steps one candle at a time until the grade is saved')

    def step(self):
        with self.lock:
            self._need_day()
            self.playing = False
            self.clock = (self.clock // core.MIN + 1) * core.MIN
            if self.mode == 'blind' and not self.graded:
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
                to = self.clock + int(float(minutes) * core.MIN)
            else:
                hh, mm = (int(x) for x in str(tod).split(':')[:2])
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
            end = int(self.day.utc[-1]) if len(self.day) else self.clock
            if to >= end:
                to, self.playing = max(end, self.clock), False
            if to > self.clock:
                self.clock = to
                self._release()

    # ---------------------------------------------------------------- what the page may see
    def vis(self):
        return self.day.upto(visible_count(self.day, self.clock))

    def state(self):
        with self.lock:
            s = {'mode': self.mode, 'loaded': self.day is not None, 'playing': self.playing, 'speed': self.speed,
                 'scan': dict(self.scan), 'queue': self.queue() if self.scan['done'] else None, 'version': VERSION}
            if self.day is not None:
                s.update(clock_utc_ms=self.clock, clock_tod=core.fmt_tod(core.utc_to_wall(self.clock)), steps=self.steps,
                         graded=self.graded, level=self._level()[0])
                if self.mode == 'free':
                    s['date'] = self.day.date
                elif self.cand:
                    s['candidate'] = {'n': self.cand_no}
            return s

    def machine(self, level=None):
        with self.lock:
            self._need_day()
            if self.mode == 'blind' and not self.graded:
                raise Refused('the machine read stays hidden in blind mode until the grade is saved')
            cross = self.cand['cross_utc_ms'] if self.mode == 'blind' and self.cand else None
            lv = level
            if lv is None:
                cur, cross2 = self._level()
                lv = (cur or {}).get('price')
                cross = cross if cross is not None else cross2
            if lv is None:
                return {'ok': False, 'why': 'mark a Level (or open a candidate) to read it'}
            return core.machine_read(self.vis(), self.clock, float(lv), cross)

    def _level(self):
        """The level in force and its cross: the open candidate's, the one set in free mode, or else (free mode) the day's
        latest candidate whose cross is at or before the clock."""
        if self.level:
            return self.level, (self.cand or {}).get('cross_utc_ms')
        if self.mode == 'free' and self.day is not None:
            past = [c for c in self.candidates if c['date'] == self.day.date and c['cross_utc_ms'] <= self.clock]
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
            reason = str(p.get('reason') or '').strip()
            chips = [str(c)[:80] for c in (p.get('chips') or [])][:40]
            if setup != 'NONE' and not reason and not chips:
                raise Refused('give a reason: type it or click a chip')
            to_utc = lambda t: int(core.wall_to_utc([round(float(t) * 1000)])[0])
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
            mr = core.machine_read(self.vis(), self.clock, float(level['price']), cross) if level else {'ok': False, 'why': 'no level'}
            rule = core.load_rule(self.rule_path)
            draft = core.draft_verdict(mr, rule)
            clock_wall = core.utc_to_wall(self.clock)
            if self.mode == 'blind':
                gid = self.cand['id']
            else:
                gid = 'F' + self.day.date.replace('-', '') + '_' + core.fmt_tod(clock_wall).replace(':', '')
            item = {'id': gid, 'mode': self.mode, 'date': self.day.date, 'symbol': self.symbol, 'setup': setup, 'direction': direction,
                    'reason': reason, 'chips': chips, 'marks': marks, 'spans': spans,
                    'steps_after_cut': self.steps if self.mode == 'blind' else None,
                    'clock_utc_ms': self.clock, 'clock_tod': core.fmt_tod(clock_wall),
                    'level_type': (level or {}).get('type'), 'level_price': (level or {}).get('price'),
                    'candidate': self.cand, 'machine_read': mr, 'draft': draft, 'agrees_with_draft': core.agrees(setup, draft['verdict']),
                    'saved_utc': datetime.now(timezone.utc).isoformat(timespec='seconds')}
            path = core.save_grade(self.marks, item)
            if self.mode == 'blind':
                self.graded = True
            return {'ok': True, 'file': path, 'machine_read': mr, 'draft': draft, 'agrees_with_draft': item['agrees_with_draft'],
                    'agreement': self.agreement()}

    def agreement(self):
        """Anthony's SWEEP against the draft's TAKE, over every saved grade with a verdict. In blind mode before the grade
        is saved the list carries no dates or times (only what was graded and what the draft said)."""
        gs = [g for g in core.list_grades(self.marks) if (g.get('draft') or {}).get('verdict') in ('TAKE', 'PASS')]
        agree = sum(1 for g in gs if g.get('agrees_with_draft'))
        dis = [{'id': g['id'], 'setup': g.get('setup'), 'verdict': g['draft']['verdict']} for g in gs if not g.get('agrees_with_draft')]
        return {'agree': agree, 'total': len(gs), 'disagreements': dis}

    def open_grade(self, gid):
        g = next((x for x in core.list_grades(self.marks) if x.get('id') == gid), None)
        if g is None:
            raise Refused('no grade with that id')
        lv = {'type': g.get('level_type'), 'price': g.get('level_price')} if g.get('level_price') is not None else None
        st = self.free_load(g['date'], clock_utc=g['clock_utc_ms'], level=lv)
        return st

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
        path = os.path.join(self.marks, 'chips.json')
        with self.lock:
            extra = [x for x in self.chips() if x not in core.DEFAULT_CHIPS]
            if text not in extra and text not in core.DEFAULT_CHIPS:
                extra.append(text)
            tmp = path + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(extra, f, indent=1)
            os.replace(tmp, path)
        return self.chips()

    # ---------------------------------------------------------------- the charts' WebSocket (read only)
    def _drop_clients(self):
        for c in list(self.clients):
            c.close()
        self.clients.clear()

    def ws_open(self, c):
        with self.lock:
            self.clients.add(c)
            c.send({'type': 'hello', 'version': VERSION, 'now': self.clock, 'accounts': [],
                    'instruments': [{'root': self.symbol, 'name': self.symbol + ' replay', 'tick': core.TICK, 'pointValue': 20}]})
            c.send({'type': 'execs', 'list': []})

    def ws_message(self, c, m):
        if not isinstance(m, dict) or m.get('type') != 'subscribe':
            return                                   # read only: everything else (orders included) is ignored
        with self.lock:
            if self.day is None:
                c.send({'type': 'status', 'level': 'info', 'text': 'No day loaded'})
                return
            if m.get('root') != self.symbol:
                c.send({'type': 'status', 'level': 'info', 'text': 'Markup Studio serves ' + self.symbol + ' only'})
                return
            v = self.vis()
            r = self.symbol
            bars = core.minute_bars(v)
            for i in range(0, max(1, len(bars)), 4000):
                c.send({'type': 'history', 'root': r, 'name': r + ' replay', 'barSeconds': 60, 'bars': bars[i:i + 4000], 'done': i + 4000 >= len(bars)})
            rows = tick_rows(v, 0, len(v))
            for i in range(0, max(1, len(rows)), 20000):
                c.send({'type': 'ticks', 'root': r, 'ticks': rows[i:i + 20000], 'done': i + 20000 >= len(rows)})
            c.send({'type': 'ready', 'root': r})
            c.sent, c.ready = len(v), True

    def _release(self):
        """Live ticks up to the clock to every chart that is loaded."""
        if self.day is None:
            return
        n = visible_count(self.day, self.clock)
        for c in list(self.clients):
            if c.ready and c.sent < n:
                c.send_many([tick_msg(self.day, i, self.symbol) for i in range(c.sent, n)])
                c.sent = n


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
                    return self._json(200, {'items': [{'id': g.get('id'), 'setup': g.get('setup')} for g in core.list_grades(studio.marks)]})
            except Refused as e:
                return self._json(409, {'error': str(e)})
            except (ValueError, KeyError) as e:
                return self._json(400, {'error': str(e)})
            return self._static(u.path)

        def do_POST(self):
            why = self._gate()
            if why:
                return self._json(403, {'error': why})
            n = int(self.headers.get('Content-Length') or 0)
            try:
                p = json.loads(self.rfile.read(n) or b'{}') if n else {}
            except ValueError:
                return self._json(400, {'error': 'not JSON'})
            path = urlparse(self.path).path
            try:
                if path == '/api/blind/next':
                    return self._json(200, studio.blind_next())
                if path == '/api/free/load':
                    return self._json(200, studio.free_load(p.get('date'), p.get('time')))
                if path == '/api/free/open':
                    return self._json(200, studio.open_grade(p.get('id')))
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
            except (ValueError, KeyError, TypeError) as e:
                return self._json(400, {'error': str(e)})
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
    seen = opt['seen'].split(',') if opt.get('seen') else default_seen()
    studio = Studio(source, marks, opt.get('rule', os.path.join(REPO, 'tools', 'markup_rule_v0.json')), seen, symbol)
    studio.start_scan()
    server = ThreadingHTTPServer(('127.0.0.1', port), make_handler(studio, port))
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
