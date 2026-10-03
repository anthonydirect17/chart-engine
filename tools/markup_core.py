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
import io
import json
import os
import random
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
import numpy as np

try:                                   # Windows Python has no time zone database unless the tzdata package is installed
    from zoneinfo import ZoneInfo
    NY = ZoneInfo('America/New_York')
except Exception:                      # noqa: BLE001 - the US rules below are used instead
    NY = None
HOLDOUT = date(2026, 4, 1)           # this date and later is the holdout: never listed, loaded, scanned or graded
TICK = 0.25                           # NQ
SYMBOL = 'NQ'
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
    no prior kept day), ONH/ONL from 18:00 the evening before to 09:29:59."""
    out = []
    if prev_hilo:
        out += [('PDH', float(prev_hilo[0])), ('PDL', float(prev_hilo[1]))]
    s = tod_s(day.wall)
    m = (s >= SESSION_START) | (s < RTH_OPEN)
    if m.any():
        out += [('ONH', float(day.px[m].max())), ('ONL', float(day.px[m].min()))]
    return out


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
            out.append({'id': cid, 'date': day.date, 'dir': 'short' if up else 'long', 'level_type': ltype,
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


def read_seen(paths):
    """Best effort: [(date, level_type, reclaim_ms)] from the blind-chart KEY.csv and event-study print CSVs."""
    seen = []
    for p in paths:
        try:
            with open(p, newline='', encoding='utf-8-sig') as f:
                rows = list(csv.DictReader(f))
        except OSError:
            continue
        if not rows:
            continue
        names = list(rows[0].keys())
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


def machine_read(day: Day, clock_utc: int, level: float, cross_utc: int | None = None, tick=TICK):
    """Bot-mechanics numbers for one level at the clock. `day` must already be cut at the clock (the server does it);
    the function also refuses any tick after clock_utc on its own. No outcome is computed."""
    n = int(np.searchsorted(day.utc, clock_utc, 'right'))
    day = day.upto(n)
    clock_wall = utc_to_wall(clock_utc)
    if cross_utc is None:
        i = last_cross(day, level, tick)
    else:
        i = int(np.searchsorted(day.utc, cross_utc, 'left'))
        if i >= n:
            i = None
    if i is None or i <= 0:
        return {'ok': False, 'why': 'no cross of this level at or before the clock'}
    tc = int(day.utc[i])
    up = bool(day.px[i] > level)
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
    # the probe: from the cross to the first tick back on the original side by a tick, or to the clock
    w = day.px[i:]
    back = w <= level - RECLAIM_TICKS * tick + 1e-9 if up else w >= level + RECLAIM_TICKS * tick - 1e-9
    r = i + int(np.argmax(back)) if back.any() else None
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


def save_grade(marks_dir, item: dict) -> str:
    """One JSON per graded item: written to a temp file, then moved onto a name reserved with O_EXCL, so an existing
    file is never overwritten (a second grade of an id gets _2, _3, ...). Also appends to marks_log.jsonl."""
    os.makedirs(marks_dir, exist_ok=True)
    base = 'grade_' + safe_name(item['id'])
    data = json.dumps(item, indent=2, sort_keys=True)
    for k in range(1, 10000):
        dest = os.path.join(marks_dir, base + ('' if k == 1 else f'_{k}') + '.json')
        try:
            fd = os.open(dest, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            continue
        os.close(fd)
        tmp = dest + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, dest)
        with open(os.path.join(marks_dir, 'marks_log.jsonl'), 'a', encoding='utf-8') as f:
            f.write(json.dumps(item, sort_keys=True) + '\n')
        return dest
    raise OSError('no free file name for ' + base)


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


def export_csv(marks_dir) -> tuple[str, int]:
    """marks_export.csv: one flat row per grade."""
    rows = []
    for g in list_grades(marks_dir):
        r = {k: g.get(k) for k in ('id', 'mode', 'date', 'clock_tod', 'clock_utc_ms', 'level_type', 'level_price',
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
    tmp = dest + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='') as f:
        f.write(buf.getvalue())
    os.replace(tmp, dest)
    return dest, len(rows)


DEFAULT_CHIPS = ['weak volume into level', 'strong volume into level', 'volume drying up', 'fast move into level',
                 'slow grind into level', 'too deep', 'shallow probe', 'clean reclaim close', 'wick reclaim',
                 'no confirmation yet', 'confirmation candle', 'near another level', 'trend day', 'chop', 'time of day']
