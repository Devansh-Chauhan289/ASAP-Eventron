import { Money } from './money.vo';

describe('Money (value object)', () => {
  it('stores minor units exactly as BigInt (no float)', () => {
    const m = Money.of(12999n, 'USD');
    expect(m.amount).toBe(12999n);
    expect(m.currency).toBe('USD');
    expect(m.toApi()).toEqual({ amount: 12999, currency: 'USD' });
  });

  it('uppercases and validates the currency code', () => {
    expect(Money.of(100n, 'usd').currency).toBe('USD');
    expect(() => Money.of(100n, 'US')).toThrow(/Invalid currency/);
  });

  it('adds and subtracts within the same currency', () => {
    const a = Money.of(1000n, 'USD');
    const b = Money.of(250n, 'USD');
    expect(a.add(b).amount).toBe(1250n);
    expect(a.subtract(b).amount).toBe(750n);
  });

  it('rejects cross-currency arithmetic', () => {
    expect(() => Money.of(100n, 'USD').add(Money.of(100n, 'EUR'))).toThrow(
      /Currency mismatch/,
    );
  });

  it('compares correctly', () => {
    expect(Money.of(100n, 'USD').gte(Money.of(100n, 'USD'))).toBe(true);
    expect(Money.of(99n, 'USD').lte(Money.of(100n, 'USD'))).toBe(true);
    expect(Money.zero('USD').isZero()).toBe(true);
  });
});
