import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfig } from '../config/config.module';
import { QUEUES } from '../queue/queues';
import { DomainEventEnvelope } from '../events/domain-event.envelope';

interface OutboxRow {
  id: string;
  eventId: string;
  eventType: string;
  eventVersion: number;
  aggregateType: string;
  aggregateId: string;
  correlationId: string | null;
  causationId: string | null;
  tripId: string | null;
  userId: string | null;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

/**
 * Transactional Outbox relay (Section 5.6 / 17.6). Polls platform.OutboxEvent for PENDING
 * rows using FOR UPDATE SKIP LOCKED (safe with multiple relay instances), publishes each to
 * the DOMAIN_EVENTS queue (at-least-once), and marks them DISPATCHED in the same tx.
 *
 * Phase 1 uses an interval poller; Phase 2+ can add Postgres LISTEN/NOTIFY for lower latency.
 */
@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    @InjectQueue(QUEUES.DOMAIN_EVENTS) private readonly eventsQueue: Queue,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.outboxRelayIntervalMs);
    this.logger.log(
      `Outbox relay started (interval=${this.config.outboxRelayIntervalMs}ms)`,
    );
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** Exposed for tests: drains one batch. */
  async tick(): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;
    try {
      return await this.drainBatch();
    } catch (err) {
      this.logger.error('Outbox relay tick failed', err as Error);
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async drainBatch(): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<OutboxRow[]>`
        SELECT id, "eventId", "eventType", "eventVersion", "aggregateType",
               "aggregateId", "correlationId", "causationId", "tripId", "userId",
               payload, "occurredAt"
        FROM platform."OutboxEvent"
        WHERE status = 'PENDING'
        ORDER BY "occurredAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 100`;

      if (rows.length === 0) return 0;

      for (const row of rows) {
        const envelope: DomainEventEnvelope = {
          eventId: row.eventId,
          eventType: row.eventType,
          eventVersion: row.eventVersion,
          occurredAt: row.occurredAt,
          aggregateType: row.aggregateType,
          aggregateId: row.aggregateId,
          correlationId: row.correlationId,
          causationId: row.causationId,
          tripId: row.tripId,
          userId: row.userId,
          payload: row.payload,
        };
        // jobId = eventId makes redelivery dedupe at the queue level too.
        await this.eventsQueue.add(row.eventType, envelope, {
          jobId: row.eventId,
          attempts: 10,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: true,
        });
        await tx.outboxEvent.update({
          where: { eventId: row.eventId },
          data: { status: 'DISPATCHED', publishedAt: new Date() },
        });
      }
      this.logger.debug(`Relayed ${rows.length} outbox event(s)`);
      return rows.length;
    });
  }
}
