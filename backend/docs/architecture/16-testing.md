# Section 16 — Testing Strategy

## 16.1 Objectives & Philosophy

ASAP is a money-moving orchestration system. The dominant failure cost is not a crash — it is **money moving without inventory, or inventory held without money**. Therefore the testing strategy is not optimized for line coverage; it is optimized for *invariant survival under adversarial conditions*. Every test tier exists to defend a specific class of the foundational invariants:

| Invariant under defense | Primary defending tier |
|---|---|
| `sum(debits) == sum(credits)` (double-entry) | Unit (ledger math) + Integration (repo) |
| `capturedAmount <= authorizedAmount`, `refundedAmount <= capturedAmount` | Unit (PaymentIntent SM) + E2E |
| CONFIRMED trip ⇒ all required legs CONFIRMED | Unit (Trip SM) + E2E saga |
| At-most-one active booking per `tripLegId` | Integration (DB unique constraint) |
| Idempotency: replayed request ⇒ exactly one effect | Integration + E2E replay tests |
| Outbox: DB write + publish atomic, at-least-once | Integration (relay) + Chaos |
| Compensation: provider release BEFORE refund | E2E + Chaos |
| No money without inventory (anchor lost ⇒ VOID, nothing charged) | Chaos (kill worker mid-saga) |

**Guiding principle: test the seams the foundational rules forbid us from crossing.** Because Rule 2 forbids external calls inside a DB tx and Rule 8 forbids cross-context joins, the highest-value tests are at the *boundaries*: saga step transactions, outbox relay, Provider ACL, Stripe webhook ingestion, and idempotency keys.

```
                       ▲  fewer, slower, broader
        ┌──────────────┴──────────────┐
        │   Chaos / Load / Soak       │  ← invariant survival under failure
        ├─────────────────────────────┤
        │   E2E (ephemeral env)       │  ← full saga happy + failure + replay
        ├─────────────────────────────┤
        │   Contract (Pact)           │  ← API.md & provider adapter alignment
        ├─────────────────────────────┤
        │   Integration (Testcontainers) │ ← repos/Prisma/Redis/BullMQ/ACL
        ├─────────────────────────────┤
        │   Unit (Jest, pure)         │  ← SMs, invariants, ledger, saga logic
        └─────────────────────────────┘
                       ▼  many, fast, narrow
```

## 16.2 Tier 1 — Unit Tests (domain layer, pure, fast)

**Scope:** Pure domain logic with **zero I/O** — no Prisma, no Redis, no network. This is enabled directly by Clean Architecture (Rule 7: Prisma never reaches controllers; repositories wrap it) and Rule 6 (state machines explicit + enforced in the domain layer). The domain layer takes plain inputs and returns decisions/events.

**Runner:** Jest (`ts-jest` or `swc` transform), run on every push, target < 30s wall-clock for the entire unit suite. No Testcontainers, no `--runInBand`.

### What gets unit-tested

| Target | Examples of cases |
|---|---|
| **TripStatus state machine** | Legal: `DRAFT→PLANNING→PENDING_PAYMENT→BOOKING→CONFIRMED`. Illegal: `DRAFT→CONFIRMED` throws `IllegalTransition`. `BOOKING→PARTIALLY_BOOKED` only when anchor CONFIRMED + secondary failed+refunded. Guard: `→BOOKING` requires `PaymentIntent === AUTHORIZED`. Anchor-loss ⇒ `COMPENSATING→CANCELLED`. |
| **PaymentStatus SM (manual capture)** | `CREATED→…→AUTHORIZED→CAPTURED`; `AUTHORIZED→VOIDED` (the common failure outcome — zero money moved); reject `CAPTURED→AUTHORIZED`; `CAPTURED→PARTIALLY_REFUNDED→REFUNDED`. |
| **BookingStatus SM** | `PENDING→RESERVED→CONFIRMED`; `RESERVED→RELEASING→RELEASED`; `RETRYING` loops bounded; `EXPIRED` on FareQuote past `expiresAt`. |
| **RefundStatus SM** | Compensation ordering encoded: a refund cannot reach `PROCESSING` unless the provider reservation release is recorded first. `FAILED_NEEDS_ATTENTION` terminal-but-flagged. |
| **Money VO** | BigInt minor units, currency Char(3) mismatch throws, no float ever, rounding rules, `add/sub/negate`. |
| **Double-entry ledger math** | Every posting balances (`Σdebits==Σcredits`); `refunded<=captured`; partial capture/refund arithmetic; currency isolation per `LedgerAccount`. |
| **Saga decision logic** | Given `(SagaState.step, lastEvent, legResults)` → next step ∈ {AUTHORIZE_PAYMENT, RESERVE_EVENT, RESERVE_TRANSPORT, RESERVE_STAY, CAPTURE_PAYMENT, CONFIRM_LEGS, COMPENSATE, DONE}. Pure decision function: easy to exhaustively test. |
| **Outbox envelope builder** | `eventType` matches `context.aggregate.pastTense`; `correlationId`/`causationId` propagation; `eventVersion` set. |

### Illustrative unit test (saga decision is a pure function)

```ts
// trip/domain/saga.decider.ts — no I/O, returns a decision the service will persist
export function decideNext(state: SagaState, evt: DomainEvent): SagaDecision { /* ... */ }

describe('saga decider — anchor loss', () => {
  it('losing anchor event triggers full compensation, not partial', () => {
    const decision = decideNext(
      { step: 'RESERVE_EVENT', anchorLegId: 'leg-1' },
      bookingEventFailed({ legId: 'leg-1' }),
    );
    expect(decision.nextStep).toBe('COMPENSATE');
    expect(decision.targetTripStatus).toBe('COMPENSATING'); // → CANCELLED, auth VOIDED
    expect(decision.partialBookingAllowed).toBe(false);
  });
});
```

**Coverage gate:** revenue-critical domain modules (Payments ledger/SM, Trip saga decider, Refund SM) are gated at **100% branch coverage** here because they are pure and there is no excuse to miss a branch (see §16.10).

**Property-based testing** (`fast-check`) is mandatory for ledger and money math: generate random sequences of debits/credits/captures/refunds and assert `Σdebits==Σcredits` and `refunded<=captured<=authorized` always hold. This catches the long-tail arithmetic bugs that example-based tests miss.

## 16.3 Tier 2 — Integration Tests (real infra, Testcontainers)

**Scope:** Everything below the domain layer that the unit tier deliberately stubs: repositories against **real PostgreSQL**, Prisma migrations, Redis, BullMQ workers, the outbox relay, and Provider ACL adapters against mocked HTTP.

**Infrastructure:** `@testcontainers/postgresql`, `@testcontainers/redis`. Each integration suite boots a throwaway Postgres + Redis, runs **`prisma migrate deploy`** (NOT `db push` — we test the real migration path that production uses), and seeds minimal fixtures. This validates that migrations themselves are correct and that schema-per-context (Rule 8) is honored.

### 16.3.1 Repository & transaction-boundary tests

These prove the rules that unit tests cannot reach:

| Test class | What it proves |
|---|---|
| **DB-enforced uniqueness** | `booking` table: inserting a second active booking for the same `tripLegId` violates the unique constraint → at-most-one active booking invariant is enforced by the DB, not just app code. Same for `provider.ProviderRequest [provider, idempotencyKey]`, `platform.WebhookReceipt [source, externalEventId]`, `notify.Notification [userId, templateId, dedupeKey]`, `platform.IdempotencyKey`. |
| **Optimistic concurrency** | Two concurrent updates to the same `Trip`/`PaymentIntent`/`Booking` with stale `version Int` → exactly one wins, the other gets a version conflict and retries. Run with real concurrent connections. |
| **One-tx-per-saga-step** | Assert each saga step's service method opens exactly one `$transaction` and performs **no network call** inside it (verified via a tx-scoped Prisma extension that throws if an HTTP client is invoked during a tx — a test-time guard enforcing Rule 2). |
| **Schema isolation** | Static + runtime check: no query joins across `trip.*` ↔ `payment.*` ↔ `booking.*`. Cross-context refs are by ID only. A test parses generated SQL and fails on cross-schema joins. |

### 16.3.2 Outbox relay integration

The outbox is the atomicity backbone (Rule 4) and is integration-tested directly:

```
[Service tx] ── writes domain rows + platform.OutboxEvent  (ONE $transaction)
                                  │ commit
[Outbox relay worker] ── polls UNPUBLISHED → publishes to BullMQ → marks PUBLISHED
[Consumer] ── checks platform.ProcessedEvent (dedupe) → handles → records ProcessedEvent
```

Tests:
- Write-then-crash-before-publish: kill the relay after the tx commits but before publish; restart; assert the event is still published exactly once (at-least-once + consumer dedupe ⇒ effectively-once effect).
- Duplicate delivery: deliver the same `eventId` twice; assert `ProcessedEvent` short-circuits the second; assert no duplicate side effect.
- Ordering within an aggregate: events for one `tripId` are processed in `occurredAt`/causation order.

### 16.3.3 BullMQ worker integration

Real Redis + real workers. Test: retry/backoff config, DLQ routing for poison messages, job idempotency (replayed job with same key ⇒ no double effect), and **backpressure** (queue depth caps, rate limiting). Workers must be safe to run N-at-once (horizontal scale on Fargate).

### 16.3.4 Provider ACL adapter tests

| Mode | Tooling | Purpose |
|---|---|---|
| **Mocked HTTP** | `nock` / `msw` | Deterministic CI tests of normalization, retry, circuit breaker, rate limiter, idempotency-key persistence into `provider.ProviderRequest`. Inject 429/500/timeout/malformed-body and assert `provider.CircuitState` opens, half-opens, closes. |
| **Provider sandboxes** | Ticketmaster/Eventbrite/Amadeus/Booking.com/Uber sandbox/test creds | Nightly (not per-PR) job that hits real provider sandboxes to detect contract drift the mocks would hide. Quarantined from the blocking gate (sandboxes are flaky); failures open an alert, not a red PR. |

## 16.4 Tier 3 — Contract Tests (consumer-driven, Pact)

Two contract surfaces, both consumer-driven so the canonical `API.md` and provider integrations cannot silently drift.

### 16.4.1 Public API contract (frontend ⇄ backend)

The frontend (and SSE/mobile clients) is the **consumer**; the NestJS API is the **provider**. Pact contracts assert the shape of the REST surface defined in the foundation:

- Error envelope `{ error: { code, message, details[], correlationId, retryable } }` shape is contract-locked.
- `POST /trips/{id}/confirm` returns **202** (async booking) — contract asserts status + body, so a refactor to 200 breaks the build.
- `Idempotency-Key` header required on state-changing POSTs (contract verifies 400/422 when absent).
- Cursor pagination shape on `GET /trips`.
- Bearer JWT auth (401 without token).

Pact Broker (or PactFlow) gates deploys via **`can-i-deploy`**: backend cannot deploy a version that breaks a verified consumer contract. This keeps `API.md` honest as executable spec.

### 16.4.2 Provider adapter contracts

Each adapter (Ticketmaster, Amadeus, etc.) has a contract describing the **subset of the provider response the adapter depends on** (consumer = ASAP adapter). Combined with the nightly sandbox tests (§16.3.4), this gives early warning of provider-side breaking changes while keeping per-PR CI fast and deterministic.

## 16.5 Tier 4 — End-to-End Tests (full saga, ephemeral env)

**Environment:** An ephemeral, per-PR (or per-merge) environment — full modular monolith container + RDS-equivalent Postgres + ElastiCache-equivalent Redis (Testcontainers compose for local; a short-lived ECS/Fargate task + isolated Postgres/Redis for CI). **Stripe test mode** with **Stripe CLI test webhooks** (`stripe trigger`, `stripe listen --forward-to`). Providers run as high-fidelity mock servers (msw/WireMock) seeded with scripted responses, since provider sandboxes are too flaky and rate-limited for the blocking gate.

E2E drives only the **public REST/SSE API** — never internal services — exercising the real saga, outbox, BullMQ, and webhook ingestion end to end.

### 16.5.1 Core E2E scenarios

1. **Happy path:** `POST /trips` → `/legs` → `/quote` → `/checkout` (PaymentIntent CREATED→AUTHORIZED) → `/confirm` (202) → poll `GET /trips/{id}` / SSE until `CONFIRMED`. Assert: all required legs CONFIRMED with `providerRef`, `PaymentStatus=CAPTURED`, ledger balanced, outbox drained, `trip.confirmed` emitted.
2. **PARTIALLY_BOOKED (first-class):** anchor event reserved+CONFIRMED, a secondary leg fails after auth. Assert: secondary refunded, `Trip=PARTIALLY_BOOKED`, captured reflects only the anchor, `trip.partially_booked` emitted, `refundedAmount<=capturedAmount`.
3. **Anchor loss ⇒ full compensation:** anchor reserve fails ⇒ `COMPENSATING→CANCELLED`, auth **VOIDED**, **nothing charged**, all reservations released, ledger nets to zero.
4. **Idempotency replay:** resend `POST /trips/{id}/confirm` with the **same `Idempotency-Key`** → identical response, **exactly one** PaymentIntent, no second authorization. Replay `POST /trips`, `/checkout`, refund endpoints similarly.
5. **Duplicate Stripe webhook:** deliver the same `payment_intent.amount_capturable_updated` event twice with the same `externalEventId` → `platform.WebhookReceipt` unique constraint dedupes → single state transition.
6. **Compensation ordering:** force a refund path and assert provider reservation is **released BEFORE** the refund is issued (RefundStatus reaches `AWAITING_PROVIDER`/`PROCESSING` only after release recorded).
7. **FareQuote expiry:** transport quote past `expiresAt` at confirm ⇒ `booking.transport.quote_expired`, re-quote flow, no stale-price capture.
8. **Cancellation:** `POST /trips/{id}/cancel` from CONFIRMED ⇒ `CANCELLATION_REQUESTED→…`, snapshotted stay cancellation policy honored, correct refund computed.

## 16.6 Tier 5 — Load & Performance Testing

**Tooling:** k6 (primary, scripted scenarios + thresholds in CI) and Artillery (for quick soak profiles). Run against a production-shaped ephemeral env.

| Test | Profile | Pass criteria (tied to NFRs) |
|---|---|---|
| **Read load** | `events/search`, `GET /trips/{id}` to peak | read **p95 < 200ms** (cache-served); cache hit ratio tracked |
| **Booking throughput** | confirm saga at **20 TPS sustained**, ramp to **~200 TPS peak** | no failed bookings due to capacity; saga latency budget met; zero invariant violations |
| **Soak** | 20 TPS for 4–8h | no memory leak, no connection leak, no unbounded queue growth, no `NEEDS_ATTENTION` accumulation |
| **Connection-pool saturation** | drive concurrency beyond Prisma/PgBouncer pool size | graceful degradation (429/`retryable:true`), **no deadlocks, no lost writes**; verifies pool sizing for Fargate task count |
| **Queue backpressure** | flood BullMQ faster than workers drain | bounded queue depth, backpressure surfaced, DLQ not flooded, no job loss; autoscaling signal fires |
| **Stripe/provider rate-limit** | exceed provider/Stripe limits | ACL rate limiter + circuit breaker shed load gracefully; no cascading failure |

Load tests assert **invariants still hold at peak**, not just latency — a sampled post-run audit confirms `Σdebits==Σcredits` and no money-without-inventory across all trips created during the run.

## 16.7 Tier 6 — Chaos / Resilience Testing

The most important tier for ASAP. Each chaos experiment has a **steady-state hypothesis** ("no money moves without inventory; ledger stays balanced; no booking without `providerRef`") that must hold after fault injection. Run in the ephemeral env via a fault-injection harness (Toxiproxy for network faults, programmatic worker kill, Stripe/provider mock fault modes).

| Fault injected | Hypothesis verified | Mechanism under test |
|---|---|---|
| **Provider timeout / 5xx** | Circuit opens, retries bounded, leg → `RETRYING`/`FAILED`, compensation triggers; **no orphaned reservation** | `provider.CircuitState`, ACL retry, saga compensation |
| **Kill worker mid-saga** (after AUTHORIZE, before RESERVE) | On restart, `SagaState.step` resumes from durable Postgres; **no double-charge, no double-reserve** | Durable saga (Rule 1), idempotency keys (Rule 3) |
| **Kill worker between DB commit and outbox publish** | Event still published exactly-once on relay restart | Outbox (Rule 4) + `ProcessedEvent` dedupe |
| **Duplicate webhook (Stripe & provider)** | Single effect; `WebhookReceipt` unique constraint dedupes | `[source, externalEventId]` uniqueness |
| **Redis / ElastiCache failover** | Jobs survive or safely re-enqueue; no job processed twice with effect; reads degrade to DB | BullMQ durability, cache-aside fallback |
| **DB / RDS failover** | In-flight tx rolled back cleanly; saga resumes; **RPO ≤ 5min, RTO ≤ 30min** validated | Postgres as system of record |
| **Network partition (Toxiproxy) app↔Stripe** | No partial money state; auth either completes idempotently or is retried; never double-authorized | Idempotency key on every state-changing external call |
| **Capture succeeds at Stripe but ACK lost** | Reconciliation/webhook converges PaymentIntent to `CAPTURED`; no double-capture on retry | Idempotent capture + webhook reconciliation |
| **Compensation interrupted mid-flight** | Resumes; provider released BEFORE refund; ends `SUCCEEDED` or `FAILED_NEEDS_ATTENTION` (flagged, never silently lost) | Refund SM ordering |

**Game days:** quarterly manual chaos game days replay these in a staging env with on-call present, validating runbooks and the `NEEDS_ATTENTION` operator workflow.

## 16.8 Failure-Scenario Test Matrix (cross-reference to Section 7)

This matrix maps each Section 7 failure scenario to the tier(s) that test it, the invariant defended, and the expected terminal state. **This is the contract between Section 7 (failure design) and the test suite — every Section 7 row must have at least one ✓.**

| # | Section 7 failure scenario | Unit | Int | E2E | Load | Chaos | Invariant defended | Expected terminal outcome |
|---|---|:--:|:--:|:--:|:--:|:--:|---|---|
| F1 | Stripe authorize fails | ✓ | ✓ | ✓ | | ✓ | no inventory reserved without auth | `Trip=PAYMENT_FAILED`, no reservations, $0 |
| F2 | Authorize OK, anchor event reserve fails | ✓ | | ✓ | | ✓ | no money without inventory | `COMPENSATING→CANCELLED`, auth **VOIDED**, $0 |
| F3 | Anchor OK, secondary leg fails | ✓ | | ✓ | | ✓ | partial is first-class | `PARTIALLY_BOOKED`, secondary refunded, `refunded<=captured` |
| F4 | Capture fails after legs reserved | ✓ | ✓ | ✓ | | ✓ | no confirmed booking without capture | compensate: release legs, `Trip→NEEDS_ATTENTION`/CANCELLED |
| F5 | Provider timeout / 5xx | | ✓ | ✓ | ✓ | ✓ | circuit breaker, bounded retry | leg `RETRYING→FAILED` → compensation |
| F6 | FareQuote expired at confirm | ✓ | ✓ | ✓ | | | no stale-price capture | `quote_expired`, re-quote, no capture on stale price |
| F7 | Duplicate confirm (same Idempotency-Key) | | ✓ | ✓ | ✓ | | exactly-once effect | single PaymentIntent, identical response |
| F8 | Duplicate Stripe/provider webhook | | ✓ | ✓ | | ✓ | webhook dedupe | single transition; `WebhookReceipt` blocks dup |
| F9 | Worker killed mid-saga | | ✓ | | | ✓ | durable saga, no double-charge | resume from `SagaState.step`; one charge, one reserve |
| F10 | DB commit OK, outbox publish lost | | ✓ | | | ✓ | outbox atomic publish | event published exactly-once on relay restart |
| F11 | Redis / cache failover | | ✓ | | ✓ | ✓ | derived-store resilience | reads degrade to DB; no job double-effect |
| F12 | RDS failover mid-booking | | | | | ✓ | system-of-record durability | saga resumes; RPO≤5m/RTO≤30m |
| F13 | Network partition app↔Stripe | | ✓ | | | ✓ | idempotent external call | never double-authorized; converges |
| F14 | Capture succeeds, ACK lost | | ✓ | ✓ | | ✓ | idempotent capture + reconcile | `CAPTURED` once; no double-capture |
| F15 | Refund/compensation interrupted | ✓ | ✓ | ✓ | | ✓ | release-before-refund ordering | `SUCCEEDED` or `FAILED_NEEDS_ATTENTION` (flagged) |
| F16 | Stripe dispute / chargeback received | ✓ | ✓ | ✓ | | | ledger correctness under dispute | `DISPUTED`/`CHARGEBACK`, ledger entries posted |
| F17 | Notification provider (FCM/SendGrid) down | ✓ | ✓ | | | ✓ | notify never blocks booking | `RETRYING→FAILED/UNCONFIRMED`; saga unaffected |
| F18 | Queue backpressure / traffic spike | | ✓ | | ✓ | ✓ | bounded queues, autoscale | backpressure surfaced; no job loss |
| F19 | Connection-pool exhaustion | | | | ✓ | ✓ | graceful degradation | 429 `retryable:true`; no deadlock/lost write |
| F20 | Abuse / replay flood on POST | | ✓ | ✓ | ✓ | | idempotency + rate limit | dup requests collapsed; abusive load shed |

> Coverage rule: a Section 7 scenario with no ✓ in any column is a **release blocker**. CI fails the build if the matrix and the test registry diverge (the matrix is encoded as machine-readable test tags, see §16.10).

## 16.9 Test Data Management

| Concern | Approach |
|---|---|
| **Determinism** | Fixed seed data via Prisma seed scripts per context schema; faker seeded with a constant; clock injected (`Clock` port) so `expiresAt`/cancellation-policy windows are controllable. |
| **Money/PCI** | **No real card data, ever** — Stripe test cards/tokens only (PCI SAQ-A preserved; card data never touches ASAP). Test PANs include 3DS-required (`REQUIRES_ACTION`) and decline cards. |
| **PII** | Synthetic users; no production data in lower envs. If prod-shaped data is needed for load tests, it is **masked/anonymized** in a one-way transform. |
| **Isolation** | Each integration/E2E run gets a fresh Testcontainers DB (or a per-run schema) — no shared mutable state, parallel-safe. |
| **Builders** | Domain object mother/builder functions (`aTrip().inBooking().withAuthorizedPayment()`) so tests read as scenarios, not setup boilerplate. |
| **Idempotency keys** | Generated per-test UUIDs; replay tests deliberately reuse a captured key. |
| **Provider/Stripe fixtures** | Recorded sandbox responses checked into the repo and version-pinned; nightly job detects drift. |

## 16.10 CI Gates & Coverage Targets

**Pipeline (per PR, blocking):**

```
lint + typecheck (tsc --strict)
  → unit (Jest, <30s)
  → integration (Testcontainers: PG+Redis, prisma migrate deploy)
  → contract verify (Pact) + can-i-deploy
  → E2E core scenarios (Stripe test mode, mock providers)
  → k6 smoke (low-rate, threshold check)
  → matrix consistency check (Section 7 ↔ test tags)
→ merge allowed
```

**Nightly / scheduled (non-blocking alerting):** provider-sandbox integration, full k6 peak + soak, full chaos suite.

**Coverage targets (differentiated by risk — line/branch coverage is a floor, not the goal):**

| Module class | Target | Rationale |
|---|---|---|
| **Payments (ledger, PaymentIntent SM, Refund SM), Trip saga decider, Outbox relay** | **~100% branch** | Revenue-critical; "payment correctness 100%" NFR. Pure logic ⇒ no excuse for gaps. Mutation testing (Stryker) enforced here — coverage that survives mutation, not just executes lines. |
| **Booking ACL, Provider adapters** | ≥ 90% | Money-adjacent, but partly I/O. |
| **Identity, Notifications, Discovery** | ≥ 80% | Supporting contexts; lower blast radius. |
| **Controllers / DTO mapping** | ≥ 70% | Thin; mostly covered by contract + E2E. |

Additional hard gates:
- **No external call inside a DB tx** — enforced at test time by a Prisma extension guard; any violation fails CI (defends Rule 2).
- **No cross-context schema join** — SQL-introspection test fails CI (defends Rule 8).
- **Section 7 matrix completeness** — each F-scenario must resolve to ≥1 tagged, passing test, or the build is red.
- **Mutation score** on payments/saga modules must exceed a threshold (e.g. ≥ 85%) — prevents "coverage theater" on the modules where correctness is non-negotiable.

## 16.11 Tradeoffs, Alternatives & Risks

| Decision | Alternative considered | Why chosen / tradeoff |
|---|---|---|
| Testcontainers (real Postgres) for integration | SQLite/in-memory or mocked Prisma | Prisma + Postgres-specific constraints (partial unique indexes, `version` concurrency, schema-per-context) are the *thing under test*; a fake DB would hide the exact invariants we care about. Cost: slower CI, Docker dependency — mitigated by parallelism and unit-tier speed. |
| Mock providers (msw) in E2E gate; sandboxes nightly | Provider sandboxes in the blocking gate | Sandboxes are flaky, rate-limited, and shared — they'd make the gate non-deterministic. Tradeoff: mocks can drift from reality → mitigated by nightly sandbox + contract tests. |
| Pact consumer-driven contracts | OpenAPI schema validation only | Schema validation proves shape, not *interaction semantics* (202-async, idempotency, error envelope). Pact + `can-i-deploy` prevents silent breakage. Cost: broker infra + discipline. |
| Chaos as first-class blocking-adjacent tier | Chaos only in prod (pure chaos engineering) | ASAP's correctness is dominated by failure paths; we cannot wait for prod to discover double-charges. We run chaos in ephemeral/staging pre-release. Tradeoff: chaos envs are expensive and slower — run nightly, not per-PR. |
| Mutation testing on payments/saga | Branch coverage only | Coverage can be 100% while assertions are weak. Mutation testing is the only way to *prove* the revenue-critical assertions bite. Cost: slow — scoped to the few critical modules. |
| k6 + Artillery | JMeter / Gatling | k6 scripts in TS/JS (same language, thresholds-as-code in CI); Artillery for quick soak. Avoids JVM/Scala toolchain divergence. |

**Residual risks & mitigations:** (1) *Mock/reality drift* — nightly sandbox + contract drift alerts. (2) *Flaky E2E eroding trust* — quarantine lane, zero-tolerance flake policy, retries only with root-cause tickets. (3) *Chaos coverage gaps* — game days surface untested faults; each prod incident becomes a new chaos test (regression-by-design). (4) *Load env ≠ prod sizing* — periodic re-baselining against real RDS/ElastiCache instance classes before major launches.
