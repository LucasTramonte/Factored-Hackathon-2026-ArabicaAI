"""Offline, versioned Jev enrichment; never overwrite bank labels or call a model.

DuckDB performs fact joins under 3GB with spill; SQLite membership streams through
CSV. Only the 546 distinct-text responses are held in Python memory.
"""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile

import duckdb
from data_pipelines.jev_contract import CONFIG_HASH, MODEL, MAPPING, validate_response, HASH, status, validate


def create_view(con):
    """Keep every interaction and invalidate predictions on changed text or identity."""
    con.execute('''CREATE OR REPLACE VIEW enrichment.interaction_labels AS
        SELECT i.interaction_id, i.contact_reason original_contact_reason,
        t.transcript_id, p.primary_intent transcript_intent,
        p.mapped_category transcript_category, p.confidence jev_confidence,
        p.review_status, p.model, p.first_config_hash, p.second_config_hash,
        CASE WHEN t.transcript_id IS NULL THEN 'no_transcript'
             WHEN p.text_hash IS NULL THEN 'stale_or_unclassified'
             WHEN p.review_status <> 'balance_only_supported' THEN 'review_required'
             ELSE 'provisional' END prediction_status,
        'pending' human_adjudication
        FROM silver.fact_call_center_interactions i
        LEFT JOIN silver.fact_call_transcripts t ON i.interaction_id=t.interaction_id
        LEFT JOIN enrichment.jev_members m ON m.transcript_id=t.transcript_id
          AND m.interaction_id=i.interaction_id AND m.customer_id=i.customer_id
          AND m.customer_id=t.customer_id AND m.text_hash=sha256(t.full_text)
        LEFT JOIN enrichment.jev_predictions p ON p.text_hash=m.text_hash''')


def build(db, first, second):
    """Atomically import validated caches; reject duplicate joins and stale inputs."""
    for path in (db, first, second):
        if not path.is_file():
            raise ValueError(f'Missing prerequisite: {path}')
    with sqlite3.connect(first.resolve().as_uri()+'?mode=ro', uri=True) as old, sqlite3.connect(second.resolve().as_uri()+'?mode=ro', uri=True) as new:
        responses = {}
        for h, payload, config in new.execute("SELECT item_id,response_json,config_hash FROM results WHERE stage='corpus'"):
            if h in responses:
                raise ValueError('Duplicate second-pass text hash')
            responses[h] = (json.loads(payload), config)
        predictions=[]
        for h,text,payload,config in old.execute('SELECT text_hash,full_text,response_json,config_hash FROM texts JOIN responses USING(text_hash)'):
            if hashlib.sha256(text.encode()).hexdigest()!=h or config!=CONFIG_HASH:
                raise ValueError('Invalid text or first-pass configuration hash')
            result=json.loads(payload); a=validate_response(result)
            if h not in responses:
                raise ValueError('Missing second-pass prediction')
            second_result, second_hash=responses.pop(h)
            if second_hash!=HASH: raise ValueError('Invalid second-pass configuration hash')
            validate(second_result)
            predictions.append((h,a['choice'],MAPPING[a['choice']],a['confidence'],status(second_result),config,second_hash,MODEL,payload,json.dumps(second_result)))
        if not predictions or responses or len(predictions)!=old.execute('SELECT count(*) FROM texts').fetchone()[0]:
            raise ValueError('Incomplete or unexpected cached predictions')
        with tempfile.TemporaryDirectory(dir=db.parent) as scratch:
            members=Path(scratch)/'members.csv'
            with members.open('w',newline='') as f:
                writer=csv.writer(f);writer.writerow(['transcript_id','interaction_id','customer_id','text_hash'])
                cursor=old.execute('SELECT transcript_id,interaction_id,customer_id,text_hash FROM members')
                while rows:=cursor.fetchmany(2000):writer.writerows(rows)
            with duckdb.connect(str(db)) as con:
                con.execute("SET memory_limit='3GB'");con.execute('SET threads=2')
                con.execute('SET temp_directory=?',[str(db.parent/'duckdb_tmp')])
                con.execute('BEGIN TRANSACTION')
                try:
                    con.execute('CREATE SCHEMA IF NOT EXISTS enrichment')
                    con.execute('CREATE OR REPLACE TABLE enrichment.jev_members AS SELECT * FROM read_csv(?,all_varchar=true)',[str(members)])
                    con.execute('CREATE OR REPLACE TABLE enrichment.jev_predictions(text_hash VARCHAR PRIMARY KEY,primary_intent VARCHAR,mapped_category VARCHAR,confidence DOUBLE,review_status VARCHAR,first_config_hash VARCHAR,second_config_hash VARCHAR,model VARCHAR,first_response_json VARCHAR,second_response_json VARCHAR)')
                    con.executemany('INSERT INTO enrichment.jev_predictions VALUES (?,?,?,?,?,?,?,?,?,?)',predictions)
                    for table in ('silver.fact_call_center_interactions','silver.fact_call_transcripts','enrichment.jev_members'):
                        n,ids=con.execute(f'SELECT count(*),count(DISTINCT interaction_id) FROM {table}').fetchone()
                        if n!=ids:raise ValueError('Nonunique/null interaction key: '+table)
                    for table in ('silver.fact_call_transcripts', 'enrichment.jev_members'):
                        n, ids = con.execute(f'SELECT count(*), count(DISTINCT transcript_id) FROM {table}').fetchone()
                        if n != ids:
                            raise ValueError('Nonunique/null transcript key: ' + table)
                    unmatched = con.execute("""SELECT count(*) FROM enrichment.jev_members m
                        FULL JOIN enrichment.jev_predictions p USING(text_hash)
                        WHERE m.transcript_id IS NULL OR p.text_hash IS NULL""").fetchone()[0]
                    if unmatched:
                        raise ValueError('Incomplete membership/prediction coverage')
                    invalid=con.execute('''SELECT count(*) FROM enrichment.jev_members m
                        LEFT JOIN silver.fact_call_transcripts t USING(transcript_id)
                        LEFT JOIN silver.fact_call_center_interactions i ON i.interaction_id=m.interaction_id
                        WHERE t.transcript_id IS NULL OR i.interaction_id IS NULL
                        OR m.interaction_id IS DISTINCT FROM t.interaction_id
                        OR m.customer_id IS DISTINCT FROM t.customer_id
                        OR m.customer_id IS DISTINCT FROM i.customer_id
                        OR m.text_hash IS DISTINCT FROM sha256(t.full_text)''').fetchone()[0]
                    if invalid:raise ValueError(f'Stale or unmatched cached members: {invalid}')
                    create_view(con)
                    counts=dict(con.execute('SELECT prediction_status,count(*) FROM enrichment.interaction_labels GROUP BY 1').fetchall())
                    if sum(counts.values())!=con.execute('SELECT count(*) FROM silver.fact_call_center_interactions').fetchone()[0]:raise ValueError('Join expanded population')
                    con.execute('COMMIT')
                    return counts
                except Exception:
                    con.execute('ROLLBACK');raise


def main():
    """Build the opt-in enrichment stage from existing local Jev evidence."""
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db',type=Path,default=Path('data/latam_bank.duckdb'))
    parser.add_argument('--first',type=Path,default=Path('data_foundation/runs/jev-label-audit/audit.sqlite'))
    parser.add_argument('--second',type=Path,default=Path('data_foundation/runs/jev-second-pass/second-pass.sqlite'))
    args=parser.parse_args()
    for path in (args.db,args.first,args.second):
        if not path.is_file():parser.error(f'Missing prerequisite: {path}')
    print(json.dumps(build(args.db,args.first,args.second),indent=2))


if __name__=='__main__':main()
