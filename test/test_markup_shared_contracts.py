"""The shared contract values (Bot-Lab plan step 1.5): the Markup Studio's instrument table agrees with chart-engine's
exact copy of market-data's shared/ folder, read with its Python loader. The copy itself is pinned by sha256 in
test/shared-calendar.test.js. The Studio does not read the copy yet; it keeps its own table.

    python3 -m unittest discover -s test -p "test_markup*.py"
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'tools'))
sys.path.insert(0, os.path.join(HERE, '..', 'shared'))
import markup_core as core  # noqa: E402
import shared_calendar as S  # noqa: E402


class SharedContracts(unittest.TestCase):
    def test_the_studio_table_matches_the_shared_values(self):
        k = S.load_contracts()
        self.assertEqual(sorted(core.INSTRUMENTS), sorted(k))
        for root, c in k.items():
            self.assertEqual(core.INSTRUMENTS[root]['tick'], c.tick_size, root)
            self.assertEqual(core.INSTRUMENTS[root]['point_value'], c.point_value, root)
            self.assertEqual(core.INSTRUMENTS[root].get('micro'), c.micro, root)

    def test_the_python_loader_reads_the_calendar(self):
        cal = S.load_calendar()
        self.assertTrue(cal.is_session('2026-04-03'))
        self.assertFalse(cal.is_session('2027-03-26'))
        with self.assertRaises(S.CalendarNotCovered):
            cal.is_session('2028-01-03')


if __name__ == '__main__':
    unittest.main()
