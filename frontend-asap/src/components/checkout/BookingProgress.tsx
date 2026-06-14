"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  Plane,
} from "lucide-react";
import { api, subscribeTripUpdates, ApiClientError } from "@/lib/api";
import type { Money, TripResource } from "@/lib/types";
import { formatMoney } from "@/lib/money";

interface BookingProgressProps {
  tripId: string;
  paymentIntentId?: string | null;
  eventTitle: string;
  total: Money;
  onRetry: () => void;
}

/**
 * Async booking state machine UI.
 * Flow: POST /trips/{id}/confirm (202) → "Booking in progress" → live updates
 * via SSE with 3s polling fallback → render the terminal state.
 */
export function BookingProgress({
  tripId,
  paymentIntentId,
  eventTitle,
  total,
  onRetry,
}: BookingProgressProps) {
  // Backend trip statuses: BOOKING | CONFIRMED | PARTIALLY_BOOKED | PAYMENT_FAILED | CANCELLED.
  const [status, setStatus] = useState<string>("BOOKING");
  const [failedLegs, setFailedLegs] =
    useState<TripResource["failedLegs"]>(undefined);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let demoTimer: ReturnType<typeof setTimeout> | undefined;

    const apply = (trip: { status: string; failedLegs?: TripResource["failedLegs"] }) => {
      setStatus(trip.status);
      if (trip.failedLegs) setFailedLegs(trip.failedLegs);
    };

    (async () => {
      try {
        if (!paymentIntentId) throw new ApiClientError(0, { code: "NO_PI", message: "demo", retryable: false });
        // Kick off async booking — server returns 202; then poll for the terminal state.
        const trip = await api.confirm(tripId, paymentIntentId);
        apply(trip as unknown as { status: string });
        unsubscribe = subscribeTripUpdates(tripId, (t) =>
          apply(t as unknown as { status: string }),
        );
      } catch {
        // No real payment intent / backend unavailable — simulate confirmation for demo.
        demoTimer = setTimeout(() => setStatus("CONFIRMED"), 2600);
      }
    })();

    return () => {
      unsubscribe?.();
      if (demoTimer) clearTimeout(demoTimer);
    };
  }, [tripId, paymentIntentId]);

  // ── In progress ──
  if (status === "BOOKING" || status === "BOOKING_IN_PROGRESS" || status === "PENDING" || status === "COMPENSATING") {
    return (
      <div className="flex flex-col items-center py-12 text-center">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
        <h2 className="mt-5 text-xl font-bold text-ink-primary">
          Booking in progress…
        </h2>
        <p className="mt-2 max-w-sm text-sm text-ink-secondary">
          We&apos;re securing your tickets and confirming your order. This usually
          takes a few seconds — please don&apos;t close this window.
        </p>
      </div>
    );
  }

  // ── Confirmed ──
  if (status === "CONFIRMED") {
    return (
      <div className="text-center">
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 200, damping: 14 }}
          className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-green-100"
        >
          <CheckCircle2 className="h-12 w-12 text-tag-fastest" />
        </motion.div>
        <h2 className="mt-5 text-2xl font-extrabold text-ink-primary">
          You&apos;re going! 🎉
        </h2>
        <p className="mt-2 text-sm text-ink-secondary">
          Your booking for <strong>{eventTitle}</strong> is confirmed.
        </p>

        <div className="mx-auto mt-6 max-w-sm rounded-lg bg-bg p-5 text-left">
          <div className="flex justify-between text-sm">
            <span className="text-ink-secondary">Booking ref</span>
            <span className="font-semibold text-ink-primary">
              ASAP-{tripId.slice(0, 6).toUpperCase()}
            </span>
          </div>
          <div className="mt-2 flex justify-between text-sm">
            <span className="text-ink-secondary">Total paid</span>
            <span className="font-semibold text-ink-primary">
              {formatMoney(total)}
            </span>
          </div>
        </div>

        {/* Best ways to get there → transport suggestions */}
        <div className="mx-auto mt-6 max-w-sm rounded-lg border border-primary/20 bg-primary-50 p-5 text-left">
          <div className="flex items-center gap-2 font-semibold text-primary">
            <Plane className="h-5 w-5" />
            Best ways to get there
          </div>
          <p className="mt-1 text-sm text-ink-secondary">
            We found smart transport options based on your location and the event
            start time.
          </p>
          <Link
            href="/transport"
            className="mt-3 inline-block rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-white"
          >
            View transport suggestions →
          </Link>
        </div>

        <Link
          href="/dashboard"
          className="mt-6 inline-block text-sm font-semibold text-primary hover:underline"
        >
          Go to trip dashboard
        </Link>
      </div>
    );
  }

  // ── Partially booked ──
  if (status === "PARTIALLY_BOOKED") {
    return (
      <div className="text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-amber-100">
          <AlertTriangle className="h-12 w-12 text-tag-lowprice" />
        </div>
        <h2 className="mt-5 text-2xl font-extrabold text-ink-primary">
          Almost there
        </h2>
        <p className="mt-2 max-w-md text-sm text-ink-secondary">
          Some parts of your booking went through, but the following could not be
          completed. You&apos;ve been refunded for these items.
        </p>
        <div className="mx-auto mt-5 max-w-sm space-y-2 text-left">
          {(failedLegs ?? [
            {
              name: "Hotel — Grand Plaza",
              reason: "Sold out at checkout",
              refund: total,
            },
          ]).map((leg) => (
            <div
              key={leg.name}
              className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm"
            >
              <p className="font-semibold text-ink-primary">{leg.name}</p>
              <p className="text-ink-secondary">{leg.reason}</p>
              <p className="mt-1 font-medium text-green-700">
                Refunded {formatMoney(leg.refund)}
              </p>
            </div>
          ))}
        </div>
        <Link
          href="/dashboard"
          className="mt-6 inline-block rounded-md bg-primary px-6 py-2.5 text-sm font-semibold text-white"
        >
          View what was booked
        </Link>
      </div>
    );
  }

  // ── Payment failed ──
  if (status === "PAYMENT_FAILED") {
    return (
      <div className="text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-red-100">
          <XCircle className="h-12 w-12 text-tag-sale" />
        </div>
        <h2 className="mt-5 text-2xl font-extrabold text-ink-primary">
          Payment failed
        </h2>
        <p className="mt-2 max-w-md text-sm text-ink-secondary">
          <strong>Nothing was charged.</strong> Your card was not billed and no
          tickets were reserved. You can safely try again.
        </p>
        <button
          onClick={onRetry}
          className="mt-6 rounded-md bg-primary px-6 py-2.5 text-sm font-semibold text-white"
        >
          Try again
        </button>
      </div>
    );
  }

  // ── Cancelled ──
  return (
    <div className="text-center">
      <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-gray-100">
        <XCircle className="h-12 w-12 text-tag-soldout" />
      </div>
      <h2 className="mt-5 text-2xl font-extrabold text-ink-primary">
        Booking lost
      </h2>
      <p className="mt-2 max-w-md text-sm text-ink-secondary">
        This booking was cancelled and the reservation released. If you were
        charged, a full refund is on its way.
      </p>
      <button
        onClick={onRetry}
        className="mt-6 rounded-md bg-primary px-6 py-2.5 text-sm font-semibold text-white"
      >
        Start over
      </button>
    </div>
  );
}