"""Markup Studio Bot tab unit tests: the day split, quote detection, the no-future view filter, the summary math, the bot
module checks and the bot endpoints. Made-up sample data and the public test bot (test/markup_bot_fixture.py) only.

    python3 -m unittest discover -s test -p "test_markup*.py"
"""
import csv
import http.client
import json
import os
import random
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'tools'))
sys.path.insert(0, HERE)
import markup_core as core  # noqa: E402
import markup_studio as ms  # noqa: E402
import markup_fixture  # noqa: E402
from test_markup_studio import fake_tickreplay  # noqa: E402

RULE = os.path.join(HERE, '..', 'tools', 'markup_rule_v0.json')
BOT = os.path.join(HERE, 'markup_bot_fixture.py')
W = lambda d, hh, mm=0, ss=0: core.wall_of(d, hh, mm, ss)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = os.path.join(self.tmp.name, 'data')
        self.marks = os.path.join(self.tmp.name, 'marks')
        markup_fixture.write(self.data)
        self.logs = []
        self._log = ms.log
        ms.log = self.logs.append

    def tearDown(self):
        ms.log = self._log
        self.tmp.cleanup()

    def studio(self, bot=BOT, source=None, scan=True):
        st = ms.Studio(source or ms.NpzSource(self.data, 'NQ'), self.marks, RULE, [], 'NQ', bot_path=bot)
        if scan:
            st.start_scan(background=False)
        return st

    def split_file(self):
        return os.path.join(self.marks, 'bot_split_v1.json')

    def wait_bot(self, st):
        for _ in range(200):
            if st.state().get('bot_day', {}).get('status') != 'running':
                return
            time.sleep(0.02)
        self.fail('the bot run never finished')

    def at(self, st, hhmm):
        st.clock = ms.clock_of(st.day.date, hhmm)


class Split(Base):
    def test_hand_worked_split(self):
        q = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09']
        xs = sorted(q)
        random.Random(7).shuffle(xs)                       # the seeded shuffle, by hand
        sp = core.bot_split(reversed(q), ['2026-01-02'])
        self.assertEqual((sp['version'], sp['seed']), (1, 7))
        self.assertEqual(sp['bot'], sorted(['2026-01-02'] + xs[:3]))          # ceil(5/2) = 3 quote days and the last-only one
        self.assertEqual(sp['grading'], sorted(xs[3:]))
        self.assertEqual(core.bot_split(q, ['2026-01-02']), sp)                # the order given does not matter

    def test_written_on_first_start(self):
        self.studio(bot=None)
        with open(self.split_file()) as f:
            self.assertEqual(json.load(f), {'version': 1, 'seed': 7, 'bot': ['2026-03-05', '2026-03-09'], 'grading': ['2026-03-10'],
                                              'symbol': 'NQ'})

    def test_never_changes_and_new_days_go_to_neither_list(self):
        self.studio(bot=None)
        with open(self.split_file()) as f:
            before = f.read()
        st = self.studio(bot=None)                         # a restart: read back, same file
        with open(self.split_file()) as f:
            self.assertEqual(f.read(), before)
        # new data: a day the file does not hold goes to neither list, logged
        with open(self.split_file(), 'w') as f:
            json.dump({'version': 1, 'seed': 7, 'bot': ['2026-03-05'], 'grading': ['2026-03-10']}, f)
        self.logs.clear()
        st = self.studio(bot=None)
        self.assertEqual((st.bot_days, st.grading_days), ({'2026-03-05'}, {'2026-03-10'}))
        self.assertTrue(any('2026-03-09' in x and 'neither' in x for x in self.logs))
        with open(self.split_file()) as f:
            self.assertEqual(json.load(f)['bot'], ['2026-03-05'])            # not rewritten

    def test_no_days_no_file(self):
        empty = os.path.join(self.tmp.name, 'empty')
        os.makedirs(empty)
        st = self.studio(bot=None, source=ms.NpzSource(empty, 'NQ'))
        self.assertFalse(os.path.exists(self.split_file()))
        self.assertIsNone(st.grading_days)

    def test_quote_days_without_loading(self):
        self.assertEqual(ms.NpzSource(self.data, 'NQ').quote_days(), ['2026-03-05', '2026-03-10'])
        tr, packed = fake_tickreplay(self.tmp.name, self.data)
        try:
            src = ms.TickReplaySource(tr, packed, 'NQ')
            self.assertEqual(src.quote_days(), ['2026-03-05', '2026-03-10'])
            self.assertEqual(src.mod.CALLS, [])                               # from sessions_index.csv, nothing loaded
        finally:
            sys.path[:] = [p for p in sys.path if p != os.path.abspath(tr)]
            sys.modules.pop('loader', None)

    def test_blind_queue_skips_bot_days(self):
        st = self.studio(bot=None)
        self.assertEqual((st.queue()['remaining'], st.queue()['bot_days']), (1, 0))
        os.remove(self.split_file())
        os.makedirs(self.marks, exist_ok=True)
        with open(self.split_file(), 'w') as f:
            json.dump({'version': 1, 'seed': 7, 'bot': ['2026-03-09', '2026-03-10'], 'grading': ['2026-03-05']}, f)
        st = self.studio(bot=None)
        self.assertEqual((st.queue()['remaining'], st.queue()['bot_days']), (0, 1))
        with self.assertRaises(ms.Refused):
            st.blind_next()


class ViewFilter(unittest.TestCase):
    """Hand-worked: what the page may see at clocks 2000, 3000 and 4000 (wall ms)."""
    RES = {
        'events': [{'t': 1000, 'kind': 'arm', 'text': 'a', 'price': 1.0, 'level': None, 'secret': 'x'},
                   {'t': 2000, 'kind': 'fill', 'text': 'b', 'price': 2.0, 'level': None},
                   {'t': 3000, 'kind': 'exit', 'text': 'c', 'price': 3.0, 'level': None}],
        'orders': [{'id': 'o1', 'side': 'buy', 'type': 'stop', 'role': 'entry', 'price': 10.0, 'limit': None, 't_from': 500, 't_to': 1500, 'status': 'filled'},
                   {'id': 'o2', 'side': 'sell', 'type': 'limit', 'role': 'target', 'price': 20.0, 'limit': None, 't_from': 2500, 't_to': 4000, 'status': 'cancelled', 'fill_t': 9},
                   {'id': 'o3', 'side': 'buy', 'type': 'stop', 'role': 'entry', 'price': 30.0, 'limit': None, 't_from': 5000, 't_to': 6000, 'status': 'expired'}],
        'trades': [{'id': 'X1', 'level_type': 'L', 'level_price': 9.0, 'dir': 'long', 'entry_t': 1500, 'entry': 10.0, 'stop': 5.0, 'target': 20.0,
                    'target_kind': '2R', 'features': {'f': 1}, 'outcome': 'hidden',
                    'exits': {'base': {'exit_t': 2500, 'exit': 20.0, 'reason': 'target', 'points': 10.0, 'r': 2.0, 'mfe': 99},
                              'alt': {'exit_t': 3500, 'exit': 5.0, 'reason': 'stop', 'points': -5.0, 'r': -1.0}}},
                   {'id': 'X2', 'level_type': 'L', 'level_price': 9.0, 'dir': 'short', 'entry_t': 4500, 'entry': 10.0, 'stop': 15.0,
                    'target': 0.0, 'target_kind': '2R', 'features': {}, 'exits': {}}]}

    def test_at_2000(self):
        v = core.bot_view(self.RES, 2000, ['base', 'alt'])
        self.assertEqual([e['t'] for e in v['events']], [1000, 2000])
        self.assertEqual(v['orders'], [{'id': 'o1', 'side': 'buy', 'type': 'stop', 'role': 'entry', 'price': 10.0, 'limit': None,
                                        't_from': 500, 't_to': 1500, 'status': 'filled', 'open': False}])
        self.assertEqual([(t['id'], t['exits']) for t in v['trades']], [('X1', {})])
        self.assertEqual(v['net']['base'], {'trades': 0, 'points': 0, 'usd': 0, 'usd_micro': 0})

    def test_at_3000(self):
        v = core.bot_view(self.RES, 3000, ['base', 'alt'])
        self.assertEqual(len(v['events']), 3)
        o2 = v['orders'][1]
        self.assertEqual((o2['id'], o2['t_from'], o2['t_to'], o2['status'], o2['open']), ('o2', 2500, 3000, None, True))   # clipped, no status yet
        self.assertEqual(list(v['trades'][0]['exits']), ['base'])
        self.assertEqual(v['net']['base'], {'trades': 1, 'points': 10.0, 'usd': 195.5, 'usd_micro': 19.0})
        self.assertEqual(v['net']['alt']['trades'], 0)

    def test_at_4000(self):
        v = core.bot_view(self.RES, 4000, ['base', 'alt'])
        o2 = v['orders'][1]
        self.assertEqual((o2['t_to'], o2['status'], o2['open']), (4000, 'cancelled', False))
        self.assertEqual([o['id'] for o in v['orders']], ['o1', 'o2'])
        self.assertEqual(sorted(v['trades'][0]['exits']), ['alt', 'base'])
        self.assertEqual(len(v['trades']), 1)                                  # X2 enters at 4500

    def test_only_contract_fields_pass(self):
        text = json.dumps(core.bot_view(self.RES, 10_000, ['base']))
        for k in ('secret', 'fill_t', 'outcome', 'mfe'):
            self.assertNotIn(k, text)

    def test_nothing_after_the_clock_at_any_clock(self):
        for c in range(0, 7000, 250):
            v = core.bot_view(self.RES, c, ['base', 'alt'])
            times = [e['t'] for e in v['events']] + [o['t_from'] for o in v['orders']] + [o['t_to'] for o in v['orders']]
            times += [t['entry_t'] for t in v['trades']] + [x['exit_t'] for t in v['trades'] for x in t['exits'].values()]
            self.assertTrue(all(t <= c for t in times), c)


class Summary(unittest.TestCase):
    def trades(self):
        mk = lambda pts, r, t, lt='A', d='long': {'variant': 'V', 'level_type': lt, 'dir': d,
                                                  'exits': {'base': {'points': pts, 'r': r, 'exit_t': t}}}
        # given out of order: the equity runs in exit time order (10, -5, 2, -3)
        return [mk(2.0, 0.4, 3, 'B'), mk(10.0, 2.0, 1), mk(-3.0, -0.6, 4, 'B', 'short'), mk(-5.0, -1.0, 2),
                {'variant': 'V', 'level_type': 'A', 'dir': 'long', 'exits': {}}]           # no base exit: left out

    def test_hand_worked(self):
        rows = core.bot_summary(self.trades(), ['V'], ['base'])
        a = rows[0]
        self.assertEqual((a['variant'], a['exit_id'], a['group']), ('V', 'base', 'all'))
        # $ NQ per trade: 10*20-4.5 = 195.5, -104.5, 35.5, -64.5; MNQ: 19, -11, 3, -7
        self.assertEqual({k: a[k] for k in ('trades', 'wins', 'losses', 'win_pct', 'avg_r', 'net_points')},
                         {'trades': 4, 'wins': 2, 'losses': 2, 'win_pct': 50.0, 'avg_r': 0.2, 'net_points': 4.0})
        self.assertEqual((a['net_usd'], a['net_usd_per_trade'], a['net_usd_micro'], a['net_usd_micro_per_trade']), (62.0, 15.5, 4.0, 1.0))
        self.assertEqual(a['pf'], round(231.0 / 169.0, 2))                    # (195.5 + 35.5) / (104.5 + 64.5)
        self.assertEqual((a['max_dd_usd'], a['max_dd_usd_micro']), (133.5, 15.0))    # equity 195.5, 91, 126.5, 62; MNQ 19, 8, 11, 4
        groups = {r['group']: r for r in rows}
        self.assertEqual(set(groups), {'all', 'level_type=A', 'level_type=B', 'dir=long', 'dir=short'})
        self.assertEqual((groups['level_type=B']['trades'], groups['level_type=B']['net_usd']), (2, -29.0))
        self.assertEqual(groups['dir=short']['pf'], 0.0)                     # nothing won: 0 / 64.5
        self.assertEqual(groups['dir=long']['max_dd_usd'], 104.5)

    def test_pf_without_losses_and_empty(self):
        s = core.bot_stats([{'points': 1.0, 'r': 1.0, 'exit_t': 1}])
        self.assertIsNone(s['pf'])
        self.assertEqual(core.bot_stats([])['trades'], 0)


class BadModules(Base):
    def write(self, name, text):
        p = os.path.join(self.tmp.name, name)
        with open(p, 'w') as f:
            f.write(text)
        return p

    GOOD = ("BOT_API = 1\nNAME = 'x'\ndef variants():\n    return [{'id': 'a', 'label': 'a', 'params': {}}]\n"
            "def exit_ids():\n    return ['base']\ndef run(day, prior, params, progress=None):\n    return {'events': [], 'orders': [], 'trades': []}\n")

    def test_messages(self):
        cases = [(os.path.join(self.tmp.name, 'none.py'), 'no bot file'),
                 (self.write('syntax.py', 'def (:\n'), 'could not import syntax.py: SyntaxError'),
                 (self.write('api2.py', self.GOOD.replace('BOT_API = 1', 'BOT_API = 2')), 'BOT_API = 2; this Studio speaks BOT_API 1'),
                 (self.write('noname.py', self.GOOD.replace("NAME = 'x'", '')), 'has no NAME'),
                 (self.write('norun.py', self.GOOD.split('def run')[0]), 'has no run() function'),
                 (self.write('novar.py', self.GOOD.replace("[{'id': 'a', 'label': 'a', 'params': {}}]", '[]')), 'variants() must return'),
                 (self.write('noexit.py', self.GOOD.replace("['base']", "'base'")), 'exit_ids() must return'),
                 (self.write('boom.py', self.GOOD.replace("return ['base']", "raise RuntimeError('nope')")), 'exit_ids() failed: RuntimeError: nope')]
        for path, want in cases:
            with self.assertRaises(ms.BotError) as cm:
                ms.load_bot(path)
            self.assertIn(want, str(cm.exception), path)
        self.assertEqual(ms.load_bot(self.write('good.py', self.GOOD))['name'], 'x')

    def test_a_bad_bot_leaves_the_rest_working(self):
        st = self.studio(bot=self.write('api2.py', self.GOOD.replace('BOT_API = 1', 'BOT_API = 2')))
        info = st.bot_info()
        self.assertFalse(info['ok'])
        self.assertIn('BOT_API 1', info['error'])
        with self.assertRaisesRegex(ms.Refused, 'BOT_API'):
            st.bot_load('2026-03-05')
        self.assertEqual(st.blind_next()['clock_tod'], '10:06:00')
        self.assertIn('--bot=PATH', self.studio(bot=None).bot_info()['usage'])

    def test_a_failing_run_is_shown(self):
        st = self.studio(bot=self.write('fail.py', self.GOOD.replace("return {'events'", "raise ValueError('bad day'); return {'events'")))
        st.bot_load('2026-03-05')
        self.wait_bot(st)
        self.assertIn('ValueError: bad day', st.state()['bot_day']['error'])
        self.assertEqual(st.bot_view()['events'], [])


class BotFlow(Base):
    def test_load_view_and_the_prior_day(self):
        st = self.studio()
        s = st.bot_load('2026-03-05', 'T1000')
        self.assertEqual((s['mode'], s['date'], s['clock_tod']), ('bot', '2026-03-05', '09:30:00'))
        self.wait_bot(st)
        self.at(st, '10:01')
        v = st.bot_view()
        self.assertEqual([e['kind'] for e in v['events']], ['note', 'arm', 'fill'])
        self.assertEqual([(o['id'], o['status'], o['t_to']) for o in v['orders']],              # the open stop and target: clipped, no status
                         [('E1', 'filled', W('2026-03-05', 10, 0, 20)), ('S1', None, W('2026-03-05', 10, 1)), ('T1', None, W('2026-03-05', 10, 1))])
        self.assertEqual([(t['entry'], t['exits']) for t in v['trades']], [(21001.0, {})])
        self.assertNotIn(str(W('2026-03-05', 10, 3, 40)), json.dumps(v))       # the exit time is not sent before it happens
        self.at(st, '10:04')
        v = st.bot_view()
        self.assertEqual(v['trades'][0]['exits']['base']['points'], 10.0)
        self.assertEqual(v['net']['base']['usd'], 195.5)
        # 03-09: the prior kept day (03-05, the Day the history uses) reaches the bot
        st.bot_load('2026-03-09', 'T1000')
        self.assertEqual(st.prior_kept.date, '2026-03-05')
        self.wait_bot(st)
        self.at(st, '10:00')
        self.assertIn('prior day high 21030.00', [e['text'] for e in st.bot_view()['events']][0])

    def test_grading_and_holdout_days_refused(self):
        st = self.studio()
        with self.assertRaisesRegex(ms.Forbidden, 'grading day'):
            st.bot_load('2026-03-10')
        with self.assertRaises(core.HoldoutError):
            st.bot_load('2026-04-02')
        self.assertEqual(st.bot_day_list(), ['2026-03-05', '2026-03-09'])
        st.blind_next()
        with self.assertRaisesRegex(ms.Refused, 'blind candidate is open'):
            st.bot_load('2026-03-05')
        st.save({'setup': 'NONE'})
        st.bot_load('2026-03-05')
        with self.assertRaises(ms.Refused):
            st.save({'setup': 'NONE'})                                     # no grades from the Bot tab

    def test_http_403(self):
        st = self.studio()
        srv = ms.Server(('127.0.0.1', 0), ms.make_handler(st, 0))
        port = srv.server_address[1]
        srv.RequestHandlerClass = ms.make_handler(st, port)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            def req(method, path, body=b'{}'):
                c = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                c.putrequest(method, path, skip_host=True)
                c.putheader('Host', f'localhost:{port}')
                c.putheader('Content-Length', str(len(body)))
                c.endheaders(body if method == 'POST' else None)
                r = c.getresponse()
                out = r.status, json.loads(r.read() or b'{}')
                c.close()
                return out
            code, j = req('POST', '/api/bot/load', b'{"date":"2026-03-10"}')
            self.assertEqual(code, 403)
            self.assertIn('grading day', j['error'])
            code, j = req('POST', '/api/bot/load', b'{"date":"2026-04-02"}')
            self.assertEqual(code, 403)
            self.assertIn('holdout', j['error'])
            self.assertEqual(req('GET', '/api/bot/view')[0], 409)              # nothing loaded in the Bot tab
            self.assertEqual(req('POST', '/api/bot/load', b'{"date":"2026-03-05","variant":"T1100"}')[0], 200)
            self.assertEqual(req('GET', '/api/bot/view')[0], 200)
            self.assertEqual(req('GET', '/api/bot/days')[1]['days'], ['2026-03-05', '2026-03-09'])
        finally:
            srv.shutdown()
            srv.server_close()

    def test_run_all(self):
        st = self.studio()
        loads = []
        real = st.source.load
        st.source.load = lambda d: (loads.append(d), real(d))[1]
        st.bot_runall_start()
        for _ in range(300):
            if not st.runall['running']:
                break
            time.sleep(0.02)
        r = st.bot_runall_status()
        self.assertEqual((r['error'], r['failed'], r['k'], r['n']), ('', [], 2, 2))
        self.assertEqual(sorted(loads), ['2026-03-05', '2026-03-09'])         # each day loaded once (03-05 is also 03-09's prior)
        main = [(x['variant'], x['exit_id'], x['trades'], x['net_usd']) for x in r['rows'] if x['group'] == 'all']
        self.assertEqual(main, [('T1000', 'base', 1, 195.5), ('T1000', 't5', 1, 95.5), ('T1100', 'base', 1, -104.5), ('T1100', 't5', 1, -104.5)])
        folder = st.bot_export()['folder']
        self.assertTrue(folder.startswith(os.path.join(self.marks, 'botruns')))
        with open(os.path.join(folder, 'trades.csv')) as f:
            rows = list(csv.DictReader(f))
        self.assertEqual([(x['variant'], x['date'], x['entry_time'], x['base_points'], x['base_net_usd']) for x in rows],
                         [('T1000', '2026-03-05', '10:00:20', '10.0', '195.5'), ('T1100', '2026-03-05', '11:00:20', '-5.0', '-104.5')])
        self.assertIn('f_minutes_to_fill', rows[0])
        with open(os.path.join(folder, 'summary.json')) as f:
            js = json.load(f)
        self.assertEqual((js['bot'], js['days'], len(js['rows'])), ('Test bot', ['2026-03-05', '2026-03-09'], len(r['rows'])))
        with open(os.path.join(folder, 'summary.csv')) as f:
            self.assertEqual(len(list(csv.DictReader(f))), len(r['rows']))


if __name__ == '__main__':
    unittest.main()
