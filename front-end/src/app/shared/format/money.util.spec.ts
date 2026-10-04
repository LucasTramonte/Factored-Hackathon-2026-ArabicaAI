import { formatMoney } from './money.util';

const plain = (s: string) => s.replace(/\s/g, ' '); // Intl separates the code with a no-break space

describe('formatMoney', () => {
  it('formats a stored amount in the conventions of the interface language, with the ISO code', () => {
    expect(plain(formatMoney('120443.55', 'ARS', 'es'))).toBe('ARS 120.443,55');
    expect(plain(formatMoney('120443.55', 'ARS', 'pt'))).toBe('ARS 120.443,55');
    expect(plain(formatMoney('120443.55', 'ARS', 'en'))).toBe('ARS 120,443.55');
    expect(plain(formatMoney('47.3', 'COP', 'es'))).toBe('COP 47,30');
    expect(plain(formatMoney('20', 'USD', 'en'))).toBe('USD 20.00');
  });

  it('shows anything unexpected as stored instead of guessing', () => {
    for (const [amount, currency] of [['1e5', 'USD'], ['-3.00', 'USD'], ['12.345', 'ARS'], ['', 'ARS'], ['10.00', 'XX'], ['10.00', '']]) {
      expect(formatMoney(amount, currency, 'es')).toBe(`${amount} ${currency}`);
    }
  });
});
