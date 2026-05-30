import { Module } from '@nestjs/common';
import { EventBookingService } from './application/event-booking.service';
import { EventBookingRepository } from './infrastructure/event-booking.repository';
import { EventBookingFacade } from './event-booking.facade';
import { EVENT_BOOKING_PORT } from '@shared/contracts/event-booking.contract';

/**
 * Event Booking (core). Exports the EVENT_BOOKING_PORT (bound to the facade) for the Trip saga.
 * Depends on the global Provider Integration ACL for the actual provider calls.
 */
@Module({
  providers: [
    EventBookingService,
    EventBookingRepository,
    EventBookingFacade,
    { provide: EVENT_BOOKING_PORT, useExisting: EventBookingFacade },
  ],
  exports: [EVENT_BOOKING_PORT],
})
export class EventBookingModule {}
