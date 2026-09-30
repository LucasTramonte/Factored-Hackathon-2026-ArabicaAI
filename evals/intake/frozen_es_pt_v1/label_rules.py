"""Construction-only policy oracle; no message text or system under test is read."""
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
import unicodedata


def _norm(value):
    return ''.join(c for c in unicodedata.normalize('NFKD', str(value).casefold())
                   if not unicodedata.combining(c)).strip()


def _date_bounds(fact, as_of):
    if not fact:
        return None
    expression = _norm(fact.get('expression', ''))
    day = datetime.fromisoformat(as_of).date()
    if expression in ('hoy', 'hoje', 'today'):
        start = end = day
    elif expression in ('ayer', 'ontem', 'yesterday'):
        start = end = day - timedelta(days=1)
    elif expression in ('el viernes pasado', 'sexta passada'):
        start = end = day - timedelta(days=(day.weekday() - 4) % 7 or 7)
    elif expression in ('la semana pasada', 'semana passada'):
        end = day - timedelta(days=day.weekday() + 1)
        start = end - timedelta(days=6)
    else:
        start = date.fromisoformat(fact['from'])
        end = date.fromisoformat(fact['to'])
    # Resolved dates are assertions, not a second source that can override a phrase.
    if fact.get('from') and date.fromisoformat(fact['from']) != start:
        raise ValueError('date expression/from disagreement')
    if fact.get('to') and date.fromisoformat(fact['to']) != end:
        raise ValueError('date expression/to disagreement')
    if start > end:
        raise ValueError('reversed date interval')
    return start, end


def _currency(value, country):
    aliases = {'dolares': 'USD', 'dollars': 'USD', 'us$': 'USD',
               'pesos': {'Argentina': 'ARS', 'Colombia': 'COP'}.get(country, 'INVALID')}
    return aliases.get(_norm(value), str(value).upper())


def _card_type(value):
    return {'credito': 'Tarjeta Crédito', 'credit': 'Tarjeta Crédito',
            'debito': 'Tarjeta Débito', 'debit': 'Tarjeta Débito'}.get(_norm(value), value)


def _category(value):
    return {'alimentacion': 'Food', 'alimentacao': 'Food', 'comida': 'Food',
            'salud': 'Health', 'saude': 'Health', 'transporte': 'Transport',
            'entretenimiento': 'Entertainment', 'entretenimento': 'Entertainment',
            'servicios': 'Services', 'servicos': 'Services', 'otros': 'Other',
            'outros': 'Other'}.get(_norm(value), value)


def _merchant_matches(query, merchant):
    if merchant is None:
        return False
    query, merchant = _norm(query), _norm(merchant)
    # Explicit obvious short forms, rather than arbitrary substring matching.
    aliases = {'cine': 'cine premium', 'farmacia': 'farmacia salud',
               'mercado': 'mercado central', 'don jose': 'tienda don jose',
               'el buen sabor': 'restaurante el buen sabor',
               'optica': 'optica vision', 'streaming': 'streaming music'}
    return aliases.get(query, query) == merchant


def evaluate(spec, fixture):
    """Apply first-fit policy to normalized facts; return sorted, owned candidates.

    Amount values are canonical decimal strings, dates have ISO resolved bounds,
    and customer/card metadata come from the synthetic fixture. Memory is bounded
    by this tiny fixture (32 purchases); this is not a production data reader.
    """
    def result(action, candidates=()):
        return {'action': action, 'candidate_ids': sorted(candidates),
                'completion_ready': action == 'H'}

    if not spec['authenticated']:
        return result('A')
    intent = spec['intent']
    if spec['tool_failure'] and intent in ('report', 'confirm'):
        return result('T')
    if intent.startswith('out_of_scope:') or intent == 'unsupported_language':
        return result('R')
    if intent not in ('report', 'confirm'):
        raise ValueError('unknown intent')

    customer = next(c for c in fixture['customers'] if c['customer_id'] == spec['customer_id'])
    purchases = [t for t in fixture['transactions'] if t['customer_id'] == spec['customer_id']]
    facts = spec['stated_facts']
    if spec.get('invalid'):
        return result('C')
    try:
        bounds = _date_bounds(facts.get('date'), spec['as_of'])
        amount_fact = facts.get('amount')
        amount = Decimal(amount_fact['value']) if amount_fact else None
        if amount is not None and (not amount.is_finite() or amount <= 0):
            return result('C')
        currency = _currency(facts['currency'], customer['country']) if facts.get('currency') else None
        if currency and currency not in {c['currency'] for c in customer['cards']}:
            return result('C')
        card = facts.get('card') or {}
        card_type = _card_type(card['type']) if card.get('type') else None
        if card and not any((not card_type or c['product_type'] == card_type)
                            and (not card.get('last4') or c['last4'] == card['last4'])
                            for c in customer['cards']):
            return result('C')
    except (ValueError, KeyError, TypeError, InvalidOperation):
        return result('C')

    def matches(t):
        if facts.get('merchant') and not _merchant_matches(facts['merchant'], t['merchant_name']):
            return False
        if facts.get('category') and _norm(_category(facts['category'])) != _norm(t['merchant_category']):
            return False
        if amount is not None:
            tolerance = amount * Decimal('0.10') if amount_fact['approx'] else Decimal('0')
            if abs(Decimal(t['amount']) - amount) > tolerance:
                return False
        if currency and currency != t['currency']:
            return False
        if bounds and not bounds[0] <= datetime.fromisoformat(t['transaction_date']).date() <= bounds[1]:
            return False
        if card_type and card_type != t['product_type']:
            return False
        if card.get('last4') and card['last4'] != t['last4']:
            return False
        if facts.get('country') and facts['country'] != t['transaction_country']:
            return False
        if facts.get('abroad') is not None and facts['abroad'] != (t['transaction_country'] != customer['country']):
            return False
        return True

    confirmed = spec.get('confirmed_id')
    if confirmed:
        return result('H', [confirmed]) if any(t['transaction_id'] == confirmed and matches(t) for t in purchases) else result('C')
    usable = any(facts.get(k) is not None for k in ('merchant', 'category', 'amount', 'currency', 'date', 'country', 'abroad')) or any((facts.get('card') or {}).values())
    if not usable:
        return result('C')
    candidates = [t['transaction_id'] for t in purchases if matches(t)]
    return result('F' if len(candidates) == 1 else 'C', candidates)


def ambiguous_reading(spec):
    """Flag literal today/yesterday readings in the first three hours of a day."""
    fact = spec['stated_facts'].get('date') or {}
    return (datetime.fromisoformat(spec['as_of']).hour < 3
            and _norm(fact.get('expression', '')) in ('hoy', 'hoje', 'today', 'ayer', 'ontem', 'yesterday'))
