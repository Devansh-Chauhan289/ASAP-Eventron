# Section 10 — Redis Architecture

## 10.1 Position of Redis in the System

Redis is a **derived/transport tier**, never the system of record (Foundational Rule 1). PostgreSQL on RDS holds canonical state for every aggregate (`trip.Trip`, `payment.PaymentIntent`, `booking.*`, `platform.IdempotencyKey`, `platform.OutboxEvent`). Redis on ElastiCache serves four distinct workloads with *different durability, eviction, and failover requirements*:

| Workload | Why Redis | Durability tolerance | Eviction policy | Loss impact |
|---|---|---|---|---|
| **Cache** (Discovery, event detail, reco, FareQuote read-model) | Sub-ms reads to hit read p95<200ms NFR | Fully disposable | `allkeys-lru` | Cache miss → re-read Postgres/provider. Zero correctness loss. |
| **Rate limiting** counters | Atomic INCR + Lua, high write rate | Seconds-disposable | `volatile-ttl` | Brief over/under-admission. Self-heals on TTL. |
| **Idempotency L1 fast-path** | Avoid Postgres roundtrip for replays | Disposable (Postgres is truth) | `allkeys-lru` | Falls back to `platform.IdempotencyKey`. Zero correctness loss. |
| **BullMQ queues** (saga drivers, outbox relay, notifications, webhook processing) | Job state, delayed/retry sets | **MUST NOT be evicted** | `noeviction` + AOF | Eviction = silent job loss = stuck sagas = correctness violation. |

**Architectural decision: physically separate ElastiCache instances** — the eviction-policy conflict between cache (`allkeys-lru`, must evict under memory pressure) and queues (`noeviction`, must never evict) is irreconcilable on a single instance. Co-locating them means either the cache stops admitting keys (latency NFR breach) or BullMQ jobs get evicted (saga durability breach). They are split into:

- **`asap-cache`** ElastiCache Redis — cluster mode enabled, `allkeys-lru`, no AOF.
- **`asap-queue`** ElastiCache Redis — cluster mode *disabled* (BullMQ is not Redis-Cluster-safe across keys; multi-key Lua needs same slot), `noeviction`, AOF `everysec`.

This separation is also the **microservice cut-line** (Foundational Rule 8 analog): when Trip Orchestration is extracted, its queue instance travels with it.

---

## 10.2 Cache Key Naming Convention

All keys are namespaced `asap:{schemaVersion}:{context}:{aggregate}:{discriminator}`. The `v1` segment is a **global schema epoch** — bumping it on a breaking serialization change invalidates the entire cache without a flush.

```
asap:v1:events:search:{sha256(normalizedQuery)}      # Discovery search result page
asap:v1:event:{eventId}                              # Discovery event detail projection
asap:v1:reco:{userId}:{tripContextHash}              # recommendations/trip output
asap:v1:event:{eventId}:availability                 # volatile availability hint (advisory only)
asap:v1:farequote:{tripLegId}                        # booking.FareQuote read-model mirror
asap:v1:trip:{tripId}:projection                     # GET /trips/{id} read model (versioned, see 10.5)
asap:v1:idem:{scope}:{idempotencyKey}                # idempotency L1 (10.7)
asap:v1:rl:user:{userId}:{bucket}                    # rate-limit token bucket
asap:v1:rl:ip:{ip}:{bucket}
asap:v1:rl:provider:{provider}:{window}              # provider ACL pacing
asap:v1:lock:{resource}                              # advisory cache-fill lock (NOT correctness lock)
```

**Conventions & reasoning:**

- **Hash the search query** (`sha256` of the canonicalized query object — sorted keys, normalized casing, rounded geo) so semantically identical searches collapse to one key. Canonicalization happens in the Discovery application service, never the controller.
- **Never embed PII** in keys (no email, no raw card data — irrelevant anyway under PCI SAQ-A since card data never touches our servers). `userId` is an opaque UUID.
- **Co-locate keys that are mutated together under a hash tag** in cluster mode where Lua spans them, e.g. rate-limit token-bucket Lua reads/writes `{rl:user:123}:tokens` and `{rl:user:123}:ts` — the `{...}` hash tag forces same-slot placement so the Lua script is legal.

---

## 10.3 TTLs per Data Type

TTL is chosen from **(a) volatility of underlying data, (b) cost of a miss, (c) staleness tolerance for correctness.** Correctness-critical data gets *short or zero* TTL and is always re-validated against Postgres before any state change.

| Key | TTL | Justification |
|---|---|---|
| `events:search:{hash}` | 60s | Search is read-heavy, mildly stale-tolerant. Short TTL absorbs traffic spikes (200 TPS peak) while keeping listings fresh. |
| `event:{id}` | 5–10 min + jitter | Event metadata (title, venue, base price) changes slowly. Jitter ±20% prevents synchronized expiry stampede. |
| `reco:{userId}:{ctx}` | 15 min | Recommendation compute is expensive (ML/scoring). Stale recos are harmless. |
| `event:{id}:availability` | 10–30s | Inventory is volatile and **advisory only** — never used to authorize a booking. The Provider ACL re-checks at RESERVE time. |
| `farequote:{tripLegId}` | = `FareQuote.expiresAt` (TTL set to remaining seconds) | Hard correctness coupling: cached quote must expire no later than the domain `expiresAt` guard. Capture/confirm re-reads Postgres. |
| `trip:{tripId}:projection` | 30s **OR** event-invalidated | Bridges polling load on `GET /trips/{id}` during async booking; invalidated on every `trip.*` domain event for freshness. |
| `idem:{scope}:{key}` | 24h | Matches the idempotency replay window; Postgres `IdempotencyKey` is the durable long-tail. |
| `rl:*` | = window length (1s–1min) | Self-expiring counters; TTL *is* the algorithm. |

**Rule:** any TTL'd value that feeds a **state-changing decision** (price to charge, inventory to reserve) is treated as a *hint*, and the authoritative value is re-read inside the saga step's Postgres `$transaction`. The cache only accelerates *reads*, never *commits*.

---

## 10.4 Cache-Aside + Stampede Protection

ASAP uses **cache-aside (lazy loading)** — repositories check Redis, fall back to Postgres/provider, then populate. This keeps the cache decoupled from writes (no write-through coupling that would put Prisma-derived state in two places with skew).

```
            ┌─────────────┐  hit   ┌──────────┐
  read ───▶ │ Redis GET   │ ─────▶ │ return   │
            └──────┬──────┘        └──────────┘
                   │ miss
                   ▼
            ┌────────────────────────────────────┐
            │ SET NX lock asap:v1:lock:{res} (5s) │
            └──────┬───────────────────┬──────────┘
            got lock                no lock
                   ▼                   ▼
        load from Postgres      short-sleep + re-GET (≤3x)
        SETEX value + jitter        │ (serve stale if present)
        DEL lock                    ▼
                   └────────────▶ return
```

**Stampede (cache stampede / "dog-pile") protection — three layers:**

1. **Single-flight via `SET NX PX` lock.** First reader to miss acquires `asap:v1:lock:{resource}` (short TTL, e.g. 5s); others briefly back off and re-read. This collapses N concurrent Postgres/provider hits into 1. Critically, this lock is **advisory cache-fill coordination, not a correctness lock** — if it expires early and two readers both fill, the result is identical data written twice (idempotent), never corruption.
2. **TTL jitter** (±20%) so a popular `event:{id}` doesn't expire simultaneously across the fleet.
3. **Stale-while-revalidate** for non-correctness reads: store `{value, softExpiry}` and serve slightly-stale data while one worker refreshes, smoothing the 200 TPS peak.

For **provider-backed** reads (Discovery → Ticketmaster/Eventbrite), single-flight is doubly important: it shields the Provider Integration ACL's rate limiter and circuit breaker from a thundering herd on a cache miss.

---

## 10.5 Invalidation Strategy

Two complementary mechanisms; **event-driven is primary, versioned keys are the safety net.**

**1. Event-driven invalidation (push, on domain events).**
Cache-invalidation is a *consumer* of the domain event stream, not a side effect baked into write services. When `platform.OutboxEvent` is relayed and a context publishes e.g. `event.updated`, `booking.transport.price_changed`, or any `trip.*` event, a `CacheInvalidationConsumer` (idempotent via `platform.ProcessedEvent`) deletes the affected keys:

| Domain event | Keys invalidated |
|---|---|
| `trip.created/confirmed/partially_booked/cancelled/...` | `asap:v1:trip:{tripId}:projection` |
| `booking.transport.price_changed`, `booking.transport.quote_expired` | `asap:v1:farequote:{tripLegId}` |
| `event.updated` (Discovery ingest) | `asap:v1:event:{id}`, and bump search version (below) |
| `payment.*` affecting trip projection | `asap:v1:trip:{tripId}:projection` |

Because consumers are idempotent and invalidation is `DEL` (naturally idempotent), at-least-once delivery is safe — a duplicate delete is a no-op.

**2. Versioned keys (pull, monotonic epoch).**
Search results can't be enumerated to delete (the `{hash}` space is unbounded). Instead we embed a **monotonic version** read from a tiny counter: `asap:v1:events:search:{searchEpoch}:{hash}`. On bulk catalog change we `INCR asap:v1:events:search_epoch`; all old-epoch keys become unreachable and LRU-evict naturally. This is "invalidation by abandonment" — no expensive `SCAN`/`KEYS` (which is banned in prod for blocking the event loop).

**Why both:** event-driven gives *precise, fast* invalidation for point lookups; versioned epochs give *cheap, bulk* invalidation for unbounded query spaces. Neither uses `KEYS`/`SCAN` on the hot path.

---

## 10.6 Session / Refresh-Token Storage vs JWT

| Token | Storage | Reasoning |
|---|---|---|
| **Access JWT (15 min)** | **Stateless, not in Redis.** | Signed (RS256), short-lived, validated by signature + `exp` at API Gateway / guard. Storing it would defeat statelessness and add a Redis hop to every request (200ms p95 budget). Revocation handled by short TTL + refresh rotation. |
| **Refresh token (rotating)** | **Postgres `identity.sessions` (system of record) + Redis L1 lookup.** | Refresh tokens must be **revocable and rotation-tracked** (reuse detection). The durable record (hashed token, `familyId`, `rotatedAt`, device) lives in Postgres. Redis caches the *current valid hash per family* (`asap:v1:session:{familyId}` TTL = refresh lifetime) to make the high-frequency `/auth/refresh` check fast. |
| **Denylist (optional)** | Redis `asap:v1:jwt:revoked:{jti}` TTL=access-token-lifetime | For forced logout / compromised token, a small short-TTL denylist checked only on sensitive routes. Self-purging via TTL. |

**Refresh-token reuse detection:** rotation writes the new token to Postgres in one `$transaction` (invalidating the old `familyId` lineage); Redis is updated after commit. If a previously-rotated token is presented (cache miss → Postgres says "rotated"), the **entire family is revoked** — Postgres is authoritative, Redis is the accelerator. Cache loss = extra Postgres reads, never a security hole.

---

## 10.7 Idempotency Fast-Path (Redis L1, Postgres durable truth)

`Idempotency-Key` (UUID) is required on all state-changing POSTs (`/checkout`, `/confirm`, `/cancel`, `/legs`, refunds). The durable source of truth is **`platform.IdempotencyKey`** (Foundational Rule 3 & 4). Redis is a **non-authoritative L1** to short-circuit obvious replays cheaply.

```
POST with Idempotency-Key
        │
        ▼
GET asap:v1:idem:{scope}:{key}
   ├─ HIT (status=COMPLETED) ─▶ return cached response  (fast replay)
   ├─ HIT (status=IN_FLIGHT)  ─▶ 409 / 425 retryable     (concurrent dup)
   └─ MISS ─▶ begin Postgres $transaction:
                 INSERT platform.IdempotencyKey (UNIQUE key)   ← TRUE arbiter
                   ├─ unique violation ─▶ replay: load stored result
                   └─ inserted ─▶ execute handler, persist result, COMMIT
              then SET asap:v1:idem:{scope}:{key} = result (TTL 24h)
```

**Critical rule:** the Postgres `UNIQUE` constraint on `platform.IdempotencyKey` is the **only correctness guarantee**. Redis can lie (evicted, lagging replica, split-brain) — so a Redis MISS *never* authorizes execution; it only routes to the Postgres path which re-checks. Redis a HIT only fast-returns an already-COMMITTED result. This makes idempotency correct even with a cold/empty Redis. No external call (Stripe authorize, provider reserve) happens inside the tx — the tx claims the key; the side-effecting call runs after with its own persisted provider idempotency key (`provider.ProviderRequest` unique `[provider, idempotencyKey]`, Stripe's `Idempotency-Key` header).

---

## 10.8 Distributed Rate Limiting

Per-dimension limiting, all enforced via **atomic Lua scripts** (single round-trip, no check-then-act race) on `asap-cache`.

| Scope | Key | Algorithm | Purpose |
|---|---|---|---|
| Per-user | `asap:v1:rl:user:{userId}:{route}` | Token bucket | Fairness, abuse, runaway clients |
| Per-IP | `asap:v1:rl:ip:{ip}:{route}` | Sliding-window log/counter | Credential stuffing, unauthenticated abuse on `auth/*`, `events/search` |
| Per-provider | `asap:v1:rl:provider:{provider}:{window}` | Token bucket (refill = provider's documented QPS) | **Protect us from being throttled/banned by Ticketmaster/Amadeus/etc.** Lives in Provider ACL, coordinates the whole fleet's outbound call rate. |

**Token-bucket Lua (illustrative interface):**

```lua
-- KEYS[1]=tokens KEYS[2]=ts  ARGV: rate, burst, now, requested
-- returns {allowed(0/1), remaining, retryAfterMs}  -- atomic refill+consume
```

Reasoning:
- **Lua = atomicity.** Refill-then-consume must be one indivisible op; otherwise concurrent requests double-spend tokens. Redis runs the script single-threaded — no distributed lock needed.
- **Per-provider limiter is a reliability control, not just abuse control.** It is the fleet-wide governor in front of circuit breakers (`provider.CircuitState`); combined they implement bulkhead + rate-pacing so one provider's slowness can't exhaust our worker pool.
- **Fail-open vs fail-closed:** if `asap-cache` is unavailable, *user/IP* limiters **fail-open** (availability > perfect throttling — a brief over-admission is acceptable, 99.9% NFR). The *provider* limiter **fails-closed degraded** (back off to a conservative local in-process limit) because over-calling a provider risks an account-level ban, which is far costlier than a slow request.

---

## 10.9 Distributed Locks — and Why We Mostly Avoid Them

**Decision: Redis is NOT used for correctness-critical mutual exclusion.** Redlock has well-known safety caveats (clock skew, GC pauses, lock expiry while holder still runs, no fencing tokens by default) — unacceptable for money and inventory.

| Need | Mechanism | Reasoning |
|---|---|---|
| Single-flight cache fill | Redis `SET NX PX` (10.4) | Advisory only; double-fill is harmless/idempotent. Redis is fine here. |
| Mutating a hot aggregate (`Trip`, `PaymentIntent`, `Booking`) | **Optimistic concurrency: `version Int`** (Foundational Rule 10) | Lock-free; the `WHERE version = ?` update either wins or retries the saga step. Scales better than locks under 200 TPS. |
| Serialize a specific saga step / unique resource claim | **Postgres advisory locks** (`pg_advisory_xact_lock`) inside the `$transaction` | Lock lifetime is bound to the transaction (auto-released on commit/abort/crash) — no orphaned locks, no clock dependency. Correct by construction. |
| At-most-one active booking per leg | **Postgres `UNIQUE(tripLegId)` partial index** | Database-enforced invariant; no lock needed at all. |

**Principle:** correctness invariants are enforced by Postgres (constraints, advisory locks, optimistic version); Redis locks are reserved for *performance optimizations where a lost lock is harmless*. This honors "compensation over rollback" — we never depend on a distributed lock holding for the duration of a multi-step saga.

---

## 10.10 BullMQ on Redis

BullMQ (saga drivers, **outbox relay**, notification dispatch, webhook processing, refund/compensation jobs) runs on the dedicated **`asap-queue`** instance.

- **Separate instance, `noeviction`, AOF `everysec`.** Job loss = a saga stuck mid-flight or an outbox event never published = correctness/durability breach. Queues therefore demand the strictest durability profile, opposite to the cache.
- **Cluster mode disabled** for the queue: BullMQ relies on multi-key atomic Lua across a job's keys; Redis Cluster requires same-slot, which BullMQ does not guarantee across all internal keys at scale. A single primary + replica with Multi-AZ failover is the supported, safe topology.
- **At-least-once semantics align with the event model:** BullMQ may re-deliver a job on failover/retry; every consumer is idempotent via `platform.ProcessedEvent` and persisted idempotency keys, so re-delivery is safe by design.
- **The outbox relay is the bridge, not the source of truth:** Postgres `platform.OutboxEvent` is written *in the same `$transaction* as the state change (Rule 4). A BullMQ-backed relay polls/streams unpublished rows and publishes them. If Redis/BullMQ loses the job, the row is still `PENDING` in Postgres and gets re-picked — **no event is lost because the queue is never the record of intent.**

---

## 10.11 ElastiCache Configuration Summary

| Setting | `asap-cache` | `asap-queue` |
|---|---|---|
| Engine | Redis (ElastiCache) | Redis (ElastiCache) |
| Cluster mode | **Enabled** (shard for read scale) | **Disabled** (single shard, BullMQ-safe) |
| Eviction policy | `allkeys-lru` | **`noeviction`** |
| Persistence | None / RDB snapshot ok | **AOF `everysec`** |
| Multi-AZ + auto-failover | Yes | Yes (replica promotion) |
| Encryption (in-transit + at-rest) | Yes (PCI SAQ-A posture) | Yes |
| Auth | AUTH token from Secrets Manager | AUTH token from Secrets Manager |
| Backup/RPO | Disposable (RPO N/A) | Snapshot + AOF → supports RPO ≤ 5 min |
| Failure behavior | Degrades latency only | Failover preserves jobs; saga resumes |

Both sit in private subnets, reachable only from the ECS/Fargate tasks' security group. Connection pooling via a shared client per instance per task; BullMQ and cache use **distinct connection pools** even though both are "Redis" — they are different systems with different SLAs.

---

## 10.12 Why the Cache Is Never the Source of Truth (First Principles)

1. **Redis is volatile and evictable.** `allkeys-lru` *will* discard data under memory pressure; a key can vanish at any instant. Truth cannot be evictable. Postgres on RDS is durable, backed up, point-in-time-recoverable (RPO ≤ 5 min).
2. **No transactional integration with the domain.** State changes happen inside a single Prisma `$transaction` with the outbox; Redis can't enlist in that transaction, so any cache write is *after* commit and can fail/skew. Treating it as truth would create dual-write inconsistency.
3. **Failover loses recent writes.** ElastiCache async replication means a primary failover can drop the last few writes. Acceptable for a cache (re-read from Postgres), catastrophic for money or booking state.
4. **Correctness invariants live in SQL constraints.** Unique idempotency keys, `UNIQUE(tripLegId)`, double-entry ledger balance, optimistic `version` — these are enforceable only in Postgres, not in a key-value cache.

Therefore every correctness-critical decision (capture amount, reserve inventory, claim idempotency key, rotate refresh token) **re-validates against Postgres**, and Redis exists purely to make the *common, read-heavy, replay, and rate-limiting paths fast* — accelerating the system without ever being trusted as its memory. Cache loss degrades latency; it must never degrade correctness.
