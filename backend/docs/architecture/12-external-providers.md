# Section 12 — External Provider Architecture

## 12.1 Purpose & Scope

This section specifies the **Provider Integration** bounded context — ASAP's generic **Anti-Corruption Layer (ACL)** that isolates the core domain (Trip Orchestration, Booking, Payments) from the wild, heterogeneous, and frequently-failing world of third-party providers (Ticketmaster, Eventbrite, Amadeus, Booking.com, Uber, Stripe).

The ACL exists to enforce **Foundational Rule 8**: every cross-context reference is logical, and every provider is a *replaceable detail*. No core domain code ever imports a vendor SDK, sees a vendor field name, or depends on a vendor's HTTP status semantics. The ACL is the single seam at which the outside world is *normalized into ASAP's ubiquitous language* and at which the outside world's failures are *contained* so they degrade rather than corrupt.

Architectural position in the saga: the Trip saga (Section on Trip Orchestration) executes steps `RESERVE_EVENT`, `RESERVE_TRANSPORT`, `RESERVE_STAY`, `AUTHORIZE_PAYMENT`, `CAPTURE_PAYMENT` by calling **Booking** / **Payments** application services. Those services call **Provider Integration ports**. Per **Rule 2**, every provider call happens *outside* any Prisma `$transaction` — the DB tx records intent (`ProviderRequest` row + outbox), commits, and only then does a BullMQ worker make the network call. This section designs that network-call layer.

```
            CORE DOMAIN                         ACL (this section)              OUTSIDE WORLD
 ┌───────────────────────────┐    ports     ┌──────────────────────────┐   ┌──────────────────┐
 │ Trip Saga / Process Mgr   │──────────────▶│ EventProviderPort        │──▶│ Ticketmaster API │
 │ Booking app services      │              │ TransportProviderPort    │──▶│ Eventbrite API   │
 │ Payments app services     │              │ StayProviderPort         │──▶│ Amadeus API      │
 │                           │              │ RideProviderPort         │──▶│ Booking.com API  │
 │ (speaks ASAP DTOs only)   │◀─────────────│ PaymentGatewayPort       │──▶│ Uber API         │
 └───────────────────────────┘  normalized  │  (adapters + resilience) │──▶│ Stripe API       │
                                 DTOs        └──────────────────────────┘   └──────────────────┘
                                                       │  ▲
                                              ProviderRequest / CircuitState
                                              (provider.* tables, Redis token buckets)
```

## 12.2 Port / Adapter Model (Hexagonal)

A **Port** is a domain-owned TypeScript interface expressed entirely in ASAP types. An **Adapter** is the vendor-specific implementation living *inside* the Provider Integration module. The booking domain depends on the port symbol; NestJS DI binds a concrete adapter (or a `CompositeAdapter` that fans out to multiple vendors).

Design rule: **one port per capability, not per vendor.** Two providers offering the same capability (Ticketmaster + Eventbrite both `EventProviderPort`) implement the same port. This is what makes "alternative provider" fallback (12.7) possible without leaking the choice upward.

### 12.2.1 Capability port interfaces (illustrative)

```ts
// All inputs/outputs are ASAP DTOs. No vendor types cross this boundary.
// Money is the shared-kernel Money VO: { amountMinor: bigint; currency: string /*Char(3)*/ }.

export interface ProviderCallContext {
  correlationId: string;       // saga correlationId (tracing)
  causationId: string;         // event that caused this call
  tripId: string;
  tripLegId: string;
  idempotencyKey: string;      // persisted; drives ProviderRequest unique [provider, idempotencyKey]
  deadlineMs: number;          // absolute budget; adapter must abort past this
}

// Normalized error taxonomy — NOT HTTP codes, NOT vendor codes.
export type ProviderErrorClass =
  | 'RETRYABLE_TRANSIENT'      // 5xx, timeout, connection reset, 429 -> retry w/ backoff
  | 'RETRYABLE_THROTTLED'      // explicit rate-limit signal; honor Retry-After
  | 'TERMINAL_REJECTED'        // 4xx business reject (sold out, invalid) -> compensate, no retry
  | 'TERMINAL_CONFLICT'        // idempotency replay mismatch / already-consumed
  | 'AMBIGUOUS_UNKNOWN';       // timeout after send: state unknown -> reconcile, never blind-retry

export class ProviderError extends Error {
  readonly class: ProviderErrorClass;
  readonly providerCode?: string;     // raw vendor code, for audit only
  readonly retryAfterMs?: number;
  readonly retryable: boolean;        // surfaced into error envelope { retryable }
}

export interface EventReservation {
  providerRef: string;                // REQUIRED to reach BookingStatus.CONFIRMED
  status: 'RESERVED' | 'CONFIRMED' | 'REJECTED';
  holdExpiresAt?: Date;               // reservation TTL (drives RETRYING/EXPIRED)
  price: Money;                       // priceSnapshot projection onto TripLeg
  seatRefs?: string[];
  raw?: unknown;                      // opaque, stored in ProviderRequest.responseBody for audit
}

export interface EventProviderPort {
  readonly provider: 'TICKETMASTER' | 'EVENTBRITE';
  search(q: EventSearchQuery, ctx: ProviderCallContext): Promise<EventOffer[]>;   // idempotent (GET-like)
  reserve(cmd: ReserveEventCommand, ctx: ProviderCallContext): Promise<EventReservation>; // idempotent via key
  confirm(cmd: ConfirmEventCommand, ctx: ProviderCallContext): Promise<EventReservation>;
  release(cmd: ReleaseEventCommand, ctx: ProviderCallContext): Promise<void>;     // compensation; idempotent
}

export interface TransportProviderPort {
  readonly provider: 'AMADEUS';
  quote(cmd: FareQuoteCommand, ctx: ProviderCallContext): Promise<FareQuote>;     // has expiresAt guard
  reserve(cmd: ReserveTransportCommand, ctx: ProviderCallContext): Promise<TransportReservation>;
  confirm(cmd: ConfirmTransportCommand, ctx: ProviderCallContext): Promise<TransportReservation>;
  release(cmd: ReleaseTransportCommand, ctx: ProviderCallContext): Promise<void>;
}

export interface StayProviderPort {
  readonly provider: 'BOOKING_COM';
  reserve(cmd: ReserveStayCommand, ctx: ProviderCallContext): Promise<StayReservation>; // snapshots cancellation policy
  confirm(cmd: ConfirmStayCommand, ctx: ProviderCallContext): Promise<StayReservation>;
  release(cmd: ReleaseStayCommand, ctx: ProviderCallContext): Promise<void>;
}

export interface RideProviderPort {
  readonly provider: 'UBER';
  estimate(cmd: RideEstimateCommand, ctx: ProviderCallContext): Promise<RideEstimate>;
  reserve(cmd: ReserveRideCommand, ctx: ProviderCallContext): Promise<RideReservation>; // scheduled ride
  release(cmd: ReleaseRideCommand, ctx: ProviderCallContext): Promise<void>;
}

// Payments port — separate, because failure policy is the inverse (NEVER degrade).
export interface PaymentGatewayPort {
  readonly provider: 'STRIPE';
  createIntent(cmd: CreateIntentCommand, ctx: ProviderCallContext): Promise<GatewayIntent>;   // manual capture
  authorize(cmd: AuthorizeCommand, ctx: ProviderCallContext): Promise<GatewayIntent>;
  capture(cmd: CaptureCommand, ctx: ProviderCallContext): Promise<GatewayCharge>;
  voidAuth(cmd: VoidCommand, ctx: ProviderCallContext): Promise<GatewayIntent>;  // compensation when auth not captured
  refund(cmd: RefundCommand, ctx: ProviderCallContext): Promise<GatewayRefund>;
  verifyWebhook(raw: Buffer, sig: string): WebhookEnvelope;                      // signature verification
}
```

**Why ports return `providerRef` and `raw`:** the booking invariant is *"CONFIRMED only with providerRef"*. The port contract makes `providerRef` a first-class normalized field so the domain can enforce the invariant without knowing it came from a Ticketmaster `reservationToken` vs an Amadeus `pnr`. `raw` is opaque and is persisted to `ProviderRequest.responseBody` for audit/replay — it never re-enters the domain.

### 12.2.2 Adapter internal structure

Each adapter is a thin onion of cross-cutting decorators wrapping a vendor-specific transport. The decorators are **shared** (one implementation, applied per provider via config); only the innermost `*HttpClient` and the `*Mapper` are vendor-specific.

```
reserve(cmd, ctx)
  └─ IdempotencyGuard      (ProviderRequest dedupe — 12.8)
       └─ BulkheadGuard    (per-provider concurrency semaphore — 12.4)
            └─ RateLimiter  (Redis token bucket — 12.5)
                 └─ CircuitBreaker (provider.CircuitState — 12.3)
                      └─ TimeoutGuard (deadlineMs / AbortController)
                           └─ RetryPolicy (backoff+jitter, idempotent only — 12.3)
                                └─ TicketmasterHttpClient + TicketmasterMapper (vendor)
```

Ordering rationale: **Idempotency outermost** so a replayed saga step short-circuits before consuming a rate-limit token or a bulkhead slot. **Circuit breaker inside rate limiter** so an open circuit fails fast *without* burning tokens. **Retry innermost** so each physical attempt is independently timed and counted by the breaker.

## 12.3 Resilience: Circuit Breaker & Retry

### 12.3.1 Circuit breaker (`provider.CircuitState`)

State is **persisted** in `provider.CircuitState` (durable across Fargate task restarts and shared across tasks) with a Redis hot-path mirror to avoid a DB read on every call. Postgres is system-of-record (Rule 1); Redis is derived cache that is rebuilt from `CircuitState` on miss.

| Column | Meaning |
|---|---|
| `provider` (PK) | TICKETMASTER, AMADEUS, … |
| `state` | CLOSED / OPEN / HALF_OPEN |
| `failureCount`, `successCount` | rolling-window counters |
| `openedAt` | when it tripped (cooldown anchor) |
| `nextProbeAt` | earliest HALF_OPEN probe time |
| `version` | optimistic concurrency (Rule 10) for state transitions |

```
        failures >= threshold (e.g. 50% of >=20 reqs in 30s window,
        OR 5 consecutive RETRYABLE_TRANSIENT)
 CLOSED ───────────────────────────────────────────────▶ OPEN
   ▲                                                       │
   │ probe success >= N (e.g. 3)                cooldown elapses (e.g. 20s, jittered)
   │                                                       ▼
   └──────────────────── HALF_OPEN ◀───────────── (allow limited probes, e.g. 3 concurrent max)
                              │  probe fails
                              └────────────────────────▶ OPEN (reset cooldown w/ exponential bump)
```

Design choices and tradeoffs:
- **Per-provider, not per-endpoint** by default, with optional per-endpoint sub-circuits for endpoints with independent SLAs (e.g. Amadeus *search* vs *book*). Tradeoff: per-endpoint gives finer isolation but multiplies state rows and can mask a provider-wide outage; we start per-provider and split only where observed failure modes diverge.
- **HALF_OPEN concurrency cap** prevents a thundering herd of 200 peak-TPS workers all probing simultaneously. Probes are gated by a Redis lock (`SET NX` on `circuit:{provider}:probe`).
- **`AMBIGUOUS_UNKNOWN` does NOT count as a breaker failure** in a way that triggers blind retry; it routes to reconciliation (12.10). Counting it as failure is fine; *retrying* it is forbidden.
- **Payments breaker is softer.** We never want to declare Stripe globally down and start failing authorizations spuriously — payment correctness is 100% and degradation of payment is forbidden (12.7). Stripe's breaker uses higher thresholds and shorter cooldowns, and an OPEN Stripe circuit surfaces as `PAYMENT_FAILED` / retry-later to the user rather than silent fallback.

### 12.3.2 Retry with backoff + jitter

```ts
// Applied ONLY to idempotent operations with class RETRYABLE_TRANSIENT | RETRYABLE_THROTTLED.
delayMs(attempt) = min(cap, base * 2 ** attempt) * (0.5 + random()/2);  // full-ish jitter
// base=200ms, cap=8s, maxAttempts=4 for reads; maxAttempts=2 for writes.
// RETRYABLE_THROTTLED: honor providerError.retryAfterMs if present (overrides backoff).
```

Hard rules:
- **Only idempotent operations retry.** `reserve`/`authorize`/`capture` are *made* idempotent via the persisted idempotency key (Stripe `Idempotency-Key`, provider request key) so they *are* safe to retry — but a retry re-sends the **same** key so the provider dedupes, never double-books / double-charges (Rule 3).
- **`TERMINAL_*` never retries** — it compensates. A sold-out event (`TERMINAL_REJECTED`) drives the leg to `booking.event.failed`, and the saga either reaches `PARTIALLY_BOOKED` (anchor ok) or `COMPENSATING → CANCELLED` (anchor lost).
- **`AMBIGUOUS_UNKNOWN` never retries the write.** It schedules a reconciliation read (`GET` by idempotency key) to learn the true outcome, then proceeds.
- Retries are **bounded by `ctx.deadlineMs`**; a retry that can't complete before the saga step deadline is abandoned and the step is requeued by BullMQ (durable saga, Rule on durability) rather than blocking a worker.

| Error class | Retry? | Counts toward breaker? | Saga consequence |
|---|---|---|---|
| RETRYABLE_TRANSIENT | yes (idempotent only) | yes | retry, then RETRYING → FAILED |
| RETRYABLE_THROTTLED | yes, honor Retry-After | partial | backpressure |
| TERMINAL_REJECTED | no | no | compensate / PARTIALLY_BOOKED |
| TERMINAL_CONFLICT | no | no | treat as success-replay or NEEDS_ATTENTION |
| AMBIGUOUS_UNKNOWN | no | yes | reconcile then decide |

## 12.4 Timeouts & Bulkheads

- **Timeouts are mandatory and per-operation**, expressed as `ctx.deadlineMs` and enforced with `AbortController`. Defaults: search 2s, reserve/confirm 8s, Stripe authorize/capture 15s (Stripe is on the critical money path and tolerates more latency than read paths). No call is ever unbounded — an unbounded call is the classic way a single slow provider exhausts the event-loop / connection pool and takes down the whole monolith.
- **Bulkheads isolate slow providers.** Each provider gets a bounded concurrency semaphore (Redis-backed counter, e.g. max 30 in-flight Amadeus calls) and a **dedicated BullMQ queue + worker concurrency budget** (`provider:ticketmaster`, `provider:amadeus`, …). A pathological Amadeus latency spike fills the Amadeus bulkhead and starts shedding/queuing Amadeus work, but Ticketmaster, Stripe, and the rest of the monolith keep flowing.

```
 BullMQ queues (bulkhead = isolated worker pool + concurrency cap):
   provider:ticketmaster  (conc 40)   ─┐
   provider:eventbrite    (conc 40)    │  one slow/down provider cannot
   provider:amadeus       (conc 30)    │  starve workers of the others
   provider:booking_com   (conc 30)    │
   provider:uber          (conc 20)    │
   provider:stripe        (conc 25) ◀──┘  separate pool; never starved by event providers
```

Tradeoff: static per-provider concurrency caps can under-utilize capacity during asymmetric load. We accept this for blast-radius containment; caps are config-driven (Secrets Manager / parameter store) and tunable per provider from observed p95 + concurrency, without redeploy.

## 12.5 Rate Limiting (token bucket per provider in Redis)

Each provider has a published or empirically-derived quota (e.g. Ticketmaster RPS, Amadeus TPS, Stripe ~100 rps default). We enforce **client-side** token buckets in Redis so we never get globally throttled (a 429 storm trips our own breaker and harms all users), and so quota is shared correctly across all Fargate tasks.

```ts
// Atomic token-bucket via Redis Lua (refill + take in one round-trip):
//   key bucket:{provider}; params: ratePerSec, burst, now
//   returns: { allowed: boolean, retryAfterMs }
// On allowed=false: RateLimiter decorator parks the job (BullMQ delayed retry) up to deadlineMs.
```

- **Bucket is per provider**, optionally per (provider, endpoint) where vendors quota separately (Amadeus search vs booking).
- Refill rate set **below** the vendor's hard limit (e.g. 80%) to leave headroom for retries and webhook-triggered reconciliation traffic.
- **Stripe gets a reserved sub-bucket** that booking traffic cannot exhaust — money operations must not be starved by event-search bursts. This is rate-limit-level expression of "never degrade payment."
- Distinguish **local throttle** (our bucket said no → park, do not count against breaker) from **remote throttle** (vendor 429 → `RETRYABLE_THROTTLED`, honor Retry-After, *does* inform breaker). Conflating them double-penalizes and oscillates.

## 12.6 Per-Provider Profiles

| Provider | Port | Auth model | Idempotency mechanism | Rate-limit posture | Webhooks | Notes / tradeoffs |
|---|---|---|---|---|---|---|
| **Ticketmaster** | EventProviderPort | API key + OAuth2 (Secrets Manager, rotated) | ASAP-generated key in `ProviderRequest`; replay GET to confirm hold | Strict RPS; bucket @80% | Limited; rely on polling reconciliation (12.10) | Inventory holds expire fast → `holdExpiresAt` tight; reserve→confirm window short |
| **Eventbrite** | EventProviderPort | OAuth2 bearer | ASAP key; idempotent reserve | Moderate | Order webhooks (signature) | Alternative to Ticketmaster for same `EventProviderPort` → enables alt-provider fallback |
| **Amadeus** | TransportProviderPort | OAuth2 client-credentials, short-lived token (cache+refresh) | PNR-based; `quote.expiresAt` guard enforced before reserve | TPS-limited, per-endpoint quotas | Ticketing webhooks/queues; supplement w/ polling | Two-phase quote→book; FareQuote expiry is a domain guard, not just provider concern |
| **Booking.com** | StayProviderPort | API key / partner credentials | Reservation idempotency token | Moderate | Reservation/modification notifications | **Cancellation policy snapshotted** at reserve (invariant); refund compensation honors snapshot |
| **Uber** | RideProviderPort | OAuth2 bearer | Request idempotency key | Per-app RPS | Trip status webhooks | Scheduled rides; estimate volatile → treat estimate as non-binding, re-confirm price |
| **Stripe** | PaymentGatewayPort | Restricted API key (Secrets Manager) | **Native `Idempotency-Key` header**, persisted per call | ~100rps default; reserved sub-bucket | **Primary** mechanism: `payment_intent.*`, `charge.dispute.*`, `refund.*` | Manual capture (authorize→capture). PCI SAQ-A: card data via Elements, server never touches PAN |

**Stripe failure-mode emphasis** (per foundation: most common authorize-then-capture failure is VOID, zero money moved): the adapter maps Stripe intent states to ASAP `PaymentStatus`. `requires_capture` → `AUTHORIZED`; a failed/abandoned auth → `VOIDED` (compensation cheap, nothing charged). The breaker/retry for `capture` is conservative because a lost capture response is `AMBIGUOUS_UNKNOWN` → reconcile via `GET payment_intent` by idempotency key, never blind re-capture (would risk double charge if the first silently succeeded).

## 12.7 Fallback Strategies & Graceful Degradation

The first-order rule: **degradation is allowed for Discovery/recommendations, forbidden for Payments and for booking *correctness*.**

| Capability | Fallback ladder | Forbidden |
|---|---|---|
| **events/search, recommendations/trip** | (1) live provider → (2) Redis-cached results (stale-while-revalidate) → (3) alternative `EventProviderPort` (Eventbrite if Ticketmaster open) → (4) degraded recs (popular/cached only, flagged `stale:true`) | — |
| **reserve/confirm (booking)** | (1) live → (2) alternative provider implementing same port *if and only if* it can fulfill the same `tripLeg` requirement → otherwise (3) fail the leg honestly | Never fabricate a `providerRef`; never mark CONFIRMED without it |
| **Payments (Stripe)** | (1) live → (2) bounded retry/backoff → (3) surface `PAYMENT_FAILED` / retry-later to user | **No alternative gateway swap mid-saga; no cached/optimistic auth; no degradation. Ever.** |

Why payment is special: an authorized-but-uncaptured trip with a confirmed anchor must reach a *truthful* terminal state. Faking a payment success to "degrade gracefully" violates the 100%-payment-correctness NFR and the ledger's double-entry invariant. When Stripe is unavailable, the honest behavior is to keep the trip in `PENDING_PAYMENT` / `PAYMENT_FAILED` and let the durable saga retry — not to invent money movement.

Alternative-provider fallback is only safe because of the **port-per-capability** design (12.2). The saga asks `EventProviderPort.reserve`; a router selects Ticketmaster or Eventbrite based on circuit state, quota headroom, and which provider actually lists the event. Crucially, **switching providers re-issues a fresh idempotency key for the new provider** (the key is unique per `[provider, idempotencyKey]`) and the *old* provider's reservation, if any ambiguous, is reconciled and released. We never hold two live reservations for one `tripLegId` (booking invariant: at most one active booking per `tripLegId`).

## 12.8 `provider.ProviderRequest` — Idempotent Dedupe + Audit

`provider.ProviderRequest` with **unique `[provider, idempotencyKey]`** is the ACL's idempotency ledger and full audit trail. It implements Rules 3 & 4 at the provider boundary.

| Column | Purpose |
|---|---|
| `provider`, `idempotencyKey` | unique together — the dedupe key |
| `operation` | RESERVE_EVENT / CAPTURE_PAYMENT / REFUND … |
| `tripId`, `tripLegId`, `correlationId`, `causationId` | tracing + audit linkage |
| `status` | IN_FLIGHT / SUCCEEDED / FAILED / AMBIGUOUS |
| `requestHash` | hash of normalized request; mismatch on same key ⇒ `TERMINAL_CONFLICT` |
| `responseBody` | normalized + raw response (replay/audit) |
| `providerRef` | extracted ref, surfaced to booking domain |
| `attemptCount`, `lastError`, `createdAt`, `updatedAt` | |

**Idempotency flow (the `IdempotencyGuard` decorator):**

```
1. SELECT row by (provider, idempotencyKey).
   - SUCCEEDED  -> return stored normalized response (NO network call) — replay shield.
   - IN_FLIGHT  -> another worker is doing it: short-circuit, let BullMQ re-deliver later.
   - AMBIGUOUS  -> route to reconciliation (12.10), do not re-issue write.
   - none       -> INSERT (provider, key, IN_FLIGHT, requestHash) in its own short tx, then continue.
2. Make the network call (OUTSIDE any DB tx — Rule 2), passing the SAME key downstream to the vendor.
3. Persist outcome: UPDATE row -> SUCCEEDED|FAILED|AMBIGUOUS + responseBody + providerRef (own tx).
```

This guarantees that a BullMQ redelivery, a saga retry, or a duplicate client request (same `Idempotency-Key` header) collapses to a single provider effect. The `requestHash` guard catches the dangerous case where the *same key* is reused with a *different* payload (client bug / key collision) → we refuse rather than silently book the wrong thing.

Retention: `ProviderRequest` is high-volume (millions/yr). Hot rows stay in RDS; rows older than the dispute/reconciliation horizon (e.g. 18 months, > Stripe chargeback window) are archived to S3 (audit) and pruned, keeping the unique index lean.

## 12.9 Response Normalization

Each adapter has a `*Mapper` (pure function, unit-tested against recorded vendor fixtures) translating vendor payloads → ASAP DTOs. Normalization responsibilities:

- **Money:** vendor decimals/strings → `Money` VO (`bigint` minor units + `Char(3)` currency). Never carry floats. Reject ambiguous currency.
- **Status:** vendor lifecycle → ASAP `BookingStatus` / `PaymentStatus`. E.g. Stripe `requires_capture`→`AUTHORIZED`, `canceled`→`VOIDED`; Ticketmaster hold→`RESERVED`, ticketed→`CONFIRMED`.
- **Refs:** vendor reservation token / PNR / charge id → `providerRef`.
- **Errors:** vendor HTTP/codes → `ProviderErrorClass` taxonomy (12.3). This mapping table is the single place vendor error semantics live; everywhere upstream sees only the five classes.
- **Time:** vendor TZ/format → UTC `Date`; reservation TTLs → `holdExpiresAt`, fare TTL → `FareQuote.expiresAt`.

Tradeoff: mappers are the **highest-churn** code (vendors change payloads). We version them, pin to vendor API versions, and contract-test against captured fixtures in CI; a vendor schema drift fails CI rather than corrupting a live booking.

## 12.10 Webhook Ingestion & Polling Reconciliation

Webhooks are **untrusted, at-least-once, and out-of-order**. Endpoints: `POST /webhooks/stripe`, `POST /webhooks/providers/{provider}`.

**Ingestion pipeline:**
```
1. Signature verify (Stripe: verifyWebhook(rawBody, sig); providers: HMAC/secret from Secrets Manager).
   Use RAW body (pre-JSON-parse). Bad signature -> 401, drop, audit.
2. Dedupe: INSERT platform.WebhookReceipt (unique [source, externalEventId]).
   Conflict -> already processed -> 200 OK immediately (idempotent ack).
3. In ONE short tx: persist receipt + write platform.OutboxEvent (e.g. payment.captured, booking.event.confirmed).
   Return 2xx FAST. Do NOT process business logic inline (vendors retry on slow/failed acks -> duplicate storms).
4. Outbox dispatcher -> BullMQ -> consumer applies effect, idempotent via platform.ProcessedEvent.
```

Key decisions:
- **Verify-then-dedupe-then-outbox, ack fast.** Per Rule 4, the webhook handler's job is to durably *record* the event and ack; all business effects flow through the outbox so they are exactly-once-applied (via `ProcessedEvent`) even though webhooks are at-least-once. This also keeps webhook latency low so Stripe/vendors don't mark our endpoint unhealthy and disable it.
- **`WebhookReceipt` unique `[source, externalEventId]`** is the dedupe boundary — Stripe sending the same `evt_…` twice is a no-op.
- **Out-of-order tolerance:** consumers are state-machine-guarded. A `payment.captured` arriving before our own capture-response was recorded is reconciled against `ProviderRequest`/`PaymentIntent` version; stale/illegal transitions are dropped, not force-applied.

**Polling reconciliation (the safety net when webhooks are missed or providers lack them):**

A scheduled BullMQ reconciler sweeps:
1. `ProviderRequest` rows stuck `IN_FLIGHT` / `AMBIGUOUS` past a threshold → GET-by-idempotency-key to learn true state → resolve to SUCCEEDED/FAILED and emit the proper outbox event.
2. `SagaState` steps idle past SLA → re-drive or escalate to `NEEDS_ATTENTION`.
3. Stripe: `payment_intent` polling for intents in `PROCESSING`/`REQUIRES_ACTION` past timeout (Stripe webhooks are reliable but RPO≤5min demands we don't depend solely on them).
4. Providers without webhooks (Ticketmaster holds): poll hold status before `holdExpiresAt` to drive `RETRYING`/`EXPIRED`.

This dual mechanism (webhook-primary, poll-backstop) is what satisfies durability + RPO≤5min: we never assume a webhook arrived. Missing webhook ⇒ at most one poll-interval (≤5min) of staleness, then self-heals.

## 12.11 Consolidated Tradeoffs

| Decision | Chosen | Alternative | Why |
|---|---|---|---|
| Port granularity | per-capability | per-vendor | enables alt-provider fallback & microservice cut without domain leakage |
| Circuit state store | `provider.CircuitState` (PG) + Redis mirror | Redis-only | survives task restart; PG is system of record; Redis is rebuildable cache |
| Idempotency | persisted `ProviderRequest` + vendor-native keys | in-memory / Redis-only | durable replay shield; audit; survives crash mid-saga |
| Webhook processing | record+outbox, ack fast | inline business logic | exactly-once via outbox/ProcessedEvent; fast ack prevents vendor retry storms |
| Bulkheads | per-provider queues + semaphores | shared pool | one slow provider can't take down the monolith |
| Retry scope | idempotent ops only, same key | retry everything | prevents double-book / double-charge; AMBIGUOUS → reconcile not retry |
| Payment degradation | none (fail honestly) | gateway swap / optimistic auth | 100% payment correctness; ledger & money invariants |
| Reconciliation | webhook + polling backstop | webhook-only | meets RPO≤5min; handles missing/disabled webhooks & no-webhook providers |

The net property: a provider can be slow, flapping, throttling, returning garbage, sending duplicate or out-of-order webhooks, or fully down — and the worst outcome ASAP suffers is a *bounded-latency, self-healing* leg failure (degraded recommendations or an honest `PARTIALLY_BOOKED` / `PAYMENT_FAILED`), never a corrupted ledger, double charge, double booking, or a wedged saga.
