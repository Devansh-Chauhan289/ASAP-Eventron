"use client";

import { useState } from "react";
import { Download, Share2, Calendar, Users } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { TimelineItem } from "@/components/TimelineItem";
import { TransportCard } from "@/components/TransportCard";
import { HotelCard } from "@/components/HotelCard";
import { SmartTag } from "@/components/SmartTag";
import { Reveal } from "@/components/Reveal";
import { trip, transportOptions, hotels } from "@/lib/data";

export default function DashboardPage() {
  const [activeDay, setActiveDay] = useState(trip.itinerary[0].day);
  const day = trip.itinerary.find((d) => d.day === activeDay) ?? trip.itinerary[0];

  const visibleDays = trip.itinerary.slice(0, 4);
  const extraDays = trip.days - visibleDays.length;

  const stats = [
    { value: trip.days, label: "Days" },
    { value: trip.stops, label: "Stops" },
    { value: trip.hotels, label: "Hotels" },
    { value: trip.flights, label: "Flights" },
  ];

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl px-4 pt-6 md:px-6">
        {/* Header */}
        <Reveal>
          <p className="text-xs font-bold uppercase tracking-widest text-primary">
            Trip Dashboard
          </p>
          <h1 className="mt-1 text-2xl font-extrabold text-ink-primary md:text-3xl">
            {trip.name}
          </h1>
          <p className="mt-1 flex items-center gap-1 text-sm text-ink-secondary">
            <Calendar className="h-4 w-4" />
            {trip.dateRange}
          </p>
        </Reveal>

        {/* Stats row */}
        <Reveal delay={0.05}>
          <div className="mt-5 grid grid-cols-4 gap-3">
            {stats.map((s) => (
              <div
                key={s.label}
                className="rounded-md bg-white p-4 text-center card-shadow"
              >
                <p className="text-2xl font-extrabold text-ink-primary">
                  {s.value}
                </p>
                <p className="text-xs text-ink-secondary">{s.label}</p>
              </div>
            ))}
          </div>
        </Reveal>

        {/* Day tabs */}
        <div className="no-scrollbar mt-6 flex gap-2 overflow-x-auto">
          {visibleDays.map((d) => (
            <button
              key={d.day}
              onClick={() => setActiveDay(d.day)}
              className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
                activeDay === d.day
                  ? "bg-primary text-white"
                  : "bg-white text-ink-secondary card-shadow"
              }`}
            >
              {d.label}
            </button>
          ))}
          {extraDays > 0 && (
            <span className="flex items-center whitespace-nowrap rounded-full bg-white px-4 py-2 text-sm font-semibold text-ink-secondary card-shadow">
              +{extraDays}
            </span>
          )}
        </div>

        <div className="mt-6 grid gap-8 lg:grid-cols-[1.2fr_1fr]">
          {/* Timeline */}
          <section>
            <h2 className="mb-4 text-lg font-bold text-ink-primary">
              {day.label} Itinerary
            </h2>
            <div>
              {day.items.map((item, i) => (
                <TimelineItem
                  key={item.id}
                  item={item}
                  index={i}
                  last={i === day.items.length - 1}
                />
              ))}
            </div>

            <div className="mt-2 flex gap-3">
              <button className="flex flex-1 items-center justify-center gap-2 rounded-md border border-gray-200 bg-white py-2.5 text-sm font-semibold text-ink-primary hover:bg-gray-50">
                <Download className="h-4 w-4" /> Download PDF
              </button>
              <button className="flex flex-1 items-center justify-center gap-2 rounded-md bg-primary py-2.5 text-sm font-semibold text-white hover:bg-primary-600">
                <Share2 className="h-4 w-4" /> Share Trip
              </button>
            </div>
          </section>

          {/* Smart cards */}
          <section className="flex flex-col gap-4">
            <h2 className="text-lg font-bold text-ink-primary">Smart Suggestions</h2>

            {/* Recommended event card */}
            <Reveal>
              <div className="rounded-lg bg-white p-5 card-shadow">
                <div className="flex items-center justify-between">
                  <SmartTag kind="recommended" />
                  <span className="flex items-center gap-1 text-xs text-ink-secondary">
                    <Users className="h-3.5 w-3.5" /> 3 friends attending
                  </span>
                </div>
                <h3 className="mt-3 font-bold text-ink-primary">
                  TeamLab Borderless
                </h3>
                <p className="text-sm text-ink-secondary">
                  Digital art museum · Azabudai Hills
                </p>
                <p className="mt-2 rounded-md bg-primary-50 px-3 py-2 text-xs font-medium text-primary">
                  Matches your interest in Tech
                </p>
              </div>
            </Reveal>

            {/* Best option transport */}
            <Reveal delay={0.05}>
              <TransportCard option={transportOptions[0]} />
            </Reveal>

            {/* Hotel */}
            <Reveal delay={0.1}>
              <HotelCard hotel={hotels[1]} />
            </Reveal>
          </section>
        </div>
      </div>
    </AppShell>
  );
}