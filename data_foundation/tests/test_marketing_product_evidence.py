"""Focused denominator, join and session-order regressions for the Silver report."""
import duckdb

from data_foundation.src.marketing_product_evidence import analyze
from data_foundation.src.marketing_product_report import marketing_product
from data_foundation.scripts.run_marketing_product import validate_quality_identity
from datetime import datetime, timezone, timedelta
import pytest


def test_silver_aggregates_keep_denominators_and_owner_checks():
    """Unknown flags, invalid links and unordered sessions cannot inflate outcomes."""
    con = duckdb.connect(':memory:')
    con.execute('CREATE SCHEMA silver')
    con.execute("""CREATE TABLE silver.dim_customers AS SELECT * FROM (VALUES
      ('C1','Retail','México',FALSE,TIMESTAMP '2024-01-01'),('C2','Retail','Colombia',TRUE,TIMESTAMP '2024-02-03'))
      t(customer_id,segment,country,accepts_marketing,registration_date)""")
    con.execute("""CREATE TABLE silver.dim_marketing_campaigns AS SELECT * FROM (VALUES
      ('M1','Adoption','Retail','México',DATE '2024-01-01',DATE '2024-01-31',100.0))
      t(campaign_id,campaign_objective,target_segment,target_country,start_date,end_date,budget)""")
    con.execute("""CREATE TABLE silver.fact_campaign_sends AS SELECT * FROM (VALUES
      ('S1','C1','M1',TIMESTAMP '2024-01-02',DATE '2024-01-03','Email',TRUE,TRUE,NULL,TRUE,TIMESTAMP '2024-01-04',NULL,0.2),
      ('S2','C2','M1',TIMESTAMP '2024-02-02',DATE '2024-02-02','SMS',NULL,NULL,NULL,FALSE,NULL,NULL,NULL))
      t(send_id,customer_id,campaign_id,send_date,process_date,send_channel,was_delivered,was_opened,was_clicked,had_conversion,conversion_date,conversion_value,send_cost)""")
    con.execute("""CREATE TABLE silver.dim_products AS SELECT * FROM (VALUES
      ('P1','C1','Checking','Active',DATE '2024-01-02',TRUE),('P2','C2','Savings','Active',DATE '2024-01-01',NULL))
      t(product_id,customer_id,product_type,product_status,opening_date,has_linked_app)""")
    con.execute("""CREATE TABLE silver.fact_transactions AS SELECT * FROM (VALUES
      ('T1','P1','C1',TIMESTAMP '2024-01-03','Approved'),('T2','P1','C2',TIMESTAMP '2024-01-03','Approved'),
      ('T3','P1','C1',TIMESTAMP '2024-01-01','Approved'),('T4','P1','C1',TIMESTAMP '2024-02-03','Approved'),
      ('T5','P2','C2',TIMESTAMP '2024-03-03','Approved')) t(transaction_id,product_id,customer_id,transaction_date,transaction_status)""")
    con.execute("""CREATE TABLE silver.fact_digital_events AS SELECT * FROM (VALUES
      ('E1','C1','A',TIMESTAMP '2024-01-01 10:00','PageView','Navigation','x',NULL,DATE '2024-01-01'),
      ('E2','C1','A',TIMESTAMP '2024-01-01 10:01','Click','Product',NULL,'P2',DATE '2024-01-01'),
      ('E3','C1','A',TIMESTAMP '2024-01-01 10:02','FormSubmit','Transaction','x',NULL,DATE '2024-01-01'),
      ('E4','C2','B',TIMESTAMP '2024-01-01 10:00','Click','Product','x',NULL,DATE '2024-01-01'),
      ('E5','C2','B',TIMESTAMP '2024-01-01 10:01','PageView','Navigation','x',NULL,DATE '2024-01-01'),
      ('E6','C2','B',TIMESTAMP '2024-01-01 10:02','Click','Product','x',NULL,DATE '2024-01-01'),
      ('E7','C2','B',TIMESTAMP '2024-01-01 10:03','FormSubmit','Transaction','x',NULL,DATE '2024-01-01'),
      ('E8',NULL,'D',TIMESTAMP '2024-01-01 10:00','PageView','Navigation','x',NULL,DATE '2024-01-01'),
      ('E9','C1','D',TIMESTAMP '2024-01-01 10:01','Click','Product','x',NULL,DATE '2024-01-01'),
      ('E10','C1','D',TIMESTAMP '2024-01-01 10:02','FormSubmit','Transaction','x',NULL,DATE '2024-01-01'))
      t(event_id,customer_id,session_id,event_date,event_type,event_category,action,product_id,process_date)""")
    con.execute("""CREATE TABLE silver.fact_complaints AS SELECT * FROM (VALUES
      ('Q1','Cargo no reconocido','Call Center',TRUE,NULL,NULL,TIMESTAMP '2024-01-01'),
      ('Q2','Cobro indebido','Web',FALSE,NULL,NULL,TIMESTAMP '2024-01-02'))
      t(complaint_id,subcategory,reception_channel,sla_breached,origin_interaction_id,claimed_amount,creation_date)""")
    data=analyze(con)
    m=data['marketing']; p=data['products']; d=data['digital']
    assert m['overall']['sends']==2
    assert (m['overall']['delivered'],m['overall']['delivery_known'])==(1,1)
    assert (m['overall']['opens'],m['overall']['open_known'])==(1,1)
    assert (m['overall']['recorded_conversions'],m['overall']['conversion_known'])==(1,2)
    assert m['quality']['outside_campaign_dates']==1
    assert m['monthly'][0]['delivered']==1
    assert m['quality']['current_opt_out_sends']==1
    assert p['transaction_activity']['eligible_transactions']==3
    assert data['activity']['monthly'][0]['active_customers']==1
    assert data['activity']['monthly'][1]['continuing_customers']==1
    assert data['activity']['monthly'][1]['prior_active_customers']==1
    assert data['activity']['monthly'][2]['continuing_customers']==0
    assert data['activity']['monthly'][2]['prior_active_customers']==1
    assert p['transaction_activity']['owner_mismatch']==1
    assert p['transaction_activity']['before_opening']==1
    assert d['product_links']['owner_mismatch']==1
    assert d['sessions']['mixed_identity_sessions']==1
    assert (d['sessions']['navigation_view'],d['sessions']['click_after_view'],d['sessions']['submit_after_click'])==(2,2,2)
    assert data['intake']['populations'][1]['complaints']==1
    assert data['economics']['send_cost_known']==1
    assert data['economics']['campaign_budget_known']==1
    assert data['economics']['pre_registration_sends']==1
    assert {row['registration_timing']:row['sends'] for row in data['economics']['registration_sensitivity']}=={'before registration':1,'on or after registration':1}
    rendered=marketing_product(data)
    assert 'Recorded conversion' in rendered
    assert 'CAC' in rendered and 'LTV' in rendered
    assert 'Start with the chosen customer workflow' in rendered
    assert 'Checklist versus AI evaluation' in rendered
    assert 'safe accepted intake' in rendered
    assert 'id="time-year"' in rendered and 'id="time-month"' in rendered
    assert 'const sendMonths=' in rendered and 'Monthly send trend by business date</summary>' not in rendered
    assert 'C1' not in rendered and 'P1' not in rendered


def test_quality_identity_rejects_stale_database(tmp_path):
    """A report cannot reuse a ready quality result after the DB changes."""
    db=tmp_path/'fixture.duckdb';db.write_bytes(b'abc')
    metadata={'ready':True,'errors':0,'tables':list(range(13)),
      'database':str(db),'database_bytes':3,
      'generated_at_utc':(datetime.now(timezone.utc)+timedelta(seconds=5)).isoformat()}
    validate_quality_identity(db,metadata)
    db.write_bytes(b'abcd')
    with pytest.raises(ValueError,match='size changed'):
        validate_quality_identity(db,metadata)
