# Section 07 — Failure Handling Architecture

## 7.1 Philosophy & Guiding Principles

ASAP orchestrates a distributed transaction across three blast-radius boundaries that we do **not** control: Stripe (money), external Providers (inventory), and notification carriers (FCM/SendGrid). The only thing we fully control is PostgreSQL (the system of record) and our own Redis/BullMQ transport. Every failure-handling decision below flows from one architectural axiom:

> **The DB transaction is the only atomic primitive we trust. Everything crossing a network boundary is eventually-consistent, at-least-once, and must be idempotent. We never pretend a remote side-effect rolled back — we *compensate* it.**

Five derived principles govern the rest of this section:

| # | Principle | Mechanism |
|---|-----------|-----------|
| P1 | **No external call inside a DB tx** (Rule 2). A held DB connection during a 30s Stripe timeout is a connection-pool death spiral under load. | Saga step = `read state (tx)` → `external call (no tx)` → `record result + advance step (tx)`. |
| P2 | **Dual-write is solved by the outbox, never by best-effort publish-after-commit.** | `platform.OutboxEvent` written in the *same* `$transaction` as the state change; a relay publishes it to BullMQ. |
| P3 | **Manual capture makes VOID the default failure outcome.** Authorize-then-capture means the common sad path moves **zero money**. We design for VOID-first; refund is the exception, not the rule. | `PaymentStatus.AUTHORIZED → VOIDED` (Stripe `cancel`), not `CAPTURED → REFUNDED`. |
| P4 | **Compensation has a fixed ordering: cancel the provider reservation FIRST, then release/refund money.** | `RefundStatus` flow gated on `BookingStatus.RELEASED`. Never refund while a hold is still live (double-loss risk). |
| P5 | **Anything we cannot auto-resolve becomes `NEEDS_ATTENTION` and lands in the ops queue — it never silently fails or infinitely retries.** | `TripStatus.NEEDS_ATTENTION`, `RefundStatus.FAILED_NEEDS_ATTENTION`, DLQ. |

ASCII model of one saga step (the unit all failure handling is built on):

```
            ┌──────────────────────── SAGA STEP ────────────────────────┐
  Tx #1     │  external (NO tx)                              Tx #2       │
 ┌───────┐  │  ┌───────────────────────────┐               ┌─────────┐  │
 │ read  │──┼─▶│ Stripe / Provider call,    │──result/err──▶│ persist │  │
 │ Saga  │  │  │ guarded by persisted        │              │ result, │  │
 │ State │  │  │ IdempotencyKey/ProviderReq │              │ advance │  │
 └───────┘  │  └───────────────────────────┘               │ + Outbox│  │
            │   crash anywhere ⇒ replay is safe (idempotent)└─────────┘  │
            └────────────────────────────────────────────────────────────┘
```

The crash-safety property: a process can die at **any** point. On replay, the step re-reads `SagaState.step`, re-issues the external call under the **same** idempotency key (Stripe dedupes; `provider.ProviderRequest` unique `[provider, idempotencyKey]` dedupes), and the second tx is a no-op if already applied (`platform.ProcessedEvent` / version check). This is the foundation that makes every scenario below recoverable.

---

## 7.2 The Dual-Write Problem & the Outbox (foundational)

Two writes that must both happen — "change DB state" and "publish event / call provider" — cannot be made atomic across a network. Three failure modes of naive code:

1. Commit DB, then process crashes before publish → **event lost**, saga stalls.
2. Publish, then DB commit fails → **phantom event**, consumers act on a state that doesn't exist.
3. Call provider, then DB write fails → **orphaned provider hold** (we hold inventory we have no record of).

ASAP forbids all three structurally:

- **For event publish (P2):** the domain event row is inserted into `platform.OutboxEvent` *inside the same `$transaction`* as the aggregate change. Either both commit or neither does. A separate **Outbox Relay** (polling `WHERE published_at IS NULL ORDER BY id` + `FOR UPDATE SKIP LOCKED`, plus Postgres `LISTEN/NOTIFY` for low latency) publishes to BullMQ and stamps `published_at`. Publish is **at-least-once**; consumers dedupe via `platform.ProcessedEvent (eventId)`.

- **For provider/Stripe side-effects (P1/P3):** we never put the call in a tx. Instead we make the call *resumable and idempotent* via a persisted key written **before** the call, and reconciled **after**:

```
Tx#1: INSERT provider.ProviderRequest(provider, idempotencyKey, status=PENDING)  -- unique[provider,idemKey]
                (commit)
ext : POST provider  with header Idempotency-Key = idempotencyKey
Tx#2: UPDATE provider.ProviderRequest SET status=DONE, providerRef=...; advance Saga + OutboxEvent
```

If the process dies between Tx#1 and Tx#2, the reconciliation job (§7.10) finds a `PENDING` `ProviderRequest` older than threshold, queries the provider by idempotency key, and either confirms (writes the missing `providerRef`) or compensates. **The orphaned-hold window is bounded by the reconciliation interval, never unbounded.**

| Outbox guarantee | Without outbox | With outbox |
|---|---|---|
| Event lost on crash | Possible | Impossible (same tx) |
| Phantom event | Possible | Impossible (event only exists if state committed) |
| Delivery semantics | unclear | at-least-once + idempotent consumer |
| Ordering | none | per-aggregate via monotonic `OutboxEvent.id` |

**Tradeoff considered:** Debezium/CDC log-tailing vs. polling relay. We chose **polling + LISTEN/NOTIFY** for the monolith phase — no Kafka/Connect operational burden, RDS-native, and the microservice-ready cut-line is preserved (a consumer can later switch source from BullMQ to a real broker without touching the outbox write). CDC is the documented future migration when per-context services split out.

---

## 7.3 The Four Canonical Failure Questions

These are the questions the section is required to answer head-on. Each maps to a structural defense already in the foundation.

### 7.3.1 Stripe succeeds but booking fails

This is the headline scenario, and **manual capture changes its character entirely (P3).** At the point a leg booking fails, the `PaymentIntent` is in `AUTHORIZED` (`requires_capture`) — **no money has moved.** We have not captured yet because `CAPTURE_PAYMENT` is a *later* saga step than the `RESERVE_*` steps. So:

- **Anchor leg (event) fails after authorize:** saga goes `COMPENSATING`; the only money action is **VOID the authorization** (Stripe `paymentIntents.cancel`), `PaymentStatus AUTHORIZED → VOIDED`. Zero charge, zero refund, zero ledger movement beyond reversing the authorization hold. Trip → `CANCELLED`.
- **Secondary leg (e.g. stay/transport) fails but anchor succeeded:** this is **`PARTIALLY_BOOKED`** (first-class). We capture only for the confirmed legs (or capture-then-partial-refund depending on quote granularity), release the failed leg's provider hold, and refund only its portion if already captured. Trip → `PARTIALLY_BOOKED`, not `CANCELLED`.

| | Detection | Immediate action | Recovery | Compensation | Consistency outcome |
|---|---|---|---|---|---|
| **Stripe AUTHORIZED, anchor leg RESERVE fails** | `booking.event.failed` event; saga step `RESERVE_EVENT` returns error | Saga → `COMPENSATING`, step=`COMPENSATE` | Retry reserve up to policy; if exhausted, compensate | Cancel any partial provider holds (RELEASING→RELEASED) **then VOID auth** (no refund needed) | Trip `CANCELLED`, Payment `VOIDED`, **$0 moved**, ledger flat |
| **Stripe AUTHORIZED/CAPTURED, secondary leg fails** | `booking.transport.failed` / `booking.stay.failed` | Saga → `COMPENSATING` for that leg only | Keep anchor; retry secondary; on exhaustion compensate secondary | Release secondary provider hold FIRST (P4), then VOID (if uncaptured) or partial-refund (if captured) | Trip `PARTIALLY_BOOKED`, anchor `CONFIRMED`, refund only secondary portion |

Because capture is deferred, **the dreaded "charged the customer but couldn't book" state is largely unreachable** — we book everything to `CONFIRMED` *before* `CAPTURE_PAYMENT`. The only true capture-then-fail window is "captured, then a confirmed booking is later externally cancelled," which the dispute/refund flow (§7.7) handles.

### 7.3.2 Booking succeeds but the DB write recording it fails

Classic orphaned-hold dual-write (§7.2). The provider call returned `providerRef` but our Tx#2 (recording it) failed/crashed.

| Detection | Immediate action | Recovery | Compensation | Consistency outcome |
|---|---|---|---|---|
| `provider.ProviderRequest` stuck `PENDING`/`SENT` past threshold; or saga step never advanced | Reconciliation job re-queries provider **by idempotencyKey** (the call is idempotent, so re-issue is safe) | If provider says reserved → write `providerRef`, advance saga (the delayed Tx#2). If provider says no reservation → re-issue. | If trip already moved on / cannot use the hold → RELEASE the orphaned reservation | No orphaned hold survives past one reconciliation cycle; booking either `RESERVED` with `providerRef` or `RELEASED` |

The **unique `[provider, idempotencyKey]`** on `ProviderRequest` plus the provider's own idempotency support means re-querying or re-issuing never creates a *second* hold. This is the dual-write problem inverted (external write succeeded, local write didn't) and it is resolved by *making the local record the durable intent written first* and the reconciler closing the loop.

### 7.3.3 Webhook arrives twice (or N times)

Stripe and providers retry webhooks aggressively; at-least-once is guaranteed, exactly-once is not.

| Detection | Immediate action | Recovery | Compensation | Consistency outcome |
|---|---|---|---|---|
| `platform.WebhookReceipt` unique `[source, externalEventId]` insert conflicts | On conflict → ack 200 immediately, **do no work** (idempotent replay swallowed) | First delivery: verify signature, insert receipt, enqueue internal handling via outbox/BullMQ, ack 200 | n/a (no side effect on dup) | Webhook processed exactly once regardless of delivery count |

```
POST /webhooks/stripe
  verify sig (Stripe-Signature) ─ fail ⇒ 400 (never trust unsigned)
  Tx: INSERT WebhookReceipt(source='stripe', externalEventId=evt.id) ON CONFLICT DO NOTHING
      if inserted: also INSERT OutboxEvent(payment.* )   -- same tx, durable
  return 200    -- ack fast; heavy work happens off the outbox/queue
```

Critically, the webhook handler **persists-and-acks fast**; it does not do the state transition inline. The real handler consumes the outbox-published internal event and is **also** idempotent via `platform.ProcessedEvent` (defense in depth: receipt dedupes the carrier, ProcessedEvent dedupes our own at-least-once bus).

### 7.3.4 Redis / BullMQ unavailable

Redis is **transport, not source of truth** (Rule 1). Its loss degrades but does not corrupt.

| Detection | Immediate action | Recovery | Compensation | Consistency outcome |
|---|---|---|---|---|
| BullMQ enqueue errors; `health/ready` flips ElastiCache check; circuit opens | API stays up: state-changing writes still commit to Postgres + OutboxEvent (the queue is downstream of the durable write) | Outbox rows accumulate `published_at IS NULL`; relay drains the backlog when Redis returns. Idempotency rate-limit/cache falls back to DB-backed `IdempotencyKey`. | none — nothing lost, only delayed | **No data loss.** Bookings/payments are *delayed*, not dropped. Saga progress resumes from durable `SagaState`. |

Because the outbox lives in Postgres, a total Redis outage means events queue durably on disk and replay on recovery. The only user-visible effect is increased latency for the async booking flow (the 202/poll contract already tolerates this). `health/ready` returning unhealthy sheds new load at the API Gateway while in-flight sagas remain recoverable. Rate-limiting/circuit-breaker counters that live in Redis fail **closed-conservative** (treat as "limit reached / circuit open") to protect providers when we lose visibility.

---

## 7.4 Provider Timeouts, Slowness & Circuit Breaking

| Scenario | Detection | Immediate action | Recovery | Compensation | Consistency outcome |
|---|---|---|---|---|---|
| **Provider request times out** | Adapter timeout (no response) | **Ambiguous outcome** — do NOT assume failure. Mark `ProviderRequest` `SENT`/`UNKNOWN` | Retry **with same idempotencyKey** (safe); reconciler resolves true state by query-by-key | If a hold was actually created but we gave up → RELEASE it | Booking `RETRYING`; resolves to `RESERVED` or `RELEASED`, never duplicate hold |
| **Provider 5xx / connection refused** | HTTP 5xx, ECONNREFUSED | Retry with exp backoff + jitter, capped; increment `provider.CircuitState` failures | After N failures → **open circuit**: fast-fail without calling provider | If trip cannot proceed → `COMPENSATING` | Booking `FAILED`/`RETRYING`; trip may → `PARTIALLY_BOOKED` or `NEEDS_ATTENTION` |
| **Provider 429 rate limit** | HTTP 429 + Retry-After | Honor Retry-After; requeue with delay | Token-bucket per provider in Redis | n/a | Delayed, eventually consistent |
| **Circuit OPEN** | `provider.CircuitState.state=OPEN` | Reject reserve attempts fast; don't burn the provider | HALF_OPEN probe after cooldown; close on success | If booking deadline blown → compensate the trip | Trip degrades gracefully, no thundering herd on a sick provider |

**Timeout = ambiguity, not failure.** This is the single most important provider rule. A timed-out reserve may have *succeeded* server-side. We therefore (a) never auto-treat timeout as "no hold," (b) always retry under the same idempotency key so a duplicate can't form, and (c) let the reconciler (§7.10) query-by-key to learn the truth. The **orphaned-hold defense** is this trio plus the bounded reconciliation interval.

Circuit breaker states (`provider.CircuitState`): `CLOSED → OPEN` (failure threshold) `→ HALF_OPEN` (cooldown elapsed) `→ CLOSED` (probe ok) or back to `OPEN` (probe fails). This protects both ASAP (don't waste latency budget) and the provider (don't DDoS a struggling partner during the ~200 TPS peak).

---

## 7.5 Pricing Changes During Checkout

Transport especially has volatile fares; `booking.FareQuote.expiresAt` and `priceSnapshot` projection on `TripLeg` exist precisely for this.

| Scenario | Detection | Immediate action | Recovery | Compensation | Consistency outcome |
|---|---|---|---|---|---|
| **Quote expired before confirm** | `FareQuote.expiresAt < now` guard at `RESERVE_TRANSPORT` | Reject step; emit `booking.transport.quote_expired` | Re-quote; require client re-confirm if delta exceeds tolerance | None if caught pre-authorize (no money) | Trip stays `PLANNING`/`PENDING_PAYMENT`; user re-confirms |
| **Price changed at reserve time** | Provider returns new price ≠ `priceSnapshot` | Emit `booking.transport.price_changed`; compare to tolerance band | Within tolerance → proceed; outside → halt, surface to user | If already AUTHORIZED for old amount and user rejects → **VOID** (P3, no money moved) | No silent overcharge; authorize amount always matches accepted price |

Because authorization happens **before** booking confirm in the saga, and authorize uses the snapshotted basket total, a price change discovered mid-saga that exceeds tolerance is resolved by **VOID + re-quote**, not by silently capturing a different amount. **Payment correctness 100%** (NFR) is preserved: we never capture an amount the user didn't explicitly accept. Optimistic concurrency (`version` on `Trip`/`PaymentIntent`) prevents two concurrent checkout attempts from authorizing twice.

---

## 7.6 Notifications Fail

Notifications are **supporting / non-critical** — their failure must **never** block or compensate a trip.

| Scenario | Detection | Immediate action | Recovery | Compensation | Consistency outcome |
|---|---|---|---|---|---|
| **FCM/SendGrid 5xx or timeout** | Delivery attempt error logged to `notify.DeliveryAttempt` | `NotificationStatus QUEUED→SENDING→RETRYING` | BullMQ retry w/ backoff; fall over SendGrid→? / FCM→? channel | none (decoupled) | Trip state unaffected; notification eventually `SENT`/`DELIVERED` or `FAILED` |
| **Duplicate dispatch** | `notify.Notification` unique `[userId, templateId, dedupeKey]` conflict | Swallow (idempotent) | n/a | n/a | User gets one message, not N |
| **Permanently undeliverable** | Retries exhausted | `FAILED`; if delivery receipt never arrives → `UNCONFIRMED` | Surface in user's in-app trip view (pull model is the backstop) | none | User can still poll `GET /trips/{id}` / SSE — push is best-effort |

The contract "client polls `GET /trips/{id}` or SSE `/trips/{id}/events`" means **push is an optimization, not the source of truth**. A user whose FCM token is dead still sees `CONFIRMED` by polling. This is why notification failure is isolated from the saga entirely.

---

## 7.7 Stripe Auth VOID vs Refund — Decision Matrix

Manual capture gives us two very different "give the money back" paths, and choosing wrong either double-loses money or leaves a hold stuck.

| Payment state at compensation time | Correct action | Stripe call | Result state | Money moved | Notes |
|---|---|---|---|---|---|
| `AUTHORIZED` (requires_capture) | **VOID** | `paymentIntents.cancel` | `VOIDED` | **None** (auth released) | The common case (P3). Cheapest, instant, no refund fees. |
| `CAPTURED` (full) | **Refund** | `refunds.create` | `REFUNDED` | Full reversal | Only if we already captured (e.g. all legs confirmed then later cancelled) |
| `CAPTURED`, one leg failed | **Partial refund** | `refunds.create(amount)` | `PARTIALLY_REFUNDED` | Secondary leg portion | `PARTIALLY_BOOKED` trips |
| `PROCESSING`/`REQUIRES_ACTION` | **Wait/poll, don't compensate yet** | webhook + reconciler | resolves forward | TBD | Ambiguous; never void mid-flight |
| `DISPUTED`/`CHARGEBACK` | **Do not refund** (would double-pay) | handle via dispute flow | `CHARGEBACK` finalized | Bank-driven | `payment.chargeback.finalized` |

**Rule of thumb encoded in the domain layer:** *if `capturedAmount == 0`, compensation is a VOID; if `capturedAmount > 0`, compensation is a Refund of (capturedAmount − amountKept).* This keeps the invariant `refundedAmount ≤ capturedAmount` and the double-entry ledger balanced (`sum(debits)==sum(credits)`).

---

## 7.8 Saga Compensation Ordering (cancel provider FIRST, then refund)

The ordering in `RefundStatus` and the foundation is **not arbitrary** — it prevents the worst money-loss bug in travel systems: refunding the customer while still holding (and being billed for) the provider inventory.

```
COMPENSATE step  (TripStatus.COMPENSATING)
  ┌────────────────────────────────────────────────────────────────┐
  │ 1. For each confirmed/reserved leg, in REVERSE order:           │
  │      BookingStatus: CONFIRMED/RESERVED → RELEASING              │
  │      call provider.cancel  (idempotent, ProviderRequest key)    │
  │      → RELEASED   (must reach RELEASED before money step)       │
  │                                                                  │
  │ 2. ONLY AFTER all holds RELEASED:                              │
  │      if AUTHORIZED  → VOID   (PaymentStatus → VOIDED)           │
  │      if CAPTURED    → Refund (RefundStatus: REQUESTED →         │
  │                       APPROVED → AWAITING_PROVIDER →            │
  │                       PROCESSING → SUCCEEDED)                   │
  │                                                                  │
  │ 3. Trip → CANCELLED (or PARTIALLY_BOOKED if anchor survived)   │
  └────────────────────────────────────────────────────────────────┘
```

| Step | Failure mid-compensation | Handling |
|---|---|---|
| Provider cancel fails | Retry idempotently; if exhausted → leg `NEEDS_ATTENTION`, **do NOT proceed to refund** (P4) | Money stays held/authorized; ops resolves; consistency preserved (no double loss) |
| Refund fails after release | `RefundStatus FAILED_NEEDS_ATTENTION`; retry queue | Customer owed money — high-priority ops item; never abandoned |
| Crash mid-compensation | `SagaState.step=COMPENSATE` durable; replay resumes from last RELEASED leg | At-least-once compensation, idempotent provider/Stripe calls make replay safe |

Why provider-first: if we refunded first and the provider cancel then failed, ASAP eats the cost of a live booking it already refunded. Releasing inventory first means the **worst case is a stuck auth/charge (recoverable by ops), never an unrecoverable double payment.**

---

## 7.9 Poison Messages, DLQ & NEEDS_ATTENTION Ops Queue

Not every failure is transient. A message that fails deterministically (bad payload, an aggregate in an impossible state, a provider permanently rejecting) must not retry forever and must not block the queue.

| Layer | Mechanism | Transition |
|---|---|---|
| BullMQ consumer | Bounded attempts + exp backoff | After max attempts → **DLQ** (dedicated `*.dead` queue) |
| Saga | Unrecoverable step after retries | Trip → `TripStatus.NEEDS_ATTENTION` |
| Refund | Refund permanently failing | `RefundStatus.FAILED_NEEDS_ATTENTION` |
| Booking | Provider hard-reject | `BookingStatus.REJECTED`/`FAILED` |

`NEEDS_ATTENTION` is a **first-class, human-facing operational state**, not a dead-end. The flow:

```
poison/exhausted ─▶ DLQ ─▶ alert (CloudWatch alarm) ─▶ Ops queue UI
                                                          │
                                  ┌───────────────────────┴────────────────┐
                                  ▼                                          ▼
                          replay (fix + requeue)                    manual compensation
                          (idempotent ⇒ safe)                       (void/refund/release)
                                  │                                          │
                                  └───────────▶ Trip back to a valid state ◀─┘
```

Every DLQ entry retains the full event envelope (`eventId, correlationId, causationId, tripId`) so an operator (and the `AuditLog`) can trace the exact saga lineage. Because all handlers are idempotent (`ProcessedEvent`), replaying a DLQ'd message after a code fix is always safe — no double-booking, no double-refund.

---

## 7.10 Reconciliation Jobs — the Polling Backstop for Missed Webhooks

Webhooks are best-effort delivery from Stripe/providers. **Architecturally, we assume webhooks WILL be missed** (carrier outage, our 200 lost, signature rotation) and treat reconciliation as the authoritative backstop, not an afterthought.

| Reconciler (cron via BullMQ repeatable) | Scans for | Action |
|---|---|---|
| **Stripe payment reconciler** | `PaymentIntent` not in terminal state past SLA; or local state ≠ Stripe state | Query Stripe API by `paymentIntentId`, replay the state transition we'd have done on webhook (idempotent via `ProcessedEvent`) |
| **Provider hold reconciler** | `ProviderRequest` `PENDING`/`SENT` past threshold (orphan hunt) | Query provider by idempotencyKey; confirm `providerRef` or RELEASE orphan |
| **Saga watchdog** | `SagaState` not advanced past step-timeout (stuck saga) | Re-drive the step or escalate to `NEEDS_ATTENTION` |
| **Refund reconciler** | `Refund` in `AWAITING_PROVIDER`/`PROCESSING` past SLA | Query Stripe refund status; advance to `SUCCEEDED` or `FAILED_NEEDS_ATTENTION` |
| **Outbox lag monitor** | `OutboxEvent` unpublished past threshold | Alarm (relay/Redis problem); relay re-drains |

This guarantees **RPO ≤ 5min** in practice: even a total webhook blackout converges within the reconciliation interval. The reconciler and the webhook handler funnel into the **same idempotent internal handler**, so it doesn't matter which one "wins" — `WebhookReceipt` + `ProcessedEvent` ensure exactly-once *effect* regardless of how many times the trigger fires.

---

## 7.11 Partial-Trip Handling (`PARTIALLY_BOOKED`)

`PARTIALLY_BOOKED` is first-class because forcing "all-or-nothing" on a multi-leg trip would cancel a successfully-booked concert because a hotel sold out — terrible UX and wasteful compensation.

| Anchor (event) | Secondary leg | Resulting Trip state | Money |
|---|---|---|---|
| CONFIRMED | CONFIRMED | `CONFIRMED` | Captured in full |
| CONFIRMED | FAILED (released+refunded) | `PARTIALLY_BOOKED` | Capture anchor; void/refund secondary only |
| **FAILED** | any | `CANCELLED` (full compensation) | **Auth VOIDED, nothing charged** (P3) |

The asymmetry is deliberate: **losing the anchor collapses the trip's reason-to-exist**, so we fully compensate → `CANCELLED` with a clean VOID (zero money moved, since capture hadn't happened). Losing a secondary leg preserves the anchor and degrades to `PARTIALLY_BOOKED`, refunding/voiding only that leg's portion (`PARTIALLY_REFUNDED` if already captured). The invariant `CONFIRMED trip ⇒ all required legs CONFIRMED` is upheld — a partial trip is explicitly *not* `CONFIRMED`.

---

## 7.12 Consolidated Scenario Matrix (quick reference)

| # | Scenario | Detection | Immediate action | Recovery | Compensation | Consistency outcome |
|---|---|---|---|---|---|---|
| 1 | Stripe AUTHORIZED, anchor booking fails | `booking.event.failed` | Saga→COMPENSATING | retry reserve | release holds → **VOID** | Trip CANCELLED, **$0 moved** |
| 2 | Stripe CAPTURED, secondary fails | `booking.*.failed` | COMPENSATING (leg) | retry leg | release leg → partial refund | PARTIALLY_BOOKED |
| 3 | Booking ok, DB write fails | ProviderRequest PENDING | reconciler query-by-key | write providerRef / re-issue | release if unusable | no orphan hold |
| 4 | Webhook arrives twice | WebhookReceipt conflict | ack 200, no-op | n/a | n/a | exactly-once effect |
| 5 | Redis/BullMQ down | enqueue error / ready fails | keep DB writes + outbox | relay drains backlog | none | no loss, delayed only |
| 6 | Provider timeout | adapter timeout | treat as **ambiguous**, retry same key | reconciler resolves | release if phantom hold | no duplicate hold |
| 7 | Provider 5xx/down | 5xx, circuit failures | backoff, open circuit | half-open probe | compensate if deadline blown | graceful degrade |
| 8 | Quote expired/price changed | expiresAt / price delta | reject, emit quote_expired/price_changed | re-quote + re-confirm | VOID if user rejects | no silent overcharge |
| 9 | Notification fails | DeliveryAttempt error | RETRYING | backoff retry / channel fallback | none | trip unaffected; poll backstop |
| 10 | Poison message | max attempts hit | → DLQ | fix + idempotent replay | manual if needed | no infinite retry, no block |
| 11 | Missed webhook | reconciler SLA breach | query provider/Stripe | replay transition | as needed | converges ≤ RPO 5min |
| 12 | Stuck saga | watchdog step-timeout | re-drive step | resume from SagaState | escalate NEEDS_ATTENTION | durable saga, RTO ≤ 30min |

---

## 7.13 Open Questions / Decisions for Review

1. **Compensation retry budget before `NEEDS_ATTENTION`** — propose 3 attempts w/ exp backoff for provider cancel, then escalate. Confirm with ops staffing model.
2. **Tolerance band for `price_changed`** — auto-proceed threshold (e.g. ≤ 2% or ≤ X minor units) vs. always-re-confirm. Product decision; affects conversion vs. surprise-charge risk.
3. **Reconciliation interval vs. orphan-hold cost** — tighter interval shrinks orphan-hold window but raises provider API load; propose 60–120s for provider holds, 5min for payments (meets RPO).
4. **DLQ replay authority** — who can replay (ops role + audit), and auto-replay-on-deploy for code-fix poison vs. always-manual.
5. **Stripe `PROCESSING` ambiguity window** — confirm we never compensate a payment in `PROCESSING`/`REQUIRES_ACTION`; only act on terminal-ish states to avoid racing the customer's 3DS flow.
