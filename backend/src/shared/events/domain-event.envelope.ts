import { randomUUID } from 'crypto';

/**
 * Canonical domain-event envelope (Section 5.1). Written to platform.OutboxEvent inside
 * the same DB transaction as the state change, then relayed to BullMQ (at-least-once).
 */
export interface DomainEventEnvelope<P = Record<string, unknown>> {
  eventId: string; // unique; consumers dedupe on this
  eventType: string; // context.aggregate.pastTense e.g. "payment.authorized"
  eventVersion: number;
  occurredAt: Date;
  aggregateType: string;
  aggregateId: string;
  correlationId: string | null; // ties one user journey together
  causationId: string | null; // the event/command that caused this
  tripId: string | null;
  userId: string | null;
  payload: P;
}

export interface NewEventInput<P> {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: P;
  correlationId?: string | null;
  causationId?: string | null;
  tripId?: string | null;
  userId?: string | null;
  eventVersion?: number;
  occurredAt?: Date;
}

export function makeEvent<P>(input: NewEventInput<P>): DomainEventEnvelope<P> {
  return {
    eventId: randomUUID(),
    eventType: input.eventType,
    eventVersion: input.eventVersion ?? 1,
    occurredAt: input.occurredAt ?? new Date(),
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    tripId: input.tripId ?? null,
    userId: input.userId ?? null,
    payload: input.payload,
  };
}
