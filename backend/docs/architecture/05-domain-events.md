# Section 5 — Domain Events

Domain events are the **microservice-ready nervous system**. They are written to the **Outbox** table inside the same DB transaction as the state change (atomicity), then a relay publishes them to **BullMQ** (at-least-once delivery), where context subscribers react. Consumers are **idempotent** (dedupe on `eventId`). This is choreography for loose coupling, with the **process manager** (§6) providing orchestration where ordering matters.

## 5.1 Event envelope (Published Language — stable contract)

Every event shares this envelope. The `payload` is versioned per event type.

```jsonc
{
  "eventId": "uuid",              // unique; consumers dedupe on this
  "eventType": "payment.succeeded",
  "eventVersion": 1,              // schema version of payload
  "occurredAt": "2026-05-31T10:00:00Z",
  "aggregateType": "PaymentIntent",
  "aggregateId": "pi_abc",
  "correlationId": "uuid",        // ties all events of one user journey together
  "causationId": "uuid",          // the eventId/commandId that caused this
  "tripId": "uuid|null",          // business join key threaded everywhere
  "userId": "uuid",
  "payload": { /* event-specific, see catalog */ }
}
```

**Why `correlationId` + `causationId` + `tripId` in every envelope:** end-to-end tracing and saga reconstruction. Given any event we can replay the entire causal chain of a journey (audit, debugging, reconciliation). These also flow into logs/traces (§14).

## 5.2 Naming & versioning conventions

- `context.aggregate.pastTenseFact` — events are **facts that already happened**, never commands. e.g. `booking.event.confirmed`.
- Payloads are **additive-only** within a major `eventVersion`; breaking changes bump the version and run dual-publish during migration.
- Events carry **IDs and denormalized essentials**, not whole aggregates — consumers fetch detail via the owning context's API if needed (keeps payloads small and contexts decoupled).

## 5.3 Event catalog

### Trip Orchestration
| Event | Emitted when | Key payload | Primary consumers |
|-------|--------------|-------------|-------------------|
| `trip.created` | Trip created from anchor event | tripId, userId, anchor{geo,arriveBy} | Discovery (seed recos), Analytics |
| `trip.basket.confirmed` | User confirms legs → totals locked | legs[], totalAmount, currency | Payments (create intent), Pricing |
| `trip.booking.started` | Payment authorized, saga begins | tripId, legs[] | Event/Transport/Stay Booking |
| `trip.confirmed` | All legs confirmed + captured | tripId, legs[], totalCaptured | Notifications, Analytics, Itinerary |
| `trip.partially_booked` | Some legs failed post-capture | confirmedLegs[], failedLegs[] | Notifications, Refund flow |
| `trip.compensation.started` | Saga enters COMPENSATING | tripId, legsToCompensate[] | Booking ctxs, Payments |
| `trip.cancelled` | All compensation done | tripId, refundTotal | Notifications, Analytics |
| `trip.completed` | Trip end date passed | tripId | Analytics, Reviews prompt |
| `trip.needs_attention` | Unrecoverable; ops queue | tripId, reason, lastError | Ops alerting (PagerDuty) |

### Event / Transport / Stay Booking (each context emits its variant)
| Event | Emitted when | Key payload |
|-------|--------------|-------------|
| `booking.{event\|transport\|stay}.reservation_requested` | Saga asked context to reserve | bookingId, tripLegId, providerId, idempotencyKey |
| `booking.{…}.reserved` | Provider hold acquired | bookingId, providerRef, holdExpiresAt, priceSnapshot |
| `booking.{…}.confirmed` | Confirmed after capture | bookingId, providerRef |
| `booking.{…}.failed` | Retries exhausted / rejected | bookingId, reason, retryable:false |
| `booking.{…}.released` | Hold released (compensation/expiry) | bookingId |
| `booking.{…}.cancelled` | Confirmed booking cancelled | bookingId, providerCancelRef |
| `booking.transport.price_changed` | Fare moved beyond tolerance at confirm | bookingId, oldPrice, newPrice |
| `booking.transport.quote_expired` | FareQuote TTL elapsed | bookingId |

### Payments
| Event | Emitted when | Key payload |
|-------|--------------|-------------|
| `payment.intent.created` | PaymentIntent created in Stripe | paymentIntentId, stripeId, amount, clientSecret-ref |
| `payment.authorized` | `requires_capture` reached | paymentIntentId, authorizedAmount |
| `payment.captured` | Funds captured | paymentIntentId, capturedAmount |
| `payment.voided` | Auth released, no charge | paymentIntentId |
| `payment.failed` | Decline / error | paymentIntentId, declineCode |
| `payment.refund.requested` | Refund initiated | refundId, paymentIntentId, amount, reason |
| `payment.refund.succeeded` | Stripe refund settled | refundId, amount |
| `payment.refund.failed` | Refund failed after retries | refundId, reason |
| `payment.disputed` | Stripe dispute opened | paymentIntentId, disputeId, amount |
| `payment.chargeback.finalized` | Dispute lost/accepted | paymentIntentId, amount |

### Notifications
| Event | Emitted when | Key payload |
|-------|--------------|-------------|
| `notification.dispatch.requested` | Any context wants to notify | userId, channel, templateId, dedupeKey, data |
| `notification.delivered` | Receipt confirmed | notificationId, channel |
| `notification.failed` | Hard failure | notificationId, reason |

### Identity (selected)
| Event | Emitted when | Key payload |
|-------|--------------|-------------|
| `identity.user.registered` | New user | userId, email |
| `identity.user.deactivated` | Account closed | userId |
| `identity.device.registered` | FCM token added | userId, deviceToken |

## 5.4 Choreography vs orchestration (when we use which)

- **Orchestration (process manager):** the **booking saga** — order matters, compensation must be coordinated, a single component owns "where are we." Used for the Trip lifecycle (§6). Reasoning: choreographed sagas across this many steps become impossible to reason about and debug; a central process manager gives one place to see and recover state.
- **Choreography (pub/sub):** **fan-out side effects** — notifications, analytics, recommendation refresh, itinerary projection. Reasoning: these are independent reactions; coupling them into the saga would bloat it and reduce resilience.

## 5.5 Delivery semantics & idempotency

- **At-least-once delivery** (Outbox → BullMQ). Consumers MUST be idempotent: each consumer keeps a `processed_events(eventId, consumerName)` unique record; re-delivery is a no-op.
- **Ordering:** not globally guaranteed. Where per-aggregate order matters (e.g. payment events for one intent), we use a **BullMQ FIFO group / partition key = aggregateId** and design handlers to tolerate out-of-order via state-machine guards (an event that doesn't apply to the current state is parked/ignored, never crashes).
- **Poison events** go to a DLQ after max attempts and raise `*.needs_attention`.

## 5.6 The Outbox relay (atomic publish)

```
[ business tx ] : write aggregate change + INSERT INTO outbox_events(...)   ── single Postgres tx ──▶ COMMIT
        │
[ relay (BullMQ repeatable job / LISTEN-NOTIFY) ] : SELECT unpublished → enqueue to BullMQ → mark published
        │
[ subscribers ] : idempotent handlers react, may emit further events (same pattern)
```

This guarantees **"state changed ⇔ event will be delivered"** with no lost or phantom events, which a naive "save then `queue.add()`" cannot (a crash between the two loses or duplicates the event non-atomically). See §11 for the BullMQ realization and §8 for the `outbox_events` table.
