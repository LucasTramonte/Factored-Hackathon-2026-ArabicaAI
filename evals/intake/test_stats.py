"""Reference values for the interval and paired-test helpers used in evaluation reports."""
import unittest

from math import comb

from evals.intake.stats import clopper_pearson_upper, mcnemar_exact, quantile_interval, wilson


class StatsTests(unittest.TestCase):
    def test_wilson_matches_published_values_and_handles_edges(self):
        low, high = wilson(9, 10)
        self.assertAlmostEqual(low, 0.5958, places=4)
        self.assertAlmostEqual(high, 0.9821, places=4)
        self.assertEqual(wilson(0, 0), (None, None))
        low, high = wilson(0, 12)
        self.assertEqual(low, 0.0)
        self.assertAlmostEqual(high, 0.2425, places=4)

    def test_clopper_pearson_upper_bound_on_zero_errors_is_near_the_rule_of_three(self):
        self.assertAlmostEqual(clopper_pearson_upper(0, 12), 1 - 0.05 ** (1 / 12), places=6)
        self.assertAlmostEqual(clopper_pearson_upper(0, 100), 0.0295, places=4)
        self.assertAlmostEqual(clopper_pearson_upper(2, 12), 0.4381, places=4)  # Beta(3, 10) 0.95 quantile
        self.assertEqual(clopper_pearson_upper(12, 12), 1.0)
        self.assertIsNone(clopper_pearson_upper(0, 0))

    def test_mcnemar_exact_is_two_sided_on_discordant_pairs_only(self):
        self.assertEqual(mcnemar_exact(0, 0), 1.0)
        self.assertAlmostEqual(mcnemar_exact(0, 6), 0.03125, places=5)
        self.assertAlmostEqual(mcnemar_exact(1, 6), 0.125, places=5)
        self.assertEqual(mcnemar_exact(3, 3), 1.0)
        self.assertEqual(mcnemar_exact(2, 5), mcnemar_exact(5, 2))

    def test_invalid_counts_are_rejected(self):
        for bad in [(-1, 3), (4, 3)]:
            with self.assertRaises(ValueError):
                wilson(*bad)
            with self.assertRaises(ValueError):
                clopper_pearson_upper(*bad)
        with self.assertRaises(ValueError):
            mcnemar_exact(-1, 2)


def binom_cdf(k, n, p):
    """Reference CDF, written independently of the module under test."""
    return sum(comb(n, i) * p ** i * (1 - p) ** (n - i) for i in range(k + 1))


class QuantileIntervalTests(unittest.TestCase):
    """Distribution-free (order-statistic) interval for a percentile, e.g. the p95 latency."""

    def test_48_calls_have_no_upper_bound_for_p95(self):
        # 1 - 0.95**48 = 0.915 < 0.975: even the slowest call can't bound p95 from above.
        low, high = quantile_interval([float(i) for i in range(48)], 0.95, 0.95)
        self.assertIsNone(high)
        self.assertIsNotNone(low)

    def test_72_is_the_first_sample_size_with_an_upper_bound(self):
        self.assertIsNone(quantile_interval(list(range(71)), 0.95, 0.95)[1])
        self.assertEqual(quantile_interval(list(range(72)), 0.95, 0.95)[1], 71)  # the maximum

    def test_ranks_have_the_promised_coverage_for_every_size(self):
        for n in range(72, 301):
            values = list(range(1, n + 1))  # value i is the i-th order statistic
            low, high = quantile_interval(values, 0.95, 0.95)
            with self.subTest(n=n):
                # Equal tails: P(B <= low-1) <= 2.5% and P(B >= high) <= 2.5%, with B ~ Bin(n, 0.95).
                self.assertLessEqual(binom_cdf(low - 1, n, 0.95), 0.025 + 1e-12)
                self.assertLessEqual(1 - binom_cdf(high - 1, n, 0.95), 0.025 + 1e-12)
                # Tight: moving either rank inward would break its tail.
                self.assertGreater(binom_cdf(low, n, 0.95), 0.025)
                self.assertGreater(1 - binom_cdf(high - 2, n, 0.95), 0.025)

    def test_order_not_input_order_and_ties_are_kept(self):
        values = [3.0] * 50 + [1.0] * 50 + [2.0] * 50
        self.assertEqual(quantile_interval(values, 0.5, 0.95), quantile_interval(sorted(values), 0.5, 0.95))
        self.assertEqual(quantile_interval(values, 0.5, 0.95), (2.0, 2.0))

    def test_hostile_inputs_raise(self):
        for values, q, conf in (([], 0.95, 0.95), ([1.0], 0.0, 0.95), ([1.0], 1.0, 0.95),
                                ([1.0], 0.95, 0.0), ([1.0], 0.95, 1.0), ([1.0], float("nan"), 0.95),
                                ([1.0, float("nan")], 0.5, 0.95), ([1.0, None], 0.5, 0.95)):
            with self.subTest(values=values, q=q, conf=conf), self.assertRaises((ValueError, TypeError)):
                quantile_interval(values, q, conf)

    def test_exact_tail_boundaries_keep_their_bound(self):
        # P(B <= 0) = 0.25 equals alpha/2 exactly: rounding must not drop the upper bound.
        self.assertEqual(quantile_interval([0, 1], 0.5, 0.5), (0, 1))

    def test_large_samples_are_fast_and_do_not_overflow(self):
        import time
        started = time.perf_counter()
        low, high = quantile_interval(list(range(5000)), 0.95, 0.95)
        self.assertLess(time.perf_counter() - started, 1.0)
        # The p95 of 0..4999 is about 4750; the interval must straddle it closely.
        self.assertLess(low, 4750)
        self.assertGreater(high, 4750)
        # Normal approximation: about +/-1.96 sd of Bin(5000, 0.95) ranks, plus a few ranks of discreteness.
        self.assertLess(high - low, 2 * 1.96 * (5000 * 0.95 * 0.05) ** 0.5 + 4)

    def test_tiny_samples_give_only_the_bounds_they_can_support(self):
        # n=1: P(B=0)=5% > 2.5%, so not even the minimum bounds p95 from below.
        self.assertEqual(quantile_interval([1.0], 0.95, 0.95), (None, None))
        # n=2: P(B=0)=0.25% <= 2.5%, so the minimum is a valid lower bound; no upper bound.
        self.assertEqual(quantile_interval([2.0, 1.0], 0.95, 0.95), (1.0, None))

if __name__ == "__main__":
    unittest.main()
