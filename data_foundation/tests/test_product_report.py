"""Window, currency, suppression and identifier regressions for the product report."""
import json
from datetime import datetime, timedelta, timezone

import duckdb
import pytest

from data_foundation.scripts import run_product_report
from data_foundation.src.product_report import build, render

IDS = ('CUST-1', 'CUST-2', 'CUST-3', 'CMP-1', 'CMP-2', 'CMP-3', 'CMP-4', 'CMP-5', 'CMP-6', 'INT-1', 'INT-2', 'INT-3', 'SRV-1', 'SRV-2', 'SRV-3')


def _fixture(con):
    """Six complaints (one in the holdout), three contacts and three surveys (one in the holdout)."""
    con.execute('CREATE SCHEMA silver')
    con.execute("""CREATE TABLE silver.fact_complaints AS SELECT * FROM (VALUES
      ('CMP-1','CUST-1','Cargo no reconocido',TIMESTAMP '2024-01-10',100.0,'USD','Resolved',TIMESTAMP '2024-01-10',TIMESTAMP '2024-01-11',TIMESTAMP '2024-01-20',NULL::TIMESTAMP,FALSE,10.0,NULL::DOUBLE),
      ('CMP-2','CUST-2','Cargo no reconocido',TIMESTAMP '2025-12-20',50.0,'MXN','Closed',TIMESTAMP '2025-12-20',TIMESTAMP '2025-12-21',TIMESTAMP '2026-01-05',TIMESTAMP '2026-01-06',TRUE,16.0,4.0),
      ('CMP-3','CUST-1','Cargo no reconocido',TIMESTAMP '2024-02-01',NULL,NULL,'Escalated',TIMESTAMP '2024-02-01',NULL,NULL,NULL,TRUE,NULL,NULL),
      ('CMP-4','CUST-3','Cargo no reconocido',TIMESTAMP '2026-02-01',70.0,'USD','Escalated',NULL,NULL,NULL,NULL,FALSE,NULL,NULL),
      ('CMP-5','CUST-2','Cobro indebido',TIMESTAMP '2024-03-01',NULL,NULL,'Open',NULL,NULL,NULL,NULL,FALSE,NULL,NULL),
      ('CMP-6','CUST-1','Cargo no reconocido',TIMESTAMP '2024-05-01',20.0,'USD','Closed',TIMESTAMP '2024-05-01',TIMESTAMP '2024-05-02',TIMESTAMP '2024-05-03',TIMESTAMP '2024-05-10',FALSE,2.0,5.0))
      t(complaint_id,customer_id,subcategory,creation_date,claimed_amount,currency,status,assignment_date,first_response_date,resolution_date,closing_date,sla_breached,resolution_days,resolution_satisfaction)""")
    con.execute("""CREATE TABLE silver.dim_fx_rates AS SELECT * FROM (VALUES (DATE '2025-12-20','MXN','USD',0.05))
      t(rate_date,source_currency,target_currency,exchange_rate)""")
    con.execute("""CREATE TABLE silver.dim_customers AS SELECT * FROM (VALUES ('CUST-1','Basic'),('CUST-2','Premium'),('CUST-3','Basic'))
      t(customer_id,segment)""")
    con.execute("""CREATE TABLE silver.fact_call_center_interactions AS SELECT * FROM (VALUES
      ('INT-1',TIMESTAMP '2024-01-01','Queja','Queja',600.0,TRUE,FALSE),
      ('INT-2',TIMESTAMP '2024-01-01','Producto','Producto',NULL,FALSE,FALSE),
      ('INT-3',TIMESTAMP '2026-02-01','Queja','Queja',300.0,TRUE,FALSE))
      t(interaction_id,interaction_date,contact_reason,reason_category,duration_seconds,was_resolved,was_escalated)""")
    con.execute("""CREATE TABLE silver.fact_satisfaction_surveys AS SELECT * FROM (VALUES
      ('SRV-1','INT-1','CUST-1',TIMESTAMP '2024-01-02','CSAT',4),
      ('SRV-2','INT-2','CUST-2',TIMESTAMP '2024-01-02','NPS',7),
      ('SRV-3','INT-3','CUST-1',TIMESTAMP '2026-02-02','CSAT',1))
      t(survey_id,interaction_id,customer_id,survey_date,survey_type,main_score)""")


@pytest.fixture
def report():
    """Build the report once from the in-memory fixture."""
    con = duckdb.connect(':memory:')
    try:
        _fixture(con)
        yield build(con)
    finally:
        con.close()


def test_design_window_excludes_the_holdout_except_the_full_period_age(report):
    """A 2026 complaint, contact or survey is outside every design metric but counts in PR-05."""
    s = report['summary']
    assert (s['kpi1_demand']['unrecognized_charges'], s['kpi1_demand']['all_complaints']) == (4, 5)
    assert s['window']['calendar_days'] == 929
    assert s['kpi3_workload']['contacts'] == 1
    assert s['satisfaction']['CSAT']['Queja']['all']['n'] == 1
    age = s['escalated_age']
    assert (age['escalated'], age['created_in_design_window'], age['data_end']) == (2, 1, '2026-02-01')
    target = s['before']['unrecognized charge / all']
    assert target['complaints'] == 4 and target['outcome_after_window'] == 1
    assert s['before']['unrecognized charge / escalated']['first_response_n'] == 0


def test_currencies_stay_apart_and_fx_is_flagged(report):
    """Each source currency is its own row; only USD conversions are combined, and flagged."""
    k2 = report['summary']['kpi2_claimed']
    rows = {r['currency']: r for r in k2['by_currency']}
    assert set(rows) == {'(none)', 'MXN', 'USD'}
    assert rows['MXN']['usd_amount_sum'] == pytest.approx(2.5) and rows['MXN']['usd_is_estimated']
    assert rows['USD']['source_amount_sum'] == 120.0 and not rows['USD']['usd_is_estimated']
    assert (k2['usd_convertible'], k2['complaints']) == (3, 4)
    assert k2['direct_usd_per_day'] == round(120 / 929, 2)
    assert 'source_amount_sum' not in k2
    assert (k2['direct_usd_cases'], k2['fx_estimated_cases'], k2['fx_estimated_usd'], k2['no_amount'], k2['amount_without_currency']) == (2, 1, 2.5, 1, 0)


def test_workload_detail_and_csat_by_reason_keep_their_populations(report):
    """Mean duration uses observed durations only; each reason keeps its own CSAT n, split by resolution."""
    s = report['summary']
    assert (s['kpi3_workload']['mean_duration_seconds'], s['kpi3_workload']['duration_missing']) == (600.0, 0)
    by_reason = {r['reason']: r for r in s['csat_by_reason']}
    assert set(by_reason) == {'Queja', 'Producto'}
    assert (by_reason['Queja']['csat']['n'], by_reason['Queja']['csat_resolved']['mean']) == (1, 4.0)
    assert by_reason['Producto']['csat']['n'] == 0 and by_reason['Producto']['resolved_rate'] == 0.0


def test_closed_case_satisfaction_counts_only_closings_in_the_window(report):
    """A case closed in 2026 is not in F5, even when it was created in the window."""
    cc = report['summary']['closed_case_satisfaction']
    assert (cc['scored_closed'], cc['mean'], cc['cohort']) == (1, 5.0, 4)


def test_nps_without_promoters_reports_no_formal_score(report):
    """No answer reaches 9-10, so the formal NPS is withheld with its reason."""
    nps = report['summary']['nps']
    assert (nps['answers'], nps['promoters'], nps['max_score']) == (1, 0, 7)
    assert nps['formal_score_note']


def test_small_cells_are_suppressed_and_no_identifier_is_published(report):
    """Segments under the minimum cell show "too few"; no record identifier reaches HTML or JSON."""
    assert all(r['too_few'] for r in report['summary']['segments'])
    html = render(report, {'database': 'bank.duckdb', 'quality_run': 'run/quality_results.json'})
    assert 'too few to compare' in html
    assert 'class="rp-dot uc"' in html and 'class="scatter"' in html and 'fill uc' in html
    published = html + json.dumps(report)
    assert not [i for i in IDS if i in published]


def test_runner_refuses_existing_output_and_publishes_without_paths(tmp_path):
    """A run is immutable, spill is cleaned, and the shared manifest names no local path."""
    db = tmp_path / 'bank.duckdb'
    with duckdb.connect(str(db)) as con:
        _fixture(con)
    quality = tmp_path / 'quality_runs' / 'run-17' / 'quality_results.json'
    quality.parent.mkdir(parents=True)
    metadata = {'ready': True, 'errors': 0, 'warnings': 2, 'tables': list(range(13)), 'database': str(db),
                'database_bytes': db.stat().st_size, 'watermarks': [],
                'generated_at_utc': (datetime.now(timezone.utc) + timedelta(seconds=10)).isoformat()}
    quality.write_text(json.dumps({'metadata': metadata, 'checks': [{}, {}, {}]}))
    output, published = tmp_path / 'run', tmp_path / 'published'
    options = ['--db', str(db), '--quality', str(quality), '--output', str(output)]
    assert run_product_report.main(options + ['--publish', str(published)]) == 0
    assert not (output / 'duckdb_tmp').exists()
    with pytest.raises(FileExistsError):
        run_product_report.main(options)
    manifest = json.loads((published / 'product-manifest.json').read_text(encoding='utf-8'))
    assert (manifest['database'], manifest['quality_run'], manifest['quality_checks']) == ('bank.duckdb', 'run-17/quality_results.json', 3)
    shared = ''.join((published / name).read_text(encoding='utf-8') for name in ('product-report.json', 'product-report.html', 'product-manifest.json'))
    assert str(tmp_path) not in shared and str(tmp_path).replace('\\', '/') not in shared
