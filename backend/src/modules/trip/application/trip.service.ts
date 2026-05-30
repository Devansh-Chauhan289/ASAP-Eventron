import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '@shared/prisma/prisma.service';
import { OutboxRepository } from '@shared/outbox/outbox.repository';
import { makeEvent } from '@shared/events/domain-event.envelope';
import { EVENTS } from '@shared/events/event-names';
import { Money } from '@shared/money/money.vo';
import { QUEUES } from '@shared/queue/queues';
import { CorrelationContext } from '@shared/common/context/correlation.context';
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
} from '@shared/common/errors/domain-error';
import { PAYMENTS_PORT, PaymentsPort } from '@shared/contracts/payments.contract';
import {
  EVENT_BOOKING_PORT,
  EventBookingPort,
} from '@shared/contracts/event-booking.contract';
import { TripRepository, TripWithLegs } from '../infrastructure/trip.repository';
import { assertTripTransition } from '../domain/trip-status.machine';

/**
 * Trip Orchestration use-cases (Sections 6, 17.5). Owns trip lifecycle up to handing off to
 * the durable saga at confirm(). External calls (payments.createIntent, eventBooking.createPending)
 * happen OUTSIDE any DB tx; state changes + events are written atomically via the outbox.
 */
@Injectable()
export class TripService {
  private readonly logger = new Logger(TripService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trips: TripRepository,
    private readonly outbox: OutboxRepository,
    @Inject(PAYMENTS_PORT) private readonly payments: PaymentsPort,
    @Inject(EVENT_BOOKING_PORT) private readonly eventBooking: EventBookingPort,
    @InjectQueue(QUEUES.SAGA) private readonly saga: Queue,
  ) {}

  async createTrip(input: {
    userId: string;
    externalEventId: string;
    ticketTier: string;
    quantity: number;
  }): Promise<TripWithLegs> {
    // tx1: create the trip shell + anchor leg (price filled after quoting).
    const created = await this.prisma.runTransaction((tx) =>
      this.trips.createWithAnchor(tx, {
        userId: input.userId,
        currency: 'USD',
        destinationCity: null,
        destinationLat: null,
        destinationLng: null,
        startsAt: null,
        arriveBy: null,
        anchorPriceAmount: 0n,
        anchorPriceCurrency: 'USD',
      }),
    );
    const anchorLeg = created.legs[0];
    if (!anchorLeg) throw new Error('anchor leg not created');

    // EXTERNAL: create the pending event booking + quote price (outside tx).
    const pending = await this.eventBooking.createPending({
      tripId: created.id,
      tripLegId: anchorLeg.id,
      userId: input.userId,
      externalEventId: input.externalEventId,
      quantity: input.quantity,
      tier: input.ticketTier,
      idempotencyKey: `trip:${created.id}:event-pending`,
    });

    // tx2: link booking + set price + emit trip.created.
    await this.prisma.runTransaction(async (tx) => {
      await this.trips.updateLeg(tx, anchorLeg.id, {});
      await tx.tripLeg.update({
        where: { id: anchorLeg.id },
        data: {
          bookingId: pending.bookingId,
          priceAmount: pending.price.amount,
          priceCurrency: pending.price.currency,
        },
      });
      await this.trips.updateChecked(tx, created.id, created.version, {
        anchorLegId: anchorLeg.id,
        authorizedAmount: pending.price.amount,
      });
      await this.outbox.append(tx, [
        this.tripEvent(created, EVENTS.TRIP_CREATED, {
          anchorEventId: input.externalEventId,
        }),
      ]);
    });

    return this.requireTrip(created.id, input.userId);
  }

  async getTrip(tripId: string, userId: string): Promise<TripWithLegs> {
    return this.requireTrip(tripId, userId);
  }

  async quote(
    tripId: string,
    userId: string,
  ): Promise<{ total: Money; quoteExpiresAt: string; trip: TripWithLegs }> {
    const trip = await this.requireTrip(tripId, userId);
    return {
      trip,
      total: this.legTotal(trip),
      quoteExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
  }

  async checkout(
    tripId: string,
    userId: string,
  ): Promise<{
    paymentIntentId: string;
    clientSecret: string | null;
    amount: Money;
    status: string;
  }> {
    const trip = await this.requireTrip(tripId, userId);
    if (trip.status !== 'PLANNING' && trip.status !== 'PENDING_PAYMENT') {
      throw new BusinessRuleError(`Cannot checkout a trip in ${trip.status}`);
    }
    const total = this.legTotal(trip);
    if (!total.isPositive()) {
      throw new BusinessRuleError('Trip total must be positive');
    }

    // EXTERNAL: create (idempotent) Stripe PaymentIntent.
    const intent = await this.payments.createIntent({
      tripId: trip.id,
      userId,
      amount: total,
      idempotencyKey: `trip:${trip.id}:intent`,
    });

    await this.prisma.runTransaction(async (tx) => {
      if (trip.status === 'PLANNING') {
        assertTripTransition(trip.status, 'PENDING_PAYMENT');
      }
      await this.trips.updateChecked(tx, trip.id, trip.version, {
        status: 'PENDING_PAYMENT',
        authorizedAmount: total.amount,
        paymentIntentId: intent.paymentIntentId,
      });
      await this.outbox.append(tx, [
        this.tripEvent(trip, EVENTS.TRIP_BASKET_CONFIRMED, {
          total: total.toApi(),
        }),
      ]);
    });

    return {
      paymentIntentId: intent.paymentIntentId,
      clientSecret: intent.clientSecret,
      amount: total,
      status: intent.status,
    };
  }

  async confirm(
    tripId: string,
    userId: string,
    paymentIntentId: string,
  ): Promise<{ tripId: string; status: string }> {
    const trip = await this.requireTrip(tripId, userId);
    if (trip.status !== 'PENDING_PAYMENT') {
      // Idempotent: re-confirming a trip already booking/confirmed just reports status.
      if (['BOOKING', 'CONFIRMED', 'PARTIALLY_BOOKED'].includes(trip.status)) {
        return { tripId: trip.id, status: trip.status };
      }
      throw new BusinessRuleError(`Cannot confirm a trip in ${trip.status}`);
    }
    if (trip.paymentIntentId !== paymentIntentId) {
      throw new BusinessRuleError('paymentIntentId does not match this trip');
    }

    await this.prisma.runTransaction(async (tx) => {
      assertTripTransition(trip.status, 'BOOKING');
      await this.trips.updateChecked(tx, trip.id, trip.version, {
        status: 'BOOKING',
      });
      await this.trips.updateSaga(tx, trip.id, { step: 'AUTHORIZE_PAYMENT' });
      await this.outbox.append(tx, [
        this.tripEvent(trip, EVENTS.TRIP_BOOKING_STARTED, {}),
      ]);
    });

    // R2: enqueue AFTER commit. jobId dedupes concurrent confirms.
    await this.saga.add(
      'drive',
      { tripId: trip.id },
      { jobId: `trip-saga:${trip.id}`, attempts: 5, backoff: { type: 'exponential', delay: 2000 } },
    );

    return { tripId: trip.id, status: 'BOOKING' };
  }

  async listTrips(
    userId: string,
    limit: number,
    cursor: { createdAt: Date; id: string } | null,
  ): Promise<TripWithLegs[]> {
    return this.trips.listByUser(userId, limit, cursor);
  }

  /**
   * Phase-1 cancellation: pre-booking trips are fully cancelled (auth voided if any).
   * Cancelling a CONFIRMED trip records the request and emits the event; the refund saga
   * that settles money is delivered in Phase 2 (see docs/architecture/18-roadmap.md §18.4).
   */
  async cancel(
    tripId: string,
    userId: string,
  ): Promise<{ tripId: string; status: string }> {
    const trip = await this.requireTrip(tripId, userId);

    if (trip.status === 'PLANNING' || trip.status === 'PENDING_PAYMENT') {
      if (trip.paymentIntentId) {
        await this.payments
          .voidIntent({
            paymentIntentId: trip.paymentIntentId,
            idempotencyKey: `trip:${trip.id}:void`,
          })
          .catch(() => undefined);
      }
      await this.prisma.runTransaction(async (tx) => {
        assertTripTransition(trip.status, 'CANCELLED');
        await this.trips.updateChecked(tx, trip.id, trip.version, {
          status: 'CANCELLED',
        });
        await this.outbox.append(tx, [
          this.tripEvent(trip, EVENTS.TRIP_CANCELLED, { reason: 'user_pre_booking' }),
        ]);
      });
      return { tripId: trip.id, status: 'CANCELLED' };
    }

    if (trip.status === 'CONFIRMED') {
      await this.prisma.runTransaction(async (tx) => {
        assertTripTransition(trip.status, 'CANCELLATION_REQUESTED');
        await this.trips.updateChecked(tx, trip.id, trip.version, {
          status: 'CANCELLATION_REQUESTED',
        });
        await this.outbox.append(tx, [
          this.tripEvent(trip, EVENTS.TRIP_CANCELLED, { reason: 'user_requested' }),
        ]);
      });
      return { tripId: trip.id, status: 'CANCELLATION_REQUESTED' };
    }

    throw new BusinessRuleError(`Cannot cancel a trip in ${trip.status}`);
  }

  // ── helpers ───────────────────────────────────────────────
  private async requireTrip(tripId: string, userId: string): Promise<TripWithLegs> {
    const trip = await this.trips.findById(tripId);
    if (!trip) throw new NotFoundError('Trip', tripId);
    if (trip.userId !== userId) throw new ForbiddenError(); // ownership check (IDOR guard)
    return trip;
  }

  private legTotal(trip: TripWithLegs): Money {
    const total = trip.legs.reduce((s, l) => s + l.priceAmount, 0n);
    return Money.of(total, trip.currency);
  }

  private tripEvent(
    trip: TripWithLegs,
    eventType: string,
    extra: Record<string, unknown>,
  ) {
    return makeEvent({
      eventType,
      aggregateType: 'Trip',
      aggregateId: trip.id,
      tripId: trip.id,
      userId: trip.userId,
      correlationId: CorrelationContext.correlationId() ?? null,
      payload: { tripId: trip.id, ...extra },
    });
  }
}
