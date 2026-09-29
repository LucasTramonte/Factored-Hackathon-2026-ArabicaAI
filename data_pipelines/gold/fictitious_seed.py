"""Render back-end/seeds/seed_fictitious.sql from fictitious.json and identities.json.

The fictitious seed uses the same statement builders as the Gold slice, so both get the same
drift guard. A test fails if the committed SQL differs from this output.
Regenerate with ``python -m data_pipelines.gold.fictitious_seed``.
"""
from __future__ import annotations

import json
from pathlib import Path

from .intake_slice import AMOUNT, CURRENCY, IDENTITIES, REPO_ROOT, customer_statement, transaction_statement, with_header

DATA = REPO_ROOT / "back-end/seeds/fictitious.json"
SEED = REPO_ROOT / "back-end/seeds/seed_fictitious.sql"


def render_fictitious_seed(data: Path = DATA, identities: Path = IDENTITIES) -> str:
    """Seed SQL for fictitious identities and their charges. Every owner must be marked ``fictitious``."""
    people = {c["customer_id"]: c["display_name"] for c in json.loads(identities.read_text(encoding="utf-8"))["customers"]
              if c["source"] == "fictitious"}
    rows = sorted(json.loads(data.read_text(encoding="utf-8"))["transactions"], key=lambda t: t["transaction_id"])
    for t in rows:
        if t["customer_id"] not in people:
            raise ValueError(f"{t['transaction_id']}: owner {t['customer_id']} is not a fictitious identity")
        if not AMOUNT.fullmatch(t["amount"]) or not CURRENCY.fullmatch(t["currency"]):
            raise ValueError(f"{t['transaction_id']}: invalid amount or currency")
    owners = sorted({t["customer_id"] for t in rows} | set(people))
    lines = [customer_statement(c, people[c]) for c in owners]
    lines += [transaction_statement(t["transaction_id"], t["customer_id"], t["occurred_at"], None, t["merchant_name"],
                                    t["amount"], t["currency"]) for t in rows]
    return with_header("\n".join(lines) + "\n", "Fictitious demo identities and charges")


def main() -> int:
    SEED.write_text(render_fictitious_seed(), encoding="utf-8")
    print(f"Wrote {SEED.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
