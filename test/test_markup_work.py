"""Markup Studio work list (--work, tools/markup_work.py): the item files are checked and offered, one item is open at a
time, leaving it is refused while a grade is open (the same lock as Free and the Bot tab), a failed open changes nothing,
the last item opens again at start, the list shows counts and no paths, and only GET /api/work is shared with another
origin (The Desk). Made-up sample data and the public test bot only.

    python3 -m unittest discover -s test -p "test_markup*.py"
"""
import http.client
import io
import json
import os
import sys
import threading
import unittest
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'tools'))
sys.path.insert(0, HERE)
import markup_studio as ms  # noqa: E402
import markup_work as work  # noqa: E402
from test_markup_bot import BOT  # noqa: E402
from test_markup_trades import TBase  # noqa: E402

DESK = 'https://desk.example.com'


class Items(unittest.TestCase):
    def item(self, **kw):
        return dict({'version': 1, 'id': 'set-a', 'title': 'Set A', 'status': 'active', 'marks': '/m'}, **kw)

    def test_kinds_and_tabs(self):
        self.assertEqual(work.check_item(self.item())['kind'], 'sweeps')
        self.assertEqual(work.check_item(self.item(bot='/b.py', tab='bot'))['kind'], 'bot')
        self.assertEqual(work.check_item(self.item(bot='/b.py', trade_queue='/q.csv'))['kind'], 'trades')
        it = work.check_item(self.item(bot='/b.py', trade_queue='/q.csv', trade_labels_only=True, trade_target=30))
        self.assertEqual(it['kind'], 'labels')
        self.assertEqual(work.start_tab(it), 'trades')
        self.assertEqual(work.start_tab(self.item()), 'blind')

    def test_refusals(self):
        bad = [({'colour': 'red'}, 'unknown key'), ({'id': 'Set A'}, 'lower case'), ({'status': 'paused'}, 'status'),
               ({'marks': ''}, 'marks'), ({'title': ' '}, 'title'), ({'trade_queue': '/q.csv'}, 'needs its bot'),
               ({'trade_labels_only': True}, 'needs a trade queue'), ({'tab': 'trades'}, 'needs a trade queue'),
               ({'tab': 'bot'}, 'needs a bot'), ({'tab': 'review'}, 'tab'), ({'trade_target': '30'}, 'whole number'),
               ({'trade_labels_only': 'yes'}, 'true or false'), ({'seen': 'a.csv'}, 'list'), ({'version': 2}, 'version'),
               ({'created': '6 Oct'}, 'YYYY-MM-DD'), ({'symbol': 'CL'}, 'unknown symbol'),
               ({'bot': '/b.py', 'trade_queue': '/q.csv', 'trade_target': 0}, '1 or more')]
        for extra, why in bad:
            with self.assertRaisesRegex(ValueError, why, msg=extra):
                work.check_item(self.item(**extra))
        with self.assertRaisesRegex(ValueError, 'must match'):
            work.check_item(self.item(), 'set-b')

    def test_read_work_offers_the_good_and_reports_the_rest(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            def put(name, obj):
                with open(os.path.join(d, name), 'w', encoding='utf-8') as f:
                    f.write(obj if isinstance(obj, str) else json.dumps(obj))
            put('b-old.json', self.item(id='b-old', title='Old', status='done', created='2026-10-01'))
            put('a-new.json', self.item(id='a-new', title='New', created='2026-10-06'))
            put('c-two.json', self.item(id='c-two', title='Two', created='2026-10-02'))
            put('broken.json', '{not json')
            put('wrong.json', self.item(id='other'))
            put('_last_opened.txt', 'a-new')
            put('_notes.json', '{}')
            put('readme.txt', 'x')
            items, problems = work.read_work(d)
            self.assertEqual([x['id'] for x in items], ['a-new', 'c-two', 'b-old'])     # active first, the newest first
            self.assertEqual(sorted(n for n, _ in problems), ['broken.json', 'wrong.json'])
            self.assertEqual(work.read_last(d), 'a-new')
        items, problems = work.read_work(os.path.join(d, 'gone'))
        self.assertEqual(items, [])
        self.assertEqual(len(problems), 1)
        self.assertNotIn(d, problems[0][1])                                         # no paths in the list


class Tool(TBase):
    def run_tool(self, *args):
        out = io.StringIO()
        with redirect_stdout(out):
            rc = work.main(list(args))
        return rc, out.getvalue()

    def test_add_once_status_list(self):
        wd = os.path.join(self.tmp.name, 'work')
        rc, out = self.run_tool('add', f'--work={wd}', '--id=label-a', '--title=Label set A', f'--marks={self.marks}', f'--bot={BOT}',
                                f'--trade-queue={self.csv}', '--trade-variant=TM', '--trade-target=30', '--trade-labels-only',
                                '--note=approach', '--created=2026-10-06')
        self.assertEqual(rc, 0, out)
        with open(os.path.join(wd, 'label-a.json'), encoding='utf-8') as f:
            it = json.load(f)
        self.assertEqual({k: it[k] for k in ('status', 'trade_target', 'trade_labels_only', 'trade_variant')},
                         {'status': 'active', 'trade_target': 30, 'trade_labels_only': True, 'trade_variant': 'TM'})
        self.assertTrue(os.path.isabs(it['marks']) and os.path.isabs(it['trade_queue']))
        rc, out = self.run_tool('add', f'--work={wd}', '--id=label-a', '--title=Again', f'--marks={self.marks}')
        self.assertEqual(rc, 2)
        self.assertIn('written once', out)
        rc, out = self.run_tool('add', f'--work={wd}', '--id=x', '--title=X', f'--marks={self.marks}', '--bot=/no/such.py', '--tab=bot')
        self.assertEqual(rc, 2)
        self.assertIn('no such file', out)
        rc, out = self.run_tool('add', f'--work={wd}', '--id=x', '--title=X', f'--marks={self.marks}', '--colour=red')
        self.assertEqual(rc, 2)
        self.assertIn('unknown flag', out)
        self.assertEqual(self.run_tool('status', f'--work={wd}', '--id=label-a', '--set=done')[0], 0)
        rc, out = self.run_tool('list', f'--work={wd}')
        self.assertEqual(rc, 0)
        self.assertIn('label-a', out)
        self.assertIn('done', out)
        self.assertEqual(self.run_tool('status', f'--work={wd}', '--id=label-a', '--set=paused')[0], 2)


class HostBase(TBase):
    def setUp(self):
        super().setUp()
        self.wd = os.path.join(self.tmp.name, 'work')
        os.makedirs(self.wd)
        self.made = []

    def tearDown(self):
        import time
        for st in self.made:                       # a scan still writing its cache holds files the cleanup removes
            t = time.monotonic()
            while st.scan['running'] and time.monotonic() - t < 20:
                time.sleep(0.05)
        super().tearDown()

    def put(self, wid, **kw):
        it = dict({'version': 1, 'id': wid, 'title': wid.replace('-', ' ').title(), 'status': 'active', 'seen': []}, **kw)
        with open(os.path.join(self.wd, wid + '.json'), 'w', encoding='utf-8') as f:
            json.dump(it, f)

    def host(self):
        def make(it):
            st = ms.studio_for_item(it, lambda sym: ms.NpzSource(self.data, sym))
            self.made.append(st)
            self._studios = getattr(self, '_studios', []) + [st]
            return st
        return ms.Host(self.wd, make)

    def stage(self):
        self.put('sweeps', marks=os.path.join(self.tmp.name, 'm-sweeps'), rule=ms.DEFAULT_RULE)
        self.put('labels', marks=os.path.join(self.tmp.name, 'm-labels'), bot=BOT, trade_queue=self.csv, trade_variant='TM',
                 trade_target=30, trade_labels_only=True, created='2026-10-06')
        self.put('old-set', marks=os.path.join(self.tmp.name, 'm-old'), status='stopped')


class Switching(HostBase):
    def test_open_switch_lock_and_counts(self):
        self.stage()
        h = self.host()
        self.assertEqual(h.state(), {'mode': 'none', 'loaded': False, 'version': ms.VERSION,
                                     'work': {'current': None, 'title': None, 'tab': None}})
        lst = h.listing()
        self.assertEqual([x['id'] for x in lst['items']], ['labels', 'sweeps', 'old-set'])
        for x in lst['items']:
            self.assertEqual(set(x), {'id', 'title', 'kind', 'status', 'symbol', 'created', 'note', 'tab', 'progress'})
        self.assertNotIn(self.tmp.name, json.dumps(lst))                             # no folders or files leave the page
        self.assertEqual(lst['items'][0]['progress'], {'done': 0, 'total': 30})      # the queue is written on the first open
        h.open('labels', background=False)
        st = h.studio
        self.assertTrue(st.trade_labels_only)
        self.assertEqual(h.state()['work'], {'current': 'labels', 'title': 'Labels', 'tab': 'trades'})
        self.assertEqual(h.listing()['items'][0]['progress'], {'done': 0, 'total': 3})   # the queue's size (3) under the target
        st.trades_next()
        with self.assertRaisesRegex(ms.Refused, 'a trade is open in the Trades tab'):
            h.open('sweeps', background=False)
        self.assertIs(h.studio, st)
        st.trades_save1({'label': 'PASS', 'chips': ['weak volume into level']})
        st.trades_skip_mine()
        self.assertEqual(h.listing()['items'][0]['progress'], {'done': 1, 'total': 3})
        h.open('sweeps', background=False)
        self.assertIsNot(h.studio, st)
        self.assertEqual(h.state()['work']['tab'], 'blind')
        self.assertEqual(h.listing()['current'], 'sweeps')
        with self.assertRaisesRegex(ms.Refused, 'stopped: it is listed, not opened'):
            h.open('old-set', background=False)
        with self.assertRaisesRegex(ms.Refused, 'no work item'):
            h.open('nope', background=False)
        with self.assertRaisesRegex(ms.Refused, 'no such work item'):
            h.open('../labels', background=False)
        s2 = h.studio
        s2.blind_next()                                                               # a blind candidate open and ungraded
        with self.assertRaisesRegex(ms.Refused, 'blind candidate is open'):
            h.open('labels', background=False)
        s2.save({'setup': 'NONE'})
        self.assertEqual(h.listing()['items'][1]['progress'], {'done': 1, 'total': None})   # sweeps: blind grades so far
        h.open('labels', background=False)
        self.assertEqual(h.current, 'labels')

    def test_failed_open_changes_nothing_and_the_last_opens_again(self):
        self.stage()
        self.put('broken', marks=os.path.join(self.tmp.name, 'm-broken'), bot=BOT, trade_queue=os.path.join(self.tmp.name, 'gone.csv'))
        h = self.host()
        h.open('sweeps', background=False)
        st = h.studio
        with self.assertRaisesRegex(ms.Refused, 'Broken cannot open'):
            h.open('broken', background=False)
        self.assertIs(h.studio, st)
        self.assertEqual(h.current, 'sweeps')
        h2 = self.host()
        h2.open_last(background=False)
        self.assertEqual(h2.current, 'sweeps')
        with open(os.path.join(self.wd, '_last_opened.txt'), 'w') as f:
            f.write('old-set')                                                        # a finished item does not open at start
        h3 = self.host()
        h3.open_last(background=False)
        self.assertIsNone(h3.studio)

    def test_run_all_blocks_leaving(self):
        self.stage()
        self.put('bot-day', marks=os.path.join(self.tmp.name, 'm-bot'), bot=BOT, tab='bot')
        h = self.host()
        h.open('bot-day', background=False)
        h.studio.runall['running'] = True
        with self.assertRaisesRegex(ms.Refused, 'Run all is still running'):
            h.open('sweeps', background=False)
        h.studio.runall['running'] = False
        h.open('sweeps', background=False)


class Http(HostBase):
    def serve(self, target):
        srv = ms.Server(('127.0.0.1', 0), ms.make_handler(target, 0))
        port = srv.server_address[1]
        srv.RequestHandlerClass = ms.make_handler(target, port, [DESK])
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)

        def req(method, path, body=None, headers=None):
            c = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
            c.putrequest(method, path, skip_host=True)
            c.putheader('Host', f'127.0.0.1:{port}')
            for k, v in (headers or {}).items():
                c.putheader(k, v)
            data = json.dumps(body).encode() if body is not None else b''
            c.putheader('Content-Length', str(len(data)))
            c.endheaders(data if method == 'POST' else None)
            r = c.getresponse()
            raw = r.read()
            out = r.status, dict(r.getheaders()), (json.loads(raw) if raw else {})
            c.close()
            return out
        return req

    def test_work_routes_and_the_desk(self):
        self.stage()
        h = self.host()
        req = self.serve(h)
        code, _, j = req('GET', '/api/work')
        self.assertEqual((code, j['current'], len(j['items'])), (200, None, 3))
        self.assertEqual(req('GET', '/api/state')[2]['mode'], 'none')
        for path in ('/api/days', '/api/trades/info', '/markup/list'):
            self.assertEqual(req('GET', path)[0], 409, path)                          # nothing open
        self.assertIn('pick one from the Work list', req('POST', '/api/blind/next', {})[2]['error'])
        # The Desk: GET /api/work only, with its origin echoed; the private network preflight is answered
        code, hd, j = req('GET', '/api/work', headers={'Origin': DESK})
        self.assertEqual((code, hd.get('Access-Control-Allow-Origin')), (200, DESK))
        code, hd, _ = req('OPTIONS', '/api/work', headers={'Origin': DESK, 'Access-Control-Request-Method': 'GET',
                                                            'Access-Control-Request-Private-Network': 'true'})
        self.assertEqual((code, hd.get('Access-Control-Allow-Origin'), hd.get('Access-Control-Allow-Private-Network')),
                         (204, DESK, 'true'))
        self.assertEqual(req('OPTIONS', '/api/work/open', headers={'Origin': DESK, 'Access-Control-Request-Method': 'POST'})[0], 403)
        self.assertEqual(req('OPTIONS', '/api/work', headers={'Origin': 'https://evil.example', 'Access-Control-Request-Method': 'GET'})[0], 403)
        self.assertEqual(req('GET', '/api/work', headers={'Origin': 'https://evil.example'})[0], 403)
        self.assertEqual(req('GET', '/api/state', headers={'Origin': DESK})[0], 403)        # nothing else is shared
        self.assertEqual(req('POST', '/api/work/open', {'id': 'labels'}, headers={'Origin': DESK})[0], 403)
        self.assertEqual(req('GET', '/api/work')[1].get('Access-Control-Allow-Origin'), None)
        # the page opens items
        code, _, j = req('POST', '/api/work/open', {'id': 'labels'})
        self.assertEqual((code, j['current']), (200, 'labels'))
        self.assertTrue(req('GET', '/api/state')[2]['labels_only'])
        code, _, j = req('POST', '/api/work/open', {'id': 'old-set'})
        self.assertEqual(code, 409)
        self.assertEqual(req('POST', '/api/work/open', {'id': 5})[0], 409)

    def test_a_plain_studio_has_no_work_list(self):
        req = self.serve(self.tstudio())
        self.assertEqual(req('GET', '/api/work')[0], 404)
        self.assertEqual(req('POST', '/api/work/open', {'id': 'x'})[0], 404)
        self.assertEqual(req('GET', '/api/work', headers={'Origin': DESK})[0], 404)


class CommandLine(unittest.TestCase):
    def test_work_refuses_item_flags_and_bad_origins(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            for args, why in ((['--work=' + d, '--marks=' + d], 'leave out --marks'),
                              (['--work=' + d, '--trade-labels-only', '--symbol=ES'], 'leave out --symbol, --trade-labels-only'),
                              (['--work=' + os.path.join(d, 'gone')], 'does not exist'),
                              (['--work=' + d, '--allow-origin=https://desk.example.com/path'], 'no path')):
                with self.assertRaises(SystemExit) as cm:
                    ms.main(args + ['--source=npz', '--data=' + d, '--no-browser', '--port=1'])
                self.assertIn(why, str(cm.exception.code), args)
        self.assertEqual(ms.origins('https://a.example.com, http://127.0.0.1:8800/'), ['https://a.example.com', 'http://127.0.0.1:8800'])

    def test_log_to_a_file(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'studio.log')
            with open(path, 'wb') as f:
                f.truncate(5_000_001)                                                 # past 5 MB: moved to .1 first
            out, err = sys.stdout, sys.stderr
            try:
                ms.log_to(path)
                ms.log('opened something')
            finally:
                f = sys.stdout
                sys.stdout, sys.stderr = out, err
                f.close()
            with open(path, encoding='utf-8') as f:
                text = f.read()
            self.assertIn('Markup Studio starting', text)
            self.assertIn('opened something', text)
            self.assertEqual(os.path.getsize(path + '.1'), 5_000_001)


if __name__ == '__main__':
    unittest.main()
