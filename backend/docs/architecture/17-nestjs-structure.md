# Section 17 — Production NestJS Structure

## 17.1 Purpose & Design Goals

This section specifies the concrete NestJS source layout that realizes the ASAP modular monolith. The structure is not cosmetic: it is the mechanical enforcement layer for the Foundational Rules. Specifically, the directory boundaries and layer rules exist to make the following *physically hard to violate*:

| Foundational Rule | How the structure enforces it |
|---|---|
| R7: Prisma Client never reaches controllers | `PrismaService` is exported only into the `infrastructure` layer; the `interface` layer has no import path to it. ESLint boundary rules fail the build on violation. |
| R7: Services own tx boundaries | `$transaction` lives only in `application/` use-cases; repositories accept an optional `tx` handle but never open their own transaction for multi-write saga steps. |
| R2: No external call inside a DB tx | Provider/Stripe/BullMQ clients live in `infrastructure/adapters` and `infrastructure/queue`; lint rule forbids importing them from inside a `prisma.$transaction(...)` callback (enforced by review + a runtime guard described in 17.7). |
| R4: Outbox atomic publish | The shared `OutboxModule` exposes a repository that writes `platform.OutboxEvent` *inside the same `tx`* the use-case already holds. A separate relay processor publishes to BullMQ. |
| R8: Contexts never share tables / cross-context joins | Each module owns its Prisma schema namespace; cross-context calls go through **ports** (interfaces), never direct repository imports. This is the microservice cut-line. |
| R3: Idempotency everywhere | Shared `IdempotencyModule` guard + interceptor sits in `common/` and `platform/`. |

The four-layer Clean Architecture stack per module, with the dependency rule pointing **inward** (`interface → application → domain`, `infrastructure → application/domain`, and **`domain` depends on nothing**):

```
            ┌─────────────────────────────────────────────┐
            │  interface  (controllers, DTOs, mappers)     │  framework-aware, HTTP/SSE
            └───────────────┬─────────────────────────────┘
                            │ depends on
            ┌───────────────▼─────────────────────────────┐
            │  application (use-cases, owns $transaction,  │  orchestration, tx boundary
            │  command/query handlers, port consumers)     │
            └───────┬───────────────────────────┬─────────┘
                    │ depends on                 │ defines ports (interfaces)
            ┌───────▼─────────────┐    ┌─────────▼──────────────────────┐
            │  domain (entities,  │    │  infrastructure (Prisma repos, │
            │  VOs, state machines│◄───┤  provider adapters, BullMQ      │
            │  domain events,     │ impl│  processors, Redis) implements │
            │  PORTS - no fw deps)│ ports│  domain/application ports     │
            └─────────────────────┘    └────────────────────────────────┘
```

The key inversion: **ports are declared in `domain` (or `application`), implemented in `infrastructure`**. NestJS DI binds the implementation to the interface token at module-wire time. This is what makes a module microservice-ready: replace the in-process port implementation with an HTTP/gRPC client and nothing in `domain`/`application` changes.

## 17.2 Top-Level Directory Tree

```
backend/
├── prisma/
│   ├── schema.prisma                 # multi-schema: trip, booking, payment, provider, notify, platform, identity, discovery
│   └── migrations/
├── src/
│   ├── main.ts                       # bootstrap (helmet, ValidationPipe, versioning, swagger, graceful shutdown)
│   ├── app.module.ts                 # imports all context modules + shared modules
│   │
│   ├── shared/                       # SHARED KERNEL (platform.* + cross-cutting). NOT a bounded context of its own logic.
│   │   ├── prisma/
│   │   │   ├── prisma.module.ts       # @Global; exports PrismaService
│   │   │   ├── prisma.service.ts      # extends PrismaClient; onModuleInit/onModuleDestroy; $transaction helper
│   │   │   └── prisma.tx.ts           # Tx type alias = Prisma.TransactionClient
│   │   ├── outbox/
│   │   │   ├── outbox.module.ts
│   │   │   ├── outbox.repository.ts   # write OutboxEvent INSIDE caller's tx
│   │   │   ├── outbox-relay.processor.ts # BullMQ: poll/CDC -> publish -> mark dispatched
│   │   │   └── domain-event.envelope.ts  # canonical envelope type
│   │   ├── idempotency/
│   │   │   ├── idempotency.module.ts
│   │   │   ├── idempotency.guard.ts   # validates Idempotency-Key header (UUID)
│   │   │   ├── idempotency.interceptor.ts # replays stored response on key hit (platform.IdempotencyKey)
│   │   │   └── idempotency.repository.ts
│   │   ├── inbox/
│   │   │   └── processed-event.repository.ts  # platform.ProcessedEvent consumer dedupe
│   │   ├── webhook/
│   │   │   └── webhook-receipt.repository.ts   # platform.WebhookReceipt unique [source, externalEventId]
│   │   ├── money/
│   │   │   ├── money.vo.ts             # BigInt minor units + Char(3) currency; arithmetic; no float
│   │   │   └── currency.ts
│   │   ├── events/
│   │   │   ├── event-bus.port.ts       # DomainEventPublisher port (impl = OutboxRepository)
│   │   │   └── event-names.ts          # const map of canonical event types (trip.created, payment.authorized, ...)
│   │   ├── common/
│   │   │   ├── filters/all-exceptions.filter.ts   # standard error envelope {code,message,details,correlationId,retryable}
│   │   │   ├── interceptors/correlation.interceptor.ts
│   │   │   ├── interceptors/logging.interceptor.ts
│   │   │   ├── middleware/correlation.middleware.ts # correlationId / causationId propagation (AsyncLocalStorage)
│   │   │   ├── guards/jwt-auth.guard.ts
│   │   │   ├── guards/roles.guard.ts
│   │   │   ├── decorators/ (CurrentUser, Idempotent, ApiStandardErrors)
│   │   │   ├── pagination/cursor.ts
│   │   │   └── errors/domain-error.ts  # base error -> mapped to envelope by filter
│   │   ├── queue/
│   │   │   ├── bullmq.module.ts        # registers queues; connection = ElastiCache Redis
│   │   │   └── queues.ts               # queue name constants (saga, outbox-relay, notifications, provider-calls)
│   │   ├── tracing/                    # OpenTelemetry + correlation
│   │   └── config/
│   │       ├── config.module.ts        # @nestjs/config; schema-validated env; Secrets Manager loader
│   │       └── env.validation.ts       # zod/joi validation of env at boot
│   │
│   └── modules/                       # ONE FOLDER PER BOUNDED CONTEXT
│       ├── identity/
│       ├── trip/                      # CORE — saga / process manager
│       ├── event-booking/
│       ├── transport-booking/
│       ├── stay-booking/
│       ├── payments/                  # CORE
│       ├── provider-integration/      # generic ACL
│       ├── discovery/                 # read-only
│       └── notifications/
├── test/
├── eslint.config.mjs                  # import-boundary rules (no cross-context deep imports; no Prisma in interface)
└── package.json
```

> Note on `event-booking` / `transport-booking` / `stay-booking`: the foundation defines a single *Event/Transport/Stay Booking* bounded context. We split it into **three NestJS modules sharing one `booking` Prisma schema** for code locality and independent provider adapters, but they remain **one bounded context / one cut-line** — they may share the `booking.*` tables. Cross-context boundaries (to `trip`, `payment`, `provider`) remain strict no-join ports.

## 17.3 Per-Module Layout (canonical example: `trip` — the CORE saga context)

```
modules/trip/
├── trip.module.ts                     # wires layers; binds ports->impls; registers BullMQ saga processor
│
├── domain/                            # NO framework imports (no @nestjs/*, no @prisma/*)
│   ├── trip.aggregate.ts              # Trip aggregate root: TripLeg[], SagaState, version (optimistic lock), invariants
│   ├── trip-leg.entity.ts             # denormalized status + priceSnapshot projection
│   ├── saga-state.entity.ts           # step ∈ {AUTHORIZE_PAYMENT,RESERVE_EVENT,...,COMPENSATE,DONE}
│   ├── value-objects/
│   │   └── price-snapshot.vo.ts        # uses Money VO
│   ├── state-machines/
│   │   └── trip-status.machine.ts      # explicit TripStatus transitions; throws IllegalTransition
│   ├── events/                         # domain event factories (envelope payloads)
│   │   ├── trip-created.event.ts
│   │   ├── trip-booking-started.event.ts
│   │   ├── trip-partially-booked.event.ts
│   │   ├── trip-compensation-started.event.ts
│   │   └── trip-confirmed.event.ts
│   └── ports/                          # INTERFACES the application/infra must satisfy
│       ├── trip.repository.port.ts     # load/save Trip aggregate (with version check)
│       ├── saga-state.repository.port.ts
│       ├── payments.port.ts            # cross-context: authorize/capture/void/refund (LOGICAL ref, no FK, no join)
│       ├── event-booking.port.ts       # reserve/confirm/release event leg
│       ├── transport-booking.port.ts
│       └── stay-booking.port.ts
│
├── application/                        # owns $transaction; orchestrates; emits via outbox
│   ├── usecases/
│   │   ├── create-trip.usecase.ts
│   │   ├── add-leg.usecase.ts
│   │   ├── quote-trip.usecase.ts
│   │   ├── checkout-trip.usecase.ts    # creates PaymentIntent via payments.port (cross-tx, no external in DB tx)
│   │   ├── confirm-trip.usecase.ts     # returns 202; enqueues saga
│   │   └── cancel-trip.usecase.ts
│   ├── saga/
│   │   ├── trip-saga.process-manager.ts # the durable saga: drives SagaState.step; one $tx per step
│   │   └── compensation.policy.ts       # cancel-reservation-FIRST then refund ordering
│   ├── handlers/                        # consume domain events (idempotent via ProcessedEvent)
│   │   ├── on-payment-authorized.handler.ts
│   │   ├── on-booking-event-reserved.handler.ts
│   │   └── on-booking-event-failed.handler.ts
│   └── queries/
│       └── get-trip.query.ts            # read model for GET /trips/{id} (bypasses aggregate, projection)
│
├── infrastructure/
│   ├── persistence/
│   │   ├── prisma-trip.repository.ts    # implements trip.repository.port; wraps PrismaService; version check
│   │   ├── prisma-saga-state.repository.ts
│   │   └── mappers/trip.persistence-mapper.ts  # domain <-> trip.Trip row
│   ├── ports-out/                       # cross-context port IMPLEMENTATIONS (in-process today)
│   │   ├── payments.inprocess.adapter.ts  # calls PaymentsFacade exposed by payments module
│   │   ├── event-booking.inprocess.adapter.ts
│   │   └── ...  # swap to HTTP/gRPC client on extraction -> microservice-ready
│   └── queue/
│       └── trip-saga.processor.ts        # BullMQ worker -> invokes trip-saga.process-manager
│
└── interface/
    ├── trip.controller.ts                # REST /api/v1/trips...  (NO PrismaService import path)
    ├── trip-events.controller.ts         # SSE GET /trips/{id}/events
    ├── dto/
    │   ├── create-trip.dto.ts            # class-validator
    │   ├── add-leg.dto.ts
    │   ├── checkout.dto.ts
    │   └── confirm.dto.ts
    └── mappers/trip.http-mapper.ts        # domain/read-model -> response DTO
```

Every other context module follows the identical 4-folder shape. The `payments`, `event-booking`, etc. modules differ only in their aggregates, state machines, ports, and adapters.

## 17.4 How Prisma is Wrapped — and Never Reaches Controllers

`PrismaService` extends `PrismaClient` and is exported from a `@Global()` `PrismaModule`. The architectural rule is enforced on three levels:

1. **DI visibility**: `PrismaService` is injected only into classes under `infrastructure/persistence/*`. Controllers receive *use-cases*; use-cases receive *port tokens*; repositories receive `PrismaService`.
2. **Lint boundary**: `eslint-plugin-boundaries` (or `import/no-restricted-paths`) declares `interface` and `domain` layers may not import `shared/prisma/*` or `@prisma/client`. CI fails on violation.
3. **Type firewall**: controllers traffic only in DTOs and read-model view types — never `Prisma.*` types or domain aggregates.

```typescript
// shared/prisma/prisma.service.ts
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }
}

// shared/prisma/prisma.tx.ts
export type Tx = Prisma.TransactionClient;            // the per-tx client handed to repos
```

```typescript
// modules/trip/domain/ports/trip.repository.port.ts  (NO @prisma import here)
export const TRIP_REPOSITORY = Symbol('TRIP_REPOSITORY');
export interface TripRepositoryPort {
  // tx is optional: when present the write joins the caller's saga-step transaction
  findById(id: string, tx?: Tx): Promise<TripAggregate | null>;
  save(trip: TripAggregate, tx: Tx): Promise<void>;   // throws OptimisticLockError on version mismatch
}
```

```typescript
// modules/trip/infrastructure/persistence/prisma-trip.repository.ts
@Injectable()
export class PrismaTripRepository implements TripRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string, tx: Tx = this.prisma): Promise<TripAggregate | null> {
    const row = await tx.trip.findUnique({ where: { id }, include: { legs: true, sagaState: true } });
    return row ? TripPersistenceMapper.toDomain(row) : null;
  }

  async save(trip: TripAggregate, tx: Tx): Promise<void> {
    const data = TripPersistenceMapper.toPersistence(trip);
    // Optimistic concurrency (R10): version guard in the WHERE clause
    const res = await tx.trip.updateMany({
      where: { id: trip.id, version: trip.version },
      data: { ...data, version: { increment: 1 } },
    });
    if (res.count === 0) throw new OptimisticLockError('trip', trip.id, trip.version);
    // ... persist legs + sagaState within same tx
  }
}
```

The repository **never calls `this.prisma.$transaction`** for saga-step writes. It accepts the `tx` handle the *use-case* opened. A repo may use `$transaction` only for a self-contained single-aggregate write that is genuinely atomic and never part of a saga step.

## 17.5 Services Own the `$transaction` (one tx per saga step, no external calls inside)

The use-case is the **transaction boundary owner**. The pattern: read & decide → `$transaction { write aggregate + write outbox }` → after commit, the relay (separately) publishes; external network calls (Stripe/provider) happen in a *different* saga step entirely, never inside the tx.

```typescript
// modules/trip/application/usecases/confirm-trip.usecase.ts
@Injectable()
export class ConfirmTripUseCase {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TRIP_REPOSITORY) private readonly trips: TripRepositoryPort,
    private readonly outbox: OutboxRepository,
    @InjectQueue(QUEUES.SAGA) private readonly saga: Queue,
  ) {}

  // Returns 202; the heavy lifting runs in the saga worker.
  async execute(cmd: ConfirmTripCommand): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const trip = await this.trips.findById(cmd.tripId, tx);
      if (!trip) throw new TripNotFoundError(cmd.tripId);

      // Domain state machine enforces legal transition (PENDING_PAYMENT/PLANNING -> BOOKING)
      trip.startBooking();                       // throws IllegalTransition otherwise
      trip.sagaState.begin('AUTHORIZE_PAYMENT'); // first saga step

      await this.trips.save(trip, tx);           // version-checked write

      // R4: outbox write joins THE SAME tx -> atomic "state change + event"
      await this.outbox.append(tx, trip.pullDomainEvents()); // e.g. trip.booking.started
    });
    // R2: external/transport AFTER commit, never inside tx
    await this.saga.add('drive', { tripId: cmd.tripId }, { jobId: `trip-saga:${cmd.tripId}` });
  }
}
```

The saga process-manager advances one step per `$transaction`, and external calls (Stripe authorize, provider reserve) are made *between* transactions, persisting their result idempotently:

```typescript
// modules/trip/application/saga/trip-saga.process-manager.ts  (illustrative skeleton)
async driveStep(tripId: string): Promise<void> {
  const { trip, step } = await this.loadState(tripId);      // read-only tx

  switch (step) {
    case 'AUTHORIZE_PAYMENT': {
      // EXTERNAL CALL — OUTSIDE any DB tx, idempotent via persisted key (R2,R3)
      const result = await this.payments.authorize({
        paymentIntentId: trip.paymentIntentId,
        idempotencyKey: `trip:${tripId}:authorize`,
      });
      // then a SEPARATE tx: persist outcome + advance step + outbox(payment.authorized consequences)
      await this.prisma.$transaction(async (tx) => {
        const t = await this.trips.findById(tripId, tx);
        result.ok ? t.sagaState.advance('RESERVE_EVENT') : t.sagaState.fail();
        await this.trips.save(t, tx);
        await this.outbox.append(tx, t.pullDomainEvents());
      });
      break;
    }
    case 'RESERVE_EVENT': /* reserve via event-booking.port, then tx-advance */ break;
    // ... RESERVE_TRANSPORT, RESERVE_STAY, CAPTURE_PAYMENT, CONFIRM_LEGS
    case 'COMPENSATE': await this.compensation.run(tripId); break;  // cancel-reservation FIRST, then refund
  }
}
```

## 17.6 Outbox + Events Wired to BullMQ

The flow is **transactional outbox → relay processor → BullMQ → idempotent consumers**:

```
 use-case $tx ──► writes aggregate + platform.OutboxEvent (status=PENDING)   [atomic, R4]
                                   │  commit
                                   ▼
 outbox-relay.processor (BullMQ repeatable / Postgres LISTEN-NOTIFY)
   reads PENDING (FOR UPDATE SKIP LOCKED) ──► publishes to BullMQ topic queue ──► marks DISPATCHED
                                   │
                                   ▼
 consumer processors (per context)  ──► dedupe via platform.ProcessedEvent (insert unique eventId)
   if already processed -> ack & skip ; else handle in its own $tx ; record ProcessedEvent in same $tx
```

```typescript
// shared/outbox/outbox.repository.ts
@Injectable()
export class OutboxRepository {
  // Called INSIDE the use-case tx — same atomic unit as the aggregate write (R4)
  async append(tx: Tx, events: DomainEventEnvelope[]): Promise<void> {
    if (events.length === 0) return;
    await tx.outboxEvent.createMany({
      data: events.map((e) => ({
        eventId: e.eventId, eventType: e.eventType, eventVersion: e.eventVersion,
        aggregateType: e.aggregateType, aggregateId: e.aggregateId,
        correlationId: e.correlationId, causationId: e.causationId,
        tripId: e.tripId, userId: e.userId, payload: e.payload as Prisma.JsonObject,
        status: 'PENDING', occurredAt: e.occurredAt,
      })),
    });
  }
}
```

```typescript
// shared/outbox/outbox-relay.processor.ts  (illustrative)
@Processor(QUEUES.OUTBOX_RELAY)
export class OutboxRelayProcessor extends WorkerHost {
  async process(): Promise<void> {
    const batch = await this.prisma.$queryRaw/*sql*/`
      SELECT * FROM platform."OutboxEvent"
      WHERE status = 'PENDING' ORDER BY "occurredAt"
      FOR UPDATE SKIP LOCKED LIMIT 100`;                 // safe concurrent relay
    for (const ev of batch) {
      await this.bus.publishToQueue(ev.eventType, ev);   // -> BullMQ topic queue (at-least-once)
      await this.prisma.outboxEvent.update({ where: { eventId: ev.eventId }, data: { status: 'DISPATCHED' } });
    }
  }
}
```

Consumers are wired as per-context BullMQ processors under `application/handlers`; each opens its own `$transaction`, inserts `platform.ProcessedEvent (eventId UNIQUE)` first, and on unique-violation treats the message as a duplicate (at-least-once → effectively-once). The `notify.Notification` unique `[userId, templateId, dedupeKey]` provides the same idempotency at the sink.

## 17.7 Cross-Context Calls via Ports (the microservice cut-line)

A consuming context (`trip`) declares a **port** in its `domain/ports`. The producing context (`payments`) exposes a **thin facade** (a NestJS provider) that is the *only* public surface — its repositories, Prisma models, and aggregates stay private. The in-process adapter bridges them. **No cross-context Prisma join, no shared table, no FK** (R8); references are logical IDs (`paymentIntentId: string`).

```typescript
// modules/trip/domain/ports/payments.port.ts   (lives in trip's domain — depends on nothing)
export const PAYMENTS_PORT = Symbol('PAYMENTS_PORT');
export interface PaymentsPort {
  createIntent(input: { tripId: string; amount: Money; idempotencyKey: string }): Promise<{ paymentIntentId: string }>;
  authorize(input: { paymentIntentId: string; idempotencyKey: string }): Promise<AuthorizeResult>;
  capture(input: { paymentIntentId: string; amount: Money; idempotencyKey: string }): Promise<CaptureResult>;
  void(input: { paymentIntentId: string; idempotencyKey: string }): Promise<void>;
}
```

```typescript
// modules/payments/payments.facade.ts  (the ONLY thing payments exports to AppModule)
@Injectable()
export class PaymentsFacade implements PaymentsPort { /* delegates to payments use-cases */ }

// modules/trip/infrastructure/ports-out/payments.inprocess.adapter.ts
@Injectable()
export class PaymentsInProcessAdapter implements PaymentsPort {
  constructor(private readonly payments: PaymentsFacade) {}    // today: direct DI
  // tomorrow: swap PaymentsFacade for PaymentsHttpClient — trip's domain/application UNCHANGED.
}
```

Binding in the module:

```typescript
// modules/trip/trip.module.ts
@Module({
  imports: [PaymentsModule /* exports only PaymentsFacade */, BookingModule, SharedQueueModule],
  controllers: [TripController, TripEventsController],
  providers: [
    ConfirmTripUseCase, /* ...other use-cases, saga PM, handlers... */
    { provide: TRIP_REPOSITORY,  useClass: PrismaTripRepository },
    { provide: PAYMENTS_PORT,    useClass: PaymentsInProcessAdapter },
    { provide: EVENT_BOOKING_PORT, useClass: EventBookingInProcessAdapter },
    TripSagaProcessor,
  ],
})
export class TripModule {}
```

**Microservice-ready boundary.** Because every cross-context call is a port + logical-ID reference (never a join, never a shared row), extracting `payments` into its own service is a *mechanical* operation:

| Concern | Monolith today | After extraction |
|---|---|---|
| Cross-context call | `PaymentsInProcessAdapter` → `PaymentsFacade` (DI) | `PaymentsHttpAdapter` → REST/gRPC client |
| Events | BullMQ on shared Redis, single outbox relay | per-service outbox + broker (SNS/SQS or Kafka); same envelope |
| Data | `payment.*` schema in same RDS | own database; logical IDs unchanged (no FK to break) |
| Idempotency | `payment.PaymentIntent` idempotency key | identical key contract over the wire |
| Domain / application code | unchanged | unchanged |

The cut-lines are exactly the bounded-context module folders. ESLint forbids any deep import across `modules/<a>/...` from `modules/<b>/...` except the public facade barrel (`modules/<b>/index.ts` exporting only the facade + port types + DTOs) — so an accidental cross-context coupling cannot compile.

A small **runtime guard** complements lint for R2: the `PrismaService.$transaction` wrapper sets an `AsyncLocalStorage` flag `inTransaction=true`; the provider/Stripe/BullMQ client wrappers assert `inTransaction === false` and throw `ExternalCallInsideTransactionError` if violated in any environment. This converts a silent latent deadlock-risk into a loud test failure.

## 17.8 `main.ts` Bootstrap

```typescript
// src/main.ts
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });

  app.use(helmet());                                   // security headers
  app.enableCors({ origin: config.allowedOrigins, credentials: true });

  app.setGlobalPrefix('api');                          // /api/...
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });  // -> /api/v1

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true, forbidNonWhitelisted: true, transform: true,
    transformOptions: { enableImplicitConversion: false },
  }));
  app.useGlobalFilters(new AllExceptionsFilter());     // standard error envelope {code,message,details,correlationId,retryable}
  app.useGlobalInterceptors(new CorrelationInterceptor(), new LoggingInterceptor());

  app.enableShutdownHooks();                           // OnModuleDestroy -> Prisma $disconnect, BullMQ drain
  app.set('trust proxy', 1);                           // behind API Gateway / ALB

  if (config.swaggerEnabled) {                         // disabled in prod or behind auth
    const doc = new DocumentBuilder()
      .setTitle('ASAP API').setVersion('1').addBearerAuth().build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc));
  }

  const server = await app.listen(config.port);
  server.keepAliveTimeout = 65_000;                    // > ALB idle timeout to avoid 502s

  // Graceful shutdown for ECS/Fargate SIGTERM (RTO<=30min, zero-drop deploys)
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, async () => {
      await app.close();                               // stops accepting, drains in-flight, closes BullMQ workers + Prisma
      process.exit(0);
    });
  }
}
bootstrap();
```

**Graceful shutdown reasoning.** On Fargate task replacement, ECS sends `SIGTERM` then waits `stopTimeout` before `SIGKILL`. `app.close()` (via `enableShutdownHooks`) stops the HTTP listener, lets the `ValidationPipe`/health probe flip `/health/ready` to draining (so the ALB deregisters), drains in-flight HTTP requests, and closes BullMQ workers so a half-processed saga step is *not* killed mid-`$transaction`. Because saga steps are durable (each commit advances `SagaState.step`) and the queue redelivers, an interrupted worker simply resumes the step on the next task — combined with idempotency this gives at-least-once-but-effectively-once execution across deploys (RPO ≤ 5min via RDS, RTO ≤ 30min).

`/health/live` returns process liveness only; `/health/ready` checks Prisma `SELECT 1`, Redis ping, and the draining flag — wiring directly to the NFR 99.9% availability and the rolling-deploy story.

## 17.9 Layer Dependency Rules (enforced)

| From ↓ / May import → | domain | application | infrastructure | interface | shared/common | shared/prisma | @prisma/client | @nestjs/* |
|---|---|---|---|---|---|---|---|---|
| **domain** | ✓ | ✗ | ✗ | ✗ | Money/errors only | ✗ | ✗ | ✗ |
| **application** | ✓ | ✓ | ✗ (ports only) | ✗ | ✓ | ✗ | ✗ | DI decorators only |
| **infrastructure** | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ |
| **interface** | view types | ✓ (use-cases) | ✗ | ✓ | ✓ | ✗ | ✗ | ✓ |

The two load-bearing prohibitions: **`domain` imports no framework** (keeps the model pure and portable to a microservice), and **`interface` imports no Prisma** (R7). Both are CI-enforced via `import/no-restricted-paths`; a violation is a build break, not a review comment.

## 17.10 Summary of Architectural Decisions

| Decision | Rationale | Alternative rejected | Tradeoff accepted |
|---|---|---|---|
| 4-layer Clean Architecture per module | Makes R7/R2/R8 mechanically enforceable; domain stays pure & extractable | Anemic service+controller layering | More boilerplate (mappers, ports) — paid back at microservice extraction |
| Ports in `domain`, impls in `infrastructure` (DI inversion) | Cross-context coupling becomes a swappable adapter → microservice-ready | Direct repository imports across contexts | Indirection / token wiring overhead |
| One bounded context = booking, three NestJS modules | Code locality + per-provider adapters without splitting the cut-line | Three separate contexts (would forbid shared `booking.*` tables) | Slightly looser module boundary inside one context |
| Use-case owns `$transaction`; repos accept `tx` | R2/R4: atomic aggregate+outbox write, no nested tx, no external call inside | Repository-managed transactions | Use-cases must thread `tx` explicitly |
| Transactional outbox + relay → BullMQ | R4 atomic publish; survives broker outage; at-least-once | Publish directly after commit (dual-write hazard) | Relay latency (ms–sec) + eventual consistency |
| Runtime `inTransaction` guard | Turns R2 violations into loud failures, not latent prod deadlocks | Lint-only | Tiny per-call ALS overhead |
| Facade-only barrel exports + lint boundaries | Cut-lines can't be violated by accident; clean extraction | Trusting convention | CI must run boundary lint |

The net effect: the directory structure *is* the enforcement of the Foundational Rules. A developer attempting to inject `PrismaService` into a controller, join across `payment.*` and `trip.*`, call Stripe inside a `$transaction`, or import another context's repository will hit a failing build — not a runtime surprise in production during a provider outage.
