-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "booking";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "identity";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "notify";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "payment";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "platform";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "provider";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "trip";

-- CreateEnum
CREATE TYPE "trip"."TripStatus" AS ENUM ('DRAFT', 'PLANNING', 'PENDING_PAYMENT', 'PAYMENT_FAILED', 'BOOKING', 'CONFIRMED', 'PARTIALLY_BOOKED', 'COMPENSATING', 'CANCELLATION_REQUESTED', 'CANCELLED', 'COMPLETED', 'NEEDS_ATTENTION');

-- CreateEnum
CREATE TYPE "trip"."LegType" AS ENUM ('EVENT', 'TRANSPORT', 'STAY');

-- CreateEnum
CREATE TYPE "trip"."SagaStep" AS ENUM ('AUTHORIZE_PAYMENT', 'RESERVE_EVENT', 'RESERVE_TRANSPORT', 'RESERVE_STAY', 'CAPTURE_PAYMENT', 'CONFIRM_LEGS', 'COMPENSATE', 'DONE');

-- CreateEnum
CREATE TYPE "booking"."BookingStatus" AS ENUM ('PENDING', 'RESERVED', 'RETRYING', 'CONFIRMED', 'RELEASING', 'RELEASED', 'CANCELLING', 'CANCELLED', 'EXPIRED', 'REJECTED', 'FAILED', 'FULFILLED');

-- CreateEnum
CREATE TYPE "booking"."TransportMode" AS ENUM ('FLIGHT', 'TRAIN', 'BUS', 'RIDESHARE');

-- CreateEnum
CREATE TYPE "payment"."PaymentStatus" AS ENUM ('CREATED', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_CONFIRMATION', 'REQUIRES_ACTION', 'PROCESSING', 'AUTHORIZED', 'CAPTURED', 'VOIDED', 'FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED', 'CHARGEBACK');

-- CreateEnum
CREATE TYPE "payment"."RefundStatus" AS ENUM ('REQUESTED', 'APPROVED', 'DENIED', 'AWAITING_PROVIDER', 'PROCESSING', 'SUCCEEDED', 'RETRYING', 'FAILED_NEEDS_ATTENTION');

-- CreateEnum
CREATE TYPE "payment"."LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "notify"."NotificationStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'RETRYING', 'FAILED', 'UNCONFIRMED');

-- CreateEnum
CREATE TYPE "notify"."NotificationChannel" AS ENUM ('PUSH', 'EMAIL');

-- CreateEnum
CREATE TYPE "provider"."ProviderName" AS ENUM ('TICKETMASTER', 'EVENTBRITE', 'AMADEUS', 'RAIL_AGG', 'BUS_AGG', 'BOOKING_COM', 'UBER', 'STRIPE');

-- CreateEnum
CREATE TYPE "platform"."OutboxStatus" AS ENUM ('PENDING', 'DISPATCHED', 'FAILED');

-- CreateTable
CREATE TABLE "identity"."User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "displayName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "role" TEXT NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."Credential" (
    "userId" UUID NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "identity"."Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "refreshHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."DeviceToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip"."Trip" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "trip"."TripStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "anchorLegId" UUID,
    "destinationCity" TEXT,
    "destinationLat" DOUBLE PRECISION,
    "destinationLng" DOUBLE PRECISION,
    "arriveBy" TIMESTAMP(3),
    "departAfter" TIMESTAMP(3),
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "authorizedAmount" BIGINT NOT NULL DEFAULT 0,
    "capturedAmount" BIGINT NOT NULL DEFAULT 0,
    "refundedAmount" BIGINT NOT NULL DEFAULT 0,
    "paymentIntentId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Trip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip"."TripLeg" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "type" "trip"."LegType" NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" "booking"."BookingStatus" NOT NULL DEFAULT 'PENDING',
    "bookingId" UUID,
    "providerRef" TEXT,
    "priceAmount" BIGINT NOT NULL DEFAULT 0,
    "priceCurrency" CHAR(3) NOT NULL DEFAULT 'USD',
    "compRequired" BOOLEAN NOT NULL DEFAULT false,
    "refundId" UUID,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TripLeg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip"."SagaState" (
    "tripId" UUID NOT NULL,
    "step" "trip"."SagaStep" NOT NULL DEFAULT 'AUTHORIZE_PAYMENT',
    "compensating" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SagaState_pkey" PRIMARY KEY ("tripId")
);

-- CreateTable
CREATE TABLE "booking"."EventBooking" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "tripLegId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "provider"."ProviderName" NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "status" "booking"."BookingStatus" NOT NULL DEFAULT 'PENDING',
    "providerRef" TEXT,
    "holdExpiresAt" TIMESTAMP(3),
    "priceAmount" BIGINT NOT NULL,
    "priceCurrency" CHAR(3) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "attributes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking"."TransportBooking" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "tripLegId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "provider"."ProviderName" NOT NULL,
    "mode" "booking"."TransportMode" NOT NULL,
    "status" "booking"."BookingStatus" NOT NULL DEFAULT 'PENDING',
    "providerRef" TEXT,
    "fareQuoteId" UUID,
    "priceAmount" BIGINT NOT NULL,
    "priceCurrency" CHAR(3) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "segments" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransportBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking"."FareQuote" (
    "id" UUID NOT NULL,
    "provider" "provider"."ProviderName" NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FareQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking"."StayBooking" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "tripLegId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "provider"."ProviderName" NOT NULL,
    "externalPropertyId" TEXT NOT NULL,
    "status" "booking"."BookingStatus" NOT NULL DEFAULT 'PENDING',
    "providerRef" TEXT,
    "checkIn" TIMESTAMP(3) NOT NULL,
    "checkOut" TIMESTAMP(3) NOT NULL,
    "priceAmount" BIGINT NOT NULL,
    "priceCurrency" CHAR(3) NOT NULL,
    "cancellationPolicy" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StayBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment"."PaymentIntent" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "payment"."PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "amount" BIGINT NOT NULL,
    "capturedAmount" BIGINT NOT NULL DEFAULT 0,
    "refundedAmount" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "stripePaymentIntentId" TEXT,
    "clientSecret" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment"."Charge" (
    "id" UUID NOT NULL,
    "paymentIntentId" UUID NOT NULL,
    "stripeChargeId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "capturedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Charge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment"."Refund" (
    "id" UUID NOT NULL,
    "paymentIntentId" UUID NOT NULL,
    "tripLegId" UUID,
    "status" "payment"."RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "stripeRefundId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment"."Dispute" (
    "id" UUID NOT NULL,
    "paymentIntentId" UUID NOT NULL,
    "stripeDisputeId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" TEXT NOT NULL,
    "dueBy" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment"."LedgerAccount" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment"."LedgerEntry" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "paymentIntentId" UUID,
    "refundId" UUID,
    "direction" "payment"."LedgerDirection" NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "transactionId" UUID NOT NULL,
    "memo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notify"."Notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "channel" "notify"."NotificationChannel" NOT NULL,
    "templateId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" "notify"."NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "correlationId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notify"."DeliveryAttempt" (
    "id" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "channel" "notify"."NotificationChannel" NOT NULL,
    "succeeded" BOOLEAN NOT NULL,
    "providerResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider"."ProviderRequest" (
    "id" UUID NOT NULL,
    "provider" "provider"."ProviderName" NOT NULL,
    "operation" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "bookingId" UUID,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "succeeded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider"."CircuitState" (
    "provider" "provider"."ProviderName" NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'CLOSED',
    "failures" INTEGER NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CircuitState_pkey" PRIMARY KEY ("provider")
);

-- CreateTable
CREATE TABLE "platform"."OutboxEvent" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventVersion" INTEGER NOT NULL DEFAULT 1,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "correlationId" UUID,
    "causationId" UUID,
    "tripId" UUID,
    "userId" UUID,
    "payload" JSONB NOT NULL,
    "status" "platform"."OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."ProcessedEvent" (
    "eventId" UUID NOT NULL,
    "consumer" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedEvent_pkey" PRIMARY KEY ("eventId","consumer")
);

-- CreateTable
CREATE TABLE "platform"."IdempotencyKey" (
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "lockedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("scope","key")
);

-- CreateTable
CREATE TABLE "platform"."WebhookReceipt" (
    "source" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookReceipt_pkey" PRIMARY KEY ("source","externalEventId")
);

-- CreateTable
CREATE TABLE "platform"."AuditLog" (
    "id" UUID NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "correlationId" UUID,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "identity"."User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "identity"."User"("phone");

-- CreateIndex
CREATE INDEX "User_status_createdAt_idx" ON "identity"."User"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Session_userId_expiresAt_idx" ON "identity"."Session"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceToken_token_key" ON "identity"."DeviceToken"("token");

-- CreateIndex
CREATE INDEX "DeviceToken_userId_idx" ON "identity"."DeviceToken"("userId");

-- CreateIndex
CREATE INDEX "Trip_userId_createdAt_idx" ON "trip"."Trip"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Trip_status_updatedAt_idx" ON "trip"."Trip"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "TripLeg_tripId_idx" ON "trip"."TripLeg"("tripId");

-- CreateIndex
CREATE INDEX "TripLeg_bookingId_idx" ON "trip"."TripLeg"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "TripLeg_tripId_sequence_key" ON "trip"."TripLeg"("tripId", "sequence");

-- CreateIndex
CREATE INDEX "SagaState_step_nextRunAt_idx" ON "trip"."SagaState"("step", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "EventBooking_tripLegId_key" ON "booking"."EventBooking"("tripLegId");

-- CreateIndex
CREATE UNIQUE INDEX "EventBooking_idempotencyKey_key" ON "booking"."EventBooking"("idempotencyKey");

-- CreateIndex
CREATE INDEX "EventBooking_tripId_idx" ON "booking"."EventBooking"("tripId");

-- CreateIndex
CREATE INDEX "EventBooking_status_updatedAt_idx" ON "booking"."EventBooking"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "EventBooking_userId_createdAt_idx" ON "booking"."EventBooking"("userId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "TransportBooking_tripLegId_key" ON "booking"."TransportBooking"("tripLegId");

-- CreateIndex
CREATE UNIQUE INDEX "TransportBooking_idempotencyKey_key" ON "booking"."TransportBooking"("idempotencyKey");

-- CreateIndex
CREATE INDEX "TransportBooking_tripId_idx" ON "booking"."TransportBooking"("tripId");

-- CreateIndex
CREATE INDEX "TransportBooking_status_updatedAt_idx" ON "booking"."TransportBooking"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "FareQuote_expiresAt_idx" ON "booking"."FareQuote"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "StayBooking_tripLegId_key" ON "booking"."StayBooking"("tripLegId");

-- CreateIndex
CREATE UNIQUE INDEX "StayBooking_idempotencyKey_key" ON "booking"."StayBooking"("idempotencyKey");

-- CreateIndex
CREATE INDEX "StayBooking_tripId_idx" ON "booking"."StayBooking"("tripId");

-- CreateIndex
CREATE INDEX "StayBooking_status_updatedAt_idx" ON "booking"."StayBooking"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_stripePaymentIntentId_key" ON "payment"."PaymentIntent"("stripePaymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_idempotencyKey_key" ON "payment"."PaymentIntent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PaymentIntent_tripId_idx" ON "payment"."PaymentIntent"("tripId");

-- CreateIndex
CREATE INDEX "PaymentIntent_status_updatedAt_idx" ON "payment"."PaymentIntent"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "PaymentIntent_userId_createdAt_idx" ON "payment"."PaymentIntent"("userId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Charge_stripeChargeId_key" ON "payment"."Charge"("stripeChargeId");

-- CreateIndex
CREATE INDEX "Charge_paymentIntentId_idx" ON "payment"."Charge"("paymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_stripeRefundId_key" ON "payment"."Refund"("stripeRefundId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_idempotencyKey_key" ON "payment"."Refund"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Refund_paymentIntentId_idx" ON "payment"."Refund"("paymentIntentId");

-- CreateIndex
CREATE INDEX "Refund_status_updatedAt_idx" ON "payment"."Refund"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Dispute_stripeDisputeId_key" ON "payment"."Dispute"("stripeDisputeId");

-- CreateIndex
CREATE INDEX "Dispute_status_dueBy_idx" ON "payment"."Dispute"("status", "dueBy");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_code_key" ON "payment"."LedgerAccount"("code");

-- CreateIndex
CREATE INDEX "LedgerEntry_accountId_createdAt_idx" ON "payment"."LedgerEntry"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_transactionId_idx" ON "payment"."LedgerEntry"("transactionId");

-- CreateIndex
CREATE INDEX "LedgerEntry_paymentIntentId_idx" ON "payment"."LedgerEntry"("paymentIntentId");

-- CreateIndex
CREATE INDEX "Notification_status_nextAttemptAt_idx" ON "notify"."Notification"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_templateId_dedupeKey_key" ON "notify"."Notification"("userId", "templateId", "dedupeKey");

-- CreateIndex
CREATE INDEX "DeliveryAttempt_notificationId_idx" ON "notify"."DeliveryAttempt"("notificationId");

-- CreateIndex
CREATE INDEX "ProviderRequest_bookingId_idx" ON "provider"."ProviderRequest"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderRequest_provider_idempotencyKey_key" ON "provider"."ProviderRequest"("provider", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_eventId_key" ON "platform"."OutboxEvent"("eventId");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_occurredAt_idx" ON "platform"."OutboxEvent"("status", "occurredAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_aggregateType_aggregateId_idx" ON "platform"."OutboxEvent"("aggregateType", "aggregateId");

-- CreateIndex
CREATE INDEX "AuditLog_resourceType_resourceId_idx" ON "platform"."AuditLog"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "platform"."AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "identity"."Credential" ADD CONSTRAINT "Credential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "identity"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "identity"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."DeviceToken" ADD CONSTRAINT "DeviceToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "identity"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip"."TripLeg" ADD CONSTRAINT "TripLeg_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trip"."Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip"."SagaState" ADD CONSTRAINT "SagaState_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trip"."Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking"."TransportBooking" ADD CONSTRAINT "TransportBooking_fareQuoteId_fkey" FOREIGN KEY ("fareQuoteId") REFERENCES "booking"."FareQuote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment"."Charge" ADD CONSTRAINT "Charge_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId") REFERENCES "payment"."PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment"."Refund" ADD CONSTRAINT "Refund_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId") REFERENCES "payment"."PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment"."Dispute" ADD CONSTRAINT "Dispute_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId") REFERENCES "payment"."PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment"."LedgerEntry" ADD CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "payment"."LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notify"."DeliveryAttempt" ADD CONSTRAINT "DeliveryAttempt_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notify"."Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ========================================================================
-- §8.5 raw-migration hardening: partial indexes + CHECK constraints
-- (invariant backstops that Prisma DSL cannot express)
-- ========================================================================

-- Saga poller scans only in-flight trips
CREATE INDEX IF NOT EXISTS "trip_inflight_idx" ON "trip"."Trip" ("status","updatedAt")
  WHERE "status" IN ('PENDING_PAYMENT','BOOKING','COMPENSATING','CANCELLATION_REQUESTED');

-- Outbox relay scans only undispatched events
CREATE INDEX IF NOT EXISTS "outbox_pending_idx" ON "platform"."OutboxEvent" ("occurredAt")
  WHERE "status" = 'PENDING';

-- Refund / notification in-flight scans
CREATE INDEX IF NOT EXISTS "refund_inflight_idx" ON "payment"."Refund" ("status","updatedAt")
  WHERE "status" NOT IN ('SUCCEEDED','DENIED','FAILED_NEEDS_ATTENTION');
CREATE INDEX IF NOT EXISTS "notification_inflight_idx" ON "notify"."Notification" ("status","nextAttemptAt")
  WHERE "status" IN ('QUEUED','RETRYING');

-- Financial invariant backstops (defense in depth alongside the domain state machines)
ALTER TABLE "payment"."PaymentIntent"
  ADD CONSTRAINT "pi_captured_lte_amount" CHECK ("capturedAmount" <= "amount"),
  ADD CONSTRAINT "pi_refunded_lte_captured" CHECK ("refundedAmount" <= "capturedAmount");
ALTER TABLE "payment"."Charge" ADD CONSTRAINT "charge_amount_pos" CHECK ("amount" > 0);
ALTER TABLE "payment"."LedgerEntry" ADD CONSTRAINT "ledger_amount_pos" CHECK ("amount" > 0);
ALTER TABLE "booking"."StayBooking" ADD CONSTRAINT "stay_dates_valid" CHECK ("checkOut" > "checkIn");
