"""Markup Studio panels and housekeeping: the Builds panel (BUILDS.md of the bot's repository, read only), two Run all
results compared side by side, honest Work list progress (only the item's own queue's grades; no "of N" without a
target) and a quiet log when a client closes its connection early. Made-up sample data and a made-up BUILDS.md only.

    python3 -m unittest discover -s test -p "test_markup*.py"
"""
import contextlib
import io
import json
import os
import shutil
import socket
import struct
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
import markup_work as work  # noqa: E402
from test_markup_bot import BOT  # noqa: E402
from test_markup_trades import TBase  # noqa: E402

BUILDS = """# Builds

| Build | Branch | Commit | What it is |
|---|---|---|---|
| Made-up X1 | build-X1 | abc1234 | the first made-up build |

## At a glance
| Name | What | Status | File |
|---|---|---|---|
| X1 | Made-up **X1** code (abc1234) | Frozen | bots/made_up.py |
| X1M1 | X1, judged on its m1 exit; a long note that goes on and on so that it has to be cut short by the reader, because a panel row is one short line and not a page of text at all | The bench | |
| ES:X1M1 | X1M1 on ES, see `bots/made_up_es.py` | A look only | |
"""


class Builds(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = os.path.join(self.tmp.name, 'lab')
        os.makedirs(os.path.join(self.repo, 'bots'))
        os.makedirs(os.path.join(self.repo, '.git'))
        self.bot = os.path.join(self.repo, 'bots', 'made_up.py')
        shutil.copy(BOT, self.bot)

    def write(self, text):
        with open(os.path.join(self.repo, 'BUILDS.md'), 'w', encoding='utf-8') as f:
            f.write(text)

    def test_names_files_and_notes(self):
        self.write(BUILDS)
        self.assertEqual(core.find_builds(self.bot), os.path.join(self.repo, 'BUILDS.md'))
        rows = core.read_builds(core.find_builds(self.bot))
        self.assertEqual([r['name'] for r in rows], ['X1', 'X1M1', 'ES:X1M1'])
        self.assertEqual([r['file'] for r in rows], ['bots/made_up.py', '', 'bots/made_up_es.py'])
        self.assertEqual(rows[0]['note'], 'Made-up X1 code (abc1234)')
        self.assertTrue(rows[1]['note'].endswith('...') and len(rows[1]['note']) == 160)

    def test_the_build_table_when_there_is_no_name_table(self):
        self.write(BUILDS.split('## At a glance')[0])
        self.assertEqual([r['name'] for r in core.read_builds(os.path.join(self.repo, 'BUILDS.md'))], ['Made-up X1'])

    def test_studio_panel_and_its_refusals(self):
        def st(bot):
            s = ms.Studio.__new__(ms.Studio)                 # the panel needs the bot's path only
            s.bot_path = bot
            return s
        self.assertFalse(st(self.bot).builds()['ok'])
        self.assertIn('no BUILDS.md', st(self.bot).builds()['why'])
        self.write('# Builds\n\nnothing in a table\n')
        self.assertIn('no table', st(self.bot).builds()['why'])
        self.write(BUILDS)
        r = st(self.bot).builds()
        self.assertTrue(r['ok'])
        self.assertNotIn(self.tmp.name, json.dumps(r))      # no folder ever leaves the server
        self.assertIn('--bot', st(None).builds()['why'])

    def test_stops_at_the_repository(self):
        with open(os.path.join(self.tmp.name, 'BUILDS.md'), 'w', encoding='utf-8') as f:
            f.write(BUILDS)                                   # above the bot's repository: not its file
        self.assertIsNone(core.find_builds(self.bot))


def summary(bot, days, rows, contract=True, failed=()):
    out = {'version': 1, 'bot': bot, 'days': days, 'failed_days': list(failed), 'variants': [{'id': 'V1', 'label': 'one'}],
           'exit_ids': ['base', 'm1'], 'rows': rows}
    if contract:
        out.update(contract='NQ', micro='MNQ', rt=4.5, micro_rt=1.0)
    return out


class Compare(TBase):
    def put_run(self, stamp, s):
        d = os.path.join(self.marks, 'botruns', stamp)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, 'summary.json'), 'w', encoding='utf-8') as f:
            json.dump(s, f)

    def test_two_runs_side_by_side(self):
        rows = [{'variant': 'V1', 'exit_id': 'base', 'group': 'all', 'trades': 10, 'net_usd': 12.5},
                {'variant': 'V1', 'exit_id': 'm1', 'group': 'all', 'trades': 9, 'net_usd': -3.0},
                {'variant': 'V1', 'exit_id': 'base', 'group': 'dir=long', 'trades': 4, 'net_usd': 1.0}]
        self.put_run('20261003_164230', summary('Test bot', ['2026-03-05', '2026-03-09'], rows, failed=['2026-03-09']))
        old = [{'variant': 'V1', 'exit_id': 'base', 'group': 'all', 'trades': 7, 'net_nq': 5.0, 'net_mnq_per_trade': 0.1, 'max_dd_nq': 2.0}]
        self.put_run('20261002_100000', summary('Test bot', ['2026-03-05'], old, contract=False))
        os.makedirs(os.path.join(self.marks, 'botruns', 'not-a-run'))
        self.put_run('20261001_090000_2', 'not a summary')
        st = self.tstudio()
        runs = st.run_list()['runs']
        self.assertEqual([r['stamp'] for r in runs], ['20261003_164230', '20261002_100000'])
        self.assertEqual((runs[0]['days'], runs[0]['failed'], runs[0]['variants']), (2, 1, 1))
        c = st.bot_compare('20261003_164230', '20261002_100000')
        a, b = c['a'], c['b']
        self.assertEqual([r['exit_id'] for r in a['rows']], ['base', 'm1'])                # per exit, group "all" only
        self.assertEqual((a['trades'], a['days'], a['failed'], a['contract']), ({'V1': 10}, 2, 1, 'NQ'))
        self.assertEqual((b['rows'][0]['net_usd'], b['rows'][0]['net_usd_micro_per_trade'], b['rows'][0]['max_dd_usd']), (5.0, 0.1, 2.0))
        self.assertEqual((b['contract'], b['micro']), ('NQ', 'MNQ'))
        for bad in ('../x', '20261009_000000', None):
            with self.assertRaises(ms.Refused):
                st.bot_compare('20261003_164230', bad)

    def test_shut_while_a_trade_is_open(self):
        self.put_run('20261003_164230', summary('Test bot', [], []))
        st = self.tstudio()
        self.open_next(st)
        with self.assertRaisesRegex(ms.Refused, 'grade it first, then use run comparisons'):
            st.bot_compare('20261003_164230', '20261003_164230')


class Progress(TBase):
    def item(self, marks, **kw):
        return work.check_item(dict({'version': 1, 'id': 'x', 'title': 'X', 'status': 'stopped', 'marks': marks, 'bot': BOT,
                                     'trade_queue': self.csv, 'trade_variant': 'TM'}, **kw))

    def test_no_target_says_graded_only(self):
        st = self.tstudio()
        self.open_next(st)
        st.trades_save1({'label': 'TAKE'})
        self.assertEqual(work.progress(self.item(self.marks)), {'done': 1, 'total': None})
        self.assertEqual(work.progress(self.item(self.marks, trade_target=2)), {'done': 1, 'total': 2})
        self.assertEqual(work.progress(self.item(self.marks, trade_target=300)), {'done': 1, 'total': 3})
        self.assertEqual(work.progress(self.item(os.path.join(self.tmp.name, 'empty'))), {'done': 0, 'total': None})

    def test_only_this_queues_grades_count(self):
        st = self.tstudio()
        q = st.tq
        gdir = os.path.join(self.marks, 'trade_grades')
        os.makedirs(gdir, exist_ok=True)
        it = q['items']
        mine = {'qid': it[0]['qid'], 'trade_id': it[0]['trade_id'], 'queue_sha256': q['sha256'], 'label': 'TAKE'}
        other_sha = {'qid': it[1]['qid'], 'trade_id': it[1]['trade_id'], 'queue_sha256': 'f' * 64, 'label': 'TAKE'}
        other_id = {'qid': it[2]['qid'], 'trade_id': 'SOMETHING-ELSE', 'label': 'TAKE'}    # an old grade: no sha, another trade
        stray = {'qid': 'Q0000000000', 'trade_id': 'X1', 'queue_sha256': q['sha256'], 'label': 'TAKE'}   # not in the queue
        for g in (mine, other_sha, other_id, stray):
            with open(os.path.join(gdir, g['qid'] + '.json'), 'w', encoding='utf-8') as f:
                json.dump(g, f)
        self.assertEqual(work.progress(self.item(self.marks)), {'done': 1, 'total': None})
        out = io.StringIO()
        wd = os.path.join(self.tmp.name, 'work')
        os.makedirs(wd)
        with open(os.path.join(wd, 'x.json'), 'w', encoding='utf-8') as f:
            json.dump({k: v for k, v in self.item(self.marks).items() if k != 'kind'}, f)
        with contextlib.redirect_stdout(out):
            work.main(['list', '--work=' + wd])
        self.assertIn('(1 graded)', out.getvalue())
        self.assertNotIn(' of ', out.getvalue())


class QuietLog(unittest.TestCase):
    def setUp(self):
        self.logs, self._log = [], ms.log
        ms.log = self.logs.append
        self.addCleanup(lambda: setattr(ms, 'log', self._log))

    def handle_error_with(self, exc):
        srv = ms.Server(('127.0.0.1', 0), ms.make_handler(None, 0))
        self.addCleanup(srv.server_close)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            try:
                raise exc
            except Exception:   # noqa: BLE001 - as socketserver calls it, from inside the except block
                srv.handle_error(None, ('127.0.0.1', 5555))
        return err.getvalue()

    def test_a_client_gone_is_one_line(self):
        e = ConnectionResetError(10054, 'An existing connection was forcibly closed by the remote host')
        e.winerror = 10054
        for exc, word in ((e, 'ConnectionResetError, WinError 10054'), (BrokenPipeError(32, 'Broken pipe'), 'BrokenPipeError'),
                          (ConnectionAbortedError(), 'ConnectionAbortedError')):
            self.logs.clear()
            self.assertEqual(self.handle_error_with(exc), '')                   # no traceback
            self.assertEqual(len(self.logs), 1)
            self.assertIn(word, self.logs[0])
            self.assertNotIn('\n', self.logs[0])

    def test_anything_else_keeps_its_traceback(self):
        out = self.handle_error_with(ValueError('a real bug'))
        self.assertIn('Traceback', out)
        self.assertIn('a real bug', out)
        self.assertEqual(self.logs, [])

    def test_a_real_reset_mid_request(self):
        srv = ms.Server(('127.0.0.1', 0), ms.make_handler(None, 0))
        port = srv.server_address[1]
        srv.RequestHandlerClass = ms.make_handler(None, port)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            s = socket.create_connection(('127.0.0.1', port))
            s.sendall(b'GET /api/state HTTP/1.1\r\nHost: 127.0.0.1')     # half a request, then a reset (RST, not FIN)
            time.sleep(0.2)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
            s.close()
            t = time.monotonic()
            while not self.logs and time.monotonic() - t < 5:
                time.sleep(0.02)
        self.assertNotIn('Traceback', err.getvalue())
        self.assertEqual(len(self.logs), 1, self.logs)
        self.assertIn('closed its connection early', self.logs[0])


if __name__ == '__main__':
    unittest.main()
