# ASAP Backend

**ASAP — All-in-One Smart Attendance Platform.** A context-aware booking **orchestration** platform: book an event, and the system orchestrates transport + stay + payments + notifications around it as a single journey.

> **Current stage:** Architecture / contract-first design. Implementation is gated on sign-off of the architecture review (see `docs/architecture/`). No application code is written yet — by design.

## What's here

| Path | What it is |
|------|------------|
| **`API.md`** | **Frontend integration guide** — full v1 REST API reference (auth, trips, checkout, cancel/refund, errors, async booking model). Build your frontend/mocks against this now. |
| `docs/architecture/` | The 18-section **Architecture Review Document** (Principal-Engineer pre-implementation review). Start at `00-overview.md`. |
| `prisma/schema.prisma` | Canonical database schema (reproduced/explained in `docs/architecture/08-prisma-postgres.md`). *Added during Phase 1 implementation.* |
| `src/` | NestJS modular-monolith source (layout defined in `docs/architecture/17-nestjs-structure.md`). *Added during Phase 1 implementation.* |

## Stack

Node.js 20 · NestJS (Express) · TypeScript (strict) · PostgreSQL + Prisma · Redis · BullMQ · Stripe · FCM + SendGrid · AWS ECS/Fargate, RDS, ElastiCache, S3, API Gateway, Secrets Manager, CloudWatch.

## Architecture in one paragraph

A **modular monolith** organized by **DDD bounded contexts** (Identity, Trip Orchestration, Event/Transport/Stay Booking, Payments, Provider Integration, Discovery, Notifications), built **microservice-ready**. The spine is a **Saga / Process-Manager** that sequences `authorize → reserve legs → capture → confirm` with **compensating transactions** for failure — because we cannot make a Stripe charge and a third-party booking atomic. Consistency rests on: **PostgreSQL as system of record**, **one Prisma `$transaction` per saga step** (no external call inside a DB transaction), the **Outbox pattern** for atomic event publishing, **idempotency keys** everywhere, and a **double-entry ledger** for money. Read the thesis in `docs/architecture/00-overview.md`.

## For frontend engineers (start here)

1. Read **`API.md`** — it is the committed v1 contract.
2. Note the **async booking model**: `POST /trips/{id}/confirm` returns `202`; observe completion via polling, SSE (`/trips/{id}/events`), or FCM push.
3. **Money is integer minor units + currency** — format on the client.
4. Send an **`Idempotency-Key`** (UUID) on every state-changing POST.

## For backend engineers

Read `docs/architecture/00-overview.md` → follow the section order. Implementation begins at **Phase 1 (MVP)** in `docs/architecture/18-roadmap.md`. The hard rule from the review: **every multi-write operation runs inside a single `prisma.$transaction`; external effects (Stripe/providers/queues) are recorded to the outbox in that same transaction and performed by workers afterward — so a failure rolls the whole local step back, and cross-system steps are made consistent by compensation.**
