"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, SlidersHorizontal, ChevronDown, Loader2 } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { EventCard } from "@/components/EventCard";
import { FilterChips } from "@/components/FilterChips";
import { Reveal } from "@/components/Reveal";
import { events as mockEvents } from "@/lib/data";
import { api } from "@/lib/api";
import { mapApiEvent, type ApiEvent } from "@/lib/map";
import type { EventItem } from "@/lib/types";

const CATEGORIES = ["All", "Concerts", "Sports", "Arts", "Festivals"];
const SORTS = ["Newest First", "Price: Low to High", "Price: High to Low", "Top Rated"];
const PAGE_SIZE = 6;

export default function EventsPage() {
  const [selected, setSelected] = useState<string[]>(["All"]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState(SORTS[0]);
  const [visible, setVisible] = useState(PAGE_SIZE);

  const [results, setResults] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [usingFallback, setUsingFallback] = useState(false);
  const reqId = useRef(0);

  // Fetch real Ticketmaster events from the backend (debounced on the search query).
  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await api.searchEvents({
          q: query.trim() || undefined,
          limit: 24,
        });
        if (id !== reqId.current) return; // a newer query superseded this one
        const mapped = (res.data as ApiEvent[]).map(mapApiEvent);
        setResults(mapped);
        setUsingFallback(false);
      } catch {
        if (id !== reqId.current) return;
        // Backend/Ticketmaster unreachable — fall back to local sample data.
        setResults(mockEvents);
        setUsingFallback(true);
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query]);

  const filtered = useMemo(() => {
    let list = results.filter(
      (e) => selected.includes("All") || selected.includes(e.category),
    );
    const priceOf = (p: EventItem["price"]) => p?.amount ?? 0;
    switch (sort) {
      case "Price: Low to High":
        list = [...list].sort((a, b) => priceOf(a.price) - priceOf(b.price));
        break;
      case "Price: High to Low":
        list = [...list].sort((a, b) => priceOf(b.price) - priceOf(a.price));
        break;
      case "Top Rated":
        list = [...list].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
        break;
      default:
        list = [...list].sort((a, b) => b.isoDate.localeCompare(a.isoDate));
    }
    return list;
  }, [results, selected, sort]);

  const shown = filtered.slice(0, visible);
  const hasMore = visible < filtered.length;

  return (
    <AppShell>
      <div className="mx-auto max-w-7xl px-4 pt-6 md:px-6">
        <Reveal>
          <h1 className="text-2xl font-extrabold text-ink-primary md:text-3xl">
            All Events
          </h1>
        </Reveal>

        <Reveal delay={0.05} className="mt-4">
          <div className="flex items-center gap-3 rounded-md bg-white px-4 py-3 card-shadow">
            <Search className="h-5 w-5 text-ink-secondary" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setVisible(PAGE_SIZE);
              }}
              placeholder="Search live events (powered by Ticketmaster)…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-ink-secondary"
            />
            {loading && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
          </div>
        </Reveal>

        <div className="mt-6 flex gap-8">
          <aside className="hidden w-56 shrink-0 lg:block">
            <div className="sticky top-24 rounded-lg bg-white p-5 card-shadow">
              <div className="mb-4 flex items-center gap-2 font-semibold text-ink-primary">
                <SlidersHorizontal className="h-4 w-4" />
                Filters
              </div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-secondary">
                Category
              </p>
              <div className="flex flex-col gap-2">
                {CATEGORIES.map((cat) => {
                  const active = selected.includes(cat);
                  return (
                    <button
                      key={cat}
                      onClick={() => {
                        setSelected(
                          cat === "All"
                            ? ["All"]
                            : active
                              ? selected.filter((c) => c !== cat)
                              : [...selected.filter((c) => c !== "All"), cat],
                        );
                        setVisible(PAGE_SIZE);
                      }}
                      className={`rounded-md px-3 py-2 text-left text-sm transition-colors ${
                        active
                          ? "bg-primary-50 font-semibold text-primary"
                          : "text-ink-secondary hover:bg-gray-50"
                      }`}
                    >
                      {cat}
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>

          <div className="min-w-0 flex-1">
            <div className="lg:hidden">
              <FilterChips
                options={CATEGORIES}
                value={selected}
                onChange={(v) => {
                  setSelected(v as string[]);
                  setVisible(PAGE_SIZE);
                }}
                multiSelect
              />
            </div>

            <div className="mt-4 flex items-center justify-between">
              <p className="text-sm text-ink-secondary">
                <span className="font-semibold text-ink-primary">
                  {filtered.length}
                </span>{" "}
                events found
                {usingFallback && (
                  <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                    sample data (backend unreachable)
                  </span>
                )}
              </p>
              <div className="relative">
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                  className="appearance-none rounded-md border border-gray-200 bg-white py-2 pl-3 pr-9 text-sm font-medium text-ink-primary outline-none"
                >
                  {SORTS.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-secondary" />
              </div>
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              {shown.map((e, i) => (
                <Reveal key={e.id} delay={(i % PAGE_SIZE) * 0.05}>
                  <EventCard event={e} variant="list" />
                </Reveal>
              ))}
            </div>

            {loading && shown.length === 0 && (
              <div className="mt-12 flex justify-center text-ink-secondary">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            )}

            {!loading && shown.length === 0 && (
              <div className="mt-12 text-center text-ink-secondary">
                No events match your search.
              </div>
            )}

            {hasMore && (
              <div className="mt-8 flex justify-center">
                <button
                  onClick={() => setVisible((v) => v + PAGE_SIZE)}
                  className="rounded-md border border-primary bg-white px-6 py-2.5 text-sm font-semibold text-primary transition-colors hover:bg-primary-50"
                >
                  Load More Events
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
