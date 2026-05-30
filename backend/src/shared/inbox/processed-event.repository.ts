import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Tx } from '../prisma/prisma.tx';

/**
 * Consumer-side dedupe for at-least-once delivery (Section 5.5). A handler inserts
 * (eventId, consumer) inside its own transaction BEFORE doing work; a unique-violation
 * means "already processed" → the redelivery is a safe no-op (effectively-once).
 */
@Injectable()
export class ProcessedEventRepository {
  /**
   * Returns true if this is the first time `consumer` sees `eventId` (claim succeeded),
   * false if it was already processed. Must be called within the handler's tx.
   */
  async claim(tx: Tx, eventId: string, consumer: string): Promise<boolean> {
    try {
      await tx.processedEvent.create({ data: { eventId, consumer } });
      return true;
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        return false; // duplicate delivery
      }
      throw e;
    }
  }
}
