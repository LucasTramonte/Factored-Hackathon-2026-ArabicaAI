"""Charts for the intake decision-KPI baselines, built only from the committed aggregate JSON (no database access).

Each chart answers one question stated in its title, shows its population and denominator in a caption, draws
uncertainty (Wilson 95% intervals or control limits) and uses a colour-blind-safe palette. Output: PNGs under
Docs/Evidence/business/charts/. Requires data_foundation/requirements-charts.txt.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402
import seaborn as sns  # noqa: E402

from data_foundation.scripts.run_intake_kpis import wilson  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / "Docs" / "Evidence" / "business"
OUT = EVIDENCE / "charts"
DESIGN = json.loads((EVIDENCE / "intake-kpi-baselines-design-2026-10-04.json").read_text(encoding="utf-8"))
HOLDOUT = json.loads((EVIDENCE / "intake-kpi-baselines-holdout-2026-10-04.json").read_text(encoding="utf-8"))
LABELS = {"rejected": "Rejected after review", "escalated": "Escalated", "mistyped": "Mis-recorded at intake",
          "digital": "Filed in app or web", "assigned": "Assigned to an agent"}
PALETTE = sns.color_palette("colorblind")
SOURCE = ("Source: Silver, quality run pr23-check (READY); unrecognized-charge complaints; synthetic data. "
          "Design window 2023-06-17 to 2025-12-31; holdout 2026-01-01 to 2026-06-17.")


def _caption(fig, text: str) -> None:
    fig.text(0.01, 0.01, text, ha="left", va="bottom", fontsize=8, color="#444444", wrap=True)


def _save(fig, name: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    fig.savefig(OUT / name, dpi=150, bbox_inches="tight")
    plt.close(fig)


def quarterly_rates() -> None:
    """Are the intake-quality rates stable, and do they hold out of sample?"""
    rows = [r for r in DESIGN["quarterly"] if str(r["quarter"]) >= "2023-07-01"]
    fig, axes = plt.subplots(1, 5, figsize=(18, 4.2), sharex=False)
    for ax, (key, label) in zip(axes, LABELS.items()):
        x = [str(r["quarter"])[:7] for r in rows]
        p = [r[key] / r["complaints"] for r in rows]
        ci = [wilson(r[key], r["complaints"]) for r in rows]
        ax.errorbar(range(len(x)), [v * 100 for v in p], yerr=[[(v - c[0]) * 100 for v, c in zip(p, ci)],
                    [(c[1] - v) * 100 for v, c in zip(p, ci)]], fmt="o", color=PALETTE[0], ms=4, capsize=2,
                    label="Design quarter (95% CI)")
        d = DESIGN["rates"][key]
        ax.axhspan(d["ci95"][0] * 100, d["ci95"][1] * 100, color=PALETTE[0], alpha=0.15, label="Design pooled 95% CI")
        ax.axhline(d["rate"] * 100, color=PALETTE[0], lw=1)
        h = HOLDOUT["rates"][key]
        hx = len(x) + 0.8
        ax.errorbar([hx], [h["rate"] * 100], yerr=[[(h["rate"] - h["ci95"][0]) * 100], [(h["ci95"][1] - h["rate"]) * 100]],
                    fmt="D", color=PALETTE[3], ms=6, capsize=3, label="Holdout 2026 H1 (95% CI)")
        ax.set_xticks(list(range(0, len(x), 3)) + [hx], [x[i] for i in range(0, len(x), 3)] + ["2026\nholdout"], fontsize=8)
        ax.set_title(f"{label}\ntrend p = {d['trend']['p']:.2f}", fontsize=10)
        ax.set_ylabel("% of complaints" if key == "rejected" else "")
        sns.despine(ax=ax)
    handles, labels = axes[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="upper right", ncol=3, fontsize=8, frameon=False)
    fig.suptitle("Intake-quality rates are flat for 10 quarters and hold in the 2026 holdout", fontsize=13, x=0.01, ha="left")
    _caption(fig, f"Each point: rate in one quarter, Wilson 95% interval; denominators about 1,000 complaints a quarter "
                  f"(10,217 in full design quarters; holdout 1,924). Trend: Cochran–Armitage. {SOURCE}")
    fig.tight_layout(rect=(0, 0.06, 1, 0.95))
    _save(fig, "kpi-rates-quarterly.png")


def repeat_reporters() -> None:
    """Is repeat reporting more than chance?"""
    recs = []
    for name, src in (("Design 2023-25", DESIGN), ("Holdout 2026 H1", HOLDOUT)):
        po = src["repeat_reporters"]["poisson"]
        for k, obs, exp in zip(("1 report", "2+ reports"), po["observed_0_1_2plus"][1:], po["expected_0_1_2plus"][1:]):
            recs += [{"window": name, "customers": k, "kind": "Observed", "n": obs},
                     {"window": name, "customers": k, "kind": "Poisson expectation", "n": exp}]
    df = pd.DataFrame(recs)
    g = sns.catplot(df, x="customers", y="n", hue="kind", col="window", kind="bar", palette=[PALETTE[0], PALETTE[7]],
                    height=3.8, aspect=1.1, sharey=False, legend_out=False)
    g.set_titles("{col_name}")
    g.legend.set_title(None)
    for ax in g.axes.flat:
        ax.set_yscale("log"); ax.set_xlabel(""); ax.set_ylabel("Customers (log scale)")
        for c in ax.containers:
            ax.bar_label(c, fmt="%.0f", fontsize=8)
    g.figure.suptitle("Repeat reporting is what chance predicts: observed counts match a Poisson model "
                      f"(p = {DESIGN['repeat_reporters']['poisson']['p']:.2f} design, "
                      f"{HOLDOUT['repeat_reporters']['poisson']['p']:.2f} holdout)", fontsize=11, x=0.01, ha="left")
    _caption(g.figure, "Denominator: all 150,000 customers (zero-report customers included in the fit). Chi-square "
                       "goodness of fit on 0 / 1 / 2+ reports, df = 1. A repeat flag should come from history, not the source "
                       f"field is_repeat_complainer, which disagrees with it. {SOURCE}")
    g.figure.tight_layout(rect=(0, 0.1, 1, 0.92))
    _save(g.figure, "repeat-reporters-poisson.png")


def merchant_history() -> None:
    """Does a cardholder's history with the merchant flag fraud, as the industry heuristics assume?"""
    fam, ce3 = DESIGN["familiar_merchant"]["fraud_transactions"], DESIGN["ce3_like_history"]["fraud_transactions"]
    groups = [("First purchase at merchant", fam["first_time"]), ("Merchant seen before", fam["seen_before"]),
              ("No CE3.0-like history", ce3["without_history"]), ("CE3.0-like history:\n2+ purchases >120 days old", ce3["with_history"])]
    fig, ax = plt.subplots(figsize=(9, 4.2))
    for i, (label, g) in enumerate(groups):
        rate = g["fraud"] / g["transactions"]
        lo, hi = wilson(g["fraud"], g["transactions"])
        ax.errorbar([rate * 1e4], [i], xerr=[[(rate - lo) * 1e4], [(hi - rate) * 1e4]], fmt="o",
                    color=PALETTE[0] if i < 2 else PALETTE[2], capsize=4)
        ax.text(hi * 1e4 + 0.05, i, f"{g['fraud']:,} / {g['transactions']:,}", va="center", fontsize=8, color="#444444")
    ax.set_yticks(range(len(groups)), [g[0] for g in groups]); ax.invert_yaxis()
    ax.set_xlabel("Fraud per 10,000 approved purchases (Wilson 95% interval)")
    rr1, rr2 = DESIGN["familiar_merchant"]["first_time_vs_seen_before"], DESIGN["ce3_like_history"]["without_vs_with_history"]
    ax.set_title(f"History with the merchant does not separate fraud here: RR {rr1['rr']:.2f} "
                 f"({rr1['ci95'][0]:.2f}–{rr1['ci95'][1]:.2f}) and {rr2['rr']:.2f} ({rr2['ci95'][0]:.2f}–{rr2['ci95'][1]:.2f})",
                 fontsize=11, loc="left")
    sns.despine(ax=ax)
    _caption(fig, "Population: approved purchases with a merchant name, design window (800,008). CE3.0-like is a merchant-only "
                  "approximation of Visa's Compelling Evidence 3.0 (which also needs a matching IP or device; not in the data). "
                  "is_fraud is the synthetic generator's label, so this tests the data, not the heuristic in real portfolios. " + SOURCE)
    fig.tight_layout(rect=(0, 0.12, 1, 1))
    _save(fig, "merchant-history-fraud.png")


def binomial_limits(n: int, p0: float, tail: float = 0.00135) -> tuple[float, float]:
    """Exact binomial control limits for a proportion: the tail-quantiles of Binomial(n, p0), divided by n.

    Normal 3-sigma limits are too narrow in the upper tail when n * p0 is small (skewed binomial), so they flag
    too many weeks; exact quantiles keep the false-alarm rate near 0.27% per point.
    """
    cdf, lo, hi = 0.0, None, n
    for k in range(n + 1):
        cdf += math.comb(n, k) * p0 ** k * (1 - p0) ** (n - k)
        if lo is None and cdf > tail:
            lo = k
        if cdf >= 1 - tail:
            hi = k
            break
    return (lo or 0) / n, hi / n


def control_chart() -> None:
    """How a manager would watch an intake KPI weekly: p-chart limits from a baseline, then monitoring."""
    weeks = pd.DataFrame(DESIGN["weekly"])
    weeks["week"] = pd.to_datetime(weeks["week"])
    weeks = weeks[(weeks["week"] >= "2023-07-03") & (weeks["week"] < "2025-12-29")]  # full weeks only
    phase1 = weeks[weeks["week"] < "2025-01-01"]
    fig, axes = plt.subplots(2, 1, figsize=(12, 6.4), sharex=True)
    for ax, key in zip(axes, ("mistyped", "escalated")):
        p0 = phase1[key].sum() / phase1["complaints"].sum()
        p = weeks[key] / weeks["complaints"]
        limits = [binomial_limits(int(n), p0) for n in weeks["complaints"]]
        lcl = pd.Series([lo for lo, _ in limits], index=weeks.index)
        ucl = pd.Series([hi for _, hi in limits], index=weeks.index)
        out = (p > ucl) | (p < lcl)
        ax.fill_between(weeks["week"], lcl * 100, ucl * 100, step="mid", color=PALETTE[7], alpha=0.25, label="Control limits, exact binomial 99.73% (phase I)")
        ax.axhline(p0 * 100, color=PALETTE[7], lw=1, label=f"Centre line {p0:.1%}")
        ax.plot(weeks["week"], p * 100, "o-", ms=3, lw=0.8, color=PALETTE[0], label="Weekly rate")
        ax.plot(weeks["week"][out], p[out] * 100, "o", ms=7, mfc="none", color=PALETTE[3], label=f"Outside limits ({int(out.sum())} of {len(weeks)})")
        ax.axvline(pd.Timestamp("2025-01-01"), color="#555555", ls="--", lw=1)
        ax.text(pd.Timestamp("2025-01-08"), ax.get_ylim()[1] * 0.92, "phase II: monitor", fontsize=8)
        ax.text(pd.Timestamp("2023-07-10"), ax.get_ylim()[1] * 0.92, "phase I: set limits", fontsize=8)
        ax.set_ylabel(f"{LABELS[key]} (%)")
        ax.legend(fontsize=7, ncol=4, loc="lower left", frameon=False)
        sns.despine(ax=ax)
    fig.suptitle("Weekly p-chart: limits set on 2023-24, then 2025 monitored. A stable process stays inside; a point outside "
                 "is a signal to investigate, not a conclusion", fontsize=11, x=0.01, ha="left")
    _caption(fig, "Denominator: unrecognized-charge complaints per ISO week (about 70–90). Limits vary with each week's n. "
                  "Limits are exact binomial quantiles (0.135% and 99.865%), not normal 3σ, because low rates on about 75 cases a week are skewed; expect about 0.3% of points outside by chance. For small persistent shifts, a CUSUM chart is more sensitive. "
                  + SOURCE)
    fig.tight_layout(rect=(0, 0.06, 1, 0.94))
    _save(fig, "pchart-weekly.png")


def detectable_change() -> None:
    """How long must the service run before a change in a KPI can be detected?"""
    z = 1.96 + 0.8416  # two-sided alpha 0.05, power 0.80
    recs = []
    for key in ("escalated", "mistyped", "assigned"):
        p0 = DESIGN["rates"][key]["rate"]
        for per_week, vol in ((78, "78 / week (dataset bank, all unrecognized-charge reports)"), (20, "20 / week (a pilot)")):
            for w in range(2, 53):
                n = per_week * w
                recs.append({"KPI": f"{LABELS[key]} (baseline {p0:.1%})", "volume": vol, "weeks": w,
                             "mde": z * math.sqrt(2 * p0 * (1 - p0) / n) * 100})
    df = pd.DataFrame(recs)
    g = sns.relplot(df, x="weeks", y="mde", hue="KPI", col="volume", kind="line", palette="colorblind", height=3.8, aspect=1.3)
    g.set_titles("{col_name}")
    for ax in g.axes.flat:
        ax.axhline(5, color="#888888", ls=":", lw=1); ax.text(40, 5.3, "5-point change", fontsize=8, color="#666666")
        ax.set_ylabel("Smallest detectable change\n(percentage points)"); ax.set_xlabel("Weeks of data in each period compared")
        ax.set_ylim(0, 25)
    g.figure.suptitle("Detectable change shrinks with the square root of volume: at pilot volume, a 5-point change takes months",
                      fontsize=11, x=0.01, ha="left")
    _caption(g.figure, "Two equal periods (before and after a change), two-proportion test, alpha 0.05 two-sided, power 0.80; "
                       "baselines from the design window. 78 / week is 11.16 reports a day, the dataset's volume for this workflow. "
                       "Planning aid, not a measurement.")
    g.figure.tight_layout(rect=(0, 0.08, 1, 0.92))
    _save(g.figure, "detectable-change.png")


def main() -> int:
    """Write every chart."""
    sns.set_theme(style="whitegrid", context="paper", palette="colorblind")
    for build in (quarterly_rates, repeat_reporters, merchant_history, control_chart, detectable_change):
        build()
    print(f"charts -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
