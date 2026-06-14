import { Injectable } from '@nestjs/common';
import { Money } from '@shared/money/money.vo';
import {
  AuthorizeResult,
  CaptureResult,
  CreateIntentInput,
  CreateIntentResult,
  PaymentsPort,
  PaymentSummary,
  RefundResult,
} from '@shared/contracts/payments.contract';
import { PaymentsService } from './application/payments.service';

/**
 * The ONLY surface Payments exposes to other contexts (Section 17.7). Implements PaymentsPort.
 * The Trip saga binds to this in-process today; swap for an HTTP/gRPC client on extraction
 * with zero change to Trip's domain/application.
 */
@Injectable()
export class PaymentsFacade implements PaymentsPort {
  constructor(private readonly payments: PaymentsService) {}

  createIntent(input: CreateIntentInput): Promise<CreateIntentResult> {
    return this.payments.createIntent(input);
  }

  authorize(input: {
    paymentIntentId: string;
    idempotencyKey: string;
  }): Promise<AuthorizeResult> {
    return this.payments.authorize(input);
  }

  capture(input: {
    paymentIntentId: string;
    amount: Money;
    idempotencyKey: string;
  }): Promise<CaptureResult> {
    return this.payments.capture({
      paymentIntentId: input.paymentIntentId,
      amount: { amount: input.amount.amount, currency: input.amount.currency },
      idempotencyKey: input.idempotencyKey,
    });
  }

  voidIntent(input: {
    paymentIntentId: string;
    idempotencyKey: string;
  }): Promise<void> {
    return this.payments.voidIntent(input);
  }

  refund(input: {
    paymentIntentId: string;
    amount: Money;
    reason: string;
    idempotencyKey: string;
    tripLegId?: string;
  }): Promise<RefundResult> {
    return this.payments.refund({
      paymentIntentId: input.paymentIntentId,
      amount: { amount: input.amount.amount, currency: input.amount.currency },
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      tripLegId: input.tripLegId,
    });
  }

  getSummary(paymentIntentId: string): Promise<PaymentSummary | null> {
    return this.payments.getSummary(paymentIntentId);
  }
}
