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

    def test_analysis_denominators(self):
        """Unknown flags, ambiguous joins and open cases must not bias metrics."""
        connection = self.connection()
        rows = {
            'call_center_interactions': [dict(interaction_id=str(i), customer_id=customer,
                contact_reason='Account', was_resolved=flag, duration_seconds=duration,
                interaction_date='2026-01-01 12:00:00')
                for i, (flag, duration, customer) in enumerate([
                    ('True', '10', 'A'), ('False', '20', 'B'), ('', '-1', 'C'), ('invalid', 'NaN', 'A')])],
            'customers': [{'customer_id': 'A', 'country': 'Mexico'},
                          {'customer_id': 'A', 'country': 'Colombia'},
                          {'customer_id': 'B', 'country': 'Argentina'}],
            'complaints': [{'complaint_id': '1', 'status': 'Open', 'resolution_days': '0'},
                           {'complaint_id': '2', 'status': 'Resolved', 'resolution_days': '5',
                            'creation_date': '2026-01-01', 'resolution_date': '2026-01-06'}],
            'transactions': [{'transaction_id': '1', 'amount': '100.10', 'currency': 'COP',
                              'amount_usd': '', 'is_fraud': 'True'},
                             {'transaction_id': '2', 'amount': '20.20', 'currency': 'MXN',
                              'amount_usd': '1.25', 'is_fraud': 'False'}],
            'call_transcripts': [],
        }
        for table, values in rows.items():
            analysis.load_table(connection, table, [self.csv(table, values)])
        result = analysis.summarize(connection)
        metric = next(r for r in result['rates'] if r['table'] == 'call_center_interactions'
                      and r['dimension'] == 'all' and r['metric'] == 'was_resolved')
        self.assertEqual([metric[k] for k in ['numerator', 'denominator', 'unknown', 'eligible', 'rate']],
                         [1, 2, 2, 4, 0.5])
        unknown = next(r for r in result['rates'] if r['table'] == 'call_center_interactions'
                       and r['dimension'] == 'all' and r['metric'] == 'was_escalated')
        self.assertIsNone(unknown['rate'])
        duration = next(r for r in result['durations'] if r['metric'] == 'duration_seconds' and r['dimension'] == 'all')
        self.assertEqual([duration[k] for k in ['known', 'median', 'p95']], [2, 15, 20])
        resolution = next(r for r in result['durations'] if r['metric'] == 'resolution_days' and r['dimension'] == 'all')
        self.assertEqual([resolution[k] for k in ['known', 'median']], [1, 5])
        currencies = {r['currency']: r for r in result['money'] if r['is_fraud'] == 1 or r['is_fraud'] == 0}
        self.assertEqual(currencies['COP']['amount_cents'], 10010)
        self.assertIsNone(currencies['COP']['amount_usd_cents'])
        self.assertEqual(currencies['MXN']['amount_cents'], 2020)
        self.assertEqual(currencies['MXN']['amount_usd_cents'], 125)
        self.assertEqual(sum(r['rows'] for r in result['enrichment'] if r['table'] == 'call_center_interactions'), 4)
        links = {r['match_status']: r['rows'] for r in result['enrichment'] if r['table'] == 'call_center_interactions'}
        self.assertEqual(links, {'ambiguous': 2, 'matched': 1, 'missing': 1})
        self.assertEqual(next(r for r in result['coverage'] if r['table'] == 'call_center_interactions')['dated'], 4)

    def test_prevention_bands_and_empty_population(self):
        """Amount/time grouping must preserve unknowns and not depend on labels."""
        connection = self.connection()
        for table in analysis.FIELDS:
            rows = [] if table != 'transactions' else [
                {'transaction_id': '1', 'transaction_date': '2026-01-01 23:00:00', 'amount_usd': '99.99', 'is_fraud': 'True'},
                {'transaction_id': '2', 'transaction_date': 'bad', 'amount_usd': '100.00', 'is_fraud': 'False'},
                {'transaction_id': '3', 'amount_usd': 'NaN', 'is_fraud': ''}]
            analysis.load_table(connection, table, [self.csv(table, rows)])
        result = analysis.summarize(connection)
        bands = {r['label']: r for r in result['rates'] if r['table']=='transactions' and r['dimension']=='usd_band'}
        self.assertEqual(set(bands), {'0–<100 USD', '100–<1,000 USD', 'Unknown'})
        self.assertEqual(bands['0–<100 USD']['numerator'], 1)
        self.assertIsNone(bands['Unknown']['rate'])
        hours = {r['label']: r['eligible'] for r in result['rates'] if r['table']=='transactions' and r['dimension']=='event_hour'}
        self.assertEqual(hours, {'23': 1, 'Unknown': 2})
        empty = next(r for r in result['rates'] if r['table']=='call_center_interactions' and r['dimension']=='all')
        self.assertEqual(empty['eligible'], 0)
        self.assertIsNone(empty['rate'])

    def test_partition_date_mismatch_remains_visible(self):
        """A valid process date in the wrong physical day is a quality issue."""
        path = self.csv('transactions', [
            {'transaction_id': '1', 'process_date': '2026-01-02'},
            {'transaction_id': '2', 'process_date': 'not-a-date'}],
            name='year=2026/month=01/day=01/part.csv')
        quality = analysis.load_table(self.connection(), 'transactions', [path])
        self.assertEqual(quality['fields']['process_date:partition_mismatch'], 1)
        self.assertEqual(quality['fields']['process_date:invalid'], 1)

    def test_incomplete_or_invalid_partition_path_fails_the_scan(self):
        for name in ('year=2026/month=01/part.csv', 'year=2026/month=13/day=01/part.csv', 'year=2026/month=01/day=01oops/part.csv', 'year=2025/month=01/day=01/year=2026/month=01/day=01/part.csv'):
            path = self.csv('transactions', [{'transaction_id': '1', 'process_date': '2026-01-01'}], name=name)
            with self.assertRaises(ValueError):
                analysis.load_table(self.connection(), 'transactions', [path])


if __name__ == '__main__':
    unittest.main()
