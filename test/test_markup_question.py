"""Markup Studio question sets (--trade-question, on a label set): only the question's choices, one of each pair
required before T, A or P, the saved grade carries the answers, the queue records the question, and normal Trades
grading is unchanged. Made-up sample data and the public test bot only.

    python3 -m unittest discover -s test -p "test_markup*.py"
"""
import csv
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'tools'))
sys.path.insert(0, HERE)
import markup_core as core  # noqa: E402
import markup_studio as ms  # noqa: E402
import markup_work as work  # noqa: E402
from test_markup_trades import TBase, keys_of, OUTCOME_KEYS  # noqa: E402

BOTH = {'volume': 'heavy', 'speed': 'slow grind'}


class Table(unittest.TestCase):
    def test_approach_pairs_and_keys(self):
        q = core.question('approach')
        self.assertEqual(q['id'], 'approach')
        self.assertEqual([(p['id'], [c['id'] for c in p['choices']]) for p in q['pairs']],
                         [('volume', ['light', 'heavy']), ('speed', ['fast push', 'slow grind'])])
        with self.assertRaisesRegex(ValueError, 'approach'):
            core.question('nope')

    def test_choice_keys_never_clash_with_the_trades_keys(self):
        stage1 = set('TAPXN123')
        for qid, q in core.QUESTIONS.items():
            keys = [c['key'] for p in q['pairs'] for c in p['choices']]
            self.assertEqual(len(keys), len(set(keys)), qid)
            self.assertFalse(set(keys) & stage1, qid)
            self.assertTrue(all(len(k) == 1 and k.isupper() for k in keys), qid)

    def test_missing_and_answers(self):
        q = core.question('approach')
        self.assertEqual([m[0] for m in core.question_missing(q, {})], ['volume', 'speed'])
        self.assertEqual([m[0] for m in core.question_missing(q, {'volume': 'light', 'speed': 'fast'})], ['speed'])
        self.assertEqual(core.question_answers(q, dict(BOTH, extra='x')), BOTH)        # nothing else is kept
        with self.assertRaisesRegex(ValueError, r'speed into the signal \(fast push or slow grind\)'):
            core.question_answers(q, {'volume': 'light'})


class QuestionSet(TBase):
    def qstudio(self, **kw):
        return self.tstudio(trade_labels_only=True, trade_question='approach', **kw)

    def test_refused_without_both_answers(self):
        st = self.qstudio()
        self.open_next(st)
        for ans in (None, {}, {'volume': 'heavy'}, {'speed': 'fast push'}, {'volume': 'loud', 'speed': 'fast push'}):
            with self.assertRaisesRegex(ms.Refused, 'answer every question first'):
                st.trades_save1({'label': 'TAKE', 'answers': ans})
        with self.assertRaisesRegex(ms.Refused, 'volume into the signal \\(light or heavy\\)'):
            st.trades_save1({'label': 'PASS', 'answers': {'speed': 'slow grind'}})
        self.assertEqual(st._tstage(), 1)                    # nothing was saved
        self.assertFalse(os.path.exists(os.path.join(self.marks, 'trade_grades', st.trade['item']['qid'] + '.json')))

    def test_saved_grade_has_both_answers(self):
        st = self.qstudio()
        self.open_next(st)
        qid = st.trade['item']['qid']
        st.trades_save1({'label': 'TAKE', 'answers': dict(BOTH, extra='dropped'), 'confidence': 2})
        with open(os.path.join(self.marks, 'trade_grades', qid + '.json'), encoding='utf-8') as f:
            g = json.load(f)
        self.assertEqual((g['question'], g['answers'], g['confidence'], g['label']), ('approach', BOTH, 2, 'TAKE'))
        with open(os.path.join(self.marks, 'trade_grades_log.jsonl'), encoding='utf-8') as f:
            self.assertEqual(json.loads(f.readline())['answers'], BOTH)
        res = st.trades_result()
        self.assertEqual(res['answers'], BOTH)
        self.assertTrue(res['hidden'])
        self.assertFalse(keys_of(res) & ({'exits', 'date', 'trade_id', 'yours'} | OUTCOME_KEYS))
        dest = st.trades_export()['file']
        with open(dest, newline='', encoding='utf-8') as f:
            row = next(csv.DictReader(f))
        self.assertEqual((row['question'], row['answer_volume'], row['answer_speed']), ('approach', 'heavy', 'slow grind'))

    def test_confidence_stays_optional(self):
        st = self.qstudio()
        self.open_next(st)
        st.trades_save1({'label': 'PASS', 'answers': {'volume': 'light', 'speed': 'fast push'}})
        st.trades_skip_mine()
        self.assertTrue(st._tdone())
        self.assertIsNone(st.tgrades[st.trade['item']['qid']]['confidence'])

    def test_info_names_the_question_for_the_page(self):
        st = self.qstudio()
        info = st.trades_info()
        self.assertTrue(info['labels_only'])
        self.assertEqual(info['question']['id'], 'approach')
        self.assertEqual([p['label'] for p in info['question']['pairs']], ['Volume into the signal', 'Speed into the signal'])

    def test_the_queue_records_the_question(self):
        self.qstudio()
        with open(self.qfile(), encoding='utf-8') as f:
            q = json.load(f)
        self.assertEqual((q['question'], q['labels_only']), ('approach', True))
        with self.assertRaisesRegex(ms.TradeQueueError, 'trade-question=approach'):
            self.tstudio(trade_labels_only=True)             # the same set without its question
        os.remove(self.qfile())
        self.tstudio(trade_labels_only=True)                 # a label set written without one
        with self.assertRaisesRegex(ms.TradeQueueError, 'without a question'):
            self.qstudio()

    def test_bad_flags_refused(self):
        with self.assertRaisesRegex(ms.TradeQueueError, 'trade-labels-only'):
            self.tstudio(trade_question='approach')          # results shown and a required question: not a thing
        with self.assertRaisesRegex(ms.TradeQueueError, 'no question'):
            self.tstudio(trade_labels_only=True, trade_question='nope')

    def test_normal_trades_unchanged(self):
        st = self.tstudio()
        self.open_next(st)
        self.assertIsNone(st.trades_info()['question'])
        st.trades_save1({'label': 'TAKE', 'chips': ['weak volume into level']})   # no answers needed
        g = st.tgrades[st.trade['item']['qid']]
        self.assertNotIn('answers', g)
        self.assertNotIn('question', g)
        self.assertEqual(g['chips'], ['weak volume into level'])
        self.assertIn('exits', st.trades_result())
        with open(self.qfile(), encoding='utf-8') as f:
            self.assertNotIn('question', json.load(f))

    def test_a_plain_label_set_still_takes_chips(self):
        st = self.tstudio(trade_labels_only=True)
        self.open_next(st)
        st.trades_save1({'label': 'TAKE', 'chips': ['fast move into level']})
        self.assertEqual(st.trades_result()['chips'], ['fast move into level'])


class WorkItem(unittest.TestCase):
    def item(self, **kw):
        return dict({'version': 1, 'id': 'set-2', 'title': 'Set 2', 'status': 'active', 'marks': 'M', 'bot': 'b.py',
                     'trade_queue': 'q.csv', 'trade_labels_only': True, 'trade_question': 'approach'}, **kw)

    def test_checked(self):
        self.assertEqual(work.check_item(self.item())['kind'], 'labels')
        with self.assertRaisesRegex(work.WorkError, 'trade_labels_only'):
            work.check_item(self.item(trade_labels_only=False))
        with self.assertRaisesRegex(work.WorkError, 'no question'):
            work.check_item(self.item(trade_question='nope'))
        with self.assertRaisesRegex(work.WorkError, 'trade_question needs a trade queue'):
            work.check_item(self.item(trade_queue=None, bot=None, trade_labels_only=False))

    def test_flag_and_item_flag(self):
        self.assertEqual(work.FLAG_KEYS['trade-question'], 'trade_question')
        self.assertIn('trade-question', ms.ITEM_FLAGS)


if __name__ == '__main__':
    unittest.main()
