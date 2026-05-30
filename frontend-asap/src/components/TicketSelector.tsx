"use client";

import { Minus, Plus, RefreshCw, Send, Check, X } from "lucide-react";
import type { TicketTier } from "@/lib/types";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { SmartTag } from "./SmartTag";

interface TicketSelectorProps {
  tier: TicketTier;
  quantity: number;
  onChange: (id: string, quantity: number) => void;
  max?: number;
}

function PolicyChip({
  ok,
  label,
  Icon,
}: {
  ok: boolean;
  label: string;
  Icon: typeof RefreshCw;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        ok ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-400",
      )}
    >
      <Icon className="h-3 w-3" />
      {label}
      {ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
    </span>
  );
}

export function TicketSelector({
  tier,
  quantity,
  onChange,
  max = 10,
}: TicketSelectorProps) {
  const soldOut = tier.available <= 0;
  const cap = Math.min(max, tier.available);

  return (
    <div
      className={cn(
        "rounded-lg border bg-white p-4 transition-colors",
        quantity > 0 ? "border-primary" : "border-gray-200",
        soldOut && "opacity-70",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="font-bold text-ink-primary">{tier.name}</h4>
            {soldOut && <SmartTag kind="soldout" />}
          </div>
          <p className="mt-0.5 text-sm text-ink-secondary">{tier.description}</p>

          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-secondary">
            {tier.perks.map((p) => (
              <li key={p} className="flex items-center gap-1">
                <Check className="h-3 w-3 text-primary" />
                {p}
              </li>
            ))}
          </ul>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <PolicyChip
              ok={tier.refundable}
              label="Refundable"
              Icon={RefreshCw}
            />
            <PolicyChip
              ok={tier.transferable}
              label="Transferable"
              Icon={Send}
            />
          </div>
        </div>

        <div className="shrink-0 text-right">
          <p className="text-lg font-bold text-ink-primary">
            {formatMoney(tier.price)}
          </p>
          <p className="text-[11px] text-ink-secondary">/ person</p>
          {!soldOut && (
            <p className="mt-1 text-[11px] font-medium text-amber-600">
              {tier.available.toLocaleString()} left
            </p>
          )}
        </div>
      </div>

      {!soldOut && (
        <div className="mt-4 flex items-center justify-end gap-3">
          <button
            type="button"
            aria-label="Decrease quantity"
            disabled={quantity <= 0}
            onClick={() => onChange(tier.id, Math.max(0, quantity - 1))}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-gray-200 text-ink-primary disabled:opacity-30"
          >
            <Minus className="h-4 w-4" />
          </button>
          <span className="w-6 text-center text-base font-bold">{quantity}</span>
          <button
            type="button"
            aria-label="Increase quantity"
            disabled={quantity >= cap}
            onClick={() => onChange(tier.id, Math.min(cap, quantity + 1))}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-white disabled:opacity-30"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}