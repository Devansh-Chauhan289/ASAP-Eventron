import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUES } from '../queue/queues';
import { DomainEventBus } from './domain-event-bus';
import { DomainEventEnvelope } from '../events/domain-event.envelope';
import { CorrelationContext } from '../common/context/correlation.context';

/**
 * Consumes relayed domain events and dispatches them to in-process subscribers
 * (Section 17.6). Subscribers are idempotent (ProcessedEvent dedupe), so BullMQ's
 * at-least-once redelivery is safe.
 */
@Processor(QUEUES.DOMAIN_EVENTS, { concurrency: 8 })
export class DomainEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(DomainEventsProcessor.name);

  constructor(private readonly bus: DomainEventBus) {
    super();
  }

  async process(job: Job<DomainEventEnvelope>): Promise<void> {
    const event = job.data;
    await CorrelationContext.run(
      {
        correlationId: event.correlationId ?? undefined,
        userId: event.userId ?? undefined,
        tripId: event.tripId ?? undefined,
      },
      async () => {
        this.logger.debug(
          `Dispatching ${event.eventType} (${event.eventId})`,
        );
        await this.bus.dispatch(event);
      },
    );
  }
}
