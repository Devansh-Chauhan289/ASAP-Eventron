import { Module } from '@nestjs/common';
import { TripController } from './interface/trip.controller';
import { TripEventsController } from './interface/trip-events.controller';
import { TripService } from './application/trip.service';
import { TripSagaProcessManager } from './application/saga/trip-saga.process-manager';
import { TripRepository } from './infrastructure/trip.repository';
import { TripSagaProcessor } from './infrastructure/queue/trip-saga.processor';
import { PaymentsModule } from '@modules/payments/payments.module';
import { EventBookingModule } from '@modules/event-booking/event-booking.module';
import { PaymentsFacade } from '@modules/payments/payments.facade';
import { PAYMENTS_PORT } from '@shared/contracts/payments.contract';

/**
 * Trip Orchestration (CORE — the saga / process manager). Binds the cross-context ports to the
 * in-process facades (Section 17.7); EVENT_BOOKING_PORT comes from EventBookingModule, and we
 * bind PAYMENTS_PORT to PaymentsFacade here. Swapping either for an HTTP client on extraction
 * touches only this wiring — the saga/use-cases are unchanged.
 */
@Module({
  imports: [PaymentsModule, EventBookingModule],
  controllers: [TripController, TripEventsController],
  providers: [
    TripService,
    TripSagaProcessManager,
    TripRepository,
    TripSagaProcessor,
    { provide: PAYMENTS_PORT, useExisting: PaymentsFacade },
  ],
  exports: [TripService],
})
export class TripModule {}
