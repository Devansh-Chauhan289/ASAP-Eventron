/**
 * Money value object — BigInt minor units + ISO-4217 currency code (Foundational Rule 9).
 * NEVER use float for money. All arithmetic is exact integer math.
 * See docs/architecture/08-prisma-postgres.md §8.1.
 */
export class Money {
  private constructor(
    public readonly amount: bigint, // minor units (e.g. cents)
    public readonly currency: string, // ISO-4217, e.g. "USD"
  ) {}

  static of(amount: bigint | number | string, currency: string): Money {
    const cur = currency.toUpperCase();
    if (cur.length !== 3) {
      throw new Error(`Invalid currency code: ${currency}`);
    }
    const minor =
      typeof amount === 'bigint' ? amount : BigInt(Math.trunc(Number(amount)));
    return new Money(minor, cur);
  }

  static zero(currency: string): Money {
    return Money.of(0n, currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(
        `Currency mismatch: ${this.currency} vs ${other.currency}`,
      );
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount + other.amount, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount - other.amount, this.currency);
  }

  isZero(): boolean {
    return this.amount === 0n;
  }

  isPositive(): boolean {
    return this.amount > 0n;
  }

  gte(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount >= other.amount;
  }

  lte(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount <= other.amount;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount === other.amount;
  }

  /** Serializable representation for API responses (frontend formats display). */
  toJSON(): { amount: string; currency: string } {
    return { amount: this.amount.toString(), currency: this.currency };
  }

  /** API contract shape: amount as number of minor units (safe within Number range for typical totals). */
  toApi(): { amount: number; currency: string } {
    return { amount: Number(this.amount), currency: this.currency };
  }
}
