import { Inject, Injectable } from '@nestjs/common';
import {
  EVENT_PROVIDER_PORT,
  EventProviderPort,
  NormalizedEvent,
} from '@modules/provider-integration/domain/event-provider.port';

/**
 * Discovery (supporting, read-only). Proxies the provider ACL for event search/detail and
 * builds anchor-driven recommendations. Availability-tolerant: it must never block or mutate
 * bookings (Section 1.5). Phase-1 returns transport/stay placeholders; Phase 2 wires real
 * Amadeus/Booking.com offers (Section 18.4). Redis caching is added in Phase 1.5/§10.
 */
@Injectable()
export class DiscoveryService {
  constructor(
    @Inject(EVENT_PROVIDER_PORT)
    private readonly provider: EventProviderPort,
  ) {}

  search(query: {
    q?: string;
    city?: string;
    from?: string;
    to?: string;
    limit: number;
  }): Promise<NormalizedEvent[]> {
    return this.provider.search(query);
  }

  getEvent(externalId: string): Promise<NormalizedEvent | null> {
    return this.provider.getEvent(externalId);
  }

  async recommendTrip(eventId: string): Promise<{
    anchor: {
      eventId: string;
      destination: { city: string | null; geo: { lat: number; lng: number } | null };
      arriveBy: string | null;
    };
    transport: unknown[];
    stays: unknown[];
  }> {
    const event = await this.provider.getEvent(eventId);
    return {
      anchor: {
        eventId,
        destination: {
          city: event?.venue.city ?? null,
          geo:
            event?.venue.lat != null && event?.venue.lng != null
              ? { lat: event.venue.lat, lng: event.venue.lng }
              : null,
        },
        arriveBy: event?.startsAt ?? null,
      },
      // Phase 2: Amadeus transport offers + Booking.com stays orchestrated around the anchor.
      transport: [],
      stays: [],
    };
  }
}
