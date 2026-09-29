"""Small, snapshot-only customer card for the bounded intake demo load."""

VARIANTS = {'mexican': 'es-MX', 'colombian': 'es-CO', 'argentine': 'es-AR',
            'México': 'es-MX', 'Colombia': 'es-CO', 'Argentina': 'es-AR'}


def build_context_card(con, customer_id: str) -> dict | None:
    """Project one customer's non-sensitive Silver fields at load time, never at login."""
    row = con.execute(
        'SELECT first_name, country, detected_accent FROM silver.dim_customers WHERE customer_id = ?',
        [customer_id]).fetchone()
    if row is None:
        return None
    first_name, country, accent = row
    products = con.execute(
        'SELECT product_type, right(product_number, 4), currency FROM silver.dim_products '
        "WHERE customer_id = ? AND product_status = 'Active' ORDER BY 1, 2, 3",
        [customer_id]).fetchall()
    return {
        'first_name': first_name,
        'locale_hint': VARIANTS.get(accent) or VARIANTS.get(country) or 'es-419',
        'products': [{'product_type': kind, 'last4': last4, 'currency': currency}
                     for kind, last4, currency in products],
    }


def reply_language(session_language: str | None, card: dict) -> str:
    """Use the current session language; the snapshot locale is only a Spanish fallback."""
    if session_language and session_language.lower().startswith('pt'):
        return 'pt-BR'
    if session_language and session_language.lower().startswith('es'):
        return session_language
    return card['locale_hint']
