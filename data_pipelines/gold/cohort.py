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

Values are the Bronze source amount, currency and timestamp, exactly as the one-day slice serves
them, and the seed is split into parts that each stay under a D1 write budget.

Memory model: DuckDB read-only, 2 GB, 2 threads, disk spill. Eligibility, windows and counts are
grouped SQL; Python holds only the selected customers (at most ``size``) and their capped rows.
"""
from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

import duckdb
from intake_agent.context_card import build_context_card

from .intake_slice import (MAPPING, SliceRow, _validated, check_quality_gate, content_version,
                           context_card_statement, dataset_allowlist, dataset_customer_statement,
                           provenance_statement, transaction_statement, with_header)

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


_ELIGIBLE = """
    WITH complainants AS (
        SELECT DISTINCT c.customer_id, cu.country, cu.customer_status
        FROM silver.fact_complaints c JOIN silver.dim_customers cu ON cu.customer_id = c.customer_id
        WHERE c.subcategory = $sub AND c.creation_date < $design_end
    ), eligible AS (
        SELECT customer_id, country FROM complainants WHERE customer_status IS DISTINCT FROM 'Closed'
    ), win AS (
        -- N:1 to products; the owner is checked below, never assumed.
        SELECT t.transaction_id, t.customer_id, t.merchant_name, p.customer_id AS product_owner
        FROM silver.fact_transactions t
        LEFT JOIN silver.dim_products p ON p.product_id = t.product_id
        WHERE t.transaction_type = 'Purchase' AND t.transaction_status = 'Approved'
          AND t.transaction_date > $start AND t.transaction_date < $end
          AND t.customer_id IN (SELECT customer_id FROM eligible)
    ), per AS (
        SELECT e.customer_id, e.country, count(w.transaction_id) FILTER (WHERE w.merchant_name IS NOT NULL) AS usable
        FROM eligible e LEFT JOIN win w ON w.customer_id = e.customer_id
        GROUP BY 1, 2
    )
    SELECT (SELECT count(*) FROM complainants WHERE customer_status = 'Closed') AS closed,
           (SELECT count(*) FROM win WHERE product_owner IS DISTINCT FROM customer_id) AS owner_mismatch,
           (SELECT count(*) FROM win WHERE merchant_name IS NULL) AS without_merchant,
           (SELECT list({'customer_id': customer_id, 'country': country, 'usable': usable} ORDER BY customer_id) FROM per) AS pool
"""

_SHARES = """
    SELECT cu.country, count(DISTINCT c.customer_id) * 1.0 / sum(count(DISTINCT c.customer_id)) OVER () AS share
    FROM silver.fact_complaints c JOIN silver.dim_customers cu ON cu.customer_id = c.customer_id
    WHERE c.subcategory = $sub AND c.creation_date < $design_end
    GROUP BY 1 ORDER BY 1
"""

_ROWS = """
    WITH picked AS (
        SELECT t.transaction_id, t.customer_id, t.product_id, t.transaction_date, t.merchant_name, t.currency,
               row_number() OVER (PARTITION BY t.customer_id ORDER BY t.transaction_date DESC, t.transaction_id) AS rk
        FROM silver.fact_transactions t
        JOIN silver.dim_products p ON p.product_id = t.product_id AND p.customer_id = t.customer_id
        WHERE t.transaction_type = 'Purchase' AND t.transaction_status = 'Approved'
          AND t.transaction_date > $start AND t.transaction_date < $end
          AND t.merchant_name IS NOT NULL
          AND t.customer_id IN (SELECT unnest($customers::VARCHAR[]))
    ), kept AS (SELECT * FROM picked WHERE rk <= $cap),
    raw AS (
        SELECT transaction_id, count(*) AS n, any_value(amount) AS amount, any_value(_source_file) AS source_file,
               any_value(transaction_date) AS raw_ts
        FROM bronze.transactions WHERE transaction_id IN (SELECT transaction_id FROM kept)
        GROUP BY transaction_id
    )
    SELECT kept.transaction_id, kept.customer_id, kept.product_id, kept.transaction_date, kept.merchant_name,
           kept.currency, raw.amount, raw.source_file, coalesce(raw.n, 0), raw.raw_ts,
           (SELECT count(*) FROM picked WHERE rk > $cap) AS over_cap
    FROM kept LEFT JOIN raw USING (transaction_id)
    ORDER BY kept.customer_id, kept.transaction_date DESC, kept.transaction_id
"""


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
    """First name and last initial: enough to pick a demo customer, no full name served."""
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


def build_cohort(db_path: Path, quality_path: Path, params: CohortParams) -> tuple[list[str], dict]:
    """Validate the inputs and return ``(seed_parts, manifest)`` without writing anything."""
    meta = check_quality_gate(db_path, quality_path, params.as_of)
    if "complaints" not in set(meta.get("tables", [])):
        raise ValueError("The quality run does not cover complaints, which define the cohort")
    start, end = params.window
    temp_dir = db_path.parent / "duckdb_tmp"
    temp_dir.mkdir(parents=True, exist_ok=True)
    with duckdb.connect(str(db_path), read_only=True) as con:
        con.execute("SET memory_limit='2GB'")
        con.execute("SET threads=2")
        con.execute("SET temp_directory=?", [str(temp_dir)])
        common = {"sub": SUBCATEGORY, "design_end": datetime.combine(params.design_end, datetime.min.time())}
        closed, mismatch, without_merchant, pool = con.execute(
            _ELIGIBLE, {**common, "start": start, "end": end}).fetchone()
        if mismatch:
            raise ValueError(f"{mismatch} window purchases fail the product ownership check")
        shares = dict(con.execute(_SHARES, common).fetchall())
        # Committed identities (the one-day slice's customer) keep their own reviewed seed and name.
        committed = set(dataset_allowlist())
        excluded_committed = sum(1 for c in pool if c["customer_id"] in committed)
        pool = [c for c in pool if c["customer_id"] not in committed]
        dense = [c for c in pool if c["usable"] >= params.min_purchases]
        chosen, sampling = _sample(dense, params, shares)
        ids = [c["customer_id"] for c in chosen]
        raw = con.execute(_ROWS, {"start": start, "end": end, "customers": ids, "cap": params.max_per_customer}).fetchall() if ids else []
        over_cap = raw[0][-1] if raw else 0
        rows: list[SliceRow] = [_validated(r[:-1]) for r in raw]
        names = {cid: _display_name(f, l) for cid, f, l in con.execute(
            "SELECT customer_id, first_name, last_name FROM silver.dim_customers WHERE customer_id IN (SELECT unnest(?::VARCHAR[]))",
            [ids]).fetchall()} if ids else {}
        cards = {cid: build_context_card(con, cid) for cid in ids}
    if any(card is None or not (card["first_name"] or "").strip() for card in cards.values()):
        raise ValueError("A selected customer has no context card or no first_name")
    by_customer: dict[str, list[SliceRow]] = {}
    for r in rows:
        by_customer.setdefault(r.customer_id, []).append(r)
    country = {c["customer_id"]: c["country"] for c in chosen}
    blocks = []
    for cid in ids:
        mine = by_customer.get(cid, [])
        lines = [dataset_customer_statement(cid, names[cid], country[cid]),
                 context_card_statement(cid, cards[cid], meta["generated_at_utc"])]
        lines += [transaction_statement(r.transaction_id, cid, None, r.source_occurred_at, r.merchant_name, r.amount, r.currency)
                  for r in mine]
        lines += [provenance_statement(r.transaction_id, r.product_id, r.source_file, date.fromisoformat(r.source_occurred_at[:10]))
                  for r in mine]
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
        "mapping": MAPPING, "quality_generated_at_utc": meta["generated_at_utc"],
    }
    return seeds, manifest
