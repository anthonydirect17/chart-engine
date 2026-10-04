"""Markup Studio Trades tab unit tests: the queue (written once), the cut at the bot's entry order, the two-stage grade, the
reveal, the skipped days, the second opinion and the locks. Made-up sample data, the public test bot
(test/markup_bot_fixture.py, variant TM) and small synthetic trades.csv files written here only.

    python3 -m unittest discover -s test -p "test_markup*.py"
"""
import csv
import http.client
import json
import os
import random
import sys
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'tools'))
sys.path.insert(0, HERE)
import markup_core as core  # noqa: E402
import markup_studio as ms  # noqa: E402
from test_markup_bot import Base, BOT, RULE  # noqa: E402

D = '2026-03-05'
W = lambda hh, mm=0, ss=0, d=D: core.wall_of(d, hh, mm, ss)
# the test bot's TM trades on 2026-03-05 (markup_bot_fixture): id, dir, entry order placed, fill, entry, stop
TM = [('X1', 'long', W(10), W(10, 0, 20), 21001.0, 20996.0),
      ('X2', 'long', W(11), W(11, 0, 20), 21013.0, 21008.0),
      ('X3', 'short', W(11, 1), W(11, 1, 20), 21010.5, 21015.5)]
OUTCOME_KEYS = {'net', 'usd', 'usd_micro', 'wins', 'losses', 'win_pct', 'pf', 'avg_r', 'net_points', 'tally', 'by_label', 'net_usd'}


def row(variant, d, tid, dirn, entry_t, entry, stop, style='usd'):
    r = {'variant': variant, 'date': d, 'id': tid, 'level_type': 'time', 'level_price': entry, 'dir': dirn,
         'entry_time': core.fmt_tod(entry_t), 'entry_t': entry_t, 'entry': entry, 'stop': stop, 'target': '', 'target_kind': '2R',
         'base_exit_t': entry_t + 60_000, 'base_exit': entry, 'base_reason': 'flat', 'base_points': 0.0, 'base_r': 0.0}
    if style == 'usd':
        r = dict({'symbol': 'NQ', 'micro': 'MNQ'}, **r, base_net_usd=-4.5, base_net_usd_micro=-1.0)
    else:                                                        # a run from before ES support: nq columns, no symbol
        r = dict(r, base_net_nq=-4.5, base_net_mnq=-1.0)
    return r


def good_rows(style='usd'):
    out = [row('TM', D, tid, dirn, ft, e, s, style) for tid, dirn, _, ft, e, s in TM]
    out.append(row('T1000', D, 'X1', 'long', W(10, 0, 20), 21001.0, 20996.0, style))            # another variant
    out.append(row('TM', '2026-03-10', 'X9', 'long', W(10, 0, 0, '2026-03-10'), 1.0, 0.0, style))  # a grading day
    out.append(row('TM', '2026-04-02', 'X8', 'long', W(10, 0, 0, '2026-04-02'), 1.0, 0.0, style))  # the holdout
    out.append(row('TM', '2026-03-11', 'X7', 'long', W(10, 0, 0, '2026-03-11'), 1.0, 0.0, style))  # not in the split
    return out


def write_csv(path, rows):
    cols = []
    for r in rows:
        cols += [k for k in r if k not in cols]
    with open(path, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    return path


def keys_of(x, out=None):
    out = set() if out is None else out
    if isinstance(x, dict):
        for k, v in x.items():
            out.add(k)
            keys_of(v, out)
    elif isinstance(x, list):
        for v in x:
            keys_of(v, out)
    return out


class TBase(Base):
    def setUp(self):
        super().setUp()
        self.csv = write_csv(os.path.join(self.tmp.name, 'trades.csv'), good_rows())

    def tearDown(self):
        for st in getattr(self, '_studios', []):       # a prefetch still loading a day holds its file (Windows cannot delete it)
            rec = getattr(st, 'tprep', None)
            if rec:
                rec['done'].wait(10)
        super().tearDown()

    def tstudio(self, csv_path=None, variant='TM', bot=BOT, marks=None, **kw):
        st = ms.Studio(ms.NpzSource(self.data, 'NQ'), marks or self.marks, RULE, [], 'NQ', bot_path=bot,
                       trade_queue=csv_path or self.csv, trade_variant=variant, **kw)
        st.start_scan(background=False)
        self._studios = getattr(self, '_studios', []) + [st]
        return st

    def qfile(self):
        return os.path.join(self.marks, 'trade_queue_v1.json')

    def open_next(self, st):
        s = st.trades_next()
        self.assertEqual(s['mode'], 'trades')
        return s


class Queue(TBase):
    def test_written_once_deterministic_and_bot_days_only(self):
        st = self.tstudio()
        with open(self.qfile()) as f:
            text = f.read()
        q = json.loads(text)
        self.assertEqual({k: q[k] for k in ('version', 'symbol', 'variant', 'seed', 'skip_days')},
                         {'version': 1, 'symbol': 'NQ', 'variant': 'TM', 'seed': 11, 'skip_days': []})
        self.assertEqual(q['sha256'], core.read_trades_csv(self.csv)[1])
        self.assertEqual(q['source'], os.path.abspath(self.csv))
        # hand-worked: the bot days' TM rows sorted by (date, entry time, id), shuffled with random.Random(11)
        want = [x[0] for x in TM]
        random.Random(11).shuffle(want)
        self.assertEqual([it['trade_id'] for it in q['items']], want)
        self.assertEqual({it['date'] for it in q['items']}, {D})              # no grading day, holdout or day outside the split
        for it in q['items']:
            self.assertRegex(it['qid'], r'^Q[0-9a-f]{10}$')
        self.assertEqual(st.trade_counts(), {'total': 3, 'target': 300, 'graded': 0, 'adjusted': 0, 'skipped': 0, 'skipped_days': 0,
                                             'refused': 0, 'remaining': 3})
        self.tstudio()                                                       # a restart reads it back, byte for byte the same
        with open(self.qfile()) as f:
            self.assertEqual(f.read(), text)
        other = os.path.join(self.tmp.name, 'marks2')                       # another folder: the same queue
        st2 = ms.Studio(ms.NpzSource(self.data, 'NQ'), other, RULE, [], 'NQ', bot_path=BOT, trade_queue=self.csv, trade_variant='TM')
        self.assertEqual(st2.tq['items'], q['items'])

    def test_refuses_changed_flags(self):
        self.tstudio()
        with open(self.qfile()) as f:
            text = f.read()
        for kw, word in ((dict(variant='T1000'), 'variant'), (dict(trade_seed=12), 'seed'),
                         (dict(trade_skip_days=['2026-03-05']), 'skip_days')):
            with self.assertRaises(ms.TradeQueueError) as cm:
                self.tstudio(**kw)
            self.assertIn(word, str(cm.exception))
            self.assertIn('disagrees with the flags', str(cm.exception))
        changed = write_csv(os.path.join(self.tmp.name, 'other.csv'), good_rows()[:2])
        with self.assertRaisesRegex(ms.TradeQueueError, 'sha256'):
            self.tstudio(csv_path=changed)
        with self.assertRaisesRegex(ms.TradeQueueError, "variant: the file has 'TM', the flags give 'T1000'"):
            self.tstudio(variant=None)                                       # no variant given: the bot's first, T1000
        with open(self.qfile()) as f:
            self.assertEqual(f.read(), text)                                # never rewritten
        # the command line stops with the message
        with self.assertRaises(SystemExit) as cm:
            ms.main(['--source=npz', '--data=' + self.data, '--marks=' + self.marks, '--bot=' + BOT, '--trade-queue=' + self.csv,
                     '--trade-variant=TM', '--trade-seed=5', '--no-browser', '--port=0'])
        self.assertIn('the Trades tab cannot start', str(cm.exception))
        self.assertIn('seed', str(cm.exception))

    def test_skip_days_flag_and_holdout(self):
        st = self.tstudio(trade_skip_days=['2026-03-05'])
        self.assertEqual(st.tq['items'], [])
        with self.assertRaisesRegex(ms.Refused, 'no trades left'):
            st.trades_next()
        # the holdout is out even when a split names it (core.trade_queue checks in_sample itself)
        rows = good_rows()
        items = core.trade_queue(rows, 'x', 'TM', {D, '2026-04-02'})
        self.assertEqual({it['date'] for it in items}, {D})

    def test_old_nq_style_csv(self):
        old = write_csv(os.path.join(self.tmp.name, 'old.csv'), good_rows('nq'))
        st = self.tstudio(csv_path=old)
        self.assertEqual(len(st.tq['items']), 3)
        self.assertEqual(st.trades_next()['trade']['dir'] in ('long', 'short'), True)

    def test_bad_flags(self):
        with self.assertRaisesRegex(ms.TradeQueueError, 'no variant'):
            self.tstudio(variant='NOPE')
        with self.assertRaisesRegex(ms.TradeQueueError, 'cannot read'):
            self.tstudio(csv_path=os.path.join(self.tmp.name, 'none.csv'))
        st = ms.Studio(ms.NpzSource(self.data, 'NQ'), self.marks, RULE, [], 'NQ', bot_path=None, trade_queue=self.csv)
        self.assertFalse(st.trades_info()['ok'])
        with self.assertRaisesRegex(ms.Refused, 'bot did not load'):
            st.trades_next()


class EntryOrderRule(unittest.TestCase):
    T = {'id': 'X', 'dir': 'long', 'entry_t': 100, 'entry': 10.0}

    def o(self, oid, t_from, t_to=100, price=10.0, side='buy', status='filled', role='entry', limit=None):
        return {'id': oid, 'side': side, 'type': 'stop', 'role': role, 'price': price, 'limit': limit, 't_from': t_from, 't_to': t_to, 'status': status}

    def test_one_working_filled_entry_order(self):
        res = {'orders': [self.o('a', 50), self.o('b', 10, 40, status='expired'), self.o('c', 60, side='sell'), self.o('s', 100, 200, role='stop')]}
        o, how = core.entry_order_of(res, self.T)
        self.assertEqual(o['id'], 'a')
        self.assertIn('one filled entry order', how)

    def test_the_trade_names_it(self):
        res = {'orders': [self.o('a', 50), self.o('b', 70)]}
        self.assertEqual(core.entry_order_of(res, dict(self.T, entry_order='b'))[0]['id'], 'b')
        with self.assertRaisesRegex(ValueError, 'names entry order z'):
            core.entry_order_of(res, dict(self.T, entry_order='z'))

    def test_several_ties_broken_exactly_or_refused(self):
        res = {'orders': [self.o('a', 50), self.o('b', 70), self.o('c', 80, price=10.25)]}
        self.assertEqual(core.entry_order_of(res, self.T)[0]['id'], 'b')     # at the fill price, ending at the fill, placed last
        res = {'orders': [self.o('a', 70), self.o('b', 70)]}
        with self.assertRaisesRegex(ValueError, 'do not single one out'):
            core.entry_order_of(res, self.T)
        res = {'orders': [self.o('a', 70, price=9.0), self.o('b', 60, price=9.5)]}   # slipped: no price match
        with self.assertRaisesRegex(ValueError, 'do not single one out'):
            core.entry_order_of(res, self.T)

    def test_none_or_filled_at_placement(self):
        with self.assertRaisesRegex(ValueError, 'no filled entry order'):
            core.entry_order_of({'orders': [self.o('a', 50, status='cancelled')]}, self.T)
        with self.assertRaisesRegex(ValueError, 'no moment before the fill'):
            core.entry_order_of({'orders': [self.o('a', 100)]}, self.T)


class Cut(TBase):
    def leaks(self, st):
        """What reached the API at the cut that should not: ticks at or after the clock, bot times after the cut, this
        trade or its fill, an open order's status, the date."""
        bad = []
        t = st.trade
        if st.vis().utc.size and int(st.vis().utc[-1]) >= st.clock:
            bad.append('a tick at or after the clock')
        v, s = st.trades_view(), st.state()
        c = t['cut_wall']
        times = [e['t'] for e in v['events']] + [o['t_from'] for o in v['orders']] + [o['t_to'] for o in v['orders']]
        times += [x['entry_t'] for x in v['trades']] + [e['exit_t'] for x in v['trades'] for e in x['exits'].values()]
        bad += [f'time {x} after the cut' for x in times if x > c]
        if any(x['entry_t'] == t['trade']['entry_t'] for x in v['trades']):
            bad.append('this trade')
        if any(o['open'] and o['status'] for o in v['orders']):
            bad.append('an open order with its status')
        text = json.dumps([v, s])
        for word in (D, D.replace('-', ''), str(t['trade']['entry_t'])):
            if word in text:
                bad.append('names ' + word)
        return bad

    def test_cut_is_the_entry_orders_t_from_and_nothing_after(self):
        st = self.tstudio()
        order = [it['trade_id'] for it in st.tq['items']]
        by_id = {x[0]: x for x in TM}
        for k in range(3):
            self.open_next(st)
            tid = st.trade['item']['trade_id']
            self.assertEqual(tid, order[k])
            self.assertEqual(st.trade['order']['id'], 'E' + tid[1])
            self.assertEqual(st.clock, int(core.wall_to_utc([by_id[tid][2]])[0]))       # the entry order's t_from
            self.assertEqual(st.state()['clock_tod'], core.fmt_tod(by_id[tid][2]))
            v = st.trades_view()
            entry = [o for o in v['orders'] if o['role'] == 'entry' and o['t_from'] == by_id[tid][2]]
            self.assertEqual([(o['open'], o['status']) for o in entry], [(True, None)])
            self.assertEqual(self.leaks(st), [])
            st.trades_save1({'label': 'PASS'})
        # a server that cuts one tick late: the check catches it
        st2 = self.tstudio(marks=os.path.join(self.tmp.name, 'mutant'))
        real = ms.visible_count
        try:
            ms.visible_count = lambda day, clock, exclusive=False: min(len(day.utc), real(day, clock, exclusive) + 1)
            st2.trades_next()
            self.assertTrue(self.leaks(st2))
        finally:
            ms.visible_count = real

    def test_view_frozen_at_the_cut_while_adjusting(self):
        st = self.tstudio()
        self.open_next(st)
        cut = st.trade['cut_wall']
        with self.assertRaisesRegex(ms.Refused, 'stage 1 is graded at the cut'):
            st.step()
        st.trades_save1({'label': 'ADJUST'})
        for _ in range(3):
            st.step()
        v = st.trades_view()
        self.assertTrue(v['frozen'])
        self.assertEqual(v['clock_wall_ms'], cut)
        self.assertEqual(self.leaks(st)[:1], [])  # nothing of the bot after the cut, though the ticks moved on

    def test_bot_mismatch_refused(self):
        rows = good_rows()
        rows[0] = dict(rows[0], entry=21001.25)                              # one tick off
        rows[1] = dict(rows[1], entry_t=rows[1]['entry_t'] + 1)              # one ms off
        rows.append(row('TM', '2026-03-09', 'X1', 'long', W(10, 0, 20, '2026-03-09'), 20000.0, 19995.0))   # the bot trades no last-only day
        for k, want in ((0, 'entry differ'), (1, 'entry_t differ'), (-1, 'has 0 trades with the queued id')):
            path = write_csv(os.path.join(self.tmp.name, f'bad{k}.csv'), [rows[k]])
            marks = os.path.join(self.tmp.name, f'm{k}')
            st = ms.Studio(ms.NpzSource(self.data, 'NQ'), marks, RULE, [], 'NQ', bot_path=BOT, trade_queue=path, trade_variant='TM')
            with self.assertRaises(ms.TradeMismatch) as cm:
                st.trades_next()
            self.assertIn('the bot loaded is not the one that wrote the queue', str(cm.exception))
            self.assertIn(want, str(cm.exception))
            self.assertIsNone(st.trade)
            self.assertNotEqual(st.mode, 'trades')                          # nothing was opened

    def test_unlinkable_trade_passed_over(self):
        # a bot whose X1 fills the moment its order is placed: X1 cannot be graded, X2 opens
        with open(BOT) as f:
            src = f.read()
        src = src.replace("'t_from': t0, 't_to': tj, 'status': 'filled'",
                                       "'t_from': tj if n == 1 else t0, 't_to': tj, 'status': 'filled'")
        bot = os.path.join(self.tmp.name, 'instant.py')
        with open(bot, 'w') as f:
            f.write(src)
        path = write_csv(os.path.join(self.tmp.name, 'two.csv'), good_rows()[:2])
        st = self.tstudio(csv_path=path, bot=bot)
        s = st.trades_next()
        self.assertEqual(st.trade['item']['trade_id'], 'X2')
        self.assertEqual(len(s['passed_over']), 1)
        self.assertIn('no moment before the fill', s['passed_over'][0])
        self.assertEqual(st.trade_counts()['refused'], 1)


class Grading(TBase):
    def test_take_immutable_then_reveal(self):
        st = self.tstudio()
        self.open_next(st)
        qid, tid = st.trade['item']['qid'], st.trade['item']['trade_id']
        with self.assertRaisesRegex(ms.Refused, 'once the grade is saved'):
            st.trades_result()
        with self.assertRaisesRegex(ms.Refused, 'TAKE, ADJUST or PASS'):
            st.trades_save1({'label': 'MAYBE'})
        with self.assertRaisesRegex(ms.Refused, 'confidence'):
            st.trades_save1({'label': 'TAKE', 'confidence': 4})
        r = st.trades_save1({'label': 'TAKE', 'chips': ['clean reclaim close'], 'reason': 'liked it', 'confidence': 2})
        self.assertEqual((r['complete'], r['label']), (True, 'TAKE'))
        with self.assertRaisesRegex(ms.Refused, 'saved already'):
            st.trades_save1({'label': 'PASS'})
        with self.assertRaisesRegex(ms.Refused, 'graded already'):
            st.trades_skip_day()
        with self.assertRaisesRegex(ms.Refused, 'ADJUST only'):
            st.trades_save2({'entry_type': 'limit', 'marks': []})
        with open(os.path.join(self.marks, 'trade_grades', qid + '.json')) as f:
            g = json.load(f)
        self.assertEqual({k: g[k] for k in ('qid', 'trade_id', 'date', 'symbol', 'bot', 'variant', 'label', 'chips', 'reason', 'confidence')},
                         {'qid': qid, 'trade_id': tid, 'date': D, 'symbol': 'NQ', 'bot': 'Test bot', 'variant': 'TM', 'label': 'TAKE',
                          'chips': ['clean reclaim close'], 'reason': 'liked it', 'confidence': 2})
        self.assertEqual(g['queue_sha256'], st.tq['sha256'])
        cut = g['at_cut']
        self.assertEqual((cut['entry_order']['type'], cut['stop'], cut['target']), ('stop', None, None))   # the test bot shows no bracket before the fill
        self.assertFalse(keys_of(g) & ({'exits', 'points', 'r', 'exit_t', 'entry_t'} | OUTCOME_KEYS))
        with open(os.path.join(self.marks, 'trade_grades_log.jsonl')) as f:
            self.assertEqual(len(f.read().strip().split('\n')), 1)
        res = st.trades_result()
        self.assertEqual((res['date'], res['trade_id'], res['label']), (D, tid, 'TAKE'))
        self.assertEqual([x['id'] for x in res['exits']], ['base', 't5'])
        self.assertEqual(st.state()['date'], D)
        # the file is never written twice, even by a second Studio
        st2 = self.tstudio()
        self.assertTrue(core.trade_grade_done(st2.tgrades[qid]))
        self.assertFalse(core.write_once(os.path.join(self.marks, 'trade_grades', qid + '.json'), {'qid': qid}))

    def test_trade_exits_limit_the_result_and_the_view(self):
        with self.assertRaisesRegex(ms.TradeQueueError, 'does not have'):
            self.tstudio(trade_exits=('m1',))
        st = self.tstudio(trade_exits=('t5',))
        self.open_next(st)
        st.trades_save1({'label': 'PASS'})
        st.trades_skip_mine()                                               # no trade of his own: the result shows
        self.assertEqual([x['id'] for x in st.trades_result()['exits']], ['t5'])
        v = st.trades_view()
        self.assertEqual(v['exit_ids'], ['t5'])
        self.assertTrue(all(set(t.get('exits') or {}) <= {'t5'} for t in v['trades']))

    def test_adjust_two_stages(self):
        st = self.tstudio()
        self.open_next(st)
        qid = st.trade['item']['qid']
        st.trades_save1({'label': 'ADJUST'})
        self.assertTrue(st.trade_open())
        with self.assertRaisesRegex(ms.Refused, 'once the grade is saved'):
            st.trades_result()
        with self.assertRaises(ms.Refused):
            st.play(5)
        st.step()
        st.step()
        self.assertEqual(st.state()['steps'], 2)
        bar = core.utc_to_wall(st.clock - 120_000) / 1000                  # a bar before the clock (wall seconds)
        with self.assertRaisesRegex(ms.Refused, 'Entry and Stop'):
            st.trades_save2({'entry_type': 'stop-limit', 'marks': [{'role': 'Entry', 't': bar, 'price': 21002.0}]})
        with self.assertRaisesRegex(ms.Refused, 'entry type'):
            st.trades_save2({'entry_type': 'iceberg', 'marks': []})
        late = core.utc_to_wall(st.clock + 60_000) / 1000
        with self.assertRaisesRegex(ms.Refused, 'after the clock'):
            st.trades_save2({'entry_type': 'limit', 'marks': [{'role': 'Entry', 't': late, 'price': 1.0}, {'role': 'Stop', 't': bar, 'price': 1.0}]})
        marks = [{'role': 'Entry', 'chart': '1m', 't': bar, 'price': 21002.0}, {'role': 'Stop', 'chart': '1m', 't': bar, 'price': 20997.0}]
        r = st.trades_save2({'entry_type': 'stop-market', 'marks': marks})
        self.assertTrue(r['complete'])
        with self.assertRaisesRegex(ms.Refused, 'saved already'):
            st.trades_save2({'entry_type': 'stop-market', 'marks': marks})
        with open(os.path.join(self.marks, 'trade_grades', qid + '.adjust.json')) as f:
            a = json.load(f)['adjust']
        self.assertEqual({k: a[k] for k in ('entry_type', 'entry', 'stop', 'target', 'steps_after_cut')},
                         {'entry_type': 'stop-market', 'entry': 21002.0, 'stop': 20997.0, 'target': None, 'steps_after_cut': 2})
        self.assertEqual([(m['role'], m['bar_time_utc_ms']) for m in a['marks']], [('Entry', st.clock - 120_000), ('Stop', st.clock - 120_000)])
        self.assertEqual(st.trades_result()['label'], 'ADJUST')
        self.assertEqual(st.play(5)['playing'], True)                       # the reveal plays on
        st.pause()
        dest, n = st.trades_export()['file'], st.trades_export()['rows']
        with open(dest) as f:
            rows = list(csv.DictReader(f))
        self.assertEqual((n, rows[0]['label'], rows[0]['adjust_entry_type'], rows[0]['steps_after_cut'], rows[0]['adjust_stop']),
                         (1, 'ADJUST', 'stop-market', '2', '20997.0'))
        self.assertFalse(set(rows[0]) & ({'points', 'r', 'exit', 'reason_exit', 'base_points'} | OUTCOME_KEYS))
        self.assertEqual(st.trade_counts()['adjusted'], 1)

    def test_resume_same_trade_same_cut(self):
        st = self.tstudio()
        self.open_next(st)
        qid, clock = st.trade['item']['qid'], st.clock
        st2 = self.tstudio()                                                 # restarted before grading it
        st2.trades_next()
        self.assertEqual((st2.trade['item']['qid'], st2.clock, st2.trade['n']), (qid, clock, 1))
        st2.trades_save1({'label': 'ADJUST'})
        st2.step()
        st3 = self.tstudio()                                                 # restarted between the stages: stage 2 again, at the cut
        st3.trades_next()
        self.assertEqual((st3.trade['item']['qid'], st3.clock, st3.state()['trade']['stage'], st3.state()['trade']['label']), (qid, clock, 2, 'ADJUST'))
        self.assertEqual(st3.trades_next()['trade']['qid'], qid)             # Next while it is open: the same trade

    def test_skip_day(self):
        st = self.tstudio()
        self.open_next(st)
        s = st.trades_skip_day()
        self.assertFalse(s['loaded'])
        self.assertNotIn(D, json.dumps(s))
        with open(os.path.join(self.marks, 'trade_skip_days.json')) as f:
            self.assertEqual([x['date'] for x in json.load(f)['days']], [D])
        self.assertEqual({k: st.trade_counts()[k] for k in ('skipped', 'skipped_days', 'remaining', 'graded')},
                         {'skipped': 3, 'skipped_days': 1, 'remaining': 0, 'graded': 0})
        with self.assertRaisesRegex(ms.Refused, 'no trades left'):
            st.trades_next()
        self.assertEqual(self.tstudio().trade_counts()['remaining'], 0)    # kept across a restart
        self.assertEqual(os.listdir(os.path.join(self.marks)).count('trade_grades'), 0)   # nothing else recorded

    def test_prefetch(self):
        st = self.tstudio()
        a = st.trades_next()
        self.assertFalse(a['prefetched'])
        st.trades_save1({'label': 'PASS'})
        b = st.trades_next()
        self.assertTrue(b['prefetched'])
        print(f'\n  open a trade (fixture): cold {a["open_ms"]} ms, prefetched {b["open_ms"]} ms', file=sys.stderr)

    def test_counts_only_no_tally(self):
        st = self.tstudio()
        seen = [st.trades_info(), self.open_next(st), st.state(), st.trades_view()]
        seen.append(st.trades_save1({'label': 'TAKE'}))
        seen += [st.trades_result(), st.trades_next(), st.trades_save1({'label': 'ADJUST'})]
        st.step()
        bar = core.utc_to_wall(st.clock - 60_000) / 1000
        seen.append(st.trades_save2({'entry_type': 'limit', 'marks': [{'role': 'Entry', 't': bar, 'price': 1.0}, {'role': 'Stop', 't': bar, 'price': 0.5}]}))
        seen += [st.state(), st.trades_info(), st.trades_view()]
        self.assertEqual(set(st.trade_counts()), {'total', 'target', 'graded', 'adjusted', 'skipped', 'skipped_days', 'refused', 'remaining'})
        for x in seen:
            ks = keys_of(x)
            self.assertFalse(ks & OUTCOME_KEYS, ks & OUTCOME_KEYS)
            self.assertFalse(ks & set(core.TRADE_LABELS))                  # nothing keyed by a label


class SecondOpinion(TBase):
    def notes(self, rows, name='notes.csv'):
        return write_csv(os.path.join(self.tmp.name, name), rows)

    def test_only_after_the_save_and_recorded(self):
        secret = 'liquidity, "grabbed" then reclaimed'
        path = self.notes([{'trade_id': 'X1', 'variant': 'TM', 'note': secret, 'score': '0.5'},
                           {'trade_id': 'X2', 'variant': 'TM', 'note': 'x2 note', 'score': '7'}])
        st = self.tstudio(trade_notes=path)
        self.assertTrue(st.trades_info()['notes'])
        self.assertTrue(any('not a number from -1 to 1' in x for x in self.logs))
        for _ in range(3):
            s = self.open_next(st)
            tid = st.trade['item']['trade_id']
            before = json.dumps([s, st.state(), st.trades_view(), st.trades_info()])
            self.assertNotIn(secret, before)
            self.assertNotIn('x2 note', before)
            st.trades_save1({'label': 'PASS'})
            self.assertNotIn(secret, json.dumps([st.state(), st.trades_view()]))   # not while "my trade instead" is open
            st.trades_skip_mine()
            res = st.trades_result()
            g = st.tgrades[st.trade['item']['qid']]['second_opinion']
            if tid == 'X1':
                self.assertEqual(res['second_opinion'], {'note': secret, 'score': 0.5})
                self.assertEqual((g['found'], g['score'], g['note_sha256']), (True, 0.5, core.hashlib.sha256(secret.encode()).hexdigest()))
            elif tid == 'X2':
                self.assertEqual(res['second_opinion'], {'note': 'x2 note', 'score': None})
            else:
                self.assertIsNone(res['second_opinion'])                    # the page says "no second opinion for this trade"
                self.assertEqual((g['found'], g['note_sha256']), (False, None))
            self.assertEqual(g['notes_file_sha256'], st.notes_sha)
        # a changed notes file: logged, the Studio goes on
        self.notes([{'trade_id': 'X1', 'variant': 'TM', 'note': 'new'}])
        self.logs.clear()
        st2 = self.tstudio(trade_notes=path)
        self.assertTrue(any('has changed since the last grade' in x for x in self.logs))
        self.assertTrue(st2.trades_info()['ok'])


class Locks(TBase):
    def serve(self, st):
        srv = ms.Server(('127.0.0.1', 0), ms.make_handler(st, 0))
        port = srv.server_address[1]
        srv.RequestHandlerClass = ms.make_handler(st, port)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (srv.shutdown(), srv.server_close()))

        def req(method, path, body=b'{}'):
            c = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
            c.putrequest(method, path, skip_host=True)
            c.putheader('Host', f'localhost:{port}')
            c.putheader('Content-Length', str(len(body)))
            c.endheaders(body if method == 'POST' else None)
            r = c.getresponse()
            out = r.status, json.loads(r.read() or b'{}')
            c.close()
            return out
        return req

    def test_free_bot_and_reveal_locked_while_a_trade_is_open(self):
        st = self.tstudio()
        req = self.serve(st)
        self.assertEqual(req('GET', '/api/trades/result')[0], 409)          # nothing open
        code, s = req('POST', '/api/trades/next')
        self.assertEqual(code, 200)
        self.assertTrue(s['trade_open'])
        self.assertNotIn(D, json.dumps(s))
        refused = [('GET', '/api/trades/result', b''), ('POST', '/api/reveal', b'{}'), ('POST', '/api/play', b'{"speed":5}'),
                   ('POST', '/api/jump', b'{"minutes":30}'), ('GET', '/api/machine', b''), ('POST', '/api/step', b'{}'),
                   ('POST', '/api/free/load', b'{"date":"2026-03-10"}'), ('POST', '/api/bot/load', b'{"date":"2026-03-05"}'),
                   ('GET', '/api/bot/days', b''), ('POST', '/api/bot/runall', b'{}'), ('POST', '/api/blind/next', b'{}'),
                   ('POST', '/markup/save', b'{"setup":"NONE"}'), ('POST', '/api/trades/save2', b'{}')]
        for method, path, body in refused:
            code, j = req(method, path, body)
            self.assertEqual(code, 409, path)
            self.assertNotIn(D, json.dumps(j))
        self.assertIn('trade is open', req('POST', '/api/free/load', b'{"date":"2026-03-10"}')[1]['error'])
        self.assertEqual(req('POST', '/api/trades/save1', b'{"label":"TAKE"}')[0], 200)
        self.assertEqual(req('GET', '/api/trades/result')[1]['date'], D)
        self.assertEqual(req('POST', '/api/reveal')[0], 200)
        self.assertEqual(req('POST', '/api/pause')[0], 200)
        self.assertEqual(req('GET', '/api/bot/days')[0], 200)
        self.assertEqual(req('POST', '/api/free/load', b'{"date":"2026-03-10"}')[0], 200)

    def test_trades_shut_while_a_blind_candidate_is_open(self):
        st = self.tstudio()
        st.blind_next()
        with self.assertRaisesRegex(ms.Refused, 'blind candidate is open'):
            st.trades_next()


if __name__ == '__main__':
    unittest.main()
