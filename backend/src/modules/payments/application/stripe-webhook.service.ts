import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { PrismaService } from '@shared/prisma/prisma.service';
import { OutboxRepository } from '@shared/outbox/outbox.repository';
import { WebhookReceiptRepository } from '@shared/webhook/webhook-receipt.repository';
import { makeEvent } from '@shared/events/domain-event.envelope';
import { EVENTS } from '@shared/events/event-names';
import { StripeAdapter } from '../infrastructure/stripe.adapter';
import { PaymentRepository } from '../infrastructure/payment.repository';

/**
 * Stripe webhook ingestion (Section 7 — "webhook arrives twice"). Signature-verified and
 * de-duplicated via platform.WebhookReceipt (source='stripe'). Webhooks are a backstop /
 * source of async truth (disputes, async capture confirmations); the saga remains the driver.
 */
@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    private readonly stripe: StripeAdapter,
    private readonly receipts: WebhookReceiptRepository,
    private readonly prisma: PrismaService,
    private readonly payments: PaymentRepository,
    private readonly outbox: OutboxRepository,
  ) {}

  async handle(rawBody: Buffer, signature: string): Promise<void> {
    const event = this.stripe.constructWebhookEvent(rawBody, signature);

    // Idempotent: a redelivered event is acknowledged without reprocessing.
    const fresh = await this.receipts.claim('stripe', event.id);
    if (!fresh) {
      this.logger.debug(`Duplicate Stripe webhook ${event.id} ignored`);
      return;
    }

    try {
      await this.route(event);
      await this.receipts.markProcessed('stripe', event.id);
    } catch (err) {
      this.logger.error(`Stripe webhook ${event.id} failed`, err as Error);
      throw err; // Stripe will retry; receipt stays unprocessed
    }
  }

  private async route(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'charge.dispute.created':
        await this.onDispute(event.data.object as Stripe.Dispute);
        break;
      // payment_intent.* lifecycle confirmations are reconciliation backstops; the saga is
      // authoritative for capture/authorize. We log them for observability.
      case 'payment_intent.succeeded':
      case 'payment_intent.amount_capturable_updated':
      case 'payment_intent.payment_failed':
        this.logger.debug(`Stripe ${event.type} for ${event.id}`);
        break;
      default:
        this.logger.debug(`Unhandled Stripe event ${event.type}`);
    }
  }

  private async onDispute(dispute: Stripe.Dispute): Promise<void> {
    const stripePiId =
      typeof dispute.payment_intent === 'string'
        ? dispute.payment_intent
        : dispute.payment_intent?.id;
    if (!stripePiId) return;
    const pi = await this.payments.findByStripeId(stripePiId);
    if (!pi) return;

    await this.prisma.runTransaction(async (tx) => {
      await tx.dispute.create({
        data: {
          paymentIntentId: pi.id,
          stripeDisputeId: dispute.id,
          amount: BigInt(dispute.amount),
          currency: dispute.currency.toUpperCase(),
          status: 'OPEN',
          dueBy: dispute.evidence_details?.due_by
            ? new Date(dispute.evidence_details.due_by * 1000)
            : null,
        },
      });
      await this.outbox.append(tx, [
        makeEvent({
          eventType: EVENTS.PAYMENT_DISPUTED,
          aggregateType: 'PaymentIntent',
          aggregateId: pi.id,
          tripId: pi.tripId,
          userId: pi.userId,
          payload: { paymentIntentId: pi.id, disputeId: dispute.id },
        }),
      ]);
    });
  }
}
