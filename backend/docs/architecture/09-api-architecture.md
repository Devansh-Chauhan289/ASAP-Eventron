# Section 09 — API Architecture

> **Scope of this section.** This is the *strategy and reasoning* document for ASAP's public and server-to-server HTTP surface — the **why** behind the contract. The concrete, field-level endpoint reference (request/response bodies, query params, example payloads) is the committed contract in **`backend/API.md`** and the generated **OpenAPI 3.1** spec at `GET /api/v1/openapi.json`. This section does **not** re-document every field; it specifies the cross-cutting rules every endpoint inherits (versioning, error envelope, idempotency mechanics, pagination, async booking, rate limiting, validation, auth), the tradeoffs behind them, and a one-line-per-endpoint index grouped by bounded context. Where this section and `API.md` overlap, `API.md` + OpenAPI are the source of truth for *shapes*; this section is the source of truth for *rules and rationale*.

---

## 9.1 Design goals & constraints

The API is the only synchronous boundary into a **modular monolith** whose core work (booking, payment, compensation) is **asynchronous, saga-driven, and eventually consistent**. The HTTP layer's job is therefore narrow and deliberate:

| Goal | Why it matters for ASAP | Where enforced |
|------|------------------------|----------------|
| **Never double-charge / double-book on retry** | Mobile clients on flaky networks retry; API Gateway/ALB may replay; 200 peak TPS amplifies races. | `Idempotency-Key` + `platform.IdempotencyKey` (§9.4) |
| **Decouple request lifetime from booking lifetime** | A trip booking touches Stripe + 1–3 providers + capture; can take seconds and *must* survive client disconnect. | Async `202` contract (§9.6) |
| **Uniform failure semantics** | Clients must distinguish "fix your input" from "retry later" from "we owe you a refund". | Standard error envelope + `retryable` (§9.3) |
| **Thin controllers, fat domain** | Foundational Rule 7 — Prisma never reaches controllers; controllers do transport concerns only. | Layering (§9.10) |
| **Microservice-ready cut lines** | Each context (Rule 8) must be independently extractable behind the same gateway. | Route namespacing by context (§9.2, §9.11) |
| **PCI SAQ-A** | Card data must never transit ASAP. | Stripe Elements client-side; we only exchange `clientSecret` (§9.6) |

**Non-goals of the HTTP layer:** it does not own transactions spanning external calls (Rule 2), does not emit events directly (it writes to `platform.OutboxEvent` via a service, Rule 4), and does not implement business rules in guards/pipes (those live in the domain layer, Rule 6).

---

## 9.2 Versioning strategy

### Decision: URI-path versioning — `/api/v1/*`

Every route is mounted under `/api/v1`. `v1` is a **major** version representing a breaking-compatible contract surface.

```
GET /api/v1/trips/{tripId}
            │
       major version in path — coarse, cache-friendly, gateway-routable
```

**Evolution rules (committed in `API.md` §11):**

- **Additive-only within `v1`.** New optional fields, new endpoints, new enum members at the *tail* of a list, new error `code` values — all non-breaking and allowed without a version bump. Clients **must** ignore unknown fields and treat unknown enum values as a safe default (e.g., an unknown `TripStatus` ⇒ render as `NEEDS_ATTENTION`-style "unknown" state, never crash).
- **Breaking changes ⇒ `/api/v2`.** Removing/renaming a field, changing a type, tightening validation, changing default behavior, or removing an enum member.
- **Event `eventVersion` is independent** of API version (§5.2) — the published-language contract versions per payload, not per URL.

### Deprecation policy

| Stage | Mechanism | Duration (target) |
|-------|-----------|-------------------|
| Announce | OpenAPI `deprecated: true` on operation/field; `Deprecation` + `Sunset` response headers (RFC 8594); changelog entry | ≥ 90 days before removal |
| Warn | `Warning: 299 - "field X deprecated, use Y"` header on responses; metric `api.deprecated_usage{route}` in CloudWatch | continuous |
| Sunset | `/api/v2` live, `/api/v1` returns `410 Gone` with envelope `code: API_VERSION_RETIRED, retryable:false` | after both `v1`+`v2` overlap window |

We run `v1` and `v2` **side-by-side** (both mount on the same NestJS app via module-level route prefixes) rather than blue/green whole-app cutover, because mobile clients in the field cannot be force-upgraded.

### Alternatives considered

| Option | Verdict | Reason |
|--------|---------|--------|
| **Header versioning** (`Accept: application/vnd.asap.v2+json`) | Rejected | Harder to route at API Gateway, harder to curl/test, invisible in logs/CloudWatch path metrics. |
| **Query param** (`?version=2`) | Rejected | Pollutes cache keys, easy to omit, weak contract signal. |
| **No versioning / continuous evolution** | Rejected | Payment + booking contracts are money-correctness-critical; we need an explicit "this can never silently change" boundary. |

URI versioning wins on **operability** (visible everywhere, trivially routable at the gateway when contexts are later split) at the cost of slight URL churn on a major bump — an acceptable trade for a money-handling platform.

---

## 9.3 Resource modeling & contracts

### Resource model

The API is **resource-oriented around the `Trip` aggregate** (the CORE context), with supporting resources hanging off it. The trip is the *consistency boundary the user reasons about* ("my trip"), so it is the primary noun; legs, quote, checkout, confirm, payment, refunds, and the event stream are **sub-resources / actions of a trip**.

```
/trips                        collection (user-scoped)
/trips/{id}                   aggregate root (read = full projection incl. legs + payment)
/trips/{id}/legs[/{legId}]    sub-collection (mutate basket while PLANNING)
/trips/{id}/quote             action: re-price basket
/trips/{id}/checkout          action: create Stripe PaymentIntent
/trips/{id}/confirm           action: start booking saga (async)
/trips/{id}/cancel            action: start cancellation/compensation (async)
/trips/{id}/events            sub-resource: SSE progress stream
/trips/{id}/payment           sub-resource: payment projection (read)
/trips/{id}/refunds           sub-collection: refund records (read)
```

**On "action" endpoints vs pure REST.** `quote`, `checkout`, `confirm`, `cancel` are RPC-flavored verbs, not CRUD. This is intentional: they are **commands that drive a state machine** (§9.7), not mutations of a field. Modeling `confirm` as `PATCH /trips/{id} {status:"BOOKING"}` would be a lie — the client does not get to *set* status; it *requests a transition* the domain may accept, reject, or defer. Named action sub-resources make the state machine legible and let each action carry its own idempotency scope (§9.4) and auth rule. This is the pragmatic REST-with-controlled-actions style, not REST purism.

### Request / response contract baseline

- **JSON over HTTPS, UTF-8, ISO-8601 UTC** timestamps.
- **Money is always `{ amount: <integer minor units>, currency: <Char(3)> }`** — never a float, never a bare number (Rule 9). Serializers convert domain `Money` VO / Prisma `BigInt` → this object; `BigInt` is JSON-serialized as a number only after asserting it fits, otherwise as string. The client formats for display.
- **IDs are opaque strings** (`trip_uuid`, `pi_uuid`, `evt_uuid`). Clients treat them as opaque — never parse.
- **Cross-context references are by ID only** (Rule 8): a `Trip` response carries `paymentIntentId` / per-leg `providerRef`, never an embedded Payment row reached via a cross-context join. The full payment projection is fetched via `/trips/{id}/payment`, which the Trip context assembles by *calling the Payments context's API/read-model*, not by joining tables.

### Standard error envelope (authoritative shape)

Every 4xx/5xx returns exactly (full table in `API.md` §1.5):

```jsonc
{ "error": {
    "code": "BUSINESS_RULE",        // stable machine-readable enum
    "message": "Fare quote expired.",// human summary (not for branching)
    "details": [ { "field": "...", "issue": "..." } ], // optional, per-field
    "correlationId": "uuid",        // == X-Correlation-Id; ties to logs/traces
    "retryable": true               // is a same-key retry potentially safe?
} }
```

**`retryable` is the contract's load-bearing field.** It encodes, per response, whether the client may safely retry **with the same `Idempotency-Key`**:

| Class | Examples (`code`) | `retryable` | Client behavior |
|-------|-------------------|-------------|-----------------|
| Input | `VALIDATION_ERROR`, `BUSINESS_RULE` (`QUOTE_EXPIRED`) | `false` | Fix input / re-fetch quote |
| Auth | `UNAUTHENTICATED`, `FORBIDDEN` | `false` | Refresh token / hide action |
| Conflict | `CONFLICT`, `IDEMPOTENCY_REPLAY` | `false` (use returned state) | Adopt server state |
| Transient | `PROVIDER_UNAVAILABLE`, `INTERNAL` (some), `RATE_LIMITED` | `true` | Backoff + retry same key; honor `Retry-After` |

A single `NestExceptionFilter` (the only place that formats errors) maps domain exceptions → envelope. Domain code throws **typed domain exceptions** (`QuoteExpiredError`, `OptimisticLockError`, `CircuitOpenError`, `IdempotencyReplay`), never HTTP exceptions — keeping the domain transport-agnostic and microservice-portable.

---

## 9.4 Idempotency-Key handling mechanics

This is the single most important reliability mechanism in the API (Rules 3 & 4). It guarantees **at-most-once side effects** for **at-least-once delivery** of client requests.

### Surface

- **Required** on every state-changing `POST`/`DELETE` that creates or moves money/inventory: `POST /trips`, `/legs`, `DELETE /legs/{id}`, `/checkout`, `/confirm`, `/cancel`, `/legs/{id}/cancel`, `refunds`. The client sends a **UUID v4 per logical user action**, reused across retries of *that same action*.
- **Header:** `Idempotency-Key: <uuid>`. Missing on a required route ⇒ `400 VALIDATION_ERROR` (`code: IDEMPOTENCY_KEY_REQUIRED`).
- Reads (`GET`) and `webhooks/*` are exempt at this layer — webhooks dedupe via `platform.WebhookReceipt (unique [source, externalEventId])` instead.

### Storage & scope

Keys are persisted in **`platform.IdempotencyKey`**. The dedupe identity is a **scope + key tuple**, not the raw key alone, so the same client UUID used on two different actions can't collide and a key is bound to *one user + one operation + one request fingerprint*:

```
scope = userId : method : routeTemplate     e.g.  "u_123:POST:/trips/{id}/confirm"
identity = (scope, idempotencyKey)          ← unique index
```

```prisma
model IdempotencyKey {
  id             String   @id @default(uuid())
  scope          String   // userId:METHOD:routeTemplate
  key            String   // client UUID
  requestHash    String   // sha256 of canonical body — detects key reuse w/ different payload
  status         IdemStatus // IN_FLIGHT | COMPLETED
  responseStatus Int?     // replayed HTTP status
  responseBody   Json?    // replayed body (the canonical first response)
  lockedAt       DateTime?
  createdAt      DateTime @default(now())
  expiresAt      DateTime // TTL ~24–72h, swept by BullMQ janitor
  @@unique([scope, key])
}
```

### Lock + replay protocol (interceptor, runs before the handler)

```
                 ┌─────────────────────────── request w/ Idempotency-Key ───────────────────────────┐
                 ▼
 1. UPSERT (scope,key) status=IN_FLIGHT  ── one Prisma $transaction (local only, Rule 2) ──┐
    via INSERT ... ON CONFLICT DO NOTHING                                                   │
                 │                                                                          │
   ┌─────────────┴───────────────┬──────────────────────────────┐                          │
   │ inserted (first time)       │ existing & COMPLETED          │ existing & IN_FLIGHT     │
   ▼                             ▼                               ▼                          │
 run handler              requestHash match?               concurrent duplicate            │
   │                       ├ yes → REPLAY stored           → 409 CONFLICT                   │
   ▼                       │       responseStatus/Body       code:IDEMPOTENCY_IN_FLIGHT     │
 on success: UPDATE        └ no  → 409 CONFLICT             retryable:true (client backoff)  │
   status=COMPLETED,               code:IDEMPOTENCY_KEY_REUSED                               │
   store status+body               retryable:false                                          │
   (same tx as the                                                                          │
    saga step's write,                                                                      │
    Rule 4 outbox aware)                                                                     │
```

Key properties and the reasoning:

- **The completion record is written in the *same local transaction* as the domain state change + outbox row** — so "did the side effect happen" and "is the key marked done" can never diverge. No external call sits inside that tx (Rule 2); Stripe/provider calls already carry their *own* idempotency keys downstream (`provider.ProviderRequest unique [provider, idempotencyKey]`, Stripe `Idempotency-Key`), giving **layered idempotency**: API → saga step → provider/Stripe.
- **`requestHash` guards key reuse-with-different-body** — a client bug that reuses a key for a *different* basket gets `409 IDEMPOTENCY_KEY_REUSED`, not a silently wrong replay.
- **`IN_FLIGHT` short-circuits concurrent duplicates** (double-tap, ALB replay) with a retryable `409` rather than running the handler twice. A `lockedAt` timeout + janitor reclaims orphaned `IN_FLIGHT` rows from crashed Fargate tasks so a key is never permanently poisoned (supports RTO ≤ 30 min).
- **For async actions** (`/confirm`, `/cancel`) the stored replay body is the original `202 { status: BOOKING, pollAfterMs }` — replaying it returns the *same acknowledgment*, and the client converges on truth by polling/SSE. The saga itself is idempotent via `trip.SagaState` + `platform.ProcessedEvent`, so even a replay that slips past doesn't re-run booking.

---

## 9.5 Pagination — cursor / keyset

### Decision: opaque cursor (keyset) pagination, never offset

All list endpoints (`GET /trips`, `/events/search`, `/notifications`, `/trips/{id}/refunds`) return:

```jsonc
{ "data": [ ... ], "pageInfo": { "nextCursor": "eyJ...", "hasMore": true } }
```

The cursor is a **base64url-encoded, server-signed/opaque** tuple of the sort key(s) + tiebreaker:

```
cursor ≈ base64url({ "createdAt": "2026-05-31T10:00:00Z", "id": "trip_x" })
SQL:  WHERE (created_at, id) < ($cursorTs, $cursorId)  ORDER BY created_at DESC, id DESC  LIMIT $n+1
```

**Why keyset over offset:**

| Concern | Offset (`LIMIT/OFFSET`) | Keyset (cursor) |
|---------|-------------------------|-----------------|
| Cost at deep pages | `O(offset)` scan — degrades with millions of rows (NFR) | `O(log n)` index seek, constant per page |
| Stability under inserts | Rows shift; duplicates/skips on live data | Stable — anchored to a key |
| p95 < 200ms read NFR | Violated at depth | Holds via composite index `(created_at, id)` |

The cursor is **opaque to clients** (they must not parse/construct it) so we can change the underlying sort/encoding without a breaking change, and can include a `userId` binding + signature to prevent IDOR-style cursor tampering. `limit` is clamped (default 20, max e.g. 100). We fetch `limit+1` to compute `hasMore` without a second `COUNT(*)` (counts are deliberately omitted — exact totals are expensive and rarely needed; if a total is required it's a separate, cached call).

---

## 9.6 The async booking contract (`202` + poll + SSE + push)

### The contract

Booking and cancellation are **asynchronous**. `POST /trips/{id}/confirm` and `/cancel` return **`202 Accepted`** with the trip in a transient status (`BOOKING` / `CANCELLATION_REQUESTED`) and a `pollAfterMs` hint. The client then observes terminal state via **three interchangeable channels**:

```
            POST /trips/{id}/confirm ──► 202 {status:BOOKING, pollAfterMs:2000}
                       │  (handler did ONE local tx: persist intent-to-book + outbox trip.booking.started)
                       ▼
        ┌──────────────── saga runs on BullMQ workers (out of request path) ───────────────┐
        │ AUTHORIZE_PAYMENT → RESERVE_EVENT → RESERVE_TRANSPORT/STAY → CAPTURE → CONFIRM_LEGS│
        │      (each = one local tx + outbox; external calls between txs, never inside)      │
        └───────────────────────────────────────────────────────────────────────────────────┘
                       │ emits trip.confirmed / trip.partially_booked / trip.cancelled ...
        ┌──────────────┼───────────────────────────────────────────────┐
        ▼              ▼                                                 ▼
  (a) POLL        (b) SSE GET /trips/{id}/events                  (c) PUSH (FCM)
  GET /trips/{id}     event: leg.update / trip.update             Notifications ctx fans out
  until terminal      (live booking screen; close on terminal)    trip.confirmed → device token
```

**Terminal outcomes the client must handle:** `CONFIRMED`, `PARTIALLY_BOOKED` (anchor booked, secondary leg failed + auto-refunded), `PAYMENT_FAILED` (nothing charged), `CANCELLED` (anchor lost ⇒ auth **VOIDED**, nothing charged). These map 1:1 to the `TripStatus` machine — the API exposes *exactly* the domain enum, no API-private status set.

### Why async (sync vs async tradeoff)

| Dimension | Synchronous (block until booked) | **Asynchronous `202` (chosen)** |
|-----------|----------------------------------|---------------------------------|
| Request duration | Seconds (Stripe auth + 1–3 providers + capture); ties up a Fargate request slot | Milliseconds; request returns after one local tx |
| Survives client disconnect | ❌ booking state ambiguous if client drops | ✅ saga is durable in `trip.SagaState`; client reconnects and reads truth |
| Provider/Stripe latency spikes | Blows request timeout; cascades to thread/connection exhaustion at 200 TPS peak | Absorbed by BullMQ queue + worker concurrency; backpressure, not failure |
| Compensation (Rule 5) | Must happen *inside* the request — impossible (external calls, multi-step) | Natural — saga drives COMPENSATING async |
| HTTP semantics with Rule 2 | Forbidden: would require external calls inside the request's tx | Clean: request does local work only |

Synchronous booking is **architecturally incompatible** with Rules 2 and 5: you cannot perform Stripe + provider calls (let alone multi-step compensation) inside a request-bound transaction. Async is not a UX preference here — it's the only design consistent with the saga/outbox foundation. The cost is client complexity (must handle transient states), mitigated by giving clients three convergence channels.

**Why three channels (poll **and** SSE **and** push):**

- **Poll** `GET /trips/{id}` — universal lowest-common-denominator; always works, even if SSE/FCM fail. The trip read is a cheap cached projection. This is the *correctness fallback*; the others are *latency optimizations*.
- **SSE** `/trips/{id}/events` — live booking screen ("Reserving flight… ✓ Reserving hotel…"). Chosen over WebSockets because the stream is **server→client only**, runs over plain HTTP/2 (no upgrade, gateway-friendly), and auto-reconnects with `Last-Event-Id`. SSE events are *projections of domain events* relayed from the outbox/BullMQ to a per-trip Redis pub/sub channel; on reconnect the client first re-reads `GET /trips/{id}` to resync (events are at-least-once, the read is the truth).
- **Push (FCM)** — for when the app is backgrounded/closed; `trip.confirmed` etc. trigger a Notifications-context dispatch (deduped via `notify.Notification unique [userId, templateId, dedupeKey]`).

All three derive from the **same domain events** (§5) — no channel has private knowledge; **PostgreSQL via `GET /trips/{id}` is always the tiebreaker** (Rule 1).

---

## 9.7 HATEOAS-lite: status discoverability

Full hypermedia is overkill for a known mobile client, but a single blocking status enum forces the client to hardcode the state machine. We adopt **HATEOAS-lite**: the trip projection advertises **which actions are currently legal** given its `TripStatus`, so the UI enables/disables actions from the server's truth rather than re-implementing the transition table.

```jsonc
// GET /trips/{id} (excerpt)
{ "id": "trip_x", "status": "PLANNING",
  "_actions": {
    "addLeg":   { "method": "POST",  "href": "/api/v1/trips/trip_x/legs",     "enabled": true  },
    "quote":    { "method": "POST",  "href": "/api/v1/trips/trip_x/quote",    "enabled": true  },
    "checkout": { "method": "POST",  "href": "/api/v1/trips/trip_x/checkout", "enabled": true  },
    "confirm":  { "method": "POST",  "href": "/api/v1/trips/trip_x/confirm",  "enabled": false, "reason": "REQUIRES_AUTHORIZED_PAYMENT" },
    "cancel":   { "method": "POST",  "href": "/api/v1/trips/trip_x/cancel",   "enabled": false }
  } }
```

`_actions` is computed from the **domain state machine** (the single authority, Rule 6) — never duplicated logic. This keeps clients forward-compatible: when the transition table changes, the server's advertised actions change with it. It is *additive* (clients may ignore `_actions` and still work), so it doesn't violate the additive-only versioning rule.

---

## 9.8 Rate limiting surface

Rate limiting protects providers (whose own quotas we must respect), Stripe, and ASAP itself from abuse and spikes. It is **layered** — the cheapest layer rejects first.

| Layer | Scope | Mechanism | Rejects |
|-------|-------|-----------|---------|
| **API Gateway / ALB (edge)** | Global + per-IP | AWS API Gateway throttling / WAF rate rules | Volumetric floods, obvious abuse, before reaching Fargate |
| **App middleware** | Per-user, per-route-class | `@nestjs/throttler` backed by **ElastiCache Redis** (sliding-window/token bucket) | Per-user quotas; distinct buckets for *read* vs *mutating* vs *auth* routes |
| **Domain / saga** | Per-provider | `provider.CircuitState` + provider-context rate limiter (token bucket per provider) | Protects upstreams; surfaces as `PROVIDER_UNAVAILABLE` |

**Route classes** get different budgets: `auth/*` (tight, anti-brute-force), `events/search` (generous, cached, read-heavy), `trips/*` mutating actions (moderate; the `Idempotency-Key` makes legitimate retries free since replays don't re-execute). Buckets live in Redis so limits are **shared across all Fargate tasks**, not per-instance.

**Contract:** exceeding a limit returns `429 RATE_LIMITED` with the standard envelope, `retryable:true`, and a **`Retry-After`** header (seconds). Clients are required to honor `Retry-After` with jittered backoff. Internal/server-to-server callers (webhooks) and health checks are on separate, permissive buckets keyed by source, so a provider callback storm can't be throttled into data loss (webhooks are persisted to `WebhookReceipt` fast, processed async).

---

## 9.9 DTO validation (class-validator) & OpenAPI generation

### Validation

Every request body/query/param is a **DTO class decorated with `class-validator`**, validated by a **global `ValidationPipe`** with `{ whitelist: true, forbidNonWhitelisted: true, transform: true }`:

- `whitelist` strips unknown properties; `forbidNonWhitelisted` rejects them (`400 VALIDATION_ERROR`) — defense against parameter smuggling.
- `transform` coerces to typed instances (so `BigInt`/`Date`/enums arrive typed).
- Per-field failures populate `error.details[]` exactly in the envelope shape.

```ts
// Illustrative — interface, not implementation
class CreateTripDto {
  @ValidateNested() @Type(() => AnchorDto) anchor!: AnchorDto;
}
class AddLegDto {
  @IsEnum(LegType) type!: LegType;            // EVENT | TRANSPORT | STAY
  @IsString() @IsNotEmpty() offerId!: string;
  @IsEnum(Provider) provider!: Provider;      // AMADEUS | BOOKING_COM | ...
}
```

**Validation is *syntactic only*.** Business rules — fare `expiresAt`, "at most one active booking per `tripLegId`", `Trip→BOOKING requires PaymentIntent AUTHORIZED`, sold-out — are **domain invariants** enforced in services/aggregates (Rule 6), surfaced as `422 BUSINESS_RULE`. The boundary is strict: a DTO never knows about inventory or money invariants; that keeps validation reusable and the domain authoritative.

### OpenAPI generation

The **OpenAPI 3.1** spec is **generated from the NestJS DTOs + controllers** via `@nestjs/swagger` (the `CLI plugin` infers types from decorators, minimizing hand-written `@ApiProperty`). Served at `GET /api/v1/openapi.json`; Swagger UI at `/api/v1/docs` (non-prod only). The generated spec is the **machine source of truth** clients generate typed SDKs from (`openapi-typescript`); `API.md` is the human guide. Generating *from code* (rather than hand-writing the spec) guarantees the spec can't drift from the validated DTOs — the contract is the code.

---

## 9.10 Auth & layering on endpoints

### AuthN/AuthZ

- **Bearer JWT**: 15-min access token + rotating refresh (Identity & Access context). `Authorization: Bearer <jwt>`.
- A global **`JwtAuthGuard`** secures everything except an explicit allowlist (`@Public()`): `auth/register|login|refresh`, `health/live|ready`, public `events/search`, `events/{id}`, and the **webhook** routes (which authenticate by *signature*, not JWT — Stripe signature header, provider HMAC — verified before `WebhookReceipt` dedupe).
- **Ownership authorization**: trip routes enforce `trip.userId == jwt.sub` in a guard/policy layer; failure ⇒ `403 FORBIDDEN`, and we return `404 NOT_FOUND` for non-owned resource IDs to avoid leaking existence (IDOR hardening). Cursors are user-bound to prevent enumeration.

### Layering (controllers stay thin — Rule 7)

```
HTTP ─► Controller ─► (Guards · Pipes · Idempotency Interceptor) ─► Application Service ─► Domain ─► Repository ─► Prisma
        └ transport only ┘                                          └ owns the $transaction ┘     └ wraps Prisma ┘
```

- **Controllers** do *only* transport: bind DTO, attach `correlationId`, call one application-service method, map result → HTTP status. No business logic, **no Prisma** (Rule 7).
- **Application services own the transaction boundary** (one local `$transaction` per saga step, Rule 2) and emit via outbox (Rule 4).
- **Repositories wrap Prisma**; Prisma Client is injectable only into repositories. This layering is what makes each context independently extractable into a microservice behind the same gateway later (Rule 8).

---

## 9.11 Endpoint index (one line each, grouped by context)

> Authoritative shapes: `API.md` + OpenAPI. `Idem` = `Idempotency-Key` required. `Auth`: 🔓 public · 🔐 JWT · 🔏 signature.

### Identity & Access
| Method | Path | Auth | Idem |
|--------|------|------|------|
| POST | `/auth/register` | 🔓 | – |
| POST | `/auth/login` | 🔓 | – |
| POST | `/auth/mfa/verify` | 🔓 (mfaToken) | – |
| POST | `/auth/refresh` | 🔓 (refresh) | – |
| POST | `/auth/logout` | 🔐 | – |
| GET / PATCH | `/me` | 🔐 | – |
| POST | `/me/devices` | 🔐 | – |
| GET / PATCH | `/me/notification-preferences` | 🔐 | – |

### Discovery (read-only, cacheable)
| Method | Path | Auth | Idem |
|--------|------|------|------|
| GET | `/events/search` | 🔓 | – |
| GET | `/events/{eventId}` | 🔓 | – |
| GET | `/recommendations/trip` | 🔐 | – |

### Trip Orchestration (CORE)
| Method | Path | Auth | Idem |
|--------|------|------|------|
| POST | `/trips` | 🔐 | ✅ |
| GET | `/trips` | 🔐 | – |
| GET | `/trips/{id}` | 🔐 | – |
| POST | `/trips/{id}/legs` | 🔐 | ✅ |
| DELETE | `/trips/{id}/legs/{legId}` | 🔐 | ✅ |
| POST | `/trips/{id}/quote` | 🔐 | – |
| POST | `/trips/{id}/confirm` | 🔐 | ✅ (→ **202**) |
| POST | `/trips/{id}/cancel` | 🔐 | ✅ (→ **202**) |
| POST | `/trips/{id}/legs/{legId}/cancel` | 🔐 | ✅ (→ **202**) |
| GET | `/trips/{id}/events` | 🔐 | – (SSE) |

### Payments (CORE)
| Method | Path | Auth | Idem |
|--------|------|------|------|
| POST | `/trips/{id}/checkout` | 🔐 | ✅ |
| GET | `/trips/{id}/payment` | 🔐 | – |
| GET | `/trips/{id}/refunds` | 🔐 | – |

### Notifications
| Method | Path | Auth | Idem |
|--------|------|------|------|
| GET | `/notifications` | 🔐 | – |
| POST | `/notifications/{id}/read` | 🔐 | – |

### Webhooks (server-to-server) & Platform
| Method | Path | Auth | Idem |
|--------|------|------|------|
| POST | `/webhooks/stripe` | 🔏 sig | dedupe via `WebhookReceipt` |
| POST | `/webhooks/providers/{provider}` | 🔏 sig | dedupe via `WebhookReceipt` |
| GET | `/health/live` · `/health/ready` | 🔓 | – |
| GET | `/openapi.json` (· `/docs` non-prod) | 🔓 | – |

---

## 9.12 REST vs GraphQL — and summary of tradeoffs

| Concern | **REST (chosen)** | GraphQL (rejected for v1) |
|---------|-------------------|---------------------------|
| Idempotency on mutations | Natural per-endpoint `Idempotency-Key` scope | Mutations multiplex over one POST — `scope` derivation awkward; idempotency per-field is unsolved |
| Caching (read p95<200ms NFR) | HTTP cache + CDN on `GET /events/*` trivially | Single POST endpoint defeats HTTP caching; needs bespoke persisted-query cache |
| Async `202` + SSE booking | First-class HTTP semantics | GraphQL has no clean `202`; subscriptions add a second transport to operate |
| Rate-limit & WAF by route | Per-path budgets at the gateway | One endpoint ⇒ can't throttle by operation at the edge; cost-analysis required |
| Provider/abuse blast radius | Bounded per endpoint | Arbitrary query shape ⇒ harder to bound fan-out to providers |
| Client convenience / over-fetching | Slightly chattier; mitigated by `GET /trips/{id}` returning a full projection | GraphQL's win — flexible selection |

GraphQL's strength (flexible client-shaped reads) is marginal here because the dominant read (`GET /trips/{id}`) is a single well-known aggregate projection, while its weaknesses (idempotent money mutations, edge caching, edge rate-limiting, `202`/SSE async semantics) collide directly with ASAP's reliability foundation. **REST under `/api/v1` with controlled action sub-resources is the lower-risk, more operable fit** for a money-correctness-critical, provider-fan-out, async-saga platform. A read-only GraphQL/BFF facade over the same services remains an *additive* future option if client over-fetching becomes a real pain point — it does not require changing the core contract documented here.

---

**Cross-references:** error envelope/status enums → `API.md` §1.5, §10; domain events behind SSE/push → §5; saga steps behind `202` → §6; state machines behind `_actions` → §4; idempotency/outbox/webhook tables → Platform/Shared Kernel (§2, §8).
