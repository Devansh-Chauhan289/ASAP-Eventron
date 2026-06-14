import { PaymentStatus } from '@prisma/client';
import { IllegalStateTransitionError } from '@shared/common/errors/domain-error';

/**
 * Payment state machine (Section 4.3). Manual-capture lifecycle. Transitions are enforced
 * here, not implied by columns. The dominant failure outcome is AUTHORIZED -> VOIDED
 * (zero money moved).
 */
const ALLOWED: Record<PaymentStatus, PaymentStatus[]> = {
  // The client confirms the card out-of-band (Stripe.js), so our local status can jump
  // straight to AUTHORIZED once the saga retrieves the real Stripe status (requires_capture).
  CREATED: ['REQUIRES_PAYMENT_METHOD', 'REQUIRES_CONFIRMATION', 'REQUIRES_ACTION', 'PROCESSING', 'AUTHORIZED', 'FAILED'],
  REQUIRES_PAYMENT_METHOD: ['REQUIRES_CONFIRMATION', 'REQUIRES_ACTION', 'PROCESSING', 'AUTHORIZED', 'FAILED'],
  REQUIRES_CONFIRMATION: ['REQUIRES_ACTION', 'PROCESSING', 'AUTHORIZED', 'FAILED'],
  REQUIRES_ACTION: ['PROCESSING', 'AUTHORIZED', 'FAILED'],
  PROCESSING: ['AUTHORIZED', 'CAPTURED', 'FAILED'],
  AUTHORIZED: ['CAPTURED', 'VOIDED', 'FAILED'],
  CAPTURED: ['PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED'],
  PARTIALLY_REFUNDED: ['REFUNDED', 'DISPUTED'],
  REFUNDED: ['DISPUTED'],
  DISPUTED: ['CAPTURED', 'CHARGEBACK'],
  VOIDED: [],
  FAILED: [],
  CHARGEBACK: [],
};

export function assertPaymentTransition(
  from: PaymentStatus,
  to: PaymentStatus,
): void {
  if (from === to) return;
  if (!ALLOWED[from].includes(to)) {
    throw new IllegalStateTransitionError('Payment', from, to);
  }
}

export function isTerminal(status: PaymentStatus): boolean {
  return ['VOIDED', 'FAILED', 'CHARGEBACK', 'REFUNDED'].includes(status);
}
