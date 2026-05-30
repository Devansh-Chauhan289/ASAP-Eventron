import { AsyncLocalStorage } from 'async_hooks';

/**
 * Runtime guard backing Foundational Rule 2 ("no external call inside a DB tx").
 * PrismaService.$transaction sets inTransaction=true for the duration of the callback;
 * external clients (Stripe/provider/BullMQ wrappers) assert it is false and throw
 * ExternalCallInsideTransactionError otherwise. Turns a latent prod deadlock into a
 * loud test failure (Section 17.7).
 */
const als = new AsyncLocalStorage<{ inTransaction: boolean }>();

export const TxContext = {
  runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return als.run({ inTransaction: true }, fn);
  },
  isInTransaction(): boolean {
    return als.getStore()?.inTransaction === true;
  },
};

export class ExternalCallInsideTransactionError extends Error {
  constructor(what: string) {
    super(
      `External call (${what}) attempted inside a DB transaction — violates Foundational Rule 2. ` +
        `Move the call out of the $transaction callback (do it in a saga step between transactions).`,
    );
    this.name = 'ExternalCallInsideTransactionError';
  }
}

export function assertNotInTransaction(what: string): void {
  if (TxContext.isInTransaction()) {
    throw new ExternalCallInsideTransactionError(what);
  }
}
