import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { AppConfig } from '@shared/config/config.module';
import { assertNotInTransaction } from '@shared/prisma/tx-context';
import { ProviderUnavailableError } from '@shared/common/errors/domain-error';

/**
 * Anti-corruption wrapper around the Stripe SDK (Section 12). Every method asserts it is
 * NOT inside a DB transaction (Rule 2 runtime guard) and passes a Stripe idempotency key
 * so retries never double-charge (Rule 3). Card data never touches our servers — the client
 * confirms the PaymentIntent via Stripe Elements (PCI SAQ-A).
 */
@Injectable()
export class StripeAdapter {
  private readonly logger = new Logger(StripeAdapter.name);
  private readonly stripe: Stripe;

  constructor(private readonly config: AppConfig) {
    this.stripe = new Stripe(this.config.stripe.secretKey, {
      typescript: true,
      maxNetworkRetries: 2,
      timeout: 20_000,
    });
  }

  async createPaymentIntent(input: {
    amount: bigint;
    currency: string;
    tripId: string;
    idempotencyKey: string;
  }): Promise<Stripe.PaymentIntent> {
    assertNotInTransaction('Stripe.createPaymentIntent');
    try {
      return await this.stripe.paymentIntents.create(
        {
          amount: Number(input.amount),
          currency: input.currency.toLowerCase(),
          capture_method: 'manual', // authorize now, capture after legs confirm
          metadata: { tripId: input.tripId },
        },
        { idempotencyKey: `pi-create:${input.idempotencyKey}` },
      );
    } catch (e) {
      throw this.wrap(e);
    }
  }

  async retrievePaymentIntent(id: string): Promise<Stripe.PaymentIntent> {
    assertNotInTransaction('Stripe.retrievePaymentIntent');
    try {
      return await this.stripe.paymentIntents.retrieve(id);
    } catch (e) {
      throw this.wrap(e);
    }
  }

  async capturePaymentIntent(input: {
    stripePaymentIntentId: string;
    amount: bigint;
    idempotencyKey: string;
  }): Promise<Stripe.PaymentIntent> {
    assertNotInTransaction('Stripe.capturePaymentIntent');
    try {
      return await this.stripe.paymentIntents.capture(
        input.stripePaymentIntentId,
        { amount_to_capture: Number(input.amount) },
        { idempotencyKey: `pi-capture:${input.idempotencyKey}` },
      );
    } catch (e) {
      throw this.wrap(e);
    }
  }

  async cancelPaymentIntent(input: {
    stripePaymentIntentId: string;
    idempotencyKey: string;
  }): Promise<Stripe.PaymentIntent> {
    assertNotInTransaction('Stripe.cancelPaymentIntent');
    try {
      return await this.stripe.paymentIntents.cancel(
        input.stripePaymentIntentId,
        undefined,
        { idempotencyKey: `pi-cancel:${input.idempotencyKey}` },
      );
    } catch (e) {
      throw this.wrap(e);
    }
  }

  /** Verifies the webhook signature (Section 13 — never trust an unsigned webhook). */
  constructWebhookEvent(payload: Buffer, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(
      payload,
      signature,
      this.config.stripe.webhookSecret,
    );
  }

  private wrap(e: unknown): Error {
    if (e instanceof Stripe.errors.StripeError) {
      // Network / rate-limit / api errors are retryable; card errors are terminal.
      const retryable =
        e.type === 'StripeConnectionError' ||
        e.type === 'StripeAPIError' ||
        e.type === 'StripeRateLimitError';
      this.logger.error(`Stripe error ${e.type}: ${e.message}`);
      if (retryable) return new ProviderUnavailableError('stripe');
    }
    return e instanceof Error ? e : new Error('Unknown Stripe error');
  }
}
