import { Global, Module } from '@nestjs/common';
import { OutboxRepository } from './outbox.repository';
import { OutboxRelayService } from './outbox-relay.service';
import { DomainEventBus } from './domain-event-bus';
import { DomainEventsProcessor } from './domain-events.processor';
import { ProcessedEventRepository } from '../inbox/processed-event.repository';

/**
 * Shared outbox/event-bus kernel. @Global so every context can inject OutboxRepository
 * (to append events inside its tx), DomainEventBus (to subscribe handlers), and
 * ProcessedEventRepository (to dedupe consumption).
 */
@Global()
@Module({
  providers: [
    OutboxRepository,
    OutboxRelayService,
    DomainEventBus,
    DomainEventsProcessor,
    ProcessedEventRepository,
  ],
  exports: [OutboxRepository, DomainEventBus, ProcessedEventRepository],
})
export class OutboxModule {}
