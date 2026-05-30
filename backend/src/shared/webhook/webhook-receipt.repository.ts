import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Inbound webhook dedupe (Section 7 — "webhook arrives twice"). Stripe/provider webhooks
 * are de-duplicated on (source, externalEventId) so reprocessing is a no-op.
 */
@Injectable()
export class WebhookReceiptRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns true if this webhook is new (claim won), false if already received. */
  async claim(source: string, externalEventId: string): Promise<boolean> {
    try {
      await this.prisma.webhookReceipt.create({
        data: { source, externalEventId },
      });
      return true;
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        return false;
      }
      throw e;
    }
  }

  async markProcessed(source: string, externalEventId: string): Promise<void> {
    await this.prisma.webhookReceipt.update({
      where: { source_externalEventId: { source, externalEventId } },
      data: { processedAt: new Date() },
    });
  }
}
