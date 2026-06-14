"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft,
  Share2,
  Heart,
  Star,
  Calendar,
  Clock,
  Users,
  MapPin,
  ChevronDown,
  Tag,
  Loader2,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { SmartTag } from "@/components/SmartTag";
import { TicketSelector } from "@/components/TicketSelector";
import { getEvent } from "@/lib/data";
import { formatMoney } from "@/lib/money";
import { api } from "@/lib/api";
import { mapApiEvent, type ApiEvent } from "@/lib/map";
import type { Money, EventItem } from "@/lib/types";

const SERVICE_FEE_RATE = 0.02; // illustrative

export default function EventDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const router = useRouter();
  const [event, setEvent] = useState<EventItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [aboutOpen, setAboutOpen] = useState(false);
  const [promo, setPromo] = useState("");
  const [saved, setSaved] = useState(false);
  // Which performance (night) the user picked. Index into event.dates.
  const [dateIdx, setDateIdx] = useState(0);

  // Fetch the real event from the backend (Ticketmaster). Fall back to local sample
  // data when the id is a sample slug or the backend is unreachable.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const raw = (await api.getEvent(params.id)) as ApiEvent | null;
        if (!active) return;
        if (raw && raw.externalId) setEvent(mapApiEvent(raw));
        else setEvent(getEvent(params.id) ?? null);
      } catch {
        if (active) setEvent(getEvent(params.id) ?? null);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [params.id]);

  const tiers = useMemo(() => event?.ticketTiers ?? [], [event]);

  // All performances of this show (residencies list many; single events list one).
  const dates = useMemo(() => event?.dates ?? [], [event]);
  const multiDate = dates.length > 1;
  const selectedDate = dates[dateIdx] ?? dates[0];

  const setQty = (id: string, qty: number) =>
    setQuantities((prev) => ({ ...prev, [id]: qty }));

  const { totalTickets, subtotal } = useMemo(() => {
    let count = 0;
    let sum = 0;
    let currency = "USD";
    for (const tier of tiers) {
      const q = quantities[tier.id] ?? 0;
      count += q;
      sum += q * tier.price.amount;
      currency = tier.price.currency;
    }
    const subtotalMoney: Money = { amount: sum, currency };
    return { totalTickets: count, subtotal: subtotalMoney };
  }, [quantities, tiers]);

  const fee = Math.round(subtotal.amount * SERVICE_FEE_RATE);
  const total: Money = { amount: subtotal.amount + fee, currency: subtotal.currency };

  if (loading) {
    return (
      <AppShell>
        <div className="flex min-h-[60vh] items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AppShell>
    );
  }
  if (!event) notFound();

  const handleBook = () => {
    if (!event) return;
    const selection = tiers
      .filter((t) => (quantities[t.id] ?? 0) > 0)
      .map((t) => ({
        tierId: t.id,
        name: t.name,
        qty: quantities[t.id],
        price: t.price,
      }));
    if (typeof window !== "undefined") {
      sessionStorage.setItem(
        "asap.checkout",
        JSON.stringify({
          // Book the specific performance the user selected (its own bookable id).
          eventId: selectedDate?.externalId ?? event.id,
          eventTitle: event.title,
          date: selectedDate?.date ?? event.date,
          time: selectedDate?.time ?? event.time,
          venue: event.venue,
          selection,
          promo,
        }),
      );
    }
    router.push("/checkout");
  };

  return (
    <AppShell>
      {/* Hero */}
      <div className="relative h-72 w-full md:h-96">
        <Image
          src={event.image}
          alt={event.title}
          fill
          priority
          sizes="100vw"
          className="object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-black/30" />

        <div className="absolute inset-x-0 top-0 flex items-center justify-between p-4">
          <Link
            href="/events"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div className="flex gap-2">
            <button className="flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur">
              <Share2 className="h-5 w-5" />
            </button>
            <button
              onClick={() => setSaved((s) => !s)}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur"
            >
              <Heart
                className="h-5 w-5"
                fill={saved ? "currentColor" : "none"}
              />
            </button>
          </div>
        </div>

        <div className="absolute inset-x-0 bottom-0 p-5 text-white">
          <div className="mx-auto max-w-5xl">
            <div className="mb-2 flex items-center gap-2">
              <span className="rounded-full bg-white/90 px-3 py-1 text-xs font-semibold text-ink-primary">
                {event.category}
              </span>
              {event.onSale && <SmartTag kind="sale" />}
            </div>
            <h1 className="text-2xl font-extrabold md:text-4xl">{event.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-4 text-sm text-white/85">
              <span>by {event.host}</span>
              <span className="flex items-center gap-1">
                <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                {event.rating} ({(event.reviewCount ?? 0) / 1000}k reviews)
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-5xl px-4 pb-40 pt-6 md:px-6">
        {/* Info row */}
        <div className="grid grid-cols-3 gap-3">
          {[
            {
              Icon: Calendar,
              label: "Date",
              value: (selectedDate?.date ?? event.date).split(",")[0],
            },
            { Icon: Clock, label: "Time", value: selectedDate?.time ?? event.time ?? "—" },
            {
              Icon: Users,
              label: "Capacity",
              value: event.capacity?.toLocaleString() ?? "—",
            },
          ].map((info) => (
            <div
              key={info.label}
              className="rounded-md bg-white p-4 text-center card-shadow"
            >
              <info.Icon className="mx-auto h-5 w-5 text-primary" />
              <p className="mt-1.5 text-xs text-ink-secondary">{info.label}</p>
              <p className="font-bold text-ink-primary">{info.value}</p>
            </div>
          ))}
        </div>

        {/* Map placeholder */}
        <div className="mt-6 overflow-hidden rounded-lg card-shadow">
          <div className="relative flex h-44 items-center justify-center bg-gradient-to-br from-primary-50 to-primary-100">
            <div className="absolute inset-0 opacity-40 [background-image:linear-gradient(#c7cdf0_1px,transparent_1px),linear-gradient(90deg,#c7cdf0_1px,transparent_1px)] [background-size:24px_24px]" />
            <div className="relative flex flex-col items-center text-primary">
              <MapPin className="h-8 w-8" />
              <p className="mt-1 font-semibold">{event.venue}</p>
              <p className="text-sm text-ink-secondary">{event.city}</p>
            </div>
          </div>
        </div>

        {/* About */}
        <section className="mt-8">
          <button
            onClick={() => setAboutOpen((o) => !o)}
            className="flex w-full items-center justify-between"
          >
            <h2 className="text-xl font-bold text-ink-primary">About Event</h2>
            <ChevronDown
              className={`h-5 w-5 text-ink-secondary transition-transform ${
                aboutOpen ? "rotate-180" : ""
              }`}
            />
          </button>
          <p
            className={`mt-3 text-sm leading-relaxed text-ink-secondary ${
              aboutOpen ? "" : "line-clamp-3"
            }`}
          >
            {event.description}
          </p>
        </section>

        {/* Artists */}
        {event.artists && event.artists.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-4 text-xl font-bold text-ink-primary">
              Performing Artists
            </h2>
            <div className="no-scrollbar flex gap-4 overflow-x-auto pb-2">
              {event.artists.map((artist) => (
                <div key={artist.id} className="flex flex-col items-center gap-2">
                  <div className="relative h-16 w-16 overflow-hidden rounded-full ring-2 ring-primary/20">
                    <Image
                      src={artist.avatar}
                      alt={artist.name}
                      fill
                      sizes="64px"
                      className="object-cover"
                    />
                  </div>
                  <span className="whitespace-nowrap text-xs font-medium text-ink-primary">
                    {artist.name}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Genres */}
        {event.genres && (
          <div className="mt-6 flex flex-wrap gap-2">
            {event.genres.map((g) => (
              <span
                key={g}
                className="rounded-full bg-primary-50 px-3 py-1 text-xs font-medium text-primary"
              >
                {g}
              </span>
            ))}
          </div>
        )}

        {/* Select date — shown when the show runs on multiple nights (e.g. a residency) */}
        {multiDate && (
          <section className="mt-8">
            <h2 className="mb-1 text-xl font-bold text-ink-primary">
              Select a Date
            </h2>
            <p className="mb-4 text-sm text-ink-secondary">
              {dates.length} dates available at {event.venue} — choose the night
              you want tickets for.
            </p>
            <div className="no-scrollbar flex gap-3 overflow-x-auto pb-2">
              {dates.map((d, i) => {
                const active = i === dateIdx;
                const [mon, ...rest] = d.date.replace(",", "").split(" ");
                const dayNum = rest[0];
                const year = rest[1];
                return (
                  <button
                    key={d.externalId}
                    type="button"
                    disabled={d.soldOut}
                    onClick={() => setDateIdx(i)}
                    className={`flex min-w-[88px] shrink-0 flex-col items-center rounded-lg border-2 px-4 py-3 transition-colors ${
                      active
                        ? "border-primary bg-primary-50"
                        : "border-gray-200 bg-white hover:border-primary/40"
                    } ${d.soldOut ? "cursor-not-allowed opacity-40" : ""}`}
                  >
                    <span
                      className={`text-xs font-bold uppercase ${
                        active ? "text-primary" : "text-ink-secondary"
                      }`}
                    >
                      {mon}
                    </span>
                    <span className="text-2xl font-extrabold text-ink-primary">
                      {dayNum}
                    </span>
                    <span className="text-[11px] text-ink-secondary">{year}</span>
                    {d.time && (
                      <span className="mt-1 text-[11px] font-medium text-ink-secondary">
                        {d.time}
                      </span>
                    )}
                    {d.soldOut && (
                      <span className="mt-1 text-[10px] font-semibold text-tag-soldout">
                        Sold Out
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* Tickets */}
        {tiers.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-1 text-xl font-bold text-ink-primary">
              Select Tickets
            </h2>
            {selectedDate && (
              <p className="mb-4 text-sm text-ink-secondary">
                For <span className="font-semibold text-ink-primary">{selectedDate.date}</span>
                {selectedDate.time ? ` · ${selectedDate.time}` : ""}
              </p>
            )}
            <div className="flex flex-col gap-3">
              {tiers.map((tier) => (
                <TicketSelector
                  key={tier.id}
                  tier={tier}
                  quantity={quantities[tier.id] ?? 0}
                  onChange={setQty}
                />
              ))}
            </div>

            {/* Promo */}
            <div className="mt-4 flex items-center gap-2 rounded-md bg-white p-3 card-shadow">
              <Tag className="h-5 w-5 text-ink-secondary" />
              <input
                value={promo}
                onChange={(e) => setPromo(e.target.value.toUpperCase())}
                placeholder="Promo code (try NEON10)"
                className="w-full bg-transparent text-sm outline-none placeholder:text-ink-secondary"
              />
              <button className="rounded-md bg-primary-50 px-4 py-1.5 text-sm font-semibold text-primary">
                Apply
              </button>
            </div>
          </section>
        )}

        {/* Reviews */}
        {event.reviews && event.reviews.length > 0 && (
          <section className="mt-10">
            <h2 className="mb-4 text-xl font-bold text-ink-primary">Reviews</h2>
            <div className="flex flex-col gap-4">
              {event.reviews.map((review) => (
                <div
                  key={review.id}
                  className="rounded-md bg-white p-4 card-shadow"
                >
                  <div className="flex items-center gap-3">
                    <div className="relative h-10 w-10 overflow-hidden rounded-full">
                      <Image
                        src={review.avatar}
                        alt={review.author}
                        fill
                        sizes="40px"
                        className="object-cover"
                      />
                    </div>
                    <div>
                      <p className="font-semibold text-ink-primary">
                        {review.author}
                      </p>
                      <div className="flex items-center gap-0.5">
                        {Array.from({ length: review.rating }).map((_, j) => (
                          <Star
                            key={j}
                            className="h-3 w-3 fill-amber-400 text-amber-400"
                          />
                        ))}
                        <span className="ml-1 text-xs text-ink-secondary">
                          {review.date}
                        </span>
                      </div>
                    </div>
                  </div>
                  <p className="mt-3 text-sm text-ink-secondary">{review.body}</p>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      {/* Sticky bottom bar */}
      <AnimatePresence>
        {totalTickets > 0 && (
          <motion.div
            initial={{ y: 100 }}
            animate={{ y: 0 }}
            exit={{ y: 100 }}
            className="fixed inset-x-0 bottom-16 z-30 border-t border-gray-100 bg-white/95 backdrop-blur md:bottom-0"
          >
            <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3 md:px-6">
              <div>
                <p className="text-xs text-ink-secondary">
                  Total ({totalTickets} ticket{totalTickets > 1 ? "s" : ""}) incl.
                  fees
                </p>
                <p className="text-xl font-extrabold text-ink-primary">
                  {formatMoney(total)}
                </p>
              </div>
              <button
                onClick={handleBook}
                className="rounded-md bg-primary px-8 py-3 font-semibold text-white transition-colors hover:bg-primary-600"
              >
                Book Now
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </AppShell>
  );
}