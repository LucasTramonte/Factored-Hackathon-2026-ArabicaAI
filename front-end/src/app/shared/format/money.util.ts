import type { Lang } from '../i18n/lang.service';

/**
 * The number conventions of each interface language. Spanish uses Argentina's (``ARS 120.443,55``), which Colombia, the
 * dataset's other peso country, shares; ``es-419`` would switch to Mexico's ``120,443.55``.
 */
export const MONEY_LOCALE: Record<Lang, string> = { es: 'es-AR', pt: 'pt-BR', en: 'en-US' };
const AMOUNT = /^\d{1,15}(\.\d{1,2})?$/;

/**
 * A stored amount (the source's decimal string) in the interface language, with its ISO code, never a symbol: ``$``
 * would be ambiguous between pesos and dollars. Two decimals always. Anything unexpected (a malformed amount or an
 * unknown currency code) is shown as stored instead of guessed.
 */
export function formatMoney(amount: string, currency: string, lang: Lang): string {
  if (!AMOUNT.test(amount)) return `${amount} ${currency}`;
  try {
    return new Intl.NumberFormat(MONEY_LOCALE[lang], { style: 'currency', currency, currencyDisplay: 'code',
      minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(amount));
  } catch {
    return `${amount} ${currency}`;
  }
}
