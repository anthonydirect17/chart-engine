"""SERVER_RULES.md rule 6.5 for the Markup Studio tests: no test touches a file or folder outside the repo or the temp
folder (for example the Studio's defaults on HOME, E:\\SchwabDesk_bulk\\...). Runs every test_markup*.py once more in its
own process under test/markup_path_audit.py and fails on any path it reports.

    python3 -m unittest discover -s test -p "test_markup*.py"
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
FLAG = 'CHART_ENGINE_MARKUP_PATH_AUDIT'
sys.path.insert(0, HERE)


class NoPathOutsideTheRepo(unittest.TestCase):
    def test_markup_tests_touch_only_the_repo_and_temp(self):
        if os.environ.get(FLAG):
            self.skipTest('this is the audited run itself')
        with tempfile.TemporaryDirectory() as d:
            report = os.path.join(d, 'paths.json')
            r = subprocess.run([sys.executable, os.path.join(HERE, 'markup_path_audit.py'), report], cwd=os.path.dirname(HERE),
                               env=dict(os.environ, **{FLAG: '1'}), capture_output=True, text=True, timeout=900)
            self.assertEqual(r.returncode, 0, 'the audited run failed:\n' + r.stdout[-4000:] + r.stderr[-4000:])
            with open(report, encoding='utf-8') as f:
                found = json.load(f)
        self.assertEqual(found, [], 'markup tests touched paths outside the repo and the temp folder:\n' + '\n'.join(found))

    def test_the_audit_sees_what_it_should(self):
        """The audit's own rules, on made-up paths (no file is touched)."""
        import markup_path_audit as audit
        self.assertIsNotNone(audit.outside(r'E:\SchwabDesk_bulk\tickbench\runs\sweep_blind\KEY.csv') if os.name != 'nt'
                             else audit.outside('E:\\SchwabDesk_bulk\\x'))
        self.assertIsNone(audit.outside(os.path.join(audit.REPO, 'tools', 'markup_rule_v0.json')))
        self.assertIsNone(audit.outside(os.path.join(tempfile.gettempdir(), 'x', 'y.csv')))
        self.assertIsNone(audit.outside(3))                                  # a file descriptor, not a path
        if os.name != 'nt':
            self.assertIsNotNone(audit.outside('/home/someone-else/data.csv' if not audit.REPO.startswith('/home/someone-else')
                                               else '/srv/data.csv'))
        self.assertNotIn(os.path.normcase(os.path.abspath(os.sep)).rstrip('\\/'), audit.ROOTS, 'never a whole drive or /')


if __name__ == '__main__':
    unittest.main()
