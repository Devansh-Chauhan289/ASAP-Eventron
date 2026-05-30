# Section 4 — State Machines

State is **explicit and enforced in the domain layer**. Each aggregate exposes intent methods (e.g. `trip.beginBooking()`) that validate the current state against an allowed-transition table and raise a domain error on an illegal transition. The DB stores the state as an enum; transitions are written **in the same transaction** that emits the corresponding domain event (outbox), guaranteeing state and event never diverge.

Legend: `→` valid transition. Terminal states in **bold**. Every machine has an explicit failure/compensation path — no happy-path-only design.

---

## 4.1 Trip lifecycle (`TripStatus`)

```
DRAFT ──user adds anchor event──▶ PLANNING ──user confirms basket──▶ PENDING_PAYMENT
PENDING_PAYMENT ──payment authorized──▶ BOOKING
PENDING_PAYMENT ──auth failed / abandoned──▶ **PAYMENT_FAILED** (terminal-recoverable: user can retry → new PENDING_PAYMENT)
BOOKING ──all legs confirmed + payment captured──▶ CONFIRMED
BOOKING ──some legs ok, some unrecoverable──▶ PARTIALLY_BOOKED
BOOKING ──critical leg (anchor event) failed──▶ COMPENSATING
PARTIALLY_BOOKED ──user/ops accepts partial──▶ CONFIRMED (scoped to booked legs; others refunded)
PARTIALLY_BOOKED ──user/ops rejects──▶ COMPENSATING
COMPENSATING ──all compensations done──▶ **CANCELLED**
CONFIRMED ──trip end date passes──▶ **COMPLETED**
CONFIRMED ──user cancels──▶ CANCELLATION_REQUESTED ──refunds settled──▶ **CANCELLED**
ANY non-terminal ──unrecoverable system error──▶ NEEDS_ATTENTION (ops manual queue) → resumes or CANCELLED
```

| From | To | Guard / trigger |
|------|----|-----------------|
| DRAFT | PLANNING | anchor event selected |
| PLANNING | PENDING_PAYMENT | basket validated, fares/prices fresh, totals computed |
| PENDING_PAYMENT | BOOKING | PaymentIntent AUTHORIZED (INV-T3) |
| PENDING_PAYMENT | PAYMENT_FAILED | auth declined / 3DS abandoned / timeout |
| BOOKING | CONFIRMED | ∀ legs CONFIRMED ∧ payment CAPTURED (INV-T1) |
| BOOKING | PARTIALLY_BOOKED | ≥1 leg CONFIRMED ∧ ≥1 leg permanently FAILED ∧ anchor OK |
| BOOKING | COMPENSATING | anchor (event) leg permanently FAILED |
| PARTIALLY_BOOKED | CONFIRMED / COMPENSATING | explicit decision (auto-policy or ops/user) |
| COMPENSATING | CANCELLED | all refunds issued ∧ all reservations released |
| CONFIRMED | COMPLETED | now() > trip.endsAt |
| CONFIRMED | CANCELLATION_REQUESTED | user-initiated cancel |
| any | NEEDS_ATTENTION | retries exhausted / invariant breach detected |

**Design note:** `PARTIALLY_BOOKED` is a first-class state, not an error. The combined-trip value prop means we'd rather deliver the event + flight and refund the failed hotel than fail the whole trip — but only when the **anchor (event)** succeeded. Losing the anchor collapses the trip's reason to exist ⇒ full compensation.

---

## 4.2 Booking lifecycle (`BookingStatus`) — shared by Event/Transport/Stay

```
PENDING ──reserve() → provider hold ok──▶ RESERVED
PENDING ──provider reject / invalid──▶ **REJECTED**
PENDING/RESERVED ──provider timeout/5xx──▶ RETRYING ──(backoff, ≤N)──▶ RESERVED | FAILED
RESERVED ──confirm() (after payment capture)──▶ CONFIRMED
RESERVED ──hold expires (TTL)──▶ **EXPIRED**
RESERVED ──saga compensates──▶ RELEASING ──provider release ok──▶ **RELEASED**
CONFIRMED ──cancel()──▶ CANCELLING ──provider cancel ok──▶ **CANCELLED**
RETRYING ──retries exhausted──▶ **FAILED** (→ triggers saga compensation)
CONFIRMED ──end of service──▶ **FULFILLED**
```

| From | To | Guard / trigger |
|------|----|-----------------|
| PENDING | RESERVED | provider returns a hold/reservation ref |
| PENDING | REJECTED | provider business rejection (sold out, invalid) — terminal, no retry |
| any-transient-fail | RETRYING | timeout / 5xx / network — retryable per policy |
| RETRYING | FAILED | backoff attempts exhausted |
| RESERVED | CONFIRMED | payment captured ∧ provider confirm ok (INV-B1: providerRef set) |
| RESERVED | EXPIRED | hold TTL elapsed before capture |
| RESERVED/CONFIRMED | RELEASING/CANCELLING | saga compensation or user cancel |
| RELEASING | RELEASED | provider acknowledges release |
| CANCELLING | CANCELLED | provider acknowledges cancellation |

**Transport nuance:** between RESERVED and CONFIRMED a `FareQuote.expiresAt` guard applies (INV-B4). If expired at confirm time → `REQUOTE_REQUIRED` sub-state → re-quote; if price moved beyond tolerance → bubble `PriceChanged` to saga (see §7).

---

## 4.3 Payment lifecycle (`PaymentStatus`) — mirrors Stripe but is our own source of truth

```
CREATED ──Stripe PaymentIntent created──▶ REQUIRES_PAYMENT_METHOD
REQUIRES_PAYMENT_METHOD ──method attached──▶ REQUIRES_CONFIRMATION
REQUIRES_CONFIRMATION ──confirm, needs 3DS──▶ REQUIRES_ACTION
REQUIRES_ACTION ──3DS done──▶ PROCESSING
REQUIRES_CONFIRMATION/PROCESSING ──auth ok (manual capture)──▶ AUTHORIZED (requires_capture)
AUTHORIZED ──capture()──▶ CAPTURED
AUTHORIZED ──void() (compensation / expiry)──▶ **VOIDED**
any ──decline / error──▶ **FAILED**
CAPTURED ──refund (partial)──▶ PARTIALLY_REFUNDED
CAPTURED/PARTIALLY_REFUNDED ──refund (remaining)──▶ **REFUNDED**
CAPTURED ──cardholder disputes──▶ DISPUTED ──evidence won──▶ CAPTURED
DISPUTED ──evidence lost / accepted──▶ **CHARGEBACK** (funds reversed; ledger adjusted)
```

| From | To | Trigger | Notes |
|------|----|---------|-------|
| CREATED → REQUIRES_* | — | Stripe lifecycle | We use **manual capture**: authorize before booking, capture after legs confirm |
| REQUIRES_CONFIRMATION/PROCESSING | AUTHORIZED | `requires_capture` | This is the gate for Trip→BOOKING (INV-T3) |
| AUTHORIZED | CAPTURED | legs confirmed | Capture only what we will fulfill |
| AUTHORIZED | VOIDED | booking impossible | Release the hold — **no money taken** (best outcome on failure) |
| CAPTURED | PARTIALLY_REFUNDED/REFUNDED | compensation / cancel | Per-leg partial refunds supported |
| CAPTURED | DISPUTED → CHARGEBACK | Stripe dispute webhook | Ledger reversal + ops workflow |

**Why manual capture (authorize-then-capture):** it makes the *most common* failure outcome a **void** (zero money moved) instead of a charge-then-refund (fees + trust hit). We only capture money we are about to fulfill. *Tradeoff:* auth holds expire (~7 days, card-network dependent) and add a capture step; acceptable for booking timescales.

---

## 4.4 Notification lifecycle (`NotificationStatus`)

```
QUEUED ──worker picks up──▶ SENDING
SENDING ──provider accepts──▶ SENT ──delivery receipt──▶ **DELIVERED**
SENDING ──transient error──▶ RETRYING ──(backoff ≤N)──▶ SENT | FAILED
SENDING ──hard bounce / invalid token──▶ **FAILED** (no retry; prune token)
SENT ──no receipt within window──▶ **UNCONFIRMED** (best-effort; not retried to avoid dup spam)
```

| From | To | Trigger |
|------|----|---------|
| QUEUED | SENDING | BullMQ worker dequeues |
| SENDING | SENT | FCM/SendGrid 2xx accept |
| SENT | DELIVERED | delivery webhook/receipt |
| SENDING | RETRYING → FAILED | transient vs exhausted |
| SENDING | FAILED | invalid token / hard bounce (prune device token / suppress email) |

**Principle:** notifications are **at-least-once but de-duplicated** by a `(userId, templateId, dedupeKey)` idempotency check so a retried job never double-sends. They are **never** in the booking transaction — only triggered by events.

---

## 4.5 Refund lifecycle (`RefundStatus`)

```
REQUESTED ──policy computes amount > 0──▶ APPROVED
REQUESTED ──amount == 0 (non-refundable)──▶ **DENIED** (record penalty, notify)
APPROVED ──Stripe refund created──▶ PROCESSING
PROCESSING ──Stripe refund.succeeded──▶ **SUCCEEDED** (ledger credit posted)
PROCESSING ──Stripe refund.failed──▶ RETRYING ──(≤N)──▶ PROCESSING | **FAILED_NEEDS_ATTENTION**
APPROVED ──provider cancel still pending──▶ AWAITING_PROVIDER ──provider cancelled──▶ PROCESSING
```

| From | To | Guard |
|------|----|-------|
| REQUESTED | APPROVED | cancellation policy (snapshot, INV-B5) yields refundable amount > 0 |
| REQUESTED | DENIED | non-refundable per snapshot policy |
| APPROVED | AWAITING_PROVIDER | refund depends on provider releasing/cancelling first |
| APPROVED/AWAITING_PROVIDER | PROCESSING | Stripe refund issued (idempotent, INV-P2) |
| PROCESSING | SUCCEEDED | `charge.refunded` webhook ∧ ledger balanced (INV-P1/P3) |
| PROCESSING | FAILED_NEEDS_ATTENTION | Stripe failure after retries → ops queue |

**Ordering guarantee:** for compensations we **cancel the provider reservation first** (to stop fulfillment) then **refund**; if provider cancel is async, the Refund waits in `AWAITING_PROVIDER`. The saga (§6/§7) coordinates this ordering; the Refund SM enforces it locally.

---

## 4.6 Cross-machine coupling (how they interlock)

| When this happens | Trip SM | Booking SM | Payment SM | Refund SM | Notification |
|-------------------|---------|------------|------------|-----------|--------------|
| User confirms basket | →PENDING_PAYMENT | legs PENDING | CREATED→AUTHORIZED | — | "payment authorized" |
| Auth ok | →BOOKING | reserve→RESERVED | AUTHORIZED | — | — |
| All legs confirmed | →CONFIRMED | →CONFIRMED | →CAPTURED | — | "trip confirmed" |
| Anchor leg fails | →COMPENSATING | →RELEASED/FAILED | AUTHORIZED→VOIDED | (void, not refund) | "booking failed, not charged" |
| Non-anchor leg fails post-capture | →PARTIALLY_BOOKED | that leg FAILED | CAPTURED→PARTIALLY_REFUNDED | REQUESTED→…→SUCCEEDED | "partial refund issued" |
| User cancels confirmed trip | →CANCELLATION_REQUESTED→CANCELLED | →CANCELLED | →REFUNDED | per policy | "cancelled + refund" |

These interlocks are realized by the **process manager** in §6 and the **failure architecture** in §7. The key safety property: **a money state never advances past what inventory justifies, and inventory is always either confirmed-and-paid, released-and-not-charged, or confirmed-and-refunded — never charged-without-inventory.**
