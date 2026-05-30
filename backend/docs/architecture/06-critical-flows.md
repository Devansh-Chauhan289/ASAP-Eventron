# Section 06 — Critical User Flows

This section specifies the end-to-end runtime behavior of ASAP's six critical flows as **text sequence diagrams**. Each diagram is normative: it pins down (a) where Prisma `$transaction` boundaries sit, (b) where external network calls happen (always in BullMQ workers, never inside a DB tx — Foundational Rule 2), (c) how idempotency keys flow, (d) how the `platform.OutboxEvent` table bridges "DB write + event publish" atomically (Rule 4), and (e) the exact `TripStatus` / `BookingStatus` / `PaymentStatus` transitions and `context.aggregate.pastTense` domain events emitted.

## 6.0 Conventions used in all diagrams

| Actor | Module / Responsibility |
|---|---|
| **Client** | Browser/mobile SPA. Holds Stripe Elements, sends `Idempotency-Key` header, polls `GET /trips/{id}` or subscribes SSE `/trips/{id}/events`, receives FCM push. |
| **API/Controller** | NestJS controller (Identity-authenticated). NEVER touches Prisma directly (Rule 7). Delegates to application services. |
| **Trip Saga** | Trip Orchestration core. The **process manager**. Owns `trip.Trip`, `trip.TripLeg`, `trip.SagaState`, sequencing + compensation. Each saga step = one local `$transaction` then enqueues next. |
| **Booking ctx** | Event/Transport/Stay Booking. Owns `booking.*` tables, `BookingStatus` machine. |
| **Payments** | Payments core. Owns `payment.PaymentIntent`, `Charge`, `Refund`, ledger. `PaymentStatus` machine + double-entry. |
| **Provider ACL** | Provider Integration anti-corruption layer. Owns `provider.ProviderRequest` (unique `[provider, idempotencyKey]`), `provider.CircuitState`. The ONLY actor that talks to providers/Uber/Amadeus etc. |
| **Stripe** | External PSP, manual capture. |
| **BullMQ** | Redis-backed worker queues. Transport for saga steps + outbox relay. |
| **Outbox** | `platform.OutboxEvent`. Written inside the same tx as the state change; a relay worker publishes to BullMQ. |
| **Notifications** | FCM + SendGrid, dedupe via `notify.Notification` unique `[userId, templateId, dedupeKey]`. |

**Two invariants repeated in every flow:**

```
┌─ TX BOUNDARY (one Prisma $transaction, NO network I/O inside) ─┐
│  write/advance aggregate  +  bump version (optimistic lock)    │
│  + INSERT platform.OutboxEvent (same tx → atomic publish)      │
└────────────────────────────────────────────────────────────────┘
            │ (after commit)
            ▼
   OutboxRelay worker → BullMQ → consumer worker → EXTERNAL CALL → next TX
```

External calls (Stripe, Provider ACL → provider, FCM/SendGrid) ALWAYS execute in a **worker, between transactions**, guarded by a persisted idempotency key. The result is then folded back into the aggregate in the *next* `$transaction`.

**Idempotency key lineage** (all UUIDs, persisted before use):

```
Client Idempotency-Key (header, per POST)
   └─ trip.Trip.id (correlationId for the whole saga)
        ├─ payment.PaymentIntent idemKey  → Stripe Idempotency-Key
        ├─ provider.ProviderRequest.idempotencyKey  (unique [provider, idemKey])
        └─ notify.Notification.dedupeKey
```

---

## 6.1 Flow 1 — Single Event Booking

Anchor-only trip: one `EventBooking`. Demonstrates the full authorize → reserve → capture → confirm spine in miniature.

```
Client        API/Controller     Trip Saga                Payments        ProviderACL   Stripe   BullMQ  Outbox  Notif
  │  POST /trips/{id}/checkout (Idempotency-Key: K1)
  │──────────────▶│
  │               │  platform.IdempotencyKey lookup(K1) ── hit? replay stored 202
  │               │─────────────▶│ ── TX1 ────────────────────────────────────────────┐
  │               │              │  Trip: PLANNING → PENDING_PAYMENT (version++)         │
  │               │              │  SagaState.step = AUTHORIZE_PAYMENT                   │
  │               │              │  Outbox += trip.basket.confirmed                      │
  │               │              └───── COMMIT ─────────────────────────────────────────┘
  │  ◀── 202 Accepted {tripId, status:PENDING_PAYMENT, poll:/trips/K1} ──│
  │                                  (Outbox relay) ─────────────▶ BullMQ: saga.authorize_payment
  ·  (client polls GET /trips/{id} OR opens SSE /trips/{id}/events) ·
  │
  │   ┌── WORKER: saga.authorize_payment ──────────────────────────────────┐
  │   │  TX2: Payments create PaymentIntent CREATED→REQUIRES_CONFIRMATION   │
  │   │        idemKey=PI1 persisted; Outbox += payment.intent.created      │
  │   │  ── COMMIT ──                                                       │
  │   │  EXTERNAL (no tx): Stripe.paymentIntents.create+confirm             │
  │   │        manual_capture, Stripe-Idempotency-Key: PI1 ───────▶ Stripe  │
  │   │  TX3: on requires_capture → PaymentStatus AUTHORIZED (version++)    │
  │   │        Trip PENDING_PAYMENT → BOOKING (INV: needs PI AUTHORIZED)    │
  │   │        SagaState.step = RESERVE_EVENT                               │
  │   │        Outbox += payment.authorized, trip.booking.started          │
  │   └──────────────────────────────────────────────── relay ▶ saga.reserve_event
  │
  │   ┌── WORKER: saga.reserve_event ─────────────────────────────────────┐
  │   │  TX4: EventBooking PENDING → RESERVED; idemKey=PR1 reserved        │
  │   │        (unique active booking per tripLegId)                       │
  │   │  ── COMMIT ──                                                      │
  │   │  EXTERNAL: ProviderACL.reserve(Ticketmaster, idemKey=PR1)          │
  │   │        provider.ProviderRequest unique[provider,PR1]; circuit chk  │
  │   │        ───────────────────────────▶ Provider                       │
  │   │  TX5: providerRef set → EventBooking RESERVED→CONFIRMED            │
  │   │        TripLeg.status projection updated                           │
  │   │        SagaState.step = CAPTURE_PAYMENT                            │
  │   │        Outbox += booking.event.reserved (+ ...confirmed)          │
  │   └──────────────────────────────────────────── relay ▶ saga.capture_payment
  │
  │   ┌── WORKER: saga.capture_payment ───────────────────────────────────┐
  │   │  EXTERNAL: Stripe.capture(PI1, Idempotency-Key: PI1-cap)           │
  │   │  TX6: PaymentStatus AUTHORIZED → CAPTURED; LedgerEntry debits==cr  │
  │   │        capturedAmount<=authorizedAmount; Trip BOOKING → CONFIRMED  │
  │   │        (INV: all required legs CONFIRMED)                          │
  │   │        SagaState.step = DONE; Outbox += payment.captured,          │
  │   │        trip.confirmed, notification.dispatch.requested             │
  │   └──────────────────────────────────────── relay ▶ notify.dispatch
  │                                                              │
  │   WORKER notify.dispatch: notify.Notification dedupeKey;     │
  │      EXTERNAL FCM/SendGrid; QUEUED→SENDING→SENT/DELIVERED ───┘──▶ push
  │  ◀═══ FCM push "Trip confirmed" / SSE event trip.confirmed ════════════
  │  GET /trips/{id} ──▶ 200 {status: CONFIRMED}
```

**Why capture AFTER reserve:** manual capture means the most common failure (provider sold out) ends in **VOID — zero money moved** (no refund machinery needed). Capturing first would force a refund on every provider failure; that is strictly worse for reconciliation and customer trust.

---

## 6.2 Flow 2 — Transport Booking (with FareQuote expiry)

Adds the `booking.FareQuote.expiresAt` guard and `booking.transport.price_changed` / `quote_expired` events. Fares are volatile (Amadeus/rail aggregators re-price), so a quote is a time-boxed promise.

```
Client       API/Controller   Trip Saga        Booking(Transport)   ProviderACL   Payments   Stripe
  │ POST /trips/{id}/quote (Idempotency-Key: Q1)
  │────────────▶│──────────────▶│
  │             │  WORKER quote: ProviderACL.priceSearch(Amadeus) [EXTERNAL]
  │             │  TX: FareQuote{amount,currency,expiresAt=now+Xm} persisted
  │             │       Outbox += (quote ready)                     
  │ ◀─ 200 {fareQuoteId, amount, expiresAt} ─┤
  │
  │ POST /trips/{id}/checkout (Idempotency-Key: K2, fareQuoteId)
  │────────────▶│──────────────▶│── TX ── GUARD: FareQuote.expiresAt > now ?
  │             │               │   ├─ EXPIRED → Trip stays PLANNING;
  │             │               │   │    Outbox += booking.transport.quote_expired
  │             │               │   │    402 {error.code: QUOTE_EXPIRED, retryable:true}
  │             │               │   └─ valid → PLANNING→PENDING_PAYMENT; step=AUTHORIZE_PAYMENT
  │ ◀── 202 {status: PENDING_PAYMENT} ──┤  (or 402 re-quote)
  │
  │  [saga.authorize_payment — identical to 6.1: PI AUTHORIZED, Trip→BOOKING]
  │
  │  ┌── WORKER saga.reserve_transport ──────────────────────────────────┐
  │  │  TX: re-check FareQuote.expiresAt INSIDE tx (last-mile guard)       │
  │  │      TransportBooking PENDING → RESERVED; idemKey=PR2               │
  │  │  EXTERNAL: ProviderACL.reserve(transport, PR2)                      │
  │  │     ┌─ provider returns NEW price ≠ snapshot:                       │
  │  │     │    Outbox += booking.transport.price_changed                  │
  │  │     │    BookingStatus RESERVED→FAILED (policy: do NOT auto-accept) │
  │  │     │    → triggers COMPENSATE (VOID auth, Trip→CANCELLED)          │
  │  │     └─ price held: TX providerRef → CONFIRMED; step=CAPTURE_PAYMENT │
  │  └────────────────────────────────────────────────────────────────────┘
  │  [saga.capture_payment → CAPTURED, Trip CONFIRMED, notify] (as 6.1)
```

**Design note:** the `expiresAt` guard is checked **twice** — once at controller admission (fail fast, cheap) and once **inside the `reserve_transport` tx** (authoritative, race-safe). A price change discovered at reservation time is NOT silently accepted; we emit `booking.transport.price_changed` and compensate, because charging a different amount than the user authorized violates payment-correctness = 100%.

---

## 6.3 Flow 3 — Stay Booking

Adds the **snapshotted cancellation policy** invariant (`stay cancellation policy snapshotted`). The policy at booking time is frozen onto `booking.StayBooking` so later refunds compute against the terms the user agreed to, even if Booking.com changes them.

```
Client     API/Controller   Trip Saga        Booking(Stay)        ProviderACL(Booking.com)  Payments
  │ POST /trips/{id}/checkout (Idempotency-Key: K3)
  │──────────▶│─────────────▶│ TX: PLANNING→PENDING_PAYMENT; step=AUTHORIZE_PAYMENT; Outbox
  │ ◀── 202 {PENDING_PAYMENT} ──┤
  │ [saga.authorize_payment → PI AUTHORIZED → Trip BOOKING] (as 6.1)
  │
  │ ┌── WORKER saga.reserve_stay ─────────────────────────────────────────┐
  │ │  TX: StayBooking PENDING→RESERVED; idemKey=PR3                        │
  │ │  EXTERNAL: ProviderACL.reserve(Booking.com, PR3)                      │
  │ │  TX: on success → providerRef set; RESERVED→CONFIRMED                 │
  │ │      cancellationPolicy SNAPSHOT persisted (freeDeadline, penaltyBps) │
  │ │      step=CAPTURE_PAYMENT; Outbox += booking.event.reserved/confirmed │
  │ └──────────────────────────────────────────────────────────────────────┘
  │ [saga.capture_payment → CAPTURED → Trip CONFIRMED → notify] (as 6.1)
```

**Why snapshot:** refund computation (Flow 6) is deterministic and auditable only if the cancellation terms are immutable from the moment of confirmation. A logical (non-FK, Rule 8) reference to the provider's live policy would make refunds non-reproducible and unreconcilable.

---

## 6.4 Flow 4 — COMBINED TRIP (Event + Transport + Stay) — the core saga

This is the headline flow. Order: **AUTHORIZE_PAYMENT → RESERVE_EVENT(anchor) → RESERVE_TRANSPORT → RESERVE_STAY → CAPTURE_PAYMENT → CONFIRM_LEGS → DONE**. Event is the **anchor**; transport/stay are secondary. Each saga step is one `$transaction` + outbox; each provider/Stripe call is in a worker between transactions.

```
Client    API/Ctrl   Trip Saga(PM)        Booking      ProviderACL   Payments   Stripe   Outbox→BullMQ   Notif
  │ POST /trips/{id}/confirm  (Idempotency-Key: K4)
  │─────────▶│
  │          │ IdempotencyKey(K4): replay-safe
  │          │─────────▶│ TX0: Trip PLANNING→PENDING_PAYMENT (v++)
  │          │          │      SagaState.step=AUTHORIZE_PAYMENT, correlationId=tripId
  │          │          │      Outbox += trip.basket.confirmed, trip.booking.started
  │ ◀═ 202 Accepted {tripId, status:PENDING_PAYMENT} ═╡
  │   (client → SSE /trips/{id}/events  AND/OR  poll GET /trips/{id}  AND/OR  FCM)
  │                                       relay ▶ saga.authorize_payment
  │
  │ ╔═ STEP AUTHORIZE_PAYMENT (worker) ════════════════════════════════════════════╗
  │ ║ TX: PaymentIntent CREATED→REQUIRES_CONFIRMATION; idemKey=PI; Outbox=intent.created
  │ ║ EXTERNAL: Stripe.create+confirm(manual_capture, Idem:PI) ──────────▶ Stripe   ║
  │ ║ TX: requires_capture → PaymentStatus AUTHORIZED; Trip PENDING_PAYMENT→BOOKING  ║
  │ ║     step=RESERVE_EVENT; Outbox += payment.authorized                           ║
  │ ╚════════════════════════════════════════════════════════ relay ▶ saga.reserve_event
  │
  │ ╔═ STEP RESERVE_EVENT  (anchor) ═══════════════════════════════════════════════╗
  │ ║ TX: EventBooking PENDING→RESERVED; idem=PR-E (unique active per tripLegId)     ║
  │ ║ EXTERNAL: ProviderACL.reserve(Ticketmaster,PR-E)  ── circuit/retry ──▶ Provider
  │ ║   anchor FAILS → BookingStatus REJECTED/FAILED → step=COMPENSATE              ║
  │ ║          (losing anchor ⇒ FULL compensation ⇒ VOID auth ⇒ Trip CANCELLED)     ║
  │ ║   anchor OK: TX providerRef→CONFIRMED; TripLeg projection; step=RESERVE_TRANSPORT
  │ ║          Outbox += booking.event.reserved, booking.event.confirmed            ║
  │ ╚════════════════════════════════════════════════════════ relay ▶ saga.reserve_transport
  │
  │ ╔═ STEP RESERVE_TRANSPORT (secondary) ═════════════════════════════════════════╗
  │ ║ TX: FareQuote.expiresAt guard; TransportBooking PENDING→RESERVED; idem=PR-T   ║
  │ ║ EXTERNAL: ProviderACL.reserve(transport,PR-T) ──────────────────────▶ Provider
  │ ║   FAILS or price_changed → secondary failure → step=COMPENSATE (PARTIAL path) ║
  │ ║   OK: providerRef→CONFIRMED; step=RESERVE_STAY; Outbox += booking.* events     ║
  │ ╚════════════════════════════════════════════════════════ relay ▶ saga.reserve_stay
  │
  │ ╔═ STEP RESERVE_STAY (secondary) ══════════════════════════════════════════════╗
  │ ║ TX: StayBooking PENDING→RESERVED; idem=PR-S                                    ║
  │ ║ EXTERNAL: ProviderACL.reserve(Booking.com,PR-S) ────────────────────▶ Provider
  │ ║   OK: providerRef→CONFIRMED; policy snapshot; step=CAPTURE_PAYMENT             ║
  │ ║   FAILS: secondary failure → step=COMPENSATE (PARTIAL path)                    ║
  │ ╚════════════════════════════════════════════════════════ relay ▶ saga.capture_payment
  │
  │ ╔═ STEP CAPTURE_PAYMENT ═══════════════════════════════════════════════════════╗
  │ ║ amount = Σ confirmed legs (≤ authorizedAmount)                                 ║
  │ ║ EXTERNAL: Stripe.capture(PI, Idem:PI-cap) ──────────────────────────▶ Stripe  ║
  │ ║ TX: PaymentStatus AUTHORIZED→CAPTURED; LedgerEntry (Σdebits==Σcredits)         ║
  │ ║     capturedAmount<=authorizedAmount; step=CONFIRM_LEGS; Outbox=payment.captured
  │ ╚════════════════════════════════════════════════════════ relay ▶ saga.confirm_legs
  │
  │ ╔═ STEP CONFIRM_LEGS ══════════════════════════════════════════════════════════╗
  │ ║ TX: assert all required legs CONFIRMED; Trip BOOKING→CONFIRMED (v++)           ║
  │ ║     step=DONE; Outbox += trip.confirmed, notification.dispatch.requested       ║
  │ ╚════════════════════════════════════════════════════════ relay ▶ notify.dispatch
  │                                                                           │
  │  WORKER notify: dedupeKey; EXTERNAL FCM+SendGrid; QUEUED→SENDING→SENT ────┘
  │ ◀═══ FCM push + SSE trip.confirmed ═══════════════════════════════════════════
  │ GET /trips/{id} → 200 {status: CONFIRMED, legs:[CONFIRMED×3]}
```

### 6.4a Secondary-leg failure → PARTIALLY_BOOKED vs full compensation

`PARTIALLY_BOOKED` is **first-class**: the anchor (event) succeeded but a secondary leg (transport/stay) failed. The saga does NOT throw the whole trip away — it cancels + refunds only the failed leg and the over-authorized amount.

```
... anchor EVENT CONFIRMED, then RESERVE_STAY FAILS ...
  Trip Saga: step=COMPENSATE; Trip BOOKING→COMPENSATING; Outbox += trip.compensation.started
  ╔═ STEP COMPENSATE (worker) ════════════════════════════════════════════════════╗
  ║ For each CONFIRMED secondary that must be undone — NONE here (stay never        ║
  ║ confirmed); transport already CONFIRMED stays. Failed stay: BookingStatus       ║
  ║ ...→RELEASING→RELEASED (or never reserved → no provider undo needed).           ║
  ║ Refund order (Rule): cancel provider reservation FIRST, then refund.            ║
  ║ Payments: partial capture of (event+transport) only; OR capture-then-refund the ║
  ║   stay portion → PaymentStatus → PARTIALLY_REFUNDED; Refund machine (Flow 6).   ║
  ║ TX: Trip COMPENSATING → PARTIALLY_BOOKED;                                        ║
  ║     Outbox += trip.partially_booked, notification.dispatch.requested            ║
  ╚══════════════════════════════════════════════════════════════════════════════╝
  ◀ SSE/FCM: "Event + transport booked; hotel unavailable, refunded."

... vs ANCHOR (event) FAILS ...
  step=COMPENSATE; Trip BOOKING→COMPENSATING; cancel any reserved secondaries
  (RELEASING→RELEASED), Stripe VOID(PI) → PaymentStatus AUTHORIZED→VOIDED (zero moved)
  TX: Trip COMPENSATING→CANCELLED; Outbox += payment.voided, trip.cancelled
```

**Why VOID not refund on anchor loss:** because we authorize-then-capture, an anchor failure happens **before CAPTURE**, so the auth is simply VOIDED — *nothing was ever charged*. This is the single biggest reliability win of manual capture: the common-case failure moves zero money and needs zero refund.

### 6.4b Saga durability & crash recovery

`trip.SagaState` is the durable cursor. A `saga.tick` BullMQ scheduler re-drives any `SagaState` whose `step ≠ DONE` and that is stale (lease/heartbeat expired), supporting RPO≤5min / RTO≤30min. Because every external call is idempotent (Stripe Idempotency-Key, `provider.ProviderRequest` unique key, `notify.dedupeKey`) and every consumer dedupes via `platform.ProcessedEvent`, **re-driving a step is safe** — at-least-once delivery never double-charges or double-reserves. Optimistic `version` on Trip/PaymentIntent/Booking rejects concurrent re-drives.

---

## 6.5 Flow 5 — Cancellation

User-initiated (`POST /trips/{id}/cancel`) or system-initiated (provider webhook, saga failure). Compensation, never pretend-rollback (Rule 5). Order: **cancel provider reservation FIRST, then refund** (RefundStatus rule).

```
Client    API/Ctrl   Trip Saga       Booking      ProviderACL   Payments   Stripe   Outbox  Notif
  │ POST /trips/{id}/cancel (Idempotency-Key: K5)
  │─────────▶│─────────▶│ TX: validate state ∈ {CONFIRMED, PARTIALLY_BOOKED, BOOKING}
  │          │          │     Trip → CANCELLATION_REQUESTED (v++)
  │          │          │     Outbox += trip.compensation.started; step=COMPENSATE
  │ ◀═ 202 {status: CANCELLATION_REQUESTED} ═╡   (poll/SSE/FCM for terminal state)
  │                                  relay ▶ saga.compensate
  │
  │ ╔═ STEP COMPENSATE (worker) ═══════════════════════════════════════════════════╗
  │ ║ Trip → COMPENSATING                                                            ║
  │ ║ FOR EACH CONFIRMED leg (provider FIRST):                                        ║
  │ ║   TX: BookingStatus CONFIRMED→CANCELLING; idem=CR-x                            ║
  │ ║   EXTERNAL: ProviderACL.cancel(provider, providerRef, idem=CR-x) ───▶ Provider ║
  │ ║   TX: ...CANCELLING→CANCELLED; Outbox += booking.event.released/cancelled      ║
  │ ║ THEN PAYMENT (only after provider cancels):                                     ║
  │ ║   pre-capture  → Stripe VOID(PI) → AUTHORIZED→VOIDED (nothing charged)         ║
  │ ║   post-capture → compute refund per snapshotted policy → Refund machine (6.6)  ║
  │ ║                  CAPTURED→PARTIALLY_REFUNDED/REFUNDED                          ║
  │ ║ TX: Trip COMPENSATING→CANCELLED; step=DONE                                      ║
  │ ║     Outbox += trip.cancelled, notification.dispatch.requested                  ║
  │ ╚══════════════════════════════════════════════════════════════════════════════╝
  │  WORKER notify: FCM/SendGrid dedupe ──▶ push "Trip cancelled, refund €X"
  │ ◀═══ SSE trip.cancelled / FCM push ═══
  │ GET /trips/{id} → 200 {status: CANCELLED}
```

**Edge — provider cancel fails after retries/circuit-open:** the booking goes to `BookingStatus.FAILED` and `Trip → NEEDS_ATTENTION` (`trip.needs_attention` event) for human/ops resolution. We do **not** refund before the provider reservation is released, because that would leave a paid-but-still-held reservation — a money-correctness violation. The refund waits in `RefundStatus.AWAITING_PROVIDER`.

---

## 6.6 Flow 6 — Refund

Triggered by cancellation (post-capture), `PARTIALLY_BOOKED` over-charge, dispute, or `POST /refunds`. The `Refund` aggregate has its own state machine and is **always reservation-cancel-then-refund** ordered.

```
Trigger    API/Ctrl   Trip Saga    Payments(Refund)   ProviderACL   Stripe   Outbox  Ledger  Notif
  │ POST /refunds {tripId, amount?, reason} (Idempotency-Key: K6)
  │─────────▶│──────────────────▶│ TX: Refund REQUESTED (idemKey=RF1, version)
  │          │                    │     amount ≤ capturedAmount − alreadyRefunded
  │          │                    │     Outbox += payment.refund.requested
  │ ◀═ 202 {refundId, status: REQUESTED} ═╡
  │                                  relay ▶ refund.process
  │
  │ ╔═ APPROVAL (policy/auto or manual) ══════════════════════════════════════════╗
  │ ║ TX: Refund REQUESTED → APPROVED  (or → DENIED, terminal + notify)             ║
  │ ╚═══════════════════════════════════════════════════════════════════════════════╝
  │ ╔═ STEP 1 — CANCEL PROVIDER RESERVATION FIRST ════════════════════════════════╗
  │ ║ TX: Refund → AWAITING_PROVIDER; Booking → CANCELLING; idem=CR                 ║
  │ ║ EXTERNAL: ProviderACL.cancel(providerRef, idem=CR) ─────────────▶ Provider    ║
  │ ║ TX: Booking CANCELLING→CANCELLED; Outbox += booking.*released                 ║
  │ ║   (if provider cancel fails → Refund FAILED_NEEDS_ATTENTION, Trip NEEDS_ATTN) ║
  │ ╚═══════════════════════════════════════════════════════════════════════════════╝
  │ ╔═ STEP 2 — REFUND MONEY ══════════════════════════════════════════════════════╗
  │ ║ TX: Refund APPROVED→PROCESSING                                                 ║
  │ ║ EXTERNAL: Stripe.refunds.create(charge, amount, Idempotency-Key: RF1) ─▶ Stripe
  │ ║ TX: on success → Refund PROCESSING→SUCCEEDED                                   ║
  │ ║     PaymentStatus CAPTURED→PARTIALLY_REFUNDED | REFUNDED (refunded≤captured)   ║
  │ ║     LedgerEntry reversal (Σdebits==Σcredits, double-entry source of truth)     ║
  │ ║     Outbox += payment.refund.succeeded, notification.dispatch.requested        ║
  │ ║   on Stripe error → Refund PROCESSING→RETRYING (backoff) → …→ SUCCEEDED        ║
  │ ║                     or FAILED_NEEDS_ATTENTION after max attempts               ║
  │ ╚═══════════════════════════════════════════════════════════════════════════════╝
  │  WORKER notify: dedupe ──▶ FCM/SendGrid "Refunded €X"
  │ ◀═══ SSE payment.refund.succeeded / FCM ═══
```

**Idempotency & exactly-once money:** Stripe refund uses `Refund.idemKey` (RF1) as Stripe-Idempotency-Key, so a re-driven `refund.process` worker (at-least-once) never double-refunds. The ledger reversal is written **in the same tx** as the `SUCCEEDED` transition, so the double-entry ledger and `PaymentStatus` can never diverge. `refundedAmount ≤ capturedAmount` is enforced in-tx (Trip & PaymentIntent invariants).

---

## 6.7 Cross-cutting guarantees illustrated by these flows

| Concern | Where it shows up | Mechanism |
|---|---|---|
| No external call in a tx (Rule 2) | Every `EXTERNAL:` line sits **between** `TX:` blocks, inside a worker | Saga step = TX → enqueue; worker = call → next TX |
| Atomic publish (Rule 4) | Every `Outbox +=` is inside the state-change tx | `platform.OutboxEvent` + relay → BullMQ |
| Idempotency (Rule 3) | `K*` header, `PI`, `PR-*`, `RF1`, `CR-*`, `dedupeKey` | persisted keys → Stripe/Provider/Notify idempotency |
| At-least-once safe consumers | Re-driven saga steps & event handlers | `platform.ProcessedEvent` dedupe; `WebhookReceipt` unique `[source, externalEventId]` |
| Optimistic concurrency (Rule 10) | `(v++)` on Trip/PaymentIntent/Booking | `version Int`, conflicting re-drive rejected |
| Async UX | `202 Accepted` + poll `GET /trips/{id}` / SSE `/trips/{id}/events` / FCM | booking is async by contract |
| Compensation > rollback (Rule 5) | Flows 4a/5/6 | provider-cancel-first, then VOID (pre-capture) or refund (post-capture) |
| Money correctness 100% | Capture-after-reserve; VOID on common failure; ledger reversal in-tx | manual capture; double-entry source of truth |

**Webhook reconciliation (applies to all payment flows):** Stripe `POST /webhooks/stripe` and provider `POST /webhooks/providers/{provider}` are the **out-of-band truth channel**. Each insert dedupes via `platform.WebhookReceipt` unique `[source, externalEventId]`, then advances the relevant state machine in its own tx (e.g. async `payment.captured`, `payment.disputed → DISPUTED`, `payment.chargeback.finalized → CHARGEBACK`). The saga is webhook-reconciled, not webhook-dependent: worker-driven optimistic transitions plus webhook confirmation converge on the same persisted state, both idempotent.
