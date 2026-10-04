"""Markup Studio Trades tab: only the graded trade is drawn, the listed exits' own legs, his own trade (ADJUST, or his trade
instead of a PASS) simulated by the bot's optional simulate() once the grade is complete, the opposite-side flag. Made-up
sample data and the public test bot (test/markup_bot_fixture.py, variant TM, its made-up simulate()).

2026-03-05 (test/markup_fixture.py): 21,000.00 to 10:00, up 0.25 a trade (every 5 s) to 21,012.00 at 10:04:00, flat, up to
21,013.25 at 11:00:25, down to 21,005.00 at 11:03:10, flat to the close.

    python3 -m unittest discover -s test -p "test_markup*.py"
"""
import csv
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
from test_markup_bot import BOT  # noqa: E402
from test_markup_trades import TBase, W  # noqa: E402


def read_csv(path):
    with open(path, newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))


def bot_variant(tmp, name, old, new):
    """A copy of the test bot with one change (a bot without simulate(), or without exit_orders)."""
    with open(BOT) as f:
        src = f.read()
    assert old in src, old
    path = os.path.join(tmp, name)
    with open(path, 'w') as f:
        f.write(src.replace(old, new))
    return path


class Base(TBase):
    def open_trade(self, st, tid):
        """Open trades until `tid` is the open one, grading the others TAKE (queue order: X1, X3, X2)."""
        for _ in range(3):
            self.open_next(st)
            if st.trade['item']['trade_id'] == tid:
                return
            st.trades_save1({'label': 'TAKE'})
        self.fail('trade ' + tid + ' not in the queue')

    def bar(self, st, back=60_000):
        return core.utc_to_wall(st.clock - back) / 1000            # a bar before the clock (wall seconds)

    def own_marks(self, st, entry, stop, target=None):
        b = self.bar(st)
        out = [{'role': 'Entry', 'chart': '1m', 't': b, 'price': entry}, {'role': 'Stop', 'chart': '1m', 't': b, 'price': stop}]
        if target is not None:
            out.append({'role': 'Target', 'chart': '1m', 't': b, 'price': target})
        return out

    def adjust(self, st, entry, stop, target=None, et='stop-market'):
        st.trades_save1({'label': 'ADJUST'})
        st.step()                                                   # 10:01:00 for X1
        return st.trades_save2({'entry_type': et, 'marks': self.own_marks(st, entry, stop, target)})


class OneTrade(Base):
    def test_at_the_cut_only_this_entry_order(self):
        st = self.tstudio()
        self.open_trade(st, 'X3')                                   # cut 11:01:00: D1, X1 and X2 are on the chart too
        full = core.bot_view(st.trade['res'], st.trade['cut_wall'], st.bot['exit_ids'])
        self.assertGreater(len(full['orders']), 3)
        self.assertTrue(full['trades'] and full['events'])
        v = st.trades_view()
        self.assertEqual([(o['id'], o['open'], o['status']) for o in v['orders']], [('E3', True, None)])
        self.assertEqual((v['trades'], v['events']), ([], []))

    def test_after_the_reveal_only_this_trades_legs(self):
        st = self.tstudio()
        self.open_trade(st, 'X3')
        st.trades_save1({'label': 'TAKE'})
        st.jump(minutes=10)                                         # 11:11: X2 and X3 both closed, D1 still working
        v = st.trades_view()
        self.assertEqual(sorted(o['id'] for o in v['orders']), ['E3', 'S3', 'T3'])
        self.assertEqual([t['id'] for t in v['trades']], ['X3'])
        self.assertEqual(v['events'], [])

    def test_listed_exit_draws_its_own_legs(self):
        st = self.tstudio(trade_exits=('t5',))
        self.open_trade(st, 'X1')
        st.trades_save1({'label': 'TAKE'})
        v = st.trades_view()                                        # at the cut: nothing of the fill yet
        self.assertEqual([o['id'] for o in v['orders']], ['E1'])
        st.jump(minutes=10)
        v = st.trades_view()
        self.assertEqual(sorted((o['id'], o.get('label')) for o in v['orders']),
                         [('E1', None), ('t5-S1', 't5 stop'), ('t5-T1', 't5 target')])
        self.assertEqual(sorted(o['price'] for o in v['orders'] if o['role'] != 'entry'), [20996.0, 21006.0])   # not the base 21,011.00
        self.assertEqual([(t['stop'], t['target']) for t in v['trades']], [(None, None)])                       # no primary lines

    def test_without_exit_orders_the_primary_target_is_named(self):
        bot = bot_variant(self.tmp.name, 'no_exit_orders.py', "'trades': trades, 'exit_orders': exit_orders}\n\n\nTYPES",
                          "'trades': trades}\n\n\nTYPES")
        st = self.tstudio(bot=bot, trade_exits=('t5',))
        self.open_trade(st, 'X1')
        st.trades_save1({'label': 'TAKE'})
        st.jump(minutes=10)
        v = st.trades_view()
        self.assertEqual([(o['id'], o.get('label')) for o in v['orders'] if o['role'] == 'target'], [('T1', 'bot primary target')])
        self.assertEqual([t['target_label'] for t in v['trades']], ['bot primary target'])

    def test_exit_orders_shape_checked(self):
        with self.assertRaisesRegex(ms.BotError, 'exit_orders'):
            ms.check_result({'events': [], 'orders': [], 'trades': [], 'exit_orders': {'m1': 'x'}})
        r = ms.check_result({'events': [], 'orders': [], 'trades': [], 'exit_orders': {'m1': [{'t_from': '1', 't_to': 2.0}]}})
        self.assertEqual(r['exit_orders']['m1'][0]['t_from'], 1)


class Yours(Base):
    def test_only_after_an_adjust_is_complete(self):
        st = self.tstudio()
        self.open_trade(st, 'X1')
        st.trades_save1({'label': 'ADJUST'})
        st.step()
        self.assertNotIn('yours', json.dumps([st.state(), st.trades_view()]))
        with self.assertRaises(ms.Refused):
            st.trades_result()
        st.trades_save2({'entry_type': 'stop-market', 'marks': self.own_marks(st, 21010.0, 21000.0, 21012.0)})
        path = os.path.join(self.marks, 'trade_grades', st.trade['item']['qid'] + '.adjust.json')
        with open(path, 'rb') as f:
            before = hashlib.sha256(f.read()).hexdigest()
        # hand-worked (the fixture's law): sent 10:01:00 (21,003.00), the buy stop 21,010.00 reached at 10:03:20, filled there;
        # the target 21,012.00 at 10:04:00: +2.00 points, R 10
        y = st.trades_result()['yours']
        self.assertEqual({k: y[k] for k in ('filled', 'reason', 'entry_t', 'entry', 'exit_t', 'exit', 'points', 'r', 'target', 'kind')},
                         {'filled': True, 'reason': 'target', 'entry_t': W(10, 3, 20), 'entry': 21010.0, 'exit_t': W(10, 4),
                          'exit': 21012.0, 'points': 2.0, 'r': 0.2, 'target': 21012.0, 'kind': 'adjust'})
        self.assertEqual(y['spec'], {'dir': 'long', 'entry_type': 'stop-market', 'entry': 21010.0, 'stop': 21000.0, 'target': 21012.0,
                                     't': W(10, 1)})
        self.assertIs(st.trades_result()['yours'], y)               # cached per qid
        with open(path, 'rb') as f:
            self.assertEqual(hashlib.sha256(f.read()).hexdigest(), before)    # no grade file rewritten
        # the view: his order from 10:01:00, cut at the clock as the bot's
        v = st.trades_view()
        self.assertEqual([(o['id'], o['t_from'], o['open'], o['status']) for o in v['yours_orders']], [('yours-entry', W(10, 1), True, None)])
        self.assertIsNone(v['yours_trade'])
        st.jump(minutes=2)                                          # 10:03:00: before his fill
        self.assertIsNone(st.trades_view()['yours_trade'])
        st.jump(minutes=1)                                          # 10:04:00: filled, out at the target
        v = st.trades_view()
        self.assertEqual((v['yours_trade']['entry_t'], v['yours_trade']['entry'], v['yours_trade']['exits']['yours']['exit_t']),
                         (W(10, 3, 20), 21010.0, W(10, 4)))
        self.assertEqual(sorted((o['role'], o['status']) for o in v['yours_orders']), [('entry', 'filled'), ('stop', 'cancelled'), ('target', 'filled')])
        st.yours.clear()                                            # recomputed on demand: the same (deterministic)
        self.assertEqual(json.dumps(st.trades_result()['yours'], sort_keys=True), json.dumps(y, sort_keys=True))

    def test_2r_default_flat(self):
        st = self.tstudio()
        self.open_trade(st, 'X1')
        self.adjust(st, 21010.0, 21000.0)
        y = st.trades_result()['yours']                             # 2R 21,030.00 never; flat at 16:00:00 at 21,005.00
        self.assertEqual((y['target'], y['reason'], y['exit_t'], y['exit'], y['points'], y['r']), (21030.0, 'flat', W(16), 21005.0, -5.0, -0.5))

    def test_contradictory_target(self):
        st = self.tstudio()
        self.open_trade(st, 'X1')
        self.adjust(st, 21010.0, 21000.0, 21005.0)
        self.assertEqual(st.trades_result()['yours'], {'error': 'cannot simulate (target on the losing side)', 'kind': 'adjust'})
        self.assertEqual(st.trades_view().get('yours_orders'), [])

    def test_absent_for_take_pass_and_a_bot_without_simulate(self):
        st = self.tstudio()
        self.open_next(st)
        st.trades_save1({'label': 'TAKE'})
        self.assertNotIn('yours', st.trades_result())
        self.assertNotIn('yours_orders', st.trades_view())
        self.open_next(st)
        st.trades_save1({'label': 'PASS'})
        st.trades_skip_mine()
        self.assertNotIn('yours', st.trades_result())
        bot = bot_variant(self.tmp.name, 'no_sim.py', 'def simulate(day, prior, spec):', 'def _no_simulate(day, prior, spec):')
        st = self.tstudio(bot=bot, marks=os.path.join(self.tmp.name, 'm2'))
        self.assertIsNone(st.bot['simulate'])
        self.open_trade(st, 'X1')
        self.adjust(st, 21010.0, 21000.0)
        self.assertNotIn('yours', st.trades_result())
        self.assertNotIn('yours_orders', st.trades_view())

    def test_opposite_side_adjust(self):
        st = self.tstudio()
        self.open_trade(st, 'X1')                                   # the bot is long
        st.trades_save1({'label': 'ADJUST'})
        with self.assertRaisesRegex(ms.Refused, 'Stop is at your Entry'):
            st.trades_save2({'entry_type': 'limit', 'marks': self.own_marks(st, 21000.0, 21000.0)})
        st.step()
        st.trades_save2({'entry_type': 'limit', 'marks': self.own_marks(st, 21010.0, 21020.0, 21000.0)})
        a = st.tgrades[st.trade['item']['qid']]['adjust']
        self.assertEqual((a['dir'], a['opposite_side']), ('short', True))
        self.assertEqual(st.trades_result()['yours']['spec']['dir'], 'short')
        rows = read_csv(st.trades_export()['file'])
        self.assertEqual((rows[-1]['adjust_dir'], rows[-1]['adjust_opposite_side']), ('short', 'True'))


class Instead(Base):
    def test_pass_then_my_trade_before_any_outcome(self):
        st = self.tstudio()
        self.open_trade(st, 'X1')
        qid = st.trade['item']['qid']
        st.trades_save1({'label': 'PASS'})
        s = st.state()
        self.assertEqual((s['trade']['stage'], s['trade']['complete'], s['trade_open']), (4, False, True))
        self.assertNotIn('date', s)
        self.assertTrue(st.trades_view()['frozen'])
        for f in (st.trades_result, lambda: st.play(5), lambda: st.free_load('2026-03-10')):
            with self.assertRaises(ms.Refused):
                f()
        with self.assertRaisesRegex(ms.Refused, 'ADJUST only'):
            st.trades_save2({'entry_type': 'limit', 'marks': []})
        st.step()                                                   # the candles step, as for ADJUST
        r = st.trades_save_mine({'entry_type': 'stop-market', 'marks': self.own_marks(st, 21010.0, 21000.0, 21012.0)})
        self.assertEqual((r['kind'], r['complete']), ('instead', True))
        with open(os.path.join(self.marks, 'trade_grades', qid + '.mine.json')) as f:
            rec = json.load(f)
        m = rec['mine']
        self.assertEqual((rec['kind'], m['kind'], m['after_reveal'], m['entry_type'], m['entry'], m['stop'], m['target'], m['steps_after_cut'], m['dir']),
                         ('instead', 'instead', False, 'stop-market', 21010.0, 21000.0, 21012.0, 1, 'long'))
        with open(os.path.join(self.marks, 'trade_grades', qid + '.json')) as f:
            self.assertEqual(json.load(f)['label'], 'PASS')        # stage 1 is not touched
        res = st.trades_result()
        self.assertEqual((res['label'], res['yours']['kind'], res['yours']['reason'], res['yours']['points']), ('PASS', 'instead', 'target', 2.0))
        self.assertIn('yours_orders', st.trades_view())
        for f in (lambda: st.trades_save_mine({'entry_type': 'limit', 'marks': self.own_marks(st, 1.0, 0.0)}), st.trades_skip_mine):
            with self.assertRaises(ms.Refused):
                f()
        self.assertFalse(core.write_once(os.path.join(self.marks, 'trade_grades', qid + '.mine.json'), {}))
        st2 = self.tstudio()                                        # read back: complete, his trade kept
        self.assertTrue(core.trade_grade_done(st2.tgrades[qid]))
        self.assertEqual(core.own_trade(st2.tgrades[qid])[0], 'instead')
        rows = read_csv(st.trades_export()['file'])
        row = [x for x in rows if x['qid'] == qid][0]
        self.assertEqual((row['label'], row['instead_kind'], row['instead_entry'], row['instead_after_reveal']), ('PASS', 'instead', '21010.0', 'False'))

    def test_pass_without_my_trade(self):
        st = self.tstudio()
        self.open_next(st)
        qid = st.trade['item']['qid']
        st.trades_save1({'label': 'PASS'})
        st2 = self.tstudio()                                        # a restart before the choice: the same trade, at the choice
        st2.trades_next()
        self.assertEqual((st2.trade['item']['qid'], st2.state()['trade']['stage']), (qid, 4))
        st.trades_skip_mine()
        with open(os.path.join(self.marks, 'trade_grades', qid + '.mine.json')) as f:
            self.assertEqual(json.load(f)['mine']['kind'], 'none')
        self.assertEqual(st.trades_result()['label'], 'PASS')
        # Next while the choice is open declines it too
        self.open_next(st)
        q2 = st.trade['item']['qid']
        st.trades_save1({'label': 'PASS'})
        self.open_next(st)
        self.assertNotEqual(st.trade['item']['qid'], q2)
        self.assertEqual(st.tgrades[q2]['mine']['kind'], 'none')
        # a PASS saved before "my trade instead" existed (no mine_offer) is complete as it was
        self.assertTrue(core.trade_grade_done({'label': 'PASS'}))
        self.assertFalse(core.trade_grade_done({'label': 'PASS', 'mine_offer': True, 'mine': None}))

    def test_only_after_a_pass(self):
        st = self.tstudio()
        self.open_next(st)
        with self.assertRaisesRegex(ms.Refused, 'follows a PASS'):
            st.trades_save_mine({'entry_type': 'limit', 'marks': []})
        st.trades_save1({'label': 'TAKE'})
        with self.assertRaisesRegex(ms.Refused, 'nothing to skip'):
            st.trades_skip_mine()


if __name__ == '__main__':
    unittest.main()
