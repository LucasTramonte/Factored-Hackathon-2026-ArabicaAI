"""Hand-checked regressions for the meeting analysis, using tiny real CSVs."""

import csv
import sqlite3
import tempfile
import unittest
from pathlib import Path

from data_foundation.src import exploration as analysis


class ExplorationTests(unittest.TestCase):
    """Protect coverage, grain and analytical denominators."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def csv(self, table, rows, name='part.csv', fields=None):
        path = self.root / table / name
        path.parent.mkdir(parents=True, exist_ok=True)
        fields = fields or analysis.FIELDS[table]
        with path.open('w', encoding='utf-8-sig', newline='') as stream:
            writer = csv.DictWriter(stream, fields)
            writer.writeheader()
            writer.writerows({field: row.get(field, '') for field in fields} for row in rows)
        return path

    def connection(self):
        connection = sqlite3.connect(self.root / 'test.sqlite')
        self.addCleanup(connection.close)
        return connection

    def test_input_gate(self):
        """An incomplete or changed inventory must never pass as full coverage."""
        path = self.csv('call_center_interactions', [])
        manifest = [{'path': str(path.relative_to(self.root)), 'size': path.stat().st_size}]
        self.assertEqual(analysis.verify_inputs(self.root, manifest, ('call_center_interactions',)),
                         {'call_center_interactions': [path]})
        with self.assertRaises(ValueError):
            analysis.verify_inputs(self.root, [], ('call_center_interactions',))
        with path.open('a') as stream:
            stream.write('\n')
        with self.assertRaises(ValueError):
            analysis.verify_inputs(self.root, manifest, ('call_center_interactions',))
        path.unlink()
        with self.assertRaises(ValueError):
            analysis.verify_inputs(self.root, manifest, ('call_center_interactions',))
        path = self.csv('call_center_interactions', [])
        self.csv('call_center_interactions', [], name='extra.csv')
        with self.assertRaises(ValueError):
            analysis.verify_inputs(self.root, manifest, ('call_center_interactions',))

    def test_cross_partition_keys_and_bom(self):
        """Keeping one duplicate or checking each file alone would break counts."""
        files = [self.csv('call_center_interactions', [
            {'interaction_id': 'A', 'was_resolved': 'True'},
            {'interaction_id': 'B', 'was_resolved': 'False'}]),
            self.csv('call_center_interactions', [
                {'interaction_id': 'A', 'was_resolved': 'False'},
                {'interaction_id': 'C'}, {'interaction_id': ''}], name='second.csv')]
        connection = self.connection()
        for size in (1, 3):
            result = analysis.load_table(connection, 'call_center_interactions', files, size)
            self.assertEqual({k: result[k] for k in ('raw', 'eligible', 'duplicate_keys',
                             'duplicate_rows', 'blank_rows', 'conflicting_keys')},
                             dict(raw=5, eligible=2, duplicate_keys=1,
                                  duplicate_rows=2, blank_rows=1, conflicting_keys=1))

    def test_bad_schema_is_atomic(self):
        """A bad later partition must not leave a partially loaded table."""
        good = self.csv('call_center_interactions', [{'interaction_id': 'A'}])
        bad = self.csv('call_center_interactions', [], name='bad.csv', fields=['interaction_id'])
        connection = self.connection()
        with self.assertRaises(ValueError):
            analysis.load_table(connection, 'call_center_interactions', [good, bad])
        self.assertEqual(connection.execute("SELECT count(*) FROM sqlite_master WHERE name='call_center_interactions'").fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
