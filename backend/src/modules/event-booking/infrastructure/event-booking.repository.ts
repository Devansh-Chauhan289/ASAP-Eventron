import { Injectable } from '@nestjs/common';
import { BookingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { Tx } from '@shared/prisma/prisma.tx';
import { OptimisticLockError } from '@shared/common/errors/domain-error';

@Injectable()
export class EventBookingRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: {
    tripId: string;
    tripLegId: string;
    userId: string;
    externalEventId: string;
    priceAmount: bigint;
    priceCurrency: string;
    idempotencyKey: string;
    attributes: Prisma.InputJsonValue;
  }) {
    return this.prisma.eventBooking.create({
      data: { ...data, provider: 'TICKETMASTER', status: 'PENDING' },
    });
  }

  findById(id: string, client: Tx | PrismaService = this.prisma) {
    return client.eventBooking.findUnique({ where: { id } });
  }

  /** INV-B3: lookup by leg to enforce one active booking per tripLegId. */
  findByLeg(tripLegId: string) {
    return this.prisma.eventBooking.findUnique({ where: { tripLegId } });
  }

  async updateChecked(
    tx: Tx,
    id: string,
    version: number,
    data: Prisma.EventBookingUpdateInput,
  ) {
    const res = await tx.eventBooking.updateMany({
      where: { id, version },
      data: { ...data, version: { increment: 1 } },
    });
    if (res.count === 0) {
      throw new OptimisticLockError('EventBooking', id, version);
    }
  }

  setStatus(
    tx: Tx,
    id: string,
    version: number,
    status: BookingStatus,
    extra?: { providerRef?: string; holdExpiresAt?: Date },
  ) {
    return this.updateChecked(tx, id, version, { status, ...extra });
  }
}
