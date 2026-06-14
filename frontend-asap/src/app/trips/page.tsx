"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Ticket, AlertCircle, CheckCircle2 } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { RefundTimeline } from "@/components/RefundTimeline";
import { apiFetch, ApiClientError } from "@/lib/api";
import { formatMoney } from "@/lib/money";

interface Leg {
  id: string;
  type: string;
  status: string;
  providerRef: string | null;
  price: { amount: number; currency: string };
}
interface BackendTrip {
  id: string;
  status: string;
  currency: string;
  legs: Leg[];
  payment: {
    captured: { amount: number; currency: string };
    refunded: { amount: number; currency: string };
  };
  totals: { estimated: { amount: number; currency: string } };
  createdAt: string;
}
interface CancellationQuote {
  refund: { amount: number; currency: string };
  penalty: { amount: number; currency: string };
  refundPercent: number;
  daysUntilEvent: number | null;
  reason: string;
  captured: { amount: number; currency: string };
  eventStartsAt: string | null;
}

const STATUS_STYLES: Record<string, string> = {
  CONFIRMED: "bg-green-50 text-green-700",
  BOOKING: "bg-blue-50 text-blue-700",
  PARTIALLY_BOOKED: "bg-amber-50 text-amber-700",
  CANCELLED: "bg-gray-100 text-gray-600",
  PAYMENT_FAILED: "bg-red-50 text-red-700",
  PLANNING: "bg-gray-100 text-gray-600",
  PENDING_PAYMENT: "bg-gray-100 text-gray-600",
};

export default function TripsPage() {
  const [trips, setTrips] = useState<BackendTrip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelFor, setCancelFor] = useState<BackendTrip | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ data: BackendTrip[] }>("/trips", {
        query: { limit: 20 },
      });
      setTrips(res.data);
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Could not load trips.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl px-4 pt-6 md:px-6">
        <h1 className="text-2xl font-extrabold text-ink-primary md:text-3xl">
          My Trips
        </h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Manage your bookings, cancellations and refunds.
        </p>

        {loading && (
          <div className="mt-12 flex justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        )}

        {error && (
          <div className="mt-6 flex items-center gap-2 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
            <AlertCircle className="h-4 w-4" /> {error}
          </div>
        )}

        {!loading && !error && trips.length === 0 && (
          <div className="mt-12 text-center text-ink-secondary">
            <Ticket className="mx-auto h-10 w-10 text-gray-300" />
            <p className="mt-3">No trips yet.</p>
            <Link
              href="/events"
              className="mt-4 inline-block rounded-md bg-primary px-6 py-2.5 text-sm font-semibold text-white"
            >
              Browse events
            </Link>
          </div>
        )}

        <div className="mt-6 space-y-3">
          {trips.map((t) => (
            <div key={t.id} className="rounded-lg bg-white p-5 card-shadow">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-ink-primary">
                      Trip {t.id.slice(0, 8).toUpperCase()}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        STATUS_STYLES[t.status] ?? "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {t.status.replace(/_/g, " ")}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-ink-secondary">
                    {t.legs.length} item{t.legs.length === 1 ? "" : "s"} ·{" "}
                    {new Date(t.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-extrabold text-ink-primary">
                    {formatMoney(
                      t.payment.captured.amount > 0
                        ? t.payment.captured
                        : t.totals.estimated,
                    )}
                  </p>
                  {t.payment.refunded.amount > 0 && (
                    <p className="text-xs font-medium text-green-700">
                      Refunded {formatMoney(t.payment.refunded)}
                    </p>
                  )}
                </div>
              </div>

              {t.status === "CONFIRMED" && (
                <div className="mt-4 flex justify-end">
                  <button
                    onClick={() => setCancelFor(t)}
                    className="rounded-md border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-600 transition-colors hover:bg-red-50"
                  >
                    Cancel &amp; request refund
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {cancelFor && (
        <CancelModal
          trip={cancelFor}
          onClose={() => setCancelFor(null)}
          onCancelled={() => {
            setCancelFor(null);
            load();
          }}
        />
      )}
    </AppShell>
  );
}

function CancelModal({
  trip,
  onClose,
  onCancelled,
}: {
  trip: BackendTrip;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const [quote, setQuote] = useState<CancellationQuote | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ refund: { amount: number; currency: string } } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const q = await apiFetch<CancellationQuote>(
          `/trips/${trip.id}/cancellation-quote`,
        );
        setQuote(q);
      } catch (err) {
        setError(err instanceof ApiClientError ? err.message : "Failed to load.");
      } finally {
        setLoading(false);
      }
    })();
  }, [trip.id]);

  const confirmCancel = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch<{ refund: { amount: number; currency: string } }>(
        `/trips/${trip.id}/cancel`,
        { method: "POST", body: {} },
      );
      setDone(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Cancellation failed.");
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 md:items-center md:p-4">
      <div className="w-full max-w-md rounded-t-2xl bg-white p-6 md:rounded-2xl">
        {done ? (
          <div className="text-center">
            <CheckCircle2 className="mx-auto h-12 w-12 text-green-600" />
            <h3 className="mt-3 text-lg font-bold text-ink-primary">
              Trip cancelled
            </h3>
            <p className="mt-1 text-sm text-ink-secondary">
              {done.refund.amount > 0
                ? `A refund of ${formatMoney(done.refund)} is on its way.`
                : "This booking was non-refundable, so no refund was issued."}
            </p>
            <button
              onClick={onCancelled}
              className="mt-6 w-full rounded-md bg-primary py-3 font-semibold text-white"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <h3 className="text-lg font-bold text-ink-primary">
              Cancel this trip?
            </h3>
            {loading && (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            )}
            {quote && (
              <>
                <div className="mt-3 rounded-md bg-bg p-4 text-sm">
                  <div className="flex justify-between">
                    <span className="text-ink-secondary">Paid</span>
                    <span className="font-medium text-ink-primary">
                      {formatMoney(quote.captured)}
                    </span>
                  </div>
                  <div className="mt-1 flex justify-between">
                    <span className="text-ink-secondary">
                      Refund ({quote.refundPercent}%)
                    </span>
                    <span className="font-bold text-green-700">
                      {formatMoney(quote.refund)}
                    </span>
                  </div>
                  {quote.penalty.amount > 0 && (
                    <div className="mt-1 flex justify-between">
                      <span className="text-ink-secondary">
                        Non-refundable
                      </span>
                      <span className="font-medium text-ink-primary">
                        {formatMoney(quote.penalty)}
                      </span>
                    </div>
                  )}
                </div>

                <div className="mt-4">
                  <RefundTimeline
                    highlightPercent={quote.refundPercent}
                    daysUntilEvent={quote.daysUntilEvent}
                  />
                </div>
              </>
            )}

            {error && (
              <p className="mt-3 text-sm text-red-600">{error}</p>
            )}

            <div className="mt-6 flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 rounded-md border border-gray-200 py-3 text-sm font-semibold text-ink-secondary"
              >
                Keep trip
              </button>
              <button
                onClick={confirmCancel}
                disabled={submitting || loading}
                className="flex-1 rounded-md bg-red-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-60"
              >
                {submitting ? "Cancelling…" : "Confirm cancellation"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
