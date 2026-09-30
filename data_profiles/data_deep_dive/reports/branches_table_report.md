# `branches` deep dive -- Bronze vs. Silver

Findings from `03_deep_dive_branches.ipynb`, run against the real production DuckDB (`bronze.branches` / `silver.dim_branches`, 350 rows -- matches the data dictionary exactly).

## Headline finding -- confirmed, and bigger than it first looked

**167/350 branches (47.7%) have both `latitude` AND `longitude` clustered near zero (roughly -0.1 to +0.1 for both), not just longitude.** The follow-up run ruled out my first hypothesis -- it's not one shared sentinel value (`exact_sentinel_matches` was just 1; the `0.099995` that appeared identical across all three countries' `max_lon` was coincidental rounding at 2 decimals, not a real match). What it found instead is worse: for these same 167 rows, `latitude` is *also* a tiny decimal near 0 (range: -0.099144 to 0.099491) -- it just didn't trip section 11's "out of box" filter because that check's latitude range (-56 to 34) is wide enough to technically include values near the equator. Real Latin American branch coordinates should never be this close to (0, 0) -- that point sits in the Gulf of Guinea, off the coast of Africa, nowhere near México, Colombia, or Argentina.

**Confirmed as a genuine source-data defect, not a Silver bug.** The Bronze-vs-Silver comparison shows the bad values are already exactly this small in the raw text (e.g. `0.0704497` in Bronze, cast cleanly to `0.070450` in Silver) -- `TRY_CAST(... AS DOUBLE)` is doing its job correctly; the number was already wrong before Silver touched it.

**Practical read**: for essentially half the branch network, `latitude`/`longitude` do not point at the real branch location. Any map, geospatial join, or "nearest branch" feature built on this table needs to either filter these 167 rows out or flag them, until this is fixed upstream. The full list of affected `branch_id`s is in the notebook's section 11.5 (second cell) for whoever needs to trace this back to the source generator.

## Other real findings

1. **`geographic_zone` has zero variation: 100% of branches are `"Urbana"`.** Two things worth separating: (a) the dictionary's declared domain is `(Urban, Suburban, Rural)` in English -- the real value is Spanish (`Urbana`), so a domain check using the dictionary's literal values would flag every single row; (b) beyond the language mismatch, there is no diversity at all -- not one `Suburban`/`Rural`/`Rural` equivalent anywhere in 350 rows. For a synthetic dataset that's supposed to model variety, a column that never varies is a strong signal the generator collapsed to a constant for this field.

2. **`has_atms` and `has_teller_windows` are both `True` for all 350 branches -- also zero variation.** Same class of issue as `geographic_zone`: three separate columns in this one table produce a single constant value across the entire dimension, with `atm_count`/`teller_window_count` always positive (2-8 and 3-12 respectively) whenever the flag is checked. Internally consistent (no flag/count disagreement), but worth knowing this table currently can't support any "which branches lack an ATM" analysis, because the data never says any branch lacks one.

3. **`branch_status` never shows the dictionary's third declared value, `Closed`** (only `Active`, 336, and `Temporarily Closed`, 14) -- plausible for a dataset that only runs a few years (no branch has been permanently shut yet), but worth knowing it's untested if you build logic branching on `Closed` specifically.

## Confirmed correct (no action)

- Column inventory, row count (350, matches the dictionary exactly), dedup: all clean.
- NOT NULL audit: all 16 declared columns, zero NULLs.
- **`branch_code`**: confirmed genuinely unique -- 350 distinct values, 0 NULLs, 0 collisions. Not yet declared in `contracts.py`'s `unique_fields` (unlike `document_number`/`product_number`, added earlier) -- **Contract change applied**: `branch_code` is now in `unique_fields`.
- `branch_type`: matches the dictionary's 4 declared values exactly, plausible distribution.
- Country canonicalization: full coverage. State/country pairs: all plausible, same state sets as `customers`.
- `postal_code`: 80.0% numeric-parseable -- consistent with `customers`' 80.09%, no new concern.
- `phone`/`email`: 0 nulls, 0 structurally malformed values -- fully populated, unlike the contact fields in `customers`.
- `opening_time`/`closing_time`: correct `TIME` casts, no branch closes before/at its own opening time, plausible banking hours (08:00-09:30 open, 17:00-20:00 close).
- `branch_opening_date`: 100% of branches opened before the dataset's June 2023 window (earliest 1990-01-03, latest 2023-05-11) -- the cleanest confirmation yet of the `customers`/`products` conclusion that the dictionary's stated window describes transactional data, not entity lifecycle dates. No future-dated openings.

## Status

The `branch_code` uniqueness check is applied in `contracts.py`. The longitude follow-up is recorded above.
