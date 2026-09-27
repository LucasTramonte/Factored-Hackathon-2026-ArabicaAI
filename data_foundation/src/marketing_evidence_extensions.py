"""Extensions to marketing/product evidence: closes three gaps left open by
marketing_product.py --

  A) channel attribution  -- correlates campaign_sends with digital_events via
     utm_campaign; still descriptive, no causal claim.
  B) propensity check      -- the "at least one learned component vs baseline"
     evidence the hackathon rubric asks for: a smoothed conditional
     conversion-rate table, evaluated by log loss on a held-out split, against
     a constant-rate baseline.
  C) feature-level usage   -- digital_events.action was already being read but
     discarded; this keeps (product_type, action) instead of collapsing to
     product_type alone.

Reuses the same bounded-memory streaming primitives as marketing_product.py
(DiskKeySet, projected_rows, unique_dimensions) so nothing here loads a full
fact table into memory at once.
"""

from __future__ import annotations

import hashlib
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

from data_foundation.src.contracts import CONTRACTS, discover_files
from data_foundation.src.marketing_product import (
    COLUMNS,
    boolean,
    projected_rows,
    unique_dimensions,
)
from data_foundation.src.quality.checks import DiskKeySet

EXT_TABLES = ("customers", "products", "marketing_campaigns", "campaign_sends", "digital_events")


# --------------------------------------------------------------------------
# A) channel attribution via utm_campaign -- descriptive correlation only
# --------------------------------------------------------------------------

def build_utm_touches(paths: list[Path], campaigns: dict) -> set[tuple[str, str]]:
    """(customer_id, campaign_id) pairs with >=1 digital event whose utm_campaign
    matches a known campaign_id. No event/send ordering is verified here, so
    this is co-occurrence, not sequenced attribution."""
    touches: set[tuple[str, str]] = set()
    with DiskKeySet() as keys:
        for _, row in projected_rows(paths, COLUMNS["digital_events"]):
            key = row["event_id"]
            if not key or not keys.add(key):
                continue
            campaign_id = row["utm_campaign"]
            customer_id = row["customer_id"]
            if campaign_id in campaigns and customer_id:
                touches.add((customer_id, campaign_id))
    return touches


def attribution_by_touch(paths: list[Path], campaigns: dict, touches: set) -> dict:
    """Split send-level conversion by whether the (customer, campaign) pair also
    shows a matching digital touch. Reports both groups with denominators; makes
    no claim that the touch caused the conversion or happened before it."""
    counts: dict[str, Counter] = defaultdict(Counter)
    with DiskKeySet() as keys:
        for _, row in projected_rows(paths, COLUMNS["campaign_sends"]):
            key = row["send_id"]
            if not key or not keys.add(key):
                continue
            if row["campaign_id"] not in campaigns:
                continue
            converted = boolean(row["had_conversion"])
            if converted is None:
                continue
            group = "utm_touched" if (row["customer_id"], row["campaign_id"]) in touches else "no_utm_touch"
            counts[group]["sends"] += 1
            if converted:
                counts[group]["conversions"] += 1
    return {
        group: {
            "sends": c["sends"],
            "conversions": c["conversions"],
            "conversion_rate": c["conversions"] / c["sends"] if c["sends"] else None,
        }
        for group, c in sorted(counts.items())
    }


# --------------------------------------------------------------------------
# B) propensity check: learned conditional rate vs constant-rate baseline
# --------------------------------------------------------------------------

def _bucket(row: dict, campaigns: dict, customers: dict) -> tuple[str, str, str]:
    campaign = campaigns.get(row["campaign_id"])
    customer = customers.get(row["customer_id"])
    channel = row["send_channel"] or "Unknown"
    objective = (campaign["campaign_objective"] if campaign else None) or "Unknown"
    segment = (customer["segment"] if customer else None) or "Unknown"
    return (channel, objective, segment)


def evaluate_propensity(
    paths: list[Path],
    campaigns: dict,
    customers: dict,
    seed: bytes = b"marketing-evidence-v1",
    holdout_fraction: float = 0.3,
    smoothing: float = 5.0,
) -> dict:
    """Deterministic hash-of-send_id split (no shuffling needed, reproducible
    across runs). Trains a Laplace-smoothed conditional conversion rate per
    (channel, objective, segment) on the train split, scores log loss on the
    holdout split, and compares against a constant global-rate baseline."""
    train: list[tuple[tuple, bool]] = []
    holdout: list[tuple[tuple, bool]] = []
    with DiskKeySet() as keys:
        for _, row in projected_rows(paths, COLUMNS["campaign_sends"]):
            key = row["send_id"]
            if not key or not keys.add(key):
                continue
            converted = boolean(row["had_conversion"])
            if converted is None:
                continue
            bucket = _bucket(row, campaigns, customers)
            digest = hashlib.sha256(seed + key.encode()).digest()
            is_holdout = (digest[0] / 255.0) < holdout_fraction
            (holdout if is_holdout else train).append((bucket, converted))

    if not train or not holdout:
        return {"error": "insufficient valid sends for a train/holdout split"}

    bucket_counts: dict[tuple, list[int]] = defaultdict(lambda: [0, 0])  # [conversions, total]
    global_conversions = 0
    for bucket, converted in train:
        bucket_counts[bucket][1] += 1
        if converted:
            bucket_counts[bucket][0] += 1
            global_conversions += 1
    global_rate = global_conversions / len(train)

    def bucket_rate(bucket: tuple) -> float:
        conv, total = bucket_counts.get(bucket, [0, 0])
        return (conv + smoothing * global_rate) / (total + smoothing)

    def log_loss(pairs: list[tuple[float, float]]) -> float:
        eps = 1e-9
        total = 0.0
        for p, label in pairs:
            p = min(max(p, eps), 1 - eps)
            total += -(label * math.log(p) + (1 - label) * math.log(1 - p))
        return total / len(pairs)

    baseline_loss = log_loss([(global_rate, float(c)) for _, c in holdout])
    model_loss = log_loss([(bucket_rate(b), float(c)) for b, c in holdout])
    unseen = sum(1 for b, _ in holdout if b not in bucket_counts)

    return {
        "train_sends": len(train),
        "holdout_sends": len(holdout),
        "global_train_conversion_rate": global_rate,
        "baseline_log_loss": baseline_loss,
        "model_log_loss": model_loss,
        "improvement_over_baseline": baseline_loss - model_loss,
        "buckets_trained": len(bucket_counts),
        "holdout_sends_in_unseen_bucket": unseen,
        "features": ["send_channel", "campaign_objective", "customer_segment (current snapshot)"],
        "method": "Laplace-smoothed conditional conversion rate per (channel, objective, segment); scored by log loss on a send_id-hashed holdout split.",
        "caveats": [
            "customer_segment is the current snapshot, not the segment at send time.",
            "Descriptive/correlational only -- not validated as a production targeting model.",
            "Group-level features only (no customer identity used), so a customer appearing in both splits is not a leakage concern here.",
        ],
    }


# --------------------------------------------------------------------------
# C) feature-level product usage (product_type + action, not type alone)
# --------------------------------------------------------------------------

def feature_usage(paths: list[Path], products: dict) -> dict:
    usage: Counter = Counter()
    with DiskKeySet() as keys:
        for _, row in projected_rows(paths, COLUMNS["digital_events"]):
            key = row["event_id"]
            if not key or not keys.add(key):
                continue
            if row["product_id"] not in products:
                continue
            kind = products[row["product_id"]]["product_type"] or "Unknown"
            action = row["action"] or "Unknown"
            usage[(kind, action)] += 1
    return {f"{kind} / {action}": count for (kind, action), count in sorted(usage.items(), key=lambda item: -item[1])}


# --------------------------------------------------------------------------
# orchestration
# --------------------------------------------------------------------------

def analyze_extensions(data_root: Path) -> dict:
    files = {table: discover_files(data_root, CONTRACTS[table]) for table in EXT_TABLES}
    missing = [table for table, paths in files.items() if not paths]
    if missing:
        raise ValueError(f"Missing table CSV files: {missing}")

    customers, _ = unique_dimensions(files["customers"], "customers")
    products, _ = unique_dimensions(files["products"], "products")
    campaigns, _ = unique_dimensions(files["marketing_campaigns"], "marketing_campaigns")

    touches = build_utm_touches(files["digital_events"], campaigns)
    attribution = attribution_by_touch(files["campaign_sends"], campaigns, touches)
    propensity = evaluate_propensity(files["campaign_sends"], campaigns, customers)
    usage = feature_usage(files["digital_events"], products)

    return {
        "attribution_by_utm_touch": attribution,
        "propensity_vs_baseline": propensity,
        "feature_usage_top20": dict(list(usage.items())[:20]),
    }


if __name__ == "__main__":
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("data")
    result = analyze_extensions(root)
    print(json.dumps(result, indent=2, ensure_ascii=False))
