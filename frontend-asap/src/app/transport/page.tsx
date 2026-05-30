"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { MapPin, Sparkles, TrendingUp, Clock, BadgeCheck } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { TransportCard } from "@/components/TransportCard";
import { Reveal } from "@/components/Reveal";
import { transportOptions } from "@/lib/data";

const TABS = ["Best Value", "Fastest", "Cheapest"] as const;
type Tab = (typeof TABS)[number];

function durationToMinutes(d: string): number {
  const h = /(\d+)h/.exec(d)?.[1] ?? "0";
  const m = /(\d+)m/.exec(d)?.[1] ?? "0";
  return Number(h) * 60 + Number(m);
}

export default function TransportPage() {
  const [tab, setTab] = useState<Tab>("Best Value");

  const sorted = useMemo(() => {
    const list = [...transportOptions];
    switch (tab) {
      case "Fastest":
        return list.sort(
          (a, b) => durationToMinutes(a.duration) - durationToMinutes(b.duration),
        );
      case "Cheapest":
        return list.sort((a, b) => a.price.amount - b.price.amount);
      default:
        // Best Value: recommended first, then by price.
        return list.sort(
          (a, b) =>
            Number(!!b.recommended) - Number(!!a.recommended) ||
            a.price.amount - b.price.amount,
        );
    }
  }, [tab]);

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl px-4 pt-6 md:px-6">
        {/* Context banner */}
        <Reveal>
          <div className="rounded-lg bg-bg-dark p-5 text-white">
            <p className="text-xs font-medium uppercase tracking-wide text-white/60">
              Getting to
            </p>
            <h1 className="mt-1 text-xl font-bold">
              Neon Pulse Music Festival 2025
            </h1>
            <p className="text-sm text-white/70">Sat Dec 14, 8:00 PM</p>
            <div className="mt-3 flex items-center gap-2 text-sm">
              <MapPin className="h-4 w-4 text-primary-100" />
              <span className="font-medium">Los Angeles</span>
              <span className="text-white/50">→</span>
              <span className="font-medium">New York</span>
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/70">
                auto-detected
              </span>
            </div>
          </div>
        </Reveal>

        {/* Filter tabs */}
        <div className="mt-5 flex gap-2">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
                tab === t
                  ? "bg-primary text-white"
                  : "bg-white text-ink-secondary card-shadow"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Transport cards */}
        <div className="mt-5 flex flex-col gap-4">
          {sorted.map((option, i) => (
            <Reveal key={option.id} delay={i * 0.08}>
              <TransportCard option={option} />
            </Reveal>
          ))}
        </div>

        {/* ASAP Intelligence panel */}
        <Reveal delay={0.1}>
          <motion.div className="mt-6 rounded-lg bg-primary p-6 text-white">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5" />
              <h3 className="font-bold">ASAP Intelligence</h3>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-white/90">
              Based on your location in LA, the event start time, and typical
              check-in windows, United Airlines gives the optimal buffer. 94% of
              ASAP users choose this option.
            </p>
            <div className="mt-5 grid grid-cols-3 gap-3">
              {[
                { Icon: TrendingUp, stat: "94%", label: "chose this" },
                { Icon: Clock, stat: "3h", label: "pre-show arrival" },
                { Icon: BadgeCheck, stat: "✓", label: "Price matched" },
              ].map((s) => (
                <div
                  key={s.label}
                  className="rounded-md bg-white/10 p-3 text-center"
                >
                  <s.Icon className="mx-auto h-5 w-5" />
                  <p className="mt-1 text-lg font-extrabold">{s.stat}</p>
                  <p className="text-[11px] text-white/70">{s.label}</p>
                </div>
              ))}
            </div>
          </motion.div>
        </Reveal>
      </div>
    </AppShell>
  );
}