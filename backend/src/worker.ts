import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

/**
 * Worker entrypoint (Section 15). On AWS we run the API and the BullMQ workers as SEPARATE
 * ECS/Fargate services so they scale independently. This boots the application context WITHOUT
 * an HTTP listener — the BullMQ processors (saga, outbox relay, notifications) start with their
 * modules. In Phase-1 local/dev you can instead run `npm run start` which runs both in one process.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Worker');
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  app.enableShutdownHooks();

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      void app.close().then(() => process.exit(0));
    });
  }
  logger.log('ASAP worker started (BullMQ processors active)');
}

void bootstrap();
