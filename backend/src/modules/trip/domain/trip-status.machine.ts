import { TripStatus } from '@prisma/client';
import { IllegalStateTransitionError } from '@shared/common/errors/domain-error';

/**
 * Trip state machine (Section 4.1). PARTIALLY_BOOKED is first-class (anchor ok, secondary
 * leg failed+refunded). Losing the anchor collapses the trip -> COMPENSATING -> CANCELLED with
 * the authorization VOIDED (zero money moved). Transitions enforced in the domain layer.
 */
const ALLOWED: Record<TripStatus, TripStatus[]> = {
  DRAFT: ['PLANNING'],
  PLANNING: ['PENDING_PAYMENT', 'CANCELLED'],
  PENDING_PAYMENT: ['BOOKING', 'PAYMENT_FAILED', 'CANCELLED'],
  PAYMENT_FAILED: ['PENDING_PAYMENT', 'CANCELLED'],
  BOOKING: ['CONFIRMED', 'PARTIALLY_BOOKED', 'COMPENSATING', 'NEEDS_ATTENTION'],
  PARTIALLY_BOOKED: ['CONFIRMED', 'COMPENSATING', 'NEEDS_ATTENTION'],
  COMPENSATING: ['CANCELLED', 'NEEDS_ATTENTION'],
  CONFIRMED: ['CANCELLATION_REQUESTED', 'COMPLETED'],
  CANCELLATION_REQUESTED: ['CANCELLED', 'NEEDS_ATTENTION'],
  CANCELLED: [],
  COMPLETED: [],
  NEEDS_ATTENTION: ['BOOKING', 'COMPENSATING', 'CANCELLED'],
};

export function assertTripTransition(from: TripStatus, to: TripStatus): void {
  if (from === to) return;
  if (!ALLOWED[from].includes(to)) {
    throw new IllegalStateTransitionError('Trip', from, to);
  }
}

export function isTripTerminal(status: TripStatus): boolean {
  return ['CANCELLED', 'COMPLETED', 'PAYMENT_FAILED'].includes(status);
}
