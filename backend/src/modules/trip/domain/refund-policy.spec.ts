import { computeRefund } from './refund-policy';

describe('Refund policy (time-based)', () => {
  const captured = 10000n; // $100.00
  const now = new Date('2026-06-01T12:00:00Z');

  it('refunds 100% when cancelled 10+ days before the event', () => {
    const r = computeRefund(captured, new Date('2026-06-15T20:00:00Z'), now); // 14 days
    expect(r.refundPercent).toBe(100);
    expect(r.tier).toBe('FULL');
    expect(r.refundAmount).toBe(10000n);
    expect(r.penaltyAmount).toBe(0n);
  });

  it('refunds 100% at exactly 10 days', () => {
    const r = computeRefund(captured, new Date('2026-06-11T20:00:00Z'), now);
    expect(r.daysUntilEvent).toBe(10);
    expect(r.refundPercent).toBe(100);
  });

  it('refunds 50% when cancelled 5–9 days before the event', () => {
    const r = computeRefund(captured, new Date('2026-06-08T20:00:00Z'), now); // 7 days
    expect(r.refundPercent).toBe(50);
    expect(r.tier).toBe('PARTIAL');
    expect(r.refundAmount).toBe(5000n);
    expect(r.penaltyAmount).toBe(5000n);
  });

  it('refunds 50% at exactly 5 days', () => {
    const r = computeRefund(captured, new Date('2026-06-06T20:00:00Z'), now);
    expect(r.daysUntilEvent).toBe(5);
    expect(r.refundPercent).toBe(50);
  });

  it('refunds 0% when cancelled less than 5 days before', () => {
    const r = computeRefund(captured, new Date('2026-06-04T20:00:00Z'), now); // 3 days
    expect(r.refundPercent).toBe(0);
    expect(r.tier).toBe('NONE');
    expect(r.refundAmount).toBe(0n);
    expect(r.penaltyAmount).toBe(10000n);
  });

  it('refunds 0% on the day of the event', () => {
    const r = computeRefund(captured, new Date('2026-06-01T23:00:00Z'), now); // same day
    expect(r.daysUntilEvent).toBe(0);
    expect(r.refundPercent).toBe(0);
    expect(r.refundAmount).toBe(0n);
  });

  it('defaults to full refund when the event date is unknown', () => {
    const r = computeRefund(captured, null, now);
    expect(r.refundPercent).toBe(100);
    expect(r.refundAmount).toBe(10000n);
  });

  it('returns zero when nothing was captured', () => {
    const r = computeRefund(0n, new Date('2026-06-20T20:00:00Z'), now);
    expect(r.refundAmount).toBe(0n);
    expect(r.tier).toBe('NONE');
  });
});
