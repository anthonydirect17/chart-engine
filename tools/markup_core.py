"""Markup Studio core: day data, sweep candidates, the machine read, rule draft v0, marks on disk.

Pure functions over numpy arrays. Nothing here looks at a tick past the clock: every function that takes a clock is
handed arrays the server has already cut at the clock (markup_studio.visible_count), and the candidate scan walks a
day in time order using only ticks up to each candidate's own reclaim.

Times:
  wall  New York wall-clock ms stored as if UTC (tickreplay's convention, and the chart engine's `t` times 1000)
  utc   true UTC epoch ms (the replay clock)
Python 3.10+, stdlib + numpy only.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import random
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
import numpy as np

try:                                   # Windows Python has no time zone database unless the tzdata package is installed
    from zoneinfo import ZoneInfo
    NY = ZoneInfo('America/New_York')
except Exception:                      # noqa: BLE001 - the US rules below are used instead
    NY = None
HOLDOUT = date(2026, 4, 1)           # this date and later is the holdout: never listed, loaded, scanned or graded
# Every instrument's numbers, in this one place: tick size, $ per point and $ per round trip (1 contract, commissions and
# fees). The Studio runs on a full contract (one with a 'micro') and prices its trades on that contract and its micro.
# Round trips are the prop account rates; ES and MES cost the same as NQ and MNQ (NinjaTrader's commission table,
# as of 2026-08-14, lists identical fees for ES/NQ and for MES/MNQ).
INSTRUMENTS = {
    'NQ': {'tick': 0.25, 'point_value': 20.0, 'rt': 4.50, 'micro': 'MNQ'},
    'ES': {'tick': 0.25, 'point_value': 50.0, 'rt': 4.50, 'micro': 'MES'},
    'MNQ': {'tick': 0.25, 'point_value': 2.0, 'rt': 1.00},
    'MES': {'tick': 0.25, 'point_value': 5.0, 'rt': 1.00},
}
STUDIO_SYMBOLS = tuple(sorted(k for k, v in INSTRUMENTS.items() if v.get('micro')))
TICK = INSTRUMENTS['NQ']['tick']      # the default tick of the candidate scan and the machine read; the Studio passes its own
MIN = 60_000
RTH_OPEN = 9 * 3600 + 30 * 60         # seconds of the day, wall clock
RTH_CLOSE = 16 * 3600
SESSION_START = 18 * 3600


class HoldoutError(ValueError):
    pass


def parse_date(s) -> date:
    if isinstance(s, date):
        return s
    m = re.fullmatch(r'(\d{4})-?(\d{2})-?(\d{2})', str(s).strip())
    if not m:
        raise ValueError('not a date (YYYY-MM-DD): ' + str(s))
    return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))


def check_date(s) -> str:
    """The date as YYYY-MM-DD, or HoldoutError for 2026-04-01 and later."""
    d = parse_date(s)
    if d >= HOLDOUT:
        raise HoldoutError(f'{d.isoformat()} is in the holdout (2026-04-01 and later); the Studio refuses it')
    return d.isoformat()


def instrument(symbol) -> dict:
    """The Studio's instrument: {'symbol', 'tick', 'point_value', 'rt', 'micro', 'micro_point_value', 'micro_rt'}, or a
    ValueError naming the symbols it knows. Never a silent default."""
    sym = str(symbol or '').strip().upper()
    if sym not in STUDIO_SYMBOLS:
        raise ValueError(f'unknown symbol {symbol!r}: the Studio runs on {" or ".join(STUDIO_SYMBOLS)} '
                         f'({" or ".join("--symbol=" + x for x in STUDIO_SYMBOLS)})')
    i = INSTRUMENTS[sym]
    m = INSTRUMENTS[i['micro']]
    return {'symbol': sym, 'tick': i['tick'], 'point_value': i['point_value'], 'rt': i['rt'], 'micro': i['micro'],
            'micro_point_value': m['point_value'], 'micro_rt': m['rt']}


def in_sample(s) -> bool:
    try:
        check_date(s)
        return True
    except ValueError:
        return False


# ------------------------------------------------------------------------------------------------ time conversion
def _nth_sunday(year, month, n):
    d = date(year, month, 1)
    return d + timedelta(days=(6 - d.weekday()) % 7 + 7 * (n - 1))


def _us_dst(wall: datetime) -> bool:
    """New York daylight time at a wall-clock moment, by the US rules since 2007 (second Sunday of March 02:00 to the
    first Sunday of November 02:00). Only used when the time zone database is missing."""
    start = datetime.combine(_nth_sunday(wall.year, 3, 2), datetime.min.time()) + timedelta(hours=2)
    end = datetime.combine(_nth_sunday(wall.year, 11, 1), datetime.min.time()) + timedelta(hours=1)
    return start <= wall < end


def _offset_ms(hour_index: int) -> int:
    """UTC offset (ms, negative in New York) for the wall-clock hour `hour_index` (hours since 1970 on the wall clock)."""
    wall = datetime(1970, 1, 1) + timedelta(hours=int(hour_index))
    if NY is not None:
        return int(wall.replace(tzinfo=NY).utcoffset().total_seconds() * 1000)
    return (-4 if _us_dst(wall) else -5) * 3_600_000


def wall_to_utc(wall_ms) -> np.ndarray:
    """New York wall-clock ms (stored as if UTC) to true UTC ms. The offset is looked up once per wall hour."""
    w = np.asarray(wall_ms, dtype=np.int64)
    if w.size == 0:
        return w.copy()
    hours = np.floor_divide(w, 3_600_000)
    uniq, inv = np.unique(hours, return_inverse=True)
    offs = np.array([_offset_ms(h) for h in uniq], dtype=np.int64)
    return w - offs[inv]


def utc_to_wall(utc_ms: int) -> int:
    if NY is not None:
        dt = datetime.fromtimestamp(utc_ms / 1000, tz=timezone.utc).astimezone(NY)
        return int(utc_ms + dt.utcoffset().total_seconds() * 1000)
    est = int(utc_ms) - 5 * 3_600_000
    return est + 3_600_000 if _us_dst(datetime(1970, 1, 1) + timedelta(milliseconds=est)) else est


def wall_of(d: str, hh: int, mm: int = 0, ss: int = 0) -> int:
    """Wall ms of a time on a calendar day."""
    x = parse_date(d)
    return int((datetime(x.year, x.month, x.day, hh, mm, ss) - datetime(1970, 1, 1)).total_seconds() * 1000)


def tod_s(wall_ms) -> np.ndarray:
    return np.floor_divide(np.asarray(wall_ms, dtype=np.int64), 1000) % 86400


def fmt_tod(wall_ms: int) -> str:
    s = int(wall_ms // 1000) % 86400
    return f'{s // 3600:02d}:{s // 60 % 60:02d}:{s % 60:02d}'


def wall_date(wall_ms: int) -> str:
    return (datetime(1970, 1, 1) + timedelta(milliseconds=int(wall_ms))).date().isoformat()


# ------------------------------------------------------------------------------------------------ a day of ticks
@dataclass
class Day:
    date: str                       # the session date (the session runs 18:00 the evening before to 17:00)
    wall: np.ndarray                # int64 wall ms, nondecreasing
    px: np.ndarray                  # float64 price
    vol: np.ndarray                 # int64
    bid: np.ndarray | None = None   # float64, nan when missing
    ask: np.ndarray | None = None
    utc: np.ndarray = field(default=None)
    side: np.ndarray = field(default=None)   # int8: 1 buy, -1 sell, 0 unknown
    sm: np.ndarray = field(default=None)     # int8: 2 bid/ask, 3 tick rule, 0 none (ChartBridge's codes)

    def __post_init__(self):
        self.wall = np.asarray(self.wall, dtype=np.int64)
        self.px = np.asarray(self.px, dtype=np.float64)
        self.vol = np.asarray(self.vol, dtype=np.int64)
        if self.utc is None:
            self.utc = wall_to_utc(self.wall)
        if self.side is None:
            self.side, self.sm = classify(self.px, self.bid, self.ask)

    @property
    def has_quotes(self) -> bool:
        return self.bid is not None and self.ask is not None and bool(np.isfinite(self.bid).any())

    def __len__(self):
        return int(self.px.size)

    def upto(self, n: int) -> 'Day':
        """The first n ticks only (the server cuts at the clock and hands this on)."""
        n = int(n)
        return Day(self.date, self.wall[:n], self.px[:n], self.vol[:n],
                   None if self.bid is None else self.bid[:n], None if self.ask is None else self.ask[:n],
                   self.utc[:n], self.side[:n], self.sm[:n])


def classify(px, bid, ask):
    """Trade sides as ChartBridge does: at or above the ask a buy, at or below the bid a sell (sm 2); otherwise the tick
    rule (sm 3: up a buy, down a sell, unchanged the previous side); unknown (0, 0) before the first move."""
    px = np.asarray(px, dtype=np.float64)
    n = px.size
    d = np.zeros(n, dtype=np.int8)
    if n > 1:
        d[1:] = np.sign(np.diff(px)).astype(np.int8)
    idx = np.where(d != 0, np.arange(n), 0)
    np.maximum.accumulate(idx, out=idx)
    tick = d[idx]
    side = tick.copy()
    sm = np.where(tick != 0, 3, 0).astype(np.int8)
    if bid is not None and ask is not None and n:
        b = np.asarray(bid, dtype=np.float64)
        a = np.asarray(ask, dtype=np.float64)
        ok = np.isfinite(b) & np.isfinite(a) & (b > 0) & (a > b)
        buy = ok & (px >= a - 1e-9)
        sell = ok & (px <= b + 1e-9)
        side = np.where(buy, 1, np.where(sell, -1, side)).astype(np.int8)
        sm = np.where(buy | sell, 2, sm).astype(np.int8)
    return side, sm


def minute_bars(day: Day):
    """1-minute bars from the ticks (start-inclusive, as live/bar-builder.js): list of [t_wall_s, o, h, l, c, v]."""
    if not len(day):
        return []
    k = np.floor_divide(day.wall, MIN)
    starts = np.flatnonzero(np.r_[True, k[1:] != k[:-1]])
    ends = np.r_[starts[1:], k.size]
    hi = np.maximum.reduceat(day.px, starts)
    lo = np.minimum.reduceat(day.px, starts)
    v = np.add.reduceat(day.vol, starts)
    return [[int(k[s]) * 60, float(day.px[s]), float(hi[i]), float(lo[i]), float(day.px[e - 1]), int(v[i])]
            for i, (s, e) in enumerate(zip(starts, ends))]


def bars_of(day: Day, seconds: int, clock_wall: int | None = None, closed_only: bool = False):
    """OHLC bars of `seconds` from the ticks: dict of arrays t (wall ms start), o, h, l, c. closed_only keeps bars whose
    end is at or before clock_wall."""
    if not len(day):
        z = np.zeros(0)
        return {'t': z.astype(np.int64), 'o': z, 'h': z, 'l': z, 'c': z}
    ms = seconds * 1000
    k = np.floor_divide(day.wall, ms)
    starts = np.flatnonzero(np.r_[True, k[1:] != k[:-1]])
    ends = np.r_[starts[1:], k.size]
    out = {'t': k[starts] * ms, 'o': day.px[starts], 'h': np.maximum.reduceat(day.px, starts),
           'l': np.minimum.reduceat(day.px, starts), 'c': day.px[ends - 1]}
    if closed_only and clock_wall is not None:
        keep = out['t'] + ms <= clock_wall
        out = {key: v[keep] for key, v in out.items()}
    return out


def wilder_atr(h, l, c, period=14):
    n = len(h)
    if n < period:
        return None
    tr = np.empty(n)
    tr[0] = h[0] - l[0]
    if n > 1:
        pc = c[:-1]
        tr[1:] = np.maximum(h[1:] - l[1:], np.maximum(np.abs(h[1:] - pc), np.abs(l[1:] - pc)))
    atr = float(np.mean(tr[:period]))
    for x in tr[period:]:
        atr = (atr * (period - 1) + float(x)) / period
    return atr


# ------------------------------------------------------------------------------------------------ candidates
SWEEP_TICKS = 4          # through the level by at least this many ticks
RECLAIM_TICKS = 1        # back on the original side by at least this many ticks
WINDOW_MS = 120_000      # both within this long of the first cross
REFRACTORY_MS = 30 * MIN
FIRST_RTH_S = RTH_OPEN + 60


def day_levels(day: Day, prev_hilo):
    """[(type, price)]: PDH/PDL from the prior kept day's RTH high and low (prev_hilo, from rth_hilo; None when there is
    no prior kept day), ONH/ONL from 18:00 the evening before to 09:29:59,
    only when the day has overnight ticks (has_overnight)."""
    out = []
    if prev_hilo:
        out += [('PDH', float(prev_hilo[0])), ('PDL', float(prev_hilo[1]))]
    if USE_OVERNIGHT_LEVELS and has_overnight(day):
        s = tod_s(day.wall)
        m = (s >= SESSION_START) | (s < RTH_OPEN)
        out += [('ONH', float(day.px[m].max())), ('ONL', float(day.px[m].min()))]
    return out


# Anthony 2026-10-03: train on RTH sweeps only (candidates fire 09:31 to 16:00), but KEEP ONH/ONL as levels when the
# day really has overnight ticks (has_overnight); a day packed without them gets no ONH/ONL.
USE_OVERNIGHT_LEVELS = True


OVERNIGHT_GRACE_S = 15 * 60   # the session's first tick must come by 18:15 the evening before


def has_overnight(day: Day) -> bool:
    """True when the day's ticks start in the evening session (by 18:15 the evening before). Some packed days start in
    the morning (no overnight ticks); their 'overnight' high and low would only be the pre-open minutes, so no ONH/ONL."""
    if not len(day):
        return False
    s0 = int(tod_s(day.wall[:1])[0])
    return SESSION_START <= s0 <= SESSION_START + OVERNIGHT_GRACE_S


MAX_GAP_MS = 5 * MIN     # a gap longer than this inside RTH (a halt): no candidates from there on


def has_morning(day: Day) -> bool:
    """The research's rule: a day whose first RTH tick is after noon (or with none) is not kept."""
    s = tod_s(day.wall)
    rth = np.flatnonzero((s >= RTH_OPEN) & (s < RTH_CLOSE))
    return bool(rth.size) and int(s[rth[0]]) < 12 * 3600


def rth_halt_wall(day: Day):
    """Wall ms of the last tick before the first gap of more than MAX_GAP_MS inside RTH (None without one)."""
    s = tod_s(day.wall)
    rth = np.flatnonzero((s >= RTH_OPEN) & (s < RTH_CLOSE))
    if rth.size < 2:
        return None
    w = day.wall[rth]
    big = np.flatnonzero(np.diff(w) > MAX_GAP_MS)
    return int(w[big[0]]) if big.size else None


def rth_hilo(day: Day):
    s = tod_s(day.wall)
    m = (s >= RTH_OPEN) & (s < RTH_CLOSE)
    return (float(day.px[m].max()), float(day.px[m].min())) if m.any() else None


def _sides(px, level):
    """Side of each tick against the level (1 above, -1 below), an exact touch keeping the side before it."""
    s = np.sign(px - level).astype(np.int8)
    idx = np.where(s != 0, np.arange(s.size), 0)
    np.maximum.accumulate(idx, out=idx)
    return s[idx]


def find_sweep(day: Day, level: float, i_cross: int, tick=TICK):
    """For a cross at tick i_cross: (i_deep, i_reclaim) when the price went SWEEP_TICKS through and came back
    RECLAIM_TICKS on the original side within WINDOW_MS of the cross, else None. Uses ticks up to the reclaim only."""
    up = day.px[i_cross] > level
    end = int(np.searchsorted(day.utc, day.utc[i_cross] + WINDOW_MS, 'right'))
    w = day.px[i_cross:end]
    deep = w >= level + SWEEP_TICKS * tick - 1e-9 if up else w <= level - SWEEP_TICKS * tick + 1e-9
    if not deep.any():
        return None
    j = int(np.argmax(deep))
    back = w[j:] <= level - RECLAIM_TICKS * tick + 1e-9 if up else w[j:] >= level + RECLAIM_TICKS * tick - 1e-9
    if not back.any():
        return None
    return i_cross + j, i_cross + j + int(np.argmax(back))


def find_candidates(day: Day, prev_hilo, tick=TICK):
    """The day's sweep candidates (the research's definition, BRIEF_M1b item 4). No outcome fields."""
    out = []
    if not len(day):
        return out
    s = tod_s(day.wall)
    halt = rth_halt_wall(day)
    for ltype, level in day_levels(day, prev_hilo):
        side = _sides(day.px, level)
        cross = np.flatnonzero((side[1:] != side[:-1]) & (side[:-1] != 0)) + 1
        last = None
        for i in cross:
            i = int(i)
            if not (FIRST_RTH_S <= s[i] < RTH_CLOSE):
                continue
            if halt is not None and day.wall[i] > halt:
                break
            if last is not None and day.utc[i] < last + REFRACTORY_MS:
                continue
            hit = find_sweep(day, level, i, tick)
            if hit is None:
                continue
            _, r = hit
            up = day.px[i] > level
            rw = int(day.wall[r])
            cut_wall = (rw // MIN + 1) * MIN
            cid = f'C{day.date.replace("-", "")}{ltype}{fmt_tod(day.wall[i]).replace(":", "")}'
            out.append({'id': cid, 'date': day.date, 'quotes': bool(day.has_quotes), 'dir': 'short' if up else 'long', 'level_type': ltype,
                        'level_price': level, 'cross_utc_ms': int(day.utc[i]), 'reclaim_utc_ms': int(day.utc[r]),
                        'reclaim_wall_ms': rw, 'cut_utc_ms': int(day.utc[r]) + (cut_wall - rw)})
            last = int(day.utc[i])
    out.sort(key=lambda c: c['cross_utc_ms'])
    return out


def shuffled(items, seed=4):
    xs = sorted(items, key=lambda c: (c['date'], c['cross_utc_ms'], c['level_type']))
    random.Random(seed).shuffle(xs)
    return xs


# ------------------------------------------------------------------------------------------------ already seen
def _find_col(names, *keys):
    for k in keys:
        for n in names:
            if k in n.lower():
                return n
    return None


def _wall_from(value, day: str):
    """A reclaim time from a CSV cell: epoch ms, an ISO date-time, or HH:MM[:SS] on `day` (New York wall clock)."""
    v = str(value).strip()
    if not v:
        return None
    if re.fullmatch(r'\d{12,14}(\.\d*)?', v):
        return float(v)
    m = re.search(r'(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?', v)
    if m:
        return wall_of(m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4) or 0))
    m = re.fullmatch(r'(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?', v)
    if m and day:
        return wall_of(day, int(m.group(1)), int(m.group(2))) + float(m.group(3) or 0) * 1000
    return None


# Round 1 sweep prints are named E2_<n>_<date>_<event ms>_<level>.csv (the event is the reclaim tick); the rows are ticks.
PRINT_NAME = re.compile(r'^E2_\d+_(\d{4}-\d{2}-\d{2})_(\d{10,14})_(PDH|PDL|ONH|ONL)\.csv$', re.IGNORECASE)


def read_seen(paths, report=None):
    """Best effort: [(date, level_type, reclaim_ms)] from the blind-chart KEY.csv and event-study print CSVs. `report`, a
    list, gets one {path, rows, parsed, columns} per file read (parsed: rows with a date and a reclaim time)."""
    seen = []
    for p in paths:
        m = PRINT_NAME.match(re.split(r'[\\/]', str(p))[-1])     # either slash, whatever the OS
        if m:                                   # an event-study print: the event is in the file name, not the rows
            seen.append((m.group(1), m.group(3).upper(), float(m.group(2))))
            if report is not None:
                report.append({'path': p, 'rows': 1, 'parsed': 1, 'columns': ['file name']})
            continue
        try:
            with open(p, newline='', encoding='utf-8-sig') as f:
                rd = csv.DictReader(f)
                rows = list(rd)
                names = list(rd.fieldnames or [])
        except (OSError, UnicodeDecodeError, csv.Error):
            continue
        n0 = len(seen)
        if report is not None:
            report.append({'path': p, 'rows': len(rows), 'parsed': 0, 'columns': names})
        if not rows:
            continue
        dc = _find_col(names, 'date', 'day')
        lc = _find_col(names, 'level_type', 'level')
        rc = _find_col(names, 'reclaim')
        for r in rows:
            try:
                d = parse_date(str(r.get(dc, '')).strip()[:10]).isoformat() if dc else None
            except ValueError:
                d = None
            lt = str(r.get(lc, '')).strip().upper() if lc else ''
            lt = next((x for x in ('PDH', 'PDL', 'ONH', 'ONL') if x in lt), '')
            t = _wall_from(r.get(rc, ''), d) if rc else None
            if d:
                seen.append((d, lt, t))
        if report is not None:
            report[-1]['parsed'] = sum(1 for x in seen[n0:] if x[2] is not None)
    return seen


def is_seen(c, seen, within_ms=180_000):
    for d, lt, t in seen:
        if d != c['date'] or (lt and lt != c['level_type']):
            continue
        if t is None:
            continue
        if abs(t - c['reclaim_wall_ms']) <= within_ms or abs(t - c['reclaim_utc_ms']) <= within_ms:
            return True
    return False


# ------------------------------------------------------------------------------------------------ the machine read
def _price_at(day: Day, utc_ms):
    """The last price at or before utc_ms (None when there is none)."""
    i = int(np.searchsorted(day.utc, utc_ms, 'right')) - 1
    return float(day.px[i]) if i >= 0 else None


def last_cross(day: Day, level: float, tick=TICK):
    """The cross that started the latest probe through the level: the latest cross after which the price went at least
    SWEEP_TICKS through before crossing back (a cross back, the reclaim, is not a probe); with none, the latest cross.
    None if the price never crossed."""
    side = _sides(day.px, level)
    cross = np.flatnonzero((side[1:] != side[:-1]) & (side[:-1] != 0)) + 1
    if not cross.size:
        return None
    ends = np.r_[cross[1:], day.px.size]
    for j, e in zip(cross[::-1], ends[::-1]):
        seg = day.px[j:e]
        if (side[j] > 0 and seg.max() >= level + SWEEP_TICKS * tick - 1e-9) or (side[j] < 0 and seg.min() <= level - SWEEP_TICKS * tick + 1e-9):
            return int(j)
    return int(cross[-1])


def machine_read(day: Day, clock_utc: int, level: float, cross_utc: int | None = None, tick=TICK, exclusive=False,
                 direction: str | None = None):
    """Bot-mechanics numbers for one level at the clock. `day` must already be cut at the clock (the server does it);
    the function also refuses any tick after clock_utc on its own (and, exclusive, one exactly at it, as blind mode
    does). No outcome is computed."""
    n = int(np.searchsorted(day.utc, clock_utc, 'left' if exclusive else 'right'))
    day = day.upto(n)
    clock_wall = utc_to_wall(clock_utc)
    if cross_utc is None:
        i = last_cross(day, level, tick)
    else:
        i = int(np.searchsorted(day.utc, cross_utc, 'left'))
        if direction in ('long', 'short'):
            # Several trades can share the cross's millisecond: step to the first one actually beyond the level on the
            # candidate's side (a long is a sweep DOWN through the level, a short a sweep UP), never trusting tick order
            # inside the millisecond to say which side the sweep was on.
            below = direction == 'long'
            while i < n and int(day.utc[i]) <= cross_utc and not (day.px[i] < level if below else day.px[i] > level):
                i += 1
            if i < n and int(day.utc[i]) > cross_utc:
                i = int(np.searchsorted(day.utc, cross_utc, 'left'))
        if i >= n:
            i = None
    if i is None or i <= 0:
        return {'ok': False, 'why': 'no cross of this level at or before the clock'}
    tc = int(day.utc[i])
    up = bool(day.px[i] > level) if direction not in ('long', 'short') else direction == 'short'
    into = 1 if up else -1
    sgn = 1.0 if up else -1.0
    quotes = day.has_quotes
    if quotes:
        into_vol = np.where((day.side == into) & (day.sm == 2), day.vol, 0)
        basis = 'aggressive volume into the level (bid/ask)'
    else:
        into_vol = day.vol
        basis = 'total volume (no quotes this day)'

    def vol_between(a, b):
        ia, ib = np.searchsorted(day.utc, a, 'left'), np.searchsorted(day.utc, b, 'left')
        return int(into_vol[ia:ib].sum())

    windows = [vol_between(tc - (5 - k) * MIN, tc - (4 - k) * MIN) for k in range(5)]
    slope = float(np.polyfit(np.arange(5), np.array(windows, dtype=float), 1)[0])
    # the probe: from the cross to the reclaim, the reclaim defined as the detector does it (find_sweep): the first
    # tick back on the original side by a tick AFTER the price has gone SWEEP_TICKS through. A wiggle back across the
    # level before the push through is not the reclaim (at HOME it cut the probe to 0 s and 0.25 points).
    w = day.px[i:]
    deep = w >= level + SWEEP_TICKS * tick - 1e-9 if up else w <= level - SWEEP_TICKS * tick + 1e-9
    j = int(np.argmax(deep)) if deep.any() else 0
    back = w[j:] <= level - RECLAIM_TICKS * tick + 1e-9 if up else w[j:] >= level + RECLAIM_TICKS * tick - 1e-9
    r = i + j + int(np.argmax(back)) if back.any() else None
    end_utc = int(day.utc[r]) if r is not None else clock_utc
    probe_px = day.px[i:(r + 1 if r is not None else n)]
    depth = float((probe_px.max() - level) if up else (level - probe_px.min()))
    probe_min = max((end_utc - tc) / MIN, 1 / 60)
    probe_rate = vol_between(tc, end_utc + 1) / probe_min
    pre2_rate = vol_between(tc - 2 * MIN, tc) / 2
    b5 = bars_of(day, 300, clock_wall, closed_only=True)
    atr = wilder_atr(b5['h'], b5['l'], b5['c'], 14)
    # approach
    p_in = float(day.px[i - 1])
    p2, p5 = _price_at(day, tc - 2 * MIN), _price_at(day, tc - 5 * MIN)
    a2 = None if p2 is None else sgn * (p_in - p2)
    a5 = None if p5 is None else sgn * (p_in - p5)
    i5 = int(np.searchsorted(day.utc, tc - 5 * MIN, 'right'))
    seq = day.px[max(0, i5 - 1):i]
    path = float(np.abs(np.diff(seq)).sum()) if seq.size > 1 else 0.0
    er = abs(float(seq[-1] - seq[0])) / path if path > 0 else None
    # 1-minute candles: the reclaim close and the confirmation
    b1 = bars_of(day, 60)
    t1, done = b1['t'], b1['t'] + MIN <= clock_wall
    cross_k = int(np.searchsorted(t1, (int(day.wall[i]) // MIN) * MIN, 'left'))
    closed_back = (b1['c'] < level) if up else (b1['c'] > level)
    rk = None
    for k in range(cross_k, t1.size):
        if done[k] and closed_back[k]:
            rk = k
            break
    reclaim = 'not closed back yet' if rk is None else 'same-candle wick close back' if rk == cross_k else 'later candle close back'
    confirm, entry_b = 'not yet known', None
    failed = None
    if rk is not None:
        failed = {'t_wall_ms': int(t1[rk]), 'o': float(b1['o'][rk]), 'h': float(b1['h'][rk]), 'l': float(b1['l'][rk]),
                  'c': float(b1['c'][rk])}
        nxt = int(t1[rk]) + MIN
        ia, ib = np.searchsorted(day.wall, nxt, 'left'), np.searchsorted(day.wall, nxt + MIN, 'left')
        seg = day.px[ia:ib]
        entry_b = failed['l'] - tick if up else failed['h'] + tick
        broke = (seg <= entry_b + 1e-9) if up else (seg >= entry_b - 1e-9)
        if broke.any():
            confirm = 'yes'
        elif nxt + MIN <= clock_wall:
            confirm = 'no'
    # earlier touches today: runs of 1-minute candles before the cross candle whose range held the level
    touch = (b1['l'][:cross_k] <= level + 1e-9) & (b1['h'][:cross_k] >= level - 1e-9)
    touches = int(np.count_nonzero(touch & ~np.r_[False, touch[:-1]])) if cross_k else 0
    rnd = lambda x, k=2: None if x is None else round(float(x), k)
    return {
        'ok': True, 'clock_utc_ms': int(clock_utc), 'clock_tod': fmt_tod(clock_wall), 'level': level,
        'sweep': 'up through the level' if up else 'down through the level', 'side_for_trade': 'short' if up else 'long',
        'cross_utc_ms': tc, 'cross_tod': fmt_tod(int(day.wall[i])), 'volume_basis': basis, 'quotes': quotes,
        'into_level_windows': windows, 'into_level_slope_per_min': rnd(slope),
        'probe_into_rate_per_min': rnd(probe_rate, 1), 'pre2_into_rate_per_min': rnd(pre2_rate, 1),
        'probe_vs_pre2': rnd(probe_rate / pre2_rate) if pre2_rate > 0 else None,
        'depth_points': rnd(depth), 'atr14_5m': rnd(atr), 'depth_atr': rnd(depth / atr, 3) if atr else None,
        'probe_seconds': rnd((end_utc - tc) / 1000, 1), 'probe_closed': r is not None,
        'approach_2m_points': rnd(a2), 'approach_5m_points': rnd(a5),
        'approach_points_per_min_2m': rnd(None if a2 is None else a2 / 2), 'efficiency_5m': rnd(er, 3),
        'reclaim': reclaim, 'failed_candle': failed, 'confirmation': confirm,
        'entry_a': None if failed is None else failed['c'], 'entry_b': entry_b,
        'earlier_touches_today': touches,
    }


# ------------------------------------------------------------------------------------------------ rule draft v0
RULE_DEFAULT = {'name': 'draft v0', 'slope_below': 0.0, 'reclaim_closes': ['same-candle wick close back', 'later candle close back']}


def load_rule(path):
    rule = dict(RULE_DEFAULT)
    try:
        with open(path, encoding='utf-8') as f:
            rule.update(json.load(f))
    except (OSError, ValueError):
        pass
    return rule


def draft_verdict(mr, rule):
    """TAKE when the volume into the level is falling (slope below the threshold) and a candle has closed back."""
    if not mr or not mr.get('ok'):
        return {'verdict': 'n/a', 'why': ['no machine read'], 'rule': rule.get('name')}
    why = []
    slope_ok = mr['into_level_slope_per_min'] is not None and mr['into_level_slope_per_min'] < rule['slope_below']
    why.append(f"volume into level slope {mr['into_level_slope_per_min']} {'<' if slope_ok else '>='} {rule['slope_below']}")
    closed = mr['reclaim'] in rule['reclaim_closes']
    why.append('reclaim candle closed back' if closed else 'no reclaim close yet')
    take = slope_ok and closed
    return {'verdict': 'TAKE' if take else 'PASS', 'why': why, 'rule': rule.get('name'),
            'entry_a': mr.get('entry_a') if take else None, 'entry_b': mr.get('entry_b') if take else None}


def agrees(setup, verdict):
    """Anthony's SWEEP against the draft's TAKE (and anything else against PASS)."""
    return (setup == 'SWEEP') == (verdict == 'TAKE')


# ------------------------------------------------------------------------------------------------ marks on disk
def safe_name(s):
    return re.sub(r'[^A-Za-z0-9_.-]', '_', str(s))[:80] or 'item'


def replace_retry(src, dest, tries=3, wait=0.25):
    """os.replace, tried again a few times: on Windows an antivirus or OneDrive can hold a file for a moment
    (PermissionError). Then a clear error."""
    for k in range(tries):
        try:
            os.replace(src, dest)
            return
        except PermissionError as e:
            if k == tries - 1:
                raise OSError(f'could not write {dest}: the file is locked (antivirus or OneDrive?): {e}') from e
            time.sleep(wait)


def write_text(dest, text):
    """Write a whole file atomically: a temp file next to it, flushed, then moved onto the name."""
    tmp = f'{dest}.{os.getpid()}.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8', newline='') as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        replace_retry(tmp, dest)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def _claim(tmp, dest):
    """Put the finished temp file at dest only if dest does not exist yet: a hard link (fails when dest exists) or, where a
    link cannot be made, a rename, which on Windows also fails when dest exists. Never an empty placeholder."""
    try:
        os.link(tmp, dest)
        return True
    except FileExistsError:
        return False
    except OSError:
        if os.name != 'nt':
            raise
    try:
        os.rename(tmp, dest)
        return True
    except FileExistsError:
        return False


def save_grade(marks_dir, item: dict) -> str:
    """One JSON per graded item, never overwriting a file (a second grade of an id gets _2, _3, ...): the whole file is
    written to a temp file first and then claimed under a free name (_claim). Also appends to marks_log.jsonl."""
    os.makedirs(marks_dir, exist_ok=True)
    base = 'grade_' + safe_name(item['id'])
    tmp = os.path.join(marks_dir, f'.{base}.{os.getpid()}.{threading.get_ident()}.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(json.dumps(item, indent=2, sort_keys=True))
        f.flush()
        os.fsync(f.fileno())
    try:
        for k in range(1, 10000):
            dest = os.path.join(marks_dir, base + ('' if k == 1 else f'_{k}') + '.json')
            if _claim(tmp, dest):
                break
        else:
            raise OSError('no free file name for ' + base)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    with open(os.path.join(marks_dir, 'marks_log.jsonl'), 'a', encoding='utf-8') as f:
        f.write(json.dumps(item, sort_keys=True) + '\n')
    return dest


def list_grades(marks_dir):
    out = []
    try:
        names = sorted(os.listdir(marks_dir))
    except OSError:
        return out
    for n in names:
        if n.startswith('grade_') and n.endswith('.json'):
            try:
                with open(os.path.join(marks_dir, n), encoding='utf-8') as f:
                    out.append(json.load(f))
            except (OSError, ValueError):
                pass
    return out


def marks_symbols(marks_dir, grades=None) -> set:
    """The symbols a marks folder's own files name: its candidate cache (candidates_v1.json) and its grades."""
    out = set()
    try:
        with open(os.path.join(marks_dir, 'candidates_v1.json'), encoding='utf-8') as f:
            out.add(json.load(f).get('symbol'))
    except (OSError, ValueError, AttributeError):
        pass
    out.update(g.get('symbol') for g in (list_grades(marks_dir) if grades is None else grades))
    return {str(x).upper() for x in out if x}


def export_csv(marks_dir) -> tuple[str, int]:
    """marks_export.csv: one flat row per grade."""
    rows = []
    for g in list_grades(marks_dir):
        r = {k: g.get(k) for k in ('id', 'mode', 'date', 'symbol', 'clock_tod', 'clock_utc_ms', 'level_type', 'level_price',
                                   'setup', 'direction', 'reason', 'steps_after_cut', 'saved_utc')}
        r['chips'] = ';'.join(g.get('chips') or [])
        d = g.get('draft') or {}
        r['draft_verdict'] = d.get('verdict')
        r['agrees_with_draft'] = g.get('agrees_with_draft')
        for k, v in (g.get('machine_read') or {}).items():
            if isinstance(v, (int, float, str, bool)) or v is None:
                r['mr_' + k] = v
            elif k == 'into_level_windows':
                for j, x in enumerate(v):
                    r[f'mr_into_w{j - 5}'] = x
        for m in g.get('marks') or []:
            key = safe_name(m.get('role', '')).lower()
            r[f'mark_{key}_chart'], r[f'mark_{key}_utc_ms'], r[f'mark_{key}_price'] = m.get('chart'), m.get('bar_time_utc_ms'), m.get('price')
        for s in g.get('spans') or []:
            key = safe_name(s.get('role', '')).lower()
            r[f'span_{key}_seconds'] = s.get('seconds')
            r[f'span_{key}_from_utc_ms'], r[f'span_{key}_to_utc_ms'] = s.get('from_utc_ms'), s.get('to_utc_ms')
        rows.append(r)
    cols = []
    for r in rows:
        for k in r:
            if k not in cols:
                cols.append(k)
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=cols)
    w.writeheader()
    w.writerows(rows)
    dest = os.path.join(marks_dir, 'marks_export.csv')
    write_text(dest, buf.getvalue())
    return dest, len(rows)


DEFAULT_CHIPS = ['weak volume into level', 'strong volume into level', 'volume drying up', 'fast move into level',
                 'slow grind into level', 'too deep', 'shallow probe', 'clean reclaim close', 'wick reclaim',
                 'no confirmation yet', 'confirmation candle', 'near another level', 'trend day', 'chop', 'time of day',
                 'stop limit on failed candle break']


# ------------------------------------------------------------------------------------------------ the Bot tab (BOT_API v1)
# The Studio knows no trading rule: a bot module (scratchpad contract BOT_API v1) returns events, orders and trades for a
# whole day, and the functions below only split the days, cut what the bot returned at the replay clock and sum trades.
SPLIT_SEED = 7


def bot_split(quote_days, last_only_days, seed=SPLIT_SEED, symbol=None) -> dict:
    """Bot days and grading days: every last-only day goes to the bot; the quote days, sorted and shuffled with the seeded
    shuffle, give their first ceil(n/2) to the bot and the rest to grading. With a symbol the split records it."""
    q = [x['date'] for x in shuffled([{'date': d, 'cross_utc_ms': 0, 'level_type': ''} for d in sorted(set(quote_days))], seed)]
    k = (len(q) + 1) // 2
    sp = {'version': 1, 'seed': seed, 'bot': sorted(set(last_only_days) | set(q[:k])), 'grading': sorted(q[k:])}
    if symbol:
        sp['symbol'] = symbol
    return sp


def check_split(sp, symbol, days=None, folder_symbols=()):
    """A split file read back is this symbol's, or a ValueError (the Studio refuses to start; the file is never rewritten).
    A split that names its symbol must name this one. A legacy split (no symbol: written before splits recorded one, all
    of them NQ) is refused when the folder's grades or candidate cache name another symbol; else taken as NQ's for NQ,
    and for another symbol only when every day in it is one of that symbol's days (`days`), with a warning. Returns the
    warning to log, or None."""
    have = sp.get('symbol')
    if have is not None:
        if str(have).upper() != symbol:
            raise ValueError(f'its day split (bot_split_v1.json) is for {have}, not {symbol}: give {symbol} its own marks folder')
        return None
    others = sorted({str(x).upper() for x in folder_symbols if x} - {symbol})
    if others:
        raise ValueError(f'its day split (bot_split_v1.json) names no symbol and the folder holds {", ".join(others)} grades or '
                         f'candidates: give {symbol} its own marks folder')
    if symbol == 'NQ':
        return None
    if days is None:
        raise ValueError(f'its day split (bot_split_v1.json) names no symbol and the {symbol} days cannot be listed to check it')
    missing = sorted((set(sp['bot']) | set(sp['grading'])) - set(days))
    if missing:
        raise ValueError(f'its day split (bot_split_v1.json) names no symbol (an NQ split from before splits named theirs) and '
                         f'{len(missing)} of its days are not {symbol} days (e.g. {missing[0]}): give {symbol} its own marks folder')
    return (f'day split: bot_split_v1.json names no symbol; every one of its days is an {symbol} day, so it is taken as the '
            f'{symbol} split (the file is not rewritten)')


EVENT_KEYS = ('t', 'kind', 'text', 'price', 'level')
ORDER_KEYS = ('id', 'side', 'type', 'role', 'price', 'limit', 't_from', 't_to', 'status')
TRADE_KEYS = ('id', 'level_type', 'level_price', 'dir', 'entry_t', 'entry', 'stop', 'target', 'target_kind', 'features')
EXIT_KEYS = ('exit_t', 'exit', 'reason', 'points', 'r')


def _pick(d, keys):
    return {k: d.get(k) for k in keys}


def trade_cost(points, contract='NQ'):
    """Net $ of one round trip of 1 contract: points times its $ per point, less its round trip (INSTRUMENTS)."""
    c = INSTRUMENTS[contract]
    return float(points) * c['point_value'] - c['rt']


def contracts(symbol) -> dict:
    """What the dollar fields are in: {'symbol', 'contract', 'micro', 'point_value', 'rt', 'micro_point_value', 'micro_rt'}.
    'usd' fields are 1 `contract` (the symbol), 'usd_micro' fields 1 `micro`, each after its round trip."""
    i = instrument(symbol)
    return {'symbol': i['symbol'], 'contract': i['symbol'], 'micro': i['micro'], 'point_value': i['point_value'], 'rt': i['rt'],
            'micro_point_value': i['micro_point_value'], 'micro_rt': i['micro_rt']}


def bot_view(result, clock_wall, exit_ids=(), symbol='NQ') -> dict:
    """NO-FUTURE for the Bot tab: what the page may see of a bot's day at the clock (wall ms). Events with t <= clock; an
    order only from t_from <= clock, its t_to clipped at the clock and its status only once t_to <= clock; a trade only
    once entry_t <= clock, each exit only once its exit_t <= clock. Only the contract's fields pass (nothing else the bot
    returned). Every /api/bot response about a loaded day is built here. Net $ per exit: 'usd' 1 symbol contract, 'usd_micro'
    1 micro (contracts())."""
    c = int(clock_wall)
    cs = contracts(symbol)
    evs = (result or {}).get('events') or []
    events = [_pick(e, EVENT_KEYS) for e in evs if e['t'] <= c]
    orders = []
    for o in (result or {}).get('orders') or []:
        if o['t_from'] > c:
            continue
        x = _pick(o, ORDER_KEYS)
        done = o['t_to'] <= c
        x['t_to'] = min(int(o['t_to']), c)
        x['status'] = o.get('status') if done else None
        x['open'] = not done
        orders.append(x)
    trades = []
    for t in (result or {}).get('trades') or []:
        if t['entry_t'] > c:
            continue
        x = _pick(t, TRADE_KEYS)
        x['exits'] = {k: _pick(v, EXIT_KEYS) for k, v in (t.get('exits') or {}).items() if v['exit_t'] <= c}
        trades.append(x)
    net = {}
    for k in exit_ids:
        pts = [t['exits'][k]['points'] for t in trades if k in t['exits']]
        net[k] = {'trades': len(pts), 'points': round(sum(pts), 2), 'usd': round(sum(trade_cost(p, cs['contract']) for p in pts), 2),
                  'usd_micro': round(sum(trade_cost(p, cs['micro']) for p in pts), 2)}
    return {'clock_wall_ms': c, 'events': events, 'orders': orders, 'trades': trades, 'net': net, **cs}


def max_drawdown(pnls):
    """The largest fall of closed-trade equity from its running peak (equity starts at 0)."""
    eq = peak = dd = 0.0
    for p in pnls:
        eq += p
        peak = max(peak, eq)
        dd = max(dd, peak - eq)
    return dd


def bot_stats(rows, symbol='NQ') -> dict:
    """rows: closed trades of one variant and one exit id, each {'points', 'r', 'exit_t'}. Costs per round trip, 1 contract:
    'usd' fields the symbol's contract, 'usd_micro' its micro (contracts()); the profit factor on the full contract."""
    cs = contracts(symbol)
    rows = sorted(rows, key=lambda x: x['exit_t'])
    n = len(rows)
    pts = [float(x['points']) for x in rows]
    usd = [trade_cost(p, cs['contract']) for p in pts]
    micro = [trade_cost(p, cs['micro']) for p in pts]
    wins = sum(1 for p in pts if p > 0)
    won, lost = sum(x for x in usd if x > 0), -sum(x for x in usd if x < 0)
    rs = [float(x['r']) for x in rows if x.get('r') is not None]
    r2 = lambda v: None if v is None else round(v, 2)
    return {'trades': n, 'wins': wins, 'losses': n - wins, 'win_pct': r2(100.0 * wins / n) if n else None,
            'avg_r': r2(sum(rs) / len(rs)) if rs else None, 'net_points': r2(sum(pts)),
            'net_usd': r2(sum(usd)), 'net_usd_per_trade': r2(sum(usd) / n) if n else None,
            'net_usd_micro': r2(sum(micro)), 'net_usd_micro_per_trade': r2(sum(micro) / n) if n else None,
            'pf': r2(won / lost) if lost > 0 else None, 'max_dd_usd': r2(max_drawdown(usd)), 'max_dd_usd_micro': r2(max_drawdown(micro))}


def bot_summary(trades, variants, exit_ids, symbol='NQ') -> list:
    """trades: [{'variant': id, 'level_type', 'dir', 'exits': {exit id: {...}}}]. One row per variant x exit id (group
    'all'), then the same split by level_type and by dir. A trade without a given exit is left out of that exit's rows."""
    out = []
    for v in variants:
        mine = [t for t in trades if t['variant'] == v]
        groups = [('all', mine)]
        for key in ('level_type', 'dir'):
            for val in sorted({str(t.get(key)) for t in mine}):
                groups.append((f'{key}={val}', [t for t in mine if str(t.get(key)) == val]))
        for g, ts in groups:
            for k in exit_ids:
                rows = [t['exits'][k] for t in ts if k in (t.get('exits') or {})]
                out.append({'variant': v, 'exit_id': k, 'group': g, **bot_stats(rows, symbol)})
    return out


# ------------------------------------------------------------------------------------------------ the Trades tab
# Anthony grades a bot's own trades blind, one at a time, frozen when the bot placed the trade's entry order: TAKE, ADJUST
# or PASS. The functions below read a Run all trades.csv, build the queue (written once), check that the bot loaded is the
# one that wrote it, find each trade's entry order (the cut) and keep the grades. Nothing here holds a trading rule, and
# nothing here sums an outcome by label: the grades carry no result at all.
TRADE_LABELS = ('TAKE', 'ADJUST', 'PASS')
ENTRY_TYPES = ('stop-limit', 'stop-market', 'limit', 'market')
TRADE_SEED = 11
QUEUE_VERSION = 1


def read_trades_csv(path):
    """A Run all trades.csv: (rows, sha256 of the file's bytes). Old runs (net_nq / net_mnq columns, no symbol column) and
    new ones (net_usd / net_usd_micro, symbol) both work: only variant, date, id, dir, entry_t, entry and stop are read."""
    with open(path, 'rb') as f:
        raw = f.read()
    rows = list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))
    need = ('variant', 'date', 'id', 'dir', 'entry_t', 'entry', 'stop')
    missing = [c for c in need if rows and c not in rows[0]]
    if not rows:
        raise ValueError(f'{path} has no trades')
    if missing:
        raise ValueError(f'{path} has no column {", ".join(missing)} (is it a Run all trades.csv?)')
    return rows, hashlib.sha256(raw).hexdigest()


def qid_of(sha, variant, d, trade_id):
    """An opaque queue id: no date, no trade id (a bot's trade ids may carry the date)."""
    return 'Q' + hashlib.sha1(f'{sha}|{variant}|{d}|{trade_id}'.encode()).hexdigest()[:10]


def trade_queue(rows, sha, variant, bot_days, skip_days=(), seed=TRADE_SEED) -> list:
    """The queue's items [{qid, trade_id, date}]: every row of the variant on a bot day, in sample, not a skip day; sorted
    (date, entry time, id) and shuffled with the seeded shuffle. A trade id twice on one day is refused (ambiguous)."""
    skip, out, seen = set(skip_days), [], set()
    for r in rows:
        if r.get('variant') != variant:
            continue
        d = parse_date(str(r['date'])[:10]).isoformat()
        if d not in bot_days or not in_sample(d) or d in skip:
            continue
        key = (d, str(r['id']))
        if key in seen:
            raise ValueError(f'trades.csv has trade id {r["id"]} twice on one day for variant {variant}')
        seen.add(key)
        out.append({'date': d, 't': int(float(r['entry_t'])), 'id': str(r['id'])})
    out.sort(key=lambda x: (x['date'], x['t'], x['id']))
    random.Random(seed).shuffle(out)
    return [{'qid': qid_of(sha, variant, x['date'], x['id']), 'trade_id': x['id'], 'date': x['date']} for x in out]


def check_queue(stored, want):
    """A queue file read back must agree with the flags given now (symbol, the trades.csv's sha256, variant, seed, skip
    days), else a ValueError naming each difference (the Studio refuses to start; the file is never rewritten)."""
    diff = [f'{k}: the file has {stored.get(k)!r}, the flags give {want[k]!r}' for k in ('symbol', 'sha256', 'variant', 'seed', 'skip_days')
            if stored.get(k) != want[k]]
    if stored.get('version') != QUEUE_VERSION or not isinstance(stored.get('items'), list):
        diff.insert(0, 'not a version 1 queue')
    if diff:
        raise ValueError('its trade queue (trade_queue_v1.json) disagrees with the flags given (' + '; '.join(diff) +
                         '): start with the flags it was written with, or use another marks folder')


def _same_px(a, b, tick):
    blank = lambda x: x is None or (isinstance(x, str) and not x.strip())
    if blank(a) or blank(b):
        return blank(a) and blank(b)
    return round(float(a) / tick) == round(float(b) / tick)


def trade_mismatch(row, trade, tick=TICK) -> list:
    """The fields where the bot's trade differs from the queue's source row: entry and stop to the tick, entry_t to the ms,
    dir exactly. Empty when they match."""
    bad = [k for k in ('entry', 'stop') if not _same_px(row.get(k), trade.get(k), tick)]
    try:
        if int(float(row.get('entry_t'))) != int(trade.get('entry_t')):
            bad.append('entry_t')
    except (TypeError, ValueError):
        bad.append('entry_t')
    if str(row.get('dir')) != str(trade.get('dir')):
        bad.append('dir')
    return bad


def entry_order_of(result, trade, tick=TICK):
    """The order whose fill opened `trade`, by an exact rule, never a guess: (order, how) or a ValueError.
      1. The trade names it: trade['entry_order'] (an order id; optional, BOT_API 1 trades carry no order reference) ->
         the one entry order with that id.
      2. Else the entry orders (role 'entry') on the trade's side (buy for long, sell for short) that were working at the
         fill (t_from <= entry_t <= t_to) and ended filled (status 'filled'). Exactly one: that one.
      3. Several: those that ended at the fill (t_to == entry_t) with their price or limit equal to the fill price to the
         tick; of those, the one with the latest t_from if no other has it. Anything else is refused as ambiguous.
    The cut is that order's t_from, and it must be before the fill (an order filled the moment it was placed leaves no
    moment to grade at): refused too."""
    orders = (result or {}).get('orders') or []
    ref = trade.get('entry_order')
    if ref not in (None, ''):
        hit = [o for o in orders if str(o.get('id')) == str(ref) and o.get('role') == 'entry']
        if len(hit) != 1:
            raise ValueError(f'the trade names entry order {ref}, but the result has {len(hit)} entry orders with that id')
        o, how = hit[0], 'the trade names its entry order'
    else:
        side = {'long': 'buy', 'short': 'sell'}.get(trade.get('dir'))
        et = int(trade['entry_t'])
        live = [o for o in orders if o.get('role') == 'entry' and o.get('side') == side and o['t_from'] <= et <= o['t_to']
                and o.get('status') == 'filled']
        if not live:
            raise ValueError('no filled entry order on the trade\'s side was working at its fill')
        if len(live) == 1:
            o, how = live[0], 'the one filled entry order on its side working at the fill'
        else:
            px = [x for x in live if x['t_to'] == et and (_same_px(x.get('price'), trade.get('entry'), tick)
                                                         or _same_px(x.get('limit'), trade.get('entry'), tick))]
            late = max((x['t_from'] for x in px), default=None)
            px = [x for x in px if x['t_from'] == late]
            if len(px) != 1:
                raise ValueError(f'{len(live)} filled entry orders on the trade\'s side were working at its fill and the '
                                 'price and time do not single one out')
            o, how = px[0], 'of several working at the fill, the one ending at it at the fill price, placed last'
    if not int(o['t_from']) < int(trade['entry_t']):
        raise ValueError('the entry order filled the moment it was placed: there is no moment before the fill to grade at')
    return o, how


def trade_at_cut(result, trade, order) -> dict:
    """What the bot showed of this trade at its cut (the entry order's t_from): the side and level, the entry order, and the
    stop and target orders it had working then that were placed with or after the entry order (an earlier open trade's
    are not this one's). No fill, no exit, no status."""
    c = int(order['t_from'])
    near = [o for o in (result or {}).get('orders') or [] if o['t_from'] >= c and o['t_from'] <= c < o['t_to'] and o.get('role') in ('stop', 'target')]
    stops = [o['price'] for o in near if o['role'] == 'stop']
    targets = [o['price'] for o in near if o['role'] == 'target']
    return {'dir': trade.get('dir'), 'level_type': trade.get('level_type'), 'level_price': trade.get('level_price'),
            'cut_wall_ms': c, 'cut_tod': fmt_tod(c),
            'entry_order': {k: order.get(k) for k in ('id', 'side', 'type', 'price', 'limit')},
            'stop': stops[0] if len(stops) == 1 else None, 'target': targets[0] if len(targets) == 1 else None,
            'stops_shown': stops, 'targets_shown': targets}


def read_trade_notes(path):
    """--trade-notes: a CSV with trade_id, variant, note and optionally score (a number from -1 to 1). Returns ({(variant,
    trade_id): {'note', 'score'}}, sha256 of the file, warnings). A trade named twice gets no note (warned); a score that is
    not a number from -1 to 1 is dropped (warned). The Studio shows a note only in a trade's reveal."""
    with open(path, 'rb') as f:
        raw = f.read()
    rd = csv.DictReader(io.StringIO(raw.decode('utf-8-sig')))
    missing = [c for c in ('trade_id', 'variant', 'note') if c not in (rd.fieldnames or [])]
    if missing:
        raise ValueError('no column ' + ', '.join(missing))
    out, twice, warn = {}, set(), []
    for r in rd:
        key = (str(r.get('variant') or '').strip(), str(r.get('trade_id') or '').strip())
        if key in out or key in twice:
            twice.add(key)
            out.pop(key, None)
            continue
        score = None
        if str(r.get('score') or '').strip():
            try:
                score = float(r['score'])
                if not (-1.0 <= score <= 1.0):
                    raise ValueError
            except ValueError:
                warn.append(f'score {r["score"]!r} of trade {key[1]} ({key[0]}) is not a number from -1 to 1: dropped')
                score = None
        out[key] = {'note': str(r.get('note') or ''), 'score': score}
    for v, t in sorted(twice):
        warn.append(f'trade {t} ({v}) is in the notes twice: it gets no note')
    return out, hashlib.sha256(raw).hexdigest(), warn


def write_once(dest, obj) -> bool:
    """Write a JSON file whole, only if dest does not exist yet (a temp file, then _claim). False when it exists."""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = f'{dest}.{os.getpid()}.{threading.get_ident()}.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(json.dumps(obj, indent=1, sort_keys=True))
        f.flush()
        os.fsync(f.fileno())
    try:
        return _claim(tmp, dest)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def list_trade_grades(folder) -> dict:
    """qid -> the grade: <qid>.json (stage 1) with, for an ADJUST whose stage 2 is saved, 'adjust' from <qid>.adjust.json,
    and for a PASS, 'mine' from <qid>.mine.json (his own trade instead, kind 'instead', or kind 'none' when he went on
    without one). Each file is written once: a saved stage is never rewritten."""
    out = {}
    try:
        names = sorted(os.listdir(folder))
    except OSError:
        return out
    for n in names:
        if not n.endswith('.json') or n.endswith('.adjust.json') or n.endswith('.mine.json'):
            continue
        try:
            with open(os.path.join(folder, n), encoding='utf-8') as f:
                g = json.load(f)
        except (OSError, ValueError):
            continue
        g['adjust'] = None
        try:
            with open(os.path.join(folder, n[:-5] + '.adjust.json'), encoding='utf-8') as f:
                g['adjust'] = json.load(f).get('adjust')
        except (OSError, ValueError):
            pass
        g['mine'] = None
        try:
            with open(os.path.join(folder, n[:-5] + '.mine.json'), encoding='utf-8') as f:
                g['mine'] = json.load(f).get('mine')
        except (OSError, ValueError):
            pass
        out[g.get('qid')] = g
    return out


def trade_grade_done(g) -> bool:
    """A grade is complete once stage 1 is saved and, for an ADJUST, stage 2 too; for a PASS that offered "my trade
    instead" (mine_offer, every PASS saved since it exists), once that is saved or declined."""
    if not g:
        return False
    if g.get('label') == 'ADJUST':
        return bool(g.get('adjust'))
    if g.get('label') == 'PASS' and g.get('mine_offer'):
        return bool(g.get('mine'))
    return True


def own_trade(g):
    """His own trade of a complete grade, simulated in the reveal: ('adjust', the stage 2 record) for an ADJUST, ('instead',
    the mine record) for a PASS with his trade instead, else (None, None)."""
    if not trade_grade_done(g):
        return None, None
    if g.get('label') == 'ADJUST' and g.get('adjust'):
        return 'adjust', g['adjust']
    m = g.get('mine') or {}
    if g.get('label') == 'PASS' and m.get('kind') == 'instead':
        return 'instead', m
    return None, None


def mark_dir(entry, stop):
    """The direction his marks say: the stop below the entry is long, above it short; None when they are equal."""
    if entry is None or stop is None or float(stop) == float(entry):
        return None
    return 'long' if float(stop) < float(entry) else 'short'


YOURS_ENTRY_TYPES = {t: t for t in ENTRY_TYPES}      # the Trades tab's stored entry type -> simulate()'s spec (the same names)


def yours_spec(rec):
    """simulate()'s spec from his stage 2 record (ADJUST or instead): the direction from the marks, the entry type, the
    prices, and t = the replay clock when he saved it, as wall ms. ({spec}, None), or (None, a plain message) when it cannot
    be simulated."""
    d = mark_dir(rec.get('entry'), rec.get('stop'))
    if d is None:
        return None, 'cannot simulate (the stop is at the entry)'
    tg = rec.get('target')
    if tg is not None and (float(tg) <= float(rec['entry']) if d == 'long' else float(tg) >= float(rec['entry'])):
        return None, 'cannot simulate (target on the losing side)'
    et = YOURS_ENTRY_TYPES.get(rec.get('entry_type'))
    if et is None:
        return None, f'cannot simulate (entry type {rec.get("entry_type")!r})'
    return {'dir': d, 'entry_type': et, 'entry': float(rec['entry']), 'stop': float(rec['stop']),
            'target': None if tg is None else float(tg), 't': utc_to_wall(int(rec['clock_utc_ms']))}, None


def yours_view(sim, clock_wall) -> dict:
    """NO-FUTURE for his simulated trade, cut by bot_view exactly as the bot's: his orders from t_from <= clock (t_to
    clipped, status once ended), his fill once entry_t <= clock and his exit once exit_t <= clock."""
    if not isinstance(sim, dict) or sim.get('error'):
        return {'orders': [], 'trade': None}
    tr = []
    if sim.get('filled') and sim.get('entry_t') is not None:
        x = {'id': 'yours', 'dir': (sim.get('spec') or {}).get('dir'), 'entry_t': int(sim['entry_t']), 'entry': sim.get('entry'),
             'stop': (sim.get('spec') or {}).get('stop'), 'target': sim.get('target'), 'exits': {}}
        if sim.get('exit_t') is not None:
            x['exits']['yours'] = {k: sim.get(k) for k in ('exit_t', 'exit', 'points', 'r')}
            x['exits']['yours']['reason'] = sim.get('reason')
        tr.append(x)
    v = bot_view({'orders': sim.get('orders') or [], 'trades': tr}, clock_wall)
    return {'orders': v['orders'], 'trade': v['trades'][0] if v['trades'] else None}


LEG_ROLES = ('stop', 'target', 'flat')


def _names(oid, tid):
    """An order id that carries the trade id (the id itself, or the id then a separator), so it is that trade's order."""
    return oid == tid or (oid.startswith(tid) and not oid[len(tid)].isalnum())


def _trade_legs(orders, trade, order):
    """Of `orders` (any list of order records), the stop, target and flat orders of this trade: on its exit side, and when
    any of them names the trade (its book or id is the trade id, or the id then a separator) those only; else those placed
    from the entry order's t_from to the trade's last exit (one position at a time)."""
    tid = str(trade.get('id'))
    out_side = {'long': 'sell', 'short': 'buy'}.get(trade.get('dir'))
    ends = [int(x['exit_t']) for x in (trade.get('exits') or {}).values()]
    last = max(ends) if ends else None
    legs = [o for o in orders or [] if o.get('role') in LEG_ROLES and o.get('side') == out_side]
    named = lambda o: _names(str(o.get('book') or ''), tid) or _names(str(o.get('id')), tid)
    if any(named(o) for o in legs):
        return [o for o in legs if named(o)]
    return [o for o in legs if int(order['t_from']) <= int(o['t_from']) and (last is None or int(o['t_from']) <= last)]


def trade_only(view, result, trade, order) -> dict:
    """The Trades tab draws ONE trade: of a view already cut by bot_view, only this trade's entry order (by id and t_from),
    its stop, target and flat legs (_trade_legs, decided on the whole result so the rule never changes with the clock),
    the trade itself and no events (events are not tied to a trade exactly, so none)."""
    tid, et = str(trade.get('id')), int(trade['entry_t'])
    mine = {(str(o.get('id')), int(o['t_from'])) for o in _trade_legs((result or {}).get('orders'), trade, order)}
    mine.add((str(order.get('id')), int(order['t_from'])))
    out = dict(view)
    out['orders'] = [o for o in view.get('orders') or [] if (str(o.get('id')), int(o['t_from'])) in mine
                     and (o.get('role') != 'entry' or str(o.get('id')) == str(order.get('id')))]
    out['trades'] = [t for t in view.get('trades') or [] if str(t.get('id')) == tid and int(t['entry_t']) == et]
    out['events'] = []
    return out


PRIMARY_TARGET = 'bot primary target'


def exit_legs(result, trade, order, exit_ids, clock_wall):
    """The legs of the exits a graded trade lists (--trade-exits), from the result's optional 'exit_orders' ({exit id: order
    records with role stop, target or flat}): this trade's (_trade_legs) of each named exit, cut at the clock exactly as
    bot_view cuts 'orders', each labelled '<exit id> <role>'. None when the result has no exit_orders for those exits."""
    eo = (result or {}).get('exit_orders') or {}
    if not isinstance(eo, dict) or not any(eo.get(x) for x in exit_ids):
        return None
    out = []
    for x in exit_ids:
        legs = [o for o in _trade_legs(eo.get(x) or [], trade, order) if o.get('price') is not None]
        for o in bot_view({'orders': legs}, clock_wall)['orders']:
            o['exit_id'], o['label'] = x, f'{x} {o.get("role")}'
            out.append(o)
    return out


def export_trade_grades(marks_dir, grades) -> tuple[str, int]:
    """trade_grades.csv: one flat row per grade. Labels, the bot's trade at the cut, the adjust fields and his trade instead
    of a PASS (instead_*); NO outcome."""
    rows = []
    for g in sorted(grades.values(), key=lambda x: x.get('saved_utc') or ''):
        cut = g.get('at_cut') or {}
        eo = cut.get('entry_order') or {}
        r = {k: g.get(k) for k in ('qid', 'trade_id', 'date', 'symbol', 'bot', 'variant', 'label', 'reason', 'confidence', 'saved_utc')}
        r['chips'] = ';'.join(g.get('chips') or [])
        r.update({'cut_tod': cut.get('cut_tod'), 'dir': cut.get('dir'), 'level_type': cut.get('level_type'), 'level_price': cut.get('level_price'),
                  'bot_entry_order_type': eo.get('type'), 'bot_entry_order_price': eo.get('price'), 'bot_entry_order_limit': eo.get('limit'),
                  'bot_stop': cut.get('stop'), 'bot_target': cut.get('target')})
        a = g.get('adjust') or {}
        r.update({'adjust_entry_type': a.get('entry_type'), 'adjust_entry': a.get('entry'), 'adjust_stop': a.get('stop'),
                  'adjust_target': a.get('target'), 'steps_after_cut': a.get('steps_after_cut'), 'adjust_saved_utc': a.get('saved_utc')})
        r.update({'adjust_dir': a.get('dir'), 'adjust_opposite_side': a.get('opposite_side')})
        for m in a.get('marks') or []:
            key = safe_name(m.get('role', '')).lower()
            r[f'adjust_{key}_bar_utc_ms'], r[f'adjust_{key}_bar_tod'] = m.get('bar_time_utc_ms'), m.get('bar_tod')
        mi = g.get('mine') or {}
        r.update({'instead_kind': mi.get('kind'), 'instead_dir': mi.get('dir'), 'instead_entry_type': mi.get('entry_type'),
                  'instead_entry': mi.get('entry'), 'instead_stop': mi.get('stop'), 'instead_target': mi.get('target'),
                  'instead_steps_after_cut': mi.get('steps_after_cut'), 'instead_opposite_side': mi.get('opposite_side'),
                  'instead_after_reveal': mi.get('after_reveal'), 'instead_saved_utc': mi.get('saved_utc')})
        for m in mi.get('marks') or []:
            key = safe_name(m.get('role', '')).lower()
            r[f'instead_{key}_bar_utc_ms'], r[f'instead_{key}_bar_tod'] = m.get('bar_time_utc_ms'), m.get('bar_tod')
        rows.append(r)
    cols = []
    for r in rows:
        for k in r:
            if k not in cols:
                cols.append(k)
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=cols or ['qid'])
    w.writeheader()
    w.writerows(rows)
    dest = os.path.join(marks_dir, 'trade_grades.csv')
    write_text(dest, buf.getvalue())
    return dest, len(rows)
