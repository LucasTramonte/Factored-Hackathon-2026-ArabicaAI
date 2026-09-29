"""Reference values for the interval and paired-test helpers used in evaluation reports."""
import unittest

from evals.intake.stats import clopper_pearson_upper, mcnemar_exact, wilson


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


if __name__ == "__main__":
    unittest.main()
