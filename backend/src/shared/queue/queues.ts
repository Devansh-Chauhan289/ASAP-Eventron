/**
 * BullMQ queue name constants (Section 11). Queues run on the ElastiCache Redis
 * configured with `noeviction` (jobs are durable, never evicted) — separate from the
 * cache instance which uses allkeys-lru.
 */
export const QUEUES = {
  SAGA: 'saga', // trip booking saga step driver
  OUTBOX_RELAY: 'outbox-relay', // publishes platform.OutboxEvent -> domain-event consumers
  DOMAIN_EVENTS: 'domain-events', // fan-out of published domain events to handlers
  NOTIFICATIONS: 'notifications', // FCM/SendGrid delivery
  PROVIDER_CALLS: 'provider-calls', // (Phase 2) async provider retries
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Default retry/backoff policy for durable side-effect jobs (Section 11). */
export const DEFAULT_JOB_OPTS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: false, // keep failed jobs for DLQ inspection
};
