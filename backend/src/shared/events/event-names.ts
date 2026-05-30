/**
 * Canonical domain event type names (Section 5.3). context.aggregate.pastTense.
 * Used as the source of truth for OutboxEvent.eventType and consumer routing.
 */
export const EVENTS = {
  // Trip Orchestration
  TRIP_CREATED: 'trip.created',
  TRIP_BASKET_CONFIRMED: 'trip.basket.confirmed',
  TRIP_BOOKING_STARTED: 'trip.booking.started',
  TRIP_CONFIRMED: 'trip.confirmed',
  TRIP_PARTIALLY_BOOKED: 'trip.partially_booked',
  TRIP_COMPENSATION_STARTED: 'trip.compensation.started',
  TRIP_CANCELLED: 'trip.cancelled',
  TRIP_COMPLETED: 'trip.completed',
  TRIP_NEEDS_ATTENTION: 'trip.needs_attention',

  // Event Booking
  BOOKING_EVENT_RESERVATION_REQUESTED: 'booking.event.reservation_requested',
  BOOKING_EVENT_RESERVED: 'booking.event.reserved',
  BOOKING_EVENT_CONFIRMED: 'booking.event.confirmed',
  BOOKING_EVENT_FAILED: 'booking.event.failed',
  BOOKING_EVENT_RELEASED: 'booking.event.released',

  // Payments
  PAYMENT_INTENT_CREATED: 'payment.intent.created',
  PAYMENT_AUTHORIZED: 'payment.authorized',
  PAYMENT_CAPTURED: 'payment.captured',
  PAYMENT_VOIDED: 'payment.voided',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_REFUND_REQUESTED: 'payment.refund.requested',
  PAYMENT_REFUND_SUCCEEDED: 'payment.refund.succeeded',
  PAYMENT_REFUND_FAILED: 'payment.refund.failed',
  PAYMENT_DISPUTED: 'payment.disputed',

  // Notifications
  NOTIFICATION_DISPATCH_REQUESTED: 'notification.dispatch.requested',
  NOTIFICATION_DELIVERED: 'notification.delivered',
  NOTIFICATION_FAILED: 'notification.failed',
} as const;

export type EventType = (typeof EVENTS)[keyof typeof EVENTS];
