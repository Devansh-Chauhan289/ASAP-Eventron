import { assertTripTransition, isTripTerminal } from './trip-status.machine';
import { IllegalStateTransitionError } from '@shared/common/errors/domain-error';

describe('Trip state machine (Section 4.1)', () => {
  it('allows the Phase-1 happy path', () => {
    expect(() => assertTripTransition('PLANNING', 'PENDING_PAYMENT')).not.toThrow();
    expect(() => assertTripTransition('PENDING_PAYMENT', 'BOOKING')).not.toThrow();
    expect(() => assertTripTransition('BOOKING', 'CONFIRMED')).not.toThrow();
  });

  it('allows the compensation (sad) path', () => {
    expect(() => assertTripTransition('BOOKING', 'COMPENSATING')).not.toThrow();
    expect(() => assertTripTransition('COMPENSATING', 'CANCELLED')).not.toThrow();
  });

  it('rejects illegal transitions', () => {
    expect(() => assertTripTransition('CONFIRMED', 'BOOKING')).toThrow(
      IllegalStateTransitionError,
    );
    expect(() => assertTripTransition('CANCELLED', 'CONFIRMED')).toThrow();
    expect(() => assertTripTransition('PLANNING', 'CONFIRMED')).toThrow();
  });

  it('treats same-state as a no-op', () => {
    expect(() => assertTripTransition('BOOKING', 'BOOKING')).not.toThrow();
  });

  it('identifies terminal states', () => {
    expect(isTripTerminal('CANCELLED')).toBe(true);
    expect(isTripTerminal('COMPLETED')).toBe(true);
    expect(isTripTerminal('PAYMENT_FAILED')).toBe(true);
    expect(isTripTerminal('BOOKING')).toBe(false);
  });
});
