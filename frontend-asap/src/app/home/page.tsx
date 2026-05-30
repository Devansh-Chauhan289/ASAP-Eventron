"use client";

import { useState } from "react";
import Image from "next/image";
import { Search } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { EventCard } from "@/components/EventCard";
import { FilterChips } from "@/components/FilterChips";
import { Reveal } from "@/components/Reveal";
import { featuredEvents, recommendedEvents } from "@/lib/data";

const CATEGORIES = [
  "All",
  "Concerts",
  "Tech",
  "Sports",
  "Festivals",
  "Workshops",
  "Arts",
];

export default function HomePage() {
  const [filter, setFilter] = useState("All");
  const [query, setQuery] = useState("");

  const matchFilter = (cat: string) => filter === "All" || cat === filter;

  const featured = featuredEvents.filter(
    (e) =>
      matchFilter(e.category) &&
      e.title.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <AppShell>
      <div className="mx-auto max-w-7xl px-4 pt-6 md:px-6">
        {/* Top bar */}
        <Reveal className="flex items-center justify-between">
          <div>
            <p className="text-sm text-ink-secondary">Good Morning 👋</p>
            <h1 className="text-2xl font-extrabold text-ink-primary">
              Jordan Mitchell
            </h1>
          </div>
          <div className="relative h-11 w-11 overflow-hidden rounded-full ring-2 ring-primary/20">
            <Image
              src="https://i.pravatar.cc/120?img=15"
              alt="Your avatar"
              fill
              sizes="44px"
              className="object-cover"
            />
          </div>
        </Reveal>

        {/* Search */}
        <Reveal delay={0.05} className="mt-5">
          <div className="flex items-center gap-3 rounded-md bg-white px-4 py-3 card-shadow">
            <Search className="h-5 w-5 text-ink-secondary" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search events, cities, artists..."
              className="w-full bg-transparent text-sm outline-none placeholder:text-ink-secondary"
            />
          </div>
        </Reveal>

        {/* Filter chips */}
        <Reveal delay={0.1} className="mt-5">
          <FilterChips options={CATEGORIES} value={filter} onChange={(v) => setFilter(v as string)} />
        </Reveal>

        {/* Featured */}
        <section className="mt-8">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-bold text-ink-primary">Featured Events</h2>
            <span className="text-sm text-ink-secondary">Swipe →</span>
          </div>
          <div className="no-scrollbar flex gap-5 overflow-x-auto pb-4">
            {featured.length ? (
              featured.map((e) => (
                <EventCard key={e.id} event={e} variant="featured" />
              ))
            ) : (
              <p className="text-sm text-ink-secondary">No events match.</p>
            )}
          </div>
        </section>

        {/* Recommended */}
        <section className="mt-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-bold text-ink-primary">
              Recommended for You
            </h2>
          </div>
          <div className="no-scrollbar flex gap-4 overflow-x-auto pb-4">
            {recommendedEvents.map((e) => (
              <EventCard key={e.id} event={e} variant="compact" />
            ))}
          </div>
        </section>
      </div>
    </AppShell>
  );
}