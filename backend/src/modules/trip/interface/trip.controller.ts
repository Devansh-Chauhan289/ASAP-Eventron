import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TripService } from '../application/trip.service';
import {
  CancelTripDto,
  CheckoutDto,
  ConfirmTripDto,
  CreateTripDto,
} from './dto/trip.dto';
import { toTripResponse } from './trip.http-mapper';
import {
  CurrentUser,
  AuthUser,
} from '@shared/common/decorators/current-user.decorator';
import { Idempotent } from '@shared/idempotency/idempotency.interceptor';
import { buildPage, decodeCursor } from '@shared/common/pagination/cursor';

@ApiTags('trips')
@ApiBearerAuth()
@Controller({ path: 'trips', version: '1' })
export class TripController {
  constructor(private readonly trips: TripService) {}

  @Post()
  @Idempotent()
  @HttpCode(201)
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateTripDto) {
    const trip = await this.trips.createTrip({
      userId: user.userId,
      externalEventId: dto.anchor.eventId,
      ticketTier: dto.anchor.ticketTier,
      quantity: dto.anchor.quantity,
    });
    return toTripResponse(trip);
  }

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query('limit') limitRaw?: string,
    @Query('cursor') cursorRaw?: string,
  ) {
    const limit = Math.min(Math.max(Number(limitRaw) || 20, 1), 50);
    const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
    const rows = await this.trips.listTrips(
      user.userId,
      limit,
      cursor ? { createdAt: new Date(cursor.createdAt), id: cursor.id } : null,
    );
    const page = buildPage(rows, limit);
    return {
      data: page.data.map(toTripResponse),
      pageInfo: page.pageInfo,
    };
  }

  @Get(':id')
  async get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return toTripResponse(await this.trips.getTrip(id, user.userId));
  }

  @Post(':id/quote')
  @HttpCode(200)
  async quote(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const { trip, total, quoteExpiresAt } = await this.trips.quote(
      id,
      user.userId,
    );
    return {
      tripId: trip.id,
      legs: trip.legs.map((l) => ({
        id: l.id,
        price: { amount: Number(l.priceAmount), currency: l.priceCurrency },
      })),
      total: total.toApi(),
      quoteExpiresAt,
    };
  }

  @Post(':id/checkout')
  @Idempotent()
  @HttpCode(200)
  async checkout(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() _dto: CheckoutDto,
  ) {
    const res = await this.trips.checkout(id, user.userId);
    return {
      paymentIntentId: res.paymentIntentId,
      stripeClientSecret: res.clientSecret,
      amount: res.amount.toApi(),
      captureMethod: 'manual',
      status: res.status,
    };
  }

  @Post(':id/confirm')
  @Idempotent()
  @HttpCode(202)
  async confirm(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmTripDto,
  ) {
    const res = await this.trips.confirm(id, user.userId, dto.paymentIntentId);
    return {
      tripId: res.tripId,
      status: res.status,
      message:
        "Your trip is being booked. We'll notify you when it's confirmed.",
      pollAfterMs: 2000,
    };
  }

  /** Preview the refund a cancellation would yield right now (read-only, for the UI timeline). */
  @Get(':id/cancellation-quote')
  async cancellationQuote(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.trips.quoteCancellation(id, user.userId);
  }

  @Post(':id/cancel')
  @Idempotent()
  @HttpCode(200)
  async cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() _dto: CancelTripDto,
  ) {
    return this.trips.cancel(id, user.userId);
  }
}
