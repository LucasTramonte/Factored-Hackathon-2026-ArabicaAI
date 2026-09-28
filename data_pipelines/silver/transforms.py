"""
Reusable SQL-expression builders for Silver column transforms.

Every function here returns a SQL EXPRESSION STRING (not a full statement), meant to be embedded
in a SELECT list -- silver.py assembles these into `CREATE OR REPLACE TABLE ... AS SELECT`
statements via table_specs.py's declarative column specs. Kept separate so the same building
blocks (null-sentinel coalescing, boolean parsing, country canonicalization) are written once and
reused across every table instead of each table's spec reinventing its own CASE WHEN.

All of this operates on Bronze data, which is VARCHAR by DESIGN -- but the Bronze profile found a
real exception (year columns typed BIGINT from Hive partition inference), so every function here
explicitly CASTs its input to VARCHAR before doing text work, the same defensive fix applied to
profile_bronze.py after that was found. These functions work on a typed source column too; the
cast is just insurance, not an assumption that the input is already VARCHAR.
"""
from __future__ import annotations

if __package__:
    from .config import COUNTRY_CANONICAL, NULL_LIKE_SENTINELS
else:  # direct run_silver.py execution
    from config import COUNTRY_CANONICAL, NULL_LIKE_SENTINELS

_SENTINEL_LIST_SQL = ", ".join(f"'{s}'" for s in sorted(NULL_LIKE_SENTINELS))

# RE2 (DuckDB's regex engine) word-boundary syntax -- verified directly against DuckDB before
# shipping (this project's established practice after being burned by unverified SQL behavior
# assumptions more than once): regexp_matches('¡Oferta especial en nan!', '(?i)\bnan\b') -> True,
# regexp_matches('¡Oferta especial en Nantucket!', '(?i)\bnan\b') -> False.
_NAN_WORD_REGEX = r"(?i)\bnan\b"


def null_like_guard(expr: str) -> str:
    """Wraps any expression so blank strings and known missing-value sentinels ('NaN', 'N/A',
    'unknown', ...) become true NULL before any further casting happens. This must run BEFORE
    TRY_CAST, not after: TRY_CAST('NaN' AS DOUBLE) is a "successful" cast to IEEE NaN in DuckDB,
    and TRY_CAST('Infinity' AS DATE) succeeds too (becomes 9999-12-31) -- both would otherwise
    silently pass through as "clean" data."""
    return (
        f"(CASE WHEN {expr} IS NULL OR trim(CAST({expr} AS VARCHAR)) = '' "
        f"OR lower(trim(CAST({expr} AS VARCHAR))) IN ({_SENTINEL_LIST_SQL}) "
        f"THEN NULL ELSE {expr} END)"
    )


def as_string(source: str) -> str:
    guarded = null_like_guard(source)
    return f"NULLIF(trim(CAST({guarded} AS VARCHAR)), '')"


def as_integer(source: str) -> str:
    return f"TRY_CAST({null_like_guard(source)} AS BIGINT)"


def as_double(source: str) -> str:
    return f"TRY_CAST({null_like_guard(source)} AS DOUBLE)"


def as_date(source: str) -> str:
    return f"TRY_CAST({null_like_guard(source)} AS DATE)"


def as_timestamp(source: str) -> str:
    return f"TRY_CAST({null_like_guard(source)} AS TIMESTAMP)"


def as_time(source: str) -> str:
    return f"TRY_CAST({null_like_guard(source)} AS TIME)"


def as_boolean(source: str) -> str:
    """Source data uses literal 'True'/'False' text (confirmed in the Bronze profile across
    has_atms, was_resolved, is_fraud, and every other has_*/was_*/is_* column). Anything else,
    including a sentinel value already caught by null_like_guard, becomes NULL rather than
    silently False -- an unparseable value is UNKNOWN, not a confirmed negative, and collapsing
    those two loses real information for downstream analysis (e.g. churn/fraud models)."""
    guarded = null_like_guard(source)
    return (
        f"(CASE lower(trim(CAST({guarded} AS VARCHAR))) "
        f"WHEN 'true' THEN TRUE WHEN 'false' THEN FALSE ELSE NULL END)"
    )


def as_country(source: str) -> str:
    """Canonicalizes country spelling via COUNTRY_CANONICAL -- fixes the 'México' (2.1M rows) vs.
    'Mexico' (40,515 rows) split found in transactions.transaction_country and the equivalent
    split in digital_events.ip_country, which every GROUP BY / COUNT DISTINCT currently treats as
    two different countries. Anything not in the map falls through to its trimmed original value
    rather than being dropped -- an unmapped country is a gap in COUNTRY_CANONICAL to fix, not
    data to silently discard."""
    guarded = null_like_guard(source)
    case_lines = "\n            ".join(f"WHEN '{k}' THEN '{v}'" for k, v in COUNTRY_CANONICAL.items())
    return (
        f"(CASE lower(trim(CAST({guarded} AS VARCHAR)))\n"
        f"            {case_lines}\n"
        f"            ELSE trim(CAST({guarded} AS VARCHAR))\n"
        f"        END)"
    )


def strip_templated_nan(source: str) -> str:
    """Nulls out a text field when it contains the literal word 'nan' as a whole word -- fixes the
    campaign_sends.subject bug found in the Bronze profile: an unrendered NULL product name got
    string-formatted into a template upstream ('¡Oferta especial en nan!', 38,142 rows). Uses a
    word-boundary regex (verified against DuckDB directly, see _NAN_WORD_REGEX above) so this
    doesn't misfire on text that merely CONTAINS the substring 'nan' (e.g. a hypothetical branch
    or product name like 'Nantucket')."""
    guarded = null_like_guard(source)
    return (
        f"(CASE WHEN regexp_matches(CAST({guarded} AS VARCHAR), '{_NAN_WORD_REGEX}') "
        f"THEN NULL ELSE {guarded} END)"
    )
