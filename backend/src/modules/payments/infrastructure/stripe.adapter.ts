import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Stripe from 'stripe';
import { AppConfig } from '@shared/config/config.module';
import { assertNotInTransaction } from '@shared/prisma/tx-context';
import { ProviderUnavailableError } from '@shared/common/errors/domain-error';

/**
 * Anti-corruption wrapper around the Stripe SDK (Section 12). Every method asserts it is
 * NOT inside a DB transaction (Rule 2 runtime guard) and passes a Stripe idempotency key
 * so retries never double-charge (Rule 3). Card data never touches our servers — the client
 * confirms the PaymentIntent via Stripe Elements (PCI SAQ-A).
 *
 * MOCK MODE (PAYMENTS_MODE=mock, or 'auto' with a placeholder key): returns deterministic
 * fake PaymentIntents so the full saga + double-entry ledger + idempotency can be exercised
 * locally without Stripe keys. The fake "authorizes" immediately (skips the client-side
 * Stripe.js confirm step) so the saga can drive authorize -> capture / void unattended.
 * Swap to real Stripe by setting a real sk_test_ key — no code change.
 */
@Injectable()
export class StripeAdapter {
  private readonly logger = new Logger(StripeAdapter.name);
  private readonly stripe: Stripe;
  private readonly mock: boolean;

  constructor(private readonly config: AppConfig) {
    this.mock = this.config.stripe.mock;
    this.stripe = new Stripe(this.config.stripe.secretKey, {
      typescript: true,
      maxNetworkRetries: 2,
      timeout: 20_000,
    });
    if (this.mock) {
      this.logger.warn(
        'StripeAdapter running in MOCK mode — no real charges. Set a real sk_test_ key to use Stripe.',
      );
    }
  }

  private fakePI(
    status: Stripe.PaymentIntent.Status,
    id = `pi_mock_${randomUUID()}`,
    extra: Partial<Stripe.PaymentIntent> = {},
  ): Stripe.PaymentIntent {
    return {
      id,
      object: 'payment_intent',
      status,
      client_secret: `${id}_secret_mock`,
      ...extra,
    } as unknown as Stripe.PaymentIntent;
  }

  async createPaymentIntent(input: {
    amount: bigint;
    currency: string;
    tripId: string;
    idempotencyKey: string;
  }): Promise<Stripe.PaymentIntent> {
    assertNotInTransaction('Stripe.createPaymentIntent');
    if (this.mock) return this.fakePI('requires_confirmation');
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
    // Mock: pretend the client already confirmed -> ready to capture (requires_capture).
    if (this.mock) return this.fakePI('requires_capture', id);
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
    if (this.mock) {
      return this.fakePI('succeeded', input.stripePaymentIntentId, {
        latest_charge: `ch_mock_${randomUUID()}`,
      });
    }
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
    if (this.mock) return this.fakePI('canceled', input.stripePaymentIntentId);
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

  async createRefund(input: {
    stripePaymentIntentId: string;
    amount: bigint;
    idempotencyKey: string;
  }): Promise<{ id: string; status: string }> {
    assertNotInTransaction('Stripe.createRefund');
    if (this.mock) {
      return { id: `re_mock_${randomUUID()}`, status: 'succeeded' };
    }
    try {
      const refund = await this.stripe.refunds.create(
        {
          payment_intent: input.stripePaymentIntentId,
          amount: Number(input.amount),
        },
        { idempotencyKey: `refund:${input.idempotencyKey}` },
      );
      return { id: refund.id, status: refund.status ?? 'pending' };
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
