"""A public TEST bot for the Markup Studio's Bot tab (BOT_API 1). A made-up rule for the tests only, not a strategy:

    at the variant's time, a buy stop 1 point over the last price (or a sell stop 1 point under it), good for 15 minutes;
    once filled, a stop and a target a fixed number of points away (per exit id); flat at 16:00. Days without quotes: no
    trade (a note only). Variant TM arms three times (two buys and a sell), for the Trades tab's tests, and also works a
    sell stop 50 points under the last price from 10:59 to 11:15 that never fills (another entry order working at the
    cuts of the 11:00 and 11:01 trades, which the Trades tab must not draw).

    simulate(day, prior, spec) (optional in BOT_API 1): your own trade with a made-up law, hand-checkable: the entry fills
    at the first tick at or after spec['t'] that reaches it (stops: at or through the entry, at that tick's price; limit:
    at or through it, at the entry; market: that first tick's price), unless a tick at or through the stop comes first
    ('stop traded before entry'); then out at the stop or the target (spec's, else 2R from the fill) at its price on the
    first tick that reaches it, or at 16:00 at that tick's price ('flat'); never filled by 16:00: 'no fill'.

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


def _arm(day, at, side, n, events, orders, trades, progress, exit_orders):
    """One arm: the entry stop at `at`, its fill, stop and target orders and the trade (ids E<n>, S<n>, T<n>, X<n>); each
    exit's own stop and target in exit_orders (ids <exit>-S<n>, <exit>-T<n>, book X<n>:<exit>)."""
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
        for role, typ, px, tag in (('stop', 'stop', entry - sgn * sp, 'S'), ('target', 'limit', entry + sgn * tp, 'T')):
            exit_orders[k].append({'id': f'{k}-{tag}{n}', 'side': exit_side, 'type': typ, 'role': role, 'price': px, 'limit': None,
                                   't_from': tj, 't_to': xt, 'status': 'filled' if why == role else 'cancelled',
                                   'exit_id': k, 'book': f'X{n}:{k}'})
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
    """BOT_API 1, with the optional 'exit_orders' (each exit's own stop and target per trade)."""
    events, orders, trades, exit_orders = [], [], [], {k: [] for k in EXITS}
    open_t = _wall(day, '09:30')
    note = f'prior day high {float(np.max(prior.px)):.2f}' if prior is not None and len(prior.px) else 'no prior day'
    events.append({'t': open_t, 'kind': 'note', 'text': note, 'price': None, 'level': None})
    if not day.has_quotes:
        events.append({'t': open_t, 'kind': 'note', 'text': 'no quotes this day: no trade', 'price': None, 'level': None})
        return {'events': events, 'orders': orders, 'trades': trades, 'exit_orders': exit_orders}
    for n, (at, side) in enumerate(params.get('arms') or [[params['at'], 'buy']], 1):
        _arm(day, at, side, n, events, orders, trades, progress, exit_orders)
    if params.get('arms'):                                   # TM: an entry order that never fills, working 10:59 to 11:15
        t0 = _wall(day, '10:59')
        i0 = int(np.searchsorted(day.wall, t0, 'right')) - 1
        if i0 >= 0:
            orders.append({'id': 'D1', 'side': 'sell', 'type': 'stop', 'role': 'entry', 'price': float(day.px[i0]) - 50.0,
                           'limit': None, 't_from': t0, 't_to': t0 + 16 * MIN, 'status': 'expired'})
    if progress:
        progress(1.0)
    events.sort(key=lambda e: e['t'])
    return {'events': events, 'orders': orders, 'trades': trades, 'exit_orders': exit_orders}


TYPES = {'stop-limit': 'stoplimit', 'stop-market': 'stop', 'limit': 'limit', 'market': 'market'}


def simulate(day, prior, spec):
    """Your trade by the made-up law in the module's docstring (not a fill engine). spec: dir, entry_type, entry, stop,
    target (None: 2R), t (wall ms)."""
    sg = 1 if spec['dir'] == 'long' else -1
    if not sg * (spec['entry'] - spec['stop']) > 0:
        raise ValueError('the stop must be on the losing side of the entry')
    side, out_side = ('buy', 'sell') if sg > 0 else ('sell', 'buy')
    t, et, flat_t = int(spec['t']), spec['entry_type'], _wall(day, '16:00')
    res = {'version': 'fixture_v1', 'filled': False, 'reason': 'no fill', 'entry_t': None, 'entry': None, 'exit_t': None,
           'exit': None, 'points': None, 'r': None, 'target': spec.get('target'), 'orders': []}
    entry = {'id': 'yours-entry', 'side': side, 'type': TYPES[et], 'role': 'entry', 'price': spec['entry'],
             'limit': spec['entry'] + sg * 0.25 if et == 'stop-limit' else None, 't_from': t, 't_to': flat_t, 'status': 'cancelled'}
    res['orders'].append(entry)
    j = int(np.searchsorted(day.wall, t, 'left'))
    k = None
    for i in range(j, len(day.px)):
        w, p = int(day.wall[i]), float(day.px[i])
        if w >= flat_t:
            break
        if sg * (p - spec['stop']) <= 0:
            entry['t_to'], res['reason'] = w, 'stop traded before entry'
            return res
        hit = (et == 'market' or (et == 'limit' and sg * (p - spec['entry']) <= 0)
               or (et in ('stop-limit', 'stop-market') and sg * (p - spec['entry']) >= 0))
        if hit:
            k = i
            break
    if k is None:
        return res
    fill = spec['entry'] if et == 'limit' else float(day.px[k])
    tk = int(day.wall[k])
    entry.update(t_to=tk, status='filled')
    risk = abs(fill - spec['stop'])
    target = spec['target'] if spec.get('target') is not None else fill + sg * 2 * risk
    res.update(filled=True, entry_t=tk, entry=fill, target=target)
    xt, xp, why = int(day.wall[-1]), float(day.px[-1]), 'end of tape'
    for i in range(k + 1, len(day.px)):
        w, p = int(day.wall[i]), float(day.px[i])
        if w >= flat_t:
            xt, xp, why = w, p, 'flat'
            break
        if sg * (p - spec['stop']) <= 0:
            xt, xp, why = w, spec['stop'], 'stop'
            break
        if sg * (p - target) >= 0:
            xt, xp, why = w, target, 'target'
            break
    for role, typ, px in (('stop', 'stop', spec['stop']), ('target', 'limit', target)):
        res['orders'].append({'id': 'yours-' + role, 'side': out_side, 'type': typ, 'role': role, 'price': px, 'limit': None,
                              't_from': tk, 't_to': xt, 'status': 'filled' if why == role else 'cancelled'})
    pts = round(sg * (xp - fill), 2)
    res.update(reason=why, exit_t=xt, exit=xp, points=pts, r=round(pts / risk, 4))
    return res
