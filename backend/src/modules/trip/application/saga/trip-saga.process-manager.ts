import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { OutboxRepository } from '@shared/outbox/outbox.repository';
import { makeEvent } from '@shared/events/domain-event.envelope';
import { EVENTS } from '@shared/events/event-names';
import { Money } from '@shared/money/money.vo';
import { CorrelationContext } from '@shared/common/context/correlation.context';
import {
  PAYMENTS_PORT,
  PaymentsPort,
} from '@shared/contracts/payments.contract';
import {
  EVENT_BOOKING_PORT,
  EventBookingPort,
} from '@shared/contracts/event-booking.contract';
import { TripRepository, TripWithLegs } from '../../infrastructure/trip.repository';
import { assertTripTransition } from '../../domain/trip-status.machine';

/**
 * The durable Trip booking saga / process manager (Section 6.4, 17.5). PostgreSQL holds the
 * authoritative step (trip.SagaState.step); BullMQ is transport only. Each step performs its
 * EXTERNAL call OUTSIDE a DB tx, then records the outcome + advances the step in ONE tx.
 *
 * Phase-1 path:  AUTHORIZE_PAYMENT -> RESERVE_EVENT -> CAPTURE_PAYMENT -> CONFIRM_LEGS -> DONE
 * Sad path:      RESERVE_EVENT fails -> COMPENSATE (void auth, zero money) -> CANCELLED
 *
 * The processor loops driveOnce() until DONE/terminal; on any throw, BullMQ retries the whole
 * job and the saga resumes from the persisted step (idempotent steps => effectively-once).
 */
@Injectable()
export class TripSagaProcessManager {
  private readonly logger = new Logger(TripSagaProcessManager.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trips: TripRepository,
    private readonly outbox: OutboxRepository,
    @Inject(PAYMENTS_PORT) private readonly payments: PaymentsPort,
    @Inject(EVENT_BOOKING_PORT) private readonly eventBooking: EventBookingPort,
  ) {}

  /** Drive the saga to completion. Called by the BullMQ processor. */
  async drive(tripId: string): Promise<void> {
    for (let i = 0; i < 12; i++) {
      const done = await this.driveOnce(tripId);
      if (done) return;
    }
    this.logger.warn(`Saga ${tripId} did not converge in 12 steps`);
  }

  private async driveOnce(tripId: string): Promise<boolean> {
    const trip = await this.trips.findById(tripId);
    if (!trip || !trip.saga) return true;
    const step = trip.saga.step;
    this.logger.debug(`Saga ${tripId} step=${step}`);

    switch (step) {
      case 'AUTHORIZE_PAYMENT':
        return this.stepAuthorize(trip);
      case 'RESERVE_EVENT':
        return this.stepReserveEvent(trip);
      case 'CAPTURE_PAYMENT':
        return this.stepCapture(trip);
      case 'CONFIRM_LEGS':
        return this.stepConfirmLegs(trip);
      case 'COMPENSATE':
        return this.stepCompensate(trip);
      case 'DONE':
        return true;
      default:
        return true;
    }
  }

  // ── AUTHORIZE_PAYMENT ─────────────────────────────────────
  private async stepAuthorize(trip: TripWithLegs): Promise<boolean> {
    if (!trip.paymentIntentId) {
      await this.fail(trip, 'No payment intent on trip');
      return true;
    }
    const res = await this.payments.authorize({
      paymentIntentId: trip.paymentIntentId,
      idempotencyKey: `trip:${trip.id}:authorize`,
    });

    if (res.ok) {
      await this.prisma.runTransaction((tx) =>
        this.trips.updateSaga(tx, trip.id, { step: 'RESERVE_EVENT', attempts: 0 }),
      );
      return false;
    }
    // Auth failed: nothing reserved, nothing captured -> PAYMENT_FAILED (no compensation).
    await this.prisma.runTransaction(async (tx) => {
      assertTripTransition(trip.status, 'PAYMENT_FAILED');
      await this.trips.updateChecked(tx, trip.id, trip.version, {
        status: 'PAYMENT_FAILED',
      });
      await this.trips.updateSaga(tx, trip.id, { step: 'DONE' });
    });
    return true;
  }

  // ── RESERVE_EVENT ─────────────────────────────────────────
  private async stepReserveEvent(trip: TripWithLegs): Promise<boolean> {
    const leg = trip.legs.find((l) => l.type === 'EVENT');
    if (!leg?.bookingId) {
      await this.toCompensation(trip, 'Anchor event leg missing booking');
      return false;
    }
    const res = await this.eventBooking.reserve({
      bookingId: leg.bookingId,
      idempotencyKey: `trip:${trip.id}:reserve-event`,
    });

    if (res.ok) {
      await this.prisma.runTransaction(async (tx) => {
        await this.trips.updateLeg(tx, leg.id, {
          status: 'RESERVED',
          providerRef: res.providerRef,
        });
        await this.trips.updateSaga(tx, trip.id, {
          step: 'CAPTURE_PAYMENT',
          attempts: 0,
        });
      });
      return false;
    }
    // Anchor reservation rejected (e.g. SOLD_OUT) -> compensate (void auth).
    await this.prisma.runTransaction(async (tx) => {
      await this.trips.updateLeg(tx, leg.id, { status: 'REJECTED' });
    });
    await this.toCompensation(
      trip,
      `Anchor reservation failed: ${res.rejectionReason ?? 'unknown'}`,
    );
    return false;
  }

  // ── CAPTURE_PAYMENT ───────────────────────────────────────
  private async stepCapture(trip: TripWithLegs): Promise<boolean> {
    if (!trip.paymentIntentId) {
      await this.toCompensation(trip, 'No payment intent at capture');
      return false;
    }
    const total = this.legTotal(trip);
    const res = await this.payments.capture({
      paymentIntentId: trip.paymentIntentId,
      amount: total,
      idempotencyKey: `trip:${trip.id}:capture`,
    });
    if (!res.ok) {
      await this.toCompensation(trip, 'Capture failed');
      return false;
    }
    await this.prisma.runTransaction(async (tx) => {
      await this.trips.updateChecked(tx, trip.id, trip.version, {
        capturedAmount: total.amount,
      });
      await this.trips.updateSaga(tx, trip.id, {
        step: 'CONFIRM_LEGS',
        attempts: 0,
      });
    });
    return false;
  }

  // ── CONFIRM_LEGS ──────────────────────────────────────────
  private async stepConfirmLegs(trip: TripWithLegs): Promise<boolean> {
    const leg = trip.legs.find((l) => l.type === 'EVENT');
    if (!leg?.bookingId) {
      await this.toCompensation(trip, 'Anchor leg missing at confirm');
      return false;
    }
    const res = await this.eventBooking.confirm({
      bookingId: leg.bookingId,
      idempotencyKey: `trip:${trip.id}:confirm-event`,
    });

    await this.prisma.runTransaction(async (tx) => {
      await this.trips.updateLeg(tx, leg.id, {
        status: 'CONFIRMED',
        providerRef: res.providerRef,
      });
      assertTripTransition(trip.status, 'CONFIRMED');
      await this.trips.updateChecked(tx, trip.id, trip.version, {
        status: 'CONFIRMED',
      });
      await this.trips.updateSaga(tx, trip.id, { step: 'DONE' });
      await this.outbox.append(tx, [
        this.tripEvent(trip, EVENTS.TRIP_CONFIRMED, {
          legs: trip.legs.map((l) => ({ id: l.id, type: l.type })),
        }),
        this.notify(trip, 'trip_confirmed', { tripId: trip.id }),
      ]);
    });
    return true;
  }

  // ── COMPENSATE ────────────────────────────────────────────
  private async stepCompensate(trip: TripWithLegs): Promise<boolean> {
    // 1) Release any reserved (uncaptured) bookings — cancel provider hold FIRST.
    for (const leg of trip.legs) {
      if (leg.bookingId && leg.status === 'RESERVED') {
        await this.eventBooking.release({
          bookingId: leg.bookingId,
          idempotencyKey: `trip:${trip.id}:release-${leg.id}`,
        });
        await this.prisma.runTransaction((tx) =>
          this.trips.updateLeg(tx, leg.id, { status: 'RELEASED' }),
        );
      }
    }
    // 2) Void the authorization (zero money moved) — only if not captured.
    if (trip.paymentIntentId && trip.capturedAmount === 0n) {
      await this.payments
        .voidIntent({
          paymentIntentId: trip.paymentIntentId,
          idempotencyKey: `trip:${trip.id}:void`,
        })
        .catch((e) => this.logger.error(`Void failed for ${trip.id}`, e as Error));
    }
    // 3) Finalize -> CANCELLED.
    await this.prisma.runTransaction(async (tx) => {
      const fresh = await this.trips.findById(trip.id, tx);
      if (!fresh) return;
      assertTripTransition(fresh.status, 'CANCELLED');
      await this.trips.updateChecked(tx, trip.id, fresh.version, {
        status: 'CANCELLED',
      });
      await this.trips.updateSaga(tx, trip.id, { step: 'DONE' });
      await this.outbox.append(tx, [
        this.tripEvent(trip, EVENTS.TRIP_CANCELLED, { reason: 'compensated' }),
        this.notify(trip, 'trip_cancelled', { tripId: trip.id }),
      ]);
    });
    return true;
  }

  // ── helpers ───────────────────────────────────────────────
  private async toCompensation(trip: TripWithLegs, reason: string): Promise<void> {
    await this.prisma.runTransaction(async (tx) => {
      const fresh = await this.trips.findById(trip.id, tx);
      if (!fresh) return;
      if (fresh.status === 'BOOKING' || fresh.status === 'PARTIALLY_BOOKED') {
        assertTripTransition(fresh.status, 'COMPENSATING');
        await this.trips.updateChecked(tx, trip.id, fresh.version, {
          status: 'COMPENSATING',
        });
      }
      await this.trips.updateSaga(tx, trip.id, {
        step: 'COMPENSATE',
        compensating: true,
        lastError: reason,
      });
      await this.outbox.append(tx, [
        this.tripEvent(trip, EVENTS.TRIP_COMPENSATION_STARTED, { reason }),
      ]);
    });
    this.logger.warn(`Saga ${trip.id} entering compensation: ${reason}`);
  }

  private async fail(trip: TripWithLegs, reason: string): Promise<void> {
    await this.prisma.runTransaction(async (tx) => {
      await this.trips.updateSaga(tx, trip.id, {
        step: 'DONE',
        lastError: reason,
      });
      if (trip.status === 'BOOKING' || trip.status === 'PENDING_PAYMENT') {
        assertTripTransition(trip.status, 'PAYMENT_FAILED');
        await this.trips.updateChecked(tx, trip.id, trip.version, {
          status: 'PAYMENT_FAILED',
        });
      }
    });
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

  private notify(
    trip: TripWithLegs,
    templateId: string,
    data: Record<string, unknown>,
  ) {
    return makeEvent({
      eventType: EVENTS.NOTIFICATION_DISPATCH_REQUESTED,
      aggregateType: 'Trip',
      aggregateId: trip.id,
      tripId: trip.id,
      userId: trip.userId,
      correlationId: CorrelationContext.correlationId() ?? null,
      payload: {
        userId: trip.userId,
        channel: 'EMAIL',
        templateId,
        dedupeKey: `${templateId}:${trip.id}`,
        data,
      },
    });
  }
}
