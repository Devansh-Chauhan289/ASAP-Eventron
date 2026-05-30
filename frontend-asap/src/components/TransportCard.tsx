"use client";

import { motion } from "framer-motion";
import { ArrowRight, AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import type { TransportOption } from "@/lib/types";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { SmartTag } from "./SmartTag";

interface TransportCardProps {
  option: TransportOption;
  onSelect?: (id: string) => void;
}

const NOTE_TONE: Record<
  NonNullable<TransportOption["noteTone"]>,
  { className: string; Icon: typeof CheckCircle2 }
> = {
  positive: { className: "text-green-600", Icon: CheckCircle2 },
  warning: { className: "text-amber-600", Icon: AlertTriangle },
  danger: { className: "text-red-600", Icon: AlertTriangle },
};

export function TransportCard({ option, onSelect }: TransportCardProps) {
  const tone = option.noteTone ? NOTE_TONE[option.noteTone] : null;

  return (
    <motion.div
      whileHover={{ y: -3 }}
      className={cn(
        "rounded-lg bg-white p-5 card-shadow",
        option.recommended && "border-2 border-tag-fastest",
      )}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl">{option.icon}</span>
          <div>
            <p className="font-semibold text-ink-primary">{option.carrier}</p>
            <p className="text-xs text-ink-secondary">{option.code}</p>
          </div>
        </div>
        {option.tag && <SmartTag kind={option.tag} pulse={option.tag === "best"} />}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <div className="text-center">
          <p className="text-lg font-bold text-ink-primary">{option.depart}</p>
          <p className="text-xs text-ink-secondary">{option.originCode}</p>
        </div>
        <div className="flex flex-1 flex-col items-center px-3">
          <span className="flex items-center gap-1 text-xs text-ink-secondary">
            <Clock className="h-3 w-3" />
            {option.duration}
          </span>
          <div className="my-1 flex w-full items-center">
            <span className="h-px flex-1 bg-gray-200" />
            <ArrowRight className="h-4 w-4 text-gray-300" />
            <span className="h-px flex-1 bg-gray-200" />
          </div>
          <span className="text-xs text-ink-secondary">
            {option.stops === 0
              ? "Non-stop"
              : `${option.stops} stop${option.stops > 1 ? "s" : ""}`}
          </span>
        </div>
        <div className="text-center">
          <p className="text-lg font-bold text-ink-primary">{option.arrive}</p>
          <p className="text-xs text-ink-secondary">{option.destinationCode}</p>
        </div>
      </div>

      {option.note && tone && (
        <div
          className={cn(
            "mt-3 flex items-center gap-2 rounded-md bg-gray-50 px-3 py-2 text-sm font-medium",
            tone.className,
          )}
        >
          <tone.Icon className="h-4 w-4 shrink-0" />
          {option.note}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between">
        <span className="text-xl font-bold text-ink-primary">
          {formatMoney(option.price)}
        </span>
        <button
          type="button"
          onClick={() => onSelect?.(option.id)}
          className={cn(
            "rounded-md px-5 py-2 text-sm font-semibold transition-colors",
            option.recommended
              ? "bg-tag-fastest text-white hover:brightness-95"
              : "bg-primary text-white hover:bg-primary-600",
          )}
        >
          {option.recommended ? "Select Best Option" : "Select"}
        </button>
      </div>
    </motion.div>
  );
}