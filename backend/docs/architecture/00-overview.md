# ASAP — Architecture Review Document

> **Document type:** Pre-implementation Architecture Review (Principal Engineer sign-off gate)
> **System:** ASAP — All-in-One Smart Attendance Platform (context-aware booking orchestration)
> **Status:** DESIGN — implementation is gated on approval of this document
> **Stack:** Node.js 20 · NestJS (Express adapter) · TypeScript (strict) · PostgreSQL · Prisma · Redis · BullMQ · Stripe · FCM · SendGrid · AWS ECS/Fargate

---

## Reading order

| #  | Section                          | File                              | Purpose |
|----|----------------------------------|-----------------------------------|---------|
| 1  | Business Domain Analysis         | `01-business-domain-analysis.md`  | Goals, revenue flows, critical workflows |
| 2  | Bounded Context Design           | `02-bounded-contexts.md`          | Context map, ownership, relationships |
| 3  | Aggregate Root Design            | `03-aggregates.md`                | Aggregates, entities, invariants |
| 4  | State Machines                   | `04-state-machines.md`            | Trip / Booking / Payment / Notification / Refund |
| 5  | Domain Events                    | `05-domain-events.md`             | Event catalog, contracts, choreography |
| 6  | Critical User Flows              | `06-critical-flows.md`            | Sequence diagrams (text) |
| 7  | Failure Handling Architecture    | `07-failure-handling.md`          | Failure modes, compensation, recovery |
| 8  | PostgreSQL + Prisma Architecture | `08-prisma-postgres.md`           | schema.prisma, indexes, transactions |
| 9  | API Architecture                 | `09-api-architecture.md`          | REST, versioning, contracts |
| 10 | Redis Architecture               | `10-redis.md`                     | Cache, idempotency, rate limiting |
| 11 | BullMQ Architecture              | `11-bullmq.md`                    | Queues, retries, DLQs |
| 12 | External Provider Architecture   | `12-external-providers.md`        | Anti-corruption, circuit breakers |
| 13 | Security Architecture            | `13-security.md`                  | AuthN/Z, secrets, PCI, OWASP |
| 14 | Observability Architecture       | `14-observability.md`             | Logs, metrics, tracing |
| 15 | AWS Infrastructure Architecture  | `15-aws-infrastructure.md`        | ECS, RDS, ElastiCache, S3, API GW |
| 16 | Testing Strategy                 | `16-testing.md`                   | Unit → chaos |
| 17 | Production NestJS Structure       | `17-nestjs-structure.md`          | Module layout, layering |
| 18 | Implementation Roadmap           | `18-roadmap.md`                   | MVP → microservice extraction |

---

## Architectural thesis (one paragraph)

ASAP is **not** a CRUD app; it is a **distributed orchestration platform** that coordinates money movement (Stripe) and inventory held by **third parties we do not control** (Ticketmaster, Amadeus, Booking.com, Uber). The two hardest facts in the system are: (1) **we cannot make a third-party booking and a Stripe charge atomic** — they live in different systems with no shared transaction; and (2) **external providers fail, time out, and double-deliver webhooks**. Therefore the spine of the architecture is a **Saga/Process-Manager pattern over a Modular Monolith**: each step is a local ACID transaction in PostgreSQL (via Prisma `$transaction`), durable side effects are pushed to **BullMQ** for at-least-once execution with explicit **idempotency keys**, and cross-step consistency is achieved through **compensating transactions**, not distributed locks. We optimize for **correctness under partial failure** over development speed, and we keep the monolith **microservice-ready** by enforcing bounded-context boundaries in code (separate modules, no cross-context DB joins, communication via domain events).

## Foundational design rules (apply to every section)

1. **PostgreSQL is the system of record.** Redis, BullMQ, and provider state are derived/cache/transport — never authoritative.
2. **One local transaction per saga step.** Money and inventory are never assumed atomic across systems; they are reconciled.
3. **Every state-changing external call is idempotent** via a client-supplied or system-generated idempotency key persisted in Postgres.
4. **The outbox pattern** guarantees "DB write + event publish" atomicity. We never publish to BullMQ inside business logic and hope it lands.
5. **Compensation over rollback** for cross-service work: if Stripe charged but the provider booking failed, we **refund**, we do not pretend it didn't happen.
6. **State machines are explicit and enforced in the domain layer**, not implied by boolean columns.
7. **Prisma Client never reaches a controller.** Repositories wrap it; services own transaction boundaries.
8. **Bounded contexts never share tables or do cross-context joins.** This is the seam along which we later cut microservices.
