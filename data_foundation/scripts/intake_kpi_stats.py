"""Standard-library statistics shared by intake KPI reports and charts."""

import math


def wilson(k: int, n: int, z: float = 1.96) -> list[float]:
    """Return the Wilson score interval for ``k`` successes in ``n`` trials."""
    if n == 0:
        return [math.nan, math.nan]
    p, d = k / n, 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [max(0.0, centre - half), min(1.0, centre + half)]
