import { Injectable } from '@nestjs/common';
import { PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { Tx } from '@shared/prisma/prisma.tx';
import { OptimisticLockError } from '@shared/common/errors/domain-error';

@Injectable()
export class PaymentRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(
    tx: Tx,
    data: {
      tripId: string;
      userId: string;
      amount: bigint;
      currency: string;
      idempotencyKey: string;
    },
  ) {
    return tx.paymentIntent.create({
      data: { ...data, status: 'CREATED' },
    });
  }

  findById(id: string, client: Tx | PrismaService = this.prisma) {
    return client.paymentIntent.findUnique({ where: { id } });
  }

  findByIdempotencyKey(key: string) {
    return this.prisma.paymentIntent.findUnique({
      where: { idempotencyKey: key },
    });
  }

  findByStripeId(stripeId: string) {
    return this.prisma.paymentIntent.findUnique({
      where: { stripePaymentIntentId: stripeId },
    });
  }

  /** Version-checked update (optimistic concurrency, Rule 10). Throws on conflict. */
  async updateChecked(
    tx: Tx,
    id: string,
    version: number,
    data: Prisma.PaymentIntentUpdateInput,
  ) {
    const res = await tx.paymentIntent.updateMany({
      where: { id, version },
      data: { ...data, version: { increment: 1 } },
    });
    if (res.count === 0) throw new OptimisticLockError('PaymentIntent', id, version);
  }

  setStripeFields(
    tx: Tx,
    id: string,
    version: number,
    data: {
      stripePaymentIntentId: string;
      clientSecret: string | null;
      status: PaymentStatus;
    },
  ) {
    return this.updateChecked(tx, id, version, data);
  }

  addCharge(
    tx: Tx,
    data: {
      paymentIntentId: string;
      stripeChargeId: string;
      amount: bigint;
      currency: string;
    },
  ) {
    return tx.charge.create({
      data: { ...data, capturedAt: new Date() },
    });
  }
}
