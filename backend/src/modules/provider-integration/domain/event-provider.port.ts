/**
 * Event provider port (anti-corruption layer, Section 12). The Event Booking context depends
 * on this normalized interface; concrete adapters (Ticketmaster, Eventbrite, ...) implement it.
 * Ugly external payloads are normalized into these DTOs so the domain never sees provider quirks.
 */
export const EVENT_PROVIDER_PORT = Symbol('EVENT_PROVIDER_PORT');

export interface NormalizedMoney {
  amount: number; // minor units
  currency: string;
}

export interface NormalizedEvent {
  provider: 'TICKETMASTER';
  externalId: string;
  title: string;
  category: string;
  venue: {
    name: string;
    city: string | null;
    lat: number | null;
    lng: number | null;
  };
  startsAt: string | null; // ISO
  endsAt: string | null;
  priceFrom: NormalizedMoney | null;
  imageUrl: string | null;
  availability: 'AVAILABLE' | 'LIMITED' | 'SOLD_OUT' | 'UNKNOWN';
}

export interface EventSearchQuery {
  q?: string;
  city?: string;
  from?: string;
  to?: string;
  limit: number;
}

export interface ReserveEventInput {
  externalEventId: string;
  quantity: number;
  tier: string;
  idempotencyKey: string;
  bookingId: string;
}

export interface ReserveEventResult {
  ok: boolean;
  providerRef?: string;
  holdExpiresAt?: string; // ISO
  price?: NormalizedMoney;
  rejectionReason?: string; // present when ok=false (e.g. SOLD_OUT) — terminal, no retry
}

export interface EventProviderPort {
  search(query: EventSearchQuery): Promise<NormalizedEvent[]>;
  getEvent(externalId: string): Promise<NormalizedEvent | null>;
  reserve(input: ReserveEventInput): Promise<ReserveEventResult>;
  confirm(input: {
    providerRef: string;
    idempotencyKey: string;
  }): Promise<{ ok: boolean; confirmationRef: string }>;
  cancel(input: { providerRef: string; idempotencyKey: string }): Promise<void>;
}
