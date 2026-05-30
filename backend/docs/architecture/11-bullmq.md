# Section 11 — BullMQ Architecture

## 11.1 Purpose & Scope

This section specifies how ASAP uses **BullMQ on Redis (ElastiCache)** as the durable, at-least-once execution substrate for asynchronous work: saga step orchestration, Provider ACL calls, Stripe capture/refund, notifications, the outbox relay, the reconciliation backstop, and scheduled trip reminders.

BullMQ is **transport and execution scheduling only**. Per Foundational Rule 1, PostgreSQL is the system of record; every job's authoritative state lives in `trip.SagaState`, `payment.PaymentIntent`, `booking.*`, `payment.LedgerEntry`, and `notify.Notification`. A job that is lost, replayed, or executed twice must never corrupt state — durability and correctness come from Postgres + idempotency, **not** from Redis. Redis losing the entire queue must be survivable: the `reconciliation` queue and `outbox-relay` re-drive any work that was in flight (RPO ≤ 5 min). This is the single most important design stance in this section: **BullMQ is the fast path; Postgres + reconciliation is the truth path.**

```
                         ┌──────────────────────────────────────────────┐
   HTTP 202 (confirm)    │   Postgres (system of record)                │
   ───────────────────►  │   trip.SagaState  payment.*  booking.*       │
                         │   platform.OutboxEvent  IdempotencyKey       │
                         └───────────────┬──────────────────────────────┘
                                         │ (services write DB tx, enqueue AFTER commit)
                         ┌───────────────▼──────────────────────────────┐
   Redis (queues only,   │  booking-saga → provider-calls → payments     │
   noeviction, separate  │  notifications  outbox-relay  reconciliation  │
   from cache cluster)   │  scheduled-reminders        + *-failed (DLQ)  │
                         └───────────────────────────────────────────────┘
```

## 11.2 Redis Topology — Why a Dedicated, `noeviction` Cluster

BullMQ requires durability semantics that are **incompatible with a cache**. We run **two separate ElastiCache Redis deployments**:

| Cluster | Used by | Eviction policy | Persistence | Rationale |
|---|---|---|---|---|
| `redis-cache` | Discovery search/recommendations, rate-limit counters, session lookups | `allkeys-lru` | none / best-effort | Throwaway; losing keys = cache miss |
| `redis-queues` | All BullMQ queues | **`noeviction`** | AOF `appendfsync everysec` | A job is in-flight work; silent eviction = a lost booking/refund |

Reasons a shared cluster is rejected:
1. **Eviction would silently drop jobs.** Under memory pressure an LRU cache evicts keys; if those are BullMQ keys (`bull:booking-saga:*`), in-flight saga steps vanish with no error. `noeviction` instead returns OOM errors that surface as alerts and back-pressure — fail loud, not silent.
2. **BullMQ uses blocking ops + Lua atomics** (`BZPOPMIN`, atomic move scripts). A noisy cache workload competes for the single-threaded Redis CPU and inflates worker latency.
3. **Blast-radius isolation.** A Discovery cache stampede must not stall `payments` capture jobs.

`redis-queues` is a clustered/replicated ElastiCache deployment (Multi-AZ, automatic failover). Note BullMQ uses Lua scripts and hash-tags queue keys; in Cluster mode all keys of one queue must hash to one slot — BullMQ handles this via `{queueName}` hash-tagging. AOF gives us RPO close to 1s for Redis itself; but we **do not rely on it** for correctness — reconciliation is the real backstop.

## 11.3 Queue Inventory & Per-Queue Configuration

All workers run inside the ECS/Fargate monolith tasks as NestJS providers. Concurrency below is **per worker process**; effective concurrency = value × task count. Numbers target ~20 TPS sustained / ~200 peak.

| Queue | Purpose | Concurrency / worker | attempts | backoff | per-job timeout | Rate limit | Ordering |
|---|---|---|---|---|---|---|---|
| `booking-saga` | Drive saga steps via Process Manager; emit step events | 20 | 5 | custom expo + jitter, base 2s | 30s | none | group by `tripId` (1 step/trip at a time) |
| `provider-calls` | Reserve/confirm/cancel via Provider ACL | 30 | 6 | custom expo + jitter, base 1.5s, honor `Retry-After` | 25s (per provider SLA) | **per-provider** limiter | group by `tripLegId` |
| `payments` | Stripe authorize/capture/void/refund | 15 | 8 | custom expo + jitter, base 3s, cap 5m | 20s | global ~80/s (Stripe) | group by `paymentIntentId` |
| `notifications` | FCM + SendGrid dispatch | 50 | 5 | expo + jitter, base 5s | 15s | per-channel (FCM/SendGrid) | none (dedupe instead) |
| `outbox-relay` | Publish `platform.OutboxEvent` → bus | 10 | ∞ (repeatable poll) | fixed 1s re-poll | 10s/batch | none | by partition key (aggregateId) within batch |
| `reconciliation` | Scheduled polling backstop; re-drive stuck sagas/payments | 5 | 3 | expo, base 30s | 60s | none | none |
| `scheduled-reminders` | Pre-trip reminders | 10 | 4 | expo + jitter, base 1m | 15s | per-channel | none |

### Default `JobsOptions`

```ts
// shared base; per-queue overrides above
const baseOpts: JobsOptions = {
  attempts: 5,
  backoff: { type: 'asapExpoJitter', delay: 2000 }, // custom strategy, see 11.4
  removeOnComplete: { age: 3600, count: 1000 },      // keep Redis small; Postgres is truth
  removeOnFail: false,                                // keep failed for DLQ inspection then route
};
```

`removeOnComplete` is aggressive because completed-job history is **not** our audit log — `platform.AuditLog` and `payment.LedgerEntry` are. Keeping millions of completed jobs would bloat `redis-queues` toward OOM (which, under `noeviction`, halts the system).

## 11.4 Retry Policy — Exponential Backoff with Jitter

Fixed exponential backoff causes **thundering-herd retry storms** when a provider or Stripe recovers from an outage — thousands of jobs wake simultaneously. We register a **custom backoff strategy** with full jitter and a cap, and we respect provider `Retry-After`.

```ts
// registered on Worker settings.backoffStrategy
function asapExpoJitter(attempt: number, _type: string, err: Error, job: Job): number {
  const base = job.opts.backoff?.delay ?? 2000;
  const cap  = 5 * 60_000;                         // 5 min ceiling
  // honor provider/Stripe Retry-After if the ACL attached it
  const retryAfter = (err as any).retryAfterMs;
  if (retryAfter) return Math.min(retryAfter, cap);
  const exp = Math.min(cap, base * 2 ** (attempt - 1));
  return Math.floor(Math.random() * exp);          // full jitter: U(0, exp)
}
```

**Retryable vs terminal classification.** Not every failure should consume attempts. The ACL and Payments service throw typed errors:

| Error class | Example | Behavior |
|---|---|---|
| `RetryableError` | 5xx, timeout, circuit half-open trip, Stripe `lock_timeout` | counts an attempt, backs off |
| `RateLimitedError` | provider 429 / Stripe 429 | backoff = `Retry-After`, does **not** always burn an attempt (optionally `job.moveToDelayed`) |
| `TerminalError` | provider 4xx (sold out, invalid), Stripe `card_declined` | **fail fast**: `attempts` short-circuited via `UnrecoverableError`, route straight to DLQ / compensation |

`TerminalError` maps to BullMQ's `UnrecoverableError`, which skips remaining attempts — retrying a `card_declined` 8 times is pure latency and cost. A declined auth instead drives the saga to `PAYMENT_FAILED` immediately.

## 11.5 Idempotent Processors — `jobId` = Idempotency Key (Effectively-Once)

BullMQ guarantees **at-least-once**: a worker can crash after doing work but before acking, and the job is redelivered. We make every processor idempotent so that **at-least-once + idempotency = effectively-once.**

Two layers of dedupe:

**(1) Enqueue dedupe via `jobId`.** The `jobId` IS the idempotency key. BullMQ refuses to add a job whose `jobId` already exists, so duplicate enqueues (retried HTTP, double saga emit) collapse to one.

```ts
// saga step job — deterministic id from saga position
await bookingSaga.add('step', payload, {
  jobId: `saga:${tripId}:${sagaStateId}:${step}:${attemptEpoch}`,
});

// provider reserve — id ties to provider.ProviderRequest unique [provider, idempotencyKey]
await providerCalls.add('reserve', p, {
  jobId: `prov:${provider}:${tripLegId}:${idempotencyKey}`,
});

// stripe capture — id ties to payment.PaymentIntent
await payments.add('capture', p, { jobId: `pay:capture:${paymentIntentId}` });
```

**(2) Execution dedupe in Postgres.** `jobId` collisions only stop *enqueue* duplicates. A redelivered in-flight job (worker crash) bypasses that. So every processor checks/writes the canonical idempotency record **inside the one Prisma `$transaction` for that step** (Rule 2/3):

```ts
async process(job: Job) {
  // 1. external call FIRST if needed (Stripe/provider) — NEVER inside the tx (Rule 2)
  //    guarded by persisted idempotency key so the provider itself dedupes
  const res = await this.providerAcl.reserve(p, p.idempotencyKey); // provider.ProviderRequest unique

  // 2. ONE local tx: record processed marker + apply state, atomically
  await this.uow.run(async (tx) => {
    const seen = await tx.processedEvent.findUnique({ where: { id: job.id! }});
    if (seen) return;                       // effectively-once: re-delivery is a no-op
    await tx.processedEvent.create({ data: { id: job.id!, ... }});
    await tx.booking.confirm(tripLegId, res.providerRef);  // domain invariant enforced
    await tx.outboxEvent.create({ data: bookingReservedEvent });
  });
}
```

Key points:
- **External call before the tx**, never inside it (Rule 2). The external call is itself idempotent via the persisted key (`provider.ProviderRequest [provider, idempotencyKey]`, Stripe `Idempotency-Key`, `payment.IdempotencyKey`), so re-running it returns the same result rather than double-charging or double-reserving.
- The processed-marker (`platform.ProcessedEvent`) and the state mutation commit together. If the tx commits but the worker crashes before ack, redelivery sees `ProcessedEvent` and no-ops.
- `consumer dedupe` for **event consumers** also uses `platform.ProcessedEvent` keyed by `eventId` — same mechanism.

## 11.6 Ordering & FIFO via Job Groups (keyed by aggregateId)

Per-aggregate ordering matters: two `provider-calls` jobs for the same `tripLegId` (reserve then cancel) must not run concurrently; two `payments` jobs for one `paymentIntentId` (capture then refund) must serialize. Global FIFO would destroy throughput, so we use **BullMQ Pro Groups** (or, on OSS, a Redis per-key concurrency lock; see tradeoff) keyed by the aggregate:

| Queue | Group key | Guarantee |
|---|---|---|
| `booking-saga` | `tripId` | one saga step per trip in flight (matches Process Manager: sequential steps) |
| `provider-calls` | `tripLegId` | reserve → confirm → cancel never interleave for a leg |
| `payments` | `paymentIntentId` | authorize → capture → refund serialize; protects optimistic `version` |

Groups give **per-key FIFO + concurrency=1 within key**, while keeping high parallelism *across* keys (different trips/legs run in parallel). This complements — does not replace — optimistic concurrency (`version Int`, Rule 10): even if ordering is violated by an operational edge, the version check rejects the stale write and the job retries. **Ordering is an optimization; the version column is the correctness guarantee.**

> Tradeoff: BullMQ OSS lacks native groups. Options: (a) BullMQ Pro (license) for first-class group concurrency; (b) wrap the processor body in a short-lived Redis lock (`SET key val NX PX`) on the aggregate key and `moveToDelayed` on contention. ASAP chooses **Pro for `payments`/`provider-calls`** (correctness-sensitive, low volume) and lock-based for others, revisiting if license cost dominates.

## 11.7 Flow Producers — Saga Step Chaining

The Trip saga (`AUTHORIZE_PAYMENT → RESERVE_EVENT → RESERVE_TRANSPORT → RESERVE_STAY → CAPTURE_PAYMENT → CONFIRM_LEGS → DONE`) is expressed with **BullMQ FlowProducer**, so a parent saga-coordination job only runs after its children (the actual provider/payment work) complete. This gives us a dependency tree with automatic fan-in.

```
FlowProducer.add({
  name: 'saga.confirm', queueName: 'booking-saga',     // parent: advance SagaState
  data: { tripId },
  children: [
    { name: 'capture', queueName: 'payments',          // runs after reserves succeed
      data: { paymentIntentId },
      children: [
        { name: 'reserve', queueName: 'provider-calls', data: { tripLegId: evt } },   // anchor
        { name: 'reserve', queueName: 'provider-calls', data: { tripLegId: transport }},
        { name: 'reserve', queueName: 'provider-calls', data: { tripLegId: stay } },
      ]}
  ]});
```

Important boundaries:
- The Flow tree expresses **happy-path sequencing only**. Failure handling is **NOT** done by failing the parent — it is **compensation, not rollback** (Rule 5). A failed secondary `reserve` does not nuke the tree; the saga transitions Trip → `COMPENSATING` (or `PARTIALLY_BOOKED` if the anchor event already succeeded and only a secondary leg failed+refunded), and the `COMPENSATE` step enqueues *release* + *refund* jobs in the canonical order: **cancel provider reservation FIRST, then refund** (RefundStatus flow). Losing the **anchor** event triggers full compensation → `CANCELLED` with the auth **VOIDED** (zero money moved — the cheap path).
- The FlowProducer parent reads children results from Postgres `SagaState`, **not** from in-Redis children return values, so a Redis flush mid-flow is recoverable by reconciliation re-driving from `SagaState.step`.
- Because saga state is in Postgres, the Flow is a *convenience for chaining*, not the source of truth. We could implement the same with manual enqueues; Flows reduce orchestration glue and give clean fan-in for the parallel reserves.

## 11.8 Repeatable Jobs — Outbox Relay, Reconciliation, Reminders

Three queues run on **repeatable (cron/every) schedules**. Repeatable jobs use a deterministic `repeatJobKey`, so redeploys don't create duplicates.

**`outbox-relay`** — the heart of Rule 4 (atomic publish). Services write business state **and** a row to `platform.OutboxEvent` in the **same** Prisma `$transaction`; they never call BullMQ/the bus inside the tx. A repeatable job (every ~500ms–1s) polls unpublished outbox rows, publishes to the bus / fans them into target queues, and marks them published — all idempotently (consumers dedupe via `platform.ProcessedEvent` on `eventId`).

```ts
@Cron-style repeatable: outbox-relay every 1000ms
process() {
  // claim a batch with FOR UPDATE SKIP LOCKED to allow multiple relay workers safely
  const batch = await repo.claimUnpublished({ limit: 200 });   // SKIP LOCKED
  for (const e of batch) await bus.publish(e);                 // at-least-once
  await repo.markPublished(batch.map(b => b.id));              // own tx
}
```
`FOR UPDATE SKIP LOCKED` lets us scale relay workers horizontally without double-publishing. Ordering within an aggregate is preserved by claiming ordered-by `(aggregateId, occurredAt, seq)`.

**`reconciliation`** — the backstop that makes Redis loss survivable (RPO ≤ 5 min). Every ~1–5 min it scans for **stuck aggregates**:
- `trip.SagaState` rows where `step != DONE` and `updatedAt` older than threshold → re-enqueue the step (idempotent jobId, so no duplication if the original is still alive).
- `payment.PaymentIntent` in `PROCESSING`/`AUTHORIZED` longer than expected → query Stripe (source of truth for money) and converge state; catches missed webhooks.
- `booking.*` in `RESERVED`/`RETRYING`/`RELEASING` past TTL → re-drive confirm or release.
- Orphaned `provider.ProviderRequest` / expired `booking.FareQuote` → mark `quote_expired`.

This loop is why **AOF on `redis-queues` is a nicety, not a dependency**: even a total Redis flush self-heals within one reconciliation cycle.

**`scheduled-reminders`** — delayed/repeatable jobs that emit `notification.dispatch.requested` ahead of trip start. Scheduled by `delay` to fire at `tripStart - N`; cancellation of a trip removes the reminder via its deterministic `jobId`.

## 11.9 Dead Letter Queue (DLQ) Handling → `NEEDS_ATTENTION` + Alert

Each primary queue has a paired **`<queue>-failed` DLQ**. When a job exhausts `attempts` (or throws `TerminalError`), the `failed` Worker event routes it:

```ts
worker.on('failed', async (job, err) => {
  if (job.attemptsMade < job.opts.attempts && !(err instanceof UnrecoverableError)) return; // will retry
  await dlq.add('dead', { original: job.toJSON(), err: serialize(err) },
                { jobId: `dead:${job.id}` });
  // converge the aggregate to a human-actionable terminal-ish state
  await sagaService.markNeedsAttention(job.data.tripId, { reason, jobId: job.id });
  await alerting.page('NEEDS_ATTENTION', { tripId, queue, correlationId });
});
```

Effects:
- **Trip → `NEEDS_ATTENTION`** (TripStatus) — a first-class state meaning "automation gave up; human/runbook required." Money is never left ambiguous: if a capture/refund is the failed job, the saga ensures the safe side (prefer VOID/refund over silent charge).
- **`payment.Refund` → `FAILED_NEEDS_ATTENTION`** (RefundStatus) for failed refunds — operators reconcile against Stripe.
- **Alert**: CloudWatch alarm on `<queue>-failed` depth + a paging integration with `correlationId` for trace lookup.
- **Replay**: DLQ jobs are inspected and, once the root cause is fixed, re-promoted to the source queue (`job.retry()` semantics) — idempotency makes replay safe.

DLQ depth, retry rate, oldest-waiting-job age, and worker stalled count are all CloudWatch metrics with alarms; a rising `payments-failed` depth is a sev-1.

## 11.10 Graceful Shutdown / Drain on ECS Task Stop

Fargate sends `SIGTERM` then waits `stopTimeout` (we set **120s**) before `SIGKILL`. A worker mid-Stripe-capture must not be killed silently.

```
ECS SIGTERM
  → set /health/ready = NOT READY  (ALB drains, stops new HTTP)
  → worker.close(false)            // stop pulling NEW jobs, let active finish
  → await activeJobs (bounded by stopTimeout - margin)
  → flush metrics, queue.close(), redis.quit()
  → process exit
```

- `Worker.close()` stops fetching new jobs and waits for active handlers to finish (BullMQ moves un-acked active jobs back to wait on lock expiry anyway).
- Jobs that **don't** finish within the drain window are not lost: their **lock expires** and another worker (or post-restart worker) picks them up — and the processor is idempotent, so re-execution is safe.
- We set BullMQ `lockDuration` > p99 job duration (e.g. 60s for `payments`) and rely on `lockRenewTime` so long captures aren't prematurely re-delivered.
- `health/ready` flipping first ensures the load balancer and saga producers stop targeting a draining task.

This is why **idempotency is non-negotiable**: graceful drain is best-effort; correctness under abrupt `SIGKILL` (spot reclaim, OOM) is guaranteed by the Postgres idempotency markers, not by clean shutdown.

## 11.11 At-Least-Once + Idempotency = Effectively-Once (summary)

```
 enqueue dup  ─┐
               ├─ jobId collision (Redis)        ─┐
 HTTP retry  ──┘                                  ├─►  ONE logical effect
 worker crash ─► redelivery (at-least-once) ─► ProcessedEvent / persisted
                                                idempotency key (Postgres) ─┘
 Redis flush ─► reconciliation re-drive ─────► same idempotency key, no-op
```

No single layer claims exactly-once (impossible across a network). The **composition** — at-least-once delivery + persisted idempotency keys + per-aggregate ordering + optimistic version + double-entry ledger invariants — yields **effectively-once** observable behavior, with money correctness at 100% (NFR).

## 11.12 Tradeoffs vs SQS / Kafka, and Microservice Migration Path

| Concern | BullMQ (chosen) | SQS | Kafka |
|---|---|---|---|
| Ops cost in a monolith | In-process, no extra infra beyond Redis we already run | Managed, near-zero ops | Heavy (brokers, ZK/KRaft, partitions) |
| Delayed/repeatable/cron jobs | First-class (reminders, outbox, reconciliation) | Limited (15-min delay max; needs EventBridge) | Not native; needs add-ons |
| Per-key ordering | Groups / locks per aggregateId | FIFO queues (300 TPS/​group limits) | Per-partition ordering (strong) |
| Flow/DAG chaining | FlowProducer native | None | None |
| Throughput ceiling | Bound by single-thread Redis (fine at ~200 TPS) | Very high | Very high |
| Replay / log retention | Weak (jobs ephemeral) | Weak | **Strong** (durable log, replay) |
| Backpressure on outage | `noeviction` OOM (loud) | Unbounded buffer | Unbounded log |

**Why BullMQ now:** ASAP is a modular monolith at ~20 TPS sustained / ~200 peak. BullMQ gives delayed jobs, repeatable cron (outbox/reconciliation/reminders), flows, and per-key concurrency **without** standing up Kafka or fanning everything through SQS+EventBridge. Postgres is already the system of record, so we don't need Kafka's durable log for correctness — the **outbox + reconciliation** pattern provides durability and replay-from-truth.

**Why not Kafka yet:** its strengths (durable partitioned log, cross-service streaming, huge throughput) are exactly what we'll want **after** the microservice split, but today they'd add major ops burden for capabilities we get cheaper via outbox.

**Migration path (microservice-ready, Rule 8 — contexts never share tables/joins):**
1. **Today:** in-process BullMQ workers; cross-context communication already goes through `platform.OutboxEvent` → bus with the canonical event envelope, never via direct table access.
2. **Step 1 — extract a context** (e.g. Payments or Provider Integration) into its own service. Its BullMQ queues (`payments`, `provider-calls`) move with it onto its **own `redis-queues`**; nothing else changes because the queue was always context-local.
3. **Step 2 — swap the bus transport.** Replace the in-VPC bus behind `outbox-relay` with **Kafka/SNS-SQS** for inter-service events. The outbox relay's only change is its publish target; producers/consumers keep the same envelope and `ProcessedEvent` dedupe. BullMQ can remain the **intra-service** worker engine even after extraction.
4. **Step 3 — partition keys → Kafka keys.** The `aggregateId` group keys we use for ordering map directly onto Kafka partition keys, preserving per-aggregate ordering across the boundary.

The decoupling that makes this cheap is structural: queues are **context-local**, ordering keys are **aggregate IDs**, and all cross-context truth flows through the **outbox + event envelope** — so swapping the transport (BullMQ ↔ Kafka/SQS) never touches domain or saga logic.
