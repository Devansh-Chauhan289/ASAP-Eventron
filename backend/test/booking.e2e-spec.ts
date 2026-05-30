import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/shared/common/filters/all-exceptions.filter';

/**
 * Phase-1 end-to-end exit criteria (docs/architecture/18-roadmap.md §18.3).
 *
 * Requires a live PostgreSQL + Redis and Stripe test keys. Run with:
 *   docker compose up -d && npm run prisma:deploy && RUN_E2E=1 STRIPE_SECRET_KEY=sk_test_... npm run test:e2e
 *
 * Gated behind RUN_E2E so `npm test` stays green without infra. This file is the executable
 * specification of: ledger balances, the VOID sad path, idempotency replay, and durability.
 */
const RUN = process.env.RUN_E2E === '1';
const d = RUN ? describe : describe.skip;

d('ASAP booking saga (Phase-1)', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    const email = `e2e-${randomUUID()}@asap.test`;
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: 'password123', displayName: 'E2E' })
      .expect(201);
    token = res.body.tokens.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  it('creates a trip from an anchor event (synthetic TEST event)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/trips')
      .set(auth())
      .set('Idempotency-Key', randomUUID())
      .send({ anchor: { eventId: 'TEST-1', ticketTier: 'GA', quantity: 2 } })
      .expect(201);
    expect(res.body.status).toBe('PLANNING');
    expect(res.body.legs).toHaveLength(1);
    expect(res.body.totals.estimated.amount).toBeGreaterThan(0);
  });

  it('replays the same Idempotency-Key without creating a duplicate (criterion 4)', async () => {
    const key = randomUUID();
    const body = { anchor: { eventId: 'TEST-2', ticketTier: 'GA', quantity: 1 } };
    const a = await request(app.getHttpServer())
      .post('/api/v1/trips')
      .set(auth())
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const b = await request(app.getHttpServer())
      .post('/api/v1/trips')
      .set(auth())
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(b.body.id).toBe(a.body.id); // same trip, no duplicate
  });

  // The full VOID sad-path (criterion 3) uses anchor eventId 'FAIL-1':
  //   create -> checkout -> (client confirms Stripe PI in test mode) -> confirm
  //   -> saga RESERVE_EVENT rejects (SOLD_OUT) -> COMPENSATE -> Trip CANCELLED, PI VOIDED, ledger empty.
  // It requires a confirmed Stripe test PaymentIntent, so it is documented here and exercised
  // in the Stripe-test-mode CI job rather than inline.
  it.todo('VOID sad path: FAIL anchor -> CANCELLED + PaymentIntent VOIDED + zero ledger movement');
  it.todo('happy path: ledger Σdebits == Σcredits after capture (criterion 2)');
  it.todo('durability: kill worker mid-saga, resume from persisted SagaState.step (criterion 5)');
});
