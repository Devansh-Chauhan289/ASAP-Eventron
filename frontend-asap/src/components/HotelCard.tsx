"use client";

import Image from "next/image";
import { motion } from "framer-motion";
import {
  Star,
  MapPin,
  Wifi,
  Dumbbell,
  Waves,
  Coffee,
  Wine,
} from "lucide-react";
import type { Hotel } from "@/lib/types";
import { formatMoney } from "@/lib/money";

const AMENITY_ICON: Record<string, typeof Wifi> = {
  wifi: Wifi,
  gym: Dumbbell,
  pool: Waves,
  breakfast: Coffee,
  bar: Wine,
};

export function HotelCard({ hotel }: { hotel: Hotel }) {
  return (
    <motion.div
      whileHover={{ y: -3 }}
      className="overflow-hidden rounded-lg bg-white card-shadow"
    >
      <div className="relative h-40 w-full">
        <Image
          src={hotel.image}
          alt={hotel.name}
          fill
          sizes="(max-width: 768px) 100vw, 360px"
          className="object-cover"
        />
        <span className="absolute right-3 top-3 flex items-center gap-1 rounded-full bg-white/95 px-2.5 py-1 text-xs font-bold text-ink-primary">
          <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
          {hotel.rating}
        </span>
      </div>
      <div className="p-4">
        <h3 className="text-base font-bold text-ink-primary">{hotel.name}</h3>
        <p className="mt-1 flex items-center gap-1 text-xs text-ink-secondary">
          <MapPin className="h-3.5 w-3.5" />
          {hotel.distance}
        </p>

        <div className="mt-3 flex gap-2">
          {hotel.amenities.map((a) => {
            const Icon = AMENITY_ICON[a];
            return (
              <span
                key={a}
                title={a}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-50 text-primary"
              >
                {Icon ? <Icon className="h-4 w-4" /> : a[0]}
              </span>
            );
          })}
        </div>

        <div className="mt-4 flex items-center justify-between">
          <div>
            <span className="text-lg font-bold text-ink-primary">
              {formatMoney(hotel.pricePerNight)}
            </span>
            <span className="text-xs text-ink-secondary"> / night</span>
          </div>
          <button className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-600">
            Book Now
          </button>
        </div>
      </div>
    </motion.div>
  );
}