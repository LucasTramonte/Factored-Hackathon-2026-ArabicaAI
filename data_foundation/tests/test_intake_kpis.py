"""Statistics used by the intake decision-KPI baselines, checked against hand-computed values."""
import math
import unittest

from data_foundation.scripts.run_intake_kpis import cochran_armitage, poisson_gof, relative_risk
from data_foundation.src.intake_stats import wilson


class IntakeKpiStatsTests(unittest.TestCase):
    def test_wilson_matches_a_known_interval(self):
        lo, hi = wilson(53, 60)
        self.assertAlmostEqual(lo, 0.7782, places=3)
        self.assertAlmostEqual(hi, 0.9423, places=3)
        self.assertTrue(all(math.isnan(v) for v in wilson(0, 0)))

    def test_trend_is_zero_for_flat_rates_and_strong_for_a_ramp(self):
        flat = cochran_armitage([10, 10, 10, 10], [100, 100, 100, 100])
        self.assertEqual(flat['z'], 0.0)
        self.assertAlmostEqual(flat['p'], 1.0)
        ramp = cochran_armitage([5, 10, 20, 40], [100, 100, 100, 100])
        self.assertGreater(ramp['z'], 5)
        self.assertLess(ramp['p'], 1e-6)

    def test_poisson_fit_accepts_poisson_counts_and_rejects_clumping(self):
        pop, lam = 100000, 0.05
        e1 = round(pop * lam * math.exp(-lam))
        e2 = round(pop * (1 - math.exp(-lam) - lam * math.exp(-lam)))
        good = poisson_gof({1: e1, 2: e2}, pop)  # every 2+ customer counted at 2: mean slightly low, still a fit
        self.assertGreater(good['p'], 0.01)
        clumped = poisson_gof({1: e1 - 2000, 2: e2 + 1000}, pop)
        self.assertLess(clumped['p'], 1e-6)

    def test_relative_risk_and_interval(self):
        r = relative_risk(20, 1000, 10, 1000)
        self.assertAlmostEqual(r['rr'], 2.0)
        self.assertLess(r['ci95'][0], 2.0)
        self.assertGreater(r['ci95'][1], 2.0)


if __name__ == '__main__':
    unittest.main()
