# Follow-up: `affected_product_id` owner mismatch -- resolved

Ran `12b_followup_complaints_product_owner.ipynb`. This settles it: **`affected_product_id` (and `digital_events.product_id`) are populated with a product drawn essentially at random from the full `products` table, independent of the actual customer -- not tied to a real ownership relationship at all.** Here's the evidence, point by point.

## 1. Not complaints-specific -- `digital_events` has almost the exact same problem

| Table | Linked rows | Owner matches | Owner mismatches | Mismatch rate |
|---|---|---|---|---|
| `transactions` | 4,425,008 | 4,425,008 | 0 | **0%** |
| `digital_events` | 1,094,242 | 16 | 1,094,226 | **99.9985%** |
| `complaints` | 44,570 | 0 | 44,570 | **100%** |

`transactions.product_id` is perfectly clean -- makes sense, you transact on your own account. `digital_events.product_id` and `complaints.affected_product_id` are both essentially 100% "wrong," and `digital_events`' 16 accidental matches (16/1,094,242 = 0.0015%) is exactly what you'd expect from pure chance in a random draw against ~400,000 products, not real linkage. **This is a shared pattern across two tables, not a `complaints`-only bug.**

## 2. Even when the complainant owns products, `affected_product_id` never picks one of theirs

41,625 complaints have a `customer_id` who genuinely owns products in `bronze.products`. Of those, **zero** ever have `affected_product_id` land on one of that customer's own products. If the field were "roughly right but sometimes grabs the wrong one of several," you'd expect some hits here just by chance. Getting exactly zero out of 41,625 rules that out.

## 3. It's not even temporally plausible -- 18.7% of the referenced products didn't exist yet

8,351 of the 44,570 "wrong-owner" products (18.7%) have an `opening_date` **after** the complaint's `creation_date` -- meaning the complaint references a product that hadn't been opened yet at the time it was filed. That's impossible in any real business process and is strong evidence `affected_product_id` was assigned with no logical constraint at all, not even "an existing account, just not this customer's."

## 4. The distribution confirms uniform random sampling from the whole `products` table

- No repetition problem: 44,570 complaints reference 42,184 distinct products (ratio 1.06) -- not a stuck default value.
- `product_type` among the "affected" products matches the full `products` population's proportions almost exactly (e.g. Cuenta Ahorro: 30.3% of affected products vs. 30.0% of all products; Tarjeta Crédito 24.8% vs. 25.0%; every other type within a point). That's the signature of a uniform random draw across the entire table, not a targeted or structured error.
- The 15-row sample shows no pattern either -- different segments, different branches, no visible relationship between complainant and actual owner.

## What this means

This isn't a bug introduced anywhere in this project's Bronze-to-Silver pipeline -- the FK still resolves cleanly (every `affected_product_id`/`product_id` is a real, valid product), it's just not the complaining/browsing customer's own product. That points to how the source data itself was generated upstream (a random product reference rather than a real per-customer one), not something `table_specs.py`'s transform logic did or could fix. `checks.py`'s `product_owner_mismatch` check is doing exactly its job -- it's a real, currently-100%-failing signal about the underlying data, correctly surfaced as a "warning" rather than silently ignored.

**Two decisions worth having, now that the mechanism is understood rather than a mystery:**
1. Whether `product_owner_mismatch`'s severity should stay `"warning"` forever, or whether a threshold (e.g. escalate to `"error"` above some mismatch rate) makes sense given it's now confirmed to be a real, persistent, ~100% condition on two tables rather than noise.
2. Whether `digital_events.product_id` deserves the same flagging `complaints.affected_product_id` already gets, since `relationship_checks()` already runs `product_owner_mismatch` against it too -- this was already running and already at 99.9985%, it just hadn't come up in the `digital_events` deep dive itself (that table's FK section only checked orphan resolution, not ownership).

No code-contract fix follows from this on its own (it's not a `contracts.py` gap -- the FK/domain framework doesn't model "ownership consistency," `checks.py`'s separate `relationship_checks()` does). This is a data-provenance finding to flag to whoever owns the source data generation, and a judgment call on the two points above.
