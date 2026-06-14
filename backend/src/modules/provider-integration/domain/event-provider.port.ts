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

/**
 * One specific performance of a show. A residency (e.g. the same act at the same
 * venue across many nights) is modelled as a single NormalizedEvent with one
 * EventDate per night — the externalId here is the bookable id for that night.
 */
export interface EventDate {
  externalId: string;
  startsAt: string | null; // ISO
  availability: 'AVAILABLE' | 'LIMITED' | 'SOLD_OUT' | 'UNKNOWN';
}

export interface NormalizedEvent {
  provider: 'TICKETMASTER';
  externalId: string; // representative (earliest) date's bookable id
  title: string;
  category: string;
  venue: {
    name: string;
    city: string | null;
    lat: number | null;
    lng: number | null;
  };
  startsAt: string | null; // ISO — earliest date
  endsAt: string | null;
  priceFrom: NormalizedMoney | null;
  imageUrl: string | null;
  availability: 'AVAILABLE' | 'LIMITED' | 'SOLD_OUT' | 'UNKNOWN';
  // All performances of this show, ascending by date. Always >= 1 entry.
  dates: EventDate[];
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
