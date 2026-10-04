"""Render back-end/seeds/seed_fictitious.sql from fictitious.json and identities.json.

The fictitious seed uses the same statement builders as the Gold slice, so both get the same
drift guard. A test fails if the committed SQL differs from this output.
Regenerate with ``python -m data_pipelines.gold.fictitious_seed``.
"""
from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

from .intake_slice import AMOUNT, CURRENCY, IDENTITIES, REPO_ROOT, customer_statement, quote, transaction_statement, with_header

DATA = REPO_ROOT / "back-end/seeds/fictitious.json"
SEED = REPO_ROOT / "back-end/seeds/seed_fictitious.sql"


def render_fictitious_seed(data: Path = DATA, identities: Path = IDENTITIES) -> str:
    """Seed SQL for fictitious identities and their charges. Every owner must be marked ``fictitious``. A charge with
    ``"bank_flagged": true`` gets the proactive-alert flag (ADR-011) in an idempotent update after the inserts."""
    people = {c["customer_id"]: c["display_name"] for c in json.loads(identities.read_text(encoding="utf-8"))["customers"]
              if c["source"] == "fictitious"}
    rows = sorted(json.loads(data.read_text(encoding="utf-8"))["transactions"], key=lambda t: t["transaction_id"])
    for t in rows:
        if t["customer_id"] not in people:
            raise ValueError(f"{t['transaction_id']}: owner {t['customer_id']} is not a fictitious identity")
        if not AMOUNT.fullmatch(t["amount"]) or Decimal(t["amount"]) <= 0 or not CURRENCY.fullmatch(t["currency"]):
            raise ValueError(f"{t['transaction_id']}: invalid amount or currency")
        if t.get("bank_flagged", False) not in (True, False):
            raise ValueError(f"{t['transaction_id']}: bank_flagged must be true or false")
    owners = sorted({t["customer_id"] for t in rows} | set(people))
    lines = [customer_statement(c, people[c]) for c in owners]
    lines += [transaction_statement(t["transaction_id"], t["customer_id"], t["occurred_at"], None, t["merchant_name"],
                                    t["amount"], t["currency"]) for t in rows]
    lines += [f"UPDATE transactions SET bank_flagged=1 WHERE transaction_id={quote(t['transaction_id'])} "
              f"AND customer_id={quote(t['customer_id'])};" for t in rows if t.get("bank_flagged")]
    return with_header("\n".join(lines) + "\n", "Fictitious demo identities and charges")


def main() -> int:
    SEED.write_text(render_fictitious_seed(), encoding="utf-8")
    print(f"Wrote {SEED.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
