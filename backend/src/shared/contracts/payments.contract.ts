import { Money } from '../money/money.vo';

/**
 * Cross-context Payments port (Section 17.7). Declared in the shared kernel so the consumer
 * (Trip Orchestration) depends on the contract, the producer (Payments) implements it, and
 * neither imports the other's internals. On extraction this interface becomes the HTTP/gRPC
 * client contract — the consumer's domain/application code is unchanged.
 *
 * References are LOGICAL ids (no FK, no cross-context join — Rule 8).
 */
export const PAYMENTS_PORT = Symbol('PAYMENTS_PORT');

export interface CreateIntentInput {
  tripId: string;
  userId: string;
  amount: Money;
  idempotencyKey: string;
}

export interface CreateIntentResult {
  paymentIntentId: string;
  clientSecret: string | null;
  stripePaymentIntentId: string | null;
  status: string;
}

export interface AuthorizeResult {
  ok: boolean;
  status: string; // local PaymentStatus
}

export interface CaptureResult {
  ok: boolean;
  chargeId?: string;
}

export interface PaymentsPort {
  createIntent(input: CreateIntentInput): Promise<CreateIntentResult>;
  /** Verifies the client-confirmed Stripe PI reached requires_capture and marks AUTHORIZED. */
  authorize(input: {
    paymentIntentId: string;
    idempotencyKey: string;
  }): Promise<AuthorizeResult>;
  capture(input: {
    paymentIntentId: string;
    amount: Money;
    idempotencyKey: string;
  }): Promise<CaptureResult>;
  /** Releases the authorization with zero money moved (the common failure outcome). */
  voidIntent(input: {
    paymentIntentId: string;
    idempotencyKey: string;
  }): Promise<void>;
  /** Refunds a (partial or full) captured amount; posts the reversing ledger entries. */
  refund(input: {
    paymentIntentId: string;
    amount: Money;
    reason: string;
    idempotencyKey: string;
    tripLegId?: string;
  }): Promise<RefundResult>;
  getSummary(paymentIntentId: string): Promise<PaymentSummary | null>;
}

export interface RefundResult {
  ok: boolean;
  refundId: string;
  status: string;
  refundedAmount: number;
}

export interface PaymentSummary {
  paymentIntentId: string;
  status: string;
  authorized: { amount: number; currency: string };
  captured: { amount: number; currency: string };
  refunded: { amount: number; currency: string };
}
