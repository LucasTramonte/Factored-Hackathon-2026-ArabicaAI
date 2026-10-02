/**
 * Urgency by stated policy (``config/urgency.json``; DF-024: the data has no high-value tail, so nothing is fitted).
 * ``'high'`` when the chosen charge's amount is at least the policy's fixed amount for its currency, or when at least
 * ``relative_min_others`` of the customer's other purchases share its currency and it is above their p95 (nearest
 * rank). Amounts are decimal strings; a currency the policy doesn't name uses the relative rule only. Pure: it only
 * prioritises the handoff, it never blocks a card (ADR-002).
 */
export function urgencyOf(chosen, others, config) {
  const amount = Number(chosen.amount);
  if (amount >= config.fixed[chosen.currency]) return 'high';
  const peers = others.filter(t => t.currency === chosen.currency).map(t => Number(t.amount)).sort((a, b) => a - b);
  if (peers.length < config.relative_min_others) return 'normal';
  return amount > peers[Math.ceil(0.95 * peers.length) - 1] ? 'high' : 'normal';
}
