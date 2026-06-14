// End-to-end smoke test of the booking saga against a running instance.
// Usage: STRIPE_SECRET_KEY=sk_test_... node scripts/smoke.mjs [baseUrl]
import Stripe from 'stripe';
const BASE = (process.argv[2] || 'http://localhost:1201') + '/api/v1';
const uuid = () => crypto.randomUUID();
let token = '';

// Stand in for the frontend's Stripe.js card confirmation (manual capture -> requires_capture).
const stripeKey = process.env.STRIPE_SECRET_KEY || '';
const stripe = stripeKey.startsWith('sk_') ? new Stripe(stripeKey) : null;

async function confirmCard(clientSecret) {
  if (clientSecret.startsWith('pi_mock_')) return 'mock (auto-authorized)';
  if (!stripe) return 'SKIPPED (no STRIPE_SECRET_KEY in env)';
  const piId = clientSecret.split('_secret')[0];
  const pi = await stripe.paymentIntents.confirm(piId, {
    payment_method: 'pm_card_visa',
    return_url: 'https://example.com/return',
  });
  return `stripe status=${pi.status}`;
}

async function call(method, path, body, idem) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (idem) headers['idempotency-key'] = idem;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

async function pollTrip(id, terminal, timeoutMs = 20000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    const r = await call('GET', `/trips/${id}`);
    last = r.json;
    if (terminal.includes(r.json.status)) return r.json;
    await new Promise((res) => setTimeout(res, 1000));
  }
  return last;
}

async function runFlow(label, eventId, expectTerminal) {
  console.log(`\n========== ${label} (eventId=${eventId}) ==========`);

  const create = await call('POST', '/trips',
    { anchor: { eventId, ticketTier: 'GA', quantity: 2 } }, uuid());
  console.log('1) create  ->', create.status, 'status=', create.json.status,
    'total=', JSON.stringify(create.json?.totals?.estimated));
  if (create.status >= 300) return console.log('   FAILED:', JSON.stringify(create.json));
  const tripId = create.json.id;

  const checkout = await call('POST', `/trips/${tripId}/checkout`, {}, uuid());
  console.log('2) checkout->', checkout.status,
    'paymentIntentId=', checkout.json.paymentIntentId,
    'clientSecret=', String(checkout.json.stripeClientSecret).slice(0, 24) + '...');
  if (checkout.status >= 300) return console.log('   FAILED:', JSON.stringify(checkout.json));

  // Simulate the frontend confirming the card before /confirm.
  const cardStatus = await confirmCard(checkout.json.stripeClientSecret);
  console.log('   card confirm ->', cardStatus);

  const confirm = await call('POST', `/trips/${tripId}/confirm`,
    { paymentIntentId: checkout.json.paymentIntentId }, uuid());
  console.log('3) confirm ->', confirm.status, 'status=', confirm.json.status);
  if (confirm.status >= 300) return console.log('   FAILED:', JSON.stringify(confirm.json));

  const final = await pollTrip(tripId, expectTerminal);
  console.log('4) final   -> status=', final.status);
  console.log('   legs:', final.legs.map((l) => `${l.type}:${l.status}`).join(', '));
  console.log('   payment:', JSON.stringify(final.payment));
  console.log(`   ==> tripId=${tripId}`);
  return { tripId, final };
}

(async () => {
  const email = `smoke-${uuid()}@asap.test`;
  const reg = await call('POST', '/auth/register',
    { email, password: 'password123', displayName: 'Smoke' });
  if (reg.status >= 300) { console.log('register failed', reg.status, JSON.stringify(reg.json)); process.exit(1); }
  token = reg.json.tokens.accessToken;
  console.log('registered', email);

  await runFlow('HAPPY PATH', 'TEST-1', ['CONFIRMED', 'PARTIALLY_BOOKED', 'PAYMENT_FAILED', 'CANCELLED']);
  await runFlow('SAD PATH (compensation/VOID)', 'FAIL-1', ['CANCELLED', 'PAYMENT_FAILED', 'CONFIRMED']);

  // Idempotency replay check
  console.log('\n========== IDEMPOTENCY REPLAY ==========');
  const k = uuid();
  const a = await call('POST', '/trips', { anchor: { eventId: 'TEST-2', ticketTier: 'GA', quantity: 1 } }, k);
  const b = await call('POST', '/trips', { anchor: { eventId: 'TEST-2', ticketTier: 'GA', quantity: 1 } }, k);
  console.log('same Idempotency-Key -> same trip id?', a.json.id === b.json.id, `(a=${a.json.id})`);
})();
