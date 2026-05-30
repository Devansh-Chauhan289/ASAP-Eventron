# ASAP API Reference (v1) — Frontend Integration Guide

> **Audience:** Frontend / mobile engineers building against the ASAP backend.
> **Status:** Contract-first. These contracts are **stable**; the backend is implemented against them. You can build UI and mock against this doc today.
> **Base URL:** `https://api.asap.app` → all v1 routes are under `/api/v1`.
> **Format:** JSON over HTTPS. UTF-8. All timestamps ISO-8601 UTC (`2026-05-31T10:00:00Z`).
> **Money:** every monetary value is an **integer in minor units** plus a `currency` code. `{"amount": 12999, "currency": "USD"}` means **$129.99**. Never a float. Format on the client.

---

## 1. Conventions (read first)

### 1.1 Auth
- Auth is **Bearer JWT**: `Authorization: Bearer <accessToken>`.
- Access token lifetime ~15 min; refresh token ~30 days (rotating). Use `/auth/refresh` to rotate.
- Unauthenticated endpoints: `/auth/register`, `/auth/login`, `/auth/refresh`, `/health`, public search.

### 1.2 Idempotency (critical for all POSTs that create/charge)
Any **state-changing POST** (create trip, confirm basket, pay, cancel, refund) **must** send a client-generated UUID:
```
Idempotency-Key: 7b2c...   (UUID v4 you generate per logical action)
```
Re-sending the same key returns the **same result** (the original response), never a duplicate booking/charge. Generate one key per user action; reuse it across retries of that same action.

### 1.3 Correlation
Optionally send `X-Correlation-Id: <uuid>`; if absent the server generates one and returns it in the response header. Log it client-side to help support trace issues.

### 1.4 Pagination (cursor-based)
List endpoints use cursors, not page numbers:
```
GET /api/v1/trips?limit=20&cursor=eyJjcmVhdGVkQXQ...
```
Response:
```json
{ "data": [ ... ], "pageInfo": { "nextCursor": "eyJ...", "hasMore": false } }
```
Pass `nextCursor` back as `cursor` to get the next page. `nextCursor: null` ⇒ end.

### 1.5 Standard error envelope
**Every** error (4xx/5xx) returns this shape:
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable summary.",
    "details": [ { "field": "email", "issue": "must be a valid email" } ],
    "correlationId": "uuid",
    "retryable": false
  }
}
```
| HTTP | `error.code` | Meaning | Client action |
|------|--------------|---------|---------------|
| 400 | `VALIDATION_ERROR` | Bad input | Fix fields in `details` |
| 401 | `UNAUTHENTICATED` | Missing/expired token | Refresh or re-login |
| 403 | `FORBIDDEN` | Not allowed | Hide/disable action |
| 404 | `NOT_FOUND` | No such resource | — |
| 409 | `CONFLICT` / `IDEMPOTENCY_REPLAY` | Duplicate/state conflict | Use returned state |
| 422 | `BUSINESS_RULE` | Valid input, rule violation (e.g. sold out, fare expired) | Show domain message |
| 429 | `RATE_LIMITED` | Too many requests | Back off; honor `Retry-After` header |
| 502/503 | `PROVIDER_UNAVAILABLE` | Upstream provider/circuit open | Retry later; `retryable:true` |
| 500 | `INTERNAL` | Bug | Show generic error; report `correlationId` |

`retryable:true` means a safe retry (same Idempotency-Key) may succeed.

### 1.6 Async model (important for UX)
Booking is **asynchronous**. Confirming a trip returns `202 Accepted` with the trip in a transient status (`BOOKING`). The frontend then either:
- **Polls** `GET /api/v1/trips/{id}` until status is terminal (`CONFIRMED`, `PARTIALLY_BOOKED`, `CANCELLED`, `PAYMENT_FAILED`), or
- **Subscribes** to push notifications (FCM) — the backend pushes `trip.confirmed` / `trip.partially_booked`, or
- **Streams** progress via `GET /api/v1/trips/{id}/events` (Server-Sent Events) for a live booking screen.

Design the UI around a **progressive booking** state, not a single blocking spinner.

---

## 2. Auth & Account

### POST /api/v1/auth/register
```json
// Request
{ "email": "a@b.com", "password": "••••••••", "displayName": "Ada" }
// 201 Response
{ "user": { "id": "uuid", "email": "a@b.com", "displayName": "Ada" },
  "tokens": { "accessToken": "jwt", "refreshToken": "jwt", "expiresIn": 900 } }
```

### POST /api/v1/auth/login
```json
// Request
{ "email": "a@b.com", "password": "••••••••" }
// 200 Response → same shape as register. If MFA enabled:
{ "mfaRequired": true, "mfaToken": "short-lived-jwt" }
```

### POST /api/v1/auth/mfa/verify
```json
{ "mfaToken": "jwt", "code": "123456" }  // → tokens
```

### POST /api/v1/auth/refresh
```json
{ "refreshToken": "jwt" }  // → new { accessToken, refreshToken, expiresIn }
```

### POST /api/v1/auth/logout    → 204 (revokes refresh token)

### GET /api/v1/me
```json
// 200
{ "id": "uuid", "email": "a@b.com", "displayName": "Ada",
  "phone": null, "mfaEnabled": false, "createdAt": "..." }
```

### PATCH /api/v1/me    `{ "displayName"?, "phone"? }` → updated profile

### POST /api/v1/me/devices   (register FCM token for push)
```json
{ "token": "fcm-token", "platform": "IOS" }  // → 204
```

---

## 3. Discovery (Search & Recommendations) — read-only, cacheable

### GET /api/v1/events/search
Query params: `q`, `city`, `lat`, `lng`, `radiusKm`, `from`, `to`, `category`, `priceMin`, `priceMax`, `limit`, `cursor`.
```json
// 200
{ "data": [
    { "id": "evt_uuid", "provider": "TICKETMASTER", "externalId": "G5v...",
      "title": "Coldplay — Music of the Spheres", "category": "CONCERT",
      "venue": { "name": "SoFi Stadium", "city": "Inglewood",
                 "geo": { "lat": 33.95, "lng": -118.33 } },
      "startsAt": "2026-08-01T19:00:00Z", "endsAt": "2026-08-01T23:00:00Z",
      "priceFrom": { "amount": 8500, "currency": "USD" },
      "imageUrl": "https://...", "availability": "AVAILABLE" } ],
  "pageInfo": { "nextCursor": "...", "hasMore": true } }
```
> Results may be **cached** (up to ~60s). `availability` is best-effort; the authoritative check happens at reservation time.

### GET /api/v1/events/{eventId}    → full event detail (sections, ticket tiers, seatmap ref).

### GET /api/v1/recommendations/trip?eventId=evt_uuid
Given an anchor event, returns suggested transport + stay options orchestrated around it.
```json
// 200
{ "anchor": { "eventId": "evt_uuid", "destination": { "city": "Inglewood", "geo": {...} },
              "arriveBy": "2026-08-01T18:00:00Z" },
  "transport": [ { "mode": "FLIGHT", "provider": "AMADEUS", "offerId": "off_1",
                   "from": "SFO", "to": "LAX", "depart": "...", "arrive": "...",
                   "price": { "amount": 14500, "currency": "USD" },
                   "expiresAt": "2026-05-31T10:10:00Z" } ],
  "stays": [ { "provider": "BOOKING_COM", "propertyId": "prop_1", "name": "Hotel X",
               "checkIn": "2026-08-01", "checkOut": "2026-08-02",
               "price": { "amount": 22000, "currency": "USD" },
               "cancellation": "FREE_UNTIL_2026-07-30", "rating": 4.4 } ] }
```
> Transport/stay quotes carry **`expiresAt`** — surface a countdown; re-fetch if expired before checkout.

---

## 4. Trips (the orchestration core)

A **Trip** is the container for an event + optional transport + stay, paid as one. Lifecycle status values the UI must handle:
`DRAFT, PLANNING, PENDING_PAYMENT, PAYMENT_FAILED, BOOKING, CONFIRMED, PARTIALLY_BOOKED, COMPENSATING, CANCELLATION_REQUESTED, CANCELLED, COMPLETED, NEEDS_ATTENTION`.

### POST /api/v1/trips   *(Idempotency-Key required)*
Create a trip from an anchor event.
```json
// Request
{ "anchor": { "eventId": "evt_uuid", "ticketTier": "GA", "quantity": 2 } }
// 201 Response
{ "id": "trip_uuid", "status": "PLANNING",
  "anchor": { "eventId": "evt_uuid", "destination": {...},
              "arriveBy": "2026-08-01T18:00:00Z" },
  "legs": [ { "id": "leg_uuid", "type": "EVENT", "sequence": 0, "status": "PENDING",
              "price": { "amount": 17000, "currency": "USD" } } ],
  "totals": { "estimated": { "amount": 17000, "currency": "USD" } },
  "createdAt": "..." }
```

### GET /api/v1/trips      → list current user's trips (cursor paginated). Filter `?status=`.

### GET /api/v1/trips/{tripId}
Full trip with all legs and live statuses.
```json
// 200
{ "id": "trip_uuid", "status": "CONFIRMED", "currency": "USD",
  "legs": [
    { "id": "leg0", "type": "EVENT", "status": "CONFIRMED", "providerRef": "TM-883...",
      "price": { "amount": 17000, "currency": "USD" }, "detail": { /* event */ } },
    { "id": "leg1", "type": "TRANSPORT", "status": "CONFIRMED", "providerRef": "AM-771...",
      "price": { "amount": 14500, "currency": "USD" }, "detail": { /* flight segments */ } },
    { "id": "leg2", "type": "STAY", "status": "CONFIRMED", "providerRef": "BK-552...",
      "price": { "amount": 22000, "currency": "USD" }, "detail": { /* stay */ } } ],
  "payment": { "status": "CAPTURED",
               "authorized": { "amount": 53500, "currency": "USD" },
               "captured":   { "amount": 53500, "currency": "USD" },
               "refunded":   { "amount": 0, "currency": "USD" } },
  "totals": { "captured": { "amount": 53500, "currency": "USD" } },
  "createdAt": "...", "updatedAt": "..." }
```

### POST /api/v1/trips/{tripId}/legs   *(Idempotency-Key required)*
Add a transport or stay leg (from a recommendation offer) while in `PLANNING`.
```json
// Request (transport)
{ "type": "TRANSPORT", "offerId": "off_1", "provider": "AMADEUS" }
// Request (stay)
{ "type": "STAY", "propertyId": "prop_1", "provider": "BOOKING_COM",
  "checkIn": "2026-08-01", "checkOut": "2026-08-02", "rateId": "rate_x" }
// 201 → returns the updated trip with the new leg (status PENDING) + new totals
```
> **422 `BUSINESS_RULE` / `code: QUOTE_EXPIRED`** if the offer's `expiresAt` passed — re-fetch recommendations and retry.

### DELETE /api/v1/trips/{tripId}/legs/{legId}   (remove a leg while in `PLANNING`) → updated trip.

### POST /api/v1/trips/{tripId}/quote
Re-price the current basket (refreshes provider quotes, returns authoritative total before payment).
```json
// 200
{ "tripId": "trip_uuid", "legs": [ { "id":"leg1", "price": {...}, "expiresAt":"..." } ],
  "total": { "amount": 53500, "currency": "USD" },
  "quoteExpiresAt": "2026-05-31T10:12:00Z" }
```
> Always call this immediately before payment to detect price changes. If a price changed, the UI must show the diff and get explicit user re-consent.

---

## 5. Checkout & Payment (Stripe)

ASAP uses **Stripe with manual capture**: we **authorize** at checkout, **capture** only after the bookings are confirmed. Card data is collected by **Stripe Elements / Payment Sheet on the client** — **the card number never touches ASAP servers** (PCI SAQ-A).

### Booking + payment sequence (what the frontend does)
```
1. POST /trips/{id}/quote                  → fresh total + quoteExpiresAt
2. POST /trips/{id}/checkout               → returns Stripe clientSecret (PaymentIntent, manual capture)
3. [Client] Stripe SDK confirms payment    → handles 3DS; produces an authorized PaymentIntent
4. POST /trips/{id}/confirm                → 202 Accepted; backend authorizes→books legs→captures
5. Poll GET /trips/{id}  OR  SSE /trips/{id}/events  → until CONFIRMED / PARTIALLY_BOOKED / ...
```

### POST /api/v1/trips/{tripId}/checkout   *(Idempotency-Key required)*
Creates (or returns existing) Stripe PaymentIntent for the trip total.
```json
// Request
{ "quoteToken": "from /quote (binds the price you showed the user)" }
// 200 Response
{ "paymentIntentId": "pi_uuid",
  "stripeClientSecret": "pi_3..._secret_...",   // give to Stripe SDK on client
  "amount": { "amount": 53500, "currency": "USD" },
  "captureMethod": "manual", "status": "REQUIRES_CONFIRMATION" }
```
> Re-calling with the same Idempotency-Key returns the **same** clientSecret (no double intent).

### POST /api/v1/trips/{tripId}/confirm   *(Idempotency-Key required)*
Call **after** the client-side Stripe confirmation succeeds (PaymentIntent `requires_capture`). Kicks off the booking saga.
```json
// Request
{ "paymentIntentId": "pi_uuid" }
// 202 Accepted
{ "tripId": "trip_uuid", "status": "BOOKING",
  "message": "Your trip is being booked. We'll notify you when it's confirmed.",
  "pollAfterMs": 2000 }
```
Possible terminal outcomes (observed via polling/SSE/push):
- `CONFIRMED` — all legs booked, payment captured.
- `PARTIALLY_BOOKED` — anchor event booked; a secondary leg failed and was **auto-refunded** (see `payment.refunded`). UI shows what succeeded + refund.
- `PAYMENT_FAILED` — authorization issue; nothing charged; user can retry checkout.
- `CANCELLED` — anchor failed; **nothing charged** (auth voided). UI offers to retry/search again.

### GET /api/v1/trips/{tripId}/events    (Server-Sent Events)
Live booking progress stream. Emits:
```
event: leg.update
data: { "legId": "leg1", "status": "RESERVED" }

event: trip.update
data: { "status": "CONFIRMED" }
```
Close the stream on any terminal `trip.update`.

### GET /api/v1/trips/{tripId}/payment    → payment summary (status, authorized/captured/refunded, charges, refunds list).

---

## 6. Cancellation & Refunds

### POST /api/v1/trips/{tripId}/cancel   *(Idempotency-Key required)*
Cancel an entire confirmed trip. Refund computed per each provider's **snapshotted cancellation policy**.
```json
// Request (optional reason)
{ "reason": "CHANGE_OF_PLANS" }
// 202 Accepted
{ "tripId": "trip_uuid", "status": "CANCELLATION_REQUESTED",
  "estimatedRefund": { "amount": 39500, "currency": "USD" },
  "nonRefundable": { "amount": 14000, "currency": "USD" },
  "breakdown": [
    { "legId": "leg0", "refundable": { "amount": 17000, "currency": "USD" } },
    { "legId": "leg1", "refundable": { "amount": 0, "currency": "USD" }, "reason": "NON_REFUNDABLE_FARE" },
    { "legId": "leg2", "refundable": { "amount": 22500, "currency": "USD" }, "penalty": { "amount": 0, "currency":"USD" } } ] }
```
> Refunds are **async**. Poll the trip or `/payment`; final state `CANCELLED` with `payment.status` `REFUNDED`/`PARTIALLY_REFUNDED`.

### POST /api/v1/trips/{tripId}/legs/{legId}/cancel   *(Idempotency-Key required)*
Cancel a single leg (where the provider/policy allows) without cancelling the whole trip. Same response shape scoped to one leg.

### GET /api/v1/trips/{tripId}/refunds    → list of refunds with status (`REQUESTED…SUCCEEDED`) and amounts.

---

## 7. Notifications & Preferences

### GET /api/v1/notifications     → in-app notification feed (cursor paginated).
### POST /api/v1/notifications/{id}/read   → mark read.
### GET /api/v1/me/notification-preferences
### PATCH /api/v1/me/notification-preferences
```json
{ "push": { "tripUpdates": true, "promotions": false },
  "email": { "receipts": true, "promotions": false } }
```

---

## 8. Webhooks (server-to-server — NOT called by the frontend)
Documented for completeness; the frontend never calls these.
- `POST /api/v1/webhooks/stripe` — Stripe events (payment, refund, dispute). Signature-verified, idempotent.
- `POST /api/v1/webhooks/providers/{provider}` — provider booking status callbacks.

---

## 9. Health
- `GET /health/live` → `200 { "status": "ok" }` (liveness).
- `GET /health/ready` → readiness (DB/Redis reachable).

---

## 10. Status reference (enums the UI must handle)

| Domain | Statuses |
|--------|----------|
| **Trip** | DRAFT, PLANNING, PENDING_PAYMENT, PAYMENT_FAILED, BOOKING, CONFIRMED, PARTIALLY_BOOKED, COMPENSATING, CANCELLATION_REQUESTED, CANCELLED, COMPLETED, NEEDS_ATTENTION |
| **Leg / Booking** | PENDING, RESERVED, RETRYING, CONFIRMED, RELEASING, RELEASED, CANCELLING, CANCELLED, EXPIRED, REJECTED, FAILED, FULFILLED |
| **Payment** | CREATED, REQUIRES_PAYMENT_METHOD, REQUIRES_CONFIRMATION, REQUIRES_ACTION, PROCESSING, AUTHORIZED, CAPTURED, VOIDED, FAILED, PARTIALLY_REFUNDED, REFUNDED, DISPUTED, CHARGEBACK |
| **Refund** | REQUESTED, APPROVED, DENIED, AWAITING_PROVIDER, PROCESSING, SUCCEEDED, RETRYING, FAILED_NEEDS_ATTENTION |

### Suggested UI state mapping
| Show user | When trip.status ∈ |
|-----------|--------------------|
| "Planning your trip" | DRAFT, PLANNING |
| "Complete payment" | PENDING_PAYMENT, PAYMENT_FAILED |
| "Booking… (live progress)" | BOOKING, COMPENSATING |
| "Trip confirmed 🎉" | CONFIRMED, COMPLETED |
| "Partially booked — see details + refund" | PARTIALLY_BOOKED |
| "Cancelled (refund on the way)" | CANCELLATION_REQUESTED, CANCELLED |
| "We hit a snag — support notified" | NEEDS_ATTENTION |

---

## 11. OpenAPI
A machine-readable **OpenAPI 3.1** spec is generated from the NestJS DTOs at `GET /api/v1/openapi.json` (and Swagger UI at `/api/v1/docs` in non-prod). Use it to generate typed clients (e.g. `openapi-typescript`). This README is the human guide; the OpenAPI spec is the generated source of truth once the backend is implemented.

> **Note:** Until backend implementation lands (see `docs/architecture/18-roadmap.md`), treat this document as the contract to mock against. Field names and shapes here are committed; only additive changes will occur within v1.
