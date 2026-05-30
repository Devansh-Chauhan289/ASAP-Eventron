# Section 13 — Security Architecture

> Scope: this section defines the security posture for ASAP's modular monolith. It honors the foundational rules (PostgreSQL system of record; Prisma never in controllers; idempotency everywhere; no external calls inside a DB tx; outbox for atomic publish). Security controls are layered defense-in-depth across the edge (API Gateway/WAF), the application (NestJS guards/pipes/interceptors), the data layer (Prisma + RDS/S3 KMS), and the financial boundary (Stripe SAQ-A). Every control below names a concrete table, enum, event, or context from the canonical foundation.

---

## 13.1 Threat Model (what we are defending against)

We design against a realistic adversary set, not happy-path. The NFRs (millions of bookings/yr, payment correctness 100%, money via double-entry ledger) make **financial fraud, replay, and IDOR** the highest-severity threats.

| ID | Threat | Primary asset at risk | Severity |
|----|--------|----------------------|----------|
| T1 | Credential stuffing / brute force | Identity & Access (`users`, sessions) | High |
| T2 | Token theft / refresh replay | Sessions, all authZ | Critical |
| T3 | IDOR — user reads/cancels another user's `trip.Trip` | Trip Orchestration, Payments | Critical |
| T4 | Privilege escalation (USER → OPS/ADMIN) | Refunds, cancellation, ledger | Critical |
| T5 | Payment fraud / stolen card | `payment.PaymentIntent`, ledger | Critical |
| T6 | Idempotency-key replay → double-charge / double-book | PaymentIntent, Booking, ledger | Critical |
| T7 | Forged Stripe / provider webhook | Payment state machine, saga | Critical |
| T8 | SSRF via provider adapters / image URLs | Internal network, Secrets Manager metadata | High |
| T9 | SQL injection / mass assignment | All tables | High |
| T10 | Secret leakage (env, logs, code) | Stripe keys, DB creds, JWT keys | Critical |
| T11 | PII exfiltration / GDPR non-compliance | `users` PII, trip history | High |
| T12 | DDoS / traffic spike abuse → cost + outage | Availability (99.9%) | High |
| T13 | Velocity abuse (booking spam, scalping, refund farming) | Inventory, ledger | Medium-High |
| T14 | Insider / OPS misuse of refund/cancel powers | Ledger, money movement | High |

The controls table in §13.12 maps each threat to concrete mitigations.

---

## 13.2 Authentication (AuthN)

### 13.2.1 JWT — RS256, asymmetric, short access + rotating refresh

**Decision:** Access tokens are **RS256** (asymmetric), 15-minute TTL. Refresh tokens are opaque, long-lived (e.g. 30 days), **rotating**, and stored **hashed** in the Identity & Access context.

**Why RS256 over HS256:** Asymmetric signing means only the Identity context (in the monolith today, a dedicated auth service tomorrow per the microservice-ready cut-line) holds the **private key**. Every other module — and downstream microservices after extraction — verifies with the **public key (JWKS)**. This avoids distributing a shared HMAC secret across bounded contexts, which would violate the "secrets minimization" principle and create a blast radius where any context could mint tokens.

**Tradeoff:** RS256 verification is ~10x slower than HS256. At ~200 peak TPS this is negligible (<1ms/verify) and we cache the JWKS public key in-process. Worth it for the key-isolation property.

```
Access JWT claims:
{
  sub:  userId,
  sid:  sessionId,          // ties token to a revocable session row
  role: "USER" | "OPS" | "ADMIN",
  scope: [...],
  jti:  uuid,               // for deny-list on forced logout
  iat, exp (15m), iss: "asap-identity", aud: "asap-api",
  kid:  "<key-id>"          // enables key rotation without downtime
}
```

**Key rotation:** `kid` header selects the signing key. We publish a JWKS endpoint with current + previous public keys so in-flight tokens survive rotation. Private signing key lives in **AWS Secrets Manager**, rotated on schedule; the public set is cached and refreshed on `kid` miss.

### 13.2.2 Refresh token rotation + theft detection

Refresh tokens are the highest-value AuthN asset (T2). Rules:

- Stored **hashed** (Argon2id or HMAC-SHA256 with a server pepper from Secrets Manager) — never plaintext. A DB dump must not yield usable refresh tokens.
- **Rotation on use:** each refresh issues a new refresh token and invalidates the old one (mark consumed). 
- **Reuse detection:** if a *consumed* refresh token is presented again → this signals theft (attacker + victim both holding the chain). We **revoke the entire session family** (all descendants), force re-auth, and emit an audit event + security notification.

```
session row (Identity context):
  id, userId, refreshTokenHash, familyId, parentId,
  status: ACTIVE | CONSUMED | REVOKED,
  ip, userAgentHash, createdAt, expiresAt, lastUsedAt
```

### 13.2.3 Passwords — Argon2id

Passwords hashed with **Argon2id** (memory-hard; tuned, e.g. m=64MB, t=3, p=1 — calibrated to ~200-300ms on Fargate task size). Per-password salt + a global **pepper** from Secrets Manager (so a DB-only breach is insufficient). We never store, log, or return password material. Login is constant-time on the "user not found" path to avoid user enumeration.

### 13.2.4 MFA (TOTP)

MFA is **TOTP** (RFC 6238), stored as an encrypted seed in the Identity context (`device tokens`/MFA tables). 

- Enforced for **OPS and ADMIN roles unconditionally** (they touch refunds/ledger — T14).
- Optional-but-encouraged for USER; **step-up required** for high-risk USER actions (changing payment method, large refunds).
- Backup codes are single-use, hashed.
- TOTP verification has its own rate limit + lockout to prevent code brute force.

### 13.2.5 Session revocation

Because access tokens are stateless JWTs, immediate revocation needs a fast-path. Design:

- **`sid` + `jti` deny-list in Redis** (ElastiCache), TTL = remaining access-token lifetime (max 15min). On logout / forced revoke / refresh-reuse detection, we add `sid` to the deny-list.
- A lightweight Nest guard checks Redis on each request. Redis is **derived/transport** (Rule 1) — the authoritative `status` lives in the Postgres session row; Redis is the hot cache. On Redis outage we fail toward the DB session check (correctness over latency for auth).

---

## 13.3 Authorization (AuthZ)

Two independent layers — **RBAC** (coarse) and **ownership/resource policy** (fine). Both are enforced in **Nest guards**, never in controllers' business logic, and never by trusting client-supplied IDs.

### 13.3.1 RBAC

Roles: `USER`, `OPS`, `ADMIN`.

| Capability | USER | OPS | ADMIN |
|------------|------|-----|-------|
| Create/confirm/cancel **own** trip | ✅ | ✅ (any, audited) | ✅ |
| Read **own** trip | ✅ | ✅ (any) | ✅ |
| Initiate own refund request | ✅ | ✅ | ✅ |
| **Approve** refund (`RefundStatus: APPROVED/DENIED`) | ❌ | ✅ | ✅ |
| Force-cancel / manual compensation (`COMPENSATING`) | ❌ | ✅ | ✅ |
| Resolve `NEEDS_ATTENTION` trips / `FAILED_NEEDS_ATTENTION` refunds | ❌ | ✅ | ✅ |
| Manage users / roles, view ledger config | ❌ | ❌ | ✅ |

`@Roles('OPS','ADMIN')` decorator + `RolesGuard`. Role comes from the **verified JWT claim**, re-checked against the live `users` row on sensitive mutations (a demoted user's old token must not retain power until expiry — combined with the §13.2.5 deny-list).

### 13.3.2 Ownership / resource-level policy (IDOR prevention — T3)

The single most dangerous web bug for ASAP is IDOR: `GET /trips/{id}`, `POST /trips/{id}/cancel`, `POST /trips/{id}/checkout` must **never** return or mutate a trip the caller doesn't own.

**Rule:** every resource access is scoped by `userId` **at the repository query level**, not filtered after fetch.

```ts
// repository (wraps Prisma — Rule 7). userId is ALWAYS a query predicate.
async findOwnedTrip(tripId: string, userId: string) {
  return this.prisma.trip.findFirst({ where: { id: tripId, userId } });
  // returns null if not owned -> guard/service throws 404 (not 403, to avoid existence oracle)
}
```

A `TripOwnershipGuard` resolves the trip via the repository and rejects with **404** (not 403 — avoid leaking existence). OPS/ADMIN bypass ownership via an explicit policy branch that **forces an `platform.AuditLog` write** (T14). Cross-context references are by ID only (Rule 8): a Payments query for a `paymentIntentId` independently re-derives ownership from the owning trip's `userId` — we never trust that "the trip guard already checked."

### 13.3.3 Policy engine shape

A small `PolicyService` centralizes `can(actor, action, resource)` so authZ logic is testable and not scattered. Guards call it; controllers stay thin (no Prisma, no policy logic). This keeps the microservice cut-line clean — when Payments extracts, it carries its own policy checks.

---

## 13.4 Secrets Management

**Rule: no secret in env files, code, container images, or logs.** (T10)

| Secret | Store | Rotation | Access |
|--------|-------|----------|--------|
| JWT RS256 private key | Secrets Manager (KMS-encrypted) | Scheduled, `kid` overlap | Identity context task role only |
| Stripe secret + webhook signing secret | Secrets Manager | Manual/rotated via Stripe dashboard + Secrets update | Payments context task role only |
| DB credentials (RDS) | Secrets Manager w/ **RDS managed rotation** | Automatic (Lambda rotator) | App task role |
| Provider API keys (Ticketmaster, Amadeus, Uber…) | Secrets Manager, per-provider | Provider-dependent | Provider Integration task role |
| Password pepper / refresh HMAC pepper | Secrets Manager | Rare, dual-key overlap | Identity context |
| SendGrid / FCM keys | Secrets Manager | Scheduled | Notifications context |

- Fetched at boot + cached in memory with TTL; **never** baked into the Docker image or ECS task definition plaintext env. Task definitions reference Secrets Manager ARNs via the `secrets` field so values are injected by the agent, not stored.
- **KMS** customer-managed keys; access via Fargate **task IAM roles** scoped per context (least privilege — the Discovery read service holds no Stripe key).
- CloudWatch log redaction filters on secret-shaped strings as a backstop; structured logger has an allow-list serializer (never logs `authorization`, `password`, `refreshToken`, `card*`).

---

## 13.5 PCI DSS — SAQ-A Scope Minimization

**Goal: cardholder data never touches ASAP servers, logs, or DB.** This keeps us in **SAQ-A** (the lightest PCI scope) rather than SAQ-A-EP or SAQ-D.

| Control | Implementation |
|---------|---------------|
| Card capture | **Stripe Elements** client-side; card data → Stripe directly. ASAP only ever sees a `paymentMethodId` / `PaymentIntent` client secret. |
| No PAN at rest | No card number, CVV, or full PAN in any table. `payment.Charge` stores Stripe IDs + last4/brand (non-sensitive) only. |
| Manual capture | `PaymentStatus` AUTHORIZED (requires_capture) → CAPTURED. Auth-then-capture means the common failure outcome is **VOIDED (zero money moved)** — minimizes financial exposure on saga failure. |
| Webhook signature verification | `POST /webhooks/stripe` verifies `Stripe-Signature` with the signing secret **before** any parsing/processing (see §13.6). |
| TLS everywhere | TLS 1.2+ enforced at API Gateway and to Stripe. |
| Scope isolation | Only the **Payments** context module touches Stripe SDK; no other context imports it (bounded-context rule reinforces PCI boundary). |

Because we're SAQ-A, the audited scope is essentially "the integration glue," not a card environment — dramatically lower compliance burden and breach blast radius.

---

## 13.6 Webhook Security (Stripe + Providers)

Webhooks are an **inbound, internet-facing, state-changing** surface that drives the payment state machine and saga — a forged webhook (T7) could fake a `payment.captured` and confirm a trip with no money. Defense:

1. **Signature verification first.** Stripe: HMAC verify `Stripe-Signature` (with tolerance window against replay) using the Secrets Manager signing secret. Providers: per-provider signature/HMAC or mTLS via the Provider ACL. Reject pre-parse on failure.
2. **Idempotent receipt.** Persist into `platform.WebhookReceipt` with **unique [source, externalEventId]**. A duplicate (Stripe retries aggressively, at-least-once) hits the unique constraint → we ack 200 and no-op. This is the replay/dedup guarantee.
3. **No business logic in the HTTP handler.** The webhook controller (no Prisma — Rule 7) verifies + records the receipt in one tx, writes an `platform.OutboxEvent`, returns 200 fast. Async workers (BullMQ) drive the payment state transition and saga — keeping the external call out of the request path and out of any DB tx (Rule 2).
4. **Reconcile, don't trust blindly.** Webhook says `captured`? We still treat Postgres ledger as system of record and reconcile against Stripe (the Payments reconciliation job). A webhook is a trigger, not the truth.

```
Stripe → API GW (WAF) → /webhooks/stripe
   ├─ verify Stripe-Signature  (else 400, no processing)
   ├─ tx: insert WebhookReceipt[source=stripe, externalEventId]  -- unique guard = dedup
   │       + insert OutboxEvent(payment.captured / payment.voided / payment.disputed ...)
   ├─ return 200 immediately
   └─ BullMQ worker → ProcessedEvent dedup → drive PaymentStatus + SagaState
```

---

## 13.7 OWASP Top 10 Protections

| OWASP | ASAP control |
|-------|--------------|
| **A01 Broken Access Control (IDOR)** | Ownership scoping at repository query level + 404 not 403; OPS/ADMIN bypass audited (§13.3.2). |
| **A02 Cryptographic Failures** | RS256 JWT, Argon2id, TLS 1.2+, KMS at rest, refresh tokens hashed, no secrets in logs. |
| **A03 Injection (SQLi)** | **Prisma parameterized queries only**; `$queryRaw` forbidden unless `Prisma.sql` tagged (lint rule). No string-built SQL. |
| **A04 Insecure Design** | Saga + compensation + outbox + idempotency are the secure-by-design core; explicit state machines enforced in domain layer. |
| **A05 Security Misconfiguration** | `helmet` security headers, strict CORS allow-list, disable `x-powered-by`, least-priv IAM, no default creds. |
| **A06 Vulnerable Components** | `npm audit` + Dependabot/Renovate in CI; pinned lockfile; image scanning (ECR scan on push). |
| **A07 AuthN Failures** | Brute-force lockout, MFA, session revocation, refresh rotation+reuse detection (§13.2). |
| **A08 Software/Data Integrity** | Signed webhooks, outbox integrity, image provenance, CI artifact signing. |
| **A09 Logging/Monitoring Failures** | `platform.AuditLog` for sensitive mutations, CloudWatch alarms on auth-fail spikes / 4xx-5xx anomalies, correlationId tracing. |
| **A10 SSRF** | Provider call **egress allow-list** + URL validation (§13.9). |

### 13.7.1 Input validation & mass assignment

- Global `ValidationPipe` with **`whitelist: true` + `forbidNonWhitelisted: true` + `transform: true`** via **class-validator/class-transformer DTOs**. Unknown properties are stripped/rejected → blocks **mass assignment** (T9): a client cannot smuggle `role`, `userId`, `status`, `capturedAmount`, or `version` into a body.
- Money fields validated as BigInt minor units + ISO `Char(3)` currency (Rule 9). Amounts are never taken from the client for capture — derived from the authoritative `priceSnapshot` / `FareQuote`.
- DTOs are explicit input shapes; domain aggregates are never bound directly from request bodies.

### 13.7.2 Rate limiting & brute-force lockout (T1, T12, T13)

Layered:

| Layer | Mechanism | Target |
|-------|-----------|--------|
| Edge | **API Gateway / WAF** rate rules + AWS Shield | Volumetric DDoS, bad bots |
| App global | Redis-backed throttler (per IP + per user) | General abuse |
| Auth endpoints | Stricter per-account + per-IP limits; **progressive lockout** (exponential backoff, temp lock after N fails) | Credential stuffing (T1) |
| Business velocity | Per-user booking/refund velocity checks (§13.10) | Scalping, refund farming (T13) |

Lockout state is in Redis (fast) with the authoritative counter/flag persisted for OPS visibility. Idempotency-Key replay (below) prevents the rate limiter being bypassed by re-submission.

### 13.7.3 Idempotency as replay-abuse control (T6)

`Idempotency-Key` (UUID) is **required** on all state-changing POSTs (`/checkout`, `/confirm`, `/cancel`, refunds, `/legs`). Stored in `platform.IdempotencyKey`. A replayed key returns the **original stored response**, not a re-execution. This is simultaneously:
- a correctness control (no double-charge/double-book), and
- a **security control**: an attacker replaying a captured request cannot trigger a second money movement. The unique `provider.ProviderRequest [provider, idempotencyKey]` and `payment.PaymentIntent` idempotency key extend this to the provider/Stripe boundary.

---

## 13.8 API & Edge Security

| Control | Detail |
|---------|--------|
| **WAF (API Gateway)** | Managed rule sets (SQLi/XSS/bad-bot), geo/IP reputation, rate-based rules, custom rules on `/auth/*` and `/webhooks/*`. |
| **Request size limits** | Body size cap (e.g. 256KB for JSON; reject oversized) to prevent memory-exhaustion DoS; multipart limited. |
| **Security headers (helmet)** | HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`, referrer policy, CSP for any served HTML. |
| **CORS** | Strict allow-list of known web/mobile origins; credentials mode controlled; no wildcard with credentials. |
| **TLS** | TLS 1.2+ terminated at API Gateway; HTTP→HTTPS redirect; modern cipher suite. |
| **JWT at edge + app** | API Gateway can do coarse JWT/authorizer; the app re-verifies (defense in depth — never trust the gateway alone). |
| **SSE auth** | `GET /trips/{id}/events` (SSE) carries the same JWT + ownership guard; long-lived connection re-checked against session revocation. |
| **Audit** | `platform.AuditLog` records actor, action, resource, correlationId, before/after for sensitive mutations (refund approve, force-cancel, role change). |
| **Error envelope** | Standard `{ error: { code, message, details[], correlationId, retryable } }` — never leaks stack traces, SQL, or internal IDs of other users. |

---

## 13.9 SSRF Protection — Provider Integration ACL (T8)

The Provider Integration context makes outbound calls to many third parties and may fetch provider-supplied URLs (event images, deep links). This is the SSRF surface — a malicious or compromised provider response could point us at `169.254.169.254` (instance metadata → could leak the task IAM role) or internal services.

Controls:
- **Egress allow-list:** provider base URLs are configured constants (from Secrets Manager / config), not derived from request input. Adapters only call known hosts.
- **URL validation for any dynamic fetch:** reject non-HTTPS, reject private/link-local/loopback CIDRs (RFC 1918, `169.254.0.0/16`, `::1`, etc.), resolve-then-validate to defeat DNS rebinding, disable redirects to non-allow-listed hosts.
- **No raw user/provider URL passthrough** to `fetch`/HTTP client.
- **Network-level egress controls:** Fargate tasks in private subnets; egress via NAT with security-group/egress rules; **IMDSv2 enforced** (hop limit 1) so SSRF cannot trivially reach instance metadata.
- All provider calls go through the ACL's rate limiter + circuit breaker (`provider.CircuitState`) — which also bounds abuse-amplification.

---

## 13.10 Abuse & Fraud Prevention

| Threat | Control |
|--------|---------|
| Stolen card / fraudulent payment (T5) | **Stripe Radar** rules + 3DS / `REQUIRES_ACTION` step-up; manual-capture means we can **VOID** a flagged authorization before any money moves. |
| Booking spam / scalping (T13) | Per-user **velocity checks**: max trips/confirms per window, max concurrent `PENDING_PAYMENT`/`BOOKING` trips; throttle on repeated quote→abandon. |
| Refund farming (T14/T13) | Refunds require OPS approval beyond a threshold (`RefundStatus: REQUESTED → APPROVED/DENIED`); velocity on refund requests; `FAILED_NEEDS_ATTENTION` routes to OPS. |
| Account takeover follow-on | New-device / new-IP triggers step-up MFA before high-value actions; refresh-reuse → family revoke. |
| Chargeback abuse | `payment.Dispute` / CHARGEBACK tracked in ledger; repeat-offender signal feeds Radar + account risk flags. |

Velocity state lives in Redis for speed; **the financial truth is always the double-entry ledger** (`payment.LedgerEntry`, debits==credits) — fraud heuristics never bypass ledger invariants.

---

## 13.11 Data Protection, PII & GDPR

| Control | Detail |
|---------|--------|
| **Encryption at rest** | RDS Postgres + S3 + ElastiCache + EBS encrypted with **KMS** CMKs. Backups/snapshots encrypted. |
| **Encryption in transit** | TLS 1.2+ client→edge, edge→app, app→RDS (SSL enforced), app→Redis (in-transit encryption), app→Stripe/providers. |
| **PII handling** | PII (name, email, device tokens) confined to **Identity & Access**; other contexts reference `userId` only (Rule 8). Minimize PII in events/payloads and logs. |
| **No sensitive data in events** | Domain event payloads carry IDs + non-sensitive projections, not raw PII or card data; outbox events are internal but still minimized. |
| **GDPR delete / right to erasure** | A coordinated **erasure saga**: anonymize/redact PII in Identity, while preserving **financial records** (ledger, charges) under legal-retention obligation — replace PII references with a tombstone. Money/audit records are immutable; we pseudonymize rather than hard-delete where retention law requires. |
| **Data export (portability)** | User can request export of their trips/bookings (own-scoped queries). |
| **Retention** | TTL policies on logs, idempotency keys, webhook receipts, deny-list (Redis TTL); ledger/audit retained per finance/legal. |
| **Audit immutability** | `platform.AuditLog` append-only; tamper-evident (sequence + correlationId). |

**Key tension (architect's note):** GDPR "delete everything" conflicts with PCI/financial "retain ledger." We resolve it by **separating identity PII (erasable) from financial facts (retained, pseudonymized)** — enabled directly by the bounded-context rule that money records reference `userId` logically rather than embedding PII.

---

## 13.12 Controls → Threats Traceability Matrix

| Control | Mitigates | Layer |
|---------|-----------|-------|
| Argon2id + pepper, constant-time login | T1 | App/Identity |
| Brute-force lockout + auth rate limits + WAF | T1, T12 | Edge + App |
| RS256 short access, hashed rotating refresh, reuse detection | T2 | App/Identity |
| Redis `sid`/`jti` deny-list + DB session truth | T2 | App |
| Repository-level ownership scoping, 404 not 403 | T3 | App/Repo |
| RBAC guard + live role re-check + deny-list | T4 | App |
| OPS/ADMIN bypass forces `AuditLog` | T4, T14 | App |
| Stripe Elements (SAQ-A), no PAN at rest, manual capture VOID | T5 | Payments |
| Stripe Radar + 3DS/`REQUIRES_ACTION` step-up | T5 | Payments |
| `IdempotencyKey`, `ProviderRequest` unique, PaymentIntent idem key | T6 | App/Data |
| Webhook signature verify + `WebhookReceipt` unique [source, externalEventId] | T7 | Payments/Edge |
| Provider egress allow-list, URL/CIDR validation, IMDSv2, private subnets | T8 | ACL/Infra |
| Prisma parameterization, `ValidationPipe` whitelist, `$queryRaw` lint ban | T9 | App/Data |
| Secrets Manager + KMS + task IAM roles, log redaction | T10 | Infra |
| KMS at rest, TLS in transit, PII isolation, GDPR erasure saga | T11 | Data/Infra |
| API Gateway WAF + Shield + request size limits | T12 | Edge |
| Per-user velocity checks, refund approval threshold | T13 | App |
| MFA-required for OPS/ADMIN, audited privileged actions, ledger invariants | T14 | App/Identity |

---

## 13.13 Security & Reliability Interplay (so security doesn't break the saga)

Security must not violate the foundational rules:

- **No external auth call inside a DB tx** (Rule 2): JWKS fetch, Secrets Manager fetch, Stripe verify all happen outside Prisma `$transaction` boundaries.
- **Redis is derived** (Rule 1): deny-list and rate-limit state are hot caches; on Redis failure, auth degrades to the authoritative Postgres session check rather than failing open.
- **Fail closed on authZ, fail safe on availability:** ambiguous authorization → deny (404/403). But a Stripe Radar/Secrets timeout must not silently authorize — payment proceeds only on explicit success, and the saga's compensation path (`COMPENSATING` → VOIDED/refund) is the safety net.
- **Audit is part of the transaction** for privileged money actions: the `platform.AuditLog` write and the `OutboxEvent` are in the **same local tx** as the state change, so we never lose the audit trail (no external call, so Rule 2 holds).

This keeps the security architecture consistent with the saga/outbox/compensation core: every security control is either at the edge, in a guard/pipe/interceptor, or a same-tx Postgres write — never an external call inside a DB transaction, and never trusting a client-supplied identifier.
