/**
 * Time-based cancellation/refund policy (Section 4.5 — computed against a snapshot).
 *
 *   ≥ 10 days before the event   → 100% refund (FULL)
 *   ≥ 5 and < 10 days before     →  50% refund (PARTIAL)
 *   < 5 days / on the event day   →   0% refund (NONE) — ticket cancelled, no money back
 *
 * Days are counted as whole calendar days between "today" and the event day, so a
 * cancellation on the day of the event yields 0 days → 0%.
 */
export type RefundTier = 'FULL' | 'PARTIAL' | 'NONE';

export interface RefundComputation {
  tier: RefundTier;
  refundPercent: number; // 0 | 50 | 100
  daysUntilEvent: number | null; // null when the event date is unknown
  refundAmount: bigint; // minor units
  penaltyAmount: bigint; // minor units kept (captured - refund)
  reason: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The published policy bands — also surfaced to the UI for the cancellation timeline. */
export const REFUND_POLICY_BANDS = [
  { minDaysBefore: 10, refundPercent: 100, label: '10+ days before the event' },
  { minDaysBefore: 5, refundPercent: 50, label: '5–9 days before the event' },
  { minDaysBefore: 0, refundPercent: 0, label: 'Less than 5 days / day of event' },
] as const;

function startOfUtcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function computeRefund(
  capturedMinor: bigint,
  eventStartsAt: Date | null,
  now: Date,
): RefundComputation {
  if (capturedMinor <= 0n) {
    return {
      tier: 'NONE',
      refundPercent: 0,
      daysUntilEvent: null,
      refundAmount: 0n,
      penaltyAmount: 0n,
      reason: 'Nothing was captured for this trip',
    };
  }

  if (!eventStartsAt) {
    // Unknown event date — default to a full refund (most customer-favourable, safe).
    return {
      tier: 'FULL',
      refundPercent: 100,
      daysUntilEvent: null,
      refundAmount: capturedMinor,
      penaltyAmount: 0n,
      reason: 'Event date unknown — full refund applied',
    };
  }

  const days = Math.floor(
    (startOfUtcDay(eventStartsAt) - startOfUtcDay(now)) / DAY_MS,
  );

  let percent: number;
  let tier: RefundTier;
  if (days >= 10) {
    percent = 100;
    tier = 'FULL';
  } else if (days >= 5) {
    percent = 50;
    tier = 'PARTIAL';
  } else {
    percent = 0;
    tier = 'NONE';
  }

  // Integer math on minor units; penalty absorbs any rounding remainder.
  const refundAmount = (capturedMinor * BigInt(percent)) / 100n;
  const penaltyAmount = capturedMinor - refundAmount;

  return {
    tier,
    refundPercent: percent,
    daysUntilEvent: days,
    refundAmount,
    penaltyAmount,
    reason:
      percent === 100
        ? 'Cancelled 10+ days before the event — full refund'
        : percent === 50
          ? 'Cancelled 5–9 days before the event — 50% refund'
          : 'Cancelled less than 5 days before the event — non-refundable',
  };
}
