"""Regression tests for contract-driven streaming quality checks."""

import unittest
from pathlib import Path

from data_foundation.src.contracts import CONTRACTS
from data_foundation.src.quality.checks import row_checks, schema_checks
from data_foundation.scripts.run_baseline import partition_date_from_path


class QualityChecksTests(unittest.TestCase):
    def test_required_nulls_and_duplicate_keys_are_reported(self):
        """Required blanks and duplicate identifiers remain independently visible."""

        contract = CONTRACTS["call_center_interactions"]
        rows = [
            {"interaction_id": "INT-1", "interaction_date": "2026-01-01T10:00:00", "process_date": "2026-01-01", "customer_id": "CLI-1", "interaction_type": "Chat", "channel": "Phone", "contact_reason": "Transaccional", "reason_category": "Transaccional", "requires_followup": "False", "was_escalated": "False", "has_transcript": "False"},
            {"interaction_id": "INT-1", "interaction_date": "2026-01-01T10:00:00", "process_date": "2026-01-01", "customer_id": "", "interaction_type": "Chat", "channel": "Phone", "contact_reason": "Transaccional", "reason_category": "Transaccional", "requires_followup": "False", "was_escalated": "False", "has_transcript": "False"},
        ]
        results, keys = row_checks(contract, rows, "2026-01-01")
        self.assertEqual(keys, {"INT-1"})
        self.assertEqual(next(r["numerator"] for r in results if r["check"] == "duplicate_primary_keys"), 1)
        self.assertEqual(next(r["numerator"] for r in results if r["field"] == "customer_id"), 1)

    def test_schema_missing_columns_are_errors(self):
        """Missing contract columns produce an error-level result."""

        contract = CONTRACTS["customers"]
        results = schema_checks(contract, ["customer_id"])
        missing = next(r for r in results if r["check"] == "schema_missing_columns")
        self.assertEqual(missing["severity"], "error")
        self.assertIn("country", missing["sample"])

    def test_domain_and_partition_violations_are_reported(self):
        """Unexpected domains and partition mismatches are reported with counts."""

        contract = CONTRACTS["call_center_interactions"]
        row = {"interaction_id": "INT-1", "interaction_date": "2026-01-02T10:00:00", "process_date": "2026-01-02", "customer_id": "CLI-1", "interaction_type": "Chat", "channel": "Unknown", "contact_reason": "Transaccional", "reason_category": "Transaccional", "requires_followup": "False", "was_escalated": "False", "has_transcript": "False"}
        results, _ = row_checks(contract, [row], "2026-01-01")
        self.assertEqual(next(r["numerator"] for r in results if r["check"] == "domain_violations"), 1)
        self.assertEqual(next(r["numerator"] for r in results if r["check"] == "partition_date_mismatch"), 1)

    def test_exchange_rate_composite_key_is_unique_by_currency_pair(self):
        """Exchange-rate duplicates use date and both currency columns."""

        contract = CONTRACTS["daily_exchange_rates"]
        rows = [
            {"date": "2026-01-01", "source_currency": "MXN", "target_currency": "USD", "exchange_rate": "0.05"},
            {"date": "2026-01-01", "source_currency": "COP", "target_currency": "USD", "exchange_rate": "0.0002"},
            {"date": "2026-01-01", "source_currency": "MXN", "target_currency": "USD", "exchange_rate": "0.05"},
        ]
        results, keys = row_checks(contract, rows)
        self.assertEqual(keys, {"2026-01-01|MXN|USD", "2026-01-01|COP|USD"})
        self.assertEqual(next(r["numerator"] for r in results if r["check"] == "duplicate_primary_keys"), 1)

    def test_partition_date_requires_complete_path(self):
        """Partition parsing preserves full year, month, and day components."""

        path = Path("data/transactions/year=2026/month=06/day=17/file.csv")
        self.assertEqual(partition_date_from_path(path), "2026-06-17")
        self.assertIsNone(partition_date_from_path(Path("data/transactions/year=2026/month=06/file.csv")))

    def test_row_checks_are_invariant_for_generator_input(self):
        """The row checker produces the same result for a list and generator."""

        contract = CONTRACTS["call_center_interactions"]
        rows = [{"interaction_id": f"INT-{index}", "interaction_date": "2026-01-01T10:00:00", "process_date": "2026-01-01", "customer_id": f"CLI-{index}", "interaction_type": "Chat", "channel": "Phone", "contact_reason": "Transaccional", "reason_category": "Transaccional", "requires_followup": "False", "was_escalated": "False", "has_transcript": "False"} for index in range(4)]
        list_results, list_keys = row_checks(contract, rows, "2026-01-01")
        generator_results, generator_keys = row_checks(contract, (row for row in rows), "2026-01-01")
        self.assertEqual(list_results, generator_results)
        self.assertEqual(list_keys, generator_keys)


    def test_schema_duplicate_columns_reported_as_error(self):
        """Duplicate column headers produce an error-level schema result."""

        contract = CONTRACTS["customers"]
        header = ["customer_id", "document_number", "customer_id", "country"]
        results = schema_checks(contract, header)
        dup = next(r for r in results if r["check"] == "schema_duplicate_columns")
        self.assertEqual(dup["severity"], "error")
        self.assertEqual(dup["numerator"], 1)
        self.assertEqual(dup["sample"], ["customer_id"])

        clean_results = schema_checks(contract, list(contract.expected_columns))
        clean_dup = next(r for r in clean_results if r["check"] == "schema_duplicate_columns")
        self.assertEqual(clean_dup["severity"], "info")
        self.assertEqual(clean_dup["numerator"], 0)

    def test_blank_primary_key_not_double_counted(self):
        """A blank primary key row contributes exactly one null to required-field counts."""

        contract = CONTRACTS["customers"]
        row = {
            "customer_id": "",
            "document_number": "DOC123",
            "country": "CO",
            "segment": "Retail",
            "customer_status": "Active",
            "accepts_marketing": "True",
            "registration_branch_id": "BR-1",
        }
        results, _ = row_checks(contract, [row])
        pk_nulls = next(r for r in results if r["check"] == "required_field_nulls" and r["field"] == "customer_id")
        self.assertEqual(pk_nulls["numerator"], 1)

    def test_late_arrival_comparison_logic(self):
        """Late arrival signals rows where event date is strictly before process partition."""

        contract = CONTRACTS["transactions"]
        rows = [
            {"transaction_id": "T1", "transaction_date": "2026-06-10T10:00:00", "process_date": "2026-06-15", "product_id": "P1", "customer_id": "C1", "transaction_type": "Purchase", "amount": "100", "currency": "USD", "channel": "POS", "transaction_status": "Completed", "is_fraud": "False"},
            {"transaction_id": "T2", "transaction_date": "2026-06-15T10:00:00", "process_date": "2026-06-15", "product_id": "P1", "customer_id": "C1", "transaction_type": "Purchase", "amount": "100", "currency": "USD", "channel": "POS", "transaction_status": "Completed", "is_fraud": "False"},
            {"transaction_id": "T3", "transaction_date": "2026-06-20T10:00:00", "process_date": "2026-06-15", "product_id": "P1", "customer_id": "C1", "transaction_type": "Purchase", "amount": "100", "currency": "USD", "channel": "POS", "transaction_status": "Completed", "is_fraud": "False"},
        ]
        results, _ = row_checks(contract, rows, "2026-06-15")
        late_check = next(r for r in results if r["check"] == "late_arrival_signal")
        self.assertEqual(late_check["numerator"], 1)
        self.assertEqual(late_check["message"], "Business date is before process partition")

    def test_fact_table_row_checks_does_not_retain_unneeded_in_memory_keys(self):
        """Partitioned fact tables without child dependencies return an empty in-memory key set."""

        contract = CONTRACTS["transactions"]
        rows = [
            {"transaction_id": "T1", "transaction_date": "2026-06-15T10:00:00", "process_date": "2026-06-15", "product_id": "P1", "customer_id": "C1", "transaction_type": "Purchase", "amount": "100", "currency": "USD", "channel": "POS", "transaction_status": "Completed", "is_fraud": "False"},
            {"transaction_id": "T1", "transaction_date": "2026-06-15T10:00:00", "process_date": "2026-06-15", "product_id": "P1", "customer_id": "C1", "transaction_type": "Purchase", "amount": "100", "currency": "USD", "channel": "POS", "transaction_status": "Completed", "is_fraud": "False"},
        ]
        results, in_memory_keys = row_checks(contract, rows, "2026-06-15")
        self.assertEqual(in_memory_keys, set())
        dup_check = next(r for r in results if r["check"] == "duplicate_primary_keys")
        self.assertEqual(dup_check["numerator"], 1)

    def test_disk_key_set_operations(self):
        """DiskKeySet correctly detects duplicates and supports membership checks."""

        from data_foundation.src.quality.checks import DiskKeySet

        with DiskKeySet() as tracker:
            self.assertTrue(tracker.add("K1"))
            self.assertFalse(tracker.add("K1"))
            self.assertTrue("K1" in tracker)
            self.assertFalse("K2" in tracker)
            self.assertTrue(tracker.add("K2"))
            self.assertTrue("K2" in tracker)


class BaselineRunnerTests(unittest.TestCase):
    def test_run_baseline_rejects_unknown_table_before_run_directory_creation(self):
        """Selecting an unknown table raises ValueError and creates no run directory."""

        import tempfile
        from data_foundation.scripts.run_baseline import run

        with tempfile.TemporaryDirectory() as temp_dir:
            out_root = Path(temp_dir) / "runs"
            with self.assertRaises(ValueError) as ctx:
                run(Path("data"), out_root, selected_tables={"nonexistent_table"}, run_id="invalid_run")
            self.assertIn("nonexistent_table", str(ctx.exception))
            self.assertFalse((out_root / "invalid_run").exists())

    def test_run_baseline_detects_cross_partition_duplicate_keys(self):
        """Cross-partition primary-key collisions are reported as errors."""

        import csv
        import tempfile
        from data_foundation.scripts.run_baseline import run

        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir) / "data"
            out_dir = Path(temp_dir) / "runs"
            p1 = data_dir / "transactions" / "year=2026" / "month=01" / "day=01"
            p2 = data_dir / "transactions" / "year=2026" / "month=01" / "day=02"
            p1.mkdir(parents=True)
            p2.mkdir(parents=True)

            cols = CONTRACTS["transactions"].expected_columns
            row1 = {c: "Val" for c in cols}
            row1.update({"transaction_id": "TXN-SHARED", "process_date": "2026-01-01", "transaction_date": "2026-01-01T10:00:00"})
            row2 = {c: "Val" for c in cols}
            row2.update({"transaction_id": "TXN-SHARED", "process_date": "2026-01-02", "transaction_date": "2026-01-02T10:00:00"})

            for target_path, row in [(p1 / "data.csv", row1), (p2 / "data.csv", row2)]:
                with target_path.open("w", encoding="utf-8", newline="") as f:
                    writer = csv.DictWriter(f, fieldnames=cols)
                    writer.writeheader()
                    writer.writerow(row)

            results = run(data_dir, out_dir, selected_tables={"transactions"}, run_id="cross_part_run")
            cross_dup = next(r for r in results if r["check"] == "duplicate_primary_keys_across_partitions")
            self.assertEqual(cross_dup["severity"], "error")
            self.assertEqual(cross_dup["numerator"], 1)
            self.assertEqual(cross_dup["sample"], "TXN-SHARED")

    def test_run_baseline_unscanned_parent_distinction(self):
        """Focused scan loads available parent dimension rather than marking 100% orphans."""

        import csv
        import tempfile
        from data_foundation.scripts.run_baseline import run

        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir) / "data"
            out_dir = Path(temp_dir) / "runs"
            data_dir.mkdir(parents=True)

            # Write customers.csv with CUST-1
            cust_cols = CONTRACTS["customers"].expected_columns
            cust_file = data_dir / "customers.csv"
            with cust_file.open("w", encoding="utf-8", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=cust_cols)
                writer.writeheader()
                writer.writerow({"customer_id": "CUST-1", "document_number": "D1", "country": "CO", "segment": "Retail", "customer_status": "Active", "accepts_marketing": "True", "registration_branch_id": "BR-1"})

            # Write products.csv referencing CUST-1 (not orphan)
            prod_cols = CONTRACTS["products"].expected_columns
            prod_file = data_dir / "products.csv"
            with prod_file.open("w", encoding="utf-8", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=prod_cols)
                writer.writeheader()
                writer.writerow({"product_id": "P1", "customer_id": "CUST-1", "product_type": "Checking", "currency": "USD", "product_status": "Active", "opening_channel": "Web", "has_linked_app": "True", "last_transaction_date": "2026-01-01"})

            # Focused scan only on products (customers is unscanned in initial table loop)
            results = run(data_dir, out_dir, selected_tables={"products"}, run_id="focused_prod_run")
            orphans = next(r for r in results if r["check"] == "foreign_key_orphans" and r["field"] == "customer_id")
            self.assertEqual(orphans["numerator"], 0)
            self.assertEqual(orphans["severity"], "info")

    def test_run_baseline_invalid_partition_path_emits_error(self):
        """A file with an invalid partition date path triggers partition_path_invalid error."""

        import csv
        import tempfile
        from data_foundation.scripts.run_baseline import run

        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir) / "data"
            out_dir = Path(temp_dir) / "runs"
            bad_dir = data_dir / "transactions" / "year=2026" / "month=99" / "day=99"
            bad_dir.mkdir(parents=True)

            cols = CONTRACTS["transactions"].expected_columns
            row = {c: "Val" for c in cols}
            row.update({"transaction_id": "T1", "process_date": "2026-01-01", "transaction_date": "2026-01-01T10:00:00"})

            with (bad_dir / "data.csv").open("w", encoding="utf-8", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=cols)
                writer.writeheader()
                writer.writerow(row)

            results = run(data_dir, out_dir, selected_tables={"transactions"}, run_id="bad_partition_run")
            path_err = next(r for r in results if r["check"] == "partition_path_invalid")
            self.assertEqual(path_err["severity"], "error")


if __name__ == "__main__":
    unittest.main()