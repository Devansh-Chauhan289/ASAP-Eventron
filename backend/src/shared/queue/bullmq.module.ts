import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AppConfig, AppConfigModule } from '../config/config.module';
import { QUEUES } from './queues';

/**
 * Registers the shared BullMQ connection (ElastiCache Redis) and all queues.
 * @Global so any context module can @InjectQueue without re-importing.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        connection: {
          host: config.redis.host,
          port: config.redis.port,
          password: config.redis.password,
          // BullMQ requires maxRetriesPerRequest=null for blocking commands.
          maxRetriesPerRequest: null,
        },
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUES.SAGA },
      { name: QUEUES.OUTBOX_RELAY },
      { name: QUEUES.DOMAIN_EVENTS },
      { name: QUEUES.NOTIFICATIONS },
      { name: QUEUES.PROVIDER_CALLS },
    ),
  ],
  exports: [BullModule],
})
export class AppBullModule {}
