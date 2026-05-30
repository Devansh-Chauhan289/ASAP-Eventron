import { Injectable } from '@nestjs/common';
import {
  CreatePendingEventBookingInput,
  CreatePendingEventBookingResult,
  EventBookingPort,
  ReserveResult,
} from '@shared/contracts/event-booking.contract';
import { EventBookingService } from './application/event-booking.service';

/** The only surface Event Booking exposes to the Trip saga (Section 17.7). */
@Injectable()
export class EventBookingFacade implements EventBookingPort {
  constructor(private readonly service: EventBookingService) {}

  createPending(
    input: CreatePendingEventBookingInput,
  ): Promise<CreatePendingEventBookingResult> {
    return this.service.createPending(input);
  }

  reserve(input: {
    bookingId: string;
    idempotencyKey: string;
  }): Promise<ReserveResult> {
    return this.service.reserve(input);
  }

  confirm(input: {
    bookingId: string;
    idempotencyKey: string;
  }): Promise<{ ok: boolean; providerRef: string }> {
    return this.service.confirm(input);
  }

  release(input: { bookingId: string; idempotencyKey: string }): Promise<void> {
    return this.service.release(input);
  }
}
