import { Money } from '../money/money.vo';

/**
 * Cross-context Event Booking port (Section 17.7). Consumed by the Trip saga; implemented by
 * the Event Booking context's facade. Logical-ID references only (Rule 8).
 */
export const EVENT_BOOKING_PORT = Symbol('EVENT_BOOKING_PORT');

export interface CreatePendingEventBookingInput {
  tripId: string;
  tripLegId: string;
  userId: string;
  externalEventId: string;
  quantity: number;
  tier: string;
  idempotencyKey: string;
}

export interface CreatePendingEventBookingResult {
  bookingId: string;
  price: Money;
}

export interface ReserveResult {
  ok: boolean;
  providerRef?: string;
  price?: Money;
  rejectionReason?: string; // terminal (e.g. SOLD_OUT) when ok=false
}

export interface EventBookingPort {
  createPending(
    input: CreatePendingEventBookingInput,
  ): Promise<CreatePendingEventBookingResult>;
  reserve(input: {
    bookingId: string;
    idempotencyKey: string;
  }): Promise<ReserveResult>;
  confirm(input: {
    bookingId: string;
    idempotencyKey: string;
  }): Promise<{ ok: boolean; providerRef: string }>;
  release(input: { bookingId: string; idempotencyKey: string }): Promise<void>;
}
