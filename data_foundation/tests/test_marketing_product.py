"""Focused fixtures for marketing and product evidence without full-data scans."""

import csv
import tempfile
import unittest
from pathlib import Path

from data_foundation.scripts.run_marketing_product import run_analysis


COLUMNS = {
    "customers": "customer_id country segment accepts_marketing registration_date",
    "products": "product_id customer_id product_type product_status opening_date has_linked_app",
    "marketing_campaigns": "campaign_id campaign_objective promoted_product target_segment target_country campaign_status",
    "campaign_sends": "send_id send_date process_date campaign_id customer_id send_channel send_status was_delivered was_opened was_clicked had_conversion conversion_date conversion_value",
    "transactions": "transaction_id transaction_date process_date product_id transaction_status",
    "digital_events": "event_id event_date process_date customer_id session_id event_type event_category action product_id channel utm_campaign",
}


class MarketingProductTests(unittest.TestCase):
    """Check grains, denominators, ordering, and private report output."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / "data"
        self.out = self.root / "runs"

    def write(self, table, rows, filename=None):
        """Write a tiny projected CSV for one table."""
        columns = COLUMNS[table].split()
        path = self.data / (filename or (f"{table}/part.csv" if table in ("campaign_sends", "transactions", "digital_events") else table + ".csv"))
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=columns)
            writer.writeheader()
            writer.writerows(rows)

    def fixture(self):
        """Create small dimensions and empty fact headers."""
        self.write("customers", [
            {"customer_id": "C1", "country": "Colombia", "segment": "Basic", "accepts_marketing": "True"},
            {"customer_id": "C2", "country": "México", "segment": "Plus", "accepts_marketing": "False"},
        ])
        self.write("products", [
            {"product_id": "P1", "customer_id": "C1", "product_type": "Cuenta Ahorro", "product_status": "Active", "has_linked_app": "True", "opening_date": "2025-01-01"},
            {"product_id": "P2", "customer_id": "C2", "product_type": "Tarjeta Crédito", "product_status": "Closed", "has_linked_app": "False", "opening_date": "2024-01-01"},
        ])
        self.write("marketing_campaigns", [
            {"campaign_id": "M1", "campaign_objective": "Retention", "promoted_product": "Cuenta Ahorro", "campaign_status": "Completed"},
        ])
        for table in ("campaign_sends", "transactions", "digital_events"):
            self.write(table, [])

    def test_send_grain_unknowns_repeats_and_consent_snapshot(self):
        """One send is counted once, unknown opens stay unknown, and repeat exposure is visible."""
        self.fixture()
        self.write("campaign_sends", [
            {"send_id": "A", "send_date": "2026-01-01 10:00:00", "campaign_id": "M1", "customer_id": "C1", "send_channel": "Email", "was_delivered": "True", "was_opened": "True", "was_clicked": "False", "had_conversion": "True", "conversion_date": "2026-01-02"},
            {"send_id": "B", "send_date": "2026-01-02 10:00:00", "campaign_id": "M1", "customer_id": "C1", "send_channel": "SMS", "was_delivered": "False", "was_opened": "", "was_clicked": "", "had_conversion": "False"},
            {"send_id": "C", "send_date": "2026-01-03 10:00:00", "campaign_id": "M1", "customer_id": "C2", "send_channel": "Email", "was_delivered": "True", "was_opened": "False", "was_clicked": "False", "had_conversion": "False"},
            {"send_id": "A", "send_date": "2026-01-01 10:00:00", "campaign_id": "M1", "customer_id": "C1", "send_channel": "Email", "was_delivered": "True", "was_opened": "True", "was_clicked": "False", "had_conversion": "True"},
        ])
        result = run_analysis(self.data, self.out, "send_fixture")
        self.assertEqual(result["quality"]["campaign_sends"]["duplicate_keys"], 1)
        self.assertEqual(result["marketing"]["overall"]["sends"], 3)
        self.assertEqual(result["marketing"]["overall"]["delivered"], 2)
        self.assertEqual(result["marketing"]["overall"]["conversions"], 1)
        self.assertEqual(result["marketing"]["repeat_exposed_customers"], 1)
        self.assertEqual(result["marketing"]["current_opt_out_sends"], 1)
        self.assertEqual(result["marketing"]["overall"]["open_unknown"], 1)

    def test_product_activity_and_ordered_session_funnel(self):
        """Activity joins at product grain and a product event before login cannot advance a session."""
        self.fixture()
        self.write("transactions", [
            {"transaction_id": "TXN-FIXTURE-SECRET-1", "product_id": "P1", "transaction_status": "Approved"},
            {"transaction_id": "T2", "product_id": "P2", "transaction_status": "Declined"},
        ])
        self.write("digital_events", [
            {"event_id": "E1", "session_id": "S1", "customer_id": "C1", "event_date": "2026-01-01 10:00:00", "event_type": "Login", "action": "logout"},
            {"event_id": "E2", "session_id": "S1", "customer_id": "C1", "event_date": "2026-01-01 10:01:00", "event_type": "PageView", "event_category": "Product"},
            {"event_id": "E3", "session_id": "S1", "customer_id": "C1", "event_date": "2026-01-01 10:02:00", "event_type": "Click", "event_category": "Product", "product_id": "P1"},
            {"event_id": "E4", "session_id": "S2", "customer_id": "C1", "event_date": "2026-01-01 11:00:00", "event_type": "PageView", "event_category": "Product"},
            {"event_id": "E5", "session_id": "S2", "customer_id": "C1", "event_date": "2026-01-01 11:01:00", "event_type": "Login"},
            {"event_id": "E6", "session_id": "S3", "customer_id": "C1", "event_date": "2026-01-01 12:00:00", "event_type": "Login"},
            {"event_id": "E7", "session_id": "S3", "customer_id": "C2", "event_date": "2026-01-01 12:01:00", "event_type": "PageView", "event_category": "Product"},
            {"event_id": "E8", "session_id": "S4", "event_date": "2026-01-01 13:00:00", "event_type": "PageView", "event_category": "Product"},
        ])
        result = run_analysis(self.data, self.out, "funnel_fixture")
        funnel = result["digital"]["funnel"]
        self.assertEqual([funnel[k] for k in ("all_sessions", "ambiguous_sessions", "eligible_sessions", "login", "product_after_login", "linked_product_after_product")], [4, 1, 3, 2, 1, 1])
        self.assertEqual(result["digital"]["login_action_mismatch"], 1)
        self.assertEqual(result["products"]["approved_transaction_count_by_type"]["Cuenta Ahorro"], 1)
        html = (self.out / "funnel_fixture" / "report.html").read_text()
        self.assertNotIn("C1", html)
        self.assertNotIn("S1", html)
        self.assertNotIn("TXN-FIXTURE-SECRET-1", html)

    def test_missing_keys_orphans_and_invalid_time_are_visible(self):
        """Skipped fact IDs and unresolved links remain explicit quality signals."""
        self.fixture()
        self.write("campaign_sends", [
            {"send_id": "", "send_channel": "Email", "had_conversion": "True"},
            {"send_id": "A", "send_date": "2026-01-02 10:00:00", "conversion_date": "2026-01-01 10:00:00", "had_conversion": "True", "was_delivered": "True", "campaign_id": "M1", "customer_id": "C1"},
        ])
        self.write("campaign_sends", [{"send_id": "A", "had_conversion": "True"}], filename="campaign_sends/second.csv")
        self.write("transactions", [{"transaction_id": "T-ORPHAN", "product_id": "P-UNKNOWN", "transaction_status": "Approved"}])
        self.write("digital_events", [
            {"event_id": "E1", "session_id": "S1", "event_date": "2026-01-01 10:00:00", "event_type": "Login"},
            {"event_id": "E2", "session_id": "S1", "event_date": "bad", "event_type": "PageView", "event_category": "Product"},
            {"event_id": "E3", "session_id": "S1", "event_date": "2026-01-01 10:01:00", "event_type": "PageView", "event_category": "Product", "product_id": "P-UNKNOWN"},
        ])
        result = run_analysis(self.data, self.out, "quality_fixture")
        self.assertEqual(result["quality"]["campaign_sends"]["blank_keys"], 1)
        self.assertEqual(result["quality"]["campaign_sends"]["duplicate_keys"], 1)
        self.assertEqual(result["marketing"]["quality_signals"]["conversion_before_send"], 1)
        self.assertEqual(result["quality"]["transactions"]["approved_unknown_product_id"], 1)
        self.assertEqual(result["digital"]["coverage"]["invalid_time_events"], 1)
        self.assertEqual(result["digital"]["coverage"]["unknown_product_events"], 1)
        self.assertEqual(result["digital"]["funnel"].get("linked_product_after_product", 0), 0)

    def test_duplicate_dimension_key_rejected(self):
        """Ambiguous small-side keys must fail rather than inflate a fact join."""
        self.fixture()
        self.write("customers", [{"customer_id": "C1"}, {"customer_id": "C1"}])
        with self.assertRaises(ValueError):
            run_analysis(self.data, self.out, "bad_dimension")


if __name__ == "__main__":
    unittest.main()
