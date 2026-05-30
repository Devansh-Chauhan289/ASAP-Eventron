import { Injectable, Logger } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import Stripe from 'stripe';
import { PrismaService } from '@shared/prisma/prisma.service';
import { Tx } from '@shared/prisma/prisma.tx';
import { OutboxRepository } from '@shared/outbox/outbox.repository';
import { makeEvent } from '@shared/events/domain-event.envelope';
import { EVENTS } from '@shared/events/event-names';
import { CorrelationContext } from '@shared/common/context/correlation.context';
import {
  BusinessRuleError,
  NotFoundError,
} from '@shared/common/errors/domain-error';
import {
  AuthorizeResult,
  CaptureResult,
  CreateIntentInput,
  CreateIntentResult,
  PaymentSummary,
} from '@shared/contracts/payments.contract';
import { PaymentRepository } from '../infrastructure/payment.repository';
import { LedgerRepository, LEDGER_ACCOUNTS } from '../infrastructure/ledger.repository';
import { StripeAdapter } from '../infrastructure/stripe.adapter';
import { assertPaymentTransition } from '../domain/payment-status.machine';

/**
 * Payments use-cases (Section 6/4.3). The pattern is always:
 *   read state -> EXTERNAL Stripe call (OUTSIDE tx) -> $transaction { persist + ledger + outbox }.
 * Money never advances past inventory; the dominant failure outcome is VOID (zero money moved).
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentRepository,
    private readonly ledger: LedgerRepository,
    private readonly stripe: StripeAdapter,
    private readonly outbox: OutboxRepository,
  ) {}

  async createIntent(input: CreateIntentInput): Promise<CreateIntentResult> {
    // Idempotent: same key returns the same intent (no duplicate Stripe PI).
    const existing = await this.payments.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return {
        paymentIntentId: existing.id,
        clientSecret: existing.clientSecret,
        stripePaymentIntentId: existing.stripePaymentIntentId,
        status: existing.status,
      };
    }

    // tx1: local record first (so a Stripe success is always reconcilable to a row).
    const local = await this.prisma.runTransaction((tx) =>
      this.payments.create(tx, {
        tripId: input.tripId,
        userId: input.userId,
        amount: input.amount.amount,
        currency: input.amount.currency,
        idempotencyKey: input.idempotencyKey,
      }),
    );

    // EXTERNAL (outside any tx).
    const stripePi = await this.stripe.createPaymentIntent({
      amount: input.amount.amount,
      currency: input.amount.currency,
      tripId: input.tripId,
      idempotencyKey: input.idempotencyKey,
    });
    const status = this.mapStripeStatus(stripePi.status);

    // tx2: fold the Stripe result back + emit event.
    await this.prisma.runTransaction(async (tx) => {
      await this.payments.setStripeFields(tx, local.id, local.version, {
        stripePaymentIntentId: stripePi.id,
        clientSecret: stripePi.client_secret,
        status,
      });
      await this.outbox.append(tx, [
        makeEvent({
          eventType: EVENTS.PAYMENT_INTENT_CREATED,
          aggregateType: 'PaymentIntent',
          aggregateId: local.id,
          tripId: input.tripId,
          userId: input.userId,
          correlationId: CorrelationContext.correlationId() ?? null,
          payload: { paymentIntentId: local.id, amount: Number(input.amount.amount) },
        }),
      ]);
    });

    return {
      paymentIntentId: local.id,
      clientSecret: stripePi.client_secret,
      stripePaymentIntentId: stripePi.id,
      status,
    };
  }

  async authorize(input: {
    paymentIntentId: string;
    idempotencyKey: string;
  }): Promise<AuthorizeResult> {
    const pi = await this.requireIntent(input.paymentIntentId);
    if (pi.status === 'AUTHORIZED' || pi.status === 'CAPTURED') {
      return { ok: true, status: pi.status };
    }
    if (!pi.stripePaymentIntentId) {
      throw new BusinessRuleError('PaymentIntent has no Stripe intent');
    }

    // EXTERNAL: confirm the client-side authorization reached requires_capture.
    const stripePi = await this.stripe.retrievePaymentIntent(
      pi.stripePaymentIntentId,
    );

    if (stripePi.status === 'requires_capture') {
      await this.transition(pi.id, pi.version, 'AUTHORIZED', (tx) =>
        this.outbox.append(tx, [
          makeEvent({
            eventType: EVENTS.PAYMENT_AUTHORIZED,
            aggregateType: 'PaymentIntent',
            aggregateId: pi.id,
            tripId: pi.tripId,
            userId: pi.userId,
            correlationId: CorrelationContext.correlationId() ?? null,
            payload: { paymentIntentId: pi.id, authorizedAmount: Number(pi.amount) },
          }),
        ]),
      );
      return { ok: true, status: 'AUTHORIZED' };
    }

    // Not authorized — mark failed so the saga compensates / surfaces.
    await this.transition(pi.id, pi.version, 'FAILED', (tx) =>
      this.outbox.append(tx, [
        makeEvent({
          eventType: EVENTS.PAYMENT_FAILED,
          aggregateType: 'PaymentIntent',
          aggregateId: pi.id,
          tripId: pi.tripId,
          userId: pi.userId,
          correlationId: CorrelationContext.correlationId() ?? null,
          payload: { paymentIntentId: pi.id, stripeStatus: stripePi.status },
        }),
      ]),
    );
    return { ok: false, status: 'FAILED' };
  }

  async capture(input: {
    paymentIntentId: string;
    amount: { amount: bigint; currency: string };
    idempotencyKey: string;
  }): Promise<CaptureResult> {
    const pi = await this.requireIntent(input.paymentIntentId);
    if (pi.status === 'CAPTURED') {
      return { ok: true };
    }
    if (pi.status !== 'AUTHORIZED' || !pi.stripePaymentIntentId) {
      throw new BusinessRuleError(`Cannot capture from status ${pi.status}`);
    }

    // EXTERNAL capture.
    const captured = await this.stripe.capturePaymentIntent({
      stripePaymentIntentId: pi.stripePaymentIntentId,
      amount: input.amount.amount,
      idempotencyKey: input.idempotencyKey,
    });
    const chargeId =
      typeof captured.latest_charge === 'string'
        ? captured.latest_charge
        : (captured.latest_charge as Stripe.Charge | null)?.id ?? `ch_${pi.id}`;

    await this.prisma.runTransaction(
      async (tx) => {
        assertPaymentTransition(pi.status, 'CAPTURED');
        await this.payments.updateChecked(tx, pi.id, pi.version, {
          status: 'CAPTURED',
          capturedAmount: input.amount.amount,
        });
        await this.payments.addCharge(tx, {
          paymentIntentId: pi.id,
          stripeChargeId: chargeId,
          amount: input.amount.amount,
          currency: input.amount.currency,
        });
        // Double-entry: money received into clearing, recognized as revenue. Σdr == Σcr.
        await this.ledger.post(tx, {
          currency: input.amount.currency,
          paymentIntentId: pi.id,
          memo: `capture ${pi.id}`,
          entries: [
            {
              accountCode: LEDGER_ACCOUNTS.STRIPE_CLEARING,
              direction: 'DEBIT',
              amount: input.amount.amount,
            },
            {
              accountCode: LEDGER_ACCOUNTS.REVENUE,
              direction: 'CREDIT',
              amount: input.amount.amount,
            },
          ],
        });
        await this.outbox.append(tx, [
          makeEvent({
            eventType: EVENTS.PAYMENT_CAPTURED,
            aggregateType: 'PaymentIntent',
            aggregateId: pi.id,
            tripId: pi.tripId,
            userId: pi.userId,
            correlationId: CorrelationContext.correlationId() ?? null,
            payload: {
              paymentIntentId: pi.id,
              capturedAmount: Number(input.amount.amount),
            },
          }),
        ]);
      },
      { isolationLevel: 'Serializable' },
    );
    return { ok: true, chargeId };
  }

  async voidIntent(input: {
    paymentIntentId: string;
    idempotencyKey: string;
  }): Promise<void> {
    const pi = await this.requireIntent(input.paymentIntentId);
    if (pi.status === 'VOIDED') return;
    if (pi.status !== 'AUTHORIZED') {
      // Only an authorized (uncaptured) intent can be voided. Captured -> needs refund.
      throw new BusinessRuleError(`Cannot void from status ${pi.status}`);
    }
    if (pi.stripePaymentIntentId) {
      await this.stripe.cancelPaymentIntent({
        stripePaymentIntentId: pi.stripePaymentIntentId,
        idempotencyKey: input.idempotencyKey,
      });
    }
    await this.transition(pi.id, pi.version, 'VOIDED', (tx) =>
      this.outbox.append(tx, [
        makeEvent({
          eventType: EVENTS.PAYMENT_VOIDED,
          aggregateType: 'PaymentIntent',
          aggregateId: pi.id,
          tripId: pi.tripId,
          userId: pi.userId,
          correlationId: CorrelationContext.correlationId() ?? null,
          payload: { paymentIntentId: pi.id },
        }),
      ]),
    );
  }

  async getSummary(paymentIntentId: string): Promise<PaymentSummary | null> {
    const pi = await this.payments.findById(paymentIntentId);
    if (!pi) return null;
    return {
      paymentIntentId: pi.id,
      status: pi.status,
      authorized: { amount: Number(pi.amount), currency: pi.currency },
      captured: { amount: Number(pi.capturedAmount), currency: pi.currency },
      refunded: { amount: Number(pi.refundedAmount), currency: pi.currency },
    };
  }

  // ── helpers ───────────────────────────────────────────────
  private async requireIntent(id: string) {
    const pi = await this.payments.findById(id);
    if (!pi) throw new NotFoundError('PaymentIntent', id);
    return pi;
  }

  private async transition(
    id: string,
    version: number,
    to: PaymentStatus,
    withTx: (tx: Tx) => Promise<void>,
  ): Promise<void> {
    await this.prisma.runTransaction(async (tx) => {
      const fresh = await this.payments.findById(id, tx);
      if (!fresh) throw new NotFoundError('PaymentIntent', id);
      assertPaymentTransition(fresh.status, to);
      await this.payments.updateChecked(tx, id, version, { status: to });
      await withTx(tx);
    });
  }

  private mapStripeStatus(s: Stripe.PaymentIntent.Status): PaymentStatus {
    switch (s) {
      case 'requires_payment_method':
        return 'REQUIRES_PAYMENT_METHOD';
      case 'requires_confirmation':
        return 'REQUIRES_CONFIRMATION';
      case 'requires_action':
        return 'REQUIRES_ACTION';
      case 'processing':
        return 'PROCESSING';
      case 'requires_capture':
        return 'AUTHORIZED';
      case 'succeeded':
        return 'CAPTURED';
      case 'canceled':
        return 'VOIDED';
      default:
        return 'CREATED';
    }
  }
}
