"use client";

import { CheckCircle2, Clock, XCircle } from "lucide-react";

// Mirrors the backend time-based refund policy (Section 4.5):
//   ≥10 days → 100%, 5–9 days → 50%, <5 days/day-of → 0%.
const BANDS = [
  {
    percent: 100,
    title: "100% refund",
    window: "10+ days before the event",
    Icon: CheckCircle2,
    tone: "text-green-600 bg-green-50 border-green-200",
  },
  {
    percent: 50,
    title: "50% refund",
    window: "5–9 days before the event",
    Icon: Clock,
    tone: "text-amber-600 bg-amber-50 border-amber-200",
  },
  {
    percent: 0,
    title: "No refund",
    window: "Less than 5 days / day of event",
    Icon: XCircle,
    tone: "text-red-600 bg-red-50 border-red-200",
  },
];

interface RefundTimelineProps {
  /** Highlight the band that currently applies (0 | 50 | 100). */
  highlightPercent?: number | null;
  daysUntilEvent?: number | null;
  compact?: boolean;
}

export function RefundTimeline({
  highlightPercent,
  daysUntilEvent,
  compact,
}: RefundTimelineProps) {
  return (
    <div>
      {!compact && (
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-bold text-ink-primary">
            Cancellation &amp; refund policy
          </h3>
          {daysUntilEvent != null && (
            <span className="text-xs text-ink-secondary">
              {daysUntilEvent} day{daysUntilEvent === 1 ? "" : "s"} until event
            </span>
          )}
        </div>
      )}
      <div className="space-y-2">
        {BANDS.map((b) => {
          const active = highlightPercent === b.percent;
          return (
            <div
              key={b.percent}
              className={`flex items-center gap-3 rounded-md border px-3 py-2.5 transition-all ${
                active ? b.tone + " ring-2 ring-offset-1" : "border-gray-100 bg-white"
              }`}
            >
              <b.Icon
                className={`h-5 w-5 shrink-0 ${active ? "" : "text-ink-secondary"}`}
              />
              <div className="min-w-0 flex-1">
                <p
                  className={`text-sm font-semibold ${
                    active ? "" : "text-ink-primary"
                  }`}
                >
                  {b.title}
                </p>
                <p className="text-xs text-ink-secondary">{b.window}</p>
              </div>
              {active && (
                <span className="rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-bold uppercase">
                  Applies now
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
