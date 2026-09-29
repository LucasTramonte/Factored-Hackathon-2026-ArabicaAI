"""Per-customer context card for the intake agent, read from Silver.

The card personalizes how the agent speaks (language variant, age band, formality)
and what it already knows (active products, open complaints, last contact, usual
channel). It never carries risk or value signals: every query lists its columns
explicitly and is scoped to one ``customer_id`` with a bound parameter.
"""
import datetime as dt

VARIANTS = {'mexican': 'es-MX', 'colombian': 'es-CO', 'argentine': 'es-AR',
            'México': 'es-MX', 'Colombia': 'es-CO', 'Argentina': 'es-AR'}
OPEN_STATUSES = ('Open', 'In Process', 'Escalated')
ACTIVE_STATUS = 'Active'  # silver.dim_products domain: Active, Closed, Blocked, Suspended


def build_context_card(con, customer_id: str, today: dt.date) -> dict | None:
    """Return the context card for ``customer_id`` or None when the customer is unknown.

    Reads only identity, language and product/case-history columns from ``silver.*``.
    ``today`` is the session date used for the age band and the 90-day channel window.
    """
    row = con.execute(
        'SELECT first_name, date_of_birth, country, detected_accent, segment '
        'FROM silver.dim_customers WHERE customer_id = ?', [customer_id]).fetchone()
    if row is None:
        return None
    first_name, dob, country, accent, segment = row
    variant, source = _language_variant(accent, country)
    return {
        'customer_id': customer_id,
        'first_name': first_name,
        'language_variant': variant,
        'variant_source': source,
        'date_format': 'DD/MM/YYYY',
        'currency': _usual_currency(con, customer_id),
        'age_band': age_band(dob, today),
        'segment': segment,
        'products': _products(con, customer_id),
        'open_complaints': _open_complaints(con, customer_id),
        'last_contact': _last_contact(con, customer_id),
        'usual_channel': _usual_channel(con, customer_id, today),
    }


def style_defaults(card: dict) -> dict:
    """Conversation defaults from the card's age band and language variant only.

    Unknown age band uses the 45-59 profile (accessibility default, never assume
    youth). Segment is deliberately ignored: it is a tone concern for the prompt.
    """
    band = card.get('age_band') or '45-59'
    pt = (card.get('language_variant') or '').startswith('pt')
    formal, informal = ('o senhor/a senhora' if pt else 'usted'), ('você' if pt else 'tú')
    table = {
        '60+': (formal, 'slow', 1, True, 'formal'),
        '45-59': (formal, 'normal', 1, True, 'formal'),
        '30-44': (informal, 'normal', 2, False, 'neutral'),
        '18-29': (informal, 'fast', 2, False, 'casual'),
    }
    address, pace, questions, confirm, register = table[band]
    return {'address': address, 'pace': pace, 'questions_per_turn': questions,
            'confirm_each_step': confirm, 'register': register}


def age_band(dob: dt.date | None, today: dt.date) -> str | None:
    """Age band with exact birthday arithmetic; None when date of birth is missing."""
    if dob is None:
        return None
    age = today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))
    if age >= 60:
        return '60+'
    if age >= 45:
        return '45-59'
    if age >= 30:
        return '30-44'
    return '18-29'


def _language_variant(accent, country):
    if accent in VARIANTS:
        return VARIANTS[accent], 'accent'
    if country in VARIANTS:
        return VARIANTS[country], 'country'
    return 'es-419', 'default'


def _usual_currency(con, customer_id):
    row = con.execute(
        'SELECT currency FROM silver.dim_products WHERE customer_id = ? '
        'GROUP BY currency ORDER BY count(*) DESC, currency LIMIT 1', [customer_id]).fetchone()
    return row[0] if row else None


def _products(con, customer_id):
    rows = con.execute(
        'SELECT product_type, right(product_number, 4) FROM silver.dim_products '
        'WHERE customer_id = ? AND product_status = ? ORDER BY 1, 2',
        [customer_id, ACTIVE_STATUS]).fetchall()
    return [{'product_type': t, 'last4': l} for t, l in rows]


def _open_complaints(con, customer_id):
    rows = con.execute(
        'SELECT subcategory, status, CAST(creation_date AS DATE) FROM silver.fact_complaints '
        'WHERE customer_id = ? AND status IN (?, ?, ?) ORDER BY creation_date DESC',
        [customer_id, *OPEN_STATUSES]).fetchall()
    return [{'subcategory': s, 'status': st, 'created': d.isoformat()} for s, st, d in rows]


def _last_contact(con, customer_id):
    row = con.execute(
        'SELECT contact_reason, reason_category, CAST(interaction_date AS DATE) '
        'FROM silver.fact_call_center_interactions WHERE customer_id = ? '
        'ORDER BY interaction_date DESC LIMIT 1', [customer_id]).fetchone()
    if row is None:
        return None
    return {'reason': row[0], 'category': row[1], 'date': row[2].isoformat()}


def _usual_channel(con, customer_id, today):
    row = con.execute(
        'SELECT channel FROM silver.fact_digital_events WHERE customer_id = ? '
        'AND event_date >= ? AND event_date < ? '
        'GROUP BY channel ORDER BY count(*) DESC, channel LIMIT 1',
        [customer_id, today - dt.timedelta(days=90), today + dt.timedelta(days=1)]).fetchone()
    return row[0] if row else 'web'
