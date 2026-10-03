"""A public TEST bot for the Markup Studio's Bot tab (BOT_API 1). A made-up rule for the tests only, not a strategy:

    at the variant's time, a buy stop 1 point over the last price, good for 15 minutes; once filled, a stop and a target
    a fixed number of points away (per exit id); flat at 16:00. Days without quotes: no trade (a note only).

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
            {'id': 'T1100', 'label': 'buy stop 1 point over the last price at 11:00', 'params': {'at': '11:00'}}]


def exit_ids():
    return list(EXITS)


def _wall(day, hhmm):
    from datetime import datetime
    hh, mm = (int(x) for x in hhmm.split(':'))
    x = datetime.strptime(day.date, '%Y-%m-%d').replace(hour=hh, minute=mm)
    return int((x - datetime(1970, 1, 1)).total_seconds() * 1000)


def _exit(day, j, entry, stop_pts, target_pts, flat_t):
    """The first tick after the fill at or beyond the stop or the target (filled at that price), else flat at 16:00."""
    stop, target = entry - stop_pts, entry + target_pts
    for k in range(j + 1, len(day.px)):
        t, p = int(day.wall[k]), float(day.px[k])
        if t >= flat_t:
            return t, p, 'flat'
        if p <= stop:
            return t, stop, 'stop'
        if p >= target:
            return t, target, 'target'
    return int(day.wall[-1]), float(day.px[-1]), 'flat'


def run(day, prior, params, progress=None):
    events, orders, trades = [], [], []
    open_t = _wall(day, '09:30')
    note = f'prior day high {float(np.max(prior.px)):.2f}' if prior is not None and len(prior.px) else 'no prior day'
    events.append({'t': open_t, 'kind': 'note', 'text': note, 'price': None, 'level': None})
    if not day.has_quotes:
        events.append({'t': open_t, 'kind': 'note', 'text': 'no quotes this day: no trade', 'price': None, 'level': None})
        return {'events': events, 'orders': orders, 'trades': trades}
    t0 = _wall(day, params['at'])
    i0 = int(np.searchsorted(day.wall, t0, 'right')) - 1
    if i0 < 0:
        return {'events': events, 'orders': orders, 'trades': trades}
    last = float(day.px[i0])
    stop_px, until = last + 1.0, t0 + 15 * MIN
    events.append({'t': t0, 'kind': 'arm', 'text': f'buy stop {stop_px:.2f} (last {last:.2f})', 'price': stop_px, 'level': None})
    j = next((k for k in range(i0 + 1, len(day.px)) if day.wall[k] <= until and day.px[k] >= stop_px), None)
    if j is None or day.wall[j] > until:
        orders.append({'id': 'E1', 'side': 'buy', 'type': 'stop', 'role': 'entry', 'price': stop_px, 'limit': None,
                       't_from': t0, 't_to': until, 'status': 'expired'})
        events.append({'t': until, 'kind': 'expire', 'text': 'buy stop expired', 'price': stop_px, 'level': None})
        return {'events': events, 'orders': orders, 'trades': trades}
    tj, entry = int(day.wall[j]), float(day.px[j])
    if progress:
        progress(0.5)
    orders.append({'id': 'E1', 'side': 'buy', 'type': 'stop', 'role': 'entry', 'price': stop_px, 'limit': None,
                   't_from': t0, 't_to': tj, 'status': 'filled'})
    events.append({'t': tj, 'kind': 'fill', 'text': f'bought 1 at {entry:.2f}', 'price': entry, 'level': None})
    flat_t = _wall(day, '16:00')
    exits = {}
    for k, (sp, tp) in EXITS.items():
        xt, xp, why = _exit(day, j, entry, sp, tp, flat_t)
        exits[k] = {'exit_t': xt, 'exit': xp, 'reason': why, 'points': round(xp - entry, 2), 'r': round((xp - entry) / sp, 3)}
    b = exits['base']
    sp, tp = EXITS['base']
    orders.append({'id': 'S1', 'side': 'sell', 'type': 'stop', 'role': 'stop', 'price': entry - sp, 'limit': None,
                   't_from': tj, 't_to': b['exit_t'], 'status': 'filled' if b['reason'] == 'stop' else 'cancelled'})
    orders.append({'id': 'T1', 'side': 'sell', 'type': 'limit', 'role': 'target', 'price': entry + tp, 'limit': None,
                   't_from': tj, 't_to': b['exit_t'], 'status': 'filled' if b['reason'] == 'target' else 'cancelled'})
    events.append({'t': b['exit_t'], 'kind': 'exit', 'text': f'{b["reason"]} {b["points"]:+.2f}', 'price': b['exit'], 'level': None})
    trades.append({'id': 'X1', 'level_type': 'time', 'level_price': stop_px, 'dir': 'long', 'entry_t': tj, 'entry': entry,
                   'stop': entry - sp, 'target': entry + tp, 'target_kind': '2R', 'exits': exits,
                   'features': {'last_at_arm': last, 'minutes_to_fill': round((tj - t0) / MIN, 2)}})
    if progress:
        progress(1.0)
    events.sort(key=lambda e: e['t'])
    return {'events': events, 'orders': orders, 'trades': trades}
