"""A public TEST bot for the Markup Studio's Bot tab (BOT_API 1). A made-up rule for the tests only, not a strategy:

    at the variant's time, a buy stop 1 point over the last price (or a sell stop 1 point under it), good for 15 minutes;
    once filled, a stop and a target a fixed number of points away (per exit id); flat at 16:00. Days without quotes: no
    trade (a note only). Variant TM arms three times (two buys and a sell), for the Trades tab's tests.

    python3 tools/markup_studio.py --bot=test/markup_bot_fixture.py
Causal: everything decided at time t uses ticks with wall <= t only.
"""
import numpy as np

BOT_API = 1
NAME = 'Test bot'
EXITS = {'base': (5.0, 10.0), 't5': (5.0, 5.0)}          # exit id: (stop points, target points)
MIN = 60_000


def variants():
    return [{'id': 'T1000', 'label': 'buy stop 1 point over the last price at 10:00', 'params': {'at': '10:00'}},
            {'id': 'T1100', 'label': 'buy stop 1 point over the last price at 11:00', 'params': {'at': '11:00'}},
            {'id': 'TM', 'label': 'buy stops at 10:00 and 11:00, a sell stop at 11:01',
             'params': {'arms': [['10:00', 'buy'], ['11:00', 'buy'], ['11:01', 'sell']]}}]


def exit_ids():
    return list(EXITS)


def _wall(day, hhmm):
    from datetime import datetime
    hh, mm = (int(x) for x in hhmm.split(':'))
    x = datetime.strptime(day.date, '%Y-%m-%d').replace(hour=hh, minute=mm)
    return int((x - datetime(1970, 1, 1)).total_seconds() * 1000)


def _exit(day, j, entry, stop_pts, target_pts, flat_t, sgn=1):
    """The first tick after the fill at or beyond the stop or the target (filled at that price), else flat at 16:00.
    sgn 1 long, -1 short."""
    stop, target = entry - sgn * stop_pts, entry + sgn * target_pts
    for k in range(j + 1, len(day.px)):
        t, p = int(day.wall[k]), float(day.px[k])
        if t >= flat_t:
            return t, p, 'flat'
        if sgn * (p - stop) <= 0:
            return t, stop, 'stop'
        if sgn * (p - target) >= 0:
            return t, target, 'target'
    return int(day.wall[-1]), float(day.px[-1]), 'flat'


def _arm(day, at, side, n, events, orders, trades, progress):
    """One arm: the entry stop at `at`, its fill, stop and target orders and the trade (ids E<n>, S<n>, T<n>, X<n>)."""
    sgn = 1 if side == 'buy' else -1
    exit_side = 'sell' if side == 'buy' else 'buy'
    t0 = _wall(day, at)
    i0 = int(np.searchsorted(day.wall, t0, 'right')) - 1
    if i0 < 0:
        return
    last = float(day.px[i0])
    stop_px, until = last + sgn * 1.0, t0 + 15 * MIN
    word = 'buy' if side == 'buy' else 'sell'
    events.append({'t': t0, 'kind': 'arm', 'text': f'{word} stop {stop_px:.2f} (last {last:.2f})', 'price': stop_px, 'level': None})
    j = next((k for k in range(i0 + 1, len(day.px)) if day.wall[k] <= until and sgn * (day.px[k] - stop_px) >= 0), None)
    if j is None or day.wall[j] > until:
        orders.append({'id': f'E{n}', 'side': side, 'type': 'stop', 'role': 'entry', 'price': stop_px, 'limit': None,
                       't_from': t0, 't_to': until, 'status': 'expired'})
        events.append({'t': until, 'kind': 'expire', 'text': f'{word} stop expired', 'price': stop_px, 'level': None})
        return
    tj, entry = int(day.wall[j]), float(day.px[j])
    if progress:
        progress(0.5)
    orders.append({'id': f'E{n}', 'side': side, 'type': 'stop', 'role': 'entry', 'price': stop_px, 'limit': None,
                   't_from': t0, 't_to': tj, 'status': 'filled'})
    events.append({'t': tj, 'kind': 'fill', 'text': f'{"bought" if side == "buy" else "sold"} 1 at {entry:.2f}', 'price': entry, 'level': None})
    flat_t = _wall(day, '16:00')
    exits = {}
    for k, (sp, tp) in EXITS.items():
        xt, xp, why = _exit(day, j, entry, sp, tp, flat_t, sgn)
        exits[k] = {'exit_t': xt, 'exit': xp, 'reason': why, 'points': round(sgn * (xp - entry), 2), 'r': round(sgn * (xp - entry) / sp, 3)}
    b = exits['base']
    sp, tp = EXITS['base']
    orders.append({'id': f'S{n}', 'side': exit_side, 'type': 'stop', 'role': 'stop', 'price': entry - sgn * sp, 'limit': None,
                   't_from': tj, 't_to': b['exit_t'], 'status': 'filled' if b['reason'] == 'stop' else 'cancelled'})
    orders.append({'id': f'T{n}', 'side': exit_side, 'type': 'limit', 'role': 'target', 'price': entry + sgn * tp, 'limit': None,
                   't_from': tj, 't_to': b['exit_t'], 'status': 'filled' if b['reason'] == 'target' else 'cancelled'})
    events.append({'t': b['exit_t'], 'kind': 'exit', 'text': f'{b["reason"]} {b["points"]:+.2f}', 'price': b['exit'], 'level': None})
    trades.append({'id': f'X{n}', 'level_type': 'time', 'level_price': stop_px, 'dir': 'long' if side == 'buy' else 'short',
                   'entry_t': tj, 'entry': entry, 'stop': entry - sgn * sp, 'target': entry + sgn * tp, 'target_kind': '2R', 'exits': exits,
                   'features': {'last_at_arm': last, 'minutes_to_fill': round((tj - t0) / MIN, 2)}})


def run(day, prior, params, progress=None):
    events, orders, trades = [], [], []
    open_t = _wall(day, '09:30')
    note = f'prior day high {float(np.max(prior.px)):.2f}' if prior is not None and len(prior.px) else 'no prior day'
    events.append({'t': open_t, 'kind': 'note', 'text': note, 'price': None, 'level': None})
    if not day.has_quotes:
        events.append({'t': open_t, 'kind': 'note', 'text': 'no quotes this day: no trade', 'price': None, 'level': None})
        return {'events': events, 'orders': orders, 'trades': trades}
    for n, (at, side) in enumerate(params.get('arms') or [[params['at'], 'buy']], 1):
        _arm(day, at, side, n, events, orders, trades, progress)
    if progress:
        progress(1.0)
    events.sort(key=lambda e: e['t'])
    return {'events': events, 'orders': orders, 'trades': trades}
