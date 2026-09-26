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


if __name__ == "__main__":
    unittest.main()