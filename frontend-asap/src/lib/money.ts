import type { Money } from "./types";

const SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
};

/**
 * Format an API money object for display.
 * The API returns integer minor units — NEVER display the raw amount.
 *   formatMoney({ amount: 8500, currency: "USD" }) => "$85.00"
 */
export function formatMoney(money: Money | null | undefined): string {
  if (!money) return "Free";

  const { amount, currency } = money;
  // JPY and other zero-decimal currencies have no minor unit.
  const zeroDecimal = currency === "JPY";
  const major = zeroDecimal ? amount : amount / 100;

  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: zeroDecimal ? 0 : 2,
    maximumFractionDigits: zeroDecimal ? 0 : 2,
  }).format(major);

  const symbol = SYMBOLS[currency] ?? "";
  return symbol ? `${symbol}${formatted}` : `${formatted} ${currency}`;
}

/** Construct a Money object from a major-unit number (e.g. dollars). */
export function money(major: number, currency = "USD"): Money {
  const zeroDecimal = currency === "JPY";
  return {
    amount: Math.round(zeroDecimal ? major : major * 100),
    currency,
  };
}

/** Add two money values of the same currency. */
export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
  return { amount: a.amount + b.amount, currency: a.currency };
}

/** Multiply a money value by an integer quantity. */
export function multiplyMoney(m: Money, qty: number): Money {
  return { amount: m.amount * qty, currency: m.currency };
}