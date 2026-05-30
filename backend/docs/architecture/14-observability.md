# Section 14 — Observability Architecture

## 14.1 Objectives & Scope

ASAP is a saga-driven booking orchestrator where a single user action (`POST /trips/{id}/confirm`) fans out across **Trip Orchestration → Payments → Provider Integration → Booking → Notifications**, hops three async transports (HTTP, BullMQ, the `platform.OutboxEvent` relay), and touches money. When something goes wrong — Stripe times out after authorizing, a provider confirms but the reply is lost, a saga stalls in `NEEDS_ATTENTION` — the operator's first question is always **"what happened to *this* trip, end to end, across every context and transport?"** Observability exists to answer that question in seconds, not by grepping seven modules' logs.

Three pillars, one correlation spine:

| Pillar | Tool | Primary question answered |
|---|---|---|
| **Logging** | Structured JSON → CloudWatch Logs | "What exactly happened, with what data, in what order?" |
| **Metrics** | OpenTelemetry → CloudWatch EMF + Prometheus/AMP | "Is the system healthy *in aggregate*? Are we burning SLO budget?" |
| **Tracing** | OpenTelemetry → AWS X-Ray (or Tempo) | "Where did *this one* request spend time / fail, across transports?" |

Underpinning all three: a single **`correlationId`** that is born at the API edge, threaded through `AsyncLocalStorage`, stamped on every log, propagated as W3C `traceparent` into BullMQ jobs and outbox envelopes, and stored on `payment.PaymentIntent` and `trip.SagaState` for forensic joins. Plus a **durable, queryable audit trail** (`platform.AuditLog`) distinct from operational logs.

**Methodologies.** We apply **RED** (Rate, Errors, Duration) to every *request-serving* surface (REST endpoints, BullMQ workers, saga steps, provider calls) and **USE** (Utilization, Saturation, Errors) to every *resource* (Postgres connection pool, Redis, BullMQ queues, Fargate CPU/mem, circuit breakers). RED tells us if users are suffering; USE tells us *why* and *what will break next*.

**Design tradeoff — managed (CloudWatch/X-Ray) vs. self-hosted (Prometheus/Grafana/Tempo).** We standardize on **OpenTelemetry as the instrumentation API** and treat the backend as a swappable exporter decision. The OTel Collector (sidecar on Fargate / ADOT) fans out to CloudWatch EMF for metrics and X-Ray for traces *by default* (lowest ops burden, aligns with the AWS-native NFR stack, no extra cluster to run at 20 TPS). We keep a Prometheus remote-write / OTLP path open because (a) high-cardinality custom metrics (per-provider, per-saga-step) are far cheaper in Prometheus/AMP than CloudWatch's per-metric pricing, and (b) microservice-readiness (Rule 8) means we may later want a vendor-neutral mesh. **Decision: OTel SDK everywhere; Collector owns export routing; never call a vendor SDK directly from domain code.** This keeps the cut-line clean and avoids a forklift migration if costs or topology change.

## 14.2 Logging

### 14.2.1 Structured JSON, one schema everywhere

All logs are single-line JSON (pino under Nest's logger, or `nestjs-pino`). No `console.log`, no human-formatted strings in prod. Every line carries the **correlation envelope** plus standard fields:

```jsonc
{
  "ts": "2026-05-31T10:22:31.114Z",
  "level": "info",
  "msg": "saga.step.completed",
  "service": "asap-api",
  "context": "trip",              // bounded context emitting the log
  "env": "prod",
  "correlationId": "c-7f3a...",   // request/saga-wide spine
  "requestId": "req-91be...",     // single HTTP request / single job execution
  "traceId": "4bf92f3577b34da6", // == OTel trace id (links logs<->traces)
  "spanId": "00f067aa0ba902b7",
  "tripId": "trip_01H...",
  "paymentId": "pi_01H...",        // payment.PaymentIntent id (NOT Stripe pi_ secret)
  "userId": "usr_01H...",
  "sagaStep": "CAPTURE_PAYMENT",
  "durationMs": 412,
  "outcome": "ok"
}
```

The four identity fields — `correlationId`, `requestId`, `tripId`, `paymentId`, `userId` — are **mandatory and auto-injected**, never passed manually by call sites (manual passing rots). They are populated from `AsyncLocalStorage`, so a `logger.info('booking.event.reserved')` deep in a repository automatically inherits the full context.

### 14.2.2 Context propagation: Nest interceptor + AsyncLocalStorage

```
HTTP request
   │  CorrelationInterceptor (global)
   │   - read inbound 'correlationId' header / X-Request-ID; else mint UUID
   │   - read inbound 'traceparent'; start/continue OTel span
   │   - als.run({ correlationId, requestId, traceId, spanId, userId(from JWT) }, next)
   ▼
Controller → Service (tx boundary) → Repository (Prisma)
   │  als.get() everywhere — logger auto-enriches
   ▼
Service enqueues BullMQ job → injects { correlationId, traceparent } into job.data.meta
   ▼
Worker process → als.run(meta) before handling → same fields reappear
   ▼
Service writes platform.OutboxEvent → envelope carries correlationId + traceparent
   ▼
Outbox relay publishes → consumer als.run(envelope.meta) → continuity preserved
```

A single `ClsModule`/`AsyncLocalStorage` store is the source of truth. The **same enrichment** is reused in three entry points: the HTTP interceptor, the **BullMQ worker wrapper**, and the **outbox consumer dispatcher**. Without this, async transports silently drop context and traces fragment into orphan spans — the single most common observability failure in saga systems, so it is a hard architectural requirement, not a nicety.

**Why ALS over passing a `ctx` object?** Clean Architecture forbids leaking transport concerns into domain signatures (Rule 7 spirit). Threading a `ctx` param through every repository/service method pollutes the domain API and is forgotten exactly where it matters (error paths). ALS keeps domain signatures pure while guaranteeing enrichment. Tradeoff: ALS has a small perf cost and can be lost across un-awaited promises / manual `setImmediate` — mitigated by linting against fire-and-forget and wrapping all queue/event boundaries explicitly.

### 14.2.3 Log levels

| Level | Use | Examples |
|---|---|---|
| `error` | Invariant violated, money at risk, manual action likely | ledger debits≠credits, saga→`NEEDS_ATTENTION`, refund `FAILED_NEEDS_ATTENTION`, webhook signature invalid |
| `warn` | Degraded but self-healing | provider retry, circuit `HALF_OPEN`, optimistic-concurrency version conflict + retry, `FareQuote` expired |
| `info` | State transitions, business milestones | every `TripStatus`/`PaymentStatus`/`BookingStatus` transition, saga step start/complete, event published/consumed |
| `debug` | Wire detail, off in prod (sampled on) | normalized provider payloads, Stripe request ids, BullMQ job lifecycle |
| `trace` | Deep dev only | never in prod |

Rule of thumb: **every state-machine transition logs at `info`**, every entry into `COMPENSATING`/`NEEDS_ATTENTION` logs at `error`. This makes the log a reconstructable event sourcing of the saga even independent of `trip.SagaState`.

### 14.2.4 PII redaction

ASAP holds PII (names, emails, device tokens) and is **PCI SAQ-A** — card data must *never* transit our servers, so logging it is both a leak and a compliance violation. Redaction is enforced at the logger transport, not left to call sites:

- **pino `redact` paths** strip a denylist before serialization: `*.email`, `*.phone`, `*.cardNumber`, `*.cvc`, `*.authorization`, `*.password`, `*.refresh_token`, `req.headers.authorization`, `req.headers["idempotency-key"]`(hash instead), FCM `deviceToken`, Stripe `client_secret`.
- **Allowlist for IDs:** opaque internal IDs (`tripId`, `pi_…` our id, `usr_…`) are *not* PII and are kept — they are the join keys. Stripe `client_secret`/PaN/secrets are hard-banned.
- **Email/phone** logged only as a salted hash (`emailHash`) when correlation is needed, never raw.
- A unit test asserts a known PII fixture object is fully redacted; a CI guard rejects new logger calls that interpolate raw `user.email`-shaped fields.
- Belt-and-suspenders: a **CloudWatch Logs data-protection policy** with managed PII identifiers masks anything that slips through at ingest.

### 14.2.5 Shipping & retention

Fargate stdout → **`awslogs`/FireLens (Fluent Bit)** → **CloudWatch Logs**, one log group per service (`/asap/prod/api`, `/asap/prod/worker`). Fluent Bit adds buffering + retry so a CloudWatch blip doesn't drop logs or block the app. Retention: operational logs 30 days hot, then S3 export + lifecycle to Glacier for 1 yr; **audit logs separate (see 14.6)**. CloudWatch Logs Insights is the ad-hoc query surface; the canonical runbook query is *"all logs WHERE tripId = X ORDER BY ts"*, which — thanks to the propagation spine — returns the complete cross-context story of one booking.

## 14.3 Metrics

### 14.3.1 The named four, plus the saga/financial set

All metrics are emitted via the OTel Metrics API (counters, histograms, up-down counters, observable gauges) and exported as CloudWatch EMF (auto-extracted, no PutMetricData throttling) and/or Prometheus. Naming follows OTel semconv where possible; custom metrics are namespaced `asap.<context>.<name>`.

**RED on request surfaces** (REST, worker, saga step, provider call): each surface emits `*.requests` (counter, by route/result), `*.errors` (counter, by error class), `*.duration` (histogram → p50/p95/p99).

| Metric | Type | Key dimensions | Why it matters |
|---|---|---|---|
| **Booking success rate** | derived: `booking.confirmed / booking.attempted` | provider, legType(event/transport/stay) | Core product KPI; drop = provider or inventory problem |
| **Payment success rate** | derived: `payment.authorized / payment.intent.created`, and capture success | currency, cardCountry | Money correctness leading indicator; SLO-bearing |
| **Cache hit rate** | `discovery.cache.hits / (hits+misses)` | cacheKind (search/recs/event) | Drives read p95<200ms NFR; drop = Redis/Discovery degradation |
| **Provider failure rate** | `provider.requests{result=error} / total` | provider, errorType(timeout/4xx/5xx/circuit_open) | Upstream health; feeds circuit + capacity decisions |
| Saga step latency/duration | histogram | step (AUTHORIZE_PAYMENT…CONFIRM_LEGS) | Find the slow/stuck step; per-step SLO |
| Saga step outcome | counter | step, outcome(ok/retry/compensate/needs_attention) | Compensation rate, stuck detection |
| Queue depth | observable gauge | queueName | USE saturation; backlog forming |
| Queue lag (oldest job age) | observable gauge | queueName | True latency of async path; better than depth alone |
| DLQ size | observable gauge | queueName | Poison messages / systemic failure; **alert on growth** |
| Circuit breaker state | observable gauge (0=closed,1=half,2=open) | provider | Upstream isolation visibility; **alert on open** |
| p50/p95/p99 latency | histogram | route, transport | RED duration; SLO |
| Stripe webhook lag | histogram | eventType | `now - event.created` at receipt; reconciliation health |
| Refund success rate | `refund.succeeded / refund.requested` | reason | Compensation correctness; trust/chargeback impact |
| Reconciliation discrepancy count | gauge | type(ledger/stripe/provider) | Money-correctness tripwire (see 14.5) |
| Outbox lag | gauge (unpublished age) | — | Event delivery health; relay stall = saga stall |
| Idempotency replay rate | counter | scope | Duplicate-request / retry-storm signal |

**USE on resources:** Postgres pool (in-use/idle/waiting, slow-query count), Redis (mem, evictions, latency), BullMQ (active/waiting/delayed/failed), Fargate (CPU/mem util, throttle), RDS (CPU, IOPS, replica lag, free storage).

### 14.3.2 Where metrics are emitted — and where they are NOT

Rule 2 forbids external calls inside a DB tx. **Metrics emission is in-process and cheap, but recording must not be inside the `$transaction` callback** (it shouldn't influence tx duration or, worse, throw and abort a financial write). Pattern: the service records the *outcome* after the tx commits, in the saga-step orchestration layer:

```ts
// Service / saga step orchestrator (owns tx boundary per Rule 7)
const t0 = hrtime();
const result = await this.uow.run(/* one Prisma $transaction, no I/O */);
sagaStepDuration.record(elapsed(t0), { step, outcome: result.outcome });
sagaStepCount.add(1, { step, outcome: result.outcome });
```

Success-rate metrics are **derived from counters**, not gauges, so they survive restarts and are correctly aggregated across Fargate tasks (a per-task gauge of "rate" would be meaningless when load-balanced). Histogram bucket boundaries are tuned per surface (provider calls 50ms→30s; cache 1ms→200ms).

## 14.4 Distributed Tracing

### 14.4.1 End-to-end across all three transports

A trace must survive the two places saga systems normally lose it: **the BullMQ hop** and **the outbox publish hop**. We use **W3C Trace Context (`traceparent`)** as the wire format everywhere.

```
[client] ──traceparent──▶ POST /trips/{id}/confirm
  span: http.confirm
   └─ span: trip.checkout (tx: PaymentIntent CREATED, OutboxEvent payment.intent.created)
        └─ enqueue saga job  ← inject traceparent into job.data.meta
                                  (span link: producer→consumer)
  ─────────────────── async boundary ───────────────────
[worker] dequeue ← extract traceparent → continue trace
  span: saga.AUTHORIZE_PAYMENT
   ├─ span: db.tx (PaymentIntent: REQUIRES_CONFIRMATION→…)   [USE: tx duration]
   └─ span: provider.stripe.authorize  ← OUTSIDE tx (Rule 2) [RED: provider]
        └─ Stripe (X-Ray/OTel http auto-instr)
  span: saga.RESERVE_EVENT
   └─ span: provider.ticketmaster.reserve  → booking.event.reserved (OutboxEvent)
  ─────────────────── outbox publish ───────────────────
  outbox envelope carries traceparent  → consumer extracts → child span continues
  span: notifications.dispatch  → FCM/SendGrid call
```

**Span taxonomy (one span per):**
- **Saga step** — `saga.<STEP>` (AUTHORIZE_PAYMENT, RESERVE_EVENT, …, COMPENSATE), attributes: `tripId`, `saga.step`, `saga.attempt`, `trip.status.from/to`, `outcome`.
- **Provider call** — `provider.<provider>.<op>`, attributes: `provider`, `idempotencyKey`(hashed), `circuit.state`, `http.status`, `retry.count`. These are the spans whose duration feeds **provider failure rate** and circuit decisions.
- **DB transaction** — `db.tx.<operation>`, attributes: `db.statement`(sanitized), `tx.rows`, `version.conflict`(for optimistic concurrency retries). Span makes clear the tx contains **no** external child span (visual enforcement of Rule 2 — a provider span nested under `db.tx` is a review red flag and can be asserted in tests).
- **Outbox publish & consume** — producer/consumer span pair with span links so the causal graph survives at-least-once redelivery.

### 14.4.2 Context plumbing & `causationId`/`correlationId` alignment

The domain-event envelope already carries `correlationId`, `causationId`, `tripId`. We **add `traceparent` (and `tracestate`) to the envelope `meta`** so OTel and the domain causal chain stay aligned: `correlationId` ↔ trace `correlationId` baggage, `causationId` ↔ parent span. The outbox relay does **not** start a fresh root trace per publish (that would shatter the story); it continues from the stored `traceparent`. BullMQ has no native context propagation, so the **enqueue/dequeue wrapper** does inject/extract explicitly — this is shared infra in the Platform/Shared Kernel, written once.

### 14.4.3 Sampling

At ~20 TPS sustained / ~200 peak, full traces are affordable but X-Ray/storage cost and noise argue for **tail-based sampling at the Collector**: keep **100% of traces that (a) error, (b) touch Payments/refunds, (c) enter COMPENSATING/NEEDS_ATTENTION, (d) exceed latency SLO**, and head-sample the happy path (e.g. 10%). Tail sampling (vs. head) is chosen specifically because the *interesting* booking failures are rare and must never be dropped — a head sampler would discard exactly the 1-in-1000 stuck saga an operator needs. Money paths are **always 100% sampled**: correctness > cost.

## 14.5 Dashboards, SLOs & Alerting

### 14.5.1 SLOs (error-budget driven)

| SLO | Target | Window | Source metric |
|---|---|---|---|
| API availability | 99.9% | 30d rolling | REST RED errors/requests (5xx, excl. client 4xx) |
| Read latency (search/event) | p95 < 200ms | 30d | discovery duration histogram + cache hit rate |
| **Payment correctness** | **100%** | continuous | ledger balance + reconciliation discrepancy = 0 (hard SLO, no error budget) |
| Confirm→terminal saga latency | p95 < 60s (async) | 30d | saga end-to-end duration |
| Booking success rate | ≥ 99% (excl. inventory-unavailable) | 7d | booking confirmed/attempted |
| Refund success rate | ≥ 99.5% within 24h | 7d | refund succeeded/requested |

**Burn-rate alerting** (multi-window: fast-burn 2%/1h *and* slow-burn 5%/6h) on the budgeted SLOs avoids both alert fatigue and silent budget exhaustion. Payment correctness is **not** budgeted — any discrepancy pages immediately.

### 14.5.2 Dashboards (per audience)

- **Exec/Product:** booking success rate, payment success rate, GMV (from ledger), trips by `TripStatus`.
- **SRE / on-call (RED+USE):** per-route p50/95/99 + error rate; queue depth/lag/DLQ per queue; circuit state per provider; Fargate/RDS/Redis USE; outbox lag.
- **Payments:** authorize vs capture vs void vs refund rates, Stripe webhook lag, dispute/chargeback counters, ledger debit-credit delta (must be 0), reconciliation discrepancy gauge.
- **Saga health:** funnel of trips through each `SagaState.step`; count of trips in `NEEDS_ATTENTION` / `COMPENSATING` / `PARTIALLY_BOOKED`; per-step duration heatmap; compensation rate.
- **Provider:** per-provider RED, failure type breakdown, circuit timeline, retry counts, rate-limit rejections.

### 14.5.3 Alerting matrix

| Alert | Condition | Severity | Routes to |
|---|---|---|---|
| Payment failure spike | payment success rate < 98% (5m) OR capture errors > N | **P1 page** | Payments on-call |
| Ledger imbalance | any `LedgerEntry` group debits≠credits | **P1 page** | Payments on-call |
| Reconciliation discrepancy | Stripe↔ledger or provider↔booking mismatch > 0 | **P1 page** | Payments on-call |
| DLQ growth | DLQ size increasing 3 consecutive intervals OR > threshold | **P1 page** | Platform on-call |
| Circuit open | `circuit.state == OPEN` for any provider (sustained) | **P2** | Platform on-call |
| Saga stuck | trips in `NEEDS_ATTENTION` > threshold, or step age > SLA | **P1 page** | Trip on-call |
| Stuck `PARTIALLY_BOOKED`/`COMPENSATING` | count rising / age > SLA | **P2** | Trip on-call |
| Stripe webhook lag | webhook lag p95 > 5m (RPO boundary) | **P2** | Payments |
| Refund failures | refund in `FAILED_NEEDS_ATTENTION` | **P1 page** | Payments |
| Outbox stalled | unpublished outbox age > 2m | **P1 page** | Platform |
| Read latency SLO burn | p95 > 200ms fast-burn | **P2** | SRE |
| Resource saturation | RDS CPU>80%/replica lag>5s, Redis evictions>0, pool waiters>0 | **P2** | SRE |

Alerts are defined as code (CloudWatch alarms via CDK/Terraform), routed through **SNS → PagerDuty/Opsgenie**, and **every alert carries `correlationId`/`tripId` context fields and a direct link to its runbook** (see 14.7). Alerts without a runbook link fail CI review.

## 14.6 Audit Trail

`platform.AuditLog` is a **separate, append-only, durable** record distinct from operational CloudWatch logs — logs are for debugging and expire; the audit trail is for compliance, dispute evidence, and money forensics, and is retained ~7 years in S3 (Object Lock / WORM).

| Aspect | Operational logs | `platform.AuditLog` |
|---|---|---|
| Store | CloudWatch (30d) | Postgres + S3 WORM (years) |
| Trigger | any log call | **business-significant state change** only |
| Mutability | ephemeral | append-only, immutable |
| Schema | freeform JSON | structured: `actor`, `action`, `aggregateType/Id`, `before`, `after`, `correlationId`, `causationId`, `ts`, `reason` |

**What is audited:** every `PaymentStatus`/`RefundStatus` transition, every `TripStatus` transition into a money-affecting state, manual operator interventions (force-cancel, manual refund approval, `NEEDS_ATTENTION` resolution), auth/MFA events, and every Stripe/provider webhook accepted (cross-ref `platform.WebhookReceipt`). Audit rows are written **inside the same saga-step `$transaction`** as the state change they describe (so they are atomic with the fact, never lost), then projected to S3 by the outbox. This is the difference between "we think we refunded" (logs) and "here is the immutable, time-stamped, actor-attributed record that we refunded" (audit) — essential for chargeback defense and PCI/financial review.

## 14.7 On-Call Runbooks (pointers)

Each P1/P2 alert links to a runbook keyed by failure mode; runbooks are the bridge from "an alert fired" to "the operator acted safely." Pointers:

| Runbook | Trigger | First moves (summary) |
|---|---|---|
| **RB-PAY-01 Auth/capture failure** | payment failure spike | Check Stripe status + webhook lag; confirm `PaymentIntent` state; verify `VOIDED` (zero money moved) is the common case before escalating. |
| **RB-PAY-02 Ledger imbalance / reconciliation** | discrepancy alert | Freeze affected captures; run reconciliation job; diff `LedgerEntry` vs Stripe vs `provider.ProviderRequest`; never hand-edit ledger — post compensating entries. |
| **RB-SAGA-01 Stuck in NEEDS_ATTENTION** | saga stuck | Pull `trip.SagaState` + full `tripId` log/trace; identify failed step; decide retry vs compensate (cancel reservation FIRST, then refund per RefundStatus order). |
| **RB-SAGA-02 PARTIALLY_BOOKED** | rising count | Confirm anchor event CONFIRMED; verify secondary leg refunded; ensure user notified; resolve to CONFIRMED or escalate compensation. |
| **RB-QUEUE-01 DLQ growth** | DLQ alert | Inspect poison job; check if poison (drop+audit) vs systemic (pause worker, fix, replay with idempotency keys intact). |
| **RB-PROV-01 Circuit open** | circuit open | Confirm provider outage vs our config; respect HALF_OPEN probing; communicate degraded mode; do not force-close blindly. |
| **RB-OUTBOX-01 Outbox stalled** | outbox lag | Check relay worker health + Redis; restart relay; verify no double-publish (consumers idempotent via `ProcessedEvent`). |
| **RB-WEBHOOK-01 Stripe webhook lag** | webhook lag | Verify endpoint reachable, signature valid, `WebhookReceipt` dedupe working; replay missed events from Stripe dashboard. |

Every runbook opens with the **"one trace, one trip" query** (`tripId`/`correlationId` → CloudWatch Insights + X-Ray) because the propagation spine in 14.2/14.4 makes the full cross-context, cross-transport story reconstructable from a single ID — which is the entire point of this observability architecture.

## 14.8 Failure-Mode Coverage Summary

| Threat (per brief) | Detected by | Alert/runbook |
|---|---|---|
| Provider outage | provider failure rate, circuit state, RED | Circuit open → RB-PROV-01 |
| Stripe failure | payment success rate, webhook lag, trace span | RB-PAY-01 |
| Duplicate requests | idempotency replay rate, `ProcessedEvent` dedupe metric | (informational, no page) |
| Abuse / traffic spike | RED rate, queue depth/lag, rate-limit rejections, USE saturation | Resource saturation P2 |
| Infra failure | USE (RDS/Redis/Fargate), outbox lag, health/ready | Saturation / Outbox stalled |
| Money incorrectness | ledger delta, reconciliation discrepancy (hard SLO) | RB-PAY-02 (P1) |
| Stuck saga / lost reply | NEEDS_ATTENTION count, saga step age, DLQ | RB-SAGA-01 / RB-QUEUE-01 |

**Net:** correlation-first logging, RED+USE metrics over OpenTelemetry, end-to-end traces that survive the BullMQ and outbox hops, error-budget SLOs with burn-rate alerts, a money-grade immutable audit trail, and runbook-linked alerts — together making every booking, payment, and compensation in ASAP fully reconstructable and every failure mode observable before it becomes a customer or correctness incident.
