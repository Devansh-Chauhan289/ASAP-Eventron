import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { OutboxRepository } from '@shared/outbox/outbox.repository';
import { makeEvent } from '@shared/events/domain-event.envelope';
import { EVENTS } from '@shared/events/event-names';
import { Money } from '@shared/money/money.vo';
import { CorrelationContext } from '@shared/common/context/correlation.context';
import {
  BusinessRuleError,
  NotFoundError,
} from '@shared/common/errors/domain-error';
import {
  CreatePendingEventBookingInput,
  CreatePendingEventBookingResult,
  ReserveResult,
} from '@shared/contracts/event-booking.contract';
import {
  EVENT_PROVIDER_PORT,
  EventProviderPort,
} from '@modules/provider-integration/domain/event-provider.port';
import { EventBookingRepository } from '../infrastructure/event-booking.repository';
import { assertBookingTransition } from '../domain/booking-status.machine';

/**
 * Event Booking use-cases (Section 6.1). External provider calls happen OUTSIDE the DB tx;
 * the result is folded back into the booking aggregate + TripLeg-driving events in a tx.
 */
@Injectable()
export class EventBookingService {
  private readonly logger = new Logger(EventBookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: EventBookingRepository,
    private readonly outbox: OutboxRepository,
    @Inject(EVENT_PROVIDER_PORT)
    private readonly provider: EventProviderPort,
  ) {}

  async createPending(
    input: CreatePendingEventBookingInput,
  ): Promise<CreatePendingEventBookingResult> {
    // Idempotent: same key (per leg) returns the existing booking.
    const existing = await this.bookings.findByLeg(input.tripLegId);
    if (existing) {
      return {
        bookingId: existing.id,
        price: Money.of(existing.priceAmount, existing.priceCurrency),
      };
    }

    // EXTERNAL: quote the price for the basket (outside any tx).
    const event = await this.provider.getEvent(input.externalEventId);
    const unit = event?.priceFrom ?? { amount: 5000, currency: 'USD' };
    const price = Money.of(
      BigInt(unit.amount) * BigInt(input.quantity),
      unit.currency,
    );

    const booking = await this.bookings.create({
      tripId: input.tripId,
      tripLegId: input.tripLegId,
      userId: input.userId,
      externalEventId: input.externalEventId,
      priceAmount: price.amount,
      priceCurrency: price.currency,
      idempotencyKey: input.idempotencyKey,
      attributes: { quantity: input.quantity, tier: input.tier },
    });

    return { bookingId: booking.id, price };
  }

  async reserve(input: {
    bookingId: string;
    idempotencyKey: string;
  }): Promise<ReserveResult> {
    const booking = await this.require(input.bookingId);
    if (booking.status === 'RESERVED' || booking.status === 'CONFIRMED') {
      return {
        ok: true,
        providerRef: booking.providerRef ?? undefined,
        price: Money.of(booking.priceAmount, booking.priceCurrency),
      };
    }

    const attrs = booking.attributes as { quantity?: number; tier?: string };
    // EXTERNAL reserve (idempotent at the provider via idempotencyKey).
    const result = await this.provider.reserve({
      externalEventId: booking.externalEventId,
      quantity: attrs.quantity ?? 1,
      tier: attrs.tier ?? 'GA',
      idempotencyKey: input.idempotencyKey,
      bookingId: booking.id,
    });

    if (!result.ok) {
      await this.prisma.runTransaction(async (tx) => {
        assertBookingTransition(booking.status, 'REJECTED');
        await this.bookings.setStatus(tx, booking.id, booking.version, 'REJECTED');
        await this.outbox.append(tx, [
          this.event(EVENTS.BOOKING_EVENT_FAILED, booking, {
            reason: result.rejectionReason,
            retryable: false,
          }),
        ]);
      });
      return { ok: false, rejectionReason: result.rejectionReason };
    }

    await this.prisma.runTransaction(async (tx) => {
      assertBookingTransition(booking.status, 'RESERVED');
      await this.bookings.setStatus(tx, booking.id, booking.version, 'RESERVED', {
        providerRef: result.providerRef,
        holdExpiresAt: result.holdExpiresAt
          ? new Date(result.holdExpiresAt)
          : undefined,
      });
      await this.outbox.append(tx, [
        this.event(EVENTS.BOOKING_EVENT_RESERVED, booking, {
          providerRef: result.providerRef,
        }),
      ]);
    });

    return {
      ok: true,
      providerRef: result.providerRef,
      price: result.price
        ? Money.of(BigInt(result.price.amount), result.price.currency)
        : Money.of(booking.priceAmount, booking.priceCurrency),
    };
  }

  async confirm(input: {
    bookingId: string;
    idempotencyKey: string;
  }): Promise<{ ok: boolean; providerRef: string }> {
    const booking = await this.require(input.bookingId);
    if (booking.status === 'CONFIRMED' && booking.providerRef) {
      return { ok: true, providerRef: booking.providerRef };
    }
    if (booking.status !== 'RESERVED' || !booking.providerRef) {
      throw new BusinessRuleError(`Cannot confirm booking from ${booking.status}`);
    }

    // EXTERNAL confirm.
    const res = await this.provider.confirm({
      providerRef: booking.providerRef,
      idempotencyKey: input.idempotencyKey,
    });

    await this.prisma.runTransaction(async (tx) => {
      assertBookingTransition(booking.status, 'CONFIRMED');
      await this.bookings.setStatus(tx, booking.id, booking.version, 'CONFIRMED', {
        providerRef: res.confirmationRef, // INV-B1
      });
      await this.outbox.append(tx, [
        this.event(EVENTS.BOOKING_EVENT_CONFIRMED, booking, {
          providerRef: res.confirmationRef,
        }),
      ]);
    });
    return { ok: true, providerRef: res.confirmationRef };
  }

  async release(input: {
    bookingId: string;
    idempotencyKey: string;
  }): Promise<void> {
    let booking = await this.require(input.bookingId);
    if (booking.status === 'RELEASED' || booking.status === 'REJECTED') return;
    if (booking.status !== 'RESERVED') {
      this.logger.warn(
        `release() on booking ${booking.id} in ${booking.status}; skipping`,
      );
      return;
    }

    // EXTERNAL cancel of the hold.
    if (booking.providerRef) {
      await this.provider.cancel({
        providerRef: booking.providerRef,
        idempotencyKey: input.idempotencyKey,
      });
    }

    await this.prisma.runTransaction(async (tx) => {
      assertBookingTransition(booking.status, 'RELEASING');
      await this.bookings.setStatus(tx, booking.id, booking.version, 'RELEASING');
    });
    booking = await this.require(input.bookingId);
    await this.prisma.runTransaction(async (tx) => {
      assertBookingTransition(booking.status, 'RELEASED');
      await this.bookings.setStatus(tx, booking.id, booking.version, 'RELEASED');
      await this.outbox.append(tx, [
        this.event(EVENTS.BOOKING_EVENT_RELEASED, booking, {}),
      ]);
    });
  }

  // ── helpers ───────────────────────────────────────────────
  private async require(id: string) {
    const b = await this.bookings.findById(id);
    if (!b) throw new NotFoundError('EventBooking', id);
    return b;
  }

  private event(
    eventType: string,
    booking: { id: string; tripId: string; userId: string },
    extra: Record<string, unknown>,
  ) {
    return makeEvent({
      eventType,
      aggregateType: 'EventBooking',
      aggregateId: booking.id,
      tripId: booking.tripId,
      userId: booking.userId,
      correlationId: CorrelationContext.correlationId() ?? null,
      payload: { bookingId: booking.id, ...extra },
    });
  }
}
