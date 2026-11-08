"""Runs the Markup Studio unit tests (test_markup*.py) and records every file path they touch outside the repo, the
temp folder and Python's own folders (SERVER_RULES.md rule 6.5: a test reads nothing outside the repo). Used by
test/test_markup_paths.py, which starts this in its own process and reads the report:

    python test/markup_path_audit.py REPORT.json

What counts as touching: the audit events Python raises for opening, listing, globbing, making, moving and removing
files and folders, plus os.stat, os.lstat and the os.path checks (exists, isfile, isdir and the like, which raise no
audit event). Windows drive paths (E:\\...) are always outside, on any system. Allowed: the repo, the temp folder,
Python's prefixes and every folder on sys.path (the standard library and numpy), and the operating system's own
folders (/etc, /usr, /proc and the like on Linux; the Windows folder on Windows), which Python itself reads, and the
system MIME tables mimetypes looks for and the null device. A stat-type
check (no open, no listing) of a folder above an allowed one is allowed too: os.path.realpath looks at each folder on
its way down to the repo or the temp folder.
"""
import json
import mimetypes
import os
import re
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
DRIVE = re.compile(r'^(?:[A-Za-z]:[\\/]|\\\\)')
EVENTS = {'open', 'os.listdir', 'os.scandir', 'os.walk', 'os.fwalk', 'glob.glob', 'glob.glob/2', 'os.mkdir', 'os.rmdir',
          'os.remove', 'os.rename', 'os.chmod', 'os.chown', 'os.utime', 'os.truncate', 'os.link', 'os.symlink', 'os.chdir',
          'os.startfile', 'shutil.copyfile', 'shutil.copymode', 'shutil.copystat', 'shutil.copytree', 'shutil.rmtree',
          'shutil.move', 'shutil.chown', 'shutil.make_archive', 'shutil.unpack_archive', 'sqlite3.connect', 'zipfile.ZipFile',
          'tarfile.open', 'pathlib.Path.glob', 'pathlib.Path.rglob'}


def roots():
    out = [REPO, tempfile.gettempdir(), sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix]
    out += [p for p in sys.path if p and os.path.isabs(p) and os.path.dirname(p) != p]     # never a whole drive or /
    if os.name == 'nt':
        out += [os.environ.get('SystemRoot') or os.environ.get('windir') or '']
    else:
        out += ['/etc', '/usr', '/lib', '/lib32', '/lib64', '/proc', '/sys', '/dev']
    seen = set()
    for p in out:
        if p:
            for q in (os.path.abspath(p), os.path.realpath(p)):
                seen.add(os.path.normcase(q).rstrip('\\/'))
    return sorted(seen)


ROOTS = roots()
# single files Python itself may look for: the system MIME tables (mimetypes checks each on any system, also on
# Windows, where they do not exist) and the null device
FILES = {os.path.normcase(os.path.abspath(p)) for p in list(mimetypes.knownfiles) + [os.devnull]}
FOUND = {}


def outside(p):
    if isinstance(p, int):
        return None
    try:
        s = os.fsdecode(p)
    except TypeError:
        return None
    if not s:
        return None
    if DRIVE.match(s) and os.name != 'nt':
        return s
    a = os.path.normcase(os.path.abspath(s))
    if a in FILES or s == os.devnull:
        return None
    for r in ROOTS:
        if a == r or a.startswith(r + os.sep):
            return None
    return s


def above_a_root(s):
    """A folder above an allowed one (/home above the repo): os.path.realpath looks at each one on its way down."""
    a = os.path.normcase(os.path.abspath(s)).rstrip('\\/')
    return any(r.startswith(a + os.sep) for r in ROOTS)


def note(where, args, stat_only=False):
    for x in args:
        if isinstance(x, (str, bytes, os.PathLike)):
            s = outside(x)
            if s is not None and not (stat_only and not DRIVE.match(s) and above_a_root(s)):
                FOUND.setdefault(s, where)


def hook(event, args):
    if event in EVENTS:
        note(event, args[:2])


def wrap(mod, name):
    real = getattr(mod, name)

    def checked(path, *a, **k):
        note(f'{mod.__name__}.{name}', (path,), stat_only=True)
        return real(path, *a, **k)
    setattr(mod, name, checked)


def main(report):
    sys.addaudithook(hook)
    for name in ('stat', 'lstat'):
        wrap(os, name)
    for name in ('exists', 'lexists', 'isfile', 'isdir', 'islink', 'ismount', 'getsize', 'getmtime', 'getatime', 'getctime'):
        if hasattr(os.path, name):
            wrap(os.path, name)
    os.chdir(REPO)
    suite = unittest.defaultTestLoader.discover(HERE, pattern='test_markup*.py', top_level_dir=HERE)
    result = unittest.TextTestRunner(verbosity=0).run(suite)
    with open(report, 'w', encoding='utf-8') as f:
        json.dump(sorted(f'{p}  ({w})' for p, w in FOUND.items()), f, indent=1)
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
