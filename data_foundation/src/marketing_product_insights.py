"""Reproducible decision diagnostics from the published aggregate snapshot."""

from __future__ import annotations

import math
import random
import statistics
from collections import defaultdict

DRAWS = 20_000
SEED = 20260928
YEARS = (2024, 2025)


def paired_month_change(
    rows: list[dict], numerator: str, denominator: str, *,
    first_date: str, last_date: str, seed: int, draws: int = DRAWS,
) -> dict | None:
    """Resample matched calendar months; preserve each month's numerator and denominator."""
    if str(first_date)[:10] >= f"{YEARS[0]}-01-01" or str(last_date)[:10] <= f"{YEARS[1]}-12-31":
        return None
    by_year: dict[int, dict[str, dict]] = defaultdict(dict)
    for row in rows:
        year = int(str(row["month"])[:4])
        month = str(row["month"])[5:7]
        if year in YEARS:
            if month in by_year[year]:
                return None
            by_year[year][month] = row
    months = [f"{month:02d}" for month in range(1, 13)]
    if any(set(by_year[year]) != set(months) for year in YEARS):
        return None
    pairs = [(by_year[YEARS[0]][month], by_year[YEARS[1]][month]) for month in months]
    if any(a[denominator] <= 0 or b[denominator] <= 0 for a, b in pairs):
        return None

    def rate(items: list[dict]) -> float:
        return 100 * sum(row[numerator] for row in items) / sum(row[denominator] for row in items)

    earlier = rate([a for a, _ in pairs])
    later = rate([b for _, b in pairs])

    def change(selected: list[tuple[dict, dict]]) -> float:
        return rate([b for _, b in selected]) - rate([a for a, _ in selected])

    leave_one_out = [change(pairs[:month] + pairs[month + 1:]) for month in range(12)]
    monthly_differences = [
        100 * (b[numerator] / b[denominator] - a[numerator] / a[denominator])
        for a, b in pairs
    ]
    monthly_mean = statistics.mean(monthly_differences)
    monthly_se = statistics.stdev(monthly_differences) / math.sqrt(12)
    t_critical_11df = 2.200985160082949
    rng = random.Random(seed)
    changes = []
    for _ in range(draws):
        sample = [pairs[rng.randrange(12)] for _ in range(12)]
        changes.append(rate([b for _, b in sample]) - rate([a for a, _ in sample]))
    changes.sort()

    def quantile(fraction: float) -> float:
        return changes[int(fraction * (draws - 1))]

    return {
        "years": list(YEARS),
        "months_per_year": 12,
        "earlier_numerator": sum(a[numerator] for a, _ in pairs),
        "earlier_denominator": sum(a[denominator] for a, _ in pairs),
        "later_numerator": sum(b[numerator] for _, b in pairs),
        "later_denominator": sum(b[denominator] for _, b in pairs),
        "earlier_rate_pct": earlier,
        "later_rate_pct": later,
        "observed_change_pp": later - earlier,
        "matched_months_higher": sum(
            b[numerator] / b[denominator] > a[numerator] / a[denominator]
            for a, b in pairs
        ),
        "conditional_monthly_mean_ci_95_pp": {
            "estimate": monthly_mean,
            "lower": monthly_mean - t_critical_11df * monthly_se,
            "upper": monthly_mean + t_critical_11df * monthly_se,
            "standard_error": monthly_se,
            "pairs": 12,
            "degrees_of_freedom": 11,
            "t_critical": t_critical_11df,
        },
        "leave_one_month_out_change_pp": {
            "min": min(leave_one_out), "max": max(leave_one_out),
        },
        "half_year_change_pp": {
            "jan_jun": change(pairs[:6]), "jul_dec": change(pairs[6:]),
        },
        "resampled_change_pp": {
            "p2_5": quantile(0.025), "p20": quantile(0.20),
            "p50": quantile(0.50), "p80": quantile(0.80),
            "p97_5": quantile(0.975),
        },
    }


def summarize_insights(data: dict) -> dict:
    """Report exact data checks separately from exploratory month-level simulations."""
    marketing, products, digital = data["marketing"], data["products"], data["digital"]
    overall = marketing["overall"]
    silent = [row for row in marketing["groups"]["channel"]
              if row["label"] in ("WhatsApp", "Voice")]
    active_products = sum(row["active_products"] for row in products["ownership"])
    linked_products = sum(row["linked_products"] for row in products["ownership"])
    return {
        "source_generated_at_utc": data.get("generated_at_utc"),
        "method": {
            "years": list(YEARS), "draws": DRAWS,
            "marketing_seed": SEED, "product_seed": SEED + 1,
            "description": "Paired calendar-month bootstrap with replacement; "
                           "each draw resamples 12 month pairs and recomputes "
                           "denominator-weighted annual rates.",
            "assumption": "The 12 observed month pairs are treated as exchangeable "
                          "units for a descriptive month-composition sensitivity check.",
            "conditional_ci": "Two-sided paired t interval for the unweighted mean "
                              "of 12 month-specific 2025 minus 2024 rate differences, "
                              "in percentage points (11 df). Assumes independent, "
                              "comparable month pairs and approximately normal "
                              "sampling of their mean within the synthetic setting. "
                              "This is a different estimand from the denominator-"
                              "weighted annual rate difference.",
            "interpretation": "Percentiles describe sensitivity to which months are "
                              "represented. They are not causal effects, a production "
                              "forecast, a customer-level confidence interval, or a "
                              "95% confidence interval. Month pairs may be serially "
                              "dependent and customer cohorts overlap.",
        },
        "marketing": {
            "sends": overall["sends"],
            "exposed_customers": marketing["exposure"]["exposed_customers"],
            "repeat_exposed_customers": marketing["exposure"]["repeat_exposed_customers"],
            "current_opt_out_sends": marketing["quality"]["current_opt_out_sends"],
            "silent_channels": {
                "names": [row["label"] for row in silent],
                "sends": sum(row["sends"] for row in silent),
                "delivered": sum(row["delivered"] for row in silent),
                "open_known": sum(row["open_known"] for row in silent),
                "clicks": sum(row["clicks"] for row in silent),
                "recorded_conversions": sum(row["recorded_conversions"] for row in silent),
            },
            "recorded_conversion_change": paired_month_change(
                marketing["monthly"], "recorded_conversions", "sends",
                first_date=marketing["quality"]["first_send"],
                last_date=marketing["quality"]["last_send"], seed=SEED,
            ),
        },
        "product": {
            "active_products": active_products,
            "linked_products": linked_products,
            "pre_opening_transactions": products["transaction_activity"]["before_opening"],
            "all_transactions": products["transaction_activity"]["total_transactions"],
            "identified_digital_product_links": digital["product_links"]["identified_links"],
            "digital_product_owner_mismatch": digital["product_links"]["owner_mismatch"],
            "activity_continuation_change": paired_month_change(
                data["activity"]["monthly"], "continuing_customers", "prior_active_customers",
                first_date=data["activity"]["first_transaction"],
                last_date=data["activity"]["last_transaction"], seed=SEED + 1,
            ),
        },
    }
