"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Calendar, Plane, Hotel, Ticket, Loader2, ArrowRight } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { EventCard } from "@/components/EventCard";
import { Reveal } from "@/components/Reveal";
import { apiFetch, api } from "@/lib/api";
import { mapApiEvent, type ApiEvent } from "@/lib/map";
import { formatMoney } from "@/lib/money";
import type { EventItem } from "@/lib/types";

interface BackendTrip {
  id: string;
  status: string;
  legs: { id: string; type: string; status: string }[];
  payment: {
    captured: { amount: number; currency: string };
    refunded: { amount: number; currency: string };
  };
  totals: { estimated: { amount: number; currency: string } };
  createdAt: string;
}

const STATUS_STYLES: Record<string, string> = {
  CONFIRMED: "bg-green-50 text-green-700",
  BOOKING: "bg-blue-50 text-blue-700",
  PARTIALLY_BOOKED: "bg-amber-50 text-amber-700",
  CANCELLED: "bg-gray-100 text-gray-600",
  PAYMENT_FAILED: "bg-red-50 text-red-700",
};

export default function DashboardPage() {
  const [trips, setTrips] = useState<BackendTrip[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [t, e] = await Promise.all([
          apiFetch<{ data: BackendTrip[] }>("/trips", { query: { limit: 20 } }),
          api.searchEvents({ limit: 8 }),
        ]);
        setTrips(t.data);
        setEvents((e.data as ApiEvent[]).map(mapApiEvent));
      } catch {
        /* leave empty */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const confirmed = trips.filter((t) => t.status === "CONFIRMED").length;
  const totalSpent = trips.reduce(
    (s, t) =>
      s + Math.max(0, t.payment.captured.amount - t.payment.refunded.amount),
    0,
  );
  const stats = [
    { value: trips.length, label: "Trips" },
    { value: confirmed, label: "Confirmed" },
    {
      value: trips.filter((t) => t.status === "CANCELLED").length,
      label: "Cancelled",
    },
    { value: formatMoney({ amount: totalSpent, currency: "USD" }), label: "Spent" },
  ];

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl px-4 pt-6 md:px-6">
        <Reveal>
          <p className="text-xs font-bold uppercase tracking-widest text-primary">
            Trip Dashboard
          </p>
          <h1 className="mt-1 text-2xl font-extrabold text-ink-primary md:text-3xl">
            Your bookings
          </h1>
          <p className="mt-1 flex items-center gap-1 text-sm text-ink-secondary">
            <Calendar className="h-4 w-4" /> All your event bookings in one place
          </p>
        </Reveal>

        <Reveal delay={0.05}>
          <div className="mt-5 grid grid-cols-4 gap-3">
            {stats.map((s) => (
              <div
                key={s.label}
                className="rounded-md bg-white p-4 text-center card-shadow"
              >
                <p className="text-xl font-extrabold text-ink-primary">
                  {s.value}
                </p>
                <p className="text-xs text-ink-secondary">{s.label}</p>
              </div>
            ))}
          </div>
        </Reveal>

        {/* Real trips */}
        <section className="mt-8">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-bold text-ink-primary">My Trips</h2>
            <Link
              href="/trips"
              className="flex items-center gap-1 text-sm font-semibold text-primary"
            >
              Manage all <ArrowRight className="h-4 w-4" />
            </Link>
          </div>

          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : trips.length === 0 ? (
            <div className="rounded-lg bg-white p-8 text-center card-shadow">
              <Ticket className="mx-auto h-10 w-10 text-gray-300" />
              <p className="mt-3 text-sm text-ink-secondary">
                No bookings yet — find an event to get started.
              </p>
              <Link
                href="/events"
                className="mt-4 inline-block rounded-md bg-primary px-6 py-2.5 text-sm font-semibold text-white"
              >
                Browse events
              </Link>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {trips.slice(0, 4).map((t) => (
                <Link
                  key={t.id}
                  href="/trips"
                  className="rounded-lg bg-white p-5 card-shadow transition-shadow hover:shadow-md"
                >
                  <div className="flex items-center justify-between">
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
                  <p className="mt-2 text-sm text-ink-secondary">
                    {t.legs.length} item{t.legs.length === 1 ? "" : "s"}
                  </p>
                  <p className="mt-1 text-lg font-extrabold text-ink-primary">
                    {formatMoney(
                      t.payment.captured.amount > 0
                        ? t.payment.captured
                        : t.totals.estimated,
                    )}
                  </p>
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* Travel planning — next release */}
        <section className="mt-8">
          <div className="rounded-lg border border-dashed border-primary/30 bg-primary-50/40 p-5">
            <div className="flex items-center gap-3 font-semibold text-primary">
              <Plane className="h-5 w-5" /> <Hotel className="h-5 w-5" />
              Transport &amp; stay booking
            </div>
            <p className="mt-1 text-sm text-ink-secondary">
              Smart flight, train and hotel orchestration around your events is
              coming next. Today ASAP books your event tickets and payments
              end-to-end.
            </p>
          </div>
        </section>

        {/* Discover real events */}
        {events.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-4 text-xl font-bold text-ink-primary">
              Discover more events
            </h2>
            <div className="no-scrollbar flex gap-4 overflow-x-auto pb-4">
              {events.map((e) => (
                <EventCard key={e.id} event={e} variant="compact" />
              ))}
            </div>
          </section>
        )}
      </div>
    </AppShell>
  );
}
