"""
Tests run entirely in-memory against synthetic bronze tables shaped like the real ones (same
columns, same all-VARCHAR-by-default reality, deliberately including the edge cases the Bronze
profile surfaced) -- no real .duckdb file or S3 dependency, same testing philosophy as the bronze
pipeline's own test suite: verify against realistic data shapes, not idealized ones, since that's
exactly the kind of gap that caused real bugs earlier in this project (testing against a pre-typed
synthetic table once masked a real casting issue in customer_analytics.ipynb).
"""
import os
import sys

import duckdb
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from silver import build_fx_rates_table, build_silver_table
from table_specs import (
    branches_spec,
    call_center_interactions_spec,
    call_transcripts_spec,
    campaign_sends_spec,
    complaints_spec,
    customers_spec,
    digital_events_spec,
    marketing_campaigns_spec,
    products_spec,
    satisfaction_surveys_spec,
    service_agents_spec,
    transactions_spec,
)


@pytest.fixture
def con():
    connection = duckdb.connect(":memory:")
    connection.execute("CREATE SCHEMA bronze;")
    connection.execute("CREATE SCHEMA silver;")
    yield connection
    connection.close()


def _create_bronze(con, table_name: str, columns: str, rows: str) -> None:
    """`columns` is a comma-separated column-name list; `rows` is one or more parenthesized VALUES
    tuples. Every column is cast to VARCHAR to match real Bronze -- ALL_VARCHAR=true at ingestion
    means that's genuinely what every column is, `_ingested_at` (a real TIMESTAMP in production)
    aside."""
    col_list = [c.strip() for c in columns.split(",")]
    varchar_casts = ", ".join(
        f"CAST({c} AS VARCHAR) AS {c}" if c != "_ingested_at" else c for c in col_list
    )
    con.execute(f"""
        CREATE TABLE bronze.{table_name} AS
        SELECT {varchar_casts} FROM (VALUES {rows}) AS t({columns})
    """)


@pytest.fixture
def bronze_fx(con):
    """Two currencies, two dates each -- MXN and COP both have an earlier and a later USD rate, so
    tests can distinguish "latest rate" (products) from "exact-date rate" (transactions) logic."""
    _create_bronze(
        con, "daily_exchange_rates",
        "date, source_currency, target_currency, exchange_rate, buy_rate, sell_rate, source, _ingested_at",
        """
        ('2024-01-01', 'MXN', 'USD', '0.05', '0.049', '0.051', 'Reuters', TIMESTAMP '2024-01-02'),
        ('2024-06-01', 'MXN', 'USD', '0.06', '0.059', '0.061', 'Reuters', TIMESTAMP '2024-06-02'),
        ('2024-01-01', 'COP', 'USD', '0.00025', '0.00024', '0.00026', 'Reuters', TIMESTAMP '2024-01-02'),
        ('2024-06-01', 'COP', 'USD', '0.00030', '0.00029', '0.00031', 'Reuters', TIMESTAMP '2024-06-02')
        """,
    )
    return con


# --------------------------------------------------------------------------------------
# fx_rates
# --------------------------------------------------------------------------------------

def test_fx_rates_table_and_latest_view(bronze_fx):
    con = bronze_fx
    result = build_fx_rates_table(con)
    assert result.rows == 4

    latest_mxn = con.execute(
        "SELECT rate_to_usd, rate_date FROM silver.v_fx_latest_to_usd WHERE source_currency = 'MXN'"
    ).fetchone()
    assert latest_mxn[0] == 0.06  # the 2024-06-01 rate, not the older 2024-01-01 one
    assert str(latest_mxn[1]) == "2024-06-01"


# --------------------------------------------------------------------------------------
# customers -- country canonicalization, boolean parsing, dedup
# --------------------------------------------------------------------------------------

def test_customers_country_canonicalization_and_dedup(con):
    columns = (
        "customer_id, document_number, document_type, first_name, last_name, date_of_birth, "
        "gender, email, mobile_phone, landline_phone, address, city, state, country, "
        "postal_code, detected_accent, segment, credit_score, estimated_monthly_income, "
        "occupation, marital_status, education_level, registration_date, registration_branch_id, "
        "customer_status, last_updated, accepts_marketing, _ingested_at"
    )
    rows = """
        ('C1', '123', 'DNI', 'Ana', 'Diaz', '1990-01-01', 'F', 'a@x.com', '+1', '+1', 'Addr', 'CDMX',
         'CDMX', 'mexico', '10000', 'mexican', 'Basic', '650', '2000', 'Manager', 'Single',
         'University', '2022-01-01', 'B1', 'Active', '2025-01-01', 'True', TIMESTAMP '2024-01-01'),
        ('C1', '123', 'DNI', 'Ana', 'Diaz', '1990-01-01', 'F', 'a@x.com', '+1', '+1', 'Addr', 'CDMX',
         'CDMX', 'México', '10000', 'mexican', 'Basic', '650', '2000', 'Manager', 'Single',
         'University', '2022-01-01', 'B1', 'Active', '2025-01-01', 'True', TIMESTAMP '2024-06-01'),
        ('C2', '456', 'CC', 'Luis', 'Gomez', '1985-05-05', 'M', 'l@x.com', '+2', NULL, 'Addr2', 'Bogota',
         'Bogota', 'Colombia', '110', 'colombian', 'Plus', 'nan', '3000', 'Doctor', 'Married',
         'Graduate', '2021-01-01', 'B2', 'Active', '2025-02-01', 'False', TIMESTAMP '2024-01-01')
    """
    _create_bronze(con, "customers", columns, rows)

    result = build_silver_table(con, customers_spec)
    assert result.rows == 2  # C1's duplicate collapsed to 1 row

    c1 = con.execute("SELECT country, accepts_marketing FROM silver.dim_customers WHERE customer_id = 'C1'").fetchone()
    assert c1[0] == "México"  # both 'mexico' and 'México' canonicalize to the same spelling
    assert c1[1] is True

    c2 = con.execute("SELECT credit_score, accepts_marketing FROM silver.dim_customers WHERE customer_id = 'C2'").fetchone()
    assert c2[0] is None  # 'nan' sentinel -> NULL, not IEEE NaN
    assert c2[1] is False


# --------------------------------------------------------------------------------------
# branches -- boolean + time + integer casting
# --------------------------------------------------------------------------------------

def test_branches_boolean_time_integer(con):
    columns = (
        "branch_id, branch_code, branch_name, branch_type, address, city, state, country, "
        "postal_code, geographic_zone, phone, email, opening_time, closing_time, has_atms, "
        "atm_count, has_teller_windows, teller_window_count, latitude, longitude, "
        "branch_opening_date, branch_status, _ingested_at"
    )
    rows = """
        ('B1', 'S001', 'Branch One', 'Main', 'Addr', 'Lima', 'Lima', 'Peru', '10000', 'Urbana',
         '+1', 'b@x.com', '09:00:00', '17:00:00', 'True', '5', 'False', '2', '19.4', '-99.1',
         '2010-01-01', 'Active', TIMESTAMP '2024-01-01')
    """
    _create_bronze(con, "branches", columns, rows)

    build_silver_table(con, branches_spec)
    row = con.execute(
        "SELECT has_atms, atm_count, has_teller_windows, opening_time, country FROM silver.dim_branches"
    ).fetchone()
    assert row[0] is True
    assert row[1] == 5
    assert row[2] is False
    assert str(row[3]) == "09:00:00"
    assert row[4] == "Peru"  # not in COUNTRY_CANONICAL's alias set -> trimmed passthrough, not dropped


# --------------------------------------------------------------------------------------
# products -- latest-rate currency conversion
# --------------------------------------------------------------------------------------

def test_products_uses_latest_fx_rate(bronze_fx):
    con = bronze_fx
    build_fx_rates_table(con)

    columns = (
        "product_id, customer_id, product_type, product_number, currency, current_balance, "
        "credit_limit, interest_rate, opening_date, expiration_date, opening_branch_id, "
        "product_status, opening_channel, has_linked_app, days_past_due, last_transaction_date, "
        "last_updated, _ingested_at"
    )
    rows = """
        ('P1', 'C1', 'Cuenta Ahorro', 'N1', 'MXN', '1000', NULL, '5.0', '2020-01-01', NULL, 'B1',
         'Active', 'Branch', 'True', NULL, NULL, '2024-01-01', TIMESTAMP '2024-01-01')
    """
    _create_bronze(con, "products", columns, rows)

    build_silver_table(con, products_spec)
    balance_usd = con.execute("SELECT current_balance_usd FROM silver.dim_products WHERE product_id = 'P1'").fetchone()[0]
    # latest MXN->USD rate is 0.06 (2024-06-01), not the older 0.05 -- confirms products uses the
    # LATEST rate, not an exact-date one (it has no transaction-like date to join on).
    assert balance_usd == pytest.approx(1000 * 0.06)


# --------------------------------------------------------------------------------------
# transactions -- exact-date currency conversion, amount_usd fallback + estimated flag, dedup
# --------------------------------------------------------------------------------------

def test_transactions_amount_usd_fallback_and_exact_date_fx(bronze_fx):
    con = bronze_fx
    build_fx_rates_table(con)

    columns = (
        "transaction_id, transaction_date, product_id, customer_id, transaction_type, "
        "transaction_category, amount, currency, amount_usd, channel, branch_id, merchant_name, "
        "merchant_category, transaction_country, transaction_city, transaction_status, "
        "response_code, is_fraud, fraud_score, latitude, longitude, _ingested_at"
    )
    rows = """
        ('T1', '2024-01-01 10:00:00', 'P1', 'C1', 'Purchase', 'Food', '100', 'MXN', NULL, 'POS',
         'B1', 'Store', 'Food', 'mexico', 'CDMX', 'Approved', '00', 'False', '1.0', NULL, NULL,
         TIMESTAMP '2024-01-01'),
        ('T2', '2024-01-01 11:00:00', 'P1', 'C1', 'Purchase', 'Food', '100', 'MXN', '9999.0', 'POS',
         'B1', 'Store', 'Food', 'México', 'CDMX', 'Approved', '00', 'False', '1.0', NULL, NULL,
         TIMESTAMP '2024-01-01'),
        ('T3', '2024-01-01 12:00:00', 'P1', 'C1', 'Purchase', 'Food', '100', 'MXN', NULL, 'POS',
         'B1', 'Store', 'Food', 'mexico', 'CDMX', 'Approved', '00', 'False', '1.0', NULL, NULL,
         TIMESTAMP '2024-01-01'),
        ('T3', '2024-01-01 12:00:00', 'P1', 'C1', 'Purchase', 'Food', '100', 'MXN', NULL, 'POS',
         'B1', 'Store', 'Food', 'mexico', 'CDMX', 'Approved', '00', 'False', '1.0', NULL, NULL,
         TIMESTAMP '2024-06-01')
    """
    _create_bronze(con, "transactions", columns, rows)

    build_silver_table(con, transactions_spec)

    # T1: amount_usd was NULL in Bronze -> filled via amount * exact-date (2024-01-01) rate 0.05,
    # NOT the later 0.06 rate -- confirms transactions joins by exact date, unlike products.
    t1 = con.execute(
        "SELECT amount_usd, amount_usd_is_estimated, transaction_country FROM silver.fact_transactions WHERE transaction_id = 'T1'"
    ).fetchone()
    assert t1[0] == pytest.approx(100 * 0.05)
    assert t1[1] is True
    assert t1[2] == "México"  # 'mexico' canonicalized

    # T2: amount_usd was already populated in Bronze -> kept as-is, not overwritten by the FX calc.
    t2 = con.execute(
        "SELECT amount_usd, amount_usd_is_estimated FROM silver.fact_transactions WHERE transaction_id = 'T2'"
    ).fetchone()
    assert t2[0] == 9999.0
    assert t2[1] is False

    # T3 appears twice with different _ingested_at -- dedup must keep exactly one.
    t3_count = con.execute("SELECT count(*) FROM silver.fact_transactions WHERE transaction_id = 'T3'").fetchone()[0]
    assert t3_count == 1

    total_rows = con.execute("SELECT count(*) FROM silver.fact_transactions").fetchone()[0]
    assert total_rows == 3  # T1, T2, T3 (deduped) -- not 4


# --------------------------------------------------------------------------------------
# campaign_sends -- the "nan"-in-subject bug fix
# --------------------------------------------------------------------------------------

def test_campaign_sends_strips_templated_nan_but_not_lookalike_words(con):
    columns = (
        "send_id, send_date, process_date, campaign_id, customer_id, send_channel, "
        "template_used, subject, send_status, was_delivered, was_opened, open_date, was_clicked, "
        "click_date, click_count, had_conversion, conversion_date, conversion_value, open_device, "
        "open_country, failure_reason, send_cost, _ingested_at"
    )
    rows = """
        ('S1', '2024-01-01 10:00:00', '2024-01-01', 'CMP1', 'C1', 'Email', 'tmpl1',
         '¡Oferta especial en nan!', 'Sent', 'True', 'False', NULL, 'False', NULL, NULL,
         'False', NULL, NULL, NULL, 'Mexico', NULL, '0.01', TIMESTAMP '2024-01-01'),
        ('S2', '2024-01-01 10:00:00', '2024-01-01', 'CMP1', 'C2', 'Email', 'tmpl1',
         'Special offer at Nantucket branch!', 'Sent', 'True', 'False', NULL, 'False', NULL, NULL,
         'False', NULL, NULL, NULL, 'México', NULL, '0.01', TIMESTAMP '2024-01-01')
    """
    _create_bronze(con, "campaign_sends", columns, rows)

    build_silver_table(con, campaign_sends_spec)

    s1 = con.execute("SELECT subject, open_country FROM silver.fact_campaign_sends WHERE send_id = 'S1'").fetchone()
    assert s1[0] is None  # literal "nan" word -> stripped to NULL
    assert s1[1] == "México"  # 'Mexico' canonicalized

    s2 = con.execute("SELECT subject FROM silver.fact_campaign_sends WHERE send_id = 'S2'").fetchone()
    assert s2[0] == "Special offer at Nantucket branch!"  # "Nantucket" contains "nan" but isn't the word "nan"


# --------------------------------------------------------------------------------------
# service_agents -- plain dimension, country canonicalization + integer/double casting
# --------------------------------------------------------------------------------------

def test_service_agents_typing_and_country(con):
    columns = (
        "agent_id, employee_code, first_name, last_name, email, phone, native_accent, "
        "country_of_origin, assigned_branch_id, agent_type, experience_level, languages, "
        "specialty, hire_date, avg_csat, total_monthly_interactions, agent_status, work_shift, "
        "_ingested_at"
    )
    rows = """
        ('AGT1', 'E1', 'Jose', 'Gomez', 'j@x.com', '+1', 'mexican', 'mexico', 'B1', 'Phone',
         'Senior', 'español, inglés', 'Fraudes', '2015-05-13', '4.3', '500', 'Active', 'Morning',
         TIMESTAMP '2024-01-01')
    """
    _create_bronze(con, "service_agents", columns, rows)

    build_silver_table(con, service_agents_spec)
    row = con.execute(
        "SELECT country_of_origin, avg_csat, total_monthly_interactions FROM silver.dim_service_agents"
    ).fetchone()
    assert row[0] == "México"  # 'mexico' canonicalized
    assert row[1] == pytest.approx(4.3)
    assert row[2] == 500


# --------------------------------------------------------------------------------------
# marketing_campaigns -- plain dimension, country canonicalization on a mostly-null column
# --------------------------------------------------------------------------------------

def test_marketing_campaigns_typing(con):
    columns = (
        "campaign_id, campaign_name, description, campaign_type, campaign_objective, "
        "promoted_product, target_segment, target_country, start_date, end_date, budget, "
        "campaign_status, expected_conversion_rate, _ingested_at"
    )
    rows = """
        ('CMP1', 'CMP_RET_CC', 'Retention campaign', 'Email', 'Retention', 'Tarjeta Crédito',
         'Premium', 'mexico', '2024-05-01', '2024-06-01', '20000', 'Completed', '8.5',
         TIMESTAMP '2024-01-01'),
        ('CMP2', 'CMP_ACQ_SAV', 'Acquisition campaign', 'SMS', 'Acquisition', 'Cuenta Ahorro',
         NULL, NULL, '2024-01-01', '2024-02-01', '5000', 'Active', '4.2', TIMESTAMP '2024-01-01')
    """
    _create_bronze(con, "marketing_campaigns", columns, rows)

    build_silver_table(con, marketing_campaigns_spec)
    c1 = con.execute("SELECT target_country, budget FROM silver.dim_marketing_campaigns WHERE campaign_id = 'CMP1'").fetchone()
    assert c1[0] == "México"
    assert c1[1] == pytest.approx(20000)

    c2 = con.execute("SELECT target_country FROM silver.dim_marketing_campaigns WHERE campaign_id = 'CMP2'").fetchone()
    assert c2[0] is None  # genuinely null target_country stays null, not coerced to a country


# --------------------------------------------------------------------------------------
# call_center_interactions -- fact; partition columns dropped, contact_reason/reason_category both
# carried through unchanged (see table_specs.py docstring on why neither is dropped)
# --------------------------------------------------------------------------------------

def test_call_center_interactions_drops_partition_columns_keeps_both_reason_columns(con):
    columns = (
        "interaction_id, interaction_date, process_date, customer_id, agent_id, interaction_type, "
        "channel, contact_reason, reason_category, duration_seconds, wait_time_seconds, "
        "was_resolved, requires_followup, detected_sentiment, sentiment_score, "
        "customer_detected_accent, agent_used_accent, was_escalated, mentioned_products, "
        "has_transcript, has_recording, day, month, year, _ingested_at"
    )
    rows = """
        ('INT1', '2024-01-01 10:00:00', '2024-01-01', 'C1', 'AGT1', 'Inbound Call', 'Phone',
         'Transaccional', 'Transaccional', '190.0', '162.0', 'True', 'False', 'Neutral', '-0.18',
         'mexican', 'mexican', 'False', 'PRD1,PRD2', 'True', 'True', '01', '01', 2024,
         TIMESTAMP '2024-01-01')
    """
    _create_bronze(con, "call_center_interactions", columns, rows)

    build_silver_table(con, call_center_interactions_spec)
    cols = [r[0] for r in con.execute("DESCRIBE silver.fact_call_center_interactions").fetchall()]
    assert not ({"day", "month", "year"} & set(cols))  # Hive partition artifacts dropped

    row = con.execute(
        "SELECT contact_reason, reason_category, was_resolved, duration_seconds "
        "FROM silver.fact_call_center_interactions"
    ).fetchone()
    assert row[0] == row[1] == "Transaccional"  # both columns carried through, still identical
    assert row[2] is True
    assert row[3] == pytest.approx(190.0)


# --------------------------------------------------------------------------------------
# call_transcripts -- fact; text fields pass through untouched (including template placeholders)
# --------------------------------------------------------------------------------------

def test_call_transcripts_passes_through_text_fields(con):
    columns = (
        "transcript_id, interaction_id, process_date, customer_id, agent_id, full_text, "
        "customer_text, agent_text, detected_language, detected_accent, accent_confidence, "
        "detected_keywords, mentioned_entities, detected_intents, main_topics, "
        "transcription_model, audio_quality, duration_seconds, day, month, year, _ingested_at"
    )
    rows = """
        ('TRS1', 'INT1', '2024-01-01', 'C1', 'AGT1',
         'Agente: Su saldo actual es {monto} {moneda}.', 'Hola.', 'Buenas.', 'es', 'mexican',
         '0.99', 'banco, servicio', '{"account_numbers": 0}', 'consulta_general', 'Transaccional',
         'AWS Transcribe', 'High', '419.0', '01', '01', 2024, TIMESTAMP '2024-01-01')
    """
    _create_bronze(con, "call_transcripts", columns, rows)

    build_silver_table(con, call_transcripts_spec)
    row = con.execute(
        "SELECT full_text, accent_confidence FROM silver.fact_call_transcripts"
    ).fetchone()
    assert row[0] == "Agente: Su saldo actual es {monto} {moneda}."  # unrendered placeholders kept as-is
    assert row[1] == pytest.approx(0.99)


# --------------------------------------------------------------------------------------
# satisfaction_surveys -- fact; main_score stays a plain integer across CSAT/NPS/CES scales
# --------------------------------------------------------------------------------------

def test_satisfaction_surveys_main_score_is_integer(con):
    columns = (
        "survey_id, survey_date, process_date, interaction_id, customer_id, agent_id, "
        "survey_type, send_channel, main_score, nps_category, question_1_text, "
        "question_1_response, question_2_text, question_2_response, question_3_text, "
        "question_3_response, open_comments, comment_sentiment, response_time_hours, "
        "campaign_response_rate, day, month, year, _ingested_at"
    )
    rows = """
        ('SRV1', '2024-01-01 10:00:00', '2024-01-01', 'INT1', 'C1', 'AGT1', 'CSAT', 'Email', '3',
         NULL, 'Q1', '5.0', 'Q2', '3.0', 'Q3', '1.0', 'Comment', 'Neutral', '20.8', '30.4', '01',
         '01', 2024, TIMESTAMP '2024-01-01')
    """
    _create_bronze(con, "satisfaction_surveys", columns, rows)

    build_silver_table(con, satisfaction_surveys_spec)
    score_type = con.execute("SELECT typeof(main_score) FROM silver.fact_satisfaction_surveys").fetchone()[0]
    assert score_type == "BIGINT"
    score = con.execute("SELECT main_score FROM silver.fact_satisfaction_surveys").fetchone()[0]
    assert score == 3


# --------------------------------------------------------------------------------------
# complaints -- fact; origin_interaction_id (100% null / 0 distinct in the Bronze profile) is
# dropped rather than carried forward as a typed-but-always-null column
# --------------------------------------------------------------------------------------

def test_complaints_drops_origin_interaction_id(con):
    columns = (
        "complaint_id, creation_date, process_date, customer_id, case_type, category, "
        "subcategory, reception_channel, affected_product_id, related_branch_id, "
        "origin_interaction_id, description, claimed_amount, currency, priority, status, "
        "assigned_agent_id, assignment_date, first_response_date, resolution_date, closing_date, "
        "sla_breached, resolution_days, resolution, compensation_granted, "
        "resolution_satisfaction, is_repeat_complainer, day, month, year, _ingested_at"
    )
    rows = """
        ('CMP1', '2024-01-01 03:59:47', '2024-01-01', 'C1', 'Complaint', 'Transactions', NULL,
         'Call Center', 'P1', 'B1', NULL, 'Queja', '725.2', 'MXN', 'Medium', 'Open', 'AGT1',
         '2024-01-01 00:00:37', NULL, NULL, NULL, 'False', NULL, NULL, NULL, NULL, 'False', '01',
         '01', 2024, TIMESTAMP '2024-01-01')
    """
    _create_bronze(con, "complaints", columns, rows)

    build_silver_table(con, complaints_spec)
    cols = [r[0] for r in con.execute("DESCRIBE silver.fact_complaints").fetchall()]
    assert "origin_interaction_id" not in cols

    row = con.execute("SELECT claimed_amount, sla_breached FROM silver.fact_complaints").fetchone()
    assert row[0] == pytest.approx(725.2)
    assert row[1] is False


# --------------------------------------------------------------------------------------
# digital_events -- fact; country canonicalization on ip_country, same 'México'/'Mexico' split as
# transactions.transaction_country
# --------------------------------------------------------------------------------------

def test_digital_events_canonicalizes_ip_country(con):
    columns = (
        "event_id, event_date, process_date, customer_id, session_id, event_type, "
        "event_category, channel, platform, browser, app_version, page_url, page_title, action, "
        "element_id, product_id, event_value, duration_seconds, ip_address, ip_country, ip_city, "
        "is_mobile, referrer, utm_source, utm_medium, utm_campaign, day, month, year, _ingested_at"
    )
    rows = """
        ('EVT1', '2024-01-01 10:00:00', '2024-01-01', 'C1', 'SES1', 'PageView', 'Navigation',
         'Android App', 'Android', 'Chrome', '5.4.0', '/home', 'Inicio', 'view_home', NULL, NULL,
         NULL, '103.0', '1.2.3.4', 'mexico', 'Guadalajara', 'True', NULL, NULL, NULL, NULL, '01',
         '01', 2024, TIMESTAMP '2024-01-01'),
        ('EVT2', '2024-01-01 11:00:00', '2024-01-01', 'C1', 'SES1', 'PageView', 'Navigation',
         'Android App', 'Android', 'Chrome', '5.4.0', '/home', 'Inicio', 'view_home', NULL, NULL,
         NULL, '80.0', '1.2.3.5', 'México', 'CDMX', 'True', NULL, NULL, NULL, NULL, '01', '01',
         2024, TIMESTAMP '2024-01-01')
    """
    _create_bronze(con, "digital_events", columns, rows)

    build_silver_table(con, digital_events_spec)
    countries = {
        r[0] for r in con.execute("SELECT DISTINCT ip_country FROM silver.fact_digital_events").fetchall()
    }
    assert countries == {"México"}  # 'mexico' and 'México' both canonicalize to the same spelling
