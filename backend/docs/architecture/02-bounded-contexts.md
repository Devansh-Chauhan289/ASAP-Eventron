# Section 2 — Bounded Context Design

We decompose ASAP into **bounded contexts** (DDD). Each context is a NestJS module with its **own domain model, its own tables, its own repositories**, and a **public application API** (services) that other contexts call only through well-defined ports or via **domain events**. **No cross-context database joins.** These boundaries are the future microservice cut-lines.

## 2.1 Context map

```
                       ┌─────────────────────────────────────────────┐
                       │              IDENTITY & ACCESS              │  (Supporting)
                       │     users, auth, sessions, roles, MFA       │
                       └───────────────▲─────────────────────────────┘
                                       │ user identity (ID only)
        ┌──────────────────────────────┼───────────────────────────────────────┐
        │                              │                                        │
┌───────┴────────┐         ┌───────────┴───────────┐              ┌─────────────┴────────────┐
│   DISCOVERY    │         │   TRIP ORCHESTRATION  │   <<core>>   │        PAYMENTS           │  <<core>>
│ search / recos │ ──reco─▶│  Trip aggregate +     │◀───charge───▶│  PaymentIntent, Refund,   │
│ (read model)   │  query  │  Process Manager (saga)│  authorize  │  Ledger, Disputes, Stripe │
└───────┬────────┘         └───┬───────┬───────┬───┘   refund     └─────────────┬─────────────┘
        │                      │       │       │                                │
        │ catalog              │book   │book   │book                            │ webhooks
        ▼                      ▼       ▼       ▼                                ▼
┌────────────────┐   ┌────────────┐ ┌─────────┐ ┌──────────┐         ┌────────────────────┐
│  (read cache)  │   │  EVENT     │ │TRANSPORT│ │  STAY    │         │   NOTIFICATIONS    │  (Supporting)
│                │   │  BOOKING   │ │ BOOKING │ │ BOOKING  │         │  FCM + SendGrid    │
└────────────────┘   └─────┬──────┘ └────┬────┘ └────┬─────┘         └────────────────────┘
                           │             │           │
                     ┌─────┴─────────────┴───────────┴──────┐
                     │  PROVIDER INTEGRATION (ACL)          │  (Generic / Anti-corruption)
                     │ Ticketmaster Eventbrite Amadeus      │
                     │ Booking.com Uber  + adapters         │
                     └──────────────────────────────────────┘

   Cross-cutting (Shared Kernel / Platform): Outbox+Events, Idempotency, Money VO,
   Correlation/Tracing, Config/Secrets, Audit log.
```

## 2.2 Context catalog

| Context | Type | Owns (data) | Core responsibility | Does NOT do |
|---------|------|-------------|---------------------|-------------|
| **Identity & Access** | Supporting | users, credentials, sessions, roles, MFA factors | AuthN, AuthZ, profile | Bookings, payments |
| **Trip Orchestration** | **Core domain** | trips, trip_legs, saga state, outbox | Owns the **Trip aggregate** & the **saga/process manager** that sequences event→transport→stay→payment with compensation | Talk to providers directly; hold card data |
| **Event Booking** | Core | event_bookings, holds | Reserve/confirm/cancel event inventory via Provider ACL | Decide trip composition; charge cards |
| **Transport Booking** | Core | transport_bookings, fare_quotes | Reserve/ticket/cancel transport; manage fare-quote expiry | Trip sequencing; payment capture |
| **Stay Booking** | Core | stay_bookings | Reserve/confirm/cancel stays; cancellation policy | Trip sequencing; payment capture |
| **Payments** | **Core domain** | payment_intents, charges, refunds, ledger_entries, disputes, idempotency_keys | Stripe integration, money state machine, **double-entry ledger**, refunds, disputes, reconciliation | Know what a "trip" means beyond an amount + reference |
| **Provider Integration** | Generic / ACL | provider_requests (idempotency+audit), circuit state | Anti-corruption adapters, rate limiting, circuit breakers, retries, response normalization | Business decisions |
| **Discovery (Search & Reco)** | Supporting (read) | search_index/cache, reco_cache | Search events, generate recommendations | Mutate bookings; be a source of truth |
| **Notifications** | Supporting | notifications, delivery_attempts, device_tokens, preferences | Deliver via FCM/SendGrid with retries & DLQ | Business logic |
| **Platform / Shared Kernel** | Shared kernel | outbox_events, audit_log | Money VO, Outbox, Idempotency primitives, correlation, tracing | Context-specific rules |

## 2.3 Why these boundaries (reasoning & tradeoffs)

- **Trip Orchestration is its own core context, separate from the booking contexts.** *Reasoning:* the sequencing/compensation logic (the saga) is a distinct responsibility from "how do I reserve a hotel." Mixing them creates a god-service. *Tradeoff:* one extra context and event hops; *benefit:* booking contexts stay simple and independently testable, and the saga can be extracted first when scaling.
- **Payments is isolated and money is double-entry.** *Reasoning:* financial correctness, PCI scope minimization, and auditability demand a context that knows only `(amount, currency, reference, idempotency_key)`. *Alternative considered:* embed payment fields on each booking — **rejected**: scatters money state, makes reconciliation and refunds across legs intractable, widens PCI scope.
- **Provider Integration is a generic ACL, not per-context.** *Reasoning:* circuit breaking, rate limiting, and idempotent provider calls are uniform concerns; centralizing them prevents N copies of resilience logic and gives one place to observe provider health. *Tradeoff:* a shared dependency many contexts use — mitigated by per-provider adapter modules and stable normalized DTOs.
- **Discovery is a read-only derived context.** *Reasoning:* search/reco are availability-tolerant and must never block or corrupt booking. Keeping them read-side lets us cache aggressively and later move to a separate read store/CQRS without touching the write model.
- **Identity is supporting, referenced by ID only.** Other contexts store `userId` (a value), never a foreign key into the identity tables across a service boundary — preserving the cut-line.

## 2.4 Inter-context relationships (DDD patterns)

| Upstream → Downstream | Relationship | Integration mechanism |
|-----------------------|--------------|------------------------|
| Trip Orchestration → Event/Transport/Stay Booking | **Customer/Supplier** | Synchronous in-process port (interface) for command; **domain events** for results |
| Trip Orchestration ↔ Payments | **Customer/Supplier** | Command (authorize/capture/refund) + events (`PaymentSucceeded`, `PaymentFailed`) |
| Booking contexts → Provider Integration | **Conformist downstream via ACL** | Provider Integration normalizes ugly external models into clean DTOs |
| Any context → Notifications | **Published Language** | Fire domain event; Notifications subscribes |
| Any context → Identity | **Shared identifier** | `userId` value object only |
| Everything → Platform | **Shared Kernel** | Money VO, Outbox, Idempotency, correlation |

## 2.5 Communication rules (enforced)

1. **Inside a request:** a context may call another context's **application service interface (port)** synchronously for *commands that must complete now* (e.g., Trip asks Payments to create a PaymentIntent). It must **not** reach into another context's repositories or tables.
2. **Across saga steps / for side effects:** communicate via **domain events** dispatched through the **Outbox** (Postgres) → **BullMQ** → subscribers. This is the at-least-once, microservice-ready path.
3. **No synchronous call may span more than one external system inside one DB transaction.** External calls happen in queue workers, each its own local transaction.
4. **Read models (Discovery) are eventually consistent** and never block writes.

## 2.6 Microservice extraction order (consequence of this map)

The boundaries are drawn so we can later lift contexts out **in this order** (lowest coupling first): Notifications → Discovery → Provider Integration → Payments → Trip Orchestration + booking contexts. See §18. Because contexts already communicate by events + ports and never share tables, extraction means "move the module + its tables behind a network boundary and swap the in-proc event bus for a broker (SNS/SQS/Kafka)" — **not a redesign.**
