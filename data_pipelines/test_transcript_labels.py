"""Check label coverage, source preservation and invalidation after text changes."""
import duckdb
from data_pipelines.transcript_labels import create_view


def test_current_text_only_and_no_source_overwrite():
    con = duckdb.connect()
    con.execute('CREATE SCHEMA silver; CREATE SCHEMA enrichment')
    con.execute('CREATE TABLE silver.fact_call_center_interactions(interaction_id VARCHAR, customer_id VARCHAR, contact_reason VARCHAR)')
    con.execute("INSERT INTO silver.fact_call_center_interactions VALUES ('i1','c1','Queja'),('i2','c2','Producto'),('i3','c3','Técnico')")
    con.execute('CREATE TABLE silver.fact_call_transcripts(transcript_id VARCHAR,interaction_id VARCHAR,customer_id VARCHAR,full_text VARCHAR)')
    con.execute("INSERT INTO silver.fact_call_transcripts VALUES ('t1','i1','c1','saldo'),('t3','i3','c3','new text')")
    con.execute('CREATE TABLE enrichment.jev_members(transcript_id VARCHAR,interaction_id VARCHAR,customer_id VARCHAR,text_hash VARCHAR)')
    con.execute("INSERT INTO enrichment.jev_members VALUES ('t1','i1','c1',sha256('saldo')),('t3','i3','c3',sha256('old text'))")
    con.execute('CREATE TABLE enrichment.jev_predictions(text_hash VARCHAR,primary_intent VARCHAR,mapped_category VARCHAR,confidence DOUBLE,review_status VARCHAR,first_config_hash VARCHAR,second_config_hash VARCHAR,model VARCHAR)')
    con.execute("INSERT INTO enrichment.jev_predictions VALUES (sha256('saldo'),'balance_inquiry','Transaccional',0.99,'balance_only_supported','a','b','jev-1.13.0')")
    create_view(con)
    assert con.execute('SELECT interaction_id,original_contact_reason,transcript_intent,prediction_status FROM enrichment.interaction_labels ORDER BY interaction_id').fetchall() == [('i1','Queja','balance_inquiry','provisional'),('i2','Producto',None,'no_transcript'),('i3','Técnico',None,'stale_or_unclassified')]
    con.execute("UPDATE silver.fact_call_transcripts SET full_text='changed' WHERE transcript_id='t1'")
    assert con.execute("SELECT transcript_intent FROM enrichment.interaction_labels WHERE interaction_id='i1'").fetchone()[0] is None
    assert con.execute("SELECT contact_reason FROM silver.fact_call_center_interactions WHERE interaction_id='i1'").fetchone()[0]=='Queja'

import hashlib
import json
import sqlite3
import pytest
from data_pipelines.transcript_labels import build
from data_pipelines.jev_contract import MODEL, CONFIG_HASH, HASH, CRITERIA, CHOICES


@pytest.fixture
def caches(tmp_path):
    """Create synthetic cache responses and a tiny current Silver population."""
    db, first, second = (tmp_path / name for name in ('bank.duckdb', 'first.sqlite', 'second.sqlite'))
    text = 'Cliente: Quiero consultar mi saldo.'
    digest = hashlib.sha256(text.encode()).hexdigest()
    answer = {'type': 'choice', 'choice': 'balance_inquiry', 'confidence': 0.99,
              'probabilities': {key: int(key == 'balance_inquiry') for key in CRITERIA}}
    result = {'model': MODEL, 'answers': {'intent': answer}, 'usage': {'input_tokens': 1, 'output_tokens': 1}}
    assessment = {'type': 'choice', 'choice': 'balance_only', 'confidence': 0.99,
                  'probabilities': {key: int(key == 'balance_only') for key in CHOICES}}
    review = {'model': MODEL, 'answers': {'assessment': assessment,
              **{key: {'type': 'noul', 'noul': value} for key, value in
                 [('balance_primary', 0.99), ('substantive_other', 0.01), ('ambiguous_followup', 0.01)]}},
              'usage': {'input_tokens': 1, 'output_tokens': 1}}
    with sqlite3.connect(first) as con:
        con.executescript('CREATE TABLE texts(text_hash,full_text); CREATE TABLE responses(text_hash,response_json,config_hash); CREATE TABLE members(transcript_id,interaction_id,customer_id,text_hash);')
        con.execute('INSERT INTO texts VALUES (?,?)', (digest, text))
        con.execute('INSERT INTO responses VALUES (?,?,?)', (digest, json.dumps(result), CONFIG_HASH))
        con.execute('INSERT INTO members VALUES (?,?,?,?)', ('t1','i1','c1',digest))
    with sqlite3.connect(second) as con:
        con.execute('CREATE TABLE results(item_id,response_json,config_hash,stage)')
        con.execute('INSERT INTO results VALUES (?,?,?,?)', (digest,json.dumps(review),HASH,'corpus'))
    with duckdb.connect(str(db)) as con:
        con.execute('CREATE SCHEMA silver')
        con.execute('CREATE TABLE silver.fact_call_center_interactions(interaction_id VARCHAR,customer_id VARCHAR,contact_reason VARCHAR)')
        con.execute("INSERT INTO silver.fact_call_center_interactions VALUES ('i1','c1','Queja'),('i2','c2','Producto')")
        con.execute('CREATE TABLE silver.fact_call_transcripts(transcript_id VARCHAR,interaction_id VARCHAR,customer_id VARCHAR,full_text VARCHAR)')
        con.execute("INSERT INTO silver.fact_call_transcripts VALUES ('t1','i1','c1',?)", [text])
    return db, first, second


def test_import_and_rerun(caches):
    """Repeated imports retain source labels and expose every interaction exactly once."""
    for _ in range(2):
        assert build(*caches) == {'provisional': 1, 'no_transcript': 1}
    with duckdb.connect(str(caches[0])) as con:
        assert con.execute('SELECT count(*) FROM enrichment.interaction_labels').fetchone()[0] == 2
        assert con.execute("SELECT contact_reason FROM silver.fact_call_center_interactions WHERE interaction_id='i1'").fetchone()[0] == 'Queja'
        assert con.execute('SELECT DISTINCT human_adjudication FROM enrichment.interaction_labels').fetchall() == [('pending',)]


@pytest.mark.parametrize('which,sql', [
    (1, "UPDATE texts SET full_text='tampered'"),
    (1, "UPDATE responses SET config_hash='wrong'"),
    (2, "UPDATE results SET config_hash='wrong'"),
    (2, 'INSERT INTO results SELECT * FROM results'),
    (2, 'DELETE FROM results'),
    (1, 'INSERT INTO members SELECT * FROM members'),
    (1, "UPDATE members SET customer_id='wrong'"),
    (1, "UPDATE members SET text_hash='missing'"),
    (1, 'DELETE FROM members'),
    (1, "UPDATE responses SET response_json='{}'"),
])
def test_bad_cache_preserves_published_enrichment(caches, which, sql):
    """Invalid caches must not replace the last successful enrichment tables."""
    before = build(*caches)
    with sqlite3.connect(caches[which]) as con:
        con.execute(sql)
    with pytest.raises((ValueError, KeyError)):
        build(*caches)
    with duckdb.connect(str(caches[0])) as con:
        assert dict(con.execute('SELECT prediction_status,count(*) FROM enrichment.interaction_labels GROUP BY 1').fetchall()) == before
        assert con.execute('SELECT count(*) FROM enrichment.jev_members').fetchone()[0] == 1


def test_missing_cache_is_not_created(caches):
    missing = caches[1].with_name('missing.sqlite')
    with pytest.raises(ValueError, match='Missing prerequisite'):
        build(caches[0], missing, caches[2])
    assert not missing.exists()


def test_reject_duplicate_transcript_id(caches):
    with duckdb.connect(str(caches[0])) as con:
        con.execute("INSERT INTO silver.fact_call_transcripts SELECT transcript_id,'i2','c2',full_text FROM silver.fact_call_transcripts")
    with pytest.raises(ValueError, match='transcript key'):
        build(*caches)
