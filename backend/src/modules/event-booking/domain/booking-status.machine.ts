import { BookingStatus } from '@prisma/client';
import { IllegalStateTransitionError } from '@shared/common/errors/domain-error';

/**
 * Booking state machine (Section 4.2), shared shape for Event/Transport/Stay. CONFIRMED
 * requires a providerRef (INV-B1, enforced by the service). Terminal: RELEASED, CANCELLED,
 * EXPIRED, REJECTED, FAILED, FULFILLED.
 */
const ALLOWED: Record<BookingStatus, BookingStatus[]> = {
  PENDING: ['RESERVED', 'RETRYING', 'REJECTED', 'FAILED'],
  RESERVED: ['CONFIRMED', 'RELEASING', 'EXPIRED', 'CANCELLING'],
  RETRYING: ['RESERVED', 'FAILED'],
  CONFIRMED: ['CANCELLING', 'FULFILLED'],
  RELEASING: ['RELEASED'],
  CANCELLING: ['CANCELLED'],
  RELEASED: [],
  CANCELLED: [],
  EXPIRED: [],
  REJECTED: [],
  FAILED: [],
  FULFILLED: [],
};

export function assertBookingTransition(
  from: BookingStatus,
  to: BookingStatus,
): void {
  if (from === to) return;
  if (!ALLOWED[from].includes(to)) {
    throw new IllegalStateTransitionError('Booking', from, to);
  }
}
