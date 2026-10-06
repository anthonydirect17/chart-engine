"""Markup Studio label sets (--trade-labels-only): the grade saves as usual, the result never shows (no exits, no date,
no trade of his), the clock never leaves the cut while a set trade is open, and the queue records that it is a label
set so a later start cannot show results by leaving the flag off (or the reverse).

    python3 -m unittest discover -s test -p "test_markup*.py"
"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'tools'))
sys.path.insert(0, HERE)
import markup_studio as ms  # noqa: E402
from test_markup_trades import TBase, keys_of, OUTCOME_KEYS  # noqa: E402


class LabelSet(TBase):
    def test_grade_saves_and_nothing_of_the_outcome_shows(self):
        st = self.tstudio(trade_labels_only=True)
        self.open_next(st)
        clock = st.clock
        for f in (st.step, lambda: st.play(5), lambda: st.jump(minutes=5)):
            with self.assertRaisesRegex(ms.Refused, 'clock stays at the cut'):
                f()
        self.assertEqual(st.clock, clock)
        st.trades_save1({'label': 'PASS', 'chips': ['strong volume into level', 'slow grind into level']})
        r = st.trades_skip_mine()                            # no "my trade instead": the grade is complete
        self.assertTrue(r['complete'])
        res = st.trades_result()
        self.assertEqual(res, {'qid': st.trade['item']['qid'], 'label': 'PASS', 'hidden': True,
                               'chips': ['strong volume into level', 'slow grind into level']})
        self.assertFalse(keys_of(res) & ({'exits', 'date', 'trade_id', 'yours', 'entry', 'stop'} | OUTCOME_KEYS))
        s = st.state()
        self.assertNotIn('date', s)
        self.assertTrue(s['labels_only'])
        for f in (st.step, lambda: st.play(5)):
            with self.assertRaisesRegex(ms.Refused, 'clock stays at the cut'):
                f()
        self.assertEqual(st.clock, clock)
        self.assertFalse(st.t_revealed)

    def test_adjust_marks_at_the_cut(self):
        st = self.tstudio(trade_labels_only=True)
        self.open_next(st)
        st.trades_save1({'label': 'ADJUST', 'chips': ['weak volume into level']})
        with self.assertRaisesRegex(ms.Refused, 'clock stays at the cut'):
            st.step()
        self.assertNotIn('yours', st.trades_result() if st._tdone() else {})

    def test_the_queue_remembers_it_is_a_label_set(self):
        self.tstudio(trade_labels_only=True)
        with open(self.qfile(), encoding='utf-8') as f:
            self.assertTrue(json.load(f)['labels_only'])
        with self.assertRaisesRegex(ms.TradeQueueError, 'label set'):
            self.tstudio()                                   # the same marks folder without the flag
        os.remove(self.qfile())
        self.tstudio()                                       # a results queue
        with self.assertRaisesRegex(ms.TradeQueueError, 'results shown'):
            self.tstudio(trade_labels_only=True)

    def test_without_the_flag_nothing_changes(self):
        st = self.tstudio()
        self.open_next(st)
        st.trades_save1({'label': 'TAKE'})
        res = st.trades_result()
        self.assertIn('exits', res)
        self.assertIn('date', res)
        st.step()                                            # a normal queue still replays after the save
        with open(self.qfile(), encoding='utf-8') as f:
            self.assertNotIn('labels_only', json.load(f))


if __name__ == '__main__':
    unittest.main()
