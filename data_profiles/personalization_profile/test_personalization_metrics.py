"""Offline fixtures for personalization_metrics: orphan exclusion and readings that follow the data."""
from pathlib import Path

import duckdb
import pytest

import personalization_metrics as pm


@pytest.fixture
def con():
    c = duckdb.connect()
    c.execute('CREATE SCHEMA silver')
    c.execute("""CREATE TABLE silver.dim_customers AS SELECT * FROM (VALUES
        ('C1', 'mexican', 'Basic', 'México', TRUE),
        ('C2', NULL, 'Premium', 'Colombia', FALSE),
        ('C3', 'argentine', 'Basic', 'Argentina', NULL))
        t(customer_id, detected_accent, segment, country, accepts_marketing)""")
    # 'GHOST' is an orphan fact customer; it must never enter a coverage numerator.
    c.execute("""CREATE TABLE silver.fact_call_center_interactions AS SELECT * FROM (VALUES
        ('C1', 'mexican', 'Transaccional', 0.5), ('C1', 'mexican', 'Transaccional', NULL),
        ('C3', 'argentine', 'Queja', 0.1), ('GHOST', 'mexican', 'Queja', 0.2))
        t(customer_id, customer_detected_accent, reason_category, sentiment_score)""")
    c.execute("""CREATE TABLE silver.fact_call_transcripts AS SELECT * FROM (VALUES
        ('C1', 'mexican', 'es'), ('GHOST', 'mexican', 'es')) t(customer_id, detected_accent, detected_language)""")
    c.execute("""CREATE TABLE silver.fact_complaints AS SELECT * FROM (VALUES
        ('C1', 'Open'), ('GHOST', 'Open'), ('C3', 'Closed')) t(customer_id, status)""")
    c.execute("""CREATE TABLE silver.fact_satisfaction_surveys AS SELECT * FROM (VALUES
        ('C1', 'CSAT', 4), ('C3', 'NPS', 9)) t(customer_id, survey_type, main_score)""")
    c.execute("""CREATE TABLE silver.fact_digital_events AS SELECT * FROM (VALUES
        ('C1', 'app'), ('C2', 'web'), ('GHOST', 'app')) t(customer_id, channel)""")
    c.execute("CREATE TABLE silver.fact_transactions AS SELECT * FROM (VALUES ('C1'), ('C2')) t(customer_id)")
    yield c
    c.close()


def test_coverage_counts_only_dimension_customers(con):
    m = pm.measure(con)
    cov = {c['source']: c for c in m['coverage']}
    assert cov['fact_call_center_interactions']['customers'] == 2
    assert cov['fact_call_center_interactions']['orphan_ids'] == 1
    assert cov['fact_call_center_interactions']['pct'] == pytest.approx(66.7)
    assert m['open_complaints'] == 1  # GHOST's open complaint is excluded
    assert m['repeat_contact'] == 1
    assert 'GHOST' not in str(pm.readings(m))
    assert '`fact_call_center_interactions` 1' in pm.readings(m)['coverage']


def test_language_reading_follows_the_count(con):
    assert 'None of the 2 transcripts' in pm.readings(pm.measure(con))['language']
    con.execute("INSERT INTO silver.fact_call_transcripts VALUES ('C2', NULL, 'pt-BR')")
    reading = pm.readings(pm.measure(con))['language']
    assert reading.startswith('1 of 3 transcripts') and 'cannot be derived' not in reading


def test_sentiment_and_accent_readings_use_measured_values(con):
    m = pm.measure(con)
    r = pm.readings(m)
    assert m['sentiment']['null'] == 1 and '(25.0%)' in r['sentiment']
    assert m['accent_agreement'] == {'compared': 2, 'agree': 2, 'pct': 100.0}
    assert 'every time' in r['accent']
    con.execute("UPDATE silver.dim_customers SET detected_accent = 'colombian' WHERE customer_id = 'C3'")
    assert 'agree for 50.0%' in pm.readings(pm.measure(con))['accent']


def test_display_path_never_prints_a_home_directory(tmp_path):
    assert pm.display_path(pm.PROJECT_ROOT_DEFAULT / 'data' / 'latam_bank.duckdb') == 'data/latam_bank.duckdb'
    assert pm.display_path(tmp_path / 'x.duckdb') == 'x.duckdb'
    assert str(Path.home()) not in pm.display_path(Path.home() / 'elsewhere' / 'x.duckdb')
