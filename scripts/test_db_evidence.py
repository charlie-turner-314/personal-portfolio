import contextlib
import io
import json
from pathlib import Path
import re
import runpy
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('db-evidence.py')


class InvestmentPreservationTests(unittest.TestCase):
    def run_evidence(self, rows, baseline=None):
        def sql(args, *, input, text):
            if 'information_schema.columns' in input:
                table = re.search("table_name='([^']+)'", input).group(1)
                return 'id, amount' if table in rows else ''
            table = re.search(r'FROM "([^"]+)"', input).group(1)
            return str(len(rows[table])) if 'count(*)' in input else '\n'.join(json.dumps(row, sort_keys=True) for row in rows[table])
        with tempfile.TemporaryDirectory() as directory:
            argv = [str(SCRIPT)]
            if baseline is not None:
                path = Path(directory) / 'before.json'
                path.write_text(json.dumps(baseline))
                argv.append(str(path))
            output = io.StringIO()
            with patch('sys.argv', argv), patch('subprocess.check_output', side_effect=sql), contextlib.redirect_stdout(output):
                runpy.run_path(str(SCRIPT), run_name='__main__')
            return json.loads(output.getvalue())

    def test_populated_investment_history_is_hashed(self):
        result = self.run_evidence({'holding_valuations': [{'id': 'v', 'amount': 123}], 'investment_income_events': [{'id': 'i', 'amount': 20}]})
        self.assertEqual(set(result), {'holding_valuations', 'investment_income_events'})
        self.assertEqual(result['holding_valuations']['count'], '1')

    def test_new_tables_do_not_invalidate_old_column_evidence(self):
        rows = {'holding_valuations': [{'id': 'v', 'amount': 123}]}
        before = self.run_evidence(rows)
        after = self.run_evidence({**rows, 'investment_income_events': []}, before)
        self.assertEqual(before, after)

    def test_changed_financial_history_fails_closed(self):
        before = self.run_evidence({'holding_valuations': [{'id': 'v', 'amount': 123}]})
        with self.assertRaisesRegex(SystemExit, 'Existing data changed'):
            self.run_evidence({'holding_valuations': [{'id': 'v', 'amount': 0}]}, before)


if __name__ == '__main__':
    unittest.main()
