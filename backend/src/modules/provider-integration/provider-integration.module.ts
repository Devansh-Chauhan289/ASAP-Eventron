import { Global, Module } from '@nestjs/common';
import { TicketmasterAdapter } from './infrastructure/ticketmaster.adapter';
import { CircuitBreaker } from './infrastructure/circuit-breaker';
import { ProviderRequestRepository } from './infrastructure/provider-request.repository';
import { EVENT_PROVIDER_PORT } from './domain/event-provider.port';

/**
 * Provider Integration (generic ACL). @Global so booking + discovery contexts can inject the
 * EVENT_PROVIDER_PORT without re-wiring. Binds the port to Ticketmaster for Phase 1; adding
 * Eventbrite/Amadeus/etc. is a new adapter behind the same token (Section 12).
 */
@Global()
@Module({
  providers: [
    CircuitBreaker,
    ProviderRequestRepository,
    TicketmasterAdapter,
    { provide: EVENT_PROVIDER_PORT, useExisting: TicketmasterAdapter },
  ],
  exports: [EVENT_PROVIDER_PORT, CircuitBreaker],
})
export class ProviderIntegrationModule {}
