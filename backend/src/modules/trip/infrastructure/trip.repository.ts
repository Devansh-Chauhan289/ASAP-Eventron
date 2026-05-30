import { Injectable } from '@nestjs/common';
import { BookingStatus, Prisma, SagaStep, TripStatus } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { Tx } from '@shared/prisma/prisma.tx';
import { OptimisticLockError } from '@shared/common/errors/domain-error';

const TRIP_INCLUDE = {
  legs: { orderBy: { sequence: 'asc' } },
  saga: true,
} satisfies Prisma.TripInclude;

export type TripWithLegs = Prisma.TripGetPayload<{
  include: typeof TRIP_INCLUDE;
}>;

@Injectable()
export class TripRepository {
  constructor(private readonly prisma: PrismaService) {}

  createWithAnchor(
    tx: Tx,
    input: {
      userId: string;
      currency: string;
      destinationCity: string | null;
      destinationLat: number | null;
      destinationLng: number | null;
      startsAt: Date | null;
      arriveBy: Date | null;
      anchorPriceAmount: bigint;
      anchorPriceCurrency: string;
    },
  ) {
    return tx.trip.create({
      data: {
        userId: input.userId,
        status: 'PLANNING',
        currency: input.currency,
        destinationCity: input.destinationCity,
        destinationLat: input.destinationLat,
        destinationLng: input.destinationLng,
        startsAt: input.startsAt,
        arriveBy: input.arriveBy,
        legs: {
          create: {
            type: 'EVENT',
            sequence: 0,
            status: 'PENDING',
            priceAmount: input.anchorPriceAmount,
            priceCurrency: input.anchorPriceCurrency,
          },
        },
        saga: { create: { step: 'AUTHORIZE_PAYMENT' } },
      },
      include: TRIP_INCLUDE,
    });
  }

  findById(
    id: string,
    client: Tx | PrismaService = this.prisma,
  ): Promise<TripWithLegs | null> {
    return client.trip.findUnique({ where: { id }, include: TRIP_INCLUDE });
  }

  async listByUser(
    userId: string,
    limit: number,
    cursor: { createdAt: Date; id: string } | null,
    status?: TripStatus,
  ): Promise<TripWithLegs[]> {
    return this.prisma.trip.findMany({
      where: {
        userId,
        ...(status ? { status } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: TRIP_INCLUDE,
    });
  }

  async updateChecked(
    tx: Tx,
    id: string,
    version: number,
    data: Prisma.TripUpdateInput,
  ): Promise<void> {
    const res = await tx.trip.updateMany({
      where: { id, version },
      data: { ...data, version: { increment: 1 } },
    });
    if (res.count === 0) throw new OptimisticLockError('Trip', id, version);
  }

  setAnchor(
    tx: Tx,
    tripId: string,
    version: number,
    data: { anchorLegId: string; legId: string; bookingId: string },
  ) {
    return Promise.all([
      this.updateChecked(tx, tripId, version, { anchorLegId: data.anchorLegId }),
      tx.tripLeg.update({
        where: { id: data.legId },
        data: { bookingId: data.bookingId },
      }),
    ]);
  }

  updateLeg(
    tx: Tx,
    legId: string,
    data: {
      status?: BookingStatus;
      providerRef?: string;
      compRequired?: boolean;
      cancelledAt?: Date;
    },
  ) {
    return tx.tripLeg.update({ where: { id: legId }, data });
  }

  updateSaga(
    tx: Tx,
    tripId: string,
    data: {
      step?: SagaStep;
      compensating?: boolean;
      attempts?: number;
      lastError?: string | null;
    },
  ) {
    return tx.sagaState.update({ where: { tripId }, data });
  }
}
