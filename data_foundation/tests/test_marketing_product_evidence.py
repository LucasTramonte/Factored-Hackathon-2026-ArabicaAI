"""Focused denominator, join and session-order regressions for the Silver report."""
import duckdb
import json

from data_foundation.src.marketing_product_evidence import analyze
from data_foundation.src.marketing_product_insights import paired_month_change, summarize_insights
from data_foundation.src.marketing_product_report import marketing_product, hub, complete_activity_rows, complete_intake_years, write_reports
from data_foundation.scripts.run_marketing_product import validate_quality_identity, published_manifest
from data_foundation.scripts import run_marketing_product as report_runner
from datetime import datetime, timezone, timedelta
from pathlib import Path
import pytest


@pytest.fixture
def con():
    """Close the in-memory DuckDB even when a regression assertion fails."""
    connection = duckdb.connect(':memory:')
    try:
        yield connection
    finally:
        connection.close()


def test_silver_aggregates_keep_denominators_and_owner_checks(con):
    """Unknown flags, invalid links and unordered sessions cannot inflate outcomes."""
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
    assert d['sessions']['eligible_sessions']==2
    assert (d['sessions']['navigation_view'],d['sessions']['click_after_view'],d['sessions']['submit_after_click'])==(2,2,2)
    assert data['intake']['populations'][1]['complaints']==1
    assert data['economics']['send_cost_known']==1
    assert data['economics']['campaign_budget_known']==1
    assert data['economics']['pre_registration_sends']==1
    assert {row['registration_timing']:row['sends'] for row in data['economics']['registration_sensitivity']}=={'before registration':1,'on or after registration':1}
    rendered=marketing_product(data)
    assert 'Recorded conversion' in rendered
    assert 'CAC' in rendered and 'LTV' in rendered
    assert 'What the synthetic data tells us' in rendered
    assert 'Product: feature-use analysis is blocked' in rendered
    assert 'Marketing: audit channel measurement first' in rendered
    assert rendered.index('What the synthetic data tells us') < rendered.index('What is measurable by month or year?')
    assert '100.00% of 2 eligible sessions' in rendered
    assert 'id="time-year"' in rendered and 'id="time-month"' in rendered
    assert 'const sendMonths=' in rendered and 'Monthly send trend by business date</summary>' not in rendered
    assert 'C1' not in rendered and 'P1' not in rendered


def test_complete_intake_years_excludes_partial_boundaries_and_missing_months():
    """The opening compares only fully observed, unique calendar months."""
    rows = [{'month': f'{year}-{month:02d}-01', 'v1': 1}
            for year in (2023, 2024, 2025, 2026) for month in range(1, 13)]
    intake = {'populations': [{'population': 'V1: Cargo no reconocido',
                               'first_created': '2023-06-17', 'last_created': '2026-06-18'}],
              'monthly': rows}
    assert complete_intake_years(intake) == [{'year': 2024, 'v1': 12},
                                              {'year': 2025, 'v1': 12}]
    intake['monthly'] = [row for row in rows if row['month'] != '2025-05-01']
    assert complete_intake_years(intake) == [{'year': 2024, 'v1': 12}]



def test_paired_month_bootstrap_requires_complete_matched_years():
    """Varied matched months distinguish pairing and denominator weighting."""
    rows = []
    for year in (2024, 2025):
        for month in range(1, 13):
            numerator, denominator = (
                (month + 2, 60 + 5 * month) if year == 2024
                else (3 * month + (10 if month % 3 == 0 else 1), 75 + 8 * month)
            )
            rows.append({'month': f'{year}-{month:02d}-01',
                         'n': numerator, 'd': denominator})
    options = {'first_date': '2023-06-17', 'last_date': '2026-06-18',
               'seed': 7, 'draws': 100}
    change = paired_month_change(rows, 'n', 'd', **options)
    assert (change['earlier_numerator'], change['earlier_denominator']) == (102, 1110)
    assert (change['later_numerator'], change['later_denominator']) == (282, 1524)
    assert change['observed_change_pp'] == pytest.approx(9.314747818684825)
    ci = change['conditional_monthly_mean_ci_95_pp']
    assert (ci['estimate'], ci['lower'], ci['upper']) == pytest.approx(
        (8.565738408388363, 5.4411581469974895, 11.690318669779236)
    )
    assert ci['estimate'] != pytest.approx(change['observed_change_pp'])
    assert (ci['pairs'], ci['degrees_of_freedom']) == (12, 11)
    assert change['leave_one_month_out_change_pp'] == pytest.approx(
        {'min': 8.553830992855382, 'max': 9.818474012929617}
    )
    assert change['half_year_change_pp'] == pytest.approx(
        {'jan_jun': 6.980895709364234, 'jul_dec': 10.825504389342369}
    )
    quantiles = change['resampled_change_pp']
    assert quantiles == pytest.approx({
        'p2_5': 6.207276663718334, 'p20': 7.715924212660793,
        'p50': 9.105689057234917, 'p80': 10.295213326773037,
        'p97_5': 11.479490927852783,
    })
    # The same seed gives different medians if years are sampled separately
    # or monthly rates are averaged without their denominators.
    assert quantiles['p50'] != pytest.approx(8.675717665336673)
    assert quantiles['p50'] != pytest.approx(8.281624231683852)
    assert paired_month_change(rows[:-1], 'n', 'd', **options) is None
    assert paired_month_change(rows + [rows[-1]], 'n', 'd', **options) is None
    assert paired_month_change(rows, 'n', 'd', **{**options, 'first_date': '2024-02-01'}) is None


def test_report_direction_and_interval_claims_follow_values():
    """Headlines and zero-inclusion text must survive a refreshed aggregate."""
    data = json.loads(
        (Path(__file__).resolve().parents[1] / 'reports' / 'aggregates.json').read_text()
    )
    for difference, verb in ((1, 'rose'), (-1, 'fell'), (0, 'was unchanged')):
        insights = summarize_insights(data)
        activity = insights['product']['activity_continuation_change']
        activity['observed_change_pp'] = difference
        activity['later_rate_pct'] = activity['earlier_rate_pct'] + difference
        headline = f'Product: repeat transaction activity {verb}'
        assert headline in marketing_product(data, insights)
        assert f'adjacent-month transaction activity {verb}' in hub(data, insights)

    insights = summarize_insights(data)
    ci = insights['marketing']['recorded_conversion_change']['conditional_monthly_mean_ci_95_pp']
    ci['lower'], ci['upper'] = 0.01, 0.02
    assert 'Zero is inside the interval.' not in marketing_product(data, insights)
    ci['lower'] = -0.01
    assert 'Zero is inside the interval.' in marketing_product(data, insights)


def test_curated_report_and_simulation_match_published_aggregates(tmp_path):
    """A reviewed HTML release must remain reproducible from its source JSON."""
    published = Path(__file__).resolve().parents[1] / 'reports'
    data = json.loads((published / 'aggregates.json').read_text())
    expected = summarize_insights(data)
    assert json.loads((published / 'marketing-product-insights.json').read_text()) == expected
    write_reports(data, tmp_path)
    for name in ('aggregates.json', 'marketing-product-insights.json',
                 'index.html', 'marketing-product.html', 'intake-decision.html'):
        assert (tmp_path / name).read_bytes() == (published / name).read_bytes()
    html = (published / 'marketing-product.html').read_text()
    assert html.index('What the synthetic data tells us') < html.index('What is measurable by month or year?')
    assert 'conditional 95% CI +2.56 to +3.58' in html
    assert 'conditional 95% CI -0.115 to +0.034' in html
    product_ci = expected['product']['activity_continuation_change']['conditional_monthly_mean_ci_95_pp']
    marketing_ci = expected['marketing']['recorded_conversion_change']['conditional_monthly_mean_ci_95_pp']
    assert (product_ci['lower'], product_ci['upper']) == pytest.approx(
        (2.5625624845687387, 3.58200105430518)
    )
    assert (marketing_ci['lower'], marketing_ci['upper']) == pytest.approx(
        (-0.11454243400205807, 0.03373228566326661)
    )


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


@pytest.mark.parametrize(('field','replacement','expected'), [
    ('ready', False, 'complete, ready'),
    ('errors', 1, 'complete, ready'),
    ('tables', list(range(12)), 'complete, ready'),
    ('database', '/other/database.duckdb', 'different database'),
    ('generated_at_utc', '2000-01-01T00:00:00+00:00', 'modified after'),
])
def test_quality_identity_rejects_bad_provenance(tmp_path, field, replacement, expected):
    """Ready, scope, identity and timestamp must all match before a report scan."""
    db = tmp_path / 'fixture.duckdb'
    db.write_bytes(b'abc')
    metadata = {'ready': True, 'errors': 0, 'tables': list(range(13)),
                'database': str(db), 'database_bytes': 3,
                'generated_at_utc': (datetime.now(timezone.utc) + timedelta(seconds=5)).isoformat()}
    metadata[field] = replacement
    with pytest.raises(ValueError, match=expected):
        validate_quality_identity(db, metadata)


def test_quality_identity_rejects_missing_database(tmp_path):
    """A missing database cannot be accepted even with a ready quality record."""
    db = tmp_path / 'missing.duckdb'
    with pytest.raises(ValueError, match='Database missing'):
        validate_quality_identity(db, {'ready': True})


def test_published_manifest_omits_machine_paths(tmp_path):
    """The shared manifest keeps run identity without exposing local directories."""
    db = tmp_path / 'private' / 'latam_bank.duckdb'
    quality = tmp_path / 'quality_runs' / 'run-17' / 'quality_results.json'
    result = published_manifest({'database': str(db), 'quality_run': str(quality),
                                 'database_bytes': 123}, db, quality)
    assert result['database'] == 'latam_bank.duckdb'
    assert result['quality_run'] == 'run-17/quality_results.json'
    assert str(tmp_path) not in str(result)


def test_complete_activity_excludes_partial_origin_and_final_month():
    """A complete continuation needs two complete adjacent observation months."""
    months = [{'month': f'2023-{m:02d}-01'} for m in (6, 7, 8, 9)]
    activity = {'monthly': months, 'first_transaction': '2023-06-17 06:00:00',
                'last_transaction': '2023-09-18 05:00:00'}
    assert complete_activity_rows(activity) == [months[2]]
    activity['first_transaction'] = '2023-06-01 00:00:00'
    assert complete_activity_rows(activity) == months[1:3]
    activity['last_transaction'] = '2023-09-30 23:59:59'
    assert complete_activity_rows(activity) == months[1:]


def test_report_run_rejects_existing_output_before_scan_and_cleans_spill(tmp_path, monkeypatch):
    """An immutable run fails early; a successful run leaves no shared spill files."""
    db = tmp_path / 'bank.duckdb'
    with duckdb.connect(str(db)) as connection:
        connection.execute('CREATE TABLE marker (id INTEGER)')
    quality = tmp_path / 'quality_runs' / 'run-17' / 'quality_results.json'
    quality.parent.mkdir(parents=True)
    metadata = {'ready': True, 'errors': 0, 'warnings': 0,
                'tables': list(range(13)), 'database': str(db),
                'database_bytes': db.stat().st_size,
                'generated_at_utc': (datetime.now(timezone.utc) + timedelta(seconds=10)).isoformat(),
                'source': 'fixture', 'watermarks': []}
    quality.write_text(json.dumps({'metadata': metadata, 'checks': []}))
    calls = []

    def aggregate(_connection):
        calls.append('scanned')
        return {'silver_counts': {}, 'marketing': {'overall': {'sends': 1}},
                'digital': {'events': {'events': 1}}}

    monkeypatch.setattr(report_runner, 'analyze', aggregate)
    monkeypatch.setattr(report_runner, 'write_reports',
                        lambda _data, path: path.mkdir(parents=True, exist_ok=True))
    output = tmp_path / 'run'
    output.mkdir()
    options = ['--db', str(db), '--quality', str(quality), '--output', str(output)]
    with pytest.raises(FileExistsError):
        report_runner.main(options)
    assert calls == []
    output.rmdir()
    published = tmp_path / 'published'
    assert report_runner.main(options + ['--publish', str(published)]) == 0
    assert calls == ['scanned']
    assert not (output / 'duckdb_tmp').exists()
    shared = json.loads((published / 'manifest.json').read_text())
    assert shared['database'] == 'bank.duckdb'
    assert shared['quality_run'] == 'run-17/quality_results.json'
    assert str(tmp_path) not in str(shared)
