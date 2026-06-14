import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { ProviderName } from '@prisma/client';
import { AppConfig } from '@shared/config/config.module';
import { assertNotInTransaction } from '@shared/prisma/tx-context';
import { ProviderUnavailableError } from '@shared/common/errors/domain-error';
import {
  EventProviderPort,
  EventSearchQuery,
  NormalizedEvent,
  ReserveEventInput,
  ReserveEventResult,
} from '../domain/event-provider.port';
import { CircuitBreaker } from './circuit-breaker';
import { ProviderRequestRepository } from './provider-request.repository';

const PROVIDER: ProviderName = 'TICKETMASTER';

/**
 * Ticketmaster adapter (Section 12). search/getEvent hit the real Discovery API (read-only).
 * Reservation/confirm/cancel are SANDBOX-SIMULATED because the public Discovery API does not
 * sell tickets — but they go through the exact resilience + idempotency machinery a real
 * ticketing provider would (circuit breaker, timeout, ProviderRequest dedupe). A real provider
 * slots in by replacing only the simulated section. To exercise the saga sad path in Phase 1,
 * an externalEventId beginning with "FAIL" yields a terminal SOLD_OUT rejection.
 */
@Injectable()
export class TicketmasterAdapter implements EventProviderPort {
  private readonly logger = new Logger(TicketmasterAdapter.name);
  private readonly timeoutMs = 10_000;

  constructor(
    private readonly config: AppConfig,
    private readonly breaker: CircuitBreaker,
    private readonly providerRequests: ProviderRequestRepository,
  ) {}

  async search(query: EventSearchQuery): Promise<NormalizedEvent[]> {
    assertNotInTransaction('Ticketmaster.search');
    const url = new URL(`${this.config.ticketmaster.baseUrl}/events.json`);
    url.searchParams.set('apikey', this.config.ticketmaster.apiKey);
    url.searchParams.set('size', String(query.limit));
    if (query.q) url.searchParams.set('keyword', query.q);
    if (query.city) url.searchParams.set('city', query.city);
    if (query.from) url.searchParams.set('startDateTime', query.from);
    if (query.to) url.searchParams.set('endDateTime', query.to);

    const json = await this.breaker.run(PROVIDER, () =>
      this.getJson(url.toString()),
    );
    const events = (json?._embedded?.events ?? []) as TmEvent[];
    return this.groupByShow(events);
  }

  /**
   * Ticketmaster returns ONE event object per performance date, so a residency
   * (same act, same venue, many nights) arrives as many near-identical objects.
   * Collapse them into one NormalizedEvent per show, carrying every night in
   * `dates[]`. Grouping key is the attraction id (falls back to title) + venue id.
   */
  private groupByShow(events: TmEvent[]): NormalizedEvent[] {
    const groups = new Map<string, { base: TmEvent; dates: TmEvent[] }>();

    for (const e of events) {
      const attractionId = e._embedded?.attractions?.[0]?.id;
      const venueId = e._embedded?.venues?.[0]?.id;
      const key = `${attractionId ?? e.name}::${venueId ?? e._embedded?.venues?.[0]?.name ?? ''}`;
      const existing = groups.get(key);
      if (existing) {
        existing.dates.push(e);
      } else {
        groups.set(key, { base: e, dates: [e] });
      }
    }

    return [...groups.values()].map(({ base, dates }) => {
      // Sort the show's performances ascending by start time.
      const sorted = [...dates].sort((a, b) => {
        const ta = a.dates?.start?.dateTime ?? '';
        const tb = b.dates?.start?.dateTime ?? '';
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      });
      // Normalize using the earliest date as the representative, then attach all dates.
      const representative = sorted[0] ?? base;
      const normalized = this.normalize(representative);
      normalized.dates = sorted.map((e) => ({
        externalId: e.id,
        startsAt: e.dates?.start?.dateTime ?? null,
        availability: 'AVAILABLE' as const,
      }));
      return normalized;
    });
  }

  async getEvent(externalId: string): Promise<NormalizedEvent | null> {
    assertNotInTransaction('Ticketmaster.getEvent');
    if (externalId.startsWith('FAIL') || externalId.startsWith('TEST')) {
      // Synthetic event for local/dev testing without a live API key.
      return this.syntheticEvent(externalId);
    }
    const url = `${this.config.ticketmaster.baseUrl}/events/${encodeURIComponent(
      externalId,
    )}.json?apikey=${this.config.ticketmaster.apiKey}`;
    try {
      const json = await this.breaker.run(PROVIDER, () => this.getJson(url));
      const event = json as TmEvent;
      const normalized = this.normalize(event);

      // Enrich with the show's other performances so the detail page can offer a
      // date picker even when navigated to directly (one event id -> all nights).
      const attractionId = event._embedded?.attractions?.[0]?.id;
      const venueId = event._embedded?.venues?.[0]?.id;
      if (attractionId) {
        const siblings = await this.fetchShowDates(attractionId, venueId);
        if (siblings.length > 1) {
          const sorted = siblings.sort((a, b) => {
            const ta = a.dates?.start?.dateTime ?? '';
            const tb = b.dates?.start?.dateTime ?? '';
            return ta < tb ? -1 : ta > tb ? 1 : 0;
          });
          normalized.dates = sorted.map((e) => ({
            externalId: e.id,
            startsAt: e.dates?.start?.dateTime ?? null,
            availability: 'AVAILABLE' as const,
          }));
        }
      }
      return normalized;
    } catch (err) {
      if (err instanceof ProviderUnavailableError) throw err;
      return null;
    }
  }

  /** Fetch all performances for an attraction (optionally at one venue). Best-effort. */
  private async fetchShowDates(
    attractionId: string,
    venueId?: string,
  ): Promise<TmEvent[]> {
    try {
      const url = new URL(`${this.config.ticketmaster.baseUrl}/events.json`);
      url.searchParams.set('apikey', this.config.ticketmaster.apiKey);
      url.searchParams.set('attractionId', attractionId);
      if (venueId) url.searchParams.set('venueId', venueId);
      url.searchParams.set('size', '50');
      url.searchParams.set('sort', 'date,asc');
      const json = await this.breaker.run(PROVIDER, () =>
        this.getJson(url.toString()),
      );
      return (json?._embedded?.events ?? []) as TmEvent[];
    } catch {
      return [];
    }
  }

  async reserve(input: ReserveEventInput): Promise<ReserveEventResult> {
    assertNotInTransaction('Ticketmaster.reserve');
    // Idempotency: a prior successful reservation for this key returns the same ref.
    const prior = await this.providerRequests.findSucceeded(
      PROVIDER,
      input.idempotencyKey,
    );
    if (prior) return prior as unknown as ReserveEventResult;

    // Deterministic sad-path hook for Phase-1 compensation testing.
    if (input.externalEventId.startsWith('FAIL')) {
      const result: ReserveEventResult = {
        ok: false,
        rejectionReason: 'SOLD_OUT',
      };
      await this.audit('RESERVE', input, 200, result, false);
      return result;
    }

    const event = await this.getEvent(input.externalEventId);
    const price = event?.priceFrom ?? { amount: 5000, currency: 'USD' };
    const providerRef = `TM-${this.shortHash(input.idempotencyKey)}`;
    const result: ReserveEventResult = {
      ok: true,
      providerRef,
      holdExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      price: { amount: price.amount * input.quantity, currency: price.currency },
    };
    await this.audit('RESERVE', input, 200, result, true);
    return result;
  }

  async confirm(input: {
    providerRef: string;
    idempotencyKey: string;
  }): Promise<{ ok: boolean; confirmationRef: string }> {
    assertNotInTransaction('Ticketmaster.confirm');
    const confirmationRef = `${input.providerRef}-C`;
    await this.audit(
      'CONFIRM',
      input,
      200,
      { confirmationRef },
      true,
    );
    return { ok: true, confirmationRef };
  }

  async cancel(input: {
    providerRef: string;
    idempotencyKey: string;
  }): Promise<void> {
    assertNotInTransaction('Ticketmaster.cancel');
    await this.audit('CANCEL', input, 200, { cancelled: true }, true);
  }

  // ── helpers ───────────────────────────────────────────────
  // External JSON is intentionally untyped at the boundary; normalize() maps it to DTOs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getJson(url: string): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.status >= 500 || res.status === 429) {
        throw new ProviderUnavailableError('ticketmaster');
      }
      if (!res.ok) {
        this.logger.warn(`Ticketmaster ${res.status} for ${url}`);
        return {};
      }
      return (await res.json()) as unknown;
    } catch (err) {
      if (err instanceof ProviderUnavailableError) throw err;
      throw new ProviderUnavailableError('ticketmaster');
    } finally {
      clearTimeout(timer);
    }
  }

  private async audit(
    operation: string,
    input: { idempotencyKey: string; bookingId?: string },
    status: number,
    body: object,
    succeeded: boolean,
  ): Promise<void> {
    await this.providerRequests.record({
      provider: PROVIDER,
      operation,
      idempotencyKey: input.idempotencyKey,
      bookingId: input.bookingId,
      requestHash: this.shortHash(JSON.stringify(input)),
      responseStatus: status,
      responseBody: body,
      succeeded,
    });
  }

  private shortHash(s: string): string {
    return createHash('sha256').update(s).digest('hex').slice(0, 16);
  }

  private normalize(e: TmEvent): NormalizedEvent {
    const venue = e._embedded?.venues?.[0];
    const priceRange = e.priceRanges?.[0];
    return {
      provider: 'TICKETMASTER',
      externalId: e.id,
      title: e.name,
      category: e.classifications?.[0]?.segment?.name ?? 'EVENT',
      venue: {
        name: venue?.name ?? 'Unknown venue',
        city: venue?.city?.name ?? null,
        lat: venue?.location ? Number(venue.location.latitude) : null,
        lng: venue?.location ? Number(venue.location.longitude) : null,
      },
      startsAt: e.dates?.start?.dateTime ?? null,
      endsAt: null,
      priceFrom: priceRange
        ? { amount: Math.round(priceRange.min * 100), currency: priceRange.currency }
        : null,
      imageUrl: e.images?.[0]?.url ?? null,
      availability: 'AVAILABLE',
      // Single-date by default; groupByShow() overwrites this for residencies.
      dates: [
        {
          externalId: e.id,
          startsAt: e.dates?.start?.dateTime ?? null,
          availability: 'AVAILABLE',
        },
      ],
    };
  }

  private syntheticEvent(externalId: string): NormalizedEvent {
    // `TEST-D<n>` encodes an event <n> days from now so refund-policy tiers can be exercised
    // end-to-end (e.g. TEST-D12 → 100%, TEST-D7 → 50%, TEST-D2 → 0%). Default 30 days out.
    const m = externalId.match(/-D(\d+)/);
    const daysOut = m ? Number(m[1]) : 30;
    return {
      provider: 'TICKETMASTER',
      externalId,
      title: `Test Event ${externalId}`,
      category: 'CONCERT',
      venue: { name: 'Test Arena', city: 'Inglewood', lat: 33.95, lng: -118.33 },
      startsAt: new Date(Date.now() + daysOut * 86_400_000).toISOString(),
      endsAt: null,
      priceFrom: { amount: 8500, currency: 'USD' },
      imageUrl: null,
      availability: externalId.startsWith('FAIL') ? 'SOLD_OUT' : 'AVAILABLE',
      dates: [
        {
          externalId,
          startsAt: new Date(Date.now() + daysOut * 86_400_000).toISOString(),
          availability: externalId.startsWith('FAIL') ? 'SOLD_OUT' : 'AVAILABLE',
        },
      ],
    };
  }
}

// ── Minimal Ticketmaster Discovery response shapes (only what we read) ──
interface TmEvent {
  id: string;
  name: string;
  dates?: { start?: { dateTime?: string } };
  classifications?: Array<{ segment?: { name?: string } }>;
  priceRanges?: Array<{ min: number; max: number; currency: string }>;
  images?: Array<{ url: string }>;
  _embedded?: {
    venues?: Array<{
      id?: string;
      name?: string;
      city?: { name?: string };
      location?: { latitude?: string; longitude?: string };
    }>;
    attractions?: Array<{ id?: string; name?: string }>;
  };
}
