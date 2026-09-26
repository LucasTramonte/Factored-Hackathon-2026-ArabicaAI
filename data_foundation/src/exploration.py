"""Read-only CSV exploration with disk-backed keys and explicit unknowns.

Python memory is O(batch_size + schema size). SQLite uses a 32 MiB page
cache and disk temporary storage; exact key/group/sort state lives on disk.
The caller owns and closes the SQLite connection, in an ignored scratch path.
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import sqlite3
from collections import Counter
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path

from .contracts import CONTRACTS, discover_files


FIELDS = {
    'call_center_interactions': tuple(('interaction_id interaction_date process_date customer_id '
        'agent_id interaction_type channel contact_reason reason_category duration_seconds '
        'wait_time_seconds was_resolved requires_followup detected_sentiment sentiment_score '
        'customer_detected_accent agent_used_accent was_escalated mentioned_products '
        'has_transcript has_recording').split()),
    'transactions': tuple(('transaction_id transaction_date process_date product_id customer_id '
        'transaction_type transaction_category amount currency amount_usd channel branch_id '
        'merchant_name merchant_category transaction_country transaction_city transaction_status '
        'response_code is_fraud fraud_score latitude longitude').split()),
    'complaints': tuple(('complaint_id creation_date process_date customer_id category subcategory '
        'case_type priority status sla_breached resolution_date resolution_days '
        'is_repeat_complainer origin_interaction_id affected_product_id claimed_amount currency').split()),
    'customers': ('customer_id', 'country'),
    'call_transcripts': ('transcript_id', 'interaction_id', 'process_date', 'detected_language'),
}
BOOLEANS = set(('was_resolved requires_followup was_escalated has_transcript has_recording '
                'is_fraud sla_breached is_repeat_complainer').split())
MONEY = {'amount', 'amount_usd', 'claimed_amount'}
NUMBERS = {'duration_seconds', 'wait_time_seconds', 'resolution_days', 'sentiment_score',
           'fraud_score', 'latitude', 'longitude'}
NONNEGATIVE = {'duration_seconds', 'wait_time_seconds', 'resolution_days'}
DATES = {'interaction_date', 'transaction_date', 'creation_date', 'resolution_date', 'process_date'}


def verify_inputs(data_root: Path, manifest: list[dict], tables: tuple[str, ...]) -> dict[str, list[Path]]:
    """Require the exact CSV inventory and sizes for each requested table.

Manifest paths are relative to data_root; reject path traversal and duplicated
manifest paths. Size checks establish download coverage, not content checksums.
"""
    root = data_root.resolve()
    expected = {}
    for item in manifest:
        path = root / item['path']
        if not path.resolve().is_relative_to(root) or path.is_absolute() and Path(item['path']).is_absolute():
            raise ValueError('Manifest path must stay relative to data root')
        if path in expected or not isinstance(item['size'], int) or item['size'] < 0:
            raise ValueError('Invalid or duplicate manifest entry')
        expected[path] = item['size']
    result = {}
    for table in tables:
        contract = CONTRACTS[table]
        base = root / contract.relative_path
        wanted = {p: size for p, size in expected.items()
                  if p.suffix == '.csv' and (p == base or base in p.parents)}
        actual = discover_files(root, contract)
        if not wanted or set(actual) != set(wanted):
            raise ValueError(f'{table}: missing/extra CSV objects or empty manifest')
        if any(p.stat().st_size != wanted[p] for p in actual):
            raise ValueError(f'{table}: CSV object size mismatch')
        result[table] = actual
    return result


def _value(field, text):
    """Return a normalized value and quality state; unknown never means zero."""
    text = text.strip()
    if not text:
        return None, 'missing'
    try:
        if field in BOOLEANS:
            return {'true': 1, 'false': 0, '1': 1, '0': 0}[text.lower()], 'valid'
        if field in MONEY:
            value = Decimal(text)
            if not value.is_finite() or value * 100 != (value * 100).to_integral_value():
                raise ValueError()
            cents = int(value * 100)
            if abs(cents) > 10**15:
                raise ValueError()
            return cents, 'valid'
        if field in NUMBERS:
            value = float(text)
            if not math.isfinite(value) or field in NONNEGATIVE and value < 0:
                raise ValueError()
            limits = {'sentiment_score': (-1, 1), 'fraud_score': (0, 100),
                      'latitude': (-90, 90), 'longitude': (-180, 180)}
            if field in limits and not limits[field][0] <= value <= limits[field][1]:
                raise ValueError()
            return value, 'valid'
        if field in DATES:
            value = datetime.fromisoformat(text)
            if value.tzinfo is not None:
                raise ValueError('Timezone-aware data requires an explicit conversion policy')
            return value.isoformat(sep=' ') if field != 'process_date' else value.date().isoformat(), 'valid'
        return text, 'valid'
    except (ValueError, KeyError, InvalidOperation, OverflowError):
        return None, 'invalid'


def load_table(connection: sqlite3.Connection, table: str, files: list[Path], batch_size: int = 5000) -> dict:
    """Atomically replace one projected table and create its eligible view.

Every occurrence of a blank or duplicated primary key is excluded from the
eligible view. Full-row digests detect conflicting duplicates without storing
unneeded text. Returns auditable raw/eligible and field-quality counts.
"""
    if table not in FIELDS or not files or batch_size < 1:
        raise ValueError('Known table, nonempty input and positive batch size required')
    fields = FIELDS[table]
    key = fields[0]
    connection.execute('PRAGMA cache_size=-32768')
    connection.execute('PRAGMA temp_store=FILE')
    counts = Counter()
    snapshot = [(p, p.stat().st_size, p.stat().st_mtime_ns) for p in files]
    connection.execute('SAVEPOINT load_table')
    try:
        connection.execute(f'DROP VIEW IF EXISTS eligible_{table}')
        connection.execute(f'DROP TABLE IF EXISTS keys_{table}')
        connection.execute(f'DROP TABLE IF EXISTS {table}')
        columns = ','.join(f'"{field}" ' + ('INTEGER' if field in BOOLEANS | MONEY else
                          'REAL' if field in NUMBERS else 'TEXT') for field in fields)
        connection.execute(f'CREATE TABLE {table} ({columns}, _digest TEXT)')
        insert = f'INSERT INTO {table} VALUES ({",".join("?" for _ in range(len(fields) + 1))})'
        batch = []
        for index, path in enumerate(files):
            with path.open(encoding='utf-8-sig', newline='') as stream:
                reader = csv.DictReader(stream)
                header = reader.fieldnames or []
                if len(header) != len(set(header)) or not set(fields).issubset(header):
                    raise ValueError(f'{table}: missing/duplicate header columns in {path}')
                for row in reader:
                    if None in row or any(value is None for value in row.values()):
                        raise ValueError(f'{table}: malformed CSV row in {path}')
                    values = []
                    for field in fields:
                        value, state = _value(field, row[field])
                        if state != 'valid':
                            counts[f'{field}:{state}'] += 1
                        values.append(value)
                    digest = hashlib.sha256(json.dumps(row, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
                    batch.append((*values, digest))
                    if len(batch) >= batch_size:
                        connection.executemany(insert, batch)
                        batch.clear()
            if (index + 1) % 200 == 0:
                print(f'{table}: {index + 1}/{len(files)} files', flush=True)
        connection.executemany(insert, batch)
        if any((p.stat().st_size, p.stat().st_mtime_ns) != (size, modified)
               for p, size, modified in snapshot):
            raise ValueError(f'{table}: input changed during read')
        connection.execute(f'CREATE INDEX idx_{table} ON {table}("{key}")')
        connection.execute(f'CREATE TABLE keys_{table} AS SELECT "{key}" AS id, count(*) AS n, '
                           f'count(DISTINCT _digest) AS variants FROM {table} '
                           f'WHERE "{key}" IS NOT NULL GROUP BY "{key}"')
        connection.execute(f'CREATE UNIQUE INDEX idx_keys_{table} ON keys_{table}(id)')
        connection.execute(f'CREATE VIEW eligible_{table} AS SELECT t.* FROM {table} t '
                           f'JOIN keys_{table} k ON t."{key}"=k.id WHERE k.n=1')
        scalar = lambda query: connection.execute(query).fetchone()[0]
        result = dict(table=table, files=len(files), raw=scalar(f'SELECT count(*) FROM {table}'),
                      eligible=scalar(f'SELECT count(*) FROM keys_{table} WHERE n=1'),
                      blank_rows=scalar(f'SELECT count(*) FROM {table} WHERE "{key}" IS NULL'),
                      distinct_ids=scalar(f'SELECT count(*) FROM keys_{table}'),
                      duplicate_keys=scalar(f'SELECT count(*) FROM keys_{table} WHERE n>1'),
                      duplicate_rows=scalar(f'SELECT coalesce(sum(n),0) FROM keys_{table} WHERE n>1'),
                      conflicting_keys=scalar(f'SELECT count(*) FROM keys_{table} WHERE variants>1'),
                      fields=dict(counts))
        connection.execute('RELEASE load_table')
        return result
    except BaseException:
        connection.execute('ROLLBACK TO load_table')
        connection.execute('RELEASE load_table')
        raise
