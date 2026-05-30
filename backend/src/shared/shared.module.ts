import { Global, Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { AppBullModule } from './queue/bullmq.module';
import { OutboxModule } from './outbox/outbox.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { HealthController } from './health/health.controller';

/**
 * Shared kernel aggregator. Pulls together the @Global cross-cutting modules (config, prisma,
 * queues, outbox/event-bus, idempotency) so every context can rely on them without re-importing.
 */
@Global()
@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    AppBullModule,
    OutboxModule,
    IdempotencyModule,
  ],
  controllers: [HealthController],
  exports: [
    AppConfigModule,
    PrismaModule,
    AppBullModule,
    OutboxModule,
    IdempotencyModule,
  ],
})
export class SharedModule {}
