"""Unit tests for time-series shift analysis and dashboard generator."""

import tempfile
import unittest
from collections import Counter
from pathlib import Path

from data_foundation.src.generate_dashboard import render_dashboard
from data_foundation.src.time_series_shifts import analyze_shifts, compute_psi, extract_ym


class TestTimeSeriesShifts(unittest.TestCase):
    def test_extract_ym(self):
        p1 = Path("data/complaints/year=2024/month=05/day=12/data.csv")
        self.assertEqual(extract_ym(p1), "2024-05")

        p2 = Path("data/complaints/data.csv")
        self.assertEqual(extract_ym(p2), "Unknown")

    def test_compute_psi(self):
        # Identical distributions should yield ~0 PSI
        dist_a = [100.0, 200.0, 300.0]
        dist_b = [100.0, 200.0, 300.0]
        psi = compute_psi(dist_a, dist_b)
        self.assertAlmostEqual(psi, 0.0, places=4)

        # Shifted distribution
        dist_c = [300.0, 200.0, 100.0]
        psi_shifted = compute_psi(dist_a, dist_c)
        self.assertGreater(psi_shifted, 0.1)

    def test_analyze_shifts_and_dashboard(self):
        comp = {
            "2024-01": Counter({
                "total_complaints": 100,
                "unrec_complaints": 30,
                "unrec_sla_breached": 6,
                "unrec_ch_Call Center": 15,
                "unrec_ch_App": 15,
                "unrec_ptype_Tarjeta Crédito": 20,
                "unrec_ptype_Cuenta Ahorro": 10,
            }),
            "2025-01": Counter({
                "total_complaints": 100,
                "unrec_complaints": 30,
                "unrec_sla_breached": 6,
                "unrec_ch_Call Center": 15,
                "unrec_ch_App": 15,
                "unrec_ptype_Tarjeta Crédito": 20,
                "unrec_ptype_Cuenta Ahorro": 10,
            }),
        }
        tx = {
            "2024-01": Counter({"total_tx": 5000, "approved_tx": 5000}),
            "2025-01": Counter({"total_tx": 5000, "approved_tx": 5000}),
        }
        camp = {
            "2024-01": Counter({"total_sends": 1000, "delivered": 950, "conversions": 10, "total_cost": 50.0}),
            "2025-01": Counter({"total_sends": 1000, "delivered": 950, "conversions": 10, "total_cost": 50.0}),
        }
        dig = {
            "2024-01": Counter({"total_events": 2000, "et_Error": 40}),
            "2025-01": Counter({"total_events": 2000, "et_Error": 40}),
        }

        results = analyze_shifts(comp, tx, camp, dig)
        self.assertIn("monthly_series", results)
        self.assertIn("yearly_metrics", results)
        self.assertIn("shift_assessment", results)

        # Test HTML rendering
        html = render_dashboard(results)
        self.assertIn("Arabica AI", html)
        self.assertIn("Stationarity", html)
        self.assertIn("svg viewBox", html)


if __name__ == "__main__":
    unittest.main()
