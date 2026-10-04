"""Window, currency, suppression and identifier regressions for the product report."""
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import duckdb
import pytest

from data_foundation.scripts import run_product_report
from data_foundation.src.marketing_product_report import table
from data_foundation.src.product_report import _mirrors, _scores, build, render, suppress_small_cells, write_report

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
    # Channel and the source's repeat flag; CMP-4 (holdout) is flagged too, so a window leak would show.
    con.execute("""ALTER TABLE silver.fact_complaints ADD COLUMN reception_channel VARCHAR;
      ALTER TABLE silver.fact_complaints ADD COLUMN is_repeat_complainer BOOLEAN;
      UPDATE silver.fact_complaints SET reception_channel = CASE WHEN complaint_id IN ('CMP-2','CMP-4') THEN 'App' ELSE 'Call Center' END,
        is_repeat_complainer = complaint_id IN ('CMP-6','CMP-4')""")
    con.execute("""CREATE TABLE silver.dim_fx_rates AS SELECT * FROM (VALUES (DATE '2025-12-20','MXN','USD',0.05))
      t(rate_date,source_currency,target_currency,exchange_rate)""")
    con.execute("""CREATE TABLE silver.dim_customers AS SELECT * FROM (VALUES ('CUST-1','Basic','México'),('CUST-2','Premium','Colombia'),('CUST-3','Basic','México'))
      t(customer_id,segment,country)""")
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


def test_scores_leave_out_surveys_without_a_score():
    """A NULL main_score neither breaks sorting nor enters the count or the mean."""
    result = _scores([{"score": 4, "surveys": 2}, {"score": None, "surveys": 5}, {"score": 2, "surveys": 2}])
    assert result == {"n": 4, "mean": 3.0, "distribution": {"2": 2, "4": 2}}


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


def test_small_cells_publish_no_numerator_a_hidden_value_could_be_rebuilt_from(report):
    """Every fixture segment is under 30: counts stay, rates and sums are null in the raw rows and the summary."""
    for rows in (report['queries']['PR-08']['rows'], report['summary']['segments']):
        for r in rows:
            assert r['complaints'] < 30
            assert [r[k] for k in ('unresolved', 'escalated', 'sla_known', 'sla_breached', 'closed_score_sum')] == [None] * 5
    for rows in (report['queries']['PR-09']['rows'], report['summary']['segment_csat']):
        assert all((r['score_sum'], r['top_score'], r['resolved']) == (None, None, None) for r in rows)
    assert all(r['unresolved_share'] is None and r['closed_mean'] is None for r in report['summary']['segments'])


def test_repeat_complaints_and_reopen_proxies_stay_in_the_window(report):
    """CUST-1 files three design-window complaints (22 and 90 days apart); CUST-3's holdout complaint never counts."""
    rp = report['summary']['repeat']
    assert (rp['customers'], rp['repeat_customers'], rp['complaints'], rp['complaints_from_repeat_customers']) == (2, 1, 4, 3)
    # Follow-ups: 2024-02-01 (22 days after a resolved complaint) and 2024-05-01 (90 days after an escalated one, no outcome date).
    assert (rp['follow_up_complaints'], rp['within_30_days'], rp['within_90_days'], rp['after_prior_outcome']) == (2, 1, 2, 1)
    assert rp['source_flag_repeat'] == 1 and rp['repeat_customer_share'] == 0.5


def test_country_and_channel_cuts_count_the_window_and_suppress_small_cells(report):
    """Each cut counts design-window complaints only; every fixture cell is under 30, so no rate or sum is published."""
    s = report['summary']
    assert {r['country']: r['complaints'] for r in s['by_country']} == {'México': 3, 'Colombia': 1}
    assert {r['channel']: r['complaints'] for r in s['by_channel']} == {'Call Center': 3, 'App': 1}
    for rows in (s['by_country'], s['by_channel'], report['queries']['PR-11']['rows'], report['queries']['PR-12']['rows']):
        for r in rows:
            assert [r[k] for k in ('unresolved', 'sla_breached', 'closed_score_sum', 'first_response_h_p50')] == [None] * 4
    html = render(report, {'database': 'x', 'quality_run': 'y'})
    assert 'By channel (PR-12)' in html and 'EVALUATION.md#9-live-service-as-measured' in html


def test_a_large_segment_still_hides_a_small_closed_case_mean():
    """A segment with enough complaints keeps its rates, but under 30 scored closings loses only the score sum."""
    results = {"PR-08": {"rows": [{"complaints": 539, "unresolved": 399, "escalated": 20, "sla_known": 539, "sla_breached": 82,
                                   "closed_scored": 21, "closed_score_sum": 58.0}]},
               "PR-09": {"rows": [{"surveys": 928, "score_sum": 2237, "top_score": 63, "resolved": 389}]}}
    row = suppress_small_cells(results)["PR-08"]["rows"][0]
    assert (row["unresolved"], row["closed_scored"], row["closed_score_sum"]) == (399, 21, None)
    assert results["PR-09"]["rows"][0]["score_sum"] == 2237


def _committed():
    published = Path(__file__).resolve().parents[1] / 'reports'
    return (json.loads((published / 'product-report.json').read_text(encoding='utf-8')),
            json.loads((published / 'product-manifest.json').read_text(encoding='utf-8')))


def test_headline_says_no_different_only_while_the_gap_is_small():
    """The generated headline drops "handled no differently" once other complaints differ by more than MAX_GAP_PTS."""
    report, manifest = _committed()
    assert 'handled no differently from other complaints' in render(report, manifest)
    other = report['summary']['before']['other complaint / all']
    other['open'] = other['complaints'] - other['in_process'] - other['escalated_status']  # every other complaint unresolved
    html = render(report, manifest)
    assert 'handled no differently' not in html and 'other complaints: 100.0% unresolved' in html


def test_ces_is_folded_into_a_sentence_only_when_it_mirrors_csat():
    """CES is drawn again as soon as its score shares stop matching CSAT's."""
    report, manifest = _committed()
    assert _mirrors(report['summary']['satisfaction'], 'CES', 'CSAT') is not None
    assert 'CES is not drawn' in render(report, manifest)
    ces = report['summary']['satisfaction']['CES']['Queja']['all']
    first, last = sorted(ces['distribution'])[0], sorted(ces['distribution'])[-1]
    moved = ces['distribution'][first] // 2
    ces['distribution'][first] -= moved
    ces['distribution'][last] += moved
    assert _mirrors(report['summary']['satisfaction'], 'CES', 'CSAT') is None
    html = render(report, manifest)
    assert 'CES is not drawn' not in html and '<h4>CES' in html


def test_amounts_without_a_currency_get_no_total_or_median(report):
    """A claim with no currency may be in any currency, so PR-02 never sums or takes the median of those amounts."""
    rows = {r['currency']: r for r in report['summary']['kpi2_claimed']['by_currency']}
    assert rows['(none)']['source_amount_sum'] is None and rows['(none)']['source_amount_p50'] is None


def test_tables_right_align_only_numeric_columns():
    """Numbers align right; text, including placeholders such as "too few to compare", aligns left and may wrap."""
    html = table([{'name': 'Call Center', 'n': '5,210', 'rate': ('25.0 h', 'n = 3,017'), 'note': 'FX estimate'},
                  {'name': 'Branch', 'n': '402', 'rate': 'too few', 'note': 'source USD'}],
                 [('name', 'Channel'), ('n', 'Complaints'), ('rate', 'First response'), ('note', 'Basis')])
    assert re.findall(r'<th class="(\w)">', html) == ['t', 'n', 'n', 't']
    assert '25.0 h<small class="sub">n = 3,017</small>' in html


def test_contents_line_links_every_section(report):
    """The contents line under the headline points at every section id that exists on the page."""
    html = render(report, {})
    for anchor in re.findall(r'<a href="#(\w+)">', html):
        assert f'id="{anchor}"' in html
    assert len(re.findall(r'<a href="#(\w+)">', html)) == 5


def test_committed_outputs_carry_no_real_identifier():
    """The published JSON, HTML and manifest hold no ID shaped like the dataset's keys or agent codes.

    Shapes come from Silver: an uppercase prefix, a hyphen and at least 8 letters or digits (CLI-, PRD-, AGT-, ...),
    and employee codes E99999. Bare document and product numbers are not scanned: they look like aggregate totals.
    """
    published = Path(__file__).resolve().parents[1] / 'reports'
    pattern = re.compile(r'\b(?:CLI|SUC|CMP|PRD|AGT|INT|TRS|SND|EVT|SES|SRV|TRX)-[A-Z0-9]{8,}\b|\bE\d{5}\b')
    for name in ('product-report.json', 'product-report.html', 'product-manifest.json'):
        assert not pattern.findall((published / name).read_text(encoding='utf-8')), name


def test_published_baseline_page_matches_its_committed_aggregates(tmp_path):
    """The committed HTML must be what the current code renders from the committed JSON, so a stale STYLE fails."""
    published = Path(__file__).resolve().parents[1] / 'reports'
    report = json.loads((published / 'product-report.json').read_text(encoding='utf-8'))
    manifest = json.loads((published / 'product-manifest.json').read_text(encoding='utf-8'))
    write_report(report, manifest, tmp_path)
    for name in ('product-report.json', 'product-manifest.json', 'product-report.html'):
        assert (tmp_path / name).read_bytes() == (published / name).read_bytes(), name


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
    assert manifest['silver_counts'] == {'dim_customers': 3, 'dim_fx_rates': 1, 'fact_call_center_interactions': 3,
                                         'fact_complaints': 6, 'fact_satisfaction_surveys': 3}
    shared = ''.join((published / name).read_text(encoding='utf-8') for name in ('product-report.json', 'product-report.html', 'product-manifest.json'))
    assert str(tmp_path) not in shared and str(tmp_path).replace('\\', '/') not in shared
