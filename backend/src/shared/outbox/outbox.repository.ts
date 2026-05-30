import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Tx } from '../prisma/prisma.tx';
import { DomainEventEnvelope } from '../events/domain-event.envelope';

/**
 * Writes domain events into platform.OutboxEvent INSIDE the caller's transaction
 * (Foundational Rule 4) — "state change + event publish" is atomic. The relay
 * publishes them afterwards. This is the only correct way to avoid the dual-write hazard.
 */
@Injectable()
export class OutboxRepository {
  async append(tx: Tx, events: DomainEventEnvelope[]): Promise<void> {
    if (events.length === 0) return;
    await tx.outboxEvent.createMany({
      data: events.map((e) => ({
        eventId: e.eventId,
        eventType: e.eventType,
        eventVersion: e.eventVersion,
        aggregateType: e.aggregateType,
        aggregateId: e.aggregateId,
        correlationId: e.correlationId,
        causationId: e.causationId,
        tripId: e.tripId,
        userId: e.userId,
        payload: e.payload as Prisma.InputJsonValue,
        occurredAt: e.occurredAt,
        status: 'PENDING',
      })),
    });
  }
}
