"""Synthetic NQ days for the Markup Studio tests. MADE-UP SAMPLE DATA, never market data.

    python3 test/markup_fixture.py OUTDIR      writes OUTDIR/NQ_<date>.npz and OUTDIR/fixture.json

Days (each a session from 18:00 the evening before to 16:59:55, one trade every 5 seconds, so a trade sits exactly on
every minute boundary):
  2026-03-09  a slow wave, no quotes; its RTH high is PDH for the next day
  2026-03-10  quotes; one clean PDH sweep: cross at 10:05:10, 8 ticks through at 10:05:30, reclaim at 10:05:50,
              the 10:05 candle closes back below (cut 10:06:00); the volume into the level dries up before the cross
  2026-04-02  a holdout day (must never be listed, loaded or scanned)
"""
import json
import math
import os
import sys
from datetime import datetime, timedelta

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools'))
import markup_core as core  # noqa: E402

TICK = 0.25
q = lambda p: round(p / TICK) * TICK


def wall(d, hh, mm=0, ss=0.0):
    x = datetime.strptime(d, '%Y-%m-%d') + timedelta(hours=hh, minutes=mm, seconds=ss)
    return int(round((x - datetime(1970, 1, 1)).total_seconds() * 1000))


def session_times(d):
    prev = (datetime.strptime(d, '%Y-%m-%d') - timedelta(days=1)).strftime('%Y-%m-%d')
    return np.arange(wall(prev, 18), wall(d, 17), 5000, dtype=np.int64)


def day_a(d='2026-03-09'):
    t = session_times(d)
    k = np.arange(t.size)
    px = np.array([q(20000 + 60 * math.sin(i / 900.0)) for i in k])
    vol = 1 + (k % 3)
    return t, px, vol


def day_b(P, d='2026-03-10'):
    t = session_times(d)
    s = core.tod_s(t)
    px = np.empty(t.size)
    vol = np.ones(t.size, dtype=np.int64)
    sweep = {wall(d, 10, 5, 10): P + 0.25, wall(d, 10, 5, 15): P + 1.00, wall(d, 10, 5, 20): P + 1.50,
             wall(d, 10, 5, 25): P + 1.75, wall(d, 10, 5, 30): P + 2.00, wall(d, 10, 5, 35): P + 1.25,
             wall(d, 10, 5, 40): P + 0.50, wall(d, 10, 5, 45): P + 0.00, wall(d, 10, 5, 50): P - 0.50,
             wall(d, 10, 5, 55): P - 0.75}
    for i, (w, x) in enumerate(zip(t, s)):
        if x >= 18 * 3600 or x < 9 * 3600 + 30 * 60:                      # overnight: P-60 .. P-5
            p = P - 32.5 + 27.5 * math.sin(i / 400.0)
        elif x < 10 * 3600 + 4 * 60:                                       # RTH before the move: P-50 .. P-10
            p = P - 30 + 20 * math.sin(i / 300.0)
        elif x < 10 * 3600 + 5 * 60 + 10:                                  # the approach: P-10 up to P-0.25
            f = (x - (10 * 3600 + 4 * 60)) / 70.0
            p = min(P - 0.25, P - 10 + 9.75 * f)
        elif int(w) in sweep:
            p = sweep[int(w)]
        else:                                                              # after: easing from P-1 to P-4, then flat
            f = min(1.0, (x - (10 * 3600 + 6 * 60)) / 1440.0)
            p = P - 1 - 3 * f + 0.25 * (i % 2)
        px[i] = q(p)
        if 10 * 3600 <= x < 10 * 3600 + 5 * 60 + 10:                       # the volume into the level dries up
            vol[i] = 6 - (x - 10 * 3600) // 60
    # ONH exactly P-5 and ONL exactly P-60 (one trade each)
    on = np.flatnonzero((s >= 18 * 3600) | (s < 9 * 3600 + 30 * 60))
    px[on[10]], px[on[20]] = P - 5, P - 60
    up = np.r_[True, np.diff(px) >= 0]
    bid = np.where(up, px - TICK, px)
    ask = np.where(up, px, px + TICK)
    return t, px, vol, bid, ask


def write(out):
    os.makedirs(out, exist_ok=True)
    ta, pa, va = day_a()
    np.savez(os.path.join(out, 'NQ_2026-03-09.npz'), wall_ms=ta, price=pa, volume=va)
    s = core.tod_s(ta)
    P = float(pa[(s >= 34200) & (s < 57600)].max())
    tb, pb, vb, bb, ab = day_b(P)
    np.savez(os.path.join(out, 'NQ_2026-03-10.npz'), wall_ms=tb, price=pb, volume=vb, bid=bb, ask=ab)
    th, ph, vh = day_a('2026-04-02')
    np.savez(os.path.join(out, 'NQ_2026-04-02.npz'), wall_ms=th, price=ph, volume=vh)
    info = {'PDH': P, 'days': {'2026-03-10': {'wall': tb.tolist(), 'utc': core.wall_to_utc(tb).tolist(), 'px': pb.tolist(), 'vol': vb.tolist()}}}
    with open(os.path.join(out, 'fixture.json'), 'w') as f:
        json.dump(info, f)
    return info


if __name__ == '__main__':
    write(sys.argv[1])
    print('fixture written to', sys.argv[1])
