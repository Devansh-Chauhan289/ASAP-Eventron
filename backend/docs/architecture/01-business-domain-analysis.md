# Section 1 — Business Domain Analysis

## 1.1 Business goals

ASAP sells **the journey, not the ticket.** The differentiating insight: the moment a user books an event, the system already knows the **destination (where)**, the **arrival deadline (when)**, and the **probable duration (how long)**. Every other product — transport, stay, ground transfer — can be orchestrated around that anchor.

| Goal | Description | Why it matters architecturally |
|------|-------------|--------------------------------|
| **Anchor-driven orchestration** | The event booking seeds transport + stay recommendations and a coherent itinerary | Requires a long-lived **Trip aggregate** + a **process manager**, not request/response CRUD |
| **One journey, one wallet** | A user pays once for a multi-leg trip spanning many providers | Requires **saga** money handling: one payment authorization, many fulfillments, partial refunds |
| **Survive provider reality** | Providers are slow, flaky, rate-limited, and double-deliver webhooks | Requires **anti-corruption layers, circuit breakers, idempotency, compensation** |
| **Trust** | A booking either happens and the user is charged correctly, or it doesn't and they are made whole | Requires **financial-grade consistency** and reconciliation |
| **Evolvability** | Start as one deployable, grow into services as scale/teams demand | Requires a **modular monolith** with hard context boundaries |

## 1.2 Actors

- **Traveler (end user)** — searches, books, pays, manages trips, cancels.
- **Event Organizer / Provider** — supplies inventory (mostly via 3rd-party APIs; some first-party later).
- **ASAP Orchestrator (system)** — the autonomous process manager driving sagas.
- **Stripe** — money authority (charges, refunds, disputes, payouts).
- **External providers** — Ticketmaster, Eventbrite, Amadeus (flights), rail/bus aggregators, Booking.com (stays), Uber (rideshare).
- **Ops / Finance** — reconciliation, refunds, dispute handling, manual intervention queue.

## 1.3 Critical workflows (ranked by business risk)

1. **Combined Trip Booking (the crown jewel & highest risk).** Event + transport + stay booked as one logical purchase. Spans ≥3 external systems + Stripe. This is where distributed failure, partial success, and compensation all converge.
2. **Single Event Booking.** Reserve inventory at provider → take payment → confirm. Money + external inventory, not atomic.
3. **Transport Booking.** Often time-sensitive pricing (fares change mid-checkout); strong idempotency needs.
4. **Stay Booking.** Date-range inventory, cancellation policies, partial refunds.
5. **Cancellation & Refund.** Reverse one or many legs, compute provider-specific penalties, reconcile money. Dispute/chargeback handling.
6. **Recommendation generation.** Read-heavy, cache-heavy, tolerant of staleness; must not block booking.

## 1.4 Revenue-generating flows (where money is made — protect these first)

| Flow | Revenue mechanism | Failure cost |
|------|-------------------|--------------|
| Booking fulfillment | Service fee / markup / commission per booked leg | Direct lost revenue + refunds |
| Combined trip | Attach-rate uplift (transport + stay attached to event) | Lost margin on the most profitable basket |
| Cancellation | Retained cancellation/penalty fees | Revenue leakage + chargeback fees |
| Payments | Float, interchange optimization | Disputes erode margin; fraud causes losses |

**Implication:** The booking-execution path and the payment path are the **revenue-critical core**. They get the strongest consistency guarantees, the most observability, the highest test coverage, and the first dedicated on-call alerting. Recommendation/search are **availability-tolerant** and degrade gracefully.

## 1.5 What makes this hard (the non-CRUD reality)

- **No distributed transaction across Stripe + providers.** We cannot `BEGIN…COMMIT` across Stripe and Booking.com. We get **at-most-once intent, at-least-once execution, exactly-once effect via idempotency.**
- **Eventual consistency is mandatory, not optional.** A trip can be "partially booked" for seconds to minutes while legs settle.
- **Time-bounded inventory & pricing.** A held seat or quoted fare expires; the saga races a clock.
- **Money is irreversible-ish.** Refunds cost fees and time; double charges are a trust catastrophe. Idempotency is non-negotiable.
- **Webhooks are unreliable & repeated.** Stripe/provider webhooks arrive out of order, twice, or never (need polling reconciliation as backstop).

## 1.6 Non-functional requirements (targets that shape the design)

| NFR | Target | Driver |
|-----|--------|--------|
| Bookings/year | Millions (design for 10M/yr ≈ ~20 sustained TPS, ~200 TPS peak) | Sizing of DB, queues, connection pools |
| Booking confirmation latency (p95) | < 30 s end-to-end for single leg; combined trip async with progressive confirmation | Async saga + push notifications |
| API read latency (p95) | < 200 ms (search/recommendations cached) | Redis-first reads |
| Payment correctness | 100% (zero tolerance for double charge / silent loss) | Idempotency + reconciliation + ledger |
| Availability | 99.9% control plane; booking saga **durable** (survives restarts) | BullMQ persistence, outbox, retries |
| RPO / RTO | RPO ≤ 5 min (RDS PITR), RTO ≤ 30 min | Multi-AZ RDS, IaC redeploy |
| Data residency / PCI | Card data never touches our servers (Stripe Elements/PaymentIntents) | SAQ-A scope minimization |

## 1.7 Out of scope for v1 (explicit, to bound the design)

First-party inventory ownership, multi-currency settlement, loyalty/points, marketplace organizer onboarding, B2B/group booking. The architecture must **not preclude** these (see Roadmap §18) but v1 treats all inventory as third-party and single-currency (USD) with multi-currency-ready money modeling (minor units + currency code).
