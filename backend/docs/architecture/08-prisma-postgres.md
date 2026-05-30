# Section 8 — PostgreSQL + Prisma Architecture

**PostgreSQL is the system of record. Prisma is the only ORM. Every table originates in `schema.prisma`; every change ships as a Prisma migration.** Prisma Client never reaches a controller — repositories wrap it, and **services own transaction boundaries** via `prisma.$transaction`.

## 8.1 Modeling principles (applied throughout)

1. **Money = `BigInt` minor units + `currency` (char 3).** Never `Float`/`Decimal` for money movement (avoids rounding/format ambiguity). `BigInt` survives large aggregate totals.
2. **State = enums**, with transitions enforced in the domain layer (DB stores the value; app guards the move). Optionally a DB `CHECK`/trigger as a backstop (added via raw migration).
3. **Idempotency = unique constraints**, not application checks alone. Race-safe by the DB.
4. **Bounded contexts do not FK across each other in v1 for the cut-line tables** — they reference by ID. *Exception:* within a context we use real FKs. Cross-context references (e.g. `TripLeg.bookingId`) are **logical** (indexed columns, no FK) so a context can later move to its own database without a cross-DB FK. This is a deliberate tradeoff: we lose DB-level referential integrity across contexts in exchange for clean extraction; integrity is enforced by the saga + reconciliation.
4. **Outbox table** guarantees atomic event publication.
5. **Soft-delete only where audit/compliance requires** (`deletedAt`); booking/payment records are **never hard-deleted** (financial audit).
6. **Every high-cardinality lookup and every saga/reconciliation query has an explicit index.** Composite indexes match query predicates left-to-right.
7. **`createdAt`/`updatedAt`** on every table; `@updatedAt` managed by Prisma.
8. **Optimistic concurrency** via a `version Int @default(0)` column on hot aggregates (Trip, PaymentIntent, Booking) — repositories increment & check to prevent lost updates under concurrent saga steps.

## 8.2 Transaction boundary policy (the core of "rollback on failure")

> **Rule:** every write that must be all-or-nothing executes inside a single `prisma.$transaction(async (tx) => { … })`. **Crucially, no external network call (Stripe, providers, BullMQ) ever happens inside a DB transaction.** External effects are recorded as outbox rows committed atomically with the state change, then performed by workers. This is what makes "if anything fails, the whole thing rolls back" actually true — within each saga step.

| Operation | Transaction scope (one `$transaction`) | Why |
|-----------|----------------------------------------|-----|
| Create trip from anchor | Trip + TripLegs + initial SagaState + `trip.created` outbox | Aggregate must appear whole or not at all |
| Confirm basket | lock totals on Trip + legs priceSnapshot + `trip.basket.confirmed` outbox | Consistent basket |
| Record reservation result | Booking status change + TripLeg denormalized status + outbox event | State + projection + event atomic |
| Create PaymentIntent locally | PaymentIntent + idempotency_key row + ledger draft + `payment.intent.created` outbox | Money record + idempotency atomic (then call Stripe in worker) |
| Capture | PaymentIntent→CAPTURED + ledger entries (balanced) + `payment.captured` outbox | Ledger must balance in the same tx (INV-P1) |
| Issue refund | Refund + ledger credit + TripLeg compensation flags + `payment.refund.requested` outbox | Compensation recorded atomically |
| Webhook ingestion | dedupe row + state transition + outbox | Idempotent webhook processing |

**Pattern (illustrative — full code comes in §17 implementation phase):**
```ts
// Service owns the boundary. Repos take the `tx` client. No I/O to Stripe/providers in here.
await this.prisma.$transaction(async (tx) => {
  const intent = await this.paymentRepo.create(tx, { ... });      // INSERT payment_intents
  await this.ledgerRepo.append(tx, balancedEntries(intent));      // INSERT ledger_entries (Σdr=Σcr)
  await this.idempotencyRepo.claim(tx, key, intent.id);           // INSERT idempotency_keys (unique)
  await this.outboxRepo.add(tx, paymentIntentCreated(intent));    // INSERT outbox_events
}, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10_000 });
// AFTER commit, a worker reads the outbox and calls Stripe with the idempotency key.
```
**Isolation levels:** default `ReadCommitted`; **`Serializable`** for money-moving and idempotency-claiming transactions (prevents write-skew on balance/idempotency); rely on Postgres serialization-failure retries (wrap in a bounded retry). Document per-repository which level is used.

## 8.3 Indexing & query strategy (explicit, per requirement #7/#8)

| Query (hot path) | Index | Type |
|------------------|-------|------|
| "my trips, latest first" | `(userId, createdAt desc)` on Trip | composite |
| Saga poll "trips stuck in BOOKING/COMPENSATING" | `(status, updatedAt)` on Trip | composite, partial: `WHERE status IN (...)` |
| Leg lookup by trip | `(tripId, sequence)` on TripLeg | composite |
| Booking by trip leg (dedupe) | unique `(tripLegId)` on each booking | unique |
| Idempotency lookup | unique `(scope, key)` on idempotency_keys | unique |
| Provider request dedupe | unique `(provider, idempotencyKey)` | unique |
| Outbox relay scan | `(publishedAt)` partial `WHERE publishedAt IS NULL` | partial |
| Webhook dedupe | unique `(source, externalEventId)` | unique |
| Payment by Stripe id | unique `(stripePaymentIntentId)` | unique |
| Ledger by account/time | `(accountId, createdAt)` | composite |
| Refund reconciliation | `(status, updatedAt)` partial on non-terminal | partial |
| Notification retry scan | `(status, nextAttemptAt)` partial | partial |
| Event search (Discovery cache miss → DB) | GIN on `tsvector(title, description)` + `(startsAt)` + geo | GIN + btree |

**Query optimization strategy:**
- **Keyset (cursor) pagination** for trip/booking lists (`WHERE (createdAt,id) < (:cursor)`), never `OFFSET` at scale.
- **Partial indexes** for "in-flight" rows so the saga poller scans tiny hot sets, not whole tables.
- **Covering selects** via Prisma `select` (never `findMany` of whole rows on hot paths) to keep the working set in cache.
- **No N+1**: use `include`/`in` batching in repositories; the saga loads a Trip with legs in one query.
- **`pg_partman` time-partitioning** planned for `outbox_events`, `ledger_entries`, `audit_log`, `notifications` (append-heavy, time-series) — see §8.6.
- **PgBouncer (transaction pooling)** in front of RDS; Prisma `connection_limit` tuned to `(num_tasks * pool) < max_connections`.

## 8.4 The `schema.prisma` (canonical)

> File location: `backend/prisma/schema.prisma`. Reproduced here as the source of all models. Split into per-context `.prisma` files using Prisma's multi-file schema in implementation; shown unified for review.

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["multiSchema", "postgresqlExtensions", "fullTextSearchPostgres"]
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [pg_trgm, postgis(version: "3.4"), uuidOssp(map: "uuid-ossp")]
  schemas    = ["identity", "trip", "booking", "payment", "notify", "provider", "platform"]
}

// ============================ ENUMS ============================
enum TripStatus {
  DRAFT PLANNING PENDING_PAYMENT PAYMENT_FAILED BOOKING CONFIRMED
  PARTIALLY_BOOKED COMPENSATING CANCELLATION_REQUESTED CANCELLED
  COMPLETED NEEDS_ATTENTION
  @@schema("trip")
}
enum LegType { EVENT TRANSPORT STAY @@schema("trip") }
enum BookingStatus {
  PENDING RESERVED RETRYING CONFIRMED RELEASING RELEASED
  CANCELLING CANCELLED EXPIRED REJECTED FAILED FULFILLED
  @@schema("booking")
}
enum TransportMode { FLIGHT TRAIN BUS RIDESHARE @@schema("booking") }
enum PaymentStatus {
  CREATED REQUIRES_PAYMENT_METHOD REQUIRES_CONFIRMATION REQUIRES_ACTION
  PROCESSING AUTHORIZED CAPTURED VOIDED FAILED
  PARTIALLY_REFUNDED REFUNDED DISPUTED CHARGEBACK
  @@schema("payment")
}
enum RefundStatus {
  REQUESTED APPROVED DENIED AWAITING_PROVIDER PROCESSING
  SUCCEEDED RETRYING FAILED_NEEDS_ATTENTION
  @@schema("payment")
}
enum LedgerDirection { DEBIT CREDIT @@schema("payment") }
enum NotificationStatus { QUEUED SENDING SENT DELIVERED RETRYING FAILED UNCONFIRMED @@schema("notify") }
enum NotificationChannel { PUSH EMAIL @@schema("notify") }
enum ProviderName { TICKETMASTER EVENTBRITE AMADEUS RAIL_AGG BUS_AGG BOOKING_COM UBER STRIPE @@schema("provider") }
enum SagaStep {
  AUTHORIZE_PAYMENT RESERVE_EVENT RESERVE_TRANSPORT RESERVE_STAY
  CAPTURE_PAYMENT CONFIRM_LEGS COMPENSATE DONE
  @@schema("trip")
}

// ============================ IDENTITY ============================
model User {
  id           String   @id @default(uuid()) @db.Uuid
  email        String   @unique
  phone        String?  @unique
  displayName  String
  status       String   @default("ACTIVE")            // ACTIVE|DEACTIVATED
  credential   Credential?
  sessions     Session[]
  mfaFactors   MfaFactor[]
  deviceTokens DeviceToken[]
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  @@index([status, createdAt])
  @@schema("identity")
}
model Credential {
  userId       String   @id @db.Uuid
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  passwordHash String                                   // argon2id
  updatedAt    DateTime @updatedAt
  @@schema("identity")
}
model Session {
  id           String   @id @default(uuid()) @db.Uuid
  userId       String   @db.Uuid
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  refreshHash  String                                   // hashed refresh token
  userAgent    String?
  ip           String?
  expiresAt    DateTime
  revokedAt    DateTime?
  createdAt    DateTime @default(now())
  @@index([userId, expiresAt])
  @@schema("identity")
}
model MfaFactor {
  id        String   @id @default(uuid()) @db.Uuid
  userId    String   @db.Uuid
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  type      String                                       // TOTP|SMS
  secretRef String                                       // ref to Secrets Manager / encrypted
  verified  Boolean  @default(false)
  createdAt DateTime @default(now())
  @@index([userId])
  @@schema("identity")
}
model DeviceToken {
  id        String   @id @default(uuid()) @db.Uuid
  userId    String   @db.Uuid
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  token     String   @unique                             // FCM token
  platform  String                                       // IOS|ANDROID|WEB
  lastSeenAt DateTime @default(now())
  @@index([userId])
  @@schema("identity")
}

// ============================ TRIP ORCHESTRATION ============================
model Trip {
  id               String     @id @default(uuid()) @db.Uuid
  userId           String     @db.Uuid                   // logical ref → identity.User
  status           TripStatus @default(DRAFT)
  currency         String     @db.Char(3)  @default("USD")
  // anchor
  anchorLegId      String?    @db.Uuid
  destinationGeo   Unsupported("geography(Point,4326)")?
  arriveBy         DateTime?
  departAfter      DateTime?
  startsAt         DateTime?
  endsAt           DateTime?
  // money totals (minor units)
  authorizedAmount BigInt     @default(0)
  capturedAmount   BigInt     @default(0)
  refundedAmount   BigInt     @default(0)
  paymentIntentId  String?    @db.Uuid                   // logical ref → payment.PaymentIntent
  version          Int        @default(0)                // optimistic lock
  legs             TripLeg[]
  saga             SagaState?
  createdAt        DateTime   @default(now())
  updatedAt        DateTime   @updatedAt
  @@index([userId, createdAt(sort: Desc)])
  @@index([status, updatedAt])                           // saga poller (partial in migration)
  @@schema("trip")
}
model TripLeg {
  id            String        @id @default(uuid()) @db.Uuid
  tripId        String        @db.Uuid
  trip          Trip          @relation(fields: [tripId], references: [id], onDelete: Cascade)
  type          LegType
  sequence      Int
  status        BookingStatus @default(PENDING)          // denormalized projection
  bookingId     String?       @db.Uuid                   // logical ref → owning booking aggregate
  providerRef   String?
  priceAmount   BigInt        @default(0)                // snapshot, minor units
  priceCurrency String        @db.Char(3) @default("USD")
  compRequired  Boolean       @default(false)
  refundId      String?       @db.Uuid
  cancelledAt   DateTime?
  createdAt     DateTime      @default(now())
  updatedAt     DateTime      @updatedAt
  @@unique([tripId, sequence])
  @@index([tripId])
  @@index([bookingId])
  @@schema("trip")
}
model SagaState {
  tripId       String   @id @db.Uuid
  trip         Trip     @relation(fields: [tripId], references: [id], onDelete: Cascade)
  step         SagaStep @default(AUTHORIZE_PAYMENT)
  compensating Boolean  @default(false)
  attempts     Int      @default(0)
  lastError    String?
  nextRunAt    DateTime?                                  // for timed retries
  updatedAt    DateTime @updatedAt
  @@index([step, nextRunAt])
  @@schema("trip")
}

// ============================ BOOKING (event/transport/stay share base fields) ============================
model EventBooking {
  id            String        @id @default(uuid()) @db.Uuid
  tripId        String        @db.Uuid
  tripLegId     String        @unique @db.Uuid           // INV-B3 dedupe
  userId        String        @db.Uuid
  provider      ProviderName
  externalEventId String
  status        BookingStatus @default(PENDING)
  providerRef   String?                                   // confirmation ref (INV-B1)
  holdExpiresAt DateTime?
  priceAmount   BigInt
  priceCurrency String        @db.Char(3)
  idempotencyKey String       @unique
  version       Int           @default(0)
  attributes    Json                                      // seats, tier, etc (normalized DTO)
  createdAt     DateTime      @default(now())
  updatedAt     DateTime      @updatedAt
  @@index([tripId])
  @@index([status, updatedAt])
  @@index([userId, createdAt(sort: Desc)])
  @@schema("booking")
}
model TransportBooking {
  id            String        @id @default(uuid()) @db.Uuid
  tripId        String        @db.Uuid
  tripLegId     String        @unique @db.Uuid
  userId        String        @db.Uuid
  provider      ProviderName
  mode          TransportMode
  status        BookingStatus @default(PENDING)
  providerRef   String?
  fareQuoteId   String?       @db.Uuid
  fareQuote     FareQuote?    @relation(fields: [fareQuoteId], references: [id])
  priceAmount   BigInt
  priceCurrency String        @db.Char(3)
  idempotencyKey String       @unique
  version       Int           @default(0)
  segments      Json                                      // legs/segments normalized
  createdAt     DateTime      @default(now())
  updatedAt     DateTime      @updatedAt
  @@index([tripId])
  @@index([status, updatedAt])
  @@schema("booking")
}
model FareQuote {
  id          String   @id @default(uuid()) @db.Uuid
  provider    ProviderName
  amount      BigInt
  currency    String   @db.Char(3)
  expiresAt   DateTime
  raw         Json
  bookings    TransportBooking[]
  createdAt   DateTime @default(now())
  @@index([expiresAt])
  @@schema("booking")
}
model StayBooking {
  id            String        @id @default(uuid()) @db.Uuid
  tripId        String        @db.Uuid
  tripLegId     String        @unique @db.Uuid
  userId        String        @db.Uuid
  provider      ProviderName
  externalPropertyId String
  status        BookingStatus @default(PENDING)
  providerRef   String?
  checkIn       DateTime
  checkOut      DateTime
  priceAmount   BigInt
  priceCurrency String        @db.Char(3)
  cancellationPolicy Json                                 // SNAPSHOT (INV-B5)
  idempotencyKey String       @unique
  version       Int           @default(0)
  createdAt     DateTime      @default(now())
  updatedAt     DateTime      @updatedAt
  @@index([tripId])
  @@index([status, updatedAt])
  @@schema("booking")
}

// ============================ PAYMENTS (double-entry) ============================
model PaymentIntent {
  id                    String        @id @default(uuid()) @db.Uuid
  tripId                String        @db.Uuid            // logical ref
  userId                String        @db.Uuid
  status                PaymentStatus @default(CREATED)
  amount                BigInt                            // authorized amount, minor units
  capturedAmount        BigInt        @default(0)
  refundedAmount        BigInt        @default(0)
  currency              String        @db.Char(3)
  stripePaymentIntentId String?       @unique
  idempotencyKey        String        @unique
  version               Int           @default(0)
  charges               Charge[]
  refunds               Refund[]
  disputes              Dispute[]
  createdAt             DateTime      @default(now())
  updatedAt             DateTime      @updatedAt
  @@index([tripId])
  @@index([status, updatedAt])
  @@index([userId, createdAt(sort: Desc)])
  @@schema("payment")
}
model Charge {
  id              String   @id @default(uuid()) @db.Uuid
  paymentIntentId String   @db.Uuid
  paymentIntent   PaymentIntent @relation(fields: [paymentIntentId], references: [id])
  stripeChargeId  String   @unique                        // INV-P4
  amount          BigInt
  currency        String   @db.Char(3)
  capturedAt      DateTime?
  createdAt       DateTime @default(now())
  @@index([paymentIntentId])
  @@schema("payment")
}
model Refund {
  id              String       @id @default(uuid()) @db.Uuid
  paymentIntentId String       @db.Uuid
  paymentIntent   PaymentIntent @relation(fields: [paymentIntentId], references: [id])
  tripLegId       String?      @db.Uuid                   // per-leg partial refund
  status          RefundStatus @default(REQUESTED)
  amount          BigInt
  currency        String       @db.Char(3)
  reason          String
  stripeRefundId  String?      @unique
  idempotencyKey  String       @unique
  version         Int          @default(0)
  createdAt       DateTime     @default(now())
  updatedAt       DateTime     @updatedAt
  @@index([paymentIntentId])
  @@index([status, updatedAt])
  @@schema("payment")
}
model Dispute {
  id              String   @id @default(uuid()) @db.Uuid
  paymentIntentId String   @db.Uuid
  paymentIntent   PaymentIntent @relation(fields: [paymentIntentId], references: [id])
  stripeDisputeId String   @unique
  amount          BigInt
  currency        String   @db.Char(3)
  status          String                                  // OPEN|WON|LOST
  dueBy           DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@index([status, dueBy])
  @@schema("payment")
}
// Double-entry ledger: every money movement = ≥2 balanced entries (Σdebit == Σcredit)
model LedgerAccount {
  id        String   @id @default(uuid()) @db.Uuid
  code      String   @unique                              // e.g. USER_CASH, STRIPE_CLEARING, REVENUE, REFUNDS_PAYABLE
  name      String
  entries   LedgerEntry[]
  @@schema("payment")
}
model LedgerEntry {
  id              String          @id @default(uuid()) @db.Uuid
  accountId       String          @db.Uuid
  account         LedgerAccount   @relation(fields: [accountId], references: [id])
  paymentIntentId String?         @db.Uuid
  refundId        String?         @db.Uuid
  direction       LedgerDirection
  amount          BigInt
  currency        String          @db.Char(3)
  transactionId   String          @db.Uuid                // groups entries of one movement; Σ within = 0
  memo            String?
  createdAt       DateTime        @default(now())
  @@index([accountId, createdAt])
  @@index([transactionId])
  @@index([paymentIntentId])
  @@schema("payment")
}

// ============================ NOTIFICATIONS ============================
model Notification {
  id           String              @id @default(uuid()) @db.Uuid
  userId       String              @db.Uuid
  channel      NotificationChannel
  templateId   String
  dedupeKey    String                                      // (userId,templateId,dedupeKey) unique → no double-send
  status       NotificationStatus  @default(QUEUED)
  payload      Json
  attempts     Int                 @default(0)
  nextAttemptAt DateTime?
  correlationId String?            @db.Uuid
  deliveries   DeliveryAttempt[]
  createdAt    DateTime            @default(now())
  updatedAt    DateTime            @updatedAt
  @@unique([userId, templateId, dedupeKey])
  @@index([status, nextAttemptAt])
  @@schema("notify")
}
model DeliveryAttempt {
  id             String   @id @default(uuid()) @db.Uuid
  notificationId String   @db.Uuid
  notification   Notification @relation(fields: [notificationId], references: [id], onDelete: Cascade)
  channel        NotificationChannel
  succeeded      Boolean
  providerResponse Json?
  createdAt      DateTime @default(now())
  @@index([notificationId])
  @@schema("notify")
}

// ============================ PROVIDER INTEGRATION (ACL audit + idempotency) ============================
model ProviderRequest {
  id             String       @id @default(uuid()) @db.Uuid
  provider       ProviderName
  operation      String                                    // RESERVE|CONFIRM|CANCEL|QUOTE|...
  idempotencyKey String
  bookingId      String?      @db.Uuid                     // logical ref
  requestHash    String
  responseStatus Int?
  responseBody   Json?
  succeeded      Boolean      @default(false)
  createdAt      DateTime     @default(now())
  @@unique([provider, idempotencyKey])                     // provider-call idempotency
  @@index([bookingId])
  @@schema("provider")
}
model CircuitState {
  provider     ProviderName @id
  state        String       @default("CLOSED")             // CLOSED|OPEN|HALF_OPEN
  failures     Int          @default(0)
  openedAt     DateTime?
  updatedAt    DateTime     @updatedAt
  @@schema("provider")
}

// ============================ PLATFORM (shared kernel) ============================
model OutboxEvent {
  id            String   @id @default(uuid()) @db.Uuid
  eventType     String
  eventVersion  Int      @default(1)
  aggregateType String
  aggregateId   String
  correlationId String?  @db.Uuid
  causationId   String?  @db.Uuid
  tripId        String?  @db.Uuid
  userId        String?  @db.Uuid
  payload       Json
  publishedAt   DateTime?
  attempts      Int      @default(0)
  createdAt     DateTime @default(now())
  @@index([publishedAt])                                   // partial WHERE publishedAt IS NULL (migration)
  @@index([aggregateType, aggregateId])
  @@schema("platform")
}
// Consumer-side dedupe for at-least-once delivery
model ProcessedEvent {
  eventId     String   @db.Uuid
  consumer    String
  processedAt DateTime @default(now())
  @@id([eventId, consumer])
  @@schema("platform")
}
// Generic idempotency for inbound API requests + outbound effects
model IdempotencyKey {
  scope      String                                        // e.g. "POST /trips", "stripe:create_intent"
  key        String
  requestHash String
  responseStatus Int?
  responseBody  Json?
  lockedAt   DateTime?
  completedAt DateTime?
  createdAt  DateTime @default(now())
  @@id([scope, key])
  @@schema("platform")
}
// Inbound webhook dedupe (Stripe + providers)
model WebhookReceipt {
  source          String                                   // "stripe" | "ticketmaster" | ...
  externalEventId String
  receivedAt      DateTime @default(now())
  processedAt     DateTime?
  @@id([source, externalEventId])
  @@schema("platform")
}
model AuditLog {
  id           String   @id @default(uuid()) @db.Uuid
  actorType    String                                      // USER|SYSTEM|OPS
  actorId      String?
  action       String
  resourceType String
  resourceId   String
  correlationId String? @db.Uuid
  metadata     Json?
  createdAt    DateTime @default(now())
  @@index([resourceType, resourceId])
  @@index([createdAt])
  @@schema("platform")
}
```

## 8.5 Raw-migration additions (beyond Prisma DSL)

Prisma can't express everything; these ship as `prisma migrate` SQL edits or follow-up migrations:
- **Partial indexes:** `CREATE INDEX ... ON trip.\"Trip\"(status, updatedAt) WHERE status IN ('BOOKING','COMPENSATING','PENDING_PAYMENT');` (and similar for outbox `WHERE publishedAt IS NULL`, refunds/notifications in-flight).
- **CHECK constraints (invariant backstops):** `CHECK (capturedAmount <= amount)`, `CHECK (refundedAmount <= capturedAmount)` on PaymentIntent; `CHECK (amount > 0)` on ledger/charges; `CHECK (checkOut > checkIn)` on StayBooking.
- **Ledger balance trigger (defense in depth):** a deferred constraint trigger asserting `SUM(debit) = SUM(credit)` per `transactionId` at commit.
- **GIN full-text index** for event search cache table; **PostGIS GIST** index on `destinationGeo`.
- **`updated_at` is Prisma-managed**, but we add DB `now()` defaults for safety.

## 8.6 Scaling & reporting readiness

- **Read replicas:** Discovery and reporting/analytics queries route to an RDS **read replica** (Prisma supports a separate read datasource / `@prisma/extension-read-replicas`). Booking/payment writes always hit primary.
- **Time-partitioning** (`pg_partman`) on append-heavy tables (`OutboxEvent`, `LedgerEntry`, `AuditLog`, `Notification`, `ProviderRequest`) keeps indexes small and enables cheap archival to S3 (via `aws_s3` export / nightly job).
- **Reporting:** the **double-entry ledger** is the financial source of truth for revenue/refund/dispute reporting — no need to recompute from bookings. A nightly job materializes daily summaries; later, CDC (Debezium) → data warehouse (Redshift/Snowflake) without touching OLTP.
- **Future DB-per-service:** because cross-context references are logical (no physical FK), a context's schema (`payment`, `trip`, …) can be promoted to its own database. The multiSchema layout makes the seam visible today.
- **Hot-row contention:** Trip/PaymentIntent use optimistic `version`; the saga retries on conflict rather than holding row locks across steps.

## 8.7 Decisions log (tradeoffs)

| Decision | Chosen | Alternative | Why |
|----------|--------|-------------|-----|
| Money type | `BigInt` minor units | `Decimal` | Avoids rounding/serialization ambiguity; integer math is exact |
| Cross-context refs | Logical (no FK) | Hard FKs everywhere | Enables DB-per-service later; integrity via saga + reconciliation |
| Money model | Double-entry ledger | Status columns on bookings | Auditable, reconcilable, supports partial refunds & disputes cleanly |
| Event publish | Outbox table | `queue.add()` after save | Atomicity: no lost/phantom events on crash |
| Idempotency | DB unique constraints | App-level checks | Race-safe under concurrency |
| Concurrency | Optimistic `version` | Pessimistic `SELECT FOR UPDATE` | Sagas span time; avoid long-held locks; retry on conflict |
| Schema org | Postgres multiSchema per context | one public schema | Makes context boundaries physical; eases extraction |
| State storage | enum + app-enforced SM (+ optional trigger) | booleans | Explicit, queryable, guarded transitions |
