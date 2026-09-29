"""Small, snapshot-only customer card for the bounded intake demo load."""
import re

CARD_VERSION = 1  # must match CHECK (card_version = ...) in back-end/migrations/0003_context_cards.sql
LANGUAGE_TAG = re.compile(r'(es|pt)(-[a-z0-9]+)*')

VARIANTS = {'mexican': 'es-MX', 'colombian': 'es-CO', 'argentine': 'es-AR',
            'México': 'es-MX', 'Colombia': 'es-CO', 'Argentina': 'es-AR'}


def build_context_card(con, customer_id: str) -> dict | None:
    """Project one customer's non-sensitive Silver fields at load time, never at login.

    ``last4`` is ``None`` when the product number has fewer than four characters, so a short
    number is never shown whole.
    """
    row = con.execute(
        'SELECT first_name, country, detected_accent FROM silver.dim_customers WHERE customer_id = ?',
        [customer_id]).fetchone()
    if row is None:
        return None
    first_name, country, accent = row
    products = con.execute(
        'SELECT product_type, CASE WHEN length(product_number) >= 4 THEN right(product_number, 4) END, currency '
        'FROM silver.dim_products '
        "WHERE customer_id = ? AND product_status = 'Active' ORDER BY 1, 2, 3",
        [customer_id]).fetchall()
    return {
        'first_name': first_name,
        'locale_hint': VARIANTS.get(accent) or VARIANTS.get(country) or 'es-419',
        'products': [{'product_type': kind, 'last4': last4, 'currency': currency}
                     for kind, last4, currency in products],
    }


def reply_language(session_language: str | None, card: dict) -> str:
    """Use a well-formed session language tag; the snapshot locale is only the fallback.

    Tags are matched case-insensitively with ``_`` read as ``-``. Portuguese always maps to
    ``pt-BR``; a Spanish tag is returned with the language lowercased and a region uppercased.
    """
    tag = (session_language or '').replace('_', '-').lower()
    match = LANGUAGE_TAG.fullmatch(tag)
    if not match:
        return card['locale_hint']
    if match.group(1) == 'pt':
        return 'pt-BR'
    return '-'.join(part.upper() if i and part.isalpha() and len(part) == 2 else part
                    for i, part in enumerate(tag.split('-')))
