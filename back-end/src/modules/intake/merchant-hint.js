/**
 * Merchant matching for bounded transaction discovery (issue #141). A model-extracted ``merchant_hint`` becomes three
 * deterministic alternatives that the owner-scoped D1 lookup ORs together:
 *  - ``literal``: the whole hint as a case-insensitive substring (the original behaviour, kept for any merchant name);
 *  - ``words``: every non-generic word of the hint as a substring, in any order ("music streaming" finds "Streaming Music");
 *  - ``names``: the vocabulary merchants for which every non-generic word is a concept in ``merchant-concepts.json``
 *    ("music streaming subscription" finds "Streaming Music"; "restaurant" finds only "Restaurante El Buen Sabor").
 * Generic words ("subscription", "charge", "de") never select anything, so a hint made only of them adds no alternative.
 * Values are bound as parameters; nothing here widens the lookup beyond the session customer's rows.
 * ``evals/support_assist/discovery_score.py`` applies the same rule to score candidates; both are tested on
 * ``test/fixtures/merchant-hints.json``.
 */
import CONCEPTS from '../../config/merchant-concepts.json' with { type: 'json' };
import { norm } from './matcher.js';

const GENERIC = new Set(CONCEPTS.generic);
const MERCHANTS = Object.entries(CONCEPTS.merchants).map(([name, words]) => [name, new Set(words)]);
const MAX_WORDS = 8;
const split = text => text.split(/[^\p{L}\p{N}]+/u).filter(w => [...w].length > 1);

/** ``{ literal, words, names }`` for one hint: lowercase substrings and exact stored merchant names, all bounded. */
export function merchantMatch(hint) {
  const literal = hint.toLowerCase();
  const words = [...new Set(split(literal).filter(w => !GENERIC.has(norm(w))))];
  const concepts = [...new Set(split(norm(hint)).filter(w => !GENERIC.has(w)))];
  const names = concepts.length ? MERCHANTS.filter(([, known]) => concepts.every(w => known.has(w))).map(([name]) => name) : [];
  return { literal, words: words.length > 1 && words.length <= MAX_WORDS ? words : [], names };
}
