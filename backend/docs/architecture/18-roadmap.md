# Section 18 — Implementation Roadmap

## 18.1 Purpose and Governing Principles

This roadmap sequences ASAP from zero to a microservice-ready platform serving 100K+ users. The sequencing is not arbitrary: it is driven by **risk retirement order** and the **foundational invariants** from the canonical foundation. Two architectural commitments shape every phase:

1. **The hard parts are built first, even in the MVP.** Outbox, idempotency, the saga skeleton, the double-entry ledger, and explicit state machines are *not* deferred to "later hardening." They are structurally load-bearing — retrofitting `platform.OutboxEvent`, `platform.IdempotencyKey`, or the `payment.LedgerEntry` double-entry model into a system that shipped without them is a rewrite, not a refactor. We pay this cost in Phase 1.

2. **The microservice cut-lines are honored from day one (Rule 8).** Even as a modular monolith, bounded contexts never share tables or cross-context joins; cross-context references are logical (no FK). This makes Phase 5 a *strangler-fig extraction* rather than a *big-bang rewrite*. We do not "add boundaries later" — we respect them now and extract along seams that already exist.

> **Architectural reasoning:** The classic failure mode is "ship a CRUD MVP, bolt on correctness later." For a money-moving, multi-provider orchestration system where *payment correctness must be 100%*, that path is fatal — you discover the ledger doesn't balance in production with real customer money in flight. We invert it: correctness primitives ship in Phase 1, *features* fan out in Phases 2–4, *topology* changes in Phase 5.

---

## 18.2 Phased Overview

| Phase | Name | Theme | Primary risk retired | Topology |
|-------|------|-------|---------------------|----------|
| 1 | MVP | Correctness skeleton + single-event happy+sad path | "Can we move money correctly and durably?" | Modular monolith, single AZ acceptable for non-prod |
| 2 | Beta | Multi-leg saga + compensation + refunds | "Can we orchestrate cross-provider trips and undo them?" | Monolith, modules hardened |
| 3 | Production Launch | Hardening, security, SLOs, DR | "Will it survive outages, abuse, and audits?" | Multi-AZ, autoscaled |
| 4 | Scale 100K+ | Read scaling, CQRS, queue/cache tuning | "Will it survive load and cost?" | Replicas, partitions, read models |
| 5 | Microservice extraction | Strangler-fig split along schema seams | "Can teams ship independently?" | DB-per-service, durable broker |

---

## 18.3 Phase 1 — MVP

### Goals
Prove the **end-to-end correctness backbone** on the narrowest possible vertical: a single user authorizing and capturing payment for a single event booking through one real provider, with the saga, outbox, idempotency, and ledger all genuinely exercised — including the failure (VOID) path.

### Scope (IN)

| Context | Phase-1 deliverable |
|---------|--------------------|
| Identity & Access | `users`, auth (JWT 15min access + rotating refresh), sessions, device tokens. No MFA yet. |
| Platform/Shared Kernel | `platform.OutboxEvent`, `platform.ProcessedEvent`, `platform.IdempotencyKey`, `platform.WebhookReceipt`, `platform.AuditLog`. Money VO (BigInt minor units + Char(3)). Correlation/causation propagation. Outbox relay worker (BullMQ). |
| Trip Orchestration (CORE) | `trip.Trip`, `trip.TripLeg`, `trip.SagaState`. Saga steps wired: `AUTHORIZE_PAYMENT → RESERVE_EVENT → CAPTURE_PAYMENT → CONFIRM_LEGS → DONE`, plus `COMPENSATE`. `TripStatus` machine enforced in domain. Optimistic `version` on Trip. |
| Event Booking (core) | `booking.EventBooking` only. `BookingStatus` machine. Unique active booking per `tripLegId`. CONFIRMED requires `providerRef`. |
| Payments (CORE) | `payment.PaymentIntent`, `payment.Charge`, `payment.LedgerAccount`, `payment.LedgerEntry`. Stripe **manual capture** (authorize→capture→void). Double-entry ledger (debits==credits). `PaymentStatus` machine incl. `AUTHORIZED`/`CAPTURED`/`VOIDED`. `webhooks/stripe` with `WebhookReceipt` dedupe. Optimistic `version` on PaymentIntent. |
| Provider Integration (ACL) | `provider.ProviderRequest` (unique `[provider, idempotencyKey]`). **One adapter: Ticketmaster sandbox.** Basic retry + timeout. (Circuit breaker stubbed/simple, full impl Phase 2.) |
| Notifications | `notify.Notification` (unique `[userId, templateId, dedupeKey]`). Minimal: booking-confirmed via SendGrid only. FCM optional. |
| Discovery | Thin `events/search`, `events/{id}` proxying Ticketmaster — read-only, lightly cached. No recommendations. |
| API | `/api/v1`: auth/*, events/search, events/{id}, POST/GET /trips, POST /trips/{id}/legs, POST /trips/{id}/quote, POST /trips/{id}/checkout, POST /trips/{id}/confirm (202), GET /trips/{id}, GET /trips/{id}/events (SSE), webhooks/stripe. Idempotency-Key required on state-changing POSTs. Standard error envelope. **`API.md` contract committed.** |

### Scope (OUT, deferred): transport, stay, recommendations, refunds/cancellation, disputes, reconciliation jobs, circuit breakers (full), multi-provider, partitioning, read replicas, multi-AZ prod, chaos/load testing.

### The Phase-1 saga must exercise the sad path
A common mistake is to ship only `AUTHORIZE → RESERVE → CAPTURE → DONE`. We explicitly require the **reserve-fails-after-authorize** path, because it validates compensation semantics that all later phases depend on:

```
AUTHORIZE_PAYMENT (Stripe auth, PaymentStatus=AUTHORIZED)
        │
        ▼
RESERVE_EVENT ──fail──► COMPENSATE: VOID auth (PaymentStatus=VOIDED) ──► Trip=CANCELLED
        │ ok                         (zero money moved — the canonical "most common failure outcome")
        ▼
CAPTURE_PAYMENT (PaymentStatus=CAPTURED, ledger entries posted)
        │
        ▼
CONFIRM_LEGS ──► DONE ──► Trip=CONFIRMED
```

> **Reasoning:** Authorize-then-capture means the dominant failure outcome is **VOID with zero money moved**. If the MVP cannot cleanly void a held authorization when the reservation fails, the system is not safe to take real cards. This is a Phase-1 exit gate, not a nice-to-have.

### Exit criteria (Phase 1)
1. A user can complete a single-event booking end-to-end; `confirm` returns 202, client polls `GET /trips/{id}` and/or SSE to observe `CONFIRMED`.
2. **Ledger balances** (Σ debits == Σ credits) verified by an assertion test across the full happy path.
3. **VOID path proven**: forced `RESERVE_EVENT` failure leaves `Trip=CANCELLED`, `PaymentIntent=VOIDED`, zero ledger movement, EventBooking `RELEASED`/never-confirmed.
4. **Idempotency proven**: replaying the same `Idempotency-Key` on `/checkout` and `/confirm`, and redelivering the same Stripe webhook (`WebhookReceipt`), produces no duplicate charges/legs/events.
5. **Durability proven**: kill the process mid-saga; on restart the saga resumes from persisted `trip.SagaState.step` (PostgreSQL is the system of record).
6. **Outbox proven**: every committed state change has a corresponding `OutboxEvent`; relay is at-least-once; consumers dedupe via `ProcessedEvent`.
7. No Prisma Client in controllers (lint/arch rule enforced). No external call inside any `$transaction` (arch test).
8. `API.md` matches implemented endpoints + error envelope.

### Key risks (Phase 1)
| Risk | Mitigation |
|------|-----------|
| Team treats outbox/idempotency as "later" | Make them exit criteria with executable tests; no feature merges without them. |
| External call sneaks into a DB tx | Static arch test forbidding network clients inside `$transaction` callbacks. |
| Ledger modeled as single-entry "balance column" | Enforce double-entry from day one; the balance-doesn't-reconcile bug is unfixable retroactively with real money. |
| Saga state held in memory / BullMQ only | `trip.SagaState` in Postgres is authoritative; BullMQ is transport only (Rule 1). |

---

## 18.4 Phase 2 — Beta

### Goals
Expand from single-leg to **combined trips** with full saga orchestration, compensation, and refunds — the actual product thesis ("context-aware booking orchestration"). Introduce the resilience primitives (circuit breakers) that multi-provider orchestration demands.

### Scope
| Area | Deliverable |
|------|------------|
| Booking | Add `booking.TransportBooking`, `booking.FareQuote` (with `expiresAt` guard), `booking.StayBooking` (cancellation policy snapshotted). Full `BookingStatus` incl. `RETRYING`, `RELEASING`, `EXPIRED`, `REJECTED`. |
| Trip saga | Full step set incl. `RESERVE_TRANSPORT`, `RESERVE_STAY`. **`PARTIALLY_BOOKED` as first-class state** (anchor event succeeded, secondary leg failed+refunded). Anchor-loss ⇒ full compensation ⇒ `CANCELLED`. `COMPENSATING`, `CANCELLATION_REQUESTED`, `NEEDS_ATTENTION`. |
| Payments | `payment.Refund` + `RefundStatus` machine. Compensation order enforced: **cancel provider reservation FIRST, then refund**. `PARTIALLY_REFUNDED`/`REFUNDED`. Partial capture for partially-booked trips (`capturedAmount<=authorizedAmount`). |
| API | `POST /trips/{id}/cancel`, refunds endpoints. Cancellation/refund return 202 + async resolution via SSE/FCM. |
| Provider Integration | `provider.CircuitState` + real circuit breakers, per-provider rate limiting, normalized retries. Add 2–3 providers (e.g. Amadeus, a rail/bus aggregator, Booking.com). `webhooks/providers/{provider}`. |
| Discovery | `recommendations/trip`. Cache-heavy read path. |
| Notifications | Full `notify.DeliveryAttempt`, retries, FCM + SendGrid, `RETRYING`/`UNCONFIRMED`. |
| Observability | Baseline: structured logs with `correlationId`, basic CloudWatch metrics + dashboards, saga-stuck alerting. |

### Compensation ordering (illustrative)
```
COMPENSATE step, for each booked leg to undo:
  1) Provider ACL: cancel/release reservation  (BookingStatus RELEASING→RELEASED)
  2) ONLY THEN payment.Refund (RefundStatus REQUESTED→...→SUCCEEDED)
  ── never refund before the provider seat is released; ──
  ── a failed release leaves leg NEEDS_ATTENTION, not a silent refund-without-release ──
```

### Exit criteria (Phase 2)
1. A 3-leg trip (event anchor + transport + stay) confirms end-to-end.
2. **`PARTIALLY_BOOKED` proven**: anchor confirms, a secondary leg fails ⇒ that leg refunded, trip rests in `PARTIALLY_BOOKED`, partial capture only, ledger balances.
3. **Anchor-loss proven**: anchor fails ⇒ full compensation, all releases before refunds, `Trip=CANCELLED`, auth `VOIDED`.
4. `FareQuote.expiresAt` enforced (expired quote ⇒ re-quote, no stale-price booking).
5. Circuit breaker opens under provider failure and trips saga into compensation/`NEEDS_ATTENTION` cleanly (no thread/connection exhaustion).
6. Refund compensation order (release-then-refund) enforced and tested.
7. At-least-once event delivery + consumer idempotency holds across the multi-leg saga.

### Key risks (Phase 2)
| Risk | Mitigation |
|------|-----------|
| Compensation ordering inverted (refund before release) | Hard domain rule + saga test; `RefundStatus` cannot enter `PROCESSING` before booking `RELEASED`. |
| Partial-capture math drift vs ledger | Property test: `capturedAmount<=authorizedAmount`, `refundedAmount<=capturedAmount`, ledger balanced after every partial. |
| Provider cascade failure | Circuit breakers + bulkheads per provider; one provider down must not stall the saga pool. |
| `PARTIALLY_BOOKED` treated as an error state | Model it as a *first-class, intended* resting state with its own UX + `trip.partially_booked` event. |

---

## 18.5 Phase 3 — Production Launch

### Goals
Make the correct system **operable, defensible, and survivable** under outages, abuse, and audit. This phase moves nothing functionally new of substance — it makes Phase 2 *trustworthy in production*.

### Scope
- **Security**: external security review + pen test. PCI SAQ-A validation (card data only via Stripe Elements client-side; ASAP never touches PAN). Secrets in Secrets Manager, rotation. Abuse controls: rate limiting, idempotency-key abuse guards, auth hardening, MFA enabled.
- **Disputes**: `payment.Dispute`, `PaymentStatus` `DISPUTED`/`CHARGEBACK`, `payment.chargeback.finalized` handling, evidence submission flow.
- **Reconciliation**: scheduled jobs reconciling Stripe ⇄ `payment.Charge`/`LedgerEntry`, provider state ⇄ `booking.*`, outbox drain monitoring. Detect/repair drift into `NEEDS_ATTENTION`.
- **Observability/SLOs**: full distributed tracing (correlation/causation), RED + saga-funnel metrics, SLOs (read p95<200ms, payment correctness 100%, 99.9% availability), alerting + on-call, **runbooks** per failure mode (stuck saga, open circuit, webhook backlog, refund-failed-needs-attention).
- **Resilience/Infra**: multi-AZ (ECS/Fargate, RDS Multi-AZ, ElastiCache), autoscaling, `health/live` + `health/ready`, graceful drain, **RPO<=5min / RTO<=30min** validated.
- **Testing**: load test to ~200 TPS peak; **chaos testing** (kill provider, kill Stripe, kill Redis, kill an AZ, inject duplicate webhooks).

### Exit criteria (Phase 3)
1. Pen test findings remediated; PCI SAQ-A attested.
2. Chaos suite green: provider outage, Stripe webhook delay/duplication, Redis loss, AZ loss — system degrades to `NEEDS_ATTENTION`/retry, never to incorrect money state.
3. Load test sustains ~20 TPS, survives ~200 TPS peak within SLO.
4. Reconciliation jobs run on schedule; injected drift is detected and surfaced.
5. RPO/RTO validated by a restore drill.
6. Runbooks exist and are exercised in a game-day; SLO dashboards + alerts live.
7. Disputes/chargeback path proven end-to-end against Stripe.

### Key risks (Phase 3)
| Risk | Mitigation |
|------|-----------|
| "Hardening" silently adds features and slips | Freeze functional scope; Phase 3 is reliability/security only. |
| Reconciliation reveals latent ledger drift from Phase 2 | Run reconciliation in Beta-shadow before launch to surface early. |
| Webhook storms / Stripe retries cause dup processing | `WebhookReceipt` unique `[source, externalEventId]` + chaos test for duplicate delivery. |

---

## 18.6 Phase 4 — Scale to 100K+ Users

### Goals
Sustain growth in **reads, queue throughput, and cost** without touching topology. All changes are within the monolith; correctness model is unchanged.

### Scope
- **Read scaling**: RDS **read replicas**; route Discovery/`GET` reads to replicas (system-of-record writes stay on primary). Tolerate replica lag explicitly in read models.
- **CQRS read models for Discovery**: materialized, denormalized read projections built from domain events (`trip.*`, `booking.*`) — Discovery is supporting/read-only and cache-heavy, the natural first CQRS target. Keeps p95<200ms as volume grows.
- **Partitioning**: time/tenant partition high-volume append tables (`platform.OutboxEvent`, `platform.AuditLog`, `notify.DeliveryAttempt`, ledger entries); archival/retention to S3.
- **Queue scaling**: BullMQ concurrency tuning, separate queues per workload (saga vs notifications vs outbox relay vs reconciliation), backpressure, dead-letter handling.
- **Cache tuning**: ElastiCache for Discovery, recommendations, quotes; TTL/stampede protection (request coalescing); cache hit-rate SLOs.
- **Cost/perf**: query optimization, index review, Fargate right-sizing, autoscaling policy tuning.

### Exit criteria (Phase 4)
1. Read p95<200ms held at 100K+ users / 10x current read volume via replicas + CQRS read models.
2. Replica-lag handling proven (no write-after-read correctness violation on the system of record).
3. Outbox relay keeps up at peak with no growing backlog; partition pruning/archival automated.
4. Cost-per-booking trends down or flat as volume rises; documented.
5. No change to ledger/saga correctness semantics (regression suite from Phases 1–3 stays green).

### Key risks (Phase 4)
| Risk | Mitigation |
|------|-----------|
| Reads from replica violate read-your-writes for saga decisions | Saga/payment reads always hit primary; only Discovery/idempotent reads use replicas. |
| CQRS read model diverges from source of truth | Rebuildable from events; staleness budget + reconciliation; Postgres remains system of record. |
| Partitioning migration on hot tables risks downtime | Online/partition-by-range with backfill; rehearse on staging clone. |

---

## 18.7 Phase 5 — Microservice Extraction

### Goals
Enable **independent team/deploy/scale autonomy** by extracting bounded contexts into services — *strangler-fig, no big-bang rewrite*. This is feasible only because Rule 8 was honored throughout: each context already owns its tables/schema, references across contexts are logical (no FK, no cross-context joins), and the in-proc event bus already uses the durable outbox envelope.

### Extraction order (mandated) and why
```
Notifications ─► Discovery ─► Provider Integration ─► Payments ─► Trip + Booking
 (leaf, async)   (read-only,    (ACL, already         (CORE, but   (CORE, extracted
                  rebuildable)   isolated facade)       well-bounded  LAST — orchestrator)
                                                        ledger)
```

| Order | Context | Why this position |
|-------|---------|------------------|
| 1 | **Notifications** | Pure async leaf consumer, no one depends on it synchronously, lowest blast radius — ideal first strangler cut to validate the broker + DB-per-service mechanics. |
| 2 | **Discovery** | Read-only, cache-heavy, state rebuildable from events; failure is degraded search, not lost money. |
| 3 | **Provider Integration** | Already a generic ACL/anti-corruption facade with its own circuit/rate-limit state; cleanest seam, high value (isolates flaky third parties). |
| 4 | **Payments** | CORE and money-critical, but well-bounded (own ledger, Stripe webhooks). Extracted before Trip because Trip references `paymentIntentId` *by ID* — Payments can stand alone behind events. |
| 5 | **Trip + Booking** | The orchestrator/saga + inventory — extracted **last**, as the remaining core, once every collaborator it calls is already a service. |

### Mechanics (strangler-fig)
1. **Broker swap**: replace the in-proc event bus with **SNS/SQS (or Kafka)** while keeping the *same domain-event envelope* (`eventId/eventType/correlationId/causationId/...`). Outbox relay now publishes to the broker; consumers still dedupe via `ProcessedEvent`. At-least-once semantics are unchanged, so consumer idempotency already written in Phases 1–2 carries over.
2. **DB-per-service**: each extracted context takes its **own schema** (already separate, multiSchema) into its own database. No migration of join logic is needed because cross-context joins never existed.
3. **Strangler routing**: API Gateway routes the extracted context's endpoints to the new service; the monolith stops owning them. Traffic shifts incrementally per context, with rollback by routing.
4. **Saga over the wire**: the Trip process manager already coordinates via events + compensation, not in-proc calls — so it tolerates a collaborator becoming a remote service. Compensation-over-rollback (Rule 5) is precisely what makes distributed coordination safe.

### Exit criteria (Phase 5)
1. Each extracted service deploys independently with its own DB schema; no shared tables, no cross-service DB join.
2. Durable broker (SNS/SQS or Kafka) replaces in-proc bus; same event envelope; at-least-once + `ProcessedEvent` dedupe verified end-to-end.
3. Saga/compensation works across the network (chaos: kill an extracted service mid-saga ⇒ resume/compensate, no money error).
4. No big-bang cutover: each context migrated behind routing with rollback; system never fully down.
5. Payment correctness + ledger balance invariants hold across the distributed topology.

### Key risks (Phase 5)
| Risk | Mitigation |
|------|-----------|
| Hidden cross-context coupling surfaces at extraction | Pre-extraction audit asserting no cross-schema FK/join (Rule 8 already enforced); fix in monolith first. |
| Distributed saga partial failures multiply | Compensation-over-rollback + `NEEDS_ATTENTION` + reconciliation already exist; extend reconciliation cross-service. |
| Dual-write / lost events during broker swap | Outbox remains the single publish source of truth; broker is just transport — never publish outside the outbox. |
| Extracting Trip too early | Hard-ordered: Trip+Booking last, only after all its collaborators are services. |

---

## 18.8 Dependency / Milestone View

```
PHASE 1 (MVP — correctness backbone)
  Identity ─┐
  Platform (Outbox/Idempotency/Webhook/Ledger primitives) ─┬─► Trip saga skeleton ─┬─► Payments(auth/capture/void) ─┐
  Provider ACL (Ticketmaster sandbox) ─────────────────────┘                        └─► Event Booking ──────────────┤
                                                                                                                     ▼
                                                                            EXIT: ledger balances, VOID path, idempotency,
                                                                                  durable saga resume, API.md
        │ (everything below DEPENDS on the Phase-1 primitives existing)
        ▼
PHASE 2 (Beta — orchestration + compensation)
  +Transport +Stay ─► Full saga (RESERVE_TRANSPORT/STAY, PARTIALLY_BOOKED) ─► Refunds (release-then-refund)
  +Circuit breakers/CircuitState ─► +Providers ─► Recommendations ─► Notifications full ─► Obs baseline
        │  EXIT: 3-leg trip, PARTIALLY_BOOKED, anchor-loss compensation, quote-expiry
        ▼
PHASE 3 (Prod Launch — survivable)   [no new features]
  Security/pentest/PCI ─ Disputes ─ Reconciliation ─ SLOs/tracing/alerts ─ Multi-AZ/autoscale ─ Load+Chaos ─ Runbooks
        │  EXIT: chaos-green, SLOs met, RPO<=5m/RTO<=30m, recon live
        ▼
PHASE 4 (Scale 100K+)   [topology unchanged]
  Read replicas ─ CQRS read models (Discovery) ─ Partitioning ─ Queue scaling ─ Cache tuning ─ Cost opt
        │  EXIT: p95<200ms at 10x reads, outbox keeps up, cost/booking flat, correctness regression green
        ▼
PHASE 5 (Microservice extraction — strangler-fig)
  Broker swap (SNS/SQS|Kafka, same envelope) ──►  Notifications ─► Discovery ─► Provider ─► Payments ─► Trip+Booking
        EXIT: DB-per-service, distributed saga/compensation green, no big-bang, money invariants hold
```

### Cross-phase invariants (must hold in EVERY phase)
| Invariant | Source rule |
|-----------|-------------|
| PostgreSQL is system of record; Redis/BullMQ/broker are transport | Rule 1 |
| One Prisma `$transaction` per saga step; no external call inside a tx | Rule 2 |
| Every state-changing external call idempotent via persisted key | Rule 3 |
| Outbox guarantees DB-write + publish atomicity | Rule 4 |
| Compensation, not rollback, for cross-system work | Rule 5 |
| State machines explicit + enforced in domain | Rule 6 |
| Prisma never in controllers; repos wrap it; services own tx | Rule 7 |
| Contexts never share tables / cross-context joins (logical refs only) | Rule 8 — *the Phase-5 cut-line* |
| Money = BigInt minor units + Char(3); double-entry ledger is truth | Rule 9 |
| Optimistic concurrency via `version` on Trip/PaymentIntent/Booking | Rule 10 |

> **Closing architectural note:** The roadmap's spine is that **Phase 1 builds the seams and the correctness primitives, and no later phase ever violates them.** Features (Phase 2), trust (Phase 3), and scale (Phase 4) are layered onto an unchanging correctness core; topology (Phase 5) is then a mechanical strangler-fig along seams that have existed since the first migration. This is why ASAP can reach 100K+ users and DB-per-service *without a rewrite* — the expensive decisions were made, and paid for, up front.
