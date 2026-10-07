"""Markup Studio work items: the staged grading work the Studio's Work list offers, one JSON file each in a work folder.

A work item names one way to start the Studio (the same settings as its command line flags) plus a title and a status, so
the Studio started once with --work=DIR (at logon) opens any of them from its Work list or from a link
(live/markup.html#work=<id>), instead of one starter file per set.

    py -3 tools\\markup_work.py add --work=DIR --id=label-approach --title="Label set 1: approach" --marks=DIR
        --bot=PATH --trade-queue=PATH --trade-variant=ID --trade-target=30 --trade-labels-only [--trade-question=approach]
        [--note=TEXT]
    py -3 tools\\markup_work.py status --work=DIR --id=label-approach --set=done
    py -3 tools\\markup_work.py list --work=DIR

<DIR>/<id>.json, version 1. Keys (the Studio's flags with underscores; only id, title, status and marks are required):
  id               [a-z0-9][a-z0-9-]{0,63}, the file's name without .json
  title            what the Work list shows
  status           active (offered and opened), done or stopped (listed as finished, never opened)
  created, note    shown in the list (created YYYY-MM-DD)
  symbol           NQ (default) or ES
  marks            the marks folder (grades, queue, split): each item has its own
  tab              the tab it opens on: blind, free, bot or trades (default trades with a trade queue, else blind)
  bot, trade_queue, trade_variant, trade_seed, trade_skip_days (list), trade_target, trade_notes, trade_exits (list),
  trade_labels_only, trade_question (a label set's question, e.g. approach), include_last_only, seen (list), rule
Files whose names start with "_" are not items (the Studio keeps _last_opened.txt there).
The list shows counts only (graded so far, the target when the item has one): never an outcome.
"""
from __future__ import annotations

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import markup_core as core  # noqa: E402

VERSION = 1
ID_RE = re.compile(r'^[a-z0-9][a-z0-9-]{0,63}$')
STATUSES = ('active', 'done', 'stopped')
TABS = ('blind', 'free', 'bot', 'trades')
KINDS = {'sweeps': 'Sweeps', 'trades': 'Trades', 'labels': 'Label set', 'bot': 'Bot'}
TEXT = ('id', 'title', 'status', 'created', 'note', 'symbol', 'marks', 'tab', 'bot', 'trade_queue', 'trade_variant',
        'trade_notes', 'rule', 'trade_question')
LISTS = ('trade_skip_days', 'trade_exits', 'seen')
INTS = ('trade_seed', 'trade_target')
BOOLS = ('trade_labels_only', 'include_last_only')
KEYS = frozenset(('version',) + TEXT + LISTS + INTS + BOOLS)
LAST = '_last_opened.txt'


class WorkError(ValueError):
    pass


def check_item(it, name=None):
    """A work item as read from its file, checked: the known keys only, the right types, a status, and the settings that
    belong together. Returns the item with its kind added; a WorkError says what is wrong."""
    if not isinstance(it, dict):
        raise WorkError('not a JSON object')
    unknown = sorted(set(it) - KEYS)
    if unknown:
        raise WorkError('unknown key(s): ' + ', '.join(unknown))
    if it.get('version', VERSION) != VERSION:
        raise WorkError(f'version {it.get("version")!r}, this Studio reads version {VERSION}')
    for k in TEXT:
        if k in it and it[k] is not None and not isinstance(it[k], str):
            raise WorkError(f'{k} must be text')
    for k in LISTS:
        if k in it and not (isinstance(it[k], list) and all(isinstance(x, str) for x in it[k])):
            raise WorkError(f'{k} must be a list of text')
    for k in INTS:
        if k in it and (isinstance(it[k], bool) or not isinstance(it[k], int)):
            raise WorkError(f'{k} must be a whole number')
    for k in BOOLS:
        if k in it and not isinstance(it[k], bool):
            raise WorkError(f'{k} must be true or false')
    wid = it.get('id') or ''
    if not ID_RE.match(wid):
        raise WorkError(f'id {wid!r}: use lower case letters, digits and dashes (up to 64)')
    if name is not None and name != wid:
        raise WorkError(f'the file is {name}.json but its id is {wid}: they must match')
    if not (it.get('title') or '').strip():
        raise WorkError('no title')
    if it.get('status') not in STATUSES:
        raise WorkError(f'status {it.get("status")!r}: one of {", ".join(STATUSES)}')
    if not (it.get('marks') or '').strip():
        raise WorkError('no marks folder')
    core.instrument(it.get('symbol') or 'NQ')            # an unknown symbol is a ValueError
    if it.get('created'):
        if not re.match(r'^\d{4}-\d{2}-\d{2}$', it['created']):
            raise WorkError('created must be YYYY-MM-DD')
    tab = it.get('tab')
    if tab is not None and tab not in TABS:
        raise WorkError(f'tab {tab!r}: one of {", ".join(TABS)}')
    if it.get('trade_queue') and not it.get('bot'):
        raise WorkError('a trade queue needs its bot (bot)')
    for k in ('trade_labels_only', 'trade_variant', 'trade_seed', 'trade_skip_days', 'trade_target', 'trade_notes', 'trade_exits',
              'trade_question'):
        if it.get(k) and not it.get('trade_queue'):
            raise WorkError(f'{k} needs a trade queue (trade_queue)')
    if tab == 'trades' and not it.get('trade_queue'):
        raise WorkError('tab trades needs a trade queue (trade_queue)')
    if tab == 'bot' and not it.get('bot'):
        raise WorkError('tab bot needs a bot (bot)')
    if it.get('trade_target') is not None and it['trade_target'] < 1:
        raise WorkError('trade_target must be 1 or more')
    if it.get('trade_question'):
        if not it.get('trade_labels_only'):
            raise WorkError('trade_question is for a label set: it needs trade_labels_only')
        try:
            core.question(it['trade_question'])
        except ValueError as e:
            raise WorkError(f'trade_question: {e}') from e
    out = dict(it)
    out['kind'] = kind_of(it)
    return out


def kind_of(it):
    if it.get('trade_labels_only'):
        return 'labels'
    if it.get('trade_queue'):
        return 'trades'
    if it.get('tab') == 'bot':
        return 'bot'
    return 'sweeps'


def start_tab(it):
    return it.get('tab') or ('trades' if it.get('trade_queue') else 'blind')


def read_work(folder):
    """(items: active first, the newest created first, then by title; problems as (file name, reason)). An unreadable or
    wrong file is a problem, never a crash: the others are still offered."""
    items, problems = [], []
    try:
        names = sorted(os.listdir(folder))
    except OSError as e:
        return [], [('', f'cannot read the work folder: {e.strerror or e}')]
    for n in names:
        if not n.endswith('.json') or n.startswith('_'):
            continue
        try:
            with open(os.path.join(folder, n), encoding='utf-8') as f:
                it = json.load(f)
            items.append(check_item(it, n[:-5]))
        except OSError as e:
            problems.append((n, f'cannot read it: {e.strerror or type(e).__name__}'))   # no paths: the list leaves this PC's page
        except ValueError as e:
            problems.append((n, str(e)))
    items.sort(key=lambda x: (x['title'].lower(), x['id']))
    items.sort(key=lambda x: x.get('created') or '', reverse=True)       # the newest staged first, undated last
    items.sort(key=lambda x: x['status'] != 'active')                    # active before finished (each sort is stable)
    return items, problems


def progress(it):
    """Counts only. Trades and label sets: the grades of this item's own queue (a grade counts when its queue sha256, else
    its trade id, is the queue's: a marks folder shared with other work never adds to it) and the target (the queue's size
    when smaller; none without trade_target, then the list says "N graded"); sweeps: the blind grades saved so far, no
    total. None for the Bot tab, or when nothing can be read."""
    marks = it['marks']
    if it.get('trade_queue'):
        target = it.get('trade_target') or None
        try:
            with open(os.path.join(marks, 'trade_queue_v1.json'), encoding='utf-8') as f:
                q = json.load(f)
            items = [(x['qid'], str(x['trade_id'])) for x in q.get('items', [])]
            sha = q.get('sha256')
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            return {'done': 0, 'total': target}            # the queue is written on the first open
        grades = core.list_trade_grades(os.path.join(marks, 'trade_grades'))

        def ours(g, tid):
            if not core.trade_grade_done(g):
                return False
            return g['queue_sha256'] == sha if g.get('queue_sha256') else str(g.get('trade_id')) == tid
        done = sum(1 for qid, tid in items if ours(grades.get(qid), tid))
        return {'done': done, 'total': min(target, len(items)) if target else None}
    if kind_of(it) == 'sweeps':
        return {'done': sum(1 for g in core.list_grades(marks) if g.get('mode') == 'blind'), 'total': None}
    return None


def public(it):
    """What the Work list (and The Desk) sees of an item: no folders or file paths."""
    return {'id': it['id'], 'title': it['title'], 'kind': it['kind'], 'status': it['status'], 'symbol': it.get('symbol') or 'NQ',
            'created': it.get('created') or '', 'note': it.get('note') or '', 'tab': start_tab(it), 'progress': progress(it)}


def read_last(folder):
    try:
        with open(os.path.join(folder, LAST), encoding='utf-8') as f:
            wid = f.read().strip()
        return wid if ID_RE.match(wid) else None
    except OSError:
        return None


def write_last(folder, wid):
    try:
        core.write_text(os.path.join(folder, LAST), wid + '\n')
    except OSError:
        pass                                   # remembering the last item is a convenience only


# ------------------------------------------------------------------------------------------------ the command line
FLAG_KEYS = {'id': 'id', 'title': 'title', 'note': 'note', 'created': 'created', 'symbol': 'symbol', 'marks': 'marks', 'tab': 'tab',
             'bot': 'bot', 'trade-queue': 'trade_queue', 'trade-variant': 'trade_variant', 'trade-notes': 'trade_notes',
             'rule': 'rule', 'trade-seed': 'trade_seed', 'trade-target': 'trade_target', 'trade-skip-days': 'trade_skip_days',
             'trade-exits': 'trade_exits', 'seen': 'seen', 'trade-labels-only': 'trade_labels_only',
             'include-last-only': 'include_last_only', 'status': 'status', 'trade-question': 'trade_question'}
PATH_KEYS = ('marks', 'bot', 'trade_queue', 'trade_notes', 'rule')


def item_from_flags(opt):
    it = {'version': VERSION}
    for flag, key in FLAG_KEYS.items():
        if flag not in opt:
            continue
        v = opt[flag]
        if key in BOOLS:
            it[key] = True
        elif key in INTS:
            try:
                it[key] = int(v)
            except ValueError as e:
                raise WorkError(f'--{flag} must be a whole number') from e
        elif key in LISTS:
            it[key] = [x.strip() for x in v.split(',') if x.strip()]
        else:
            it[key] = v
    for k in PATH_KEYS:
        if it.get(k):
            it[k] = os.path.abspath(it[k])
    for k in PATH_KEYS[1:]:
        if it.get(k) and not os.path.isfile(it[k]):
            raise WorkError(f'{k}: no such file: {it[k]}')
    for p in it.get('seen', []):
        if not os.path.isfile(p):
            raise WorkError(f'seen: no such file: {p}')
    it.setdefault('status', 'active')
    return it


def main(argv=None):
    args = argv if argv is not None else sys.argv[1:]
    if not args or args[0] not in ('add', 'status', 'list'):
        print(__doc__)
        return 2
    cmd, opt = args[0], dict(a[2:].split('=', 1) if '=' in a else (a[2:], '1') for a in args[1:] if a.startswith('--'))
    folder = opt.pop('work', None)
    if not folder:
        print('give the work folder with --work=DIR')
        return 2
    try:
        if cmd == 'list':
            items, problems = read_work(folder)
            for it in items:
                p = progress(it)
                print(f'{it["id"]:<28} {it["status"]:<8} {KINDS[it["kind"]]:<10} {it["title"]}' +
                      (f'  ({p["done"]}' + (f' of {p["total"]}' if p['total'] else '') + ' graded)' if p else ''))
            for n, why in problems:
                print(f'PROBLEM {n}: {why}')
            return 0 if not problems else 1
        wid = opt.get('id', '')
        if not ID_RE.match(wid):
            raise WorkError(f'--id {wid!r}: use lower case letters, digits and dashes (up to 64)')
        path = os.path.join(folder, wid + '.json')
        if cmd == 'status':
            new = opt.get('set')
            if new not in STATUSES:
                raise WorkError(f'--set must be one of {", ".join(STATUSES)}')
            with open(path, encoding='utf-8') as f:
                it = json.load(f)
            check_item(it, wid)
            it['status'] = new
            core.write_text(path, json.dumps(it, indent=1) + '\n')
            print(f'{wid}: status {new}')
            return 0
        unknown = sorted(set(opt) - set(FLAG_KEYS))
        if unknown:
            raise WorkError('unknown flag(s): ' + ', '.join('--' + u for u in unknown))
        if os.path.exists(path):
            raise WorkError(f'{path} exists: a work item is written once (change its status with "status")')
        it = item_from_flags(opt)
        check_item(it, wid)
        os.makedirs(folder, exist_ok=True)
        core.write_text(path, json.dumps(it, indent=1) + '\n')
        print(f'wrote {path} ({KINDS[kind_of(it)]}, {it["status"]})')
        return 0
    except (OSError, ValueError) as e:
        print(f'refused: {e}')
        return 2


if __name__ == '__main__':
    sys.exit(main())
