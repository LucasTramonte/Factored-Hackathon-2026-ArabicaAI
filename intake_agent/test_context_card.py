"""Context card: scoped reads, personalization fields and forbidden-signal exclusion."""
import datetime as dt
import json

import duckdb
import pytest

from intake_agent.context_card import build_context_card, style_defaults

TODAY = dt.date(2026, 9, 29)
FORBIDDEN_NAMES = ['credit_score', 'estimated_monthly_income', 'accepts_marketing', 'days_past_due',
                   'current_balance', 'credit_limit', 'is_fraud', 'fraud_score', 'document_number',
                   'email', 'phones', 'address']
SENTINELS = ['999.0', '123456.0', 'x@y.z', 'DOC-777', '555-0100', 'Calle Falsa 123', '77777.5', '88888.5', '42.0']


@pytest.fixture
def con():
    """Two customers with only the columns the card reads plus planted forbidden columns."""
    con = duckdb.connect()
    con.execute('CREATE SCHEMA silver')
    con.execute('''CREATE TABLE silver.dim_customers(customer_id VARCHAR, first_name VARCHAR, date_of_birth DATE,
        country VARCHAR, detected_accent VARCHAR, segment VARCHAR, credit_score DOUBLE,
        estimated_monthly_income DOUBLE, accepts_marketing BOOLEAN, document_number VARCHAR, email VARCHAR,
        mobile_phone VARCHAR, address VARCHAR)''')
    con.execute('''INSERT INTO silver.dim_customers VALUES
        ('A','Ana',DATE '1990-05-20','Colombia','argentine','Premium',999.0,123456.0,true,'DOC-777','x@y.z','555-0100','Calle Falsa 123'),
        ('B','Beto',NULL,'Colombia',NULL,'Basic',999.0,123456.0,false,'DOC-777','x@y.z','555-0100','Calle Falsa 123')''')
    con.execute('''CREATE TABLE silver.dim_products(product_id VARCHAR, customer_id VARCHAR, product_type VARCHAR,
        product_number VARCHAR, currency VARCHAR, product_status VARCHAR, current_balance DOUBLE,
        current_balance_usd DOUBLE, credit_limit DOUBLE, credit_limit_usd DOUBLE, days_past_due DOUBLE)''')
    con.execute('''INSERT INTO silver.dim_products VALUES
        ('p1','A','Tarjeta Crédito','4111222233334444','COP','Active',77777.5,42.0,88888.5,42.0,42.0),
        ('p2','A','Cuenta Ahorro','000123459999','COP','Active',77777.5,42.0,88888.5,42.0,42.0),
        ('p3','A','Cuenta Ahorro','000123451111','USD','Active',77777.5,42.0,88888.5,42.0,42.0),
        ('p4','A','Tarjeta Débito','5555666677778888','COP','Closed',77777.5,42.0,88888.5,42.0,42.0),
        ('p5','B','Cuenta Ahorro','000000000000','ARS','Active',77777.5,42.0,88888.5,42.0,42.0)''')
    con.execute('''CREATE TABLE silver.fact_complaints(customer_id VARCHAR, creation_date TIMESTAMP,
        subcategory VARCHAR, status VARCHAR, claimed_amount DOUBLE)''')
    con.execute('''INSERT INTO silver.fact_complaints VALUES
        ('A',TIMESTAMP '2026-09-01 10:00:00','Cargo duplicado','Open',42.0),
        ('A',TIMESTAMP '2026-09-15 10:00:00','Cajero no entregó','Escalated',42.0),
        ('A',TIMESTAMP '2026-09-20 10:00:00','Tarifa','Resolved',42.0),
        ('A',TIMESTAMP '2026-09-08 10:00:00','Transferencia fallida','In Process',42.0),
        ('B',TIMESTAMP '2026-09-21 10:00:00','Otro','Open',42.0)''')
    con.execute('''CREATE TABLE silver.fact_call_center_interactions(customer_id VARCHAR, interaction_date TIMESTAMP,
        contact_reason VARCHAR, reason_category VARCHAR, sentiment_score DOUBLE)''')
    con.execute('''INSERT INTO silver.fact_call_center_interactions VALUES
        ('A',TIMESTAMP '2026-08-01 09:00:00','Consulta saldo','Transaccional',42.0),
        ('A',TIMESTAMP '2026-09-10 09:00:00','Reclamo cargo','Queja',42.0),
        ('B',TIMESTAMP '2026-09-11 09:00:00','Otro','Otro',42.0)''')
    con.execute('''CREATE TABLE silver.fact_digital_events(customer_id VARCHAR, event_date TIMESTAMP, channel VARCHAR,
        ip_address VARCHAR)''')
    # Within 90 days: 2x iOS App, 1x Android App. Outside window: 3x Desktop Web (would win if ignored).
    con.execute('''INSERT INTO silver.fact_digital_events VALUES
        ('A',TIMESTAMP '2026-09-01 08:00:00','iOS App','1.1.1.1'),
        ('A',TIMESTAMP '2026-09-02 08:00:00','iOS App','1.1.1.1'),
        ('A',TIMESTAMP '2026-09-03 08:00:00','Android App','1.1.1.1'),
        ('A',TIMESTAMP '2026-06-01 08:00:00','Desktop Web','1.1.1.1'),
        ('A',TIMESTAMP '2026-06-02 08:00:00','Desktop Web','1.1.1.1'),
        ('A',TIMESTAMP '2026-06-03 08:00:00','Desktop Web','1.1.1.1'),
        ('B',TIMESTAMP '2026-09-03 08:00:00','Mobile Web','1.1.1.1')''')
    return con


def test_full_card(con):
    card = build_context_card(con, 'A', TODAY)
    assert card['customer_id'] == 'A' and card['first_name'] == 'Ana'
    assert card['language_variant'] == 'es-AR' and card['variant_source'] == 'accent'
    assert card['date_format'] == 'DD/MM/YYYY'
    assert card['currency'] == 'COP'
    assert card['age_band'] == '30-44'
    assert card['segment'] == 'Premium'
    assert card['products'] == [{'product_type': 'Cuenta Ahorro', 'last4': '1111'},
                                {'product_type': 'Cuenta Ahorro', 'last4': '9999'},
                                {'product_type': 'Tarjeta Crédito', 'last4': '4444'}]
    assert card['open_complaints'] == [{'subcategory': 'Cajero no entregó', 'status': 'Escalated', 'created': '2026-09-15'},
                                       {'subcategory': 'Transferencia fallida', 'status': 'In Process', 'created': '2026-09-08'},
                                       {'subcategory': 'Cargo duplicado', 'status': 'Open', 'created': '2026-09-01'}]
    assert card['last_contact'] == {'reason': 'Reclamo cargo', 'category': 'Queja', 'date': '2026-09-10'}
    assert card['usual_channel'] == 'iOS App'


def test_variant_fallbacks(con):
    assert build_context_card(con, 'B', TODAY)['language_variant'] == 'es-CO'
    assert build_context_card(con, 'B', TODAY)['variant_source'] == 'country'
    con.execute("UPDATE silver.dim_customers SET country='Chile' WHERE customer_id='B'")
    card = build_context_card(con, 'B', TODAY)
    assert (card['language_variant'], card['variant_source']) == ('es-419', 'default')


def test_empty_customer(con):
    con.execute("DELETE FROM silver.dim_products WHERE customer_id='B'")
    con.execute("DELETE FROM silver.fact_digital_events WHERE customer_id='B'")
    con.execute("DELETE FROM silver.fact_call_center_interactions WHERE customer_id='B'")
    con.execute("DELETE FROM silver.fact_complaints WHERE customer_id='B'")
    card = build_context_card(con, 'B', TODAY)
    assert card['usual_channel'] == 'web' and card['currency'] is None and card['products'] == []
    assert card['open_complaints'] == [] and card['last_contact'] is None and card['age_band'] is None


def test_ties_and_nulls(con):
    # B: 1 ARS Active + 1 COP Active + 1 USD Closed -> alphabetical tie among Active only.
    con.execute("""INSERT INTO silver.dim_products VALUES
        ('p6','B','Tarjeta Débito',NULL,'COP','Active',0,0,0,0,0),
        ('p7','B','Tarjeta Crédito','12','USD','Closed',0,0,0,0,0)""")
    con.execute("INSERT INTO silver.fact_digital_events VALUES ('B',TIMESTAMP '2026-09-04 08:00:00','Android App','1.1.1.1')")
    card = build_context_card(con, 'B', TODAY)
    assert card['currency'] == 'ARS'
    assert card['usual_channel'] == 'Android App'
    assert card['products'] == [{'product_type': 'Cuenta Ahorro', 'last4': '0000'},
                                {'product_type': 'Tarjeta Débito', 'last4': None}]
    con.execute("UPDATE silver.dim_products SET product_status='Active' WHERE product_id='p7'")
    assert {'product_type': 'Tarjeta Crédito', 'last4': '12'} in build_context_card(con, 'B', TODAY)['products']
    # Next-day events must stay outside the window even when today arrives as a datetime with a clock time.
    con.execute("INSERT INTO silver.fact_digital_events VALUES ('B',TIMESTAMP '2026-09-30 00:00:00','Mobile Web','1.1.1.1'),"
                " ('B',TIMESTAMP '2026-09-30 01:00:00','Mobile Web','1.1.1.1')")
    card = build_context_card(con, 'B', dt.datetime(2026, 9, 29, 23, 59))
    assert card == build_context_card(con, 'B', TODAY) and card['usual_channel'] == 'Android App'


def test_unknown_customer(con):
    assert build_context_card(con, 'nope', TODAY) is None


def test_forbidden_signals_absent(con):
    for cid in ('A', 'B'):
        text = json.dumps(build_context_card(con, cid, TODAY), ensure_ascii=False)
        for name in FORBIDDEN_NAMES + SENTINELS:
            assert name not in text, name


@pytest.mark.parametrize('dob,band', [
    (dt.date(1996, 9, 29), '30-44'),   # turns 30 today
    (dt.date(1996, 9, 30), '18-29'),   # turns 30 tomorrow
    (dt.date(1966, 9, 29), '60+'),     # turns 60 today
    (dt.date(1966, 9, 30), '45-59'),
    (dt.date(1981, 9, 29), '45-59'),   # turns 45 today
])
def test_age_band_boundaries(con, dob, band):
    con.execute('UPDATE silver.dim_customers SET date_of_birth=? WHERE customer_id=?', [dob, 'A'])
    assert build_context_card(con, 'A', TODAY)['age_band'] == band


@pytest.mark.parametrize('band,expected', [
    ('60+', ('usted', 'slow', 1, True, 'formal')),
    ('45-59', ('usted', 'normal', 1, True, 'formal')),
    ('30-44', ('tú', 'normal', 2, False, 'neutral')),
    ('18-29', ('tú', 'fast', 2, False, 'casual')),
    (None, ('usted', 'normal', 1, True, 'formal')),
])
def test_style_defaults(band, expected):
    style = style_defaults({'age_band': band, 'language_variant': 'es-MX', 'segment': 'Premium'})
    assert (style['address'], style['pace'], style['questions_per_turn'],
            style['confirm_each_step'], style['register']) == expected
    assert set(style) == {'address', 'pace', 'questions_per_turn', 'confirm_each_step', 'register'}


def test_style_defaults_pt_address():
    assert style_defaults({'age_band': '60+', 'language_variant': 'pt-BR'})['address'] == 'o senhor/a senhora'
    assert style_defaults({'age_band': '18-29', 'language_variant': 'pt-BR'})['address'] == 'você'
