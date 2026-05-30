# ASAP Backend

**ASAP — All-in-One Smart Attendance Platform.** A context-aware booking **orchestration** platform: book an event, and the system orchestrates transport + stay + payments + notifications around it as a single journey.

> **Current stage:** **Phase 1 (MVP) implemented** — the correctness backbone (saga, outbox, idempotency, double-entry ledger, Stripe manual-capture incl. the VOID sad path) is built and compiles. See `docs/architecture/18-roadmap.md` for what's in/out of Phase 1, and "Running locally" below.

## What's here

| Path | What it is |
|------|------------|
| **`API.md`** | **Frontend integration guide** — full v1 REST API reference (auth, trips, checkout, cancel/refund, errors, async booking model). Build your frontend/mocks against this now. |
| `docs/architecture/` | The 18-section **Architecture Review Document**. Start at `00-overview.md`. |
| `prisma/schema.prisma` | Canonical database schema (explained in `docs/architecture/08-prisma-postgres.md`). Migration in `prisma/migrations/0_init`. |
| `src/shared/` | Shared kernel: Prisma, Money VO, **Outbox + event bus**, **idempotency**, inbox dedupe, webhook receipts, config, queues, common (filters/guards/interceptors/correlation), health. |
| `src/modules/` | One folder per bounded context: `identity`, `trip` (saga), `event-booking`, `payments`, `provider-integration` (Ticketmaster ACL), `discovery`, `notifications`. |
| `src/main.ts` / `src/worker.ts` | API bootstrap / worker-only entrypoint (separate ECS services in prod). |
| `docker-compose.yml` | Local Postgres + Redis (cache + queue instances). |
| `test/` | E2E scaffold encoding the Phase-1 exit criteria (gated behind `RUN_E2E`). |

## Running locally (Phase 1)

```bash
cp .env.example .env                # fill STRIPE_SECRET_KEY (test) + TICKETMASTER_API_KEY when you have them
docker compose up -d                # Postgres + Redis (queue on :6379, cache on :6380)
npm install
npm run prisma:generate
npm run prisma:deploy               # applies prisma/migrations/0_init
npm run db:seed                     # chart of accounts (also auto-ensured at boot)
npm run start:dev                   # API + BullMQ workers in one process (Swagger at /api/v1/docs)
```

Try the flow (synthetic events work without a live Ticketmaster key — use eventId `TEST-1`; `FAIL-1` forces the VOID sad path):

```bash
# 1) register -> grab accessToken
curl -s localhost:3000/api/v1/auth/register -H 'content-type: application/json' \
  -d '{"email":"a@b.com","password":"password123","displayName":"Ada"}'
# 2) create a trip (anchor event)
curl -s localhost:3000/api/v1/trips -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H "idempotency-key: $(uuidgen)" \
  -d '{"anchor":{"eventId":"TEST-1","ticketTier":"GA","quantity":2}}'
# 3) checkout -> returns stripeClientSecret  (client confirms via Stripe.js)
# 4) confirm -> 202, then poll GET /trips/{id} or stream GET /trips/{id}/events
```

Quality gates: `npm run build` · `npm test` (unit) · `npm run lint` · `RUN_E2E=1 npm run test:e2e` (needs infra + Stripe test keys).

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
