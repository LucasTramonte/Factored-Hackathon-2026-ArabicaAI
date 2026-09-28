"""Protect reconciliation against changed evidence and join multiplication."""
import duckdb
import pytest
from data_foundation.src.silver_transcript_audit import reconcile


def test_reconciliation_and_duplicate_guard():
    """Changed text/labels and removed rows must remain visible; duplicate keys fail."""
    con = duckdb.connect()
    con.execute('CREATE TABLE current_rows(transcript_id VARCHAR, interaction_id VARCHAR, customer_id VARCHAR, text_hash VARCHAR, contact_reason VARCHAR)')
    con.execute('CREATE TABLE previous(transcript_id VARCHAR, interaction_id VARCHAR, customer_id VARCHAR, text_hash VARCHAR, contact_reason VARCHAR)')
    con.execute("INSERT INTO previous VALUES ('a','i1','c','h1','Queja'),('b','i2','c','h2','Producto'),('c','i3','c','h3','Técnico')")
    con.execute("INSERT INTO current_rows VALUES ('a','i1','c','h1','Queja'),('b','i2','c','changed','Transaccional'),('d','i4','c','h4','Queja')")
    result = reconcile(con)
    assert result == dict(matched=2, added=1, removed=1, changed_text=1, changed_label=1, changed_interaction=0, changed_customer=0)
    con.execute("INSERT INTO current_rows VALUES ('e','i4','c','h5','Queja')")
    with pytest.raises(ValueError, match='unique'):
        reconcile(con)


def test_complete_audit_on_controlled_snapshot(tmp_path):
    """Exercise every report query and refuse a failed quality gate before a full scan."""
    import hashlib
    import json
    import sqlite3
    from datetime import datetime, timezone
    from data_pipelines.quality.contracts import CONTRACTS
    from data_pipelines.quality.run_quality import main as quality_main
    from data_pipelines.silver.table_specs import ALL_SPECS
    from data_pipelines.silver.silver import build_fx_rates_table, build_silver_table
    from data_foundation.src.silver_transcript_audit import TABLES, audit
    db = tmp_path/'fixture.duckdb'
    con = duckdb.connect(str(db))
    con.execute('CREATE SCHEMA bronze; CREATE SCHEMA silver')
    specs = {s.name:s for s in ALL_SPECS}
    for name in TABLES:
        fields = set(CONTRACTS[name].expected_columns)
        if name in specs:
            fields.update(col.source.split(".")[-1] for col in specs[name].columns)
        fields.update(('_source_file','_source_table'))
        if name == 'daily_exchange_rates':
            fields.update(('date','source_currency','target_currency','exchange_rate','buy_rate','sell_rate','source'))
        ddl = ','.join('"'+field+'" VARCHAR' for field in sorted(fields))
        con.execute(f'CREATE TABLE bronze.{name} ({ddl}, _ingested_at TIMESTAMPTZ)')
    text = 'Cliente: Quiero consultar mi saldo.'
    for name, extra in [
        ('call_center_interactions',dict(interaction_id='i',interaction_date='2025-01-01',contact_reason='Producto',reason_category='Producto',channel='Phone',has_transcript='true',requires_followup='false',was_escalated='false')),
        ('call_transcripts',dict(transcript_id='t',interaction_id='i',full_text=text,detected_language='es'))]:
        row = {key:'x' for key in CONTRACTS[name].required}
        row.update(customer_id='c',agent_id='a',process_date='2025-01-01',_source_file='year=2025/month=01/day=01/a.csv',_ingested_at=datetime.now(timezone.utc),**extra)
        con.execute(f"INSERT INTO bronze.{name} ({','.join(row)}) VALUES ({','.join('?' for _ in row)})",list(row.values()))
    build_fx_rates_table(con)
    for name in TABLES:
        if name in specs:
            build_silver_table(con,specs[name])
    con.close()
    assert quality_main(['--db',str(db),'--output-root',str(tmp_path/'quality'),'--run-id','fixture','--tables',','.join(TABLES)]) == 0
    previous=tmp_path/'old.sqlite'
    h=hashlib.sha256(text.encode()).hexdigest()
    with sqlite3.connect(previous) as old:
        old.executescript('CREATE TABLE members(transcript_id,interaction_id,customer_id,text_hash); CREATE TABLE original_labels(interaction_id,contact_reason); CREATE TABLE responses(text_hash,response_json);')
        old.execute('INSERT INTO members VALUES (?,?,?,?)',('t','i','c',h))
        old.execute("INSERT INTO original_labels VALUES ('i','Producto')")
        old.execute('INSERT INTO responses VALUES (?,?)',(h,json.dumps({'answers':{'intent':{'choice':'balance_inquiry'}}})))
    sample=tmp_path/'sample.json'
    sample.write_text(json.dumps([dict(transcript_id='t',full_text=text,contact_reason='Producto')]))
    quality=tmp_path/'quality/fixture/quality_results.json'
    output=tmp_path/'audit'
    audit(db,quality,previous,sample,output)
    result=json.loads((output/'summary.json').read_text())
    assert result['historical_comparison']['matched']==1
    assert result['original_sample']==dict(sample_size=1,missing=0,changed_text=0,changed_label=0)
    assert result['labels_vs_saved_jev']==[dict(contact_reason='Producto',intent='balance_inquiry',interactions=1)]
    gate=json.loads(quality.read_text()); gate['metadata']['ready']=False; quality.write_text(json.dumps(gate))
    with pytest.raises(ValueError,match='quality gate'):
        audit(db,quality,previous,sample,tmp_path/'blocked')
