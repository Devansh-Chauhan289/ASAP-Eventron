# Section 15 — AWS Infrastructure Architecture

This section specifies the runtime topology for ASAP on AWS. The guiding principle is that **PostgreSQL is the system of record** and everything else (Redis, BullMQ, providers, Stripe) is derived/transport. Infrastructure is therefore designed so that the saga engine, outbox drain, and double-entry ledger always have a durable, highly-available Postgres to write to, while compute and transport layers can fail, scale, and recover independently without compromising **payment correctness (100%)** or the **durable saga** guarantee.

Non-negotiable NFR targets driving every sizing decision below: ~20 TPS sustained / ~200 TPS peak, read p95 < 200ms, 99.9% availability, **RPO ≤ 5 min / RTO ≤ 30 min**, PCI SAQ-A (no card data ever touches ASAP compute — Stripe Elements client-side only).

---

## 15.1 Design Principles & Why This Shape

| Principle | Infra consequence |
|---|---|
| Postgres = system of record | RDS Multi-AZ is the only stateful component whose loss is unrecoverable within RPO; everything else is rebuildable. Backups/PITR are the DR keystone. |
| No external call inside a DB tx (Rule 2) | API tasks are short-lived/latency-bound; saga external I/O (Stripe/provider) happens in **worker** tasks. This dictates the **api vs worker** split so I/O-bound retry storms never starve HTTP request threads. |
| Outbox publish atomicity (Rule 4) | An **outbox-relay worker** polls `platform.OutboxEvent` and pushes to BullMQ. It must be HA but singleton-safe (advisory-locked) — infra must support graceful drain so in-flight relay isn't lost. |
| At-least-once delivery; idempotent consumers | Workers can be killed/replaced freely (Fargate spot-friendly for non-critical queues); duplicates are absorbed by `platform.ProcessedEvent`. |
| Money = ledger source of truth | RDS is the trust anchor; reconciliation jobs run against the **read replica** to avoid loading the primary. |
| Bounded contexts microservice-ready (Rule 8) | One ECS cluster today, but services/queues are partitioned so a context (e.g. Payments) can be peeled into its own task definition + DB later with zero code change to the cut-line. |

---

## 15.2 Network Topology (VPC)

```
                         Internet
                            │
                    ┌───────┴────────┐
                    │  Route 53      │ (latency / failover records)
                    └───────┬────────┘
                            │
                    ┌───────┴────────┐   WebACL (rate, SQLi, geo, bot)
                    │  AWS WAF        │◄──────────────┐
                    └───────┬────────┘                │
                            │                         │
                ┌───────────┴────────────┐            │
                │  API Gateway (REST)     │  request validation, throttling,
                │  + usage plans / keys   │  Idempotency-Key passthrough
                └───────────┬────────────┘
                            │ VPC Link (private integration)
   ===========================================================  VPC 10.0.0.0/16
   │                        │                                  │
   │   AZ-a                 │                 AZ-b             │   AZ-c (quorum)
   │ ┌─────────────┐  ┌─────┴───────┐   ┌─────────────┐       │
   │ │ public sub  │  │ Internal ALB│   │ public sub  │       │
   │ │  NAT GW     │  │ (cross-AZ)  │   │  NAT GW     │       │
   │ └─────┬───────┘  └─────┬───────┘   └─────┬───────┘       │
   │       │                │                 │               │
   │ ┌─────┴───────────────┴─────────────────┴────────┐      │
   │ │  PRIVATE APP SUBNETS  (Fargate ENIs)            │      │
   │ │   svc:api  (HTTP)        svc:worker-* (BullMQ)  │      │
   │ └─────┬───────────────────────────┬──────────────┘      │
   │       │ RDS Proxy endpoint        │ Redis endpoints      │
   │ ┌─────┴───────────────────────────┴──────────────┐      │
   │ │  PRIVATE DATA SUBNETS (no NAT, no IGW route)    │      │
   │ │  RDS Proxy → RDS Postgres (Multi-AZ primary)    │      │
   │ │              └ read replica (AZ-b)              │      │
   │ │  ElastiCache: redis-cache (cluster mode)        │      │
   │ │  ElastiCache: redis-queue (Multi-AZ, 1 shard)   │      │
   │ └────────────────────────────────────────────────┘      │
   │                                                          │
   │  VPC Endpoints (Gateway: S3, DynamoDB; Interface:        │
   │  Secrets Manager, ECR, CloudWatch Logs, KMS, STS)        │
   ===========================================================
                            │ NAT (egress only)
                  Stripe API · FCM · SendGrid · Ticketmaster/Amadeus/Uber/...
```

**Subnet tiers (3 AZs):**

| Tier | Routing | Contents |
|---|---|---|
| Public | IGW + hosts NAT GW | ALB optional public face (we keep ALB internal; API Gateway is the only ingress), NAT gateways (one per AZ for AZ-fault isolation). |
| Private-app | Egress via NAT only | Fargate ENIs for `api` and `worker-*`. |
| Private-data | **No NAT, no IGW** | RDS Proxy, RDS, both ElastiCache clusters. Reachable only from app SG. |

**Why API Gateway → VPC Link → internal ALB → Fargate** (not a public ALB): a single managed ingress chokepoint for WAF, throttling, request schema validation, and API keys. The ALB stays internal so Fargate tasks have no public exposure — the only paths in are Gateway (north-south) and intra-VPC (east-west).

**VPC interface endpoints** for Secrets Manager, ECR, KMS, STS, CloudWatch, plus an **S3 gateway endpoint**: keeps secrets/image/log/object traffic off the NAT path. This (a) cuts NAT data-processing cost materially at 200 TPS, (b) removes a NAT outage from the blast radius of "can I read my DB password / pull my image", and (c) tightens PCI posture (control-plane traffic never leaves AWS network).

**Security groups (least privilege, SG-to-SG, no CIDR):**

| SG | Inbound | Outbound |
|---|---|---|
| `sg-alb` | 443 from API Gateway VPC Link ENIs | 8080 → `sg-app` |
| `sg-app` | 8080 from `sg-alb` (api only) | 5432 → `sg-proxy`; 6379 → `sg-redis`; 443 → NAT (Stripe/providers/FCM/SendGrid) + VPC endpoints |
| `sg-proxy` | 5432 from `sg-app` | 5432 → `sg-rds` |
| `sg-rds` | 5432 from `sg-proxy` only | — |
| `sg-redis` | 6379 from `sg-app` | — |

Workers do **not** accept inbound 8080 (no ALB target) — they are pure BullMQ consumers reaching Redis + RDS Proxy + NAT egress.

---

## 15.3 Compute — ECS/Fargate

### 15.3.1 Service decomposition (api vs workers)

We split HTTP serving from background processing into **separate ECS services on a shared cluster**, because their load profiles, failure modes, and scaling signals are fundamentally different:

| Concern | `svc:api` | `svc:worker-*` |
|---|---|---|
| Workload | Latency-bound HTTP (p95<200ms reads, fast 202 on confirm) | I/O-bound saga steps: Stripe authorize/capture, provider reserve/confirm, outbox relay, notifications |
| Scaling signal | CPU + ALB request count per target | **BullMQ queue depth / oldest-job-age** (target tracking via custom CloudWatch metric) |
| Failure tolerance | Must stay up for ingress | Killable; at-least-once + `ProcessedEvent` dedupe absorbs restarts |
| Deploy risk | User-facing | Background; can drain longer |
| Spot eligibility | On-demand (predictable) | Capacity-provider mix (FARGATE + FARGATE_SPOT) for non-payment queues |

A monolithic combined service was rejected: a retry storm against a degraded provider (circuit half-open, backoff) would consume CPU/event-loop and degrade HTTP p95, violating the read SLO. Splitting isolates the blast radius.

### 15.3.2 Worker queue partitioning

BullMQ queues map to bounded-context concerns; we run **multiple worker services** so a slow/poisoned queue can't head-of-line-block a critical one, and so each scales/secures independently:

| Worker service | Queues consumed | Capacity provider | Notes |
|---|---|---|---|
| `worker-saga` | trip saga steps (AUTHORIZE_PAYMENT, RESERVE_*, CAPTURE_PAYMENT, CONFIRM_LEGS, COMPENSATE) | FARGATE (on-demand) | Touches Payments + ledger; **never** spot. Concurrency tuned low per task to bound DB connections. |
| `worker-provider` | provider ACL reserve/confirm/release calls | FARGATE + SPOT mix | Rate-limited/circuit-broken; idempotent via `provider.ProviderRequest`. |
| `worker-payment` | Stripe webhook-driven jobs, refunds, reconciliation | FARGATE | Money correctness; on-demand only. |
| `worker-notify` | FCM/SendGrid dispatch | FARGATE_SPOT-heavy | Dedupe via `notify.Notification` unique key. |
| `worker-outbox-relay` | polls `platform.OutboxEvent` → enqueues | FARGATE (min 2 tasks) | **Singleton-safe via Postgres advisory lock** per partition, not via single task. HA without double-publish. |

> The outbox relay must be HA (≥2 tasks across AZs) yet not double-publish. Achieved with `pg_try_advisory_xact_lock` over a sharded key inside the polling tx — multiple tasks coexist, only the lock-holder drains a given shard. At-least-once is acceptable downstream (consumer dedupe), so a relay failover that re-emits a batch is safe.

### 15.3.3 Task sizing (initial; tune via load test)

| Service | vCPU / Mem | Min / Max tasks | Per-task concurrency | DB conns/task |
|---|---|---|---|---|
| `api` | 0.5 vCPU / 1 GB | 3 / 30 | Node event loop (no per-req thread) | 5 (pool) |
| `worker-saga` | 1 vCPU / 2 GB | 2 / 12 | 4 jobs | 6 |
| `worker-provider` | 0.5 vCPU / 1 GB | 2 / 20 | 8 jobs | 4 |
| `worker-payment` | 0.5 vCPU / 1 GB | 2 / 8 | 4 jobs | 5 |
| `worker-notify` | 0.25 vCPU / 0.5 GB | 1 / 10 | 16 jobs | 3 |
| `worker-outbox-relay` | 0.25 vCPU / 0.5 GB | 2 / 4 | poll batch 200 | 3 |

DB-connection budgeting is deliberate: **sum of (max tasks × conns/task)** must sit under the RDS Proxy / Postgres `max_connections` ceiling (see 15.4). At max fan-out this is ~30×5 + 12×6 + 20×4 + 8×5 + 10×3 + 4×3 ≈ 424 backend conns — which is exactly why **RDS Proxy multiplexing** (15.4.2) is mandatory rather than optional; without it, autoscaling would exhaust Postgres connections and cause a correctness-threatening outage precisely under peak load.

### 15.3.4 Autoscaling policy

```
api:            TargetTracking CPU=60%  AND  ALBRequestCountPerTarget≈80 rps/task
                step-out fast (60s cooldown), step-in slow (300s)
worker-saga:    TargetTracking custom metric  "queue.waiting / runningTasks" → target 50
                + backstop CPU=70%
worker-provider/payment/notify: queue-depth target tracking per queue
worker-outbox-relay: fixed 2 (lock-bounded); scale only if relay-lag alarm fires
```

Queue-depth target tracking (not just CPU) is essential: a worker blocked on a slow Stripe/provider call is **I/O-idle (low CPU) but backlogged**. CPU-only scaling would never add capacity while the queue grows — the visible symptom users feel (slow confirm → CONFIRMED) is queue age, not CPU. We publish `oldestJobAgeSeconds` and `waitingCount` per queue to CloudWatch from the workers and target-track on them.

**Scale-in protection** during deploy + a queue-drain guard prevent ECS from killing a task mid-job. Combined with BullMQ's `lockDuration`/stalled-job recovery, a killed worker's in-flight job is re-delivered and re-absorbed idempotently.

### 15.3.5 Deployment strategy

- **`api`: Blue/Green via CodeDeploy** (ECS Blue/Green). New task set gets a test listener; we run health + smoke (auth, events/search, GET /trips/{id}) against green, shift traffic 10%→100% with CloudWatch alarm rollback (5xx rate, p95 latency, target health). Justification: api is user-facing and the 202-async contract means a bad deploy can silently strand confirmations — instant rollback matters more than deploy speed.
- **`worker-*`: Rolling** (`minHealthyPercent=100`, `maxPercent=200`) with **graceful drain**. Workers are not behind a listener, so blue/green adds little; rolling with drain is cheaper and sufficient because idempotency makes mid-flight restarts safe.

**Graceful drain contract (critical):**

```
SIGTERM received (ECS stopTimeout = 120s)
  → api:    ALB deregistration delay 30s; stop accepting new conns; finish in-flight HTTP; close DB pool
  → worker: BullMQ worker.close(); stop pulling NEW jobs; let ACTIVE jobs finish (or hit lockDuration);
            flush outbox-relay current batch under advisory lock; then exit
```

`stopTimeout` (120s) > longest single saga-step external call budget so we don't orphan an in-flight Stripe authorize. Anything exceeding the window is safe anyway — idempotency keys (`platform.IdempotencyKey`, `provider.ProviderRequest` unique [provider, idempotencyKey], PaymentIntent idempotency) guarantee re-execution does not double-charge or double-reserve.

---

## 15.4 RDS PostgreSQL

### 15.4.1 Topology & sizing

| Attribute | Choice | Reasoning |
|---|---|---|
| Engine | PostgreSQL 16, single instance | Prisma-only ORM; advisory locks + `SKIP LOCKED` for outbox/saga claim. |
| HA | **Multi-AZ instance** (standby in 2nd AZ, sync replication) | Automatic failover ~60–120s satisfies RTO≤30m with margin; sync standby ⇒ zero committed-data loss on AZ failure (protects ledger). |
| Primary class | `db.r6g.xlarge` (4 vCPU / 32 GB) start; vertical headroom to `r6g.2xlarge` | 20 TPS sustained is modest; the constraint is **connection count + ledger write contention**, not raw throughput. Memory-optimized keeps working set/indexes hot. |
| Storage | gp3, **storage autoscaling** enabled (cap e.g. 1 TB), provisioned IOPS/throughput as needed | Avoids emergency resize; gp3 decouples IOPS from size. |
| Read replica | 1 in-region async replica | Serves **Discovery read paths + reporting/reconciliation**; never serves payment/saga reads (replica lag must not influence money decisions). |

**Multi-AZ instance (not Multi-AZ Cluster) initial choice:** simplest failover semantics with a single writer; the saga and ledger want one authoritative writer. Multi-AZ Cluster (2 readable standbys) is the documented upgrade path if read load on the primary becomes the bottleneck.

### 15.4.2 Connection pooling — RDS Proxy

Mandatory, for the reason quantified in 15.3.3: autoscaled Fargate fan-out produces hundreds of would-be Postgres connections; each Postgres backend is a process (~10 MB+), and `max_connections` on an r6g.xlarge is ~1.5–2k but practical headroom is far lower.

| | RDS Proxy | PgBouncer sidecar |
|---|---|---|
| Mgmt | Managed, Multi-AZ, IAM auth, Secrets-Manager integrated, auto-rotation aware | Self-run, must HA it yourself |
| Failover | Holds client conns across RDS failover (faster app recovery) | None |
| Decision | **RDS Proxy** | Rejected (op burden) |

**Transaction-pinning caveat — explicitly engineered around:** Prisma's per-saga-step `$transaction` (Rule 2) plus session-level constructs (advisory locks, prepared statements) can *pin* a Proxy connection for the tx duration, reducing multiplexing benefit. Mitigations: keep saga-step txns short (no external I/O inside — Rule 2 already guarantees this), prefer `pg_try_advisory_xact_lock` (xact-scoped, released at commit) over session locks, and budget the pool so pinned-worst-case still fits. App-side Prisma pool stays small (`connection_limit` 5–6/task) so the Proxy isn't the only backstop.

### 15.4.3 Parameter group tuning (highlights)

| Param | Direction | Why |
|---|---|---|
| `max_connections` | sized to Proxy backend budget (~450 + ops headroom) | match 15.3.3 budget |
| `idle_in_transaction_session_timeout` | e.g. 15s | kill a saga step that wedged a tx open (protects against leaked locks blocking ledger writes) |
| `statement_timeout` | e.g. 10s (api), higher for reporting role | bound runaway queries |
| `lock_timeout` | e.g. 3s | fail fast on hot-row contention (Trip/PaymentIntent optimistic version rows) rather than pile up |
| `log_min_duration_statement` | 500ms | slow-query visibility into CloudWatch |
| autovacuum (per-table) | aggressive on `OutboxEvent`, `ProcessedEvent`, `SagaState` | these are high-churn insert/delete tables; bloat there directly hurts relay/saga latency |

### 15.4.4 Backups, PITR, DR (RPO≤5min)

- **Automated backups** + **transaction log archiving** ⇒ Point-In-Time Recovery to any second within retention. WAL shipping interval keeps effective RPO **well under 5 min**; sync Multi-AZ standby makes single-AZ-failure RPO effectively **0**.
- Retention: 14–35 days. Daily snapshot copied **cross-region** (KMS-encrypted) for regional DR.
- RTO≤30m honored by: Multi-AZ auto-failover (~min) for the common case; cross-region restore-from-snapshot runbook for the regional-disaster case (slower but within 30m for our data size; rehearsed quarterly).
- **PITR is the recovery tool for logical corruption** (a bad migration / poison saga) that Multi-AZ can't fix (it replicates the corruption). This is why backups, not just HA, are load-bearing for "payment correctness 100%."

---

## 15.5 ElastiCache Redis — Two Clusters, Deliberately

The cache and the queue have **opposite eviction requirements**, so they cannot share a cluster:

| Cluster | Mode | maxmemory-policy | Multi-AZ | Purpose |
|---|---|---|---|---|
| `redis-cache` | **Cluster mode ON** (sharded) | `allkeys-lru` | yes, auto-failover | Discovery search/recommendation cache, events/{id}, hot read p95<200ms. Evicting cold keys is *correct*. |
| `redis-queue` | Cluster mode OFF (single shard, primary+replica) | **`noeviction`** | yes, auto-failover | BullMQ jobs, idempotency-adjacent locks, rate-limit + circuit-breaker state. Evicting a queued job = **lost saga work** = unacceptable. |

**Why this is a hard split, not a tuning knob:** a single cluster with `allkeys-lru` would silently evict BullMQ job keys under memory pressure → orphaned saga steps with no Postgres trace until a timeout; a single cluster with `noeviction` would OOM-reject cache writes and break Discovery. The eviction policy is per-cluster, so two clusters is the only correct answer.

- `redis-queue` is **single-shard on purpose**: BullMQ semantics (atomic multi-key Lua, blocking pops) assume a single keyspace; cluster-mode sharding would split queue keys across slots and break atomicity. HA comes from a replica + Multi-AZ failover, not sharding. Vertical scaling + queue partitioning (15.3.2) handles throughput; at ~200 TPS the queue is nowhere near a single-node ceiling.
- `redis-cache` is **cluster-mode** so it scales horizontally with Discovery traffic and tolerates a shard loss gracefully (only a cache slice is cold, repopulated from RDS read replica).
- **Encryption** in-transit (TLS) + at-rest (KMS) on both. AUTH token in Secrets Manager.
- **Failure stance:** Redis is *transport/derived* (Rule 1). A full `redis-queue` loss is a P1 but **not data loss** — outbox + SagaState in Postgres are the durable truth; on Redis recovery, a reconciliation sweep re-enqueues outbox events not yet marked dispatched and re-claims saga steps. We never trust Redis for anything money- or state-authoritative.

---

## 15.6 S3 — Tickets, Receipts, Exports

| Bucket | Contents | Access | Lifecycle |
|---|---|---|---|
| `asap-tickets` | provider ticket PDFs/QRs (post-CONFIRMED/FULFILLED) | private; **presigned GET** to users, short TTL (e.g. 5 min) | Standard → Standard-IA 30d → **Glacier** 180d |
| `asap-receipts` | payment receipts, ledger statements | private; presigned, audit-logged | IA 90d → Glacier 365d; retained per finance policy |
| `asap-exports` | reporting/CSV exports (from read replica) | private; presigned to admins | expire 30d |

- **SSE-KMS** on all buckets (CMK per data class; tickets/receipts may contain PII). Bucket policy denies non-TLS and non-KMS puts; **Block Public Access** on at account level.
- **Presigned URLs** mean Fargate never proxies large objects (no bandwidth/event-loop cost) and users get time-boxed, revocable access — the receipt/ticket links delivered via Notifications are presigned, not public.
- Versioning + MFA-delete on `asap-receipts` (immutability for financial artifacts; aligns with ledger-as-truth). Access via the **S3 gateway VPC endpoint** (no NAT cost, no internet path).

---

## 15.7 API Gateway, WAF, Edge Controls

| Control | Configuration | Rationale |
|---|---|---|
| Ingress | API Gateway (REST) → VPC Link → internal ALB → `svc:api` | single managed front door; ALB never public |
| WAF (WebACL) | AWS managed rules (common, SQLi, known-bad-inputs), **rate-based rule** per-IP, optional geo/bot control | abuse/DDoS absorption before it reaches Fargate; protects the saga from synthetic confirm spam |
| Throttling | Per-method + per-key usage plans; burst/steady limits sized to ~200 TPS peak with headroom | protects RDS/Redis from traffic spikes; returns 429 (retryable=true in error envelope) |
| Request validation | JSON Schema validation on bodies; require `Idempotency-Key` (UUID) header on state-changing POSTs (/trips, /legs, /quote, /checkout, /confirm, /cancel, refunds) | reject malformed/abusive requests at the edge; enforce the idempotency contract before code runs |
| Webhooks | `/webhooks/stripe`, `/webhooks/providers/{provider}` exempt from JWT but **signature-verified in-app**; recorded in `platform.WebhookReceipt` (unique [source, externalEventId]) for dedupe | webhooks are unauthenticated-by-design but must be idempotent + verified |
| Auth | Bearer JWT (15m access + rotating refresh); Gateway can do JWT authorizer pre-check, app re-validates | defense in depth |
| SSE | `/trips/{id}/events` — long-lived; configure Gateway/ALB idle timeout > heartbeat interval | async-confirm polling alternative must not be killed by idle timeout |

Throttling + WAF rate rules are the **traffic-spike and abuse defense** the NFRs demand (survive duplicate requests, abuse, spikes): they shed load at the cheapest layer so autoscaling handles legitimate growth, not attacks.

---

## 15.8 Secrets Manager

| Secret | Rotation | Consumer |
|---|---|---|
| RDS master + app DB creds | **Automatic** (Lambda rotation), RDS Proxy integrated | Proxy/app fetch at task start via VPC endpoint |
| Stripe secret + webhook signing keys | Manual/scheduled rotation runbook | `worker-payment`, webhook handler |
| Provider API keys (Ticketmaster, Amadeus, Uber, …) | Per-provider rotation cadence | `worker-provider` ACL adapters |
| Redis AUTH, FCM service account, SendGrid key, JWT signing keys | scheduled | respective modules |

- Tasks read secrets via **task execution role** + Secrets Manager **interface VPC endpoint** — secrets never in env files, images, or NAT path.
- JWT signing key rotation supports the rotating-refresh-token scheme; old key kept in a verify-set during overlap so in-flight tokens validate.
- IAM: per-service task roles scoped to exactly the secrets they need (api can't read Stripe keys; only `worker-payment` can). Least privilege = smaller PCI/abuse blast radius.

---

## 15.9 Observability — CloudWatch

**Logs:** structured JSON to CloudWatch Logs via the `awslogs`/FireLens driver, every line carrying `correlationId` / `causationId` / `tripId` (from the domain-event envelope) for end-to-end saga tracing across api → outbox-relay → worker → provider. Log-metric filters surface error codes.

**Key metrics & alarms:**

| Metric | Alarm threshold | Why it matters |
|---|---|---|
| `OutboxRelayLagSeconds` (newest undispatched event age) | > 60s | outbox is the publish-atomicity backbone; lag = events stuck, saga stalling |
| `SagaStepAge` per step / `SagaState` in COMPENSATE | sustained growth / spike | compensation storms, stuck trips → NEEDS_ATTENTION |
| BullMQ `waiting` / `oldestJobAge` per queue | per-queue | drives autoscaling AND on-call alerting |
| `payment.failed` / void rate, refund `FAILED_NEEDS_ATTENTION` | any spike | money-correctness early warning |
| `provider.CircuitState` open count | open > N | provider outage in progress; expect PARTIALLY_BOOKED / compensation |
| RDS: CPU, freeable mem, **read/write IOPS, replica lag, DB conns, deadlocks** | conns>80% Proxy budget; replica lag>30s | connection exhaustion + stale-read protection |
| RDS Proxy: pinned connections, borrow latency | rising | tx-pinning regression detection |
| API: 5xx rate, p95 latency, 429 rate | p95>200ms reads; 5xx>1% | SLO + deploy auto-rollback signal |
| `WebhookReceipt` dup rate, Stripe webhook signature failures | spike | replay/abuse detection |

**Dashboards:** (1) Saga health (step ages, COMPENSATING/NEEDS_ATTENTION counts, outbox lag), (2) Payments/ledger (auth→capture→refund funnel, double-entry balance check job result), (3) Infra (RDS/Redis/Fargate utilization + autoscaling activity), (4) Edge (Gateway/WAF throttles, 4xx/5xx).

**Health endpoints** wired to ALB target health + deploy alarms: `/health/live` (process up) vs `/health/ready` (RDS Proxy reachable, `redis-queue` reachable, migrations applied) — readiness gates traffic and blue/green shifts.

---

## 15.10 Infrastructure as Code

- **AWS CDK (TypeScript)** chosen to match the Node/TS stack — one language across app and infra, typed constructs, easy to express the api-vs-worker service pattern and per-queue worker services as reusable L3 constructs. (Terraform is a valid alternative; CDK wins on team-stack cohesion and testability via `cdk synth` snapshot tests.)
- **Stack decomposition** mirrors bounded contexts / lifecycle: `NetworkStack` (VPC/subnets/endpoints/SGs), `DataStack` (RDS+Proxy+replica, both Redis clusters, S3, KMS), `SecretsStack`, `ComputeStack` (cluster, task defs, services, autoscaling, CodeDeploy), `EdgeStack` (Gateway, WAF, Route53). Stateful stacks (`DataStack`) have deletion protection + `RETAIN` removal policy so an app redeploy can never drop the ledger DB.
- **Per-environment** (dev/staging/prod) via context/config; prod-only: Multi-AZ, cross-region snapshot copy, full autoscaling ranges. Staging runs single-AZ to control cost while preserving topology fidelity.
- CI/CD: `cdk diff` gated PRs; immutable image tags (git SHA) to ECR; CodeDeploy drives the api blue/green and worker rolling updates.

---

## 15.11 Multi-AZ HA & DR Summary

| Layer | HA mechanism | Failure outcome |
|---|---|---|
| Ingress | API Gateway (regional, managed) + cross-AZ internal ALB | AZ loss → ALB routes to surviving-AZ tasks |
| Compute | Fargate tasks spread across 3 AZs (min counts ≥2) | AZ loss → autoscaler replaces capacity; idempotent jobs re-run |
| RDS | Multi-AZ sync standby | AZ loss → auto-failover, **RPO≈0**; logical corruption → PITR (RPO≤5m) |
| Redis-cache | Cluster mode, Multi-AZ | shard/AZ loss → cold slice, repopulated from replica; no data loss |
| Redis-queue | primary+replica, Multi-AZ | failover; durable truth still in Postgres outbox/SagaState |
| Object | S3 (11 9s) + cross-region-ready | n/a |
| Region | cross-region KMS snapshot copy + rehearsed restore runbook | regional disaster → restore within RTO≤30m |

**DR posture:** Pilot-light cross-region — infra-as-code can stand up the region from CDK, data comes from cross-region snapshot + (optionally) cross-region read replica for tighter RPO on the regional case. Quarterly game-day: kill an AZ (verify failover), restore PITR to a scratch instance (verify backups + ledger integrity), rehearse regional restore.

---

## 15.12 Cost Considerations & Tradeoffs

| Lever | Saving | Tradeoff / guard |
|---|---|---|
| FARGATE_SPOT for `worker-notify`/`worker-provider` | up to ~70% on those tasks | never for `worker-saga`/`worker-payment` (money); spot interruption handled by idempotent re-run |
| Graviton (r6g/Fargate ARM) | ~20% price/perf on RDS + compute | requires arm64 images (multi-arch build) |
| RDS Proxy over big instance | smaller RDS class survives | Proxy hourly cost < the larger instance it avoids |
| VPC endpoints (S3/Secrets/ECR/Logs) | cut NAT data-processing $ at 200 TPS | endpoint hourly cost, offset by NAT savings + reliability gain |
| Aggressive S3 lifecycle → Glacier | storage cost on tickets/receipts | retrieval latency for old artifacts (acceptable; rarely accessed) |
| `redis-cache` right-sized w/ LRU | controls ElastiCache spend | cache miss → RDS read replica (not primary), bounded |
| Staging single-AZ | halves non-prod data cost | lower fidelity, accepted for non-prod |
| Compute Savings Plans on baseline (min task counts, RDS RIs) | committed-use discount on the always-on floor | commitment risk; only on the proven baseline, burst stays on-demand/spot |

**Architectural cost stance:** we spend on the things that protect *payment correctness and durability* (Multi-AZ RDS, on-demand money-path workers, cross-region backups) and economize on the *derived/transport/elastic* layers (spot notify/provider workers, LRU cache, lifecycle’d S3). This matches Rule 1 — money is paid to protect the system of record; everything rebuildable is optimized for cost.

---

### Open items / handoffs to other sections
- Exact autoscaling target values and `stopTimeout` vs longest provider-call budget must be confirmed against the Provider Integration timeout/circuit-breaker spec (Section on Provider ACL).
- Outbox-relay advisory-lock sharding count couples to the Outbox/Saga section's throughput design.
- KMS key hierarchy + PCI SAQ-A attestation scope detailed in the Security section; here we only ensure no card data path touches ASAP compute (Stripe Elements client-side).
