import { assertPaymentTransition, isTerminal } from './payment-status.machine';
import { IllegalStateTransitionError } from '@shared/common/errors/domain-error';

describe('Payment state machine (Section 4.3 — manual capture)', () => {
  it('allows authorize -> capture (happy path)', () => {
    expect(() => assertPaymentTransition('AUTHORIZED', 'CAPTURED')).not.toThrow();
  });

  it('allows authorize -> void (the dominant failure outcome: zero money moved)', () => {
    expect(() => assertPaymentTransition('AUTHORIZED', 'VOIDED')).not.toThrow();
  });

  it('forbids capturing a voided/failed intent', () => {
    expect(() => assertPaymentTransition('VOIDED', 'CAPTURED')).toThrow(
      IllegalStateTransitionError,
    );
    expect(() => assertPaymentTransition('FAILED', 'CAPTURED')).toThrow();
  });

  it('forbids voiding an already-captured intent (must refund instead)', () => {
    expect(() => assertPaymentTransition('CAPTURED', 'VOIDED')).toThrow();
  });

  it('supports refund transitions', () => {
    expect(() => assertPaymentTransition('CAPTURED', 'PARTIALLY_REFUNDED')).not.toThrow();
    expect(() => assertPaymentTransition('PARTIALLY_REFUNDED', 'REFUNDED')).not.toThrow();
  });

  it('marks terminal states', () => {
    expect(isTerminal('VOIDED')).toBe(true);
    expect(isTerminal('REFUNDED')).toBe(true);
    expect(isTerminal('AUTHORIZED')).toBe(false);
  });
});
