"""Markup Studio per symbol (NQ and ES): the instrument table, dollars per symbol, the day split's symbol guard, the hello's
instrument, the holdout on ES days, and NQ dollars unchanged. Made-up sample data (test/markup_fixture.py) and the public
test bot (test/markup_bot_fixture.py) only.

    python3 -m unittest discover -s test -p "test_markup*.py"
"""
import csv
import json
import os
import re
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'tools'))
sys.path.insert(0, HERE)
import markup_core as core  # noqa: E402
import markup_studio as ms  # noqa: E402
import markup_fixture  # noqa: E402

RULE = os.path.join(HERE, '..', 'tools', 'markup_rule_v0.json')
BOT = os.path.join(HERE, 'markup_bot_fixture.py')


class Instruments(unittest.TestCase):
    def test_the_table(self):
        self.assertEqual(core.instrument('NQ'), {'symbol': 'NQ', 'tick': 0.25, 'point_value': 20.0, 'rt': 4.5, 'micro': 'MNQ',
                                                 'micro_point_value': 2.0, 'micro_rt': 1.0})
        self.assertEqual(core.instrument('ES'), {'symbol': 'ES', 'tick': 0.25, 'point_value': 50.0, 'rt': 4.5, 'micro': 'MES',
                                                 'micro_point_value': 5.0, 'micro_rt': 1.0})
        self.assertEqual(core.instrument(' es ')['symbol'], 'ES')
        self.assertEqual(core.STUDIO_SYMBOLS, ('ES', 'NQ'))
        self.assertEqual(core.contracts('ES'), {'symbol': 'ES', 'contract': 'ES', 'micro': 'MES', 'point_value': 50.0, 'rt': 4.5,
                                                'micro_point_value': 5.0, 'micro_rt': 1.0})

    def test_unknown_symbol_fails_loudly(self):
        for bad in ('CL', '', None, 'MNQ', 'MES'):              # a micro is priced, not replayed: the Studio runs NQ or ES
            with self.assertRaisesRegex(ValueError, r'unknown symbol .*ES or NQ'):
                core.instrument(bad)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        with self.assertRaisesRegex(ValueError, 'unknown symbol'):
            ms.Studio(ms.NpzSource(tmp.name, 'CL'), os.path.join(tmp.name, 'marks'), RULE, [], 'CL')
        self.assertFalse(os.path.exists(os.path.join(tmp.name, 'marks')))             # refused before touching the folder
        with self.assertRaises(SystemExit) as cm:
            ms.main(['--symbol=CL', '--source=npz', '--data=' + tmp.name, '--marks=' + tmp.name, '--no-browser'])
        self.assertIn("unknown symbol 'CL'", str(cm.exception.code))
        self.assertIn('ES or NQ', str(cm.exception.code))

    def test_already_seen_defaults_are_nq_only(self):
        self.assertEqual(ms.default_seen('ES'), [])                            # NQ events match by date and time, not price
        self.assertTrue(ms.default_seen('NQ'))

    def test_the_page_assumes_no_symbol(self):
        """The page takes the root, header, tick and dollar labels from the server: no NQ in its code."""
        with open(os.path.join(HERE, '..', 'live', 'markup.js'), encoding='utf-8') as f:
            js = re.sub(r'/\*.*?\*/|//[^\n]*', '', f.read(), flags=re.S)
        with open(os.path.join(HERE, '..', 'live', 'markup.html'), encoding='utf-8') as f:
            html = re.sub(r'<!--.*?-->', '', f.read(), flags=re.S)
        for text in (js, html):
            self.assertIsNone(re.search(r'\b(M?NQ|M?ES)\b|4\.50|\$20\b', text))


class Dollars(unittest.TestCase):
    def test_es_hand_worked(self):
        # +37.5 points: ES 37.5 x $50 = $1,875 gross less the $4.50 round trip; MES 37.5 x $5 = $187.50 less $1.00
        self.assertEqual(37.5 * core.INSTRUMENTS['ES']['point_value'], 1875.0)
        self.assertEqual(37.5 * core.INSTRUMENTS['MES']['point_value'], 187.5)
        self.assertEqual(core.trade_cost(37.5, 'ES'), 1875.0 - core.INSTRUMENTS['ES']['rt'])
        self.assertEqual(core.trade_cost(37.5, 'ES'), 1870.5)
        self.assertEqual(core.trade_cost(37.5, 'MES'), 186.5)
        s = core.bot_stats([{'points': 37.5, 'r': 1.5, 'exit_t': 1}, {'points': -10.0, 'r': -1.0, 'exit_t': 2}], 'ES')
        self.assertEqual((s['net_usd'], s['net_usd_micro']), (1870.5 - 504.5, 186.5 - 51.0))
        self.assertEqual((s['max_dd_usd'], s['max_dd_usd_micro'], s['pf']), (504.5, 51.0, round(1870.5 / 504.5, 2)))
        v = core.bot_view({'trades': [{'id': 'X', 'entry_t': 1, 'exits': {'base': {'exit_t': 2, 'points': 37.5}}}]}, 5, ['base'], 'ES')
        self.assertEqual(v['net']['base'], {'trades': 1, 'points': 37.5, 'usd': 1870.5, 'usd_micro': 186.5})
        self.assertEqual((v['symbol'], v['contract'], v['micro'], v['point_value'], v['rt']), ('ES', 'ES', 'MES', 50.0, 4.5))

    def test_nq_identical_to_before(self):
        """Pinned with the formula before per-symbol support: NQ points x 20 - 4.50 a trade, MNQ points x 2 - 1.00."""
        pins = {10.0: (195.5, 19.0), -5.0: (-104.5, -11.0), 37.5: (745.5, 74.0), 0.25: (0.5, -0.5), -12.75: (-259.5, -26.5), 0.0: (-4.5, -1.0)}
        for p, (nq, mnq) in pins.items():
            self.assertEqual((core.trade_cost(p), core.trade_cost(p, 'NQ'), core.trade_cost(p, 'MNQ')), (nq, nq, mnq), p)
        rows = [{'points': p, 'r': 0.0, 'exit_t': k} for k, p in enumerate(pins)]
        s = core.bot_stats(rows)
        self.assertEqual(s, core.bot_stats(rows, 'NQ'))
        self.assertEqual((s['net_usd'], s['net_usd_micro']), (round(sum(v[0] for v in pins.values()), 2), round(sum(v[1] for v in pins.values()), 2)))
        self.assertEqual((s['net_usd'], s['net_usd_micro'], s['max_dd_usd'], s['max_dd_usd_micro']), (573.0, 54.0, 264.0, 28.0))
        self.assertEqual(core.contracts('NQ')['micro'], 'MNQ')


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = os.path.join(self.tmp.name, 'data')
        self.marks = os.path.join(self.tmp.name, 'marks')
        markup_fixture.write(self.data)
        markup_fixture.write(self.data, 'ES')
        self.logs = []
        self._log = ms.log
        ms.log = self.logs.append

    def tearDown(self):
        ms.log = self._log
        self.tmp.cleanup()

    def studio(self, symbol, bot=None, scan=True):
        st = ms.Studio(ms.NpzSource(self.data, symbol), self.marks, RULE, [], symbol, bot_path=bot)
        if scan:
            st.start_scan(background=False)
        return st

    @property
    def split_file(self):
        return os.path.join(self.marks, 'bot_split_v1.json')

    def put_split(self, sp):
        os.makedirs(self.marks, exist_ok=True)
        with open(self.split_file, 'w') as f:
            json.dump(sp, f)
        with open(self.split_file) as f:
            return f.read()

    def split_text(self):
        with open(self.split_file) as f:
            return f.read()


LEGACY = {'version': 1, 'seed': 7, 'bot': ['2026-03-05', '2026-03-09'], 'grading': ['2026-03-10']}


class SplitGuard(Base):
    def test_new_split_records_the_symbol(self):
        st = self.studio('ES', scan=False)
        self.assertEqual(json.loads(self.split_text()), dict(LEGACY, symbol='ES'))
        self.assertEqual((st.bot_days, st.grading_days), ({'2026-03-05', '2026-03-09'}, {'2026-03-10'}))
        self.studio('ES', scan=False)                                         # matching: read back as it is
        self.assertEqual(json.loads(self.split_text()), dict(LEGACY, symbol='ES'))

    def test_another_symbols_split_is_refused(self):
        for have, run in (('NQ', 'ES'), ('ES', 'NQ')):
            before = self.put_split(dict(LEGACY, symbol=have))
            with self.assertRaisesRegex(ValueError, f'is for {have}, not {run}: give {run} its own marks folder'):
                self.studio(run, scan=False)
            self.assertEqual(self.split_text(), before)                      # never rewritten
        with self.assertRaises(SystemExit) as cm:
            ms.main(['--symbol=NQ', '--source=npz', '--data=' + self.data, '--marks=' + self.marks, '--no-browser', '--port=1'])
        self.assertIn('cannot use the marks folder', str(cm.exception.code))
        self.assertIn('is for ES, not NQ', str(cm.exception.code))

    def test_legacy_split_is_nq(self):
        before = self.put_split(LEGACY)
        st = self.studio('NQ', scan=False)
        self.assertEqual(st.grading_days, {'2026-03-10'})
        self.assertEqual(self.split_text(), before)
        self.assertFalse(any('names no symbol' in x for x in self.logs))

    def test_legacy_split_accepted_for_es_when_every_day_is_an_es_day(self):
        before = self.put_split(LEGACY)
        st = self.studio('ES', scan=False)
        self.assertEqual((st.bot_days, st.grading_days), ({'2026-03-05', '2026-03-09'}, {'2026-03-10'}))
        self.assertEqual(self.split_text(), before)                          # not rewritten, no symbol added
        self.assertTrue(any('names no symbol' in x and 'taken as the ES split' in x for x in self.logs), self.logs)

    def test_legacy_split_refused_for_es_when_a_day_is_not_an_es_day(self):
        before = self.put_split(dict(LEGACY, bot=['2026-03-05', '2026-03-06', '2026-03-09']))
        with self.assertRaisesRegex(ValueError, r'1 of its days are not ES days \(e\.g\. 2026-03-06\): give ES its own marks folder'):
            self.studio('ES', scan=False)
        self.assertEqual(self.split_text(), before)

    def test_legacy_split_refused_when_the_folder_names_another_symbol(self):
        before = self.put_split(LEGACY)
        with open(os.path.join(self.marks, 'candidates_v1.json'), 'w') as f:
            json.dump({'version': ms.CACHE_VERSION, 'symbol': 'ES', 'days': {}, 'items': []}, f)
        with self.assertRaisesRegex(ValueError, 'names no symbol and the folder holds ES grades or candidates'):
            self.studio('NQ', scan=False)                                    # an ES folder (marks_ES) run as NQ by mistake
        self.studio('ES', scan=False)                                        # and as ES: its own
        os.remove(os.path.join(self.marks, 'candidates_v1.json'))
        core.save_grade(self.marks, {'id': 'C1', 'symbol': 'NQ'})
        with self.assertRaisesRegex(ValueError, 'holds NQ grades'):
            self.studio('ES', scan=False)
        self.assertEqual(self.split_text(), before)

    def test_an_es_folder_and_an_nq_folder_side_by_side(self):
        self.studio('NQ', scan=False)
        self.marks = os.path.join(self.tmp.name, 'marks_ES')
        self.studio('ES', scan=False)
        self.assertEqual(json.loads(self.split_text())['symbol'], 'ES')


class EsStudio(Base):
    def test_holdout_on_es_days(self):
        src = ms.NpzSource(self.data, 'ES')
        self.assertTrue(os.path.exists(os.path.join(self.data, 'ES_2026-04-02.npz')))
        self.assertEqual(src.days(), ['2026-03-05', '2026-03-09', '2026-03-10'])
        with self.assertRaises(core.HoldoutError):
            src.load('2026-04-02')
        st = self.studio('ES', bot=BOT)
        self.assertTrue(st.candidates and all(core.in_sample(c['date']) for c in st.candidates))
        self.assertNotIn('2026-04-02', json.dumps(st.split))
        for call in (lambda: st.free_load('2026-04-02'), lambda: st.bot_load('2026-04-02'), lambda: st.bot_day_ok('2026-04-02')):
            with self.assertRaises(core.HoldoutError):
                call()
        self.assertEqual(st.bot_day_list(), ['2026-03-05', '2026-03-09'])

    def test_es_candidates_hello_and_grade(self):
        st = self.studio('ES')
        self.assertEqual((st.symbol, st.tick), ('ES', 0.25))
        self.assertEqual([c['id'] for c in st.candidates], ['C20260310PDH100510'])
        self.assertLess(st.candidates[0]['level_price'], 6000)                # the ES fixture's prices, not NQ's
        sent = []

        class C:
            def send(self, m):
                sent.append(m)

            def close(self):
                pass
        st.ws_open(C())
        self.assertEqual(sent[0]['instruments'], [{'root': 'ES', 'name': 'ES replay', 'tick': 0.25, 'pointValue': 50.0}])
        st.blind_next()
        st.save({'setup': 'NONE'})
        self.assertEqual(st.grades[-1]['symbol'], 'ES')
        dest, n = core.export_csv(self.marks)
        with open(dest) as f:
            self.assertEqual([r['symbol'] for r in csv.DictReader(f)], ['ES'])

    def test_es_bot_view_and_run_all(self):
        st = self.studio('ES', bot=BOT)
        self.assertEqual((st.bot_info()['contract'], st.bot_info()['micro']), ('ES', 'MES'))
        st.bot_load('2026-03-05', 'T1000')
        for _ in range(200):
            if st.state().get('bot_day', {}).get('status') != 'running':
                break
            time.sleep(0.02)
        st.clock = ms.clock_of('2026-03-05', '10:04')
        v = st.bot_view()
        self.assertEqual((v['symbol'], v['contract'], v['micro']), ('ES', 'ES', 'MES'))
        self.assertEqual(v['trades'][0]['entry'], 6001.0)
        self.assertEqual(v['net']['base'], {'trades': 1, 'points': 10.0, 'usd': 495.5, 'usd_micro': 49.0})   # 10 x 50 - 4.50; 10 x 5 - 1
        st.bot_runall_start()
        for _ in range(300):
            if not st.runall['running']:
                break
            time.sleep(0.02)
        r = st.bot_runall_status()
        self.assertEqual((r['error'], r['contract'], r['micro'], r['rt'], r['micro_rt']), ('', 'ES', 'MES', 4.5, 1.0))
        main = [(x['variant'], x['exit_id'], x['net_usd'], x['net_usd_micro']) for x in r['rows'] if x['group'] == 'all']
        self.assertEqual(main, [('T1000', 'base', 495.5, 49.0), ('T1000', 't5', 245.5, 24.0), ('T1100', 'base', -254.5, -26.0),
                                ('T1100', 't5', -254.5, -26.0), ('TM', 'base', 511.5, 49.5), ('TM', 't5', 236.5, 22.0)])
        folder = st.bot_export()['folder']
        with open(os.path.join(folder, 'trades.csv')) as f:
            rows = list(csv.DictReader(f))
        self.assertEqual([(x['symbol'], x['micro'], x['variant'], x['base_net_usd'], x['base_net_usd_micro']) for x in rows],
                         [('ES', 'MES', 'T1000', '495.5', '49.0'), ('ES', 'MES', 'T1100', '-254.5', '-26.0'), ('ES', 'MES', 'TM', '495.5', '49.0'),
                          ('ES', 'MES', 'TM', '-254.5', '-26.0'), ('ES', 'MES', 'TM', '270.5', '26.5')])
        self.assertFalse([k for k in rows[0] if 'nq' in k.lower()])
        with open(os.path.join(folder, 'summary.csv')) as f:
            srows = list(csv.DictReader(f))
        self.assertTrue(srows and all(x['symbol'] == 'ES' and x['micro'] == 'MES' for x in srows))
        self.assertIn('net_usd_micro', srows[0])
        with open(os.path.join(folder, 'summary.json')) as f:
            js = json.load(f)
        self.assertEqual({k: js[k] for k in ('symbol', 'contract', 'micro', 'point_value', 'rt', 'micro_point_value', 'micro_rt', 'costs')},
                         {'symbol': 'ES', 'contract': 'ES', 'micro': 'MES', 'point_value': 50.0, 'rt': 4.5, 'micro_point_value': 5.0,
                          'micro_rt': 1.0, 'costs': {'ES': {'per_point': 50.0, 'round_trip': 4.5}, 'MES': {'per_point': 5.0, 'round_trip': 1.0}}})

    def test_nq_summary_costs_as_before(self):
        st = self.studio('NQ', bot=BOT)
        st.bot_runall_start()
        for _ in range(300):
            if not st.runall['running']:
                break
            time.sleep(0.02)
        with open(os.path.join(st.bot_export()['folder'], 'summary.json')) as f:
            js = json.load(f)
        self.assertEqual(js['costs'], {'NQ': {'per_point': 20.0, 'round_trip': 4.5}, 'MNQ': {'per_point': 2.0, 'round_trip': 1.0}})
        self.assertEqual([(x['variant'], x['exit_id'], x['net_usd'], x['net_usd_micro']) for x in js['rows'] if x['group'] == 'all'],
                         [('T1000', 'base', 195.5, 19.0), ('T1000', 't5', 95.5, 9.0), ('T1100', 'base', -104.5, -11.0), ('T1100', 't5', -104.5, -11.0),
                          ('TM', 'base', 196.5, 18.0), ('TM', 't5', 86.5, 7.0)])


if __name__ == '__main__':
    unittest.main()
