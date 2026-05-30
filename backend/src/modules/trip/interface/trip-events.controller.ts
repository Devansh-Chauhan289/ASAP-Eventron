import {
  Controller,
  MessageEvent,
  Param,
  ParseUUIDPipe,
  Sse,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Observable, from, interval } from 'rxjs';
import {
  distinctUntilChanged,
  map,
  startWith,
  switchMap,
  takeWhile,
} from 'rxjs/operators';
import { TripService } from '../application/trip.service';
import {
  CurrentUser,
  AuthUser,
} from '@shared/common/decorators/current-user.decorator';
import { isTripTerminal } from '../domain/trip-status.machine';

const TERMINAL_UI = ['CONFIRMED', 'PARTIALLY_BOOKED', 'CANCELLED', 'PAYMENT_FAILED'];

/**
 * Live booking progress via Server-Sent Events (API.md §5). Phase-1 polls the read model every
 * 1.5s and emits on status change, completing on a terminal status. Phase 2 can push directly
 * from the saga via Redis pub/sub. The frontend may use this OR poll GET /trips/{id} OR FCM push.
 */
@ApiTags('trips')
@ApiBearerAuth()
@Controller({ path: 'trips', version: '1' })
export class TripEventsController {
  constructor(private readonly trips: TripService) {}

  @Sse(':id/events')
  stream(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Observable<MessageEvent> {
    let emittedTerminal = false;
    return interval(1500).pipe(
      startWith(0),
      switchMap(() => from(this.trips.getTrip(id, user.userId))),
      map((trip) => ({ status: trip.status })),
      distinctUntilChanged((a, b) => a.status === b.status),
      // Emit the terminal status once, then complete the stream.
      takeWhile(() => !emittedTerminal, true),
      map((payload): MessageEvent => {
        if (TERMINAL_UI.includes(payload.status) || isTripTerminal(payload.status as never)) {
          emittedTerminal = true;
        }
        return { type: 'trip.update', data: payload };
      }),
    );
  }
}
