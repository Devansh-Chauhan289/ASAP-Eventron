# Section 3 — Aggregate Root Design

An **aggregate** is a consistency boundary: everything inside it is updated in a **single ACID transaction** and obeys **invariants** that must always hold. Across aggregates we use **eventual consistency** (events + sagas). Aggregates reference each other **by ID only**, never by object reference — this is what keeps transactions small and contexts separable.

## 3.1 Aggregate inventory

| Aggregate Root | Context | Entities inside (same tx) | References (by ID) | Transaction boundary |
|----------------|---------|---------------------------|--------------------|----------------------|
| **Trip** | Trip Orchestration | TripLeg[], SagaState, OutboxEvent[] | userId, paymentIntentId | Create trip + legs + initial saga state + outbox in one tx |
| **EventBooking** | Event Booking | (BookingHold) | tripId, tripLegId, providerRef | Reserve/confirm/cancel state change + outbox in one tx |
| **TransportBooking** | Transport Booking | FareQuote | tripId, tripLegId, providerRef | One tx per state change + outbox |
| **StayBooking** | Stay Booking | (CancellationPolicy snapshot) | tripId, tripLegId, providerRef | One tx per state change + outbox |
| **PaymentIntent** | Payments | Charge[], LedgerEntry[] | tripId (as reference) | Intent + ledger entries in one tx |
| **Refund** | Payments | LedgerEntry[] | paymentIntentId, tripLegId | Refund record + ledger in one tx |
| **Notification** | Notifications | DeliveryAttempt[] | userId, correlationId | One tx per attempt update |
| **ProviderRequest** | Provider Integration | — (idempotency/audit record) | bookingId, idempotencyKey | One tx; unique on idempotency key |
| **User** | Identity | Credential, Session[], MfaFactor[] | — | Standard |

> Rule of thumb applied: **keep aggregates small.** A Trip does **not** contain the full EventBooking/PaymentIntent objects — only `TripLeg` rows that hold the *reference* + *denormalized status* of each leg. This keeps the Trip transaction tiny and lets legs settle independently.

## 3.2 The Trip aggregate (the heart of the system)

```
Trip (root)
 ├─ id, userId, status (TripStatus SM), currency
 ├─ anchor: { eventLegId, destinationGeo, arriveBy, departAfter }   // the orchestration anchor
 ├─ sagaState: { step, attempts, compensating: bool, lastError }
 ├─ totals: { authorizedAmount, capturedAmount, refundedAmount }    // money in minor units
 ├─ paymentIntentId (ref → Payments)
 └─ legs: TripLeg[]
        ├─ id, type (EVENT|TRANSPORT|STAY), sequence
        ├─ status (BookingStatus SM, denormalized from the owning booking)
        ├─ bookingId (ref → EventBooking|TransportBooking|StayBooking)
        ├─ providerRef, priceSnapshot (amount, currency, capturedAt fare/price)
        └─ compensation: { required: bool, refundId?, cancelledAt? }
```

**Why TripLeg holds a denormalized `status` + `priceSnapshot`:** the saga must reason about "is the whole trip bookable / what do I compensate" without cross-context joins. The leg's status is updated when the owning booking context emits an event (`EventBooked`, `TransportBookingFailed`, …). The booking aggregate remains the **source of truth**; the leg is a **projection for orchestration**. *Tradeoff:* mild duplication + an eventual-consistency window (ms–seconds); *benefit:* the saga is a clean state machine over its own data and never reaches across contexts.

## 3.3 Domain invariants (must ALWAYS hold — enforced in domain layer + DB constraints)

### Trip
- **INV-T1:** A Trip in `CONFIRMED` has **every** required leg in `CONFIRMED`. (Partial confirmation ⇒ Trip stays `PARTIALLY_BOOKED`.)
- **INV-T2:** `capturedAmount ≤ authorizedAmount` and `refundedAmount ≤ capturedAmount` at all times.
- **INV-T3:** A Trip cannot transition to `BOOKING` without a successful payment **authorization** (PaymentIntent in `AUTHORIZED`/`REQUIRES_CAPTURE`).
- **INV-T4:** Every leg has exactly one owning booking aggregate (`bookingId` unique per leg).
- **INV-T5:** If any leg is `FAILED` and cannot be retried, the saga MUST enter compensation; the Trip cannot silently stay partial forever (a terminal `PARTIALLY_BOOKED` requires an explicit ops/user decision recorded).

### EventBooking / TransportBooking / StayBooking
- **INV-B1:** A booking is `CONFIRMED` only if a provider confirmation reference exists (`providerRef NOT NULL`).
- **INV-B2:** State transitions follow the Booking state machine (§4); illegal transitions are rejected by the domain method, not the DB alone.
- **INV-B3 (idempotency):** At most one *active* booking per `(tripLegId)` — re-submitting the same intent returns the existing booking, never a second provider reservation. Enforced by unique constraint + idempotency key.
- **INV-B4 (Transport):** A `FareQuote` has `expiresAt`; ticketing against an expired quote is rejected → re-quote required.
- **INV-B5 (Stay):** The `CancellationPolicy` in effect is **snapshotted** at booking time (provider policies change); refunds compute against the snapshot.

### PaymentIntent / Refund (financial invariants — strongest)
- **INV-P1 (double-entry):** For every money movement, sum of ledger debits == sum of credits. The ledger always balances.
- **INV-P2 (idempotency):** A given idempotency key maps to **exactly one** PaymentIntent/Charge/Refund. Replays return the same record. Enforced by unique constraint on `idempotency_key`.
- **INV-P3:** `Σ refunds(paymentIntent) ≤ captured(paymentIntent)`. Never refund more than captured.
- **INV-P4:** A `Charge` references a Stripe PaymentIntent id; the Stripe id is unique (no two local charges for one Stripe charge).
- **INV-P5:** Money is stored as **integer minor units + ISO currency code**. No floats, ever.

## 3.4 Lifecycle ownership

| Concern | Owner | Notes |
|---------|-------|-------|
| Creating/sequencing a Trip | Trip Orchestration (saga) | Only the saga creates legs & drives transitions |
| Reserving inventory | The owning booking context | Trip *requests* via port; booking context decides & calls provider via ACL |
| Moving money | Payments only | No other context touches Stripe or the ledger |
| Compensation (refund/cancel) | Trip saga **orchestrates**, Payments/Booking **execute** | Saga emits compensation commands; each context performs its own local tx |
| Notifying users | Notifications | Subscribes to events; never inline in booking tx |

## 3.5 Consistency model summary

- **Inside an aggregate:** strong consistency, single Prisma `$transaction`.
- **Across aggregates/contexts:** eventual consistency via Outbox → BullMQ → event handlers, with **sagas** providing the workflow and **compensating transactions** providing the rollback semantics that distributed transactions cannot.
- **Money vs inventory (the unavoidable gap):** authorize money first (reversible hold) → reserve inventory → capture money → on failure compensate (release/cancel + void/refund). Detailed in §6–§7.
