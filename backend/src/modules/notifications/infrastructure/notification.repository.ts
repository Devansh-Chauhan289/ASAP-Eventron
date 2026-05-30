import { Injectable } from '@nestjs/common';
import {
  NotificationChannel,
  NotificationStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';

@Injectable()
export class NotificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Idempotent create on (userId, templateId, dedupeKey) — a redelivered dispatch event never
   * produces a second notification (Section 4.4). Returns null if it already exists.
   */
  async createIfNew(input: {
    userId: string;
    channel: NotificationChannel;
    templateId: string;
    dedupeKey: string;
    payload: Prisma.InputJsonValue;
    correlationId: string | null;
  }): Promise<{ id: string } | null> {
    try {
      const n = await this.prisma.notification.create({
        data: { ...input, status: 'QUEUED' },
        select: { id: true },
      });
      return n;
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        return null;
      }
      throw e;
    }
  }

  findById(id: string) {
    return this.prisma.notification.findUnique({ where: { id } });
  }

  setStatus(id: string, status: NotificationStatus) {
    return this.prisma.notification.update({
      where: { id },
      data: { status, attempts: { increment: 1 } },
    });
  }

  recordAttempt(
    notificationId: string,
    channel: NotificationChannel,
    succeeded: boolean,
    providerResponse: Prisma.InputJsonValue,
  ) {
    return this.prisma.deliveryAttempt.create({
      data: { notificationId, channel, succeeded, providerResponse },
    });
  }

  listForUser(userId: string, limit: number) {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  markRead(id: string) {
    // Phase-1: no explicit read column; status -> DELIVERED acts as acknowledgement.
    return this.prisma.notification.update({
      where: { id },
      data: { status: 'DELIVERED' },
    });
  }
}
