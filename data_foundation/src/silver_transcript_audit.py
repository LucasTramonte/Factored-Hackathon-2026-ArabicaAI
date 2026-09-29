"""Reconcile Silver transcript evidence with saved Jev inputs, without model calls.

DuckDB owns scans/joins under a 3GB limit with disk spill. Python holds bounded
SQLite batches, 100 sample rows and aggregate results; source stores are read-only.
"""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile

import duckdb

TABLES = ('customers', 'products', 'branches', 'service_agents', 'daily_exchange_rates',
          'call_center_interactions', 'call_transcripts', 'complaints')


def records(con, sql, params=()):
    """Return small aggregate queries as dictionaries, never entire fact tables."""
    cur = con.execute(sql, list(params))
    names = [col[0] for col in cur.description]
    return [dict(zip(names, row)) for row in cur.fetchall()]


def reconcile(con):
    """Compare current_rows with previous at unique transcript/interaction grain."""
    for table in ('current_rows', 'previous'):
        n, transcripts, interactions = con.execute(
            f'SELECT count(*),count(DISTINCT transcript_id),count(DISTINCT interaction_id) FROM {table}'
        ).fetchone()
        if n != transcripts or n != interactions:
            raise ValueError(f'{table}: transcript and interaction keys must be unique and nonnull')
    return records(con, '''SELECT
        count(*) FILTER(WHERE c.transcript_id IS NOT NULL AND p.transcript_id IS NOT NULL) AS "matched",
        count(*) FILTER(WHERE p.transcript_id IS NULL) added,
        count(*) FILTER(WHERE c.transcript_id IS NULL) removed,
        count(*) FILTER(WHERE c.transcript_id IS NOT NULL AND p.transcript_id IS NOT NULL AND c.text_hash IS DISTINCT FROM p.text_hash) changed_text,
        count(*) FILTER(WHERE c.transcript_id IS NOT NULL AND p.transcript_id IS NOT NULL AND c.contact_reason IS DISTINCT FROM p.contact_reason) changed_label,
        count(*) FILTER(WHERE c.transcript_id IS NOT NULL AND p.transcript_id IS NOT NULL AND c.interaction_id IS DISTINCT FROM p.interaction_id) changed_interaction,
        count(*) FILTER(WHERE c.transcript_id IS NOT NULL AND p.transcript_id IS NOT NULL AND c.customer_id IS DISTINCT FROM p.customer_id) changed_customer
        FROM current_rows c FULL OUTER JOIN previous p USING(transcript_id)''')[0]


def export_previous(path, destination):
    """Stream saved API membership plus original labels to a temporary local CSV."""
    with sqlite3.connect(path.resolve().as_uri()+'?mode=ro', uri=True) as old:
        cursor = old.execute('''SELECT m.transcript_id,m.interaction_id,m.customer_id,m.text_hash,l.contact_reason
            FROM members m JOIN original_labels l USING(interaction_id)''')
        with destination.open('w', newline='') as stream:
            writer = csv.writer(stream)
            writer.writerow([col[0] for col in cursor.description])
            while batch := cursor.fetchmany(2000):
                writer.writerows(batch)
        return [dict(text_hash=h, intent=json.loads(response)['answers']['intent']['choice'])
                for h, response in old.execute('SELECT text_hash,response_json FROM responses')]


def audit(db, quality, previous, sample, output):
    """Require a matching successful quality gate and write aggregate-only evidence."""
    gate = json.loads(quality.read_text())['metadata']
    if (not gate['ready'] or gate['errors'] or Path(gate['database']).resolve() != db.resolve()
            or gate['database_bytes'] != db.stat().st_size or not set(TABLES) <= set(gate['tables'])
            or datetime.fromisoformat(gate['generated_at_utc']).timestamp() < db.stat().st_mtime):
        raise ValueError('Successful current quality gate for all required tables is required')
    output.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(dir=output) as scratch, duckdb.connect(str(db), read_only=True) as con:
        con.execute("SET memory_limit='3GB'")
        con.execute('SET threads=2')
        con.execute('SET temp_directory=?', [str(Path(scratch)/'duckdb_tmp')])
        prior_csv = Path(scratch)/'previous.csv'
        predictions = export_previous(previous, prior_csv)
        con.execute('CREATE TEMP TABLE previous AS SELECT * FROM read_csv(?,all_varchar=true)', [str(prior_csv)])
        con.execute('CREATE TEMP TABLE predictions(text_hash VARCHAR PRIMARY KEY, intent VARCHAR)')
        con.executemany('INSERT INTO predictions VALUES (?,?)', [(p['text_hash'],p['intent']) for p in predictions])
        con.execute('''CREATE TEMP VIEW current_rows AS SELECT t.transcript_id,t.interaction_id,t.customer_id,
            sha256(t.full_text) text_hash,i.contact_reason FROM silver.fact_call_transcripts t
            LEFT JOIN silver.fact_call_center_interactions i USING(interaction_id)''')
        result = {'generated_at_utc': datetime.now(timezone.utc).isoformat(),
                  'code_commit': subprocess.check_output(['git','rev-parse','HEAD'], text=True).strip(),
                  'database': str(db.resolve()), 'quality_report': str(quality.resolve()),
                  'quality_warnings': gate['warnings'], 'scope': list(TABLES),
                  'audit_script_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                  'historical_comparison': reconcile(con)}
        result['row_reconciliation'] = [c for c in json.loads(quality.read_text())['checks']
            if c['check'] in ('row_count','silver_row_count','duplicate_primary_keys','silver_row_delta_unexplained')]
        result['population'] = records(con, '''SELECT
            (SELECT count(*) FROM silver.fact_call_center_interactions) interactions,
            count(*) transcripts,count(DISTINCT t.full_text) unique_full_texts,
            count(*) FILTER(WHERE t.full_text IS NULL) missing_text,
            count(*) FILTER(WHERE i.interaction_id IS NULL) unmatched_interactions,
            count(*) FILTER(WHERE i.interaction_id IS NOT NULL AND t.customer_id IS DISTINCT FROM i.customer_id) customer_mismatch,
            min(i.interaction_date) earliest_interaction,max(i.interaction_date) latest_interaction
            FROM silver.fact_call_transcripts t LEFT JOIN silver.fact_call_center_interactions i USING(interaction_id)''')[0]
        result['bronze_silver_changes'] = []
        for table, key, fields in [
            ('call_transcripts','transcript_id',('interaction_id','customer_id','full_text','customer_text','agent_text','detected_language','detected_intents','main_topics')),
            ('call_center_interactions','interaction_id',('customer_id','contact_reason','reason_category'))]:
            changed = ', '.join(f'count(*) FILTER(WHERE b.{f} IS DISTINCT FROM s.{f}) AS "{f}"' for f in fields)
            row = records(con, f'''SELECT count(*) AS "matched", {changed}
                FROM bronze.{table} b JOIN silver.fact_{table} s USING({key})''')[0]
            for field in fields:
                result['bronze_silver_changes'].append(dict(table=table, field=field, matched=row['matched'], changed=row[field]))
        result['transcript_flags'] = records(con, """SELECT count(*) interactions,
            count(*) FILTER(WHERE i.has_transcript IS TRUE) flagged,
            count(*) FILTER(WHERE i.has_transcript IS TRUE AND t.transcript_id IS NULL) flagged_but_missing,
            count(*) FILTER(WHERE t.transcript_id IS NOT NULL AND i.has_transcript IS DISTINCT FROM TRUE) present_but_not_flagged
            FROM silver.fact_call_center_interactions i
            LEFT JOIN silver.fact_call_transcripts t USING(interaction_id)""")[0]
        result['category_fields'] = records(con, '''SELECT count(*) n,
            count(*) FILTER(WHERE contact_reason IS DISTINCT FROM reason_category) different
            FROM silver.fact_call_center_interactions''')[0]
        result['text_groups'] = records(con, '''SELECT count(*) AS "groups",
            count(*) FILTER(WHERE label_count>1) groups_with_multiple_labels FROM
            (SELECT t.full_text,count(DISTINCT i.contact_reason) label_count FROM silver.fact_call_transcripts t
             JOIN silver.fact_call_center_interactions i USING(interaction_id) GROUP BY t.full_text)''')[0]
        result['labels_vs_saved_jev'] = records(con, '''SELECT c.contact_reason,p.intent,count(*) interactions
            FROM current_rows c LEFT JOIN predictions p USING(text_hash) GROUP BY ALL ORDER BY 1,2''')
        result['text_signal'] = records(con, """SELECT
            count(DISTINCT customer_text) unique_customer_texts,
            count(DISTINCT split_part(full_text, chr(10), 1)) unique_opening_lines,
            count(*) FILTER(WHERE regexp_matches(full_text, '[{][^{}]+[}]')) unresolved_template_records
            FROM silver.fact_call_transcripts""")[0]
        result['languages'] = records(con, 'SELECT detected_language,count(*) n FROM silver.fact_call_transcripts GROUP BY 1 ORDER BY 1')
        result['complaints'] = records(con, 'SELECT category,subcategory,count(*) n FROM silver.fact_complaints GROUP BY 1,2 ORDER BY n DESC')
        result['complaint_owner_link'] = records(con, '''SELECT count(*) linked_pairs,
            count(*) FILTER(WHERE c.customer_id IS DISTINCT FROM p.customer_id) owner_mismatch
            FROM silver.fact_complaints c JOIN silver.dim_products p ON c.affected_product_id=p.product_id''')[0]
        sample_rows = json.loads(sample.read_text())
        con.execute('CREATE TEMP TABLE sample_old(transcript_id VARCHAR PRIMARY KEY, full_text VARCHAR, contact_reason VARCHAR)')
        con.executemany('INSERT INTO sample_old VALUES (?,?,?)', [(r['transcript_id'],r['full_text'],r['contact_reason']) for r in sample_rows])
        result['original_sample'] = records(con, '''SELECT count(*) sample_size,
            count(*) FILTER(WHERE t.transcript_id IS NULL) missing,
            count(*) FILTER(WHERE t.transcript_id IS NOT NULL AND t.full_text IS DISTINCT FROM o.full_text) changed_text,
            count(*) FILTER(WHERE t.transcript_id IS NOT NULL AND i.contact_reason IS DISTINCT FROM o.contact_reason) changed_label
            FROM sample_old o LEFT JOIN silver.fact_call_transcripts t USING(transcript_id)
            LEFT JOIN silver.fact_call_center_interactions i ON t.interaction_id=i.interaction_id''')[0]
        result['source_inventory'] = records(con, '''SELECT 'call_transcripts' table_name,count(*) AS "rows",
            count(DISTINCT _source_file) source_files,CAST(min(_ingested_at) AS VARCHAR) first_ingested,CAST(max(_ingested_at) AS VARCHAR) last_ingested
            FROM bronze.call_transcripts UNION ALL SELECT 'call_center_interactions',count(*),
            count(DISTINCT _source_file),CAST(min(_ingested_at) AS VARCHAR),CAST(max(_ingested_at) AS VARCHAR) FROM bronze.call_center_interactions''')
        result['limits'] = ('Fresh S3 through main Bronze/Silver; scoped quality gate, not full 13-table readiness. '
            'Saved Jev outputs reused only by exact SHA256 text match; no new API calls. '
            'Mapping disagreement is not label error; repeated model output is not human gold. '
            'No inference about interactions without transcripts or real customer demand.')
        (output/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,default=str)+'\n')
        print(json.dumps(result,ensure_ascii=False,indent=2,default=str))


def main():
    """Run the audit against explicit local evidence paths and a quality report."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db',type=Path,default=Path('data/latam_bank.duckdb'))
    parser.add_argument('--quality',type=Path,required=True)
    parser.add_argument('--previous',type=Path,default=Path('data_foundation/runs/jev-label-audit/audit.sqlite'))
    parser.add_argument('--sample',type=Path,default=Path('data_foundation/runs/intake-review/sample.json'))
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    audit(args.db,args.quality,args.previous,args.sample,args.output)


if __name__ == '__main__':
    main()
