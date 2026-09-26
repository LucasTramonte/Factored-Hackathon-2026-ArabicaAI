"""Bounded-memory marketing and product evidence over synthetic bank CSVs.

Fact rows are streamed with projected columns. Customer, campaign, and product
sizes bound in-memory dimensions; fact keys and ordered session events live in
SQLite scratch files. No fact-to-fact join or raw record enters report output.
"""

from __future__ import annotations

import csv
import hashlib
import html
import json
import logging
import re
import sqlite3
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from data_foundation.src.contracts import CONTRACTS, discover_files
from data_foundation.src.quality.checks import DiskKeySet

LOGGER = logging.getLogger(__name__)
TABLES = ("customers", "products", "marketing_campaigns", "campaign_sends", "transactions", "digital_events")
COLUMNS = {
    "customers": ("customer_id", "country", "segment", "accepts_marketing", "registration_date"),
    "products": ("product_id", "customer_id", "product_type", "product_status", "opening_date", "has_linked_app"),
    "marketing_campaigns": ("campaign_id", "campaign_objective", "promoted_product", "target_segment", "target_country", "campaign_status"),
    "campaign_sends": ("send_id", "send_date", "process_date", "campaign_id", "customer_id", "send_channel", "send_status", "was_delivered", "was_opened", "was_clicked", "had_conversion", "conversion_date", "conversion_value"),
    "transactions": ("transaction_id", "transaction_date", "process_date", "product_id", "transaction_status"),
    "digital_events": ("event_id", "event_date", "process_date", "customer_id", "session_id", "event_type", "event_category", "action", "product_id", "channel", "utm_campaign"),
}
KEYS = {"customers": "customer_id", "products": "product_id", "marketing_campaigns": "campaign_id", "campaign_sends": "send_id", "transactions": "transaction_id", "digital_events": "event_id"}
RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")


def boolean(value: str) -> bool | None:
    """Parse source boolean values; blank or invalid values stay unknown."""
    value = value.strip().lower()
    if value in ("true", "1"):
        return True
    if value in ("false", "0"):
        return False
    return None


def timestamp(value: str) -> str | None:
    """Normalize an ISO-like date or timestamp for ordered comparisons."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.isoformat() if parsed.tzinfo is None else None
    except ValueError:
        return None


def projected_rows(paths: list[Path], columns: tuple[str, ...]) -> Iterator[tuple[Path, dict[str, str]]]:
    """Yield only declared columns while rejecting corrupt CSV headers and rows."""
    for file_number, path in enumerate(paths, 1):
        with path.open(encoding="utf-8-sig", newline="") as handle:
            reader = csv.reader(handle)
            header = next(reader, [])
            if len(header) != len(set(header)) or not set(columns).issubset(header):
                raise ValueError(f"Missing or duplicate columns in {path}")
            indexes = {name: header.index(name) for name in columns}
            for raw in reader:
                if len(raw) != len(header):
                    raise ValueError(f"Malformed CSV row in {path}")
                yield path, {name: raw[index].strip() for name, index in indexes.items()}
        if file_number % 200 == 0 or file_number == len(paths):
            table_name = next((table for table in COLUMNS if table in path.parts or path.stem == table), "table")
            LOGGER.info("Scanned table=%s files=%d/%d", table_name, file_number, len(paths))


def unique_dimensions(paths: list[Path], table: str) -> tuple[dict[str, dict[str, str]], dict[str, int]]:
    """Load a bounded dimension after proving its primary keys are unique."""
    rows: dict[str, dict[str, str]] = {}
    for _, row in projected_rows(paths, COLUMNS[table]):
        key = row[KEYS[table]]
        if not key or key in rows:
            raise ValueError(f"{table} has a blank or duplicate primary key")
        rows[key] = row
    return rows, {"files": len(paths), "rows": len(rows), "valid": len(rows), "blank_keys": 0, "duplicate_keys": 0}


def scan_marketing(paths: list[Path], campaigns: dict, customers: dict) -> tuple[dict, dict]:
    """Aggregate send-level outcomes with explicit known-value denominators."""
    groups: dict[str, dict[str, Counter]] = defaultdict(lambda: defaultdict(Counter))
    exposure = Counter()
    extra = Counter()
    quality = Counter()
    with DiskKeySet() as keys:
        for _, row in projected_rows(paths, COLUMNS["campaign_sends"]):
            quality["rows"] += 1
            key = row["send_id"]
            if not key:
                quality["blank_keys"] += 1
                continue
            if not keys.add(key):
                quality["duplicate_keys"] += 1
                continue
            quality["valid"] += 1
            campaign = campaigns.get(row["campaign_id"])
            customer = customers.get(row["customer_id"])
            if campaign is None:
                extra["unknown_campaign_sends"] += 1
            if customer is None:
                extra["unknown_customer_sends"] += 1
            else:
                if boolean(customer["accepts_marketing"]) is False:
                    extra["current_opt_out_sends"] += 1
                exposure[row["customer_id"]] += 1
            labels = {
                "overall": "All sends",
                "channel": row["send_channel"] or "Unknown",
                "objective": campaign["campaign_objective"] or "Unknown" if campaign else "Unknown",
                "segment": customer["segment"] or "Unknown" if customer else "Unknown",
                "country": customer["country"] or "Unknown" if customer else "Unknown",
            }
            delivered = boolean(row["was_delivered"])
            opened = boolean(row["was_opened"])
            clicked = boolean(row["was_clicked"])
            converted = boolean(row["had_conversion"])
            for dimension, label in labels.items():
                count = groups[dimension][label]
                count["sends"] += 1
                for name, value in (("delivered", delivered), ("converted", converted)):
                    count[name + "_known" if value is not None else name + "_unknown"] += 1
                    if value is True:
                        count["delivered" if name == "delivered" else "conversions"] += 1
                if delivered is True:
                    for name, value in (("open", opened), ("click", clicked)):
                        count[name + "_known" if value is not None else name + "_unknown"] += 1
                        if value is True:
                            count["opens" if name == "open" else "clicks"] += 1
                else:
                    if opened is None:
                        count["open_unknown"] += 1
                    if clicked is None:
                        count["click_unknown"] += 1
                    if opened is True or clicked is True:
                        count["engagement_without_delivery"] += 1
            send_time = timestamp(row["send_date"])
            conversion_time = timestamp(row["conversion_date"])
            if converted is True:
                if not conversion_time:
                    extra["conversions_without_valid_date"] += 1
                elif send_time and conversion_time < send_time:
                    extra["conversion_before_send"] += 1
                if not row["conversion_value"]:
                    extra["conversions_without_value"] += 1
    def metrics(count: Counter) -> dict:
        values = dict(count)
        values.update({
            "delivery_rate": count["delivered"] / count["delivered_known"] if count["delivered_known"] else None,
            "open_rate": count["opens"] / count["open_known"] if count["open_known"] else None,
            "click_rate": count["clicks"] / count["click_known"] if count["click_known"] else None,
            "conversion_rate": count["conversions"] / count["converted_known"] if count["converted_known"] else None,
        })
        return values
    result = {
        "overall": metrics(groups["overall"]["All sends"]),
        "dimensions": {dimension: {label: metrics(count) for label, count in sorted(labels.items())}
                       for dimension, labels in groups.items() if dimension != "overall"},
        "repeat_exposed_customers": sum(count > 1 for count in exposure.values()),
        "exposed_customers": len(exposure),
        "current_opt_out_sends": extra["current_opt_out_sends"],
        "quality_signals": dict(extra),
        "attribution": "Recorded send-level conversions are descriptive; no control assignment or direct digital-event campaign key is documented.",
    }
    return result, {"files": len(paths), **dict(quality)}


def summarize_products(products: dict, customers: dict) -> dict:
    """Aggregate ownership at customer and product type grains from one snapshot."""
    ownership = defaultdict(set)
    active = Counter()
    linked_known = Counter()
    linked_true = Counter()
    cohorts = Counter()
    active_customer_ids = set()
    for product in products.values():
        if product["product_status"] != "Active":
            continue
        kind = product["product_type"] or "Unknown"
        active[kind] += 1
        if product["customer_id"] in customers:
            ownership[kind].add(product["customer_id"])
            active_customer_ids.add(product["customer_id"])
        linked = boolean(product["has_linked_app"])
        if linked is not None:
            linked_known[kind] += 1
        if linked is True:
            linked_true[kind] += 1
        year = product["opening_date"][:4] if timestamp(product["opening_date"]) else "Unknown"
        cohorts[year] += 1
    cohort_denominators = {"segment": Counter(), "country": Counter()}
    cohort_owners = {"segment": Counter(), "country": Counter()}
    for customer_id, customer in customers.items():
        for dimension in ("segment", "country"):
            label = customer[dimension] or "Unknown"
            cohort_denominators[dimension][label] += 1
            if customer_id in active_customer_ids:
                cohort_owners[dimension][label] += 1
    return {
        "customer_denominator": len(customers),
        "active_customer_count": len(active_customer_ids),
        "adoption_cohorts": {dimension: {label: {"owners": cohort_owners[dimension][label], "customers": denominator, "rate": cohort_owners[dimension][label] / denominator} for label, denominator in sorted(cohort_denominators[dimension].items())} for dimension in ("segment", "country")},
        "active_by_type": dict(sorted(active.items())),
        "active_owners_by_type": {kind: len(ids) for kind, ids in sorted(ownership.items())},
        "linked_app_known_by_type": dict(sorted(linked_known.items())),
        "linked_app_true_by_type": dict(sorted(linked_true.items())),
        "active_opening_cohorts": dict(sorted(cohorts.items())),
        "approved_transaction_count_by_type": {},
        "active_products_with_approved_activity_by_type": {},
        "digital_product_events_by_type": {},
        "note": "Ownership and opening cohorts reflect the supplied product snapshot, not historical acquisition or settled usage.",
    }


def scan_transactions(paths: list[Path], products: dict, summary: dict) -> dict:
    """Aggregate approved transaction activity to product grain before dimension enrichment."""
    quality = Counter()
    activity = Counter()
    with DiskKeySet() as keys:
        for _, row in projected_rows(paths, COLUMNS["transactions"]):
            quality["rows"] += 1
            key = row["transaction_id"]
            if not key:
                quality["blank_keys"] += 1
                continue
            if not keys.add(key):
                quality["duplicate_keys"] += 1
                continue
            quality["valid"] += 1
            if row["transaction_status"] != "Approved":
                continue
            product_id = row["product_id"]
            if not product_id:
                quality["approved_blank_product_id"] += 1
            elif product_id not in products:
                quality["approved_unknown_product_id"] += 1
            else:
                activity[product_id] += 1
    by_type = Counter()
    active_with_activity = Counter()
    for product_id, count in activity.items():
        product = products[product_id]
        kind = product["product_type"] or "Unknown"
        by_type[kind] += count
        if product["product_status"] == "Active":
            active_with_activity[kind] += 1
    summary["approved_transaction_count_by_type"] = dict(sorted(by_type.items()))
    summary["active_products_with_approved_activity_by_type"] = dict(sorted(active_with_activity.items()))
    return {"files": len(paths), **dict(quality)}


def scan_digital(paths: list[Path], products: dict, summary: dict, scratch: Path) -> tuple[dict, dict]:
    """Aggregate event quality and derive a timestamp-ordered, disk-backed session funnel."""
    quality = Counter()
    signals = Counter()
    types = Counter()
    channels = Counter()
    product_events = Counter()
    connection = sqlite3.connect(scratch / "sessions.sqlite")
    connection.execute("PRAGMA journal_mode=OFF")
    connection.execute("PRAGMA synchronous=OFF")
    connection.execute("PRAGMA temp_store=FILE")
    connection.execute("PRAGMA cache_size=-32768")
    connection.execute("CREATE TABLE events (session_id TEXT, event_time TEXT, customer_id TEXT, event_type TEXT, event_category TEXT, product_id TEXT)")
    insert = "INSERT INTO events VALUES (?,?,?,?,?,?)"
    batch = []
    try:
        with DiskKeySet() as keys:
            for _, row in projected_rows(paths, COLUMNS["digital_events"]):
                quality["rows"] += 1
                key = row["event_id"]
                if not key:
                    quality["blank_keys"] += 1
                    continue
                if not keys.add(key):
                    quality["duplicate_keys"] += 1
                    continue
                quality["valid"] += 1
                types[row["event_type"] or "Unknown"] += 1
                channels[row["channel"] or "Unknown"] += 1
                if not row["customer_id"]:
                    signals["anonymous_events"] += 1
                if not row["product_id"]:
                    signals["unlinked_product_events"] += 1
                elif row["product_id"] in products:
                    kind = products[row["product_id"]]["product_type"] or "Unknown"
                    product_events[kind] += 1
                else:
                    signals["unknown_product_events"] += 1
                if row["utm_campaign"]:
                    signals["utm_labeled_events"] += 1
                if (row["event_type"] == "Login" and row["action"] == "logout") or (row["event_type"] == "Logout" and row["action"] == "login"):
                    signals["login_action_mismatch"] += 1
                event_time = timestamp(row["event_date"])
                if not row["session_id"]:
                    signals["missing_session_events"] += 1
                elif not event_time:
                    signals["invalid_time_events"] += 1
                else:
                    linked_product_id = row["product_id"] if row["product_id"] in products else ""
                    batch.append((row["session_id"], event_time, row["customer_id"], row["event_type"], row["event_category"], linked_product_id))
                    if len(batch) >= 5000:
                        connection.executemany(insert, batch)
                        batch.clear()
        if batch:
            connection.executemany(insert, batch)
        LOGGER.info("Indexing session events on disk")
        connection.execute("CREATE INDEX idx_session_time ON events(session_id,event_time)")
        LOGGER.info("Aggregating ordered session funnel")
        funnel = Counter()
        current_session = None
        customer = ""
        ambiguous = False
        login_time = None
        product_time = None
        linked = False
        def finish_session() -> None:
            if current_session is None:
                return
            funnel["all_sessions"] += 1
            if ambiguous:
                funnel["ambiguous_sessions"] += 1
                return
            funnel["eligible_sessions"] += 1
            if not customer:
                funnel["anonymous_sessions"] += 1
            if login_time:
                funnel["login"] += 1
            if product_time:
                funnel["product_after_login"] += 1
            if linked:
                funnel["linked_product_after_product"] += 1
        for session_id, event_time, customer_id, event_type, event_category, product_id in connection.execute(
            "SELECT session_id,event_time,customer_id,event_type,event_category,product_id FROM events ORDER BY session_id,event_time"
        ):
            if session_id != current_session:
                finish_session()
                current_session = session_id
                customer = ""
                ambiguous = False
                login_time = None
                product_time = None
                linked = False
            if customer_id:
                if customer and customer != customer_id:
                    ambiguous = True
                else:
                    customer = customer_id
            if event_type == "Login" and login_time is None:
                login_time = event_time
            if event_category == "Product" and login_time and event_time > login_time:
                if product_time is None:
                    product_time = event_time
                if product_id:
                    linked = True
        finish_session()
        summary["digital_product_events_by_type"] = dict(sorted(product_events.items()))
        return {
            "funnel": dict(funnel),
            "event_types": dict(sorted(types.items())),
            "channels": dict(sorted(channels.items())),
            "login_action_mismatch": signals["login_action_mismatch"],
            "coverage": dict(signals),
            "note": "Ordered engagement stages use event_type/category; Purchase events are not verified product acquisition.",
        }, {"files": len(paths), **dict(quality)}
    finally:
        connection.close()


def build_manifest(data_root: Path, files: dict[str, list[Path]]) -> dict:
    """Record deterministic input names and sizes without hashing raw contents."""
    entries = [
        {"table": table, "path": str(path.relative_to(data_root)), "bytes": path.stat().st_size}
        for table in TABLES for path in files[table]
    ]
    canonical = json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()
    return {"files": entries, "file_count": len(entries), "name_size_sha256": hashlib.sha256(canonical).hexdigest(), "verification": "Names and byte sizes, not content checksums"}


def analyze(data_root: Path, scratch: Path) -> tuple[dict, dict]:
    """Compute aggregate evidence at send, product, and session grains."""
    files = {table: discover_files(data_root, CONTRACTS[table]) for table in TABLES}
    missing = [table for table, paths in files.items() if not paths]
    if missing:
        raise ValueError(f"Missing table CSV files: {missing}")
    customers, customer_quality = unique_dimensions(files["customers"], "customers")
    products, product_quality = unique_dimensions(files["products"], "products")
    campaigns, campaign_quality = unique_dimensions(files["marketing_campaigns"], "marketing_campaigns")
    product_summary = summarize_products(products, customers)
    marketing, send_quality = scan_marketing(files["campaign_sends"], campaigns, customers)
    transaction_quality = scan_transactions(files["transactions"], products, product_summary)
    digital, event_quality = scan_digital(files["digital_events"], products, product_summary, scratch)
    results = {
        "metadata": {"generated_at_utc": datetime.now(timezone.utc).isoformat(), "analytical_grains": {"marketing": "send_id", "product": "product_id and unique customer_id", "digital": "session_id"}},
        "quality": {"customers": customer_quality, "products": product_quality, "marketing_campaigns": campaign_quality, "campaign_sends": send_quality, "transactions": transaction_quality, "digital_events": event_quality},
        "marketing": marketing,
        "products": product_summary,
        "digital": digital,
        "limitations": ["Synthetic data; descriptive associations do not establish causal uplift.", "Current accepts_marketing snapshot cannot establish consent at historical send time.", "Conversion and send-cost monetary units are undocumented, so cross-currency ROI is not calculated.", "Digital event_type and action can disagree; product_id is missing for many events.", "A digital Purchase event is not a verified product opening or bank transaction."],
    }
    return results, build_manifest(data_root, files)


def _bars(items: list[tuple[str, float]], title: str, unit: str = "count") -> str:
    """Render an accessible aggregate bar chart with no external assets."""
    if not items:
        return "<p>No observations.</p>"
    highest = max(value for _, value in items) or 1
    pieces = [f"<section class='chart'><h3>{html.escape(title)}</h3>"]
    for label, value in items[:9]:
        label_text = html.escape(str(label))
        shown = f"{value:.1f}%" if unit == "percent" else f"{int(value):,}"
        pieces.append(f"<div class='bar-row'><span class='bar-label'>{label_text}</span><div class='track'><div class='fill' style='width:{100 * value / highest:.2f}%'></div></div><strong>{shown}</strong></div>")
    pieces.append("</section>")
    return "".join(pieces)


def render_report(results: dict) -> str:
    """Create a standalone, aggregate-only dashboard with offline section controls."""
    m = results["marketing"]
    p = results["products"]
    d = results["digital"]
    overall = m["overall"]
    funnel = d["funnel"]
    channel = m["dimensions"].get("channel", {})
    objective = m["dimensions"].get("objective", {})
    channel_values = sorted(((name, 100 * (row["conversion_rate"] or 0)) for name, row in channel.items()), key=lambda item: -item[1])
    objective_values = sorted(((name, 100 * (row["conversion_rate"] or 0)) for name, row in objective.items()), key=lambda item: -item[1])
    segment_values = sorted(((name, 100 * (row["conversion_rate"] or 0)) for name, row in m["dimensions"].get("segment", {}).items()), key=lambda item: -item[1])
    country_values = sorted(((name, 100 * (row["conversion_rate"] or 0)) for name, row in m["dimensions"].get("country", {}).items()), key=lambda item: -item[1])
    ownership = sorted(p["active_owners_by_type"].items(), key=lambda item: -item[1])
    segment_adoption = sorted(((name, 100 * row["rate"]) for name, row in p["adoption_cohorts"]["segment"].items()), key=lambda item: -item[1])
    digital_product_use = sorted(p["digital_product_events_by_type"].items(), key=lambda item: -item[1])
    activity = sorted(p["approved_transaction_count_by_type"].items(), key=lambda item: -item[1])
    stages = [("Valid sessions", funnel.get("eligible_sessions", 0)), ("Login", funnel.get("login", 0)), ("Product after login", funnel.get("product_after_login", 0)), ("Linked product", funnel.get("linked_product_after_product", 0))]
    campaign_funnel = [("Delivered", 100 * (overall.get("delivery_rate") or 0)), ("Opened*", 100 * (overall.get("open_rate") or 0)), ("Clicked*", 100 * (overall.get("click_rate") or 0)), ("Converted", 100 * (overall.get("conversion_rate") or 0))]
    cards = [
        ("Campaign sends", f"{overall.get('sends', 0):,}"),
        ("Recorded conversions", f"{overall.get('conversions', 0):,}"),
        ("Active products", f"{sum(p['active_by_type'].values()):,}"),
        ("Valid sessions", f"{funnel.get('eligible_sessions', 0):,}"),
    ]
    card_html = "".join(f"<div class='kpi'><span>{html.escape(label)}</span><strong>{html.escape(value)}</strong></div>" for label, value in cards)
    quality_rows = "".join(f"<tr><td>{html.escape(table)}</td><td>{row.get('files', 0):,}</td><td>{row.get('rows', 0):,}</td><td>{row.get('valid', 0):,}</td><td>{row.get('blank_keys', 0):,}</td><td>{row.get('duplicate_keys', 0):,}</td></tr>" for table, row in results["quality"].items())
    channel_rows = "".join(
        f"<tr><td>{html.escape(name)}</td><td>{row.get('sends', 0):,}</td><td>{row.get('delivered', 0):,}/{row.get('delivered_known', 0):,}</td><td>{row.get('opens', 0):,}/{row.get('open_known', 0):,}</td><td>{row.get('clicks', 0):,}/{row.get('click_known', 0):,}</td><td>{row.get('conversions', 0):,}/{row.get('converted_known', 0):,}</td></tr>"
        for name, row in sorted(channel.items(), key=lambda item: -item[1].get('sends', 0))
    )
    product_rows = "".join(
        f"<tr><td>{html.escape(kind)}</td><td>{count:,}</td><td>{p['active_owners_by_type'].get(kind, 0):,}</td><td>{p['linked_app_true_by_type'].get(kind, 0):,}/{p['linked_app_known_by_type'].get(kind, 0):,}</td><td>{p['active_products_with_approved_activity_by_type'].get(kind, 0):,}</td></tr>"
        for kind, count in sorted(p['active_by_type'].items(), key=lambda item: -item[1])
    )
    limitations = "".join(f"<li>{html.escape(item)}</li>" for item in results["limitations"])
    return f"""<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><title>ArabicaAI | Marketing & Product Evidence</title>
<style>:root{{--ink:#173147;--muted:#5c7181;--blue:#16809a;--teal:#54c6ac;--cream:#f5f7f3;--line:#dce6e6}}*{{box-sizing:border-box}}body{{margin:0;background:var(--cream);color:var(--ink);font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}}header{{background:linear-gradient(135deg,#102b43,#11677f);color:white;padding:4rem max(5vw,2rem) 3rem}}header h1{{font-size:clamp(2rem,4vw,3.5rem);line-height:1.1;max-width:850px;margin:.4rem 0}}header p{{max-width:850px;color:#d3eced}}.eyebrow{{text-transform:uppercase;letter-spacing:.18em;font-weight:700;font-size:.76rem}}main{{max-width:1280px;margin:auto;padding:2rem max(2vw,1rem)}}.kpis{{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-top:-3.6rem;position:relative}}.kpi,.panel,.chart{{background:white;border:1px solid var(--line);border-radius:16px;box-shadow:0 8px 24px #1937470d}}.kpi{{padding:1.2rem}}.kpi span{{display:block;color:var(--muted);font-size:.85rem}}.kpi strong{{font-size:1.9rem}}nav{{display:flex;flex-wrap:wrap;gap:.5rem;margin:2rem 0 1rem}}nav button{{border:1px solid var(--line);background:white;color:var(--ink);padding:.7rem 1rem;border-radius:999px;font:inherit;cursor:pointer}}nav button[aria-selected=true]{{background:var(--ink);color:white}}.panel{{padding:1.6rem;margin:1rem 0}}.panel h2{{margin-top:0}}.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:1rem}}.chart{{padding:1.3rem;box-shadow:none}}.chart h3{{font-size:1rem;margin:.1rem 0 1rem}}.bar-row{{display:grid;grid-template-columns:minmax(90px,150px) 1fr 85px;align-items:center;gap:.7rem;margin:.7rem 0;font-size:.84rem}}.bar-label{{overflow-wrap:anywhere}}.track{{height:16px;background:#e8f0ee;border-radius:20px;overflow:hidden}}.fill{{height:100%;background:linear-gradient(90deg,var(--blue),var(--teal));border-radius:20px}}.bar-row strong{{text-align:right}}.note{{background:#eef7f5;border-left:4px solid var(--blue);padding:1rem;margin:1rem 0}}table{{border-collapse:collapse;width:100%;font-size:.9rem}}th,td{{padding:.55rem;text-align:left;border-bottom:1px solid var(--line)}}th{{color:var(--muted)}}.scroll{{overflow:auto}}[hidden]{{display:none!important}}footer{{max-width:1280px;margin:auto;padding:1rem 2rem 3rem;color:var(--muted)}}@media(max-width:600px){{.bar-row{{grid-template-columns:90px 1fr 60px}}header{{padding-bottom:5rem}}}}</style></head>
<body><header><div class='eyebrow'>ArabicaAI · synthetic data · private team report</div><h1>Marketing & product evidence</h1><p>Observed campaign response, product ownership, and digital engagement. Rates are descriptive; no causal attribution, product acquisition, or ROI is inferred.</p></header><main><div class='kpis'>{card_html}</div>
<nav aria-label='Report sections'><button type='button' aria-selected='true' data-target='marketing'>Marketing</button><button type='button' aria-selected='false' data-target='products'>Products</button><button type='button' aria-selected='false' data-target='digital'>Digital</button><button type='button' aria-selected='false' data-target='methods'>Methods</button></nav>
<section id='marketing' class='panel'><h2>Campaign effectiveness</h2><p>Recorded conversion rate uses known <code>had_conversion</code> values over valid sends. Delivery uses known <code>was_delivered</code>; open and click rates use known values among delivered sends.</p><div class='grid'>{_bars(campaign_funnel, 'Observed campaign rates · %', 'percent')}{_bars(channel_values, 'Recorded conversion by send channel', 'percent')}{_bars(objective_values, 'Recorded conversion by campaign objective', 'percent')}{_bars(segment_values, 'Recorded conversion by current segment · %', 'percent')}{_bars(country_values, 'Recorded conversion by current country · %', 'percent')}</div><p class='small'>* Open and click rates use known values among delivered sends. Delivery uses known delivery flags; conversion uses known flags across valid sends. Unknown counts remain in summary.json.</p><div class='scroll'><table><thead><tr><th>Channel</th><th>Sends</th><th>Delivered / known</th><th>Opened / known delivered</th><th>Clicked / known delivered</th><th>Converted / known</th></tr></thead><tbody>{channel_rows}</tbody></table></div><div class='note'><strong>Attribution boundary:</strong> {html.escape(m['attribution'])} {m['repeat_exposed_customers']:,} customers received multiple sends. {m['current_opt_out_sends']:,} sends map to customers whose current snapshot says <code>accepts_marketing=False</code>; historical consent is unknown.</div></section>
<section id='products' class='panel' hidden><h2>Ownership and observed activity</h2><p>Active owners are unique customers with an active product of each type. Approved transaction counts are observed activity, not settled value or adoption. Opening cohorts are subject to product-snapshot survivorship.</p><div class='grid'>{_bars(ownership, 'Active owners by product type')}{_bars(activity, 'Approved transactions by product type')}{_bars(segment_adoption, 'Active ownership by segment · %', 'percent')}{_bars(digital_product_use, 'Linked digital events by product type')}</div><div class='scroll'><table><thead><tr><th>Product type</th><th>Active products</th><th>Active owners</th><th>Linked app / known</th><th>Active products with approved activity</th></tr></thead><tbody>{product_rows}</tbody></table></div><div class='note'>{html.escape(p['note'])}</div></section>
<section id='digital' class='panel' hidden><h2>Digital engagement</h2><p>Session stages require a Login event followed in timestamp order by a Product-category event and then an identifiable product event. The last stage may occur on the first Product event. Ambiguous sessions are excluded.</p><div class='grid'>{_bars(stages, 'Ordered session funnel')}{_bars(sorted(d['event_types'].items(), key=lambda item:-item[1]), 'Digital event types')}</div><div class='note'>{funnel.get('ambiguous_sessions', 0):,} sessions contain multiple customer IDs; {d['coverage'].get('anonymous_events', 0):,} events lack a customer ID; {d['coverage'].get('unlinked_product_events', 0):,} lack a product ID. {d['login_action_mismatch']:,} Login/Logout events disagree with their action label.</div></section>
<section id='methods' class='panel' hidden><h2>Methods and quality</h2><p>Marketing grain: <code>send_id</code>. Ownership: product and unique customer. Transaction activity is aggregated by <code>product_id</code> before enrichment. Digital grain: <code>session_id</code>, sorted by event timestamp on disk. All six tables were scanned from local CSVs; duplicate fact IDs after their first occurrence are excluded and counted below.</p><div class='scroll'><table><thead><tr><th>Table</th><th>Files</th><th>Raw rows</th><th>Included rows</th><th>Blank IDs</th><th>Repeated IDs</th></tr></thead><tbody>{quality_rows}</tbody></table></div><h3>Limits</h3><ul>{limitations}</ul></section></main>
<footer>Generated {html.escape(results['metadata']['generated_at_utc'])}. Aggregate-only offline report; no external requests.</footer><script>document.querySelectorAll('nav button').forEach(button=>button.addEventListener('click',()=>{{document.querySelectorAll('nav button').forEach(b=>b.setAttribute('aria-selected',String(b===button)));document.querySelectorAll('main>section.panel').forEach(section=>section.hidden=section.id!==button.dataset.target)}}));</script></body></html>"""


def preview_svg(results: dict) -> str:
    """Create a compact, aggregate-only SVG preview for repository Markdown."""
    values = sorted(results["products"]["active_owners_by_type"].items(), key=lambda item: -item[1])[:5]
    maximum = max((value for _, value in values), default=1)
    parts = ["<svg xmlns='http://www.w3.org/2000/svg' width='820' height='350' viewBox='0 0 820 350' role='img' aria-label='Active product owners by type'><rect width='820' height='350' rx='18' fill='#f5f7f3'/><text x='30' y='44' fill='#173147' font-size='22' font-family='sans-serif' font-weight='bold'>Active product owners</text>"]
    for index, (label, value) in enumerate(values):
        y = 78 + index * 51
        safe = html.escape(label)
        parts.append(f"<text x='30' y='{y + 16}' fill='#173147' font-size='14' font-family='sans-serif'>{safe}</text><rect x='230' y='{y}' width='{530 * value / maximum:.1f}' height='24' rx='6' fill='#16809a'/><text x='772' y='{y + 17}' text-anchor='end' fill='#173147' font-size='14' font-family='sans-serif'>{value:,}</text>")
    parts.append("</svg>")
    return "".join(parts)
