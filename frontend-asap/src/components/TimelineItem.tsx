"use client";

import { motion } from "framer-motion";
import { Plane, MapPin, BedDouble, UtensilsCrossed } from "lucide-react";
import type { TimelineItemData, TimelineKind } from "@/lib/types";
import { cn } from "@/lib/utils";

const KIND_META: Record<
  TimelineKind,
  { Icon: typeof Plane; label: string; color: string; bg: string }
> = {
  transport: {
    Icon: Plane,
    label: "TRANSPORT",
    color: "text-primary",
    bg: "bg-primary-50",
  },
  event: {
    Icon: MapPin,
    label: "EVENT",
    color: "text-tag-recommended",
    bg: "bg-purple-50",
  },
  stay: {
    Icon: BedDouble,
    label: "STAY",
    color: "text-tag-fastest",
    bg: "bg-green-50",
  },
  food: {
    Icon: UtensilsCrossed,
    label: "EVENT",
    color: "text-tag-lowprice",
    bg: "bg-amber-50",
  },
};

export function TimelineItem({
  item,
  index,
  last,
}: {
  item: TimelineItemData;
  index: number;
  last?: boolean;
}) {
  const meta = KIND_META[item.kind];
  return (
    <motion.div
      initial={{ opacity: 0, x: -16 }}
      whileInView={{ opacity: 1, x: 0 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ delay: index * 0.08 }}
      className="relative flex gap-4 pb-6 last:pb-0"
    >
      {/* connector line */}
      {!last && (
        <span className="absolute left-[19px] top-10 bottom-0 w-px bg-gray-200" />
      )}

      <div
        className={cn(
          "z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
          meta.bg,
          meta.color,
        )}
      >
        <meta.Icon className="h-5 w-5" />
      </div>

      <div className="flex-1 rounded-md bg-white p-3 card-shadow">
        <div className="flex items-center justify-between">
          <span className={cn("text-[11px] font-bold tracking-wide", meta.color)}>
            {item.kind === "food" ? "FOOD" : meta.label}
          </span>
          <span className="text-sm font-bold text-ink-primary">{item.time}</span>
        </div>
        <h4 className="mt-1 font-semibold text-ink-primary">{item.title}</h4>
        <p className="text-sm text-ink-secondary">{item.subtitle}</p>
      </div>
    </motion.div>
  );
}