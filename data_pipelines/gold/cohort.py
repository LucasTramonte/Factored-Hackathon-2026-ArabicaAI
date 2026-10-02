"""Gold cohort: customers who disputed a charge, with their recent approved purchases, as D1 seed parts.

The one-day slice in ``intake_slice`` shows a handful of rows. The cohort serves the customers the
workflow is for, defined by the design-window findings in ``Docs/deliverables/DATA_QUALITY.md``:

- **Who** (DF-022): customers with a ``Cargo no reconocido`` complaint created before the design
  end (ADR-005), excluding closed accounts. Holdout complaints never decide who is served.
- **Which rows** (DF-021): their approved purchases in the ``window_days`` before ``as_of``, with a
  merchant (D1 requires one), capped per customer at the most recent ``max_per_customer``. Only
  customers with at least ``min_purchases`` such rows are served, so each has a list to choose from.
- **How many**: everyone eligible when the pool fits ``size``; otherwise per-country quotas from the
  design-window shares, filled in a salted md5 order so the sample is reproducible.

The cohort reads **only the Gold tables** (``build_gold.py``), never Silver or Bronze. Gold has
already checked what the seed relies on: the buyer owns the card, one Bronze row per purchase, the
Bronze amount and wall time verbatim, the display name rule and byte-identical context cards. So
this module only selects. The gate is the Gold build itself: every table used must come from a
committed build of one quality run whose transactions watermark is ``as_of``.

Values are the Bronze source amount, currency and timestamp, exactly as the one-day slice serves
them, and the seed is split into parts that each stay under a D1 write budget.

Memory model: DuckDB read-only on the Gold file, 2 GB, 2 threads, disk spill. Eligibility, windows
and counts are grouped SQL; Python holds only the selected customers (at most ``size``), their capped
rows and their cards.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

import duckdb

from .intake_slice import (MAPPING, content_version, context_card_statement, dataset_allowlist,
                           dataset_customer_statement, provenance_statement, transaction_statement,
                           with_header)

GOLD_TABLES = ("customers", "customer_complaints", "card_purchases", "context_cards")
SUBCATEGORY = "Cargo no reconocido"
DESIGN_END = date(2026, 1, 1)  # ADR-005
MAX_WINDOW_DAYS = 120          # the cap DF-021 falls back to
# D1 counts index writes: a customer row is the table plus its PK index, a context card the same,
# and a transaction the table, its PK, the unique and order indexes plus its provenance row and PK.
# Derived from the schema, not yet measured: local Wrangler doesn't report rows written, so the
# loader checks it against remote D1's count on the first remote load.
WRITES = {"customer": 2, "card": 2, "transaction": 6}


@dataclass(frozen=True)
class CohortParams:
    """Cohort definition. Every bound is checked here, so a bad value never reaches SQL."""
    as_of: date
    window_days: int = MAX_WINDOW_DAYS
    min_purchases: int = 3
    max_per_customer: int = 50
    size: int = 1000
    country_floor: int = 100
    salt: str = "cohort-v1"
    part_write_limit: int = 70_000
    design_end: date = field(default=DESIGN_END)

    def __post_init__(self):
        if not 1 <= self.window_days <= MAX_WINDOW_DAYS:
            raise ValueError(f"window_days must be between 1 and {MAX_WINDOW_DAYS}")
        if self.min_purchases < 1 or not 1 <= self.max_per_customer <= 500 or self.size < 1:
            raise ValueError("min_purchases, max_per_customer and size must be positive (max_per_customer <= 500)")
        if self.country_floor < 0 or self.part_write_limit < 1 or not self.salt:
            raise ValueError("country_floor, part_write_limit and salt are out of bounds")
        if self.min_purchases > self.max_per_customer:
            raise ValueError("min_purchases cannot exceed max_per_customer")

    @property
    def window(self) -> tuple[datetime, datetime]:
        """``(start, end)``, both exclusive: exactly ``window_days`` ending at the close of ``as_of``."""
        end = datetime.combine(self.as_of + timedelta(days=1), datetime.min.time())
        return end - timedelta(days=self.window_days), end


def estimate_writes(customers: int, cards: int, transactions: int) -> int:
    """Expected D1 rows written for a load, including index writes (checked on the remote load)."""
    return WRITES["customer"] * customers + WRITES["card"] * cards + WRITES["transaction"] * transactions


def allocate_quotas(available: dict[str, int], shares: dict[str, float], size: int, floor: int) -> dict[str, int]:
    """Per-country quotas: a floor each, the rest split by share with the largest remainder.

    A country with fewer customers than its quota keeps all it has; its gap is not redistributed,
    so the mix stays close to the reference shares instead of drifting to the largest country.
    """
    countries = sorted(available)
    base = {c: min(floor, size // max(len(countries), 1)) for c in countries}
    rest = size - sum(base.values())
    total = sum(shares.get(c, 0.0) for c in countries) or 1.0
    exact = {c: rest * shares.get(c, 0.0) / total for c in countries}
    quotas = {c: base[c] + int(exact[c]) for c in countries}
    leftover = size - sum(quotas.values())
    for c in sorted(countries, key=lambda c: (-(exact[c] - int(exact[c])), c))[:leftover]:
        quotas[c] += 1
    return {c: min(q, available[c]) for c, q in quotas.items()}


# A complaint "before the design end" exists exactly when the customer's first one of that type is.
_ELIGIBLE = """
    WITH complainants AS (
        SELECT DISTINCT k.customer_id, c.country, c.customer_status
        FROM gold.customer_complaints k JOIN gold.customers c USING (customer_id)
        WHERE k.subcategory = $sub AND k.first_created_at < $design_end
    ), eligible AS (
        SELECT customer_id, country FROM complainants WHERE customer_status IS DISTINCT FROM 'Closed'
    ), win AS (
        -- Gold has already proved every purchase is on a card its buyer owns, so no owner join here.
        SELECT p.transaction_id, p.customer_id, p.merchant_name
        FROM gold.card_purchases p
        WHERE p.occurred_at > $start AND p.occurred_at < $end
          AND p.customer_id IN (SELECT customer_id FROM eligible)
    ), per AS (
        SELECT e.customer_id, e.country, count(w.transaction_id) FILTER (WHERE w.merchant_name IS NOT NULL) AS usable
        FROM eligible e LEFT JOIN win w ON w.customer_id = e.customer_id
        GROUP BY 1, 2
    )
    SELECT (SELECT count(*) FROM complainants WHERE customer_status = 'Closed') AS closed,
           (SELECT count(*) FROM win WHERE merchant_name IS NULL) AS without_merchant,
           (SELECT list({'customer_id': customer_id, 'country': country, 'usable': usable} ORDER BY customer_id) FROM per) AS pool
"""

_SHARES = """
    SELECT c.country, count(DISTINCT k.customer_id) * 1.0 / sum(count(DISTINCT k.customer_id)) OVER () AS share
    FROM gold.customer_complaints k JOIN gold.customers c USING (customer_id)
    WHERE k.subcategory = $sub AND k.first_created_at < $design_end
    GROUP BY 1 ORDER BY 1
"""

_ROWS = """
    WITH picked AS (
        SELECT transaction_id, customer_id, product_id, occurred_at, source_occurred_at, merchant_name, amount,
               currency, source_file, business_date,
               row_number() OVER (PARTITION BY customer_id ORDER BY occurred_at DESC, transaction_id) AS rk
        FROM gold.card_purchases
        WHERE occurred_at > $start AND occurred_at < $end AND merchant_name IS NOT NULL
          AND customer_id IN (SELECT unnest($customers::VARCHAR[]))
    )
    SELECT transaction_id, customer_id, product_id, source_occurred_at, merchant_name, amount, currency,
           source_file, business_date, (SELECT count(*) FROM picked WHERE rk > $cap) AS over_cap
    FROM picked WHERE rk <= $cap
    ORDER BY customer_id, occurred_at DESC, transaction_id
"""

_PEOPLE = """
    SELECT c.customer_id, c.display_name, k.card_json, k.snapshot_at
    FROM gold.customers c LEFT JOIN gold.context_cards k USING (customer_id)
    WHERE c.customer_id IN (SELECT unnest($customers::VARCHAR[]))
"""


def check_gold(con: duckdb.DuckDBPyConnection, as_of: date) -> dict:
    """Require every Gold table the cohort reads from one committed build of one quality run, loaded to ``as_of``.

    ``gold.table_builds`` says which build each table comes from (a ``--tables`` run rebuilds only
    some); ``gold.builds`` records that build's quality run and watermarks. Tables from different
    quality runs could mix customers and purchases of different snapshots, so they are refused.
    """
    try:
        rows = con.execute("""
            SELECT t.table_name, t.build_id, t.quality_generated_at_utc, b.quality_report, b.watermarks, b.silver_database
            FROM gold.table_builds t JOIN gold.builds b USING (build_id)
            WHERE t.table_name IN (SELECT unnest(?::VARCHAR[]))
        """, [list(GOLD_TABLES)]).fetchall()
    except (duckdb.CatalogException, duckdb.BinderException) as exc:  # no lineage tables, or a pre-lineage layout
        raise ValueError("The Gold file has no build lineage; run the Gold build first") from exc
    built = {r[0]: r for r in rows}
    missing = [t for t in GOLD_TABLES if t not in built]
    if missing:
        raise ValueError(f"Gold has no committed build of {', '.join(missing)}")
    runs = {r[2] for r in rows}
    if len(runs) != 1:
        raise ValueError("The Gold tables come from different quality runs; rebuild them together")
    for name in GOLD_TABLES:  # a fixed order, so the same Gold always gives the same message
        watermarks = built[name][4]
        loaded = json.loads(watermarks or "{}").get("transactions")
        if loaded is None:
            raise ValueError(f"gold.{name} comes from a build with no recorded transactions watermark; rebuild Gold")
        if loaded != str(as_of):
            raise ValueError(f"gold.{name} was built from transactions loaded to {loaded}, not as_of {as_of}")
    first = built[GOLD_TABLES[0]]
    return {"quality_generated_at_utc": first[2], "quality_report": first[3], "silver_database": first[5],
            "watermarks": json.loads(first[4]), "table_builds": {name: built[name][1] for name in GOLD_TABLES}}


def _sample(pool: list[dict], params: CohortParams, shares: dict[str, float]) -> tuple[list[dict], str]:
    """Everyone when the pool fits ``size``; otherwise per-country quotas in salted md5 order."""
    if len(pool) <= params.size:
        return sorted(pool, key=lambda c: c["customer_id"]), "all_eligible"
    by_country: dict[str, list[dict]] = {}
    for c in pool:
        by_country.setdefault(c["country"], []).append(c)
    quotas = allocate_quotas({k: len(v) for k, v in by_country.items()}, shares, params.size, params.country_floor)
    key = lambda c: (hashlib.md5((c["customer_id"] + params.salt).encode("utf-8")).hexdigest(), c["customer_id"])
    chosen = [c for k, members in by_country.items() for c in sorted(members, key=key)[:quotas[k]]]
    return sorted(chosen, key=lambda c: c["customer_id"]), "country_quotas"


def _display_name(first: str, last: str | None) -> str:
    """First name and last initial: enough to pick a demo customer, no full name served.

    Gold builds the same label in SQL (``build_gold.DISPLAY_NAME``) and a test pins the two together;
    the cohort now serves Gold's, so this is the reference rule.
    """
    first, last = (first or "").strip(), (last or "").strip()
    return f"{first} {last[0]}." if last else first


def _parts(blocks: list[tuple[str, list[str], int, int]], limit: int, as_of: date) -> list[tuple[str, dict]]:
    """Group whole customer blocks into parts that stay under ``limit`` expected writes."""
    parts, current, writes, members, rows = [], [], 0, [], 0
    for customer_id, lines, block_writes, n_rows in blocks:
        if block_writes > limit:
            raise ValueError(f"Customer {customer_id} needs {block_writes} writes, over the part write limit {limit}")
        if current and writes + block_writes > limit:
            parts.append((current, writes, members, rows))
            current, writes, members, rows = [], 0, [], 0
        current += lines
        writes, members, rows = writes + block_writes, members + [customer_id], rows + n_rows
    if current:
        parts.append((current, writes, members, rows))
    rendered = []
    for i, (lines, writes, members, rows) in enumerate(parts, 1):
        seed = with_header("\n".join(lines) + "\n", f"Gold cohort as of {as_of}, part {i} of {len(parts)}")
        rendered.append((seed, {"index": i, "version": content_version(seed), "expected_writes": writes,
                                "customers": len(members), "transactions": rows, "customer_ids": members}))
    return rendered


def build_cohort(gold_db: Path, params: CohortParams) -> tuple[list[str], dict]:
    """Select the cohort from the Gold tables and return ``(seed_parts, manifest)`` without writing anything."""
    if not gold_db.exists():
        raise ValueError(f"No Gold DuckDB at {gold_db}; run the Gold build first")
    start, end = params.window
    temp_dir = gold_db.parent / "duckdb_tmp"
    temp_dir.mkdir(parents=True, exist_ok=True)
    with duckdb.connect(str(gold_db), read_only=True) as con:
        con.execute("SET memory_limit='2GB'")
        con.execute("SET threads=2")
        con.execute("SET temp_directory=?", [str(temp_dir)])
        gold = check_gold(con, params.as_of)
        common = {"sub": SUBCATEGORY, "design_end": datetime.combine(params.design_end, datetime.min.time())}
        closed, without_merchant, pool = con.execute(_ELIGIBLE, {**common, "start": start, "end": end}).fetchone()
        pool = pool or []
        shares = dict(con.execute(_SHARES, common).fetchall())
        # Committed identities (the one-day slice's customer) keep their own reviewed seed and name.
        committed = set(dataset_allowlist())
        excluded_committed = sum(1 for c in pool if c["customer_id"] in committed)
        pool = [c for c in pool if c["customer_id"] not in committed]
        dense = [c for c in pool if c["usable"] >= params.min_purchases]
        chosen, sampling = _sample(dense, params, shares)
        ids = [c["customer_id"] for c in chosen]
        rows = con.execute(_ROWS, {"start": start, "end": end, "customers": ids, "cap": params.max_per_customer}).fetchall() if ids else []
        over_cap = rows[0][-1] if rows else 0
        people = {r[0]: r[1:] for r in con.execute(_PEOPLE, {"customers": ids}).fetchall()} if ids else {}
    if any(people.get(cid, (None, None, None))[1] is None for cid in ids):
        raise ValueError("A selected customer has no Gold context card")
    by_customer: dict[str, list[tuple]] = {}
    for r in rows:
        by_customer.setdefault(r[1], []).append(r)
    country = {c["customer_id"]: c["country"] for c in chosen}
    blocks = []
    for cid in ids:
        name, card_json, snapshot_at = people[cid]
        mine = by_customer.get(cid, [])
        # Gold's card_json is already the canonical serialization; parsing and re-serializing it
        # through the shared statement builder gives back the same text.
        lines = [dataset_customer_statement(cid, name, country[cid]),
                 context_card_statement(cid, json.loads(card_json), snapshot_at)]
        lines += [transaction_statement(tid, cid, None, when, merchant, amount, currency)
                  for tid, _, _, when, merchant, amount, currency, _, _, _ in mine]
        lines += [provenance_statement(tid, product, source_file, business_date)
                  for tid, _, product, _, _, _, _, source_file, business_date, _ in mine]
        blocks.append((cid, lines, estimate_writes(1, 1, len(mine)), len(mine)))
    rendered = _parts(blocks, params.part_write_limit, params.as_of)
    seeds = [seed for seed, _ in rendered]
    by_country_stats = {}
    for c in pool:
        s = by_country_stats.setdefault(c["country"], {"eligible": 0, "dense": 0, "selected": 0})
        s["eligible"] += 1
        s["dense"] += c["usable"] >= params.min_purchases
    for c in chosen:
        by_country_stats[c["country"]]["selected"] += 1
    manifest = {
        "scope": "cohort", "as_of": str(params.as_of),
        "slice_version": hashlib.sha256("".join(p["version"] for _, p in rendered).encode()).hexdigest()[:16],
        "params": {k: (str(v) if isinstance(v, date) else v) for k, v in asdict(params).items()},
        "window": {"start_exclusive": start.isoformat(), "end_exclusive": end.isoformat()},
        "definition": {"subcategory": SUBCATEGORY, "complaint_created_before": str(params.design_end),
                       "transaction_type": "Purchase", "transaction_status": "Approved",
                       "excluded_customer_status": "Closed", "findings": ["DF-020", "DF-021", "DF-022"]},
        "sampling": sampling, "reference_shares": {k: round(v, 4) for k, v in sorted(shares.items())},
        "by_country": dict(sorted(by_country_stats.items())),
        "exclusions": {"customers_closed": closed, "committed_identities": excluded_committed, "window_rows_without_merchant": without_merchant,
                       "customers_below_min_purchases": len(pool) - len(dense), "rows_over_per_customer_cap": over_cap},
        "expected_writes_total": sum(p["expected_writes"] for _, p in rendered),
        "parts": [p for _, p in rendered],
        "customers": [{"customer_id": cid, "country": country[cid], "transactions": len(by_customer.get(cid, []))} for cid in ids],
        "mapping": MAPPING, "quality_generated_at_utc": gold["quality_generated_at_utc"],
        "source": {"gold_database": str(gold_db.resolve()), **gold},
    }
    return seeds, manifest
