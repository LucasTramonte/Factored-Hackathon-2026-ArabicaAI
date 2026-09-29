import { formatSourceTime } from './source-time.util';

describe('formatSourceTime', () => {
  it('prints the source wall time without applying any timezone', () => {
    expect(formatSourceTime('2026-02-26T13:21:51')).toBe('2026-02-26 13:21:51');
    expect(formatSourceTime('2026-02-26T23:59:59.123')).toBe('2026-02-26 23:59:59');
    expect(formatSourceTime('2026-02-26 00:00:00')).toBe('2026-02-26 00:00:00');
  });

  it('returns anything unexpected unchanged instead of guessing', () => {
    for (const value of ['2026-02-26T13:21:51Z', '2026-02-26T13:21:51+02:00', 'yesterday', '']) {
      expect(formatSourceTime(value)).toBe(value);
    }
  });
});
