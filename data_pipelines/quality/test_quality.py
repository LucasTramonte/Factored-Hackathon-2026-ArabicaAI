"""Focused regression fixtures for the Bronze/Silver readiness gate."""
import duckdb
import pytest

from data_pipelines.quality.checks import run_checks, _SILVER_COLUMNS
from data_pipelines.quality.contracts import CONTRACTS


@pytest.fixture
def con():
    connection = duckdb.connect()
    connection.execute("CREATE SCHEMA bronze; CREATE SCHEMA silver")
    yield connection
    connection.close()


def tables(con, name, rows):
    contract = CONTRACTS[name]
    columns = list(contract.expected_columns)
    fields = ", ".join(f'"{column}" VARCHAR' for column in columns)
    prefix = 'fact_' if contract.partition_field else 'dim_'
    con.execute(f'CREATE TABLE bronze."{name}" ({fields}, _source_file VARCHAR)')
    silver_columns = sorted(_SILVER_COLUMNS[name])
    silver_fields = ", ".join(f'"{column}" VARCHAR' for column in silver_columns)
    con.execute(f'CREATE TABLE silver."{prefix}{name}" ({silver_fields})')
    for values in rows:
        raw = [values.get(column) for column in columns]
        placeholders = ', '.join('?' for _ in columns)
        con.execute(f'INSERT INTO bronze."{name}" VALUES ({placeholders}, ?)', raw + [values.get('_source_file')])
        silver_values = [values.get("date" if column == "rate_date" else column) for column in silver_columns]
        silver_placeholders = ", ".join("?" for _ in silver_columns)
        con.execute(f'INSERT INTO silver."{prefix}{name}" VALUES ({silver_placeholders})', silver_values)


def find(results, check, table, field=None):
    return next(item for item in results if item['check'] == check and item['table'] == table and item['field'] == field)


def test_missing_table_blocks_readiness(con):
    result = run_checks(con, ['customers'])
    assert find(result, 'table_discovery', 'customers')['severity'] == 'error'


def test_duplicate_and_required_fields_are_visible_before_silver_dedup(con):
    tables(con, 'customers', [
        {'customer_id': 'C1', 'country': 'México', 'customer_status': 'Active'},
        {'customer_id': 'C1', 'country': '', 'customer_status': 'Wrong'},
    ])
    con.execute("DELETE FROM silver.dim_customers WHERE country='' ")
    result = run_checks(con, ['customers'])
    assert find(result, 'duplicate_primary_keys', 'customers', 'customer_id')['numerator'] == 1
    assert find(result, 'silver_row_delta_unexplained', 'customers')['numerator'] == 0
    assert find(result, 'required_field_nulls', 'customers', 'country')['numerator'] == 1
    assert find(result, 'domain_violations', 'customers', 'customer_status')['numerator'] == 1


def test_partition_business_date_and_foreign_key_are_separate(con):
    tables(con, 'customers', [{'customer_id':'C1', 'country':'Colombia', 'customer_status':'Active'}])
    tables(con, 'marketing_campaigns', [{'campaign_id':'M1', 'campaign_status':'Active'}])
    tables(con, 'campaign_sends', [
        {'send_id':'S1', 'send_date':'2024-01-01 23:00:00', 'process_date':'2024-01-02',
         'campaign_id':'M1', 'customer_id':'C1', 'send_channel':'Email', 'send_status':'Sent',
         'was_delivered':'True', 'had_conversion':'False',
         '_source_file':'s3://bucket/data/campaign_sends/year=2024/month=01/day=02/part.csv'},
        {'send_id':'S2', 'send_date':'2024-01-03 00:00:00', 'process_date':'2024-01-02',
         'campaign_id':'Missing', 'customer_id':'C1', 'send_channel':'Email', 'send_status':'Sent',
         'was_delivered':'True', 'had_conversion':'False',
         '_source_file':'s3://bucket/data/campaign_sends/year=2024/month=01/day=03/part.csv'},
    ])
    result = run_checks(con, ['campaign_sends', 'marketing_campaigns', 'customers'])
    assert find(result, 'late_arrival_signal', 'campaign_sends', 'send_date')['numerator'] == 1
    assert find(result, 'partition_date_mismatch', 'campaign_sends', 'process_date')['numerator'] == 1
    assert find(result, 'foreign_key_orphans', 'campaign_sends', 'campaign_id')['numerator'] == 1


def test_missing_silver_and_cross_file_duplicates(con):
    tables(con, 'campaign_sends', [
        {'send_id':'S1', 'send_date':'2024-01-01', 'process_date':'2024-01-01',
         'campaign_id':'M1', 'customer_id':'C1', 'send_channel':'Email', 'send_status':'Sent',
         'was_delivered':'True', 'had_conversion':'False',
         '_source_file':'s3://bucket/campaign_sends/year=2024/month=01/day=01/a.csv'},
        {'send_id':'S1', 'send_date':'2024-01-02', 'process_date':'2024-01-02',
         'campaign_id':'M1', 'customer_id':'C1', 'send_channel':'Email', 'send_status':'Sent',
         'was_delivered':'True', 'had_conversion':'False',
         '_source_file':'s3://bucket/campaign_sends/year=2024/month=01/day=02/b.csv'},
    ])
    con.execute("DELETE FROM silver.fact_campaign_sends WHERE process_date='2024-01-02'")
    results = run_checks(con, ['campaign_sends'])
    assert find(results, 'duplicate_primary_keys_across_partitions', 'campaign_sends', 'send_id')['numerator'] == 1
    con.execute('DROP TABLE silver.fact_campaign_sends')
    results = run_checks(con, ['campaign_sends'])
    assert find(results, 'silver_table_discovery', 'campaign_sends')['severity'] == 'error'


def test_cross_file_duplicates_count_each_row_in_later_file(con):
    path_a = 's3://bucket/customers/a.csv'
    path_b = 's3://bucket/customers/b.csv'
    tables(con, 'customers', [
        {'customer_id': 'C1', 'country': 'Mexico', 'customer_status': 'Active', '_source_file': path_a},
        {'customer_id': 'C1', 'country': 'Mexico', 'customer_status': 'Active', '_source_file': path_b},
        {'customer_id': 'C1', 'country': 'Mexico', 'customer_status': 'Active', '_source_file': path_b},
    ])
    result = run_checks(con, ['customers'])
    assert find(result, 'duplicate_primary_keys', 'customers', 'customer_id')['numerator'] == 2
    assert find(result, 'duplicate_primary_keys_within_file', 'customers', 'customer_id')['numerator'] == 1
    assert find(result, 'duplicate_primary_keys_across_partitions', 'customers', 'customer_id')['numerator'] == 2


def test_partial_silver_build_blocks_readiness(con):
    tables(con, 'customers', [
        {'customer_id': 'C1', 'country': 'Mexico', 'customer_status': 'Active'},
        {'customer_id': 'C2', 'country': 'Mexico', 'customer_status': 'Active'},
    ])
    con.execute("DELETE FROM silver.dim_customers WHERE customer_id='C2'")
    result = run_checks(con, ['customers'])
    delta = find(result, 'silver_row_delta_unexplained', 'customers')
    assert delta['numerator'] == 1
    assert delta['severity'] == 'error'


def test_unique_field_violation_counts_excess_rows_not_groups(con):
    # 3 customers share one document_number -> 2 excess rows (the group's size minus 1), not 3 and
    # not "1 violation" -- matches the duplicate_primary_keys convention. A 4th, distinct customer
    # with a NULL document_number must not be swept in as a false collision.
    tables(con, 'customers', [
        {'customer_id': 'C1', 'document_number': 'DOC-1', 'country': 'México', 'customer_status': 'Active'},
        {'customer_id': 'C2', 'document_number': 'DOC-1', 'country': 'México', 'customer_status': 'Active'},
        {'customer_id': 'C3', 'document_number': 'DOC-1', 'country': 'México', 'customer_status': 'Active'},
        {'customer_id': 'C4', 'document_number': None, 'country': 'México', 'customer_status': 'Active'},
    ])
    result = run_checks(con, ['customers'])
    violation = find(result, 'unique_field_violations', 'customers', 'document_number')
    assert violation['numerator'] == 2
    assert violation['severity'] == 'warning'


def test_unique_field_violation_is_clean_when_values_differ(con):
    tables(con, 'products', [
        {'product_id': 'P1', 'customer_id': 'C1', 'product_number': 'ACC-1',
         'product_type': 'Checking', 'currency': 'USD', 'product_status': 'Active'},
        {'product_id': 'P2', 'customer_id': 'C1', 'product_number': 'ACC-2',
         'product_type': 'Checking', 'currency': 'USD', 'product_status': 'Active'},
    ])
    result = run_checks(con, ['products'])
    violation = find(result, 'unique_field_violations', 'products', 'product_number')
    assert violation['numerator'] == 0
    assert violation['severity'] == 'info'


def test_focused_foreign_key_parent_is_skipped(con):
    tables(con, "campaign_sends", [{"send_id": "S1", "send_date": "2024-01-01",
        "process_date": "2024-01-01", "campaign_id": "M1", "customer_id": "C1",
        "send_channel": "Email", "send_status": "Sent", "was_delivered": "True",
        "had_conversion": "False"}])
    focused = run_checks(con, ["campaign_sends"])
    assert find(focused, "foreign_key_skipped", "campaign_sends", "campaign_id")["severity"] == "info"
    full = run_checks(con)
    assert find(full, "foreign_key_parent_missing", "campaign_sends", "campaign_id")["severity"] == "error"


def test_silver_derived_column_is_required(con):
    tables(con, "transactions", [{"transaction_id": "T1", "transaction_date": "2024-01-01",
        "process_date": "2024-01-01", "product_id": "P1", "customer_id": "C1",
        "transaction_type": "Purchase", "amount": "1", "currency": "USD",
        "channel": "App", "transaction_status": "Approved", "is_fraud": "False"}])
    con.execute('ALTER TABLE silver.fact_transactions DROP COLUMN amount_usd_is_estimated')
    results = run_checks(con, ["transactions"])
    assert find(results, "silver_schema_missing_columns", "transactions")["numerator"] == 1


def test_relationship_checks_skip_missing_columns(con):
    tables(con, "products", [{"product_id": "P1", "customer_id": "C1",
        "product_type": "Checking", "currency": "USD", "product_status": "Active"}])
    tables(con, "transactions", [{"transaction_id": "T1", "transaction_date": "2024-01-01",
        "process_date": "2024-01-01", "product_id": "P1", "customer_id": "C1",
        "transaction_type": "Purchase", "amount": "1", "currency": "USD",
        "channel": "App", "transaction_status": "Approved", "is_fraud": "False"}])
    con.execute('ALTER TABLE bronze.transactions DROP COLUMN customer_id')
    results = run_checks(con)
    assert find(results, "schema_missing_columns", "transactions")["severity"] == "error"
    assert not any(item["check"] == "product_owner_mismatch" and item["table"] == "transactions" for item in results)
    con.execute('ALTER TABLE bronze.products DROP COLUMN product_id')
    results = run_checks(con)
    assert find(results, "schema_missing_columns", "products")["severity"] == "error"


def test_full_quality_report_survives_missing_relationship_columns(tmp_path):
    from data_pipelines.quality.run_quality import main
    db = tmp_path / "quality.duckdb"
    connection = duckdb.connect(str(db))
    connection.execute("CREATE SCHEMA bronze; CREATE SCHEMA silver")
    tables(connection, "products", [{"product_id": "P1", "customer_id": "C1",
        "product_type": "Checking", "currency": "USD", "product_status": "Active"}])
    tables(connection, "transactions", [{"transaction_id": "T1", "transaction_date": "2024-01-01",
        "process_date": "2024-01-01", "product_id": "P1", "customer_id": "C1",
        "transaction_type": "Purchase", "amount": "1", "currency": "USD",
        "channel": "App", "transaction_status": "Approved", "is_fraud": "False"}])
    connection.execute('ALTER TABLE bronze.transactions DROP COLUMN customer_id')
    connection.close()
    status = main(["--db", str(db), "--output-root", str(tmp_path / "reports"), "--run-id", "fixture"])
    assert status == 1
    import json
    report = json.loads((tmp_path / "reports" / "fixture" / "quality_results.json").read_text())
    assert any(row["check"] == "schema_missing_columns" and row["table"] == "transactions"
               for row in report["checks"])
