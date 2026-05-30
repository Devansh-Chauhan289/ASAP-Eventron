import { Module, OnModuleInit } from '@nestjs/common';
import { PaymentsService } from './application/payments.service';
import { StripeWebhookService } from './application/stripe-webhook.service';
import { PaymentRepository } from './infrastructure/payment.repository';
import { LedgerRepository } from './infrastructure/ledger.repository';
import { StripeAdapter } from './infrastructure/stripe.adapter';
import { PaymentsFacade } from './payments.facade';
import { StripeWebhookController } from './interface/stripe-webhook.controller';

/**
 * Payments (CORE). Exports ONLY PaymentsFacade (the cross-context port impl) — its
 * repositories, ledger, and Stripe adapter stay private (Rule 8). Seeds the chart of
 * accounts at boot so the double-entry ledger is ready before the first capture.
 */
@Module({
  controllers: [StripeWebhookController],
  providers: [
    PaymentsService,
    StripeWebhookService,
    PaymentRepository,
    LedgerRepository,
    StripeAdapter,
    PaymentsFacade,
  ],
  exports: [PaymentsFacade],
})
export class PaymentsModule implements OnModuleInit {
  constructor(private readonly ledger: LedgerRepository) {}

  async onModuleInit(): Promise<void> {
    await this.ledger.ensureAccounts();
  }
}
