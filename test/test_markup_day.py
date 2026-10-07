"""Markup Studio Day tab: U, D or C called at the replay clock on days already graded or seen, in a hash-chained
append-only log (day_calls.jsonl in the marks folder): the chain is checked on load and before every append, a changed,
missing or reordered row stops the tab, calls stamped after the clock stay hidden, the date never shows. Made-up sample
data only.

    python3 -m unittest discover -s test -p "test_markup*.py"
"""
import hashlib
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'tools'))
sys.path.insert(0, HERE)
import markup_core as core  # noqa: E402
import markup_studio as ms  # noqa: E402
from test_markup_bot import Base, RULE  # noqa: E402

GD = '2026-03-10'        # the fixture's grading day (bot days 2026-03-05 and 2026-03-09)


class Chain(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, core.DAY_LOG)

    def write(self, n=3):
        rows = []
        for i in range(n):
            core.append_day_row(self.path, rows, {'date': GD, 'call': 'UDC'[i % 3], 'clock_wall_ms': 1000 * i})
        return rows

    def lines(self):
        with open(self.path, encoding='utf-8') as f:
            return f.read().splitlines()

    def put(self, lines):
        with open(self.path, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines) + '\n')

    def test_hand_worked_chain(self):
        rows = self.write(2)
        r1, r2 = (json.loads(x) for x in self.lines())
        self.assertEqual((r1['seq'], r1['prev_hash']), (1, '0' * 64))
        body = {k: v for k, v in r1.items() if k != 'row_hash'}
        want = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        self.assertEqual(r1['row_hash'], want)
        self.assertEqual((r2['seq'], r2['prev_hash']), (2, r1['row_hash']))
        self.assertEqual(core.read_day_log(self.path), rows)
        self.assertEqual(core.read_day_log(os.path.join(self.tmp.name, 'none.jsonl')), [])

    def test_tamper_detected(self):
        self.write(3)
        good = self.lines()
        cases = {
            'changed': lambda L: [L[0], L[1].replace('"call":"D"', '"call":"U"'), L[2]],
            'rehashed alone': lambda L: [L[0], rehash(L[1], call='U'), L[2]],
            'missing': lambda L: [L[0], L[2]],
            'reordered': lambda L: [L[1], L[0], L[2]],
            'not json': lambda L: [L[0], '{oops', L[2]],
            'dropped first': lambda L: L[1:],
        }
        for name, f in cases.items():
            with self.subTest(name):
                self.put(f(list(good)))
                with self.assertRaises(core.DayLogError) as cm:
                    core.read_day_log(self.path)
                self.assertRegex(str(cm.exception), 'line [12]')
        self.put(good[:2])                                   # the last line cut off: what is left still chains
        self.assertEqual(len(core.read_day_log(self.path)), 2)

    def test_in_force_is_the_latest_at_or_before_the_clock(self):
        rows = []
        for call, t in (('U', 5000), ('C', 9000), ('D', 7000)):
            core.append_day_row(self.path, rows, {'date': GD, 'call': call, 'clock_wall_ms': t})
        self.assertIsNone(core.call_in_force(rows, GD, 4999))
        self.assertEqual(core.call_in_force(rows, GD, 7500)['call'], 'D')      # by clock, not by file order
        self.assertEqual(core.call_in_force(rows, GD, 9000)['call'], 'C')
        self.assertEqual([r['call'] for r in core.calls_upto(rows, GD, 8000)], ['U', 'D'])
        self.assertIsNone(core.call_in_force(rows, '2026-03-05', 10 ** 9))


def rehash(line, **change):
    r = json.loads(line)
    r.update(change)
    r['row_hash'] = core.row_hash(r)
    return json.dumps(r)


class DayTab(Base):
    def dstudio(self, graded=True, seen=(), marks=None):
        marks = marks or self.marks
        if graded:
            core.save_grade(marks, {'id': 'C1', 'mode': 'blind', 'date': GD, 'setup': 'NONE'})
        st = ms.Studio(ms.NpzSource(self.data, 'NQ'), marks, RULE, list(seen), 'NQ')
        st.start_scan(background=False)
        return st

    def log_path(self):
        return os.path.join(self.marks, core.DAY_LOG)

    def test_offers_graded_days_only_without_dates(self):
        st = self.dstudio()
        r = st.day_days()
        self.assertEqual(len(r['days']), 1)
        d = r['days'][0]
        self.assertEqual((d['n'], d['graded'], d['seen'], d['calls']), (1, True, False, 0))
        self.assertRegex(d['ref'], r'^D[0-9a-f]{10}$')
        self.assertNotIn(GD, json.dumps(r))
        other = os.path.join(self.tmp.name, 'marks-none')
        self.assertEqual(self.dstudio(graded=False, marks=other).day_days()['days'], [])   # nothing graded or seen: no day

    def test_seen_days_are_offered_and_bot_days_never(self):
        seen = os.path.join(self.tmp.name, 'seen.csv')
        with open(seen, 'w', encoding='utf-8') as f:
            f.write('date,level_type,reclaim\n2026-03-10,PDH,10:00:00\n2026-03-05,PDL,10:00:00\n')
        st = self.dstudio(graded=False, seen=[seen])
        days = st.day_days()['days']
        self.assertEqual([(d['graded'], d['seen']) for d in days], [(False, True)])   # 03-05 is a bot day: not offered
        with self.assertRaisesRegex(ms.Refused, 'no such day'):
            st.day_open(st._day_ref('2026-03-05'))

    def test_call_stamped_by_the_server_and_chained(self):
        st = self.dstudio()
        ref = st.day_days()['days'][0]['ref']
        s = st.day_open(ref)
        self.assertEqual(s['mode'], 'day')
        self.assertNotIn('date', s)
        self.assertEqual(s['day_ref'], ref)
        st.clock = ms.clock_of(GD, '10:15')
        v = st.day_call({'call': 'u', 'confidence': 2, 'words': ' trend  day ', 'clock_utc_ms': 1, 'date': '2026-01-01'})
        self.assertEqual(v['in_force']['call'], 'U')
        self.assertEqual(v['in_force']['clock_tod'], '10:15:00')
        self.assertNotIn(GD, json.dumps(v))
        st.clock = ms.clock_of(GD, '17:05')
        st.day_call({'call': 'C'})
        rows = core.read_day_log(self.log_path())
        self.assertEqual([r['seq'] for r in rows], [1, 2])
        r1, r2 = rows
        self.assertEqual((r1['date'], r1['call'], r1['confidence'], r1['words'], r1['clock_utc_ms'], r1['scored'], r1['seen_before']),
                         (GD, 'U', 2, 'trend day', ms.clock_of(GD, '10:15'), True, True))
        self.assertEqual((r2['call'], r2['confidence'], r2['scored']), ('C', None, False))       # after the close: not scored
        self.assertEqual(st.day_days()['counts'], {'calls': 2, 'days': 1, 'scored': 1})
        for bad, word in (({'call': 'X'}, 'U \\(up\\)'), ({'call': 'U', 'confidence': 5}, 'confidence')):
            with self.assertRaisesRegex(ms.Refused, word):
                st.day_call(bad)
        with self.assertRaisesRegex(ms.Refused, 'saves calls only'):
            st.save({'setup': 'NONE'})

    def test_later_calls_stay_hidden_until_the_clock_reaches_them(self):
        st = self.dstudio()
        ref = st.day_days()['days'][0]['ref']
        st.day_open(ref)
        st.clock = ms.clock_of(GD, '14:00')
        st.day_call({'call': 'D'})
        st.day_open(ref)                                     # the day again, from 09:30
        self.assertEqual(st.day_view()['calls'], [])
        st.clock = ms.clock_of(GD, '11:00')
        st.day_call({'call': 'U'})
        self.assertEqual([c['call'] for c in st.day_view()['calls']], ['U'])
        st.clock = ms.clock_of(GD, '14:00')
        v = st.day_view()
        self.assertEqual([c['call'] for c in v['calls']], ['U', 'D'])
        self.assertEqual(v['in_force']['call'], 'D')

    def test_no_call_without_a_day_open(self):
        st = self.dstudio()
        with self.assertRaisesRegex(ms.Refused, 'no day open'):
            st.day_call({'call': 'U'})
        self.assertFalse(st.day_view()['open'])

    def test_tamper_stops_the_tab_on_load_and_before_an_append(self):
        st = self.dstudio()
        ref = st.day_days()['days'][0]['ref']
        st.day_open(ref)
        st.clock = ms.clock_of(GD, '10:00')
        st.day_call({'call': 'U'})
        st.day_call({'call': 'D'})
        with open(self.log_path(), encoding='utf-8') as f:
            lines = f.read().splitlines()
        with open(self.log_path(), 'w', encoding='utf-8') as f:
            f.write(lines[0].replace('"call":"U"', '"call":"C"') + '\n' + lines[1] + '\n')
        with self.assertRaisesRegex(ms.Refused, 'stopped: .*line 1 was changed'):
            st.day_call({'call': 'C'})                       # checked again before the append: nothing appended
        with open(self.log_path(), encoding='utf-8') as f:
            self.assertEqual(len(f.read().splitlines()), 2)
        for f in (st.day_days, st.day_view, lambda: st.day_open(ref)):
            with self.assertRaisesRegex(ms.Refused, 'Day tab is stopped'):
                f()
        st2 = self.dstudio(graded=False)                     # a fresh start: refused on load, the rest works
        self.assertIn('line 1 was changed', st2.day_error)
        self.assertTrue(any('Day tab stopped' in x for x in self.logs))
        with self.assertRaisesRegex(ms.Refused, 'Day tab is stopped'):
            st2.day_days()
        self.assertIn('mode', st2.state())

    def test_shut_while_a_blind_candidate_is_open(self):
        st = self.dstudio()
        ref = st.day_days()['days'][0]['ref']
        st.mode, st.day, st.graded = 'blind', object(), False
        with self.assertRaisesRegex(ms.Refused, 'save its grade first, then use the Day tab'):
            st.day_open(ref)


if __name__ == '__main__':
    unittest.main()
