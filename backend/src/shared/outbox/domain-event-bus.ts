import { Injectable, Logger } from '@nestjs/common';
import { DomainEventEnvelope } from '../events/domain-event.envelope';

export type DomainEventHandler = (
  event: DomainEventEnvelope,
) => Promise<void>;

/**
 * In-process subscriber registry. Context modules register handlers for event types at
 * bootstrap; the DomainEventsProcessor dispatches relayed events to them. On microservice
 * extraction this registry is replaced by a broker subscription — handlers are unchanged
 * (Section 5.4 / 17.7).
 */
@Injectable()
export class DomainEventBus {
  private readonly logger = new Logger(DomainEventBus.name);
  private readonly handlers = new Map<string, DomainEventHandler[]>();

  subscribe(eventType: string, handler: DomainEventHandler): void {
    const list = this.handlers.get(eventType) ?? [];
    list.push(handler);
    this.handlers.set(eventType, list);
  }

  async dispatch(event: DomainEventEnvelope): Promise<void> {
    const list = this.handlers.get(event.eventType);
    if (!list || list.length === 0) return;
    // Handlers are independently idempotent (ProcessedEvent dedupe); run sequentially
    // so one failing handler surfaces and the job is retried (at-least-once).
    for (const handler of list) {
      await handler(event);
    }
  }
}
