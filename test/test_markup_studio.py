"""Markup Studio unit tests (Python stdlib unittest + numpy). Made-up sample data only.

    python3 -m unittest discover -s test -p "test_markup*.py"
"""
import csv
import json
import os
import sys
import tempfile
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'tools'))
sys.path.insert(0, HERE)
import markup_core as core  # noqa: E402
import markup_studio as ms  # noqa: E402
import markup_fixture  # noqa: E402

D = '2026-03-10'
W = lambda hh, mm=0, ss=0.0: core.wall_of(D, hh, mm, 0) + int(round(ss * 1000))


def tape(rows, quotes=True):
    """rows: (wall ms, price, volume, side) with side 'b' (at the ask), 's' (at the bid) or '' (between)."""
    wall = np.array([r[0] for r in rows], dtype=np.int64)
    px = np.array([r[1] for r in rows], dtype=float)
    vol = np.array([r[2] for r in rows], dtype=np.int64)
    if not quotes:
        return core.Day(D, wall, px, vol)
    side = [r[3] for r in rows]
    bid = np.array([p - 0.25 if s == 'b' else p if s == 's' else p - 0.25 for p, s in zip(px, side)])
    ask = np.array([p if s == 'b' else p + 0.25 if s == 's' else p + 0.25 for p, s in zip(px, side)])
    return core.Day(D, wall, px, vol, bid, ask)


class TimeConversion(unittest.TestCase):
    def test_summer_and_winter_0930(self):
        summer = core.wall_of('2026-07-15', 9, 30)
        winter = core.wall_of('2026-01-15', 9, 30)
        u = core.wall_to_utc([summer, winter])
        self.assertEqual(u[0] - summer, 4 * 3600 * 1000)          # EDT: 13:30 UTC
        self.assertEqual(u[1] - winter, 5 * 3600 * 1000)          # EST: 14:30 UTC
        self.assertEqual(core.utc_to_wall(int(u[0])), summer)
        self.assertEqual(core.utc_to_wall(int(u[1])), winter)

    def test_across_the_march_change(self):
        # the session of 2026-03-09 opens 18:00 on Sunday 03-08, after the 02:00 change: EDT all session
        u = core.wall_to_utc([core.wall_of('2026-03-08', 18), core.wall_of('2026-03-07', 12)])
        self.assertEqual(u[0] - core.wall_of('2026-03-08', 18), 4 * 3600 * 1000)
        self.assertEqual(u[1] - core.wall_of('2026-03-07', 12), 5 * 3600 * 1000)


    def test_rules_match_the_time_zone_database(self):
        """Without tzdata (a bare Windows Python) the US rules give the same answers as zoneinfo."""
        if core.NY is None:
            self.skipTest('no time zone database here')
        saved = core.NY
        hours = [h for y in range(2008, 2027) for h in range(int(core.wall_of(f'{y}-03-01', 0) // 3600000), int(core.wall_of(f'{y}-03-20', 0) // 3600000))]
        hours += [h for y in range(2008, 2027) for h in range(int(core.wall_of(f'{y}-10-25', 0) // 3600000), int(core.wall_of(f'{y}-11-12', 0) // 3600000))]
        want = [core._offset_ms(h) for h in hours]
        utcs = [core.wall_of('2026-03-08', 6) + k * 900000 for k in range(16)] + [core.wall_of('2026-11-01', 5) + k * 900000 for k in range(16)]
        want_w = [core.utc_to_wall(u) for u in utcs]
        try:
            core.NY = None
            got = [core._offset_ms(h) for h in hours]
            got_w = [core.utc_to_wall(u) for u in utcs]
        finally:
            core.NY = saved
        skip = {h for h in hours if (datetime_of(h).hour in (1, 2)) and datetime_of(h).weekday() == 6}   # the changeover hours (no trading)
        self.assertEqual([g for h, g in zip(hours, got) if h not in skip], [w for h, w in zip(hours, want) if h not in skip])
        self.assertEqual(got_w, want_w)


def datetime_of(hour_index):
    from datetime import datetime, timedelta
    return datetime(1970, 1, 1) + timedelta(hours=hour_index)


FAKE_LOADER = '''"""A stand-in for tickreplay's loader.py (1f9e04b) with the same names and shapes (TICKREPLAY_API.md), made for the
Markup Studio tests. It reads made-up sample days packed as <data_root>/<SYMBOL>/<SYMBOL>_<MMYY>_<YYYY-MM-DD>.npz."""
import glob
import os
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

import numpy as np

PACKED = Path(r"E:\\\\SchwabDesk_bulk\\\\ticks_packed")
TICK = 0.25
CALLS = []


@dataclass
class Ticks:
    ts_ms: np.ndarray
    last: np.ndarray
    bid: np.ndarray
    ask: np.ndarray
    vol: np.ndarray
    symbol: str
    contract: str
    file_date: object
    has_quotes: bool
    add_ms: int = 0


@dataclass
class Session:
    ticks: Ticks
    session_date: date
    early_close: bool
    gap_before: bool
    corrected_clock: bool
    n_dropped_window: int
    n_dropped_badprint: int
    n_edge_dups: int
    edge_gap_ms: object
    volume: int
    alt_contract: str
    alt_volume: int
    also_contract: str = ""
    badprint_volume: int = 0
    badprints: tuple = ()


def load_session(symbol, session_date, data_root=None):
    d = session_date if isinstance(session_date, date) else datetime.strptime(str(session_date), "%Y-%m-%d").date()
    if d.weekday() >= 5:
        raise ValueError("no session on a Saturday or Sunday")
    CALLS.append((symbol, d.isoformat(), str(data_root)))
    files = glob.glob(os.path.join(str(data_root or PACKED), symbol, f"{symbol}_*_{d.isoformat()}.npz"))
    if not files:
        e = np.zeros(0)
        return Session(Ticks(e.astype(np.int64), e, e, e, e.astype(np.int64), symbol, "", None, False), d, False, False, False, 0, 0, 0, None, 0, "", 0)
    z = np.load(files[0])
    q = bool(np.isfinite(z["bid"]).any())
    t = Ticks(z["ts_ms"].astype(np.int64), z["last"], z["bid"], z["ask"], z["vol"], symbol, os.path.basename(files[0]).split("_")[1], d, q)
    return Session(t, d, False, False, False, 0, 0, 0, None, int(z["vol"].sum()), "", 0)
'''

INDEX_COLS = ['symbol', 'session_date', 'contract', 'has_quotes', 'last_only', 'mixed_quotes', 'early_close', 'holiday_close',
              'missing_day', 'truncated', 'gap_before', 'corrected_clock', 'n_dropped_window', 'n_dropped_badprint', 'badprint_volume',
              'n_ticks', 'first_ts', 'last_ts', 'volume', 'n_edge_dups', 'edge_gap_ms', 'alt_contract', 'alt_volume', 'also_contract']


def fake_tickreplay(root, data_dir):
    """A tickreplay folder (loader.py, sessions_index.csv) and a packed data_root made from the npz fixture days."""
    tr, packed = os.path.join(root, 'tickreplay'), os.path.join(root, 'ticks_packed')
    os.makedirs(tr)
    os.makedirs(os.path.join(packed, 'NQ'))
    with open(os.path.join(tr, 'loader.py'), 'w') as f:
        f.write(FAKE_LOADER)
    rows = []
    for n in sorted(os.listdir(data_dir)):
        if not n.endswith('.npz'):
            continue
        d = n[3:13]
        z = np.load(os.path.join(data_dir, n))
        q = 'bid' in z.files
        nan = np.full(z['price'].size, np.nan)
        np.savez(os.path.join(packed, 'NQ', f'NQ_0326_{d}.npz'), ts_ms=z['wall_ms'], last=z['price'],
                 bid=z['bid'] if q else nan, ask=z['ask'] if q else nan, vol=z['volume'] if q else np.ones(z['price'].size, dtype=np.int64))
        rows.append(dict.fromkeys(INDEX_COLS, 'no') | {'symbol': 'NQ', 'session_date': d, 'contract': 'NQ 03-26', 'has_quotes': 'yes' if q else 'no',
                                                       'last_only': 'no' if q else 'yes', 'n_ticks': str(z['price'].size)})
    # rows the in-sample filter must drop: another symbol, a holiday close, a missing day, a truncated day, the holdout
    for d, k in [('2026-03-02', 'holiday_close'), ('2026-03-03', 'missing_day'), ('2026-03-04', 'truncated')]:
        rows.append(dict.fromkeys(INDEX_COLS, 'no') | {'symbol': 'NQ', 'session_date': d, k: 'yes'})
    rows.append(dict.fromkeys(INDEX_COLS, 'no') | {'symbol': 'ES', 'session_date': '2026-03-05'})
    with open(os.path.join(tr, 'sessions_index.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=INDEX_COLS)
        w.writeheader()
        w.writerows(rows)
    return tr, packed


class LoaderAdapter(unittest.TestCase):
    """TickReplaySource against a stand-in with tickreplay's exact API (loader.py, Session, Ticks, sessions_index.csv)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        data = os.path.join(self.tmp.name, 'npz')
        markup_fixture.write(data)
        self.tr, self.packed = fake_tickreplay(self.tmp.name, data)
        self.src = ms.TickReplaySource(self.tr, self.packed, 'NQ')

    def tearDown(self):
        sys.path[:] = [p for p in sys.path if p != os.path.abspath(self.tr)]
        sys.modules.pop('loader', None)
        self.tmp.cleanup()

    def test_days_from_the_index_in_sample(self):
        self.assertEqual(self.src.days(), ['2026-03-09', '2026-03-10'])

    def test_load_session(self):
        day = self.src.load('2026-03-10')
        self.assertEqual(self.src.mod.CALLS, [('NQ', '2026-03-10', self.packed)])
        self.assertTrue(day.has_quotes)
        self.assertEqual(day.utc[0] - day.wall[0], 4 * 3600 * 1000)          # EDT after 2026-03-08
        self.assertEqual(core.fmt_tod(day.wall[0]), '18:00:00')
        self.assertTrue(set(day.sm.tolist()) <= {0, 2, 3})
        last_only = self.src.load('2026-03-09')
        self.assertFalse(last_only.has_quotes)
        self.assertIsNone(last_only.bid)
        self.assertEqual(set(last_only.sm.tolist()) - {0}, {3})

    def test_holdout_refused_before_the_loader_runs(self):
        with self.assertRaises(core.HoldoutError):
            self.src.load('2026-04-02')
        self.assertEqual(self.src.mod.CALLS, [])

    def test_clear_errors(self):
        with self.assertRaises(ms.TickReplayError):
            self.src.load('2026-03-11')                                      # no file: the loader's empty Session
        with self.assertRaises(ValueError):
            self.src.load('2026-03-08')                                      # a Sunday: the loader's ValueError
        with self.assertRaises(ms.TickReplayError):
            ms.TickReplaySource(self.tmp.name, self.packed, 'NQ')            # no loader.py there

    def test_studio_scan_through_the_loader(self):
        st = ms.Studio(self.src, os.path.join(self.tmp.name, 'marks'), os.path.join(HERE, '..', 'tools', 'markup_rule_v0.json'), [], 'NQ')
        st.start_scan(background=False)
        self.assertEqual([c['id'] for c in st.candidates], ['C20260310PDH100510'])

    def test_check_command(self):
        lines = []
        self.assertEqual(ms.check(self.src, 'NQ', out=lines.append), 0)
        text = '\\n'.join(lines)
        self.assertIn('days found (in sample, before 2026-04-01): 2, 2026-03-09 to 2026-03-10', text)
        self.assertIn('chosen day: 2026-03-10', text)
        self.assertIn('first tick: 2026-03-09 18:00:00.000 New York = 2026-03-09 22:00:00.000 UTC', text)
        self.assertIn('quotes: bid and ask', text)
        self.assertIn('first candidate: C20260310PDH100510 PDH 20060.0 short', text)
        with self.assertRaises(core.HoldoutError):
            ms.check(self.src, 'NQ', '2026-04-02', out=lines.append)


class Candidates(unittest.TestCase):
    """Hand-built: PDH 100, PDL 90; ON high 85, low 80."""

    def day(self):
        return tape(self.day_rows(), quotes=False)

    def day_rows(self):
        """The hand-built trades, with a trade at the last price every minute in RTH where there is none in the minute
        before (no new crosses), so the tape has no gap of over 5 minutes."""
        rows = self.trades()
        out = []
        for r in rows:
            while out and out[-1][0] >= W(9, 30) and r[0] - out[-1][0] > 60000:
                out.append((out[-1][0] + 60000, out[-1][1], 1, ''))
            out.append(r)
        return out

    def trades(self):
        return [(W(9, 0), 80.0, 1, ''), (W(9, 10), 85.0, 1, ''),
                (W(9, 30), 95.0, 1, ''),
                # in the first 60 s of RTH: through and back, but too early
                (W(9, 30, 30), 100.25, 1, ''), (W(9, 30, 40), 101.25, 1, ''), (W(9, 30, 50), 99.5, 1, ''),
                # only 3 ticks through
                (W(9, 40), 100.25, 1, ''), (W(9, 40, 30), 100.75, 1, ''), (W(9, 40, 40), 99.75, 1, ''),
                # 4 through, but back 130 s after the cross (outside 120 s)
                (W(9, 50), 100.25, 1, ''), (W(9, 50, 30), 101.0, 1, ''), (W(9, 52, 10), 99.75, 1, ''),
                # a sweep: cross 10:00:00, 4 through at 10:00:20, back at 10:00:40 -> short, cut 10:01:00
                (W(10, 0), 100.5, 1, ''), (W(10, 0, 20), 101.0, 1, ''), (W(10, 0, 40), 99.75, 1, ''),
                # the same again 10 minutes later: inside the 30-minute refractory
                (W(10, 10), 100.25, 1, ''), (W(10, 10, 10), 101.5, 1, ''), (W(10, 10, 20), 99.5, 1, ''),
                # after the refractory: back at 10:40:59.999 -> cut 10:41:00
                (W(10, 40), 100.25, 1, ''), (W(10, 40, 10), 101.0, 1, ''), (W(10, 40, 59.999), 99.75, 1, ''),
                (W(10, 50), 95.0, 1, ''),
                # a PDL sweep down and back -> long
                (W(11, 0), 89.75, 1, ''), (W(11, 0, 5), 89.0, 1, ''), (W(11, 0, 10), 90.25, 1, ''),
                (W(12, 0), 95.0, 1, '')]

    def test_hand_worked_answers(self):
        cs = core.find_candidates(self.day(), (100.0, 90.0))
        got = [(c['level_type'], c['dir'], core.fmt_tod(core.utc_to_wall(c['cross_utc_ms'])), core.fmt_tod(core.utc_to_wall(c['cut_utc_ms'])))
               for c in cs]
        self.assertEqual(got, [('PDH', 'short', '10:00:00', '10:01:00'), ('PDH', 'short', '10:40:00', '10:41:00'),
                               ('PDL', 'long', '11:00:00', '11:01:00')])
        self.assertEqual(core.day_levels(self.day(), (100.0, 90.0)), [('PDH', 100.0), ('PDL', 90.0), ('ONH', 85.0), ('ONL', 80.0)])
        for c in cs:
            self.assertFalse({'outcome', 'pnl', 'mfe', 'mae'} & set(c))

    def test_causal(self):
        """A candidate found on the whole day is found the same on the day cut at its own cut (no later tick used)."""
        day = self.day()
        for c in core.find_candidates(day, (100.0, 90.0)):
            part = day.upto(ms.visible_count(day, c['cut_utc_ms']))
            self.assertIn(c, core.find_candidates(part, (100.0, 90.0)))

    def test_no_candidates_after_a_halt(self):
        """A gap of more than 5 minutes inside RTH (a halt): nothing from there on."""
        rows = [r for r in self.day_rows() if r[0] < W(10, 30) or r[0] >= W(10, 37)]
        cs = core.find_candidates(tape(rows, quotes=False), (100.0, 90.0))
        self.assertEqual([core.fmt_tod(core.utc_to_wall(c['cross_utc_ms'])) for c in cs], ['10:00:00'])
        rows = [r for r in self.day_rows() if r[0] < W(10, 30) or r[0] >= W(10, 34)]          # 4 minutes: no halt
        self.assertEqual(len(core.find_candidates(tape(rows, quotes=False), (100.0, 90.0))), 3)

    def test_no_morning(self):
        self.assertTrue(core.has_morning(self.day()))
        self.assertFalse(core.has_morning(tape([r for r in self.day_rows() if r[0] < W(9, 30) or r[0] >= W(12, 0, 1)], quotes=False)))

    def test_no_prior_day_no_pd_levels(self):
        self.assertEqual([c['level_type'] for c in core.find_candidates(self.day(), None)], [])

    def test_seeded_shuffle(self):
        items = [{'id': str(i), 'date': D, 'cross_utc_ms': i, 'level_type': 'PDH'} for i in range(20)]
        a, b = core.shuffled(items, 4), core.shuffled(list(reversed(items)), 4)
        self.assertEqual([x['id'] for x in a], [x['id'] for x in b])
        self.assertNotEqual([x['id'] for x in a], [x['id'] for x in items])

    def test_already_seen(self):
        c = {'date': D, 'level_type': 'PDH', 'reclaim_wall_ms': W(10, 0, 40), 'reclaim_utc_ms': W(10, 0, 40) + 4 * 3600000}
        with tempfile.TemporaryDirectory() as t:
            p = os.path.join(t, 'KEY.csv')
            with open(p, 'w', newline='') as f:
                w = csv.writer(f)
                w.writerow(['chart', 'date', 'level_type', 'reclaim_time'])
                w.writerow(['S01', D, 'PDH', '10:02:30'])          # 110 s away: seen
                w.writerow(['S02', D, 'PDL', '10:00:40'])          # other level
            seen = core.read_seen([p, os.path.join(t, 'missing.csv')])
            self.assertTrue(core.is_seen(c, seen))
            self.assertFalse(core.is_seen(dict(c, reclaim_wall_ms=W(10, 6), reclaim_utc_ms=0), seen))


class MachineRead(unittest.TestCase):
    """Level 100, approached from below; cross 10:05:00."""

    def day(self, confirm_px=99.25):
        rows = [(W(9, 0), 97.0, 1, 's'), (W(9, 45), 100.0, 1, 'b'), (W(9, 46), 99.0, 1, 's'),
                (W(10, 0), 98.0, 10, 'b'), (W(10, 1), 98.5, 8, 'b'), (W(10, 2), 99.0, 6, 'b'), (W(10, 3), 99.5, 4, 'b'), (W(10, 4), 99.75, 2, 'b'),
                (W(10, 5), 100.25, 3, 'b'), (W(10, 5, 10), 101.0, 1, 'b'), (W(10, 5, 20), 99.75, 5, 's'), (W(10, 5, 50), 99.5, 1, 's'),
                (W(10, 6, 30), confirm_px, 1, 's'), (W(10, 30), 120.0, 999, 'b')]
        return tape(rows)

    def at(self, day, hh, mm, ss=0):
        clock = int(core.wall_to_utc([W(hh, mm, ss)])[0])
        return core.machine_read(day.upto(ms.visible_count(day, clock)), clock, 100.0)

    def test_hand_worked_values(self):
        r = self.at(self.day(), 10, 6, 10)
        self.assertTrue(r['ok'])
        self.assertEqual(r['cross_tod'], '10:05:00')
        self.assertEqual(r['into_level_windows'], [10, 8, 6, 4, 2])
        self.assertEqual(r['into_level_slope_per_min'], -2.0)
        self.assertEqual(r['pre2_into_rate_per_min'], 3.0)
        self.assertEqual(r['probe_into_rate_per_min'], 12.0)
        self.assertEqual(r['probe_vs_pre2'], 4.0)
        self.assertEqual(r['depth_points'], 1.0)
        self.assertEqual(r['probe_seconds'], 20.0)
        self.assertEqual(r['approach_2m_points'], 0.25)
        self.assertEqual(r['approach_5m_points'], 1.75)
        self.assertEqual(r['efficiency_5m'], 1.0)
        self.assertEqual(r['reclaim'], 'same-candle wick close back')
        self.assertEqual(r['entry_a'], 99.5)
        self.assertEqual(r['entry_b'], 99.25)
        self.assertEqual(r['confirmation'], 'not yet known')
        self.assertEqual(r['earlier_touches_today'], 1)
        self.assertIsNone(r['atr14_5m'])           # fewer than 14 closed 5-minute bars
        self.assertTrue(r['quotes'])

    def test_confirmation_yes_no(self):
        self.assertEqual(self.at(self.day(), 10, 6, 30)['confirmation'], 'yes')
        self.assertEqual(self.at(self.day(confirm_px=99.75), 10, 7, 0)['confirmation'], 'no')

    def test_not_closed_back_inside_the_candle(self):
        self.assertEqual(self.at(self.day(), 10, 5, 30)['reclaim'], 'not closed back yet')

    def test_no_tick_after_the_clock_is_used(self):
        day = self.day()
        clock = int(core.wall_to_utc([W(10, 6, 10)])[0])
        a = core.machine_read(day, clock, 100.0)                      # handed the whole day, it still cuts at the clock
        b = core.machine_read(day.upto(ms.visible_count(day, clock)), clock, 100.0)
        day.px[-2:] = [50.0, 500.0]                                  # change the future
        c = core.machine_read(day, clock, 100.0)
        self.assertEqual(a, b)
        self.assertEqual(a, c)

    def test_last_only_day_uses_total_volume(self):
        rows = [(r[0], r[1], r[2], '') for r in [(W(10, 0), 98.0, 10), (W(10, 4), 99.75, 2), (W(10, 5), 100.25, 3), (W(10, 5, 10), 101.0, 1), (W(10, 5, 20), 99.75, 1)]]
        r = core.machine_read(tape(rows, quotes=False), int(core.wall_to_utc([W(10, 5, 30)])[0]), 100.0)
        self.assertIn('total volume', r['volume_basis'])
        self.assertEqual(r['into_level_windows'], [10, 0, 0, 0, 2])

    def test_wilder_atr(self):
        h = np.array([12.0] * 15)
        l = np.array([10.0] * 15)
        c = np.array([11.0] * 15)
        self.assertEqual(core.wilder_atr(h, l, c, 14), 2.0)
        h2 = np.r_[h, 16.0]
        l2 = np.r_[l, 10.0]
        c2 = np.r_[c, 15.0]
        self.assertAlmostEqual(core.wilder_atr(h2, l2, c2, 14), (2.0 * 13 + 6.0) / 14)
        self.assertIsNone(core.wilder_atr(h[:13], l[:13], c[:13], 14))

    def test_rule_draft(self):
        rule = core.RULE_DEFAULT
        r = self.at(self.day(), 10, 6, 10)
        d = core.draft_verdict(r, rule)
        self.assertEqual(d['verdict'], 'TAKE')
        self.assertEqual((d['entry_a'], d['entry_b']), (99.5, 99.25))
        self.assertEqual(core.draft_verdict(self.at(self.day(), 10, 5, 30), rule)['verdict'], 'PASS')
        self.assertEqual(core.draft_verdict(r, dict(rule, slope_below=-5))['verdict'], 'PASS')
        self.assertTrue(core.agrees('SWEEP', 'TAKE'))
        self.assertTrue(core.agrees('NONE', 'PASS'))
        self.assertFalse(core.agrees('RETEST', 'TAKE'))


class MarksOnDisk(unittest.TestCase):
    def test_atomic_no_overwrite(self):
        with tempfile.TemporaryDirectory() as t:
            a = core.save_grade(t, {'id': 'C1', 'setup': 'SWEEP', 'n': 1})
            b = core.save_grade(t, {'id': 'C1', 'setup': 'NONE', 'n': 2})
            self.assertEqual(os.path.basename(a), 'grade_C1.json')
            self.assertEqual(os.path.basename(b), 'grade_C1_2.json')
            with open(a) as f:
                self.assertEqual(json.load(f)['n'], 1)
            with open(b) as f:
                self.assertEqual(json.load(f)['n'], 2)
            with open(os.path.join(t, 'marks_log.jsonl')) as f:
                self.assertEqual([json.loads(x)['n'] for x in f], [1, 2])
            self.assertFalse([n for n in os.listdir(t) if n.endswith('.tmp')])
            dest, rows = core.export_csv(t)
            self.assertEqual(rows, 2)
            with open(dest) as f:
                self.assertEqual(len(list(csv.DictReader(f))), 2)


class StudioFlow(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = os.path.join(self.tmp.name, 'data')
        self.marks = os.path.join(self.tmp.name, 'marks')
        markup_fixture.write(self.data)
        os.makedirs(self.marks)
        # a cache that wrongly holds a holdout day: it must be dropped
        with open(os.path.join(self.marks, 'candidates_v1.json'), 'w') as f:
            json.dump({'version': 1, 'symbol': 'NQ', 'days_scanned': ['2026-04-02'], 'rth': {'2026-04-02': [1, 0]},
                       'items': [{'id': 'X', 'date': '2026-04-02', 'cross_utc_ms': 1, 'cut_utc_ms': 2, 'level_type': 'PDH', 'level_price': 1.0}]}, f)
        self.src = ms.NpzSource(self.data, 'NQ')
        self.st = ms.Studio(self.src, self.marks, os.path.join(HERE, '..', 'tools', 'markup_rule_v0.json'), [], 'NQ')
        self.st.start_scan(background=False)

    def tearDown(self):
        self.tmp.cleanup()

    def test_holdout_at_every_entry_point(self):
        self.assertEqual(self.src.days(), ['2026-03-09', '2026-03-10'])
        with self.assertRaises(core.HoldoutError):
            self.src.load('2026-04-02')
        with self.assertRaises(core.HoldoutError):
            self.st.free_load('2026-04-02', '10:00')
        with self.assertRaises(core.HoldoutError):
            core.check_date('2026-04-01')
        core.check_date('2026-03-31')
        self.assertTrue(self.st.scan['done'])
        self.assertEqual({c['date'] for c in self.st.candidates}, {'2026-03-10'})

    def test_blind_flow(self):
        s = self.st.blind_next()
        self.assertNotIn('date', s)
        self.assertNotIn('id', s.get('candidate', {}))
        self.assertEqual(s['clock_tod'], '10:06:00')
        with self.assertRaises(ms.Refused):
            self.st.machine()
        with self.assertRaises(ms.Refused):
            self.st.play(5)
        with self.assertRaises(ms.Refused):
            self.st.jump(minutes=30)
        self.st.step()
        self.assertEqual(self.st.state()['clock_tod'], '10:07:00')
        with self.assertRaises(ms.Refused):
            self.st.save({'setup': 'SWEEP', 'reason': 'x'})        # no direction
        r = self.st.save({'setup': 'SWEEP', 'direction': 'SHORT', 'chips': ['volume drying up'],
                          'marks': [{'role': 'Entry', 'chart': 'range', 't': core.wall_of(D, 10, 5) / 1000, 'price': 20059.25}]})
        self.assertTrue(r['machine_read']['ok'])
        g = core.list_grades(self.marks)[0]
        self.assertEqual((g['date'], g['steps_after_cut'], g['setup']), ('2026-03-10', 1, 'SWEEP'))
        self.assertEqual(g['marks'][0]['bar_time_utc_ms'], int(core.wall_to_utc([core.wall_of(D, 10, 5)])[0]))
        self.assertEqual(self.st.agreement()['total'], 1)
        self.st.play(5)                                               # Reveal, after the save
        with self.assertRaises(ms.Refused):
            self.st.save({'setup': 'NONE'})                          # graded already
        with self.assertRaises(ms.Refused):
            self.st.blind_next()                                      # the only candidate is graded now
        self.assertEqual(self.st.queue()['remaining'], 0)

    def test_clock_never_backward(self):
        self.st.free_load(D, '10:00')
        with self.assertRaises(ms.Refused):
            self.st.jump('09:00')
        self.st.jump('10:30')
        self.assertEqual(self.st.state()['clock_tod'], '10:30:00')


if __name__ == '__main__':
    unittest.main()
