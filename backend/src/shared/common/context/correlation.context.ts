import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

/**
 * Correlation context propagated via AsyncLocalStorage (Section 14). Every log line,
 * domain event envelope, and outbound call can read the active correlationId / requestId /
 * tripId / paymentId / userId without threading them through every function signature.
 */
export interface RequestContext {
  correlationId: string;
  requestId: string;
  userId?: string;
  tripId?: string;
  paymentId?: string;
}

const als = new AsyncLocalStorage<RequestContext>();

export const CorrelationContext = {
  run<T>(ctx: Partial<RequestContext>, fn: () => T): T {
    const full: RequestContext = {
      correlationId: ctx.correlationId ?? randomUUID(),
      requestId: ctx.requestId ?? randomUUID(),
      userId: ctx.userId,
      tripId: ctx.tripId,
      paymentId: ctx.paymentId,
    };
    return als.run(full, fn);
  },
  get(): RequestContext | undefined {
    return als.getStore();
  },
  set(patch: Partial<RequestContext>): void {
    const store = als.getStore();
    if (store) Object.assign(store, patch);
  },
  correlationId(): string | undefined {
    return als.getStore()?.correlationId;
  },
};
