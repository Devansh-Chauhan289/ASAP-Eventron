"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { Search, Loader2 } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { EventCard } from "@/components/EventCard";
import { FilterChips } from "@/components/FilterChips";
import { Reveal } from "@/components/Reveal";
import { featuredEvents as mockFeatured } from "@/lib/data";
import { api } from "@/lib/api";
import { mapApiEvent, type ApiEvent } from "@/lib/map";
import { getStoredUser } from "@/lib/auth";
import type { EventItem } from "@/lib/types";

const CATEGORIES = ["All", "Concerts", "Sports", "Arts", "Festivals"];

export default function HomePage() {
  const [filter, setFilter] = useState("All");
  const [query, setQuery] = useState("");
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const reqId = useRef(0);
  const [name, setName] = useState("there");

  useEffect(() => {
    setName(getStoredUser()?.displayName ?? "there");
  }, []);

  // Live Ticketmaster events (debounced on the search query).
  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await api.searchEvents({
          q: query.trim() || undefined,
          limit: 24,
        });
        if (id !== reqId.current) return;
        setEvents((res.data as ApiEvent[]).map(mapApiEvent));
      } catch {
        if (id === reqId.current) setEvents(mockFeatured);
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query]);

  const matchFilter = (cat: string) => filter === "All" || cat === filter;
  const filtered = useMemo(
    () => events.filter((e) => matchFilter(e.category)),
    [events, filter],
  );
  const featured = filtered.slice(0, 8);
  const recommended = filtered.slice(8, 16);

  return (
    <AppShell>
      <div className="mx-auto max-w-7xl px-4 pt-6 md:px-6">
        <Reveal className="flex items-center justify-between">
          <div>
            <p className="text-sm text-ink-secondary">Good day 👋</p>
            <h1 className="text-2xl font-extrabold text-ink-primary">{name}</h1>
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

        <Reveal delay={0.05} className="mt-5">
          <div className="flex items-center gap-3 rounded-md bg-white px-4 py-3 card-shadow">
            <Search className="h-5 w-5 text-ink-secondary" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search live events (powered by Ticketmaster)…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-ink-secondary"
            />
            {loading && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
          </div>
        </Reveal>

        <Reveal delay={0.1} className="mt-5">
          <FilterChips
            options={CATEGORIES}
            value={filter}
            onChange={(v) => setFilter(v as string)}
          />
        </Reveal>

        <section className="mt-8">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-bold text-ink-primary">Featured Events</h2>
            <span className="text-sm text-ink-secondary">Swipe →</span>
          </div>
          <div className="no-scrollbar flex gap-5 overflow-x-auto pb-4">
            {loading && featured.length === 0 ? (
              <div className="flex h-[360px] w-full items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : featured.length ? (
              featured.map((e) => (
                <EventCard key={e.id} event={e} variant="featured" />
              ))
            ) : (
              <p className="text-sm text-ink-secondary">No events found.</p>
            )}
          </div>
        </section>

        {recommended.length > 0 && (
          <section className="mt-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-bold text-ink-primary">
                More events near you
              </h2>
            </div>
            <div className="no-scrollbar flex gap-4 overflow-x-auto pb-4">
              {recommended.map((e) => (
                <EventCard key={e.id} event={e} variant="compact" />
              ))}
            </div>
          </section>
        )}
      </div>
    </AppShell>
  );
}
