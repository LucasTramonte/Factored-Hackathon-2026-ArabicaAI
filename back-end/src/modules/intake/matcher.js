/**
 * The deterministic suggestion rule (ADR-012 decision 2): a port of the written policy the evaluation used
 * (``evals/intake/frozen_es_pt_v1/label_rules.py`` ``evaluate``, applied by ``evals/intake/systems.py``). It turns the
 * model's validated facts into the customer's own purchases that fit every stated fact. Only the reading is learned;
 * this is unit-tested against fixtures the Python generates (``test/unit/ai-parity.test.js``).
 *
 * Python semantics kept on purpose: ``str(None)`` reads as ``'none'`` in names, casefold + NFKD without combining marks,
 * Python whitespace for ``strip``, exact decimals, Monday = 0 weekdays, sorted candidate ids. Known divergences
 * (Decimal's non-ASCII digits and 28-digit context, ``fromisoformat``'s rarer forms) only ever refuse in JS where
 * Python might accept, so they can only drop a suggestion, never add one.
 */

const PY_SPACE = '[\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const STRIP = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, 'gu');
// Python drops every mark with a non-zero combining class; this drops the Latin/Greek ones (U+034F has class 0), so
// a string with other marks can only fail to match in JS where Python would match, never the reverse.
const COMBINING = /[\u0300-\u034e\u0350-\u036f]/gu;
const pyStr = v => v === null || v === undefined ? 'None' : v === true ? 'True' : v === false ? 'False' : String(v);
/** ``str.casefold`` for the letters where it differs from ``toLowerCase`` in Latin and Greek text. */
const casefold = s => s.toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ').replace(/ſ/g, 's');
/** ``label_rules._norm``. */
export const norm = value => casefold(pyStr(value)).normalize('NFKD').replace(COMBINING, '').replace(STRIP, '');

const COUNTRIES = {
  US: ['usa', 'estados unidos', 'estados unidos de america', 'estados unidos da america', 'eeuu', 'ee.uu.', 'ee. uu.', 'eua',
    'united states', 'united states of america'],
  ES: ['espana', 'espanha', 'spain'], BR: ['brasil', 'brazil'], MX: ['mexico'], CO: ['colombia'], AR: ['argentina']
};
const COUNTRY_CODE = new Map(Object.entries(COUNTRIES).flatMap(([code, names]) => names.map(n => [n, code])));
const country = value => COUNTRY_CODE.get(norm(value)) ?? null;

const RELATIVE = ['hoy', 'hoje', 'today', 'ayer', 'ontem', 'yesterday', 'el viernes pasado', 'sexta passada', 'la semana pasada', 'semana passada'];
const PyError = reason => Object.assign(new Error(reason), { python: true });

/** A calendar day as epoch days (UTC), from Python ``date.fromisoformat`` forms ``YYYY-MM-DD`` and ``YYYYMMDD``. */
function isoDate(value) {
  if (typeof value !== 'string') throw PyError('TypeError');
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value);
  if (!m || (value.length === 10) !== value.includes('-') || (value.length === 10 && (value[4] !== '-' || value[7] !== '-'))) throw PyError('ValueError');
  return day(+m[1], +m[2], +m[3]);
}
function day(y, mo, d) {
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (y < 1 || mo < 1 || mo > 12 || back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) throw PyError('ValueError');
  return ms / 86400000;
}
/** The date of Python ``datetime.fromisoformat(value)``: a date, optionally followed by a separator and a time. */
function isoDateTimeDay(value) {
  if (typeof value !== 'string') throw PyError('TypeError');
  if (value.length <= 10) return isoDate(value);
  const time = value.slice(11);
  if (!/^\d{2}(:?\d{2}(:?\d{2}([.,]\d{1,6})?)?)?(Z|[+-]\d{2}:?\d{2}(:?\d{2}(\.\d{1,6})?)?)?$/.test(time)) throw PyError('ValueError');
  return isoDate(value.slice(0, 10));
}
const weekday = epochDay => (new Date(epochDay * 86400000).getUTCDay() + 6) % 7;

/** ``label_rules._date_bounds``: ``[start, end]`` in epoch days, or null when no date fact. */
function dateBounds(fact, asOf) {
  if (!fact || !Object.keys(fact).length) return null;
  const expression = norm(fact.expression ?? '');
  const today = RELATIVE.includes(expression) ? isoDateTimeDay(asOf) : null;
  let start, end;
  if (['hoy', 'hoje', 'today'].includes(expression)) start = end = today;
  else if (['ayer', 'ontem', 'yesterday'].includes(expression)) start = end = today - 1;
  else if (['el viernes pasado', 'sexta passada'].includes(expression)) start = end = today - ((((weekday(today) - 4) % 7) + 7) % 7 || 7);
  else if (['la semana pasada', 'semana passada'].includes(expression)) { end = today - (weekday(today) + 1); start = end - 6; }
  else {
    if (!Object.hasOwn(fact, 'from') || !Object.hasOwn(fact, 'to')) throw PyError('KeyError');
    start = isoDate(fact.from); end = isoDate(fact.to);
  }
  if (fact.from && isoDate(fact.from) !== start) throw PyError('date expression/from disagreement');
  if (fact.to && isoDate(fact.to) !== end) throw PyError('date expression/to disagreement');
  if (start > end) throw PyError('reversed date interval');
  return [start, end];
}

/** Python ``Decimal(str)`` for finite decimals: ``{ n: BigInt, e }`` meaning n * 10^e, or ``'nonfinite'``. */
function decimal(value) {
  if (typeof value !== 'string') throw PyError('TypeError');
  const text = value.replace(STRIP, '');
  if (/^[+-]?(inf|infinity|s?nan\d*)$/i.test(text)) return 'nonfinite';
  const m = /^([+-]?)(\d(?:_?\d)*)?(?:\.(\d(?:_?\d)*)?)?(?:[eE]([+-]?\d(?:_?\d)*))?$/.exec(text);
  if (!m || (m[2] === undefined && m[3] === undefined)) throw PyError('InvalidOperation');
  const whole = (m[2] ?? '').replaceAll('_', ''), frac = (m[3] ?? '').replaceAll('_', '');
  const n = BigInt((m[1] === '-' ? '-' : '') + ((whole + frac) || '0'));
  return { n, e: Number((m[4] ?? '0').replaceAll('_', '')) - frac.length };
}
/** Two decimals at a common exponent. */
function aligned(a, b) {
  const e = Math.min(a.e, b.e);
  return [a.n * 10n ** BigInt(a.e - e), b.n * 10n ** BigInt(b.e - e)];
}
const abs = n => n < 0n ? -n : n;

function currencyOf(value, homeCountry) {
  const pesos = { Argentina: 'ARS', Colombia: 'COP' }[homeCountry] ?? 'INVALID';
  const aliases = { dolares: 'USD', dollars: 'USD', 'us$': 'USD', pesos };
  return aliases[norm(value)] ?? pyStr(value).toUpperCase();
}
const CARD = { credito: 'Tarjeta Crédito', credit: 'Tarjeta Crédito', debito: 'Tarjeta Débito', debit: 'Tarjeta Débito' };
const cardType = value => CARD[norm(value)] ?? value;
const CATEGORY = { alimentacion: 'Food', alimentacao: 'Food', comida: 'Food', salud: 'Health', saude: 'Health', transporte: 'Transport',
  entretenimiento: 'Entertainment', entretenimento: 'Entertainment', servicios: 'Services', servicos: 'Services', otros: 'Other', outros: 'Other' };
const category = value => CATEGORY[norm(value)] ?? value;
const MERCHANT_ALIASES = { cine: 'cine premium', farmacia: 'farmacia salud', mercado: 'mercado central', 'don jose': 'tienda don jose',
  'el buen sabor': 'restaurante el buen sabor', optica: 'optica vision', streaming: 'streaming music' };
function merchantMatches(query, merchant) {
  if (merchant === null || merchant === undefined) return false;
  const q = norm(query);
  return (Object.hasOwn(MERCHANT_ALIASES, q) ? MERCHANT_ALIASES[q] : q) === norm(merchant);
}
const truthy = v => !(v === null || v === undefined || v === false || v === 0 || v === '' || (Array.isArray(v) && !v.length)
  || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length));

/**
 * ``label_rules.evaluate``. ``spec`` is the validated extraction plus ``as_of`` and, for parity with the evaluation,
 * ``authenticated`` (false only), ``tool_failure`` and ``confirmed_id``; the online suggestion passes none of those. ``customer`` is
 * ``{ country, cards: [{ product_type, last4, currency }] }``; ``purchases`` are the customer's own records
 * (``transaction_id, merchant_name, merchant_category, amount, currency, transaction_date, product_type, last4,
 * transaction_country``). Returns ``{ action, candidate_ids }`` (sorted). A malformed purchase throws, as in Python.
 */
export function evaluate(spec, customer, purchases) {
  const result = (action, ids = []) => ({ action, candidate_ids: [...ids].sort() });
  if (spec.authenticated === false) return result('A');
  const intent = spec.intent;
  if (spec.tool_failure && (intent === 'report' || intent === 'confirm')) return result('T');
  if (intent.startsWith('out_of_scope:') || intent === 'unsupported_language') return result('R');
  if (intent !== 'report' && intent !== 'confirm') throw PyError('unknown intent');
  const facts = spec.stated_facts;
  if (truthy(spec.invalid)) return result('C');
  let bounds, amount, amountFact, currency, card, kind;
  try {
    bounds = dateBounds(facts.date, spec.as_of ?? null);
    amountFact = facts.amount;
    amount = truthy(amountFact) ? decimal(amountFact.value) : null;
    if (amount === 'nonfinite' || (amount !== null && amount.n <= 0n)) return result('C');
    currency = truthy(facts.currency) ? currencyOf(facts.currency, customer.country) : null;
    if (truthy(currency) && !customer.cards.some(c => c.currency === currency)) return result('C');
    card = truthy(facts.card) ? facts.card : {};
    kind = truthy(card.type) ? cardType(card.type) : null;
    if (truthy(card) && !customer.cards.some(c => (!truthy(kind) || c.product_type === kind) && (!truthy(card.last4) || c.last4 === card.last4))) return result('C');
  } catch (error) {
    if (error?.python) return result('C');
    throw error;
  }
  const tolerance = amount && amountFact.approx ? amount : null; // 10% of it, compared below without rounding
  function matches(t) {
    if (truthy(facts.merchant) && !merchantMatches(facts.merchant, t.merchant_name)) return false;
    if (truthy(facts.category) && norm(category(facts.category)) !== norm(t.merchant_category)) return false;
    if (amount !== null) {
      const charged = decimal(t.amount);
      if (charged === 'nonfinite') return false;
      const [x, a] = aligned(charged, amount);
      // |x - a| > a * 0.10  <=>  10 * |x - a| > a  (approx); |x - a| > 0 (exact).
      if (tolerance ? 10n * abs(x - a) > a : x !== a) return false;
    }
    if (truthy(currency) && currency !== t.currency) return false;
    if (bounds) {
      const d = isoDateTimeDay(t.transaction_date);
      if (!(bounds[0] <= d && d <= bounds[1])) return false;
    }
    if (truthy(kind) && kind !== t.product_type) return false;
    if (truthy(card.last4) && card.last4 !== t.last4) return false;
    if (truthy(facts.country) && (country(facts.country) === null || country(facts.country) !== country(t.transaction_country))) return false;
    if (facts.abroad !== undefined && facts.abroad !== null) {
      const where = country(t.transaction_country), home = country(customer.country);
      if (where === null || home === null || facts.abroad !== (where !== home)) return false;
    }
    return true;
  }
  const usable = ['merchant', 'category', 'amount', 'currency', 'date', 'country', 'abroad'].some(k => facts[k] !== undefined && facts[k] !== null)
    || Object.values(truthy(facts.card) ? facts.card : {}).some(truthy);
  if (truthy(spec.confirmed_id)) return purchases.some(t => t.transaction_id === spec.confirmed_id && matches(t)) ? result('H', [spec.confirmed_id]) : result('C');
  if (!usable) return result('C');
  const candidates = purchases.filter(matches).map(t => t.transaction_id);
  return result(candidates.length === 1 ? 'F' : 'C', candidates);
}

/** At most this many charges are suggested; more is ``ambiguous`` and suggests nothing (ADR-012 decision 2). */
export const MAX_SUGGESTIONS = 3;

/** Outcome of the policy for a suggestion: ``suggested`` with 1..3 ids, ``ambiguous`` (more than 3) or ``no_match``. */
export function suggest(spec, customer, purchases) {
  const { candidate_ids: ids } = evaluate(spec, customer, purchases);
  if (!ids.length) return { outcome: 'no_match', ids: [] };
  return ids.length > MAX_SUGGESTIONS ? { outcome: 'ambiguous', ids: [] } : { outcome: 'suggested', ids };
}
