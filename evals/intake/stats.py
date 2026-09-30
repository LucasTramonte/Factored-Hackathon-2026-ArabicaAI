"""Small-sample statistics for evaluation reports, standard library only.

Wilson intervals for rates, an exact one-sided Clopper–Pearson upper bound for error rates
found in an audit sample, and McNemar's exact test for two systems scored on the same cases.
Empty denominators return ``None``: they are undefined, never zero.
"""
from __future__ import annotations

from math import comb, sqrt

Z95 = 1.959963984540054


def _check(k: int, n: int) -> None:
    if n < 0 or k < 0 or k > n:
        raise ValueError(f"need 0 <= k <= n, got k={k}, n={n}")


def wilson(k: int, n: int, z: float = Z95) -> tuple[float | None, float | None]:
    """Two-sided Wilson score interval for ``k`` successes in ``n`` trials."""
    _check(k, n)
    if n == 0:
        return None, None
    p = k / n
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    low = 0.0 if k == 0 else max(0.0, centre - half)
    high = 1.0 if k == n else min(1.0, centre + half)
    return low, high


def _binom_cdf(k: int, n: int, p: float) -> float:
    return sum(comb(n, i) * p ** i * (1 - p) ** (n - i) for i in range(k + 1))


def clopper_pearson_upper(k: int, n: int, alpha: float = 0.05) -> float | None:
    """Exact one-sided upper confidence bound on an error rate after ``k`` errors in ``n``."""
    _check(k, n)
    if n == 0:
        return None
    if k == n:
        return 1.0
    low, high = k / n, 1.0
    for _ in range(100):  # bisection: P(X <= k | p) = alpha
        mid = (low + high) / 2
        if _binom_cdf(k, n, mid) > alpha:
            low = mid
        else:
            high = mid
    return high


def mcnemar_exact(b: int, c: int) -> float:
    """Two-sided exact McNemar p-value from the two discordant counts of a paired comparison."""
    if b < 0 or c < 0:
        raise ValueError("discordant counts must be non-negative")
    n = b + c
    if n == 0:
        return 1.0
    return min(1.0, 2 * _binom_cdf(min(b, c), n, 0.5))
