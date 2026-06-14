// E2E refund-policy test: book a confirmed trip, then cancel at different days-to-event
// and assert the 100% / 50% / 0% refund tiers. Usage:
//   STRIPE_SECRET_KEY=sk_test_... node scripts/refund-smoke.mjs
import Stripe from "stripe";
const BASE = "http://localhost:1201/api/v1";
const uuid = () => crypto.randomUUID();
let token = "";
const stripeKey = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeKey.startsWith("sk_") ? new Stripe(stripeKey) : null;

async function call(method, path, body, idem) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (idem) headers["idempotency-key"] = idem;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let json;
  try { json = JSON.parse(txt); } catch { json = txt; }
  return { status: res.status, json };
}

async function confirmCard(clientSecret) {
  if (!clientSecret || clientSecret.startsWith("pi_mock_")) return;
  if (!stripe) return;
  const piId = clientSecret.split("_secret")[0];
  await stripe.paymentIntents.confirm(piId, {
    payment_method: "pm_card_visa",
    return_url: "https://example.com/return",
  });
}

async function poll(tripId, terminal, timeout = 20000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    const r = await call("GET", `/trips/${tripId}`);
    last = r.json;
    if (terminal.includes(r.json.status)) return r.json;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return last;
}

async function bookConfirmed(eventId) {
  const create = await call("POST", "/trips", { anchor: { eventId, ticketTier: "GA", quantity: 2 } }, uuid());
  const tripId = create.json.id;
  const checkout = await call("POST", `/trips/${tripId}/checkout`, {}, uuid());
  await confirmCard(checkout.json.stripeClientSecret);
  await call("POST", `/trips/${tripId}/confirm`, { paymentIntentId: checkout.json.paymentIntentId }, uuid());
  const final = await poll(tripId, ["CONFIRMED", "PAYMENT_FAILED", "CANCELLED"]);
  return { tripId, final };
}

async function globalLedgerBalance() {
  // not exposed via API; rely on the cancel result + per-trip checks instead
  return null;
}

(async () => {
  const email = `refund-${uuid()}@asap.test`;
  const reg = await call("POST", "/auth/register", { email, password: "password123", displayName: "Refund" });
  token = reg.json.tokens.accessToken;
  console.log("registered", email, "\n");

  const cases = [
    { id: `TEST-D12-${Date.now()}`, days: 12, expectPct: 100, expectRefund: 17000 },
    { id: `TEST-D7-${Date.now()}`, days: 7, expectPct: 50, expectRefund: 8500 },
    { id: `TEST-D2-${Date.now()}`, days: 2, expectPct: 0, expectRefund: 0 },
  ];

  for (const c of cases) {
    console.log(`========== event ${c.days} days out (expect ${c.expectPct}% refund) ==========`);
    const { tripId, final } = await bookConfirmed(c.id);
    console.log(`  booked: status=${final.status} captured=${JSON.stringify(final.payment.captured)}`);

    const quote = await call("GET", `/trips/${tripId}/cancellation-quote`);
    console.log(`  quote: daysUntilEvent=${quote.json.daysUntilEvent} refundPercent=${quote.json.refundPercent}% refund=${JSON.stringify(quote.json.refund)} penalty=${JSON.stringify(quote.json.penalty)}`);

    const cancel = await call("POST", `/trips/${tripId}/cancel`, { reason: "CHANGE_OF_PLANS" }, uuid());
    console.log(`  cancel: status=${cancel.json.status} refundPercent=${cancel.json.refundPercent}% refund=${JSON.stringify(cancel.json.refund)}`);

    const after = await call("GET", `/trips/${tripId}`);
    const pct = quote.json.refundPercent;
    const refundAmt = cancel.json.refund?.amount;
    const ok = pct === c.expectPct && refundAmt === c.expectRefund && after.json.status === "CANCELLED";
    console.log(`  trip now: status=${after.json.status} refunded=${JSON.stringify(after.json.payment.refunded)}`);
    console.log(`  ${ok ? "✅ PASS" : "❌ FAIL"} (expected ${c.expectPct}% / ${c.expectRefund})\n`);
  }
})();
