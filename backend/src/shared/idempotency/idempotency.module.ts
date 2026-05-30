import { Global, Module } from '@nestjs/common';
import { IdempotencyRepository } from './idempotency.repository';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { WebhookReceiptRepository } from '../webhook/webhook-receipt.repository';

@Global()
@Module({
  providers: [
    IdempotencyRepository,
    IdempotencyInterceptor,
    WebhookReceiptRepository,
  ],
  exports: [
    IdempotencyRepository,
    IdempotencyInterceptor,
    WebhookReceiptRepository,
  ],
})
export class IdempotencyModule {}
