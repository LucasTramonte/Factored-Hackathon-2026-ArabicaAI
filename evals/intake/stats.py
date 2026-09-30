"""Small-sample statistics for evaluation reports, standard library only.

Wilson intervals for rates, an exact one-sided Clopper–Pearson upper bound for error rates
found in an audit sample, McNemar's exact test for two systems scored on the same cases, and a
distribution-free interval for a percentile such as p95 latency.
Empty denominators return ``None``: they are undefined, never zero.
"""
from __future__ import annotations

from math import comb, exp, isnan, lgamma, log, sqrt

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


def quantile_interval(values, q: float = 0.95, conf: float = 0.95) -> tuple[float | None, float | None]:
    """Equal-tailed, distribution-free interval for the ``q`` quantile of ``values``.

    Uses order statistics: with ``B ~ Binomial(n, q)``, the lower bound is the ``j``-th smallest
    value for the largest ``j`` with ``P(B <= j - 1) <= alpha/2``, and the upper bound the ``k``-th
    for the smallest ``k`` with ``P(B <= k - 1) >= 1 - alpha/2``. A side is ``None`` when no
    order statistic reaches it, which is the honest answer for small samples: for p95 at 95%
    confidence the upper bound needs at least 72 values.
    """
    if not (isinstance(q, (int, float)) and isinstance(conf, (int, float))) or isnan(q) or isnan(conf) \
            or not 0 < q < 1 or not 0 < conf < 1:
        raise ValueError("need 0 < q < 1 and 0 < conf < 1")
    data = list(values)
    if not data:
        raise ValueError("need at least one value")
    if any(not isinstance(v, (int, float)) or isinstance(v, bool) or isnan(v) for v in data):
        raise ValueError("values must be real numbers")
    data.sort()
    n, tail = len(data), (1 - conf) / 2
    cdf, total = [], 0.0  # cdf[i] = P(B <= i)
    if n <= 1000:  # exact terms, so a tail that lands on alpha/2 keeps its bound
        for i in range(n + 1):
            total += comb(n, i) * q ** i * (1 - q) ** (n - i)
            cdf.append(total)
    else:  # log space: O(n) and no float overflow; exact ties are vanishingly rare at this size
        base = lgamma(n + 1)
        for i in range(n + 1):
            total += exp(base - lgamma(i + 1) - lgamma(n - i + 1) + i * log(q) + (n - i) * log(1 - q))
            cdf.append(min(total, 1.0))
    lows = [j for j in range(1, n + 1) if cdf[j - 1] <= tail]
    highs = [k for k in range(1, n + 1) if cdf[k - 1] >= 1 - tail]
    return (data[lows[-1] - 1] if lows else None, data[highs[0] - 1] if highs else None)
