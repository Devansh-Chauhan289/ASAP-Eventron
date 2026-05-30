"use client";

import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";
import { Calendar, MapPin, Star, Users } from "lucide-react";
import type { EventItem } from "@/lib/types";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { SmartTag } from "./SmartTag";

interface EventCardProps {
  event: EventItem;
  variant?: "featured" | "list" | "compact";
  className?: string;
}

function PriceBadge({ event }: { event: EventItem }) {
  if (event.soldOut) return <SmartTag kind="soldout" />;
  if (!event.price) return <SmartTag kind="free" />;
  return (
    <span className="text-base font-bold text-ink-primary">
      {formatMoney(event.price)}
    </span>
  );
}

export function EventCard({
  event,
  variant = "featured",
  className,
}: EventCardProps) {
  const href = `/events/${event.slug}`;

  // ── Featured / grid (large, dark overlay) ──
  if (variant === "featured") {
    return (
      <motion.div
        whileHover={{ scale: 1.02 }}
        transition={{ type: "spring", stiffness: 300, damping: 22 }}
        className={cn(
          "group relative h-[360px] w-[300px] shrink-0 overflow-hidden rounded-lg card-shadow",
          className,
        )}
      >
        <Link href={href} className="block h-full w-full">
          <Image
            src={event.image}
            alt={event.title}
            fill
            sizes="300px"
            className="object-cover transition-transform duration-500 group-hover:scale-110"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />

          <div className="absolute left-4 top-4 flex gap-2">
            <span className="rounded-full bg-white/90 px-3 py-1 text-xs font-semibold text-ink-primary">
              {event.category}
            </span>
            {event.onSale && <SmartTag kind="sale" />}
          </div>

          <div className="absolute inset-x-0 bottom-0 p-5 text-white">
            <div className="mb-1 flex items-center gap-1 text-xs font-medium text-white/80">
              <Calendar className="h-3.5 w-3.5" />
              {event.date}
            </div>
            <h3 className="mb-1 text-lg font-bold leading-snug">
              {event.title}
            </h3>
            <div className="mb-3 flex items-center gap-1 text-sm text-white/80">
              <MapPin className="h-3.5 w-3.5" />
              {event.venue}, {event.city}
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1 text-xs text-white/90">
                <Users className="h-3.5 w-3.5" />+{event.attendees} Going
              </span>
              <span className="rounded-md bg-primary px-4 py-1.5 text-sm font-semibold transition-colors group-hover:bg-primary-600">
                {event.soldOut ? "Sold Out" : "Book"}
              </span>
            </div>
          </div>
        </Link>
      </motion.div>
    );
  }

  // ── Compact (small recommended card) ──
  if (variant === "compact") {
    return (
      <motion.div
        whileHover={{ y: -4 }}
        className={cn(
          "w-[220px] shrink-0 overflow-hidden rounded-md bg-white card-shadow",
          className,
        )}
      >
        <Link href={href}>
          <div className="relative h-32 w-full">
            <Image
              src={event.image}
              alt={event.title}
              fill
              sizes="220px"
              className="object-cover"
            />
            <span className="absolute left-2 top-2 rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-semibold text-primary">
              {event.category}
            </span>
          </div>
          <div className="p-3">
            <h4 className="truncate text-sm font-semibold text-ink-primary">
              {event.title}
            </h4>
            <p className="mt-0.5 truncate text-xs text-ink-secondary">
              {event.city}
            </p>
            <div className="mt-2 flex items-center justify-between">
              <span className="flex items-center gap-1 text-xs font-medium text-ink-primary">
                <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                {event.rating}
              </span>
              <PriceBadge event={event} />
            </div>
          </div>
        </Link>
      </motion.div>
    );
  }

  // ── List (horizontal) ──
  return (
    <motion.div
      whileHover={{ y: -2 }}
      className={cn(
        "flex gap-4 overflow-hidden rounded-md bg-white p-3 card-shadow",
        className,
      )}
    >
      <Link href={href} className="relative h-28 w-28 shrink-0 sm:h-32 sm:w-40">
        <Image
          src={event.image}
          alt={event.title}
          fill
          sizes="160px"
          className="rounded-md object-cover"
        />
      </Link>
      <div className="flex min-w-0 flex-1 flex-col justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="rounded-full bg-primary-50 px-2 py-0.5 text-[11px] font-semibold text-primary">
              {event.category}
            </span>
            {event.onSale && <SmartTag kind="sale" />}
          </div>
          <Link href={href}>
            <h3 className="truncate text-base font-bold text-ink-primary hover:text-primary">
              {event.title}
            </h3>
          </Link>
          <div className="mt-1 flex items-center gap-3 text-xs text-ink-secondary">
            <span className="flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" />
              {event.date}
            </span>
            <span className="flex items-center gap-1 truncate">
              <MapPin className="h-3.5 w-3.5" />
              {event.venue}
            </span>
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between">
          <PriceBadge event={event} />
          {event.soldOut ? (
            <span className="rounded-md bg-gray-100 px-4 py-1.5 text-sm font-semibold text-gray-400">
              Sold Out
            </span>
          ) : (
            <Link
              href={href}
              className="rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-primary-600"
            >
              Book
            </Link>
          )}
        </div>
      </div>
    </motion.div>
  );
}