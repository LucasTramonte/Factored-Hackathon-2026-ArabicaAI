"""Context card keeps sensitive fields out and session language in charge."""
import json

import duckdb

from intake_agent.context_card import build_context_card, reply_language


def test_minimal_card_and_session_language():
    with duckdb.connect() as con:
        con.execute('CREATE SCHEMA silver')
        con.execute('CREATE TABLE silver.dim_customers(customer_id VARCHAR, first_name VARCHAR, country VARCHAR, detected_accent VARCHAR, credit_score DOUBLE)')
        con.execute("INSERT INTO silver.dim_customers VALUES ('A','Ana','México','mexican',999)")
        con.execute('CREATE TABLE silver.dim_products(customer_id VARCHAR, product_type VARCHAR, product_number VARCHAR, currency VARCHAR, product_status VARCHAR, current_balance DOUBLE)')
        con.execute("INSERT INTO silver.dim_products VALUES ('A','Credit card','4111222233334444','USD','Active',999), ('A','Debit card','1234','MXN','Closed',999)")
        card = build_context_card(con, 'A')
        assert card == {'first_name': 'Ana', 'locale_hint': 'es-MX',
                        'products': [{'product_type': 'Credit card', 'last4': '4444', 'currency': 'USD'}]}
        assert reply_language('pt', card) == 'pt-BR'
        assert reply_language('es-CO', card) == 'es-CO'
        assert reply_language(None, card) == 'es-MX'
        assert '999' not in json.dumps(card)
        assert build_context_card(con, 'unknown') is None


def test_null_products_and_locale_fallback():
    with duckdb.connect() as con:
        con.execute('CREATE SCHEMA silver')
        con.execute('CREATE TABLE silver.dim_customers(customer_id VARCHAR, first_name VARCHAR, country VARCHAR, detected_accent VARCHAR)')
        con.execute("INSERT INTO silver.dim_customers VALUES ('B',NULL,'Chile',NULL)")
        con.execute('CREATE TABLE silver.dim_products(customer_id VARCHAR, product_type VARCHAR, product_number VARCHAR, currency VARCHAR, product_status VARCHAR)')
        con.execute("INSERT INTO silver.dim_products VALUES ('B','Account',NULL,NULL,'Active')")
        assert build_context_card(con, 'B') == {'first_name': None, 'locale_hint': 'es-419',
                                                'products': [{'product_type': 'Account', 'last4': None, 'currency': None}]}
